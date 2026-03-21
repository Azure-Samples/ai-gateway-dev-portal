import { useState, useEffect, useCallback } from 'react';
import { Coins, ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAzure } from '../context/AzureContext';
import { createMsalCredential, queryLogAnalytics } from '../services/azure';
import { useMsal } from '@azure/msal-react';
import {
  ResponsiveContainer, LineChart, Line, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, Legend,
} from 'recharts';
import AnalyticsToolbar, {
  useToolbarState, TIME_RANGES,
  type TimeRange,
} from '../components/AnalyticsToolbar';
import useLegendHighlight from '../hooks/useLegendHighlight';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CHART_COLORS = [
  '#89b4fa', '#f9e2af', '#cba6f7', '#a6e3a1', '#f38ba8',
  '#fab387', '#74c7ec', '#94e2d5', '#f5c2e7', '#eba0ac',
  '#b4befe', '#f2cdcd',
];

/* ------------------------------------------------------------------ */
/*  KQL helpers                                                        */
/* ------------------------------------------------------------------ */

function timeExprs(tr: TimeRange, cs: string, ce: string) {
  if (tr === 'custom' && cs && ce) {
    return {
      start: `datetime('${new Date(cs).toISOString()}')`,
      end: `datetime('${new Date(ce).toISOString()}')`,
    };
  }
  const ago = TIME_RANGES.find((t) => t.value === tr)?.ago ?? '30m';
  return { start: `ago(${ago})`, end: '' };
}

function filterClauses(models: string[], subs: string[]) {
  const m = models.length ? `| where ModelName in (${models.map(v => `'${v}'`).join(', ')})` : '';
  const s = subs.length ? `| where ApimSubscriptionId in (${subs.map(v => `'${v}'`).join(', ')})` : '';
  return { m, s };
}

/** Total tokens over time per subscription */
function kqlTokensBySub(start: string, end: string, gran: string, models: string[], subs: string[]) {
  const { m, s } = filterClauses(models, subs);
  const endC = end ? `| where TimeGenerated <= ${end}` : '';
  return `
ApiManagementGatewayLlmLog
| where TimeGenerated > ${start}
${endC}
| join kind=leftouter ApiManagementGatewayLogs on CorrelationId
| project TimeGenerated, TotalTokens, ApimSubscriptionId, ModelName
${m}
${s}
| summarize Tokens = sum(TotalTokens) by bin(TimeGenerated, ${gran}), ApimSubscriptionId
| order by TimeGenerated asc
`.trim();
}

/** Total tokens over time per model */
function kqlTokensByModel(start: string, end: string, gran: string, models: string[], subs: string[]) {
  const { m, s } = filterClauses(models, subs);
  const endC = end ? `| where TimeGenerated <= ${end}` : '';
  return `
ApiManagementGatewayLlmLog
| where TimeGenerated > ${start}
${endC}
| join kind=leftouter ApiManagementGatewayLogs on CorrelationId
| project TimeGenerated, TotalTokens, ModelName, ApimSubscriptionId
${m}
${s}
| summarize Tokens = sum(TotalTokens) by bin(TimeGenerated, ${gran}), ModelName
| order by TimeGenerated asc
`.trim();
}

/** Input vs output tokens over time */
function kqlInputOutput(start: string, end: string, gran: string, models: string[], subs: string[]) {
  const { m, s } = filterClauses(models, subs);
  const endC = end ? `| where TimeGenerated <= ${end}` : '';
  return `
ApiManagementGatewayLlmLog
| where TimeGenerated > ${start}
${endC}
| join kind=leftouter ApiManagementGatewayLogs on CorrelationId
| project TimeGenerated, PromptTokens, CompletionTokens, ModelName, ApimSubscriptionId
${m}
${s}
| summarize Input = sum(PromptTokens), Output = sum(CompletionTokens) by bin(TimeGenerated, ${gran})
| order by TimeGenerated asc
`.trim();
}

/** Average tokens per request over time per model */
function kqlTokensPerReq(start: string, end: string, gran: string, models: string[], subs: string[]) {
  const { m, s } = filterClauses(models, subs);
  const endC = end ? `| where TimeGenerated <= ${end}` : '';
  return `
ApiManagementGatewayLlmLog
| where TimeGenerated > ${start}
${endC}
| join kind=leftouter ApiManagementGatewayLogs on CorrelationId
| project TimeGenerated, TotalTokens, ModelName, ApimSubscriptionId
${m}
${s}
| summarize AvgTokens = avg(TotalTokens), Requests = count() by bin(TimeGenerated, ${gran}), ModelName
| project TimeGenerated, ModelName, AvgTokens
| order by TimeGenerated asc
`.trim();
}

/** Token throughput — tokens per minute over time */
function kqlTokenThroughput(start: string, end: string, gran: string, models: string[], subs: string[]) {
  const { m, s } = filterClauses(models, subs);
  const endC = end ? `| where TimeGenerated <= ${end}` : '';
  return `
ApiManagementGatewayLlmLog
| where TimeGenerated > ${start}
${endC}
| join kind=leftouter ApiManagementGatewayLogs on CorrelationId
| project TimeGenerated, PromptTokens, CompletionTokens, TotalTokens, ModelName, ApimSubscriptionId
${m}
${s}
| summarize InputTPM = sum(PromptTokens), OutputTPM = sum(CompletionTokens), TotalTPM = sum(TotalTokens) by bin(TimeGenerated, ${gran})
| order by TimeGenerated asc
`.trim();
}

/** Input/output ratio per model (avg) */
function kqlIORatioByModel(start: string, end: string, gran: string, models: string[], subs: string[]) {
  const { m, s } = filterClauses(models, subs);
  const endC = end ? `| where TimeGenerated <= ${end}` : '';
  return `
ApiManagementGatewayLlmLog
| where TimeGenerated > ${start}
${endC}
| join kind=leftouter ApiManagementGatewayLogs on CorrelationId
| project TimeGenerated, PromptTokens, CompletionTokens, ModelName, ApimSubscriptionId
${m}
${s}
| summarize Input = sum(PromptTokens), Output = sum(CompletionTokens) by bin(TimeGenerated, ${gran}), ModelName
| extend Ratio = iff(Input > 0, round(todouble(Output) / todouble(Input), 2), 0.0)
| project TimeGenerated, ModelName, Ratio
| order by TimeGenerated asc
`.trim();
}

/* ------------------------------------------------------------------ */
/*  Formatters                                                         */
/* ------------------------------------------------------------------ */

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}

function fmtChartTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const md = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${md} ${hm}`;
}

function fmtTooltipTime(iso: unknown): string {
  const s = String(iso);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function num(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/* ------------------------------------------------------------------ */
/*  Pivot helper                                                       */
/* ------------------------------------------------------------------ */

function pivot(
  rows: Record<string, unknown>[],
  timeKey: string,
  seriesKey: string,
  valueKey: string,
): { data: Record<string, string | number>[]; series: string[] } {
  const timeMap = new Map<string, Record<string, string | number>>();
  const seriesSet = new Set<string>();
  for (const r of rows) {
    const t = String(r[timeKey]);
    const s = String((r[seriesKey] as string | number | null | undefined) ?? 'unknown');
    const v = num(r[valueKey] as string | number | null | undefined);
    seriesSet.add(s);
    let entry = timeMap.get(t);
    if (!entry) { entry = { time: t }; timeMap.set(t, entry); }
    entry[s] = v;
  }
  const series = [...seriesSet].sort();
  const data = [...timeMap.values()]
    .map((p) => { for (const s of series) if (!(s in p)) p[s] = 0; return p; })
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
  return { data, series };
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function Tokens() {
  const { config } = useAzure();
  const { instance } = useMsal();
  const service = config.apimService;
  const navigate = useNavigate();
  const getCredential = useCallback(() => createMsalCredential(instance), [instance]);

  const tb = useToolbarState();
  const { timeRange, customStart, customEnd, modelFilter, subFilter, containerRef,
    resolvedGran, setLoading, setAllModels, setAllSubs, setLastRefresh } = tb;

  /* ── Chart data ── */
  const [tokBySub, setTokBySub] = useState<{ data: Record<string, string | number>[]; series: string[] }>({ data: [], series: [] });
  const [tokByModel, setTokByModel] = useState<{ data: Record<string, string | number>[]; series: string[] }>({ data: [], series: [] });
  const [inputOutput, setInputOutput] = useState<Record<string, string | number>[]>([]);
  const [tokPerReq, setTokPerReq] = useState<{ data: Record<string, string | number>[]; series: string[] }>({ data: [], series: [] });
  const [throughput, setThroughput] = useState<Record<string, string | number>[]>([]);
  const [ioRatio, setIORatio] = useState<{ data: Record<string, string | number>[]; series: string[] }>({ data: [], series: [] });

  /* ── Fetch ── */
  const fetchAll = useCallback(async () => {
    if (!service) return;
    setLoading(true);
    try {
      const { start, end } = timeExprs(timeRange, customStart, customEnd);
      const cred = getCredential();
      const [r1, r2, r3, r4, r5, r6] = await Promise.all([
        queryLogAnalytics(cred, service.id, kqlTokensBySub(start, end, resolvedGran, modelFilter, subFilter)),
        queryLogAnalytics(cred, service.id, kqlTokensByModel(start, end, resolvedGran, modelFilter, subFilter)),
        queryLogAnalytics(cred, service.id, kqlInputOutput(start, end, resolvedGran, modelFilter, subFilter)),
        queryLogAnalytics(cred, service.id, kqlTokensPerReq(start, end, resolvedGran, modelFilter, subFilter)),
        queryLogAnalytics(cred, service.id, kqlTokenThroughput(start, end, resolvedGran, modelFilter, subFilter)),
        queryLogAnalytics(cred, service.id, kqlIORatioByModel(start, end, resolvedGran, modelFilter, subFilter)),
      ]);

      setTokBySub(pivot(r1, 'TimeGenerated', 'ApimSubscriptionId', 'Tokens'));
      setTokByModel(pivot(r2, 'TimeGenerated', 'ModelName', 'Tokens'));

      // Input vs Output — single series pair
      setInputOutput(
        r3.map((r) => ({
          time: String(r.TimeGenerated),
          Input: num(r.Input),
          Output: num(r.Output),
        })).sort((a, b) => String(a.time).localeCompare(String(b.time))),
      );

      setTokPerReq(pivot(r4, 'TimeGenerated', 'ModelName', 'AvgTokens'));

      // Throughput — input/output/total TPM
      setThroughput(
        r5.map((r) => ({
          time: String(r.TimeGenerated),
          Input: num(r.InputTPM),
          Output: num(r.OutputTPM),
          Total: num(r.TotalTPM),
        })).sort((a, b) => String(a.time).localeCompare(String(b.time))),
      );

      setIORatio(pivot(r6, 'TimeGenerated', 'ModelName', 'Ratio'));

      // Populate toolbar filters
      const subs = new Set<string>();
      const models = new Set<string>();
      for (const r of r1) subs.add(String(r.ApimSubscriptionId ?? ''));
      for (const r of r2) models.add(String(r.ModelName ?? ''));
      setAllSubs([...subs].filter(Boolean).sort());
      setAllModels([...models].filter(Boolean).sort());
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Tokens query failed:', err);
    } finally {
      setLoading(false);
    }
  }, [service, timeRange, customStart, customEnd, resolvedGran, modelFilter, subFilter, getCredential, setLoading, setAllModels, setAllSubs, setLastRefresh]);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

  const handleRefresh = useCallback(() => { void fetchAll(); }, [fetchAll]);

  /* ── Empty state ── */
  if (!service) {
    return (
      <div className="page-container">
        <div className="page-header">
          <h1 className="page-title">Tokens</h1>
          <p className="page-description">Deep dive into token usage trends and patterns.</p>
        </div>
        <div className="page-empty">
          <Coins className="page-empty-icon" />
          <div className="page-empty-title">No APIM service selected</div>
          <p className="page-empty-text">Use the workspace selector to choose an APIM instance first.</p>
        </div>
      </div>
    );
  }

  const hasData = tokBySub.data.length > 0 || tokByModel.data.length > 0;

  return (
    <div className="db-container" ref={containerRef}>
      <div className="req-header">
        <button className="req-back" onClick={() => void navigate('/dashboard')} title="Back to Dashboard">
          <ArrowLeft size={16} />
        </button>
        <div>
          <h2 className="req-title">Tokens</h2>
          <p className="req-subtitle">Token usage trends, patterns and efficiency analysis</p>
        </div>
      </div>

      <AnalyticsToolbar state={tb} onRefresh={handleRefresh} />

      {tb.loading && !hasData ? (
        <div className="page-empty"><span className="spinner" /></div>
      ) : !hasData ? (
        <div className="page-empty">
          <Coins className="page-empty-icon" />
          <div className="page-empty-title">No data</div>
          <p className="page-empty-text">No token data found for the selected time range.</p>
        </div>
      ) : (
        <div className="req-charts">
          {/* Row 1: Tokens by Subscription + Tokens by Model */}
          <div className="req-chart-row">
            <ChartCard title="Tokens by Subscription" loading={tb.loading}>
              <TimeLineChart data={tokBySub.data} series={tokBySub.series} />
            </ChartCard>
            <ChartCard title="Tokens by Model" loading={tb.loading}>
              <TimeLineChart data={tokByModel.data} series={tokByModel.series} />
            </ChartCard>
          </div>

          {/* Row 2: Input vs Output + Token Throughput */}
          <div className="req-chart-row">
            <ChartCard title="Input vs Output Tokens" loading={tb.loading}>
              <InputOutputChart data={inputOutput} />
            </ChartCard>
            <ChartCard title="Token Throughput" loading={tb.loading}>
              <ThroughputChart data={throughput} />
            </ChartCard>
          </div>

          {/* Row 3: Avg Tokens per Request + I/O Ratio by Model */}
          <div className="req-chart-row">
            <ChartCard title="Avg Tokens per Request" loading={tb.loading}>
              <TimeLineChart data={tokPerReq.data} series={tokPerReq.series} />
            </ChartCard>
            <ChartCard title="Output / Input Ratio by Model" loading={tb.loading}>
              <TimeLineChart data={ioRatio.data} series={ioRatio.series} valueFormatter={(v) => v.toFixed(2)} />
            </ChartCard>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Reusable chart sub-components                                      */
/* ------------------------------------------------------------------ */

function ChartCard({ title, loading, children }: { title: string; loading: boolean; children: React.ReactNode }) {
  return (
    <div className="db-chart-section req-chart-card">
      <div className="db-chart-header">
        <h3 className="db-chart-title">{title}</h3>
      </div>
      <div className="db-chart-body req-chart-body">
        {children}
        {loading && (
          <div className="db-chart-loading-overlay"><span className="spinner" /></div>
        )}
      </div>
    </div>
  );
}

function TimeLineChart({ data, series, valueFormatter }: {
  data: Record<string, string | number>[];
  series: string[];
  valueFormatter?: (v: number) => string;
}) {
  const legend = useLegendHighlight();
  if (data.length === 0) return <div className="db-chart-empty">No data</div>;
  const fmt = valueFormatter ?? ((v: number) => v.toLocaleString());
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 24, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
        <XAxis dataKey="time" tick={{ fill: '#8b8ba0', fontSize: 11 }} tickFormatter={fmtChartTime} stroke="rgba(255,255,255,0.08)" minTickGap={40} />
        <YAxis tick={{ fill: '#8b8ba0', fontSize: 11 }} tickFormatter={fmtNum} stroke="rgba(255,255,255,0.08)" width={48} />
        <RTooltip
          contentStyle={{ background: 'var(--bg-surface, #111118)', border: '1px solid var(--border, rgba(255,255,255,0.08))', borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: 'var(--text-secondary, #8b8ba0)', marginBottom: 4 }}
          itemStyle={{ padding: '1px 0' }}
          labelFormatter={fmtTooltipTime}
          formatter={(value: unknown) => fmt(Number(value))}
        />
        <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8, cursor: 'pointer' }}
          onMouseEnter={legend.handleMouseEnter} onMouseLeave={legend.handleMouseLeave} onClick={legend.handleClick} />
        {series.map((s, i) => {
          const color = CHART_COLORS[i % CHART_COLORS.length];
          return (
            <Line key={s} type="linear" dataKey={s} name={s} stroke={color} strokeWidth={2}
              opacity={legend.opacity(s)}
              dot={{ r: 2, fill: color, strokeWidth: 0 }} activeDot={{ r: 4, fill: color, strokeWidth: 0 }} />
          );
        })}
      </LineChart>
    </ResponsiveContainer>
  );
}

function InputOutputChart({ data }: { data: Record<string, string | number>[] }) {
  const legend = useLegendHighlight();
  if (data.length === 0) return <div className="db-chart-empty">No data</div>;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 8, right: 24, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
        <XAxis dataKey="time" tick={{ fill: '#8b8ba0', fontSize: 11 }} tickFormatter={fmtChartTime} stroke="rgba(255,255,255,0.08)" minTickGap={40} />
        <YAxis tick={{ fill: '#8b8ba0', fontSize: 11 }} tickFormatter={fmtNum} stroke="rgba(255,255,255,0.08)" width={48} />
        <RTooltip
          contentStyle={{ background: 'var(--bg-surface, #111118)', border: '1px solid var(--border, rgba(255,255,255,0.08))', borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: 'var(--text-secondary, #8b8ba0)', marginBottom: 4 }}
          labelFormatter={fmtTooltipTime}
          formatter={(value: unknown) => Number(value).toLocaleString()}
        />
        <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8, cursor: 'pointer' }}
          onMouseEnter={legend.handleMouseEnter} onMouseLeave={legend.handleMouseLeave} onClick={legend.handleClick} />
        <Area type="linear" dataKey="Input" name="Input (Prompt)" stroke="#89b4fa" fill="#89b4fa" fillOpacity={0.15} strokeWidth={2}
          opacity={legend.opacity('Input')} />
        <Area type="linear" dataKey="Output" name="Output (Completion)" stroke="#a6e3a1" fill="#a6e3a1" fillOpacity={0.15} strokeWidth={2}
          opacity={legend.opacity('Output')} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function ThroughputChart({ data }: { data: Record<string, string | number>[] }) {
  const legend = useLegendHighlight();
  if (data.length === 0) return <div className="db-chart-empty">No data</div>;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 8, right: 24, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
        <XAxis dataKey="time" tick={{ fill: '#8b8ba0', fontSize: 11 }} tickFormatter={fmtChartTime} stroke="rgba(255,255,255,0.08)" minTickGap={40} />
        <YAxis tick={{ fill: '#8b8ba0', fontSize: 11 }} tickFormatter={fmtNum} stroke="rgba(255,255,255,0.08)" width={48} />
        <RTooltip
          contentStyle={{ background: 'var(--bg-surface, #111118)', border: '1px solid var(--border, rgba(255,255,255,0.08))', borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: 'var(--text-secondary, #8b8ba0)', marginBottom: 4 }}
          labelFormatter={fmtTooltipTime}
          formatter={(value: unknown) => Number(value).toLocaleString()}
        />
        <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8, cursor: 'pointer' }}
          onMouseEnter={legend.handleMouseEnter} onMouseLeave={legend.handleMouseLeave} onClick={legend.handleClick} />
        <Area type="linear" dataKey="Total" name="Total" stroke="#cba6f7" fill="#cba6f7" fillOpacity={0.10} strokeWidth={2}
          opacity={legend.opacity('Total')} />
        <Area type="linear" dataKey="Input" name="Input" stroke="#89b4fa" fill="#89b4fa" fillOpacity={0.10} strokeWidth={2}
          opacity={legend.opacity('Input')} />
        <Area type="linear" dataKey="Output" name="Output" stroke="#a6e3a1" fill="#a6e3a1" fillOpacity={0.10} strokeWidth={2}
          opacity={legend.opacity('Output')} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
