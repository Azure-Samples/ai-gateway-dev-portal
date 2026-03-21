import { useState, useEffect, useCallback } from 'react';
import { Gauge, ArrowLeft } from 'lucide-react';
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

/** Latency percentiles (P50, P95, P99) over time */
function kqlLatencyPercentiles(start: string, end: string, gran: string, models: string[], subs: string[]) {
  const { m, s } = filterClauses(models, subs);
  const endC = end ? `| where TimeGenerated <= ${end}` : '';
  return `
ApiManagementGatewayLlmLog
| where TimeGenerated > ${start}
${endC}
| join kind=leftouter ApiManagementGatewayLogs on CorrelationId
| project TimeGenerated, TotalTime, ModelName, ApimSubscriptionId
${m}
${s}
| summarize P50 = percentile(TotalTime, 50), P95 = percentile(TotalTime, 95), P99 = percentile(TotalTime, 99) by bin(TimeGenerated, ${gran})
| order by TimeGenerated asc
`.trim();
}

/** Latency per model over time (P50) */
function kqlLatencyByModel(start: string, end: string, gran: string, models: string[], subs: string[]) {
  const { m, s } = filterClauses(models, subs);
  const endC = end ? `| where TimeGenerated <= ${end}` : '';
  return `
ApiManagementGatewayLlmLog
| where TimeGenerated > ${start}
${endC}
| join kind=leftouter ApiManagementGatewayLogs on CorrelationId
| project TimeGenerated, TotalTime, ModelName, ApimSubscriptionId
${m}
${s}
| summarize P50 = percentile(TotalTime, 50) by bin(TimeGenerated, ${gran}), ModelName
| order by TimeGenerated asc
`.trim();
}

/** Latency per subscription over time (P50) */
function kqlLatencyBySub(start: string, end: string, gran: string, models: string[], subs: string[]) {
  const { m, s } = filterClauses(models, subs);
  const endC = end ? `| where TimeGenerated <= ${end}` : '';
  return `
ApiManagementGatewayLlmLog
| where TimeGenerated > ${start}
${endC}
| join kind=leftouter ApiManagementGatewayLogs on CorrelationId
| project TimeGenerated, TotalTime, ModelName, ApimSubscriptionId
${m}
${s}
| summarize P50 = percentile(TotalTime, 50) by bin(TimeGenerated, ${gran}), ApimSubscriptionId
| order by TimeGenerated asc
`.trim();
}

/** Throughput — requests per time bucket */
function kqlThroughput(start: string, end: string, gran: string, models: string[], subs: string[]) {
  const { m, s } = filterClauses(models, subs);
  const endC = end ? `| where TimeGenerated <= ${end}` : '';
  return `
ApiManagementGatewayLlmLog
| where TimeGenerated > ${start}
${endC}
| join kind=leftouter ApiManagementGatewayLogs on CorrelationId
| project TimeGenerated, ModelName, ApimSubscriptionId
${m}
${s}
| summarize Requests = count() by bin(TimeGenerated, ${gran})
| order by TimeGenerated asc
`.trim();
}

/** Latency vs tokens scatter — avg latency and avg tokens per time bucket per model */
function kqlLatencyVsTokens(start: string, end: string, gran: string, models: string[], subs: string[]) {
  const { m, s } = filterClauses(models, subs);
  const endC = end ? `| where TimeGenerated <= ${end}` : '';
  return `
ApiManagementGatewayLlmLog
| where TimeGenerated > ${start}
${endC}
| join kind=leftouter ApiManagementGatewayLogs on CorrelationId
| project TimeGenerated, TotalTime, TotalTokens, ModelName, ApimSubscriptionId
${m}
${s}
| summarize AvgLatency = avg(TotalTime), AvgTokens = avg(TotalTokens) by bin(TimeGenerated, ${gran}), ModelName
| order by TimeGenerated asc
`.trim();
}

/** Time to first token / processing time breakdown — using TotalTime and token counts */
function kqlTokenLatency(start: string, end: string, gran: string, models: string[], subs: string[]) {
  const { m, s } = filterClauses(models, subs);
  const endC = end ? `| where TimeGenerated <= ${end}` : '';
  return `
ApiManagementGatewayLlmLog
| where TimeGenerated > ${start}
${endC}
| join kind=leftouter ApiManagementGatewayLogs on CorrelationId
| project TimeGenerated, TotalTime, TotalTokens, CompletionTokens, ModelName, ApimSubscriptionId
${m}
${s}
| extend MsPerToken = iff(TotalTokens > 0, round(todouble(TotalTime) / todouble(TotalTokens), 2), 0.0)
| summarize AvgMsPerToken = avg(MsPerToken), AvgLatency = avg(TotalTime) by bin(TimeGenerated, ${gran}), ModelName
| project TimeGenerated, ModelName, AvgMsPerToken
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

function fmtMs(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}s`;
  return `${Math.round(v)}ms`;
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

export default function Performance() {
  const { config } = useAzure();
  const { instance } = useMsal();
  const service = config.apimService;
  const navigate = useNavigate();
  const getCredential = useCallback(() => createMsalCredential(instance), [instance]);

  const tb = useToolbarState();
  const { timeRange, customStart, customEnd, modelFilter, subFilter, containerRef,
    resolvedGran, setLoading, setAllModels, setAllSubs, setLastRefresh } = tb;

  /* ── Chart data ── */
  const [percentiles, setPercentiles] = useState<Record<string, string | number>[]>([]);
  const [latByModel, setLatByModel] = useState<{ data: Record<string, string | number>[]; series: string[] }>({ data: [], series: [] });
  const [latBySub, setLatBySub] = useState<{ data: Record<string, string | number>[]; series: string[] }>({ data: [], series: [] });
  const [throughput, setThroughput] = useState<Record<string, string | number>[]>([]);
  const [latVsTok, setLatVsTok] = useState<{ data: Record<string, string | number>[]; series: string[] }>({ data: [], series: [] });
  const [msPerToken, setMsPerToken] = useState<{ data: Record<string, string | number>[]; series: string[] }>({ data: [], series: [] });

  /* ── Fetch ── */
  const fetchAll = useCallback(async () => {
    if (!service) return;
    setLoading(true);
    try {
      const { start, end } = timeExprs(timeRange, customStart, customEnd);
      const cred = getCredential();
      const [r1, r2, r3, r4, r5, r6] = await Promise.all([
        queryLogAnalytics(cred, service.id, kqlLatencyPercentiles(start, end, resolvedGran, modelFilter, subFilter)),
        queryLogAnalytics(cred, service.id, kqlLatencyByModel(start, end, resolvedGran, modelFilter, subFilter)),
        queryLogAnalytics(cred, service.id, kqlLatencyBySub(start, end, resolvedGran, modelFilter, subFilter)),
        queryLogAnalytics(cred, service.id, kqlThroughput(start, end, resolvedGran, modelFilter, subFilter)),
        queryLogAnalytics(cred, service.id, kqlLatencyVsTokens(start, end, resolvedGran, modelFilter, subFilter)),
        queryLogAnalytics(cred, service.id, kqlTokenLatency(start, end, resolvedGran, modelFilter, subFilter)),
      ]);

      setPercentiles(
        r1.map((r) => ({
          time: String(r.TimeGenerated),
          P50: num(r.P50),
          P95: num(r.P95),
          P99: num(r.P99),
        })).sort((a, b) => String(a.time).localeCompare(String(b.time))),
      );

      setLatByModel(pivot(r2, 'TimeGenerated', 'ModelName', 'P50'));
      setLatBySub(pivot(r3, 'TimeGenerated', 'ApimSubscriptionId', 'P50'));

      setThroughput(
        r4.map((r) => ({
          time: String(r.TimeGenerated),
          Requests: num(r.Requests),
        })).sort((a, b) => String(a.time).localeCompare(String(b.time))),
      );

      setLatVsTok(pivot(r5, 'TimeGenerated', 'ModelName', 'AvgLatency'));
      setMsPerToken(pivot(r6, 'TimeGenerated', 'ModelName', 'AvgMsPerToken'));

      // Populate toolbar filters
      const subs = new Set<string>();
      const models = new Set<string>();
      for (const r of r3) subs.add(String(r.ApimSubscriptionId ?? ''));
      for (const r of r2) models.add(String(r.ModelName ?? ''));
      setAllSubs([...subs].filter(Boolean).sort());
      setAllModels([...models].filter(Boolean).sort());
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Performance query failed:', err);
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
          <h1 className="page-title">Performance</h1>
          <p className="page-description">Deep dive into latency, throughput and efficiency.</p>
        </div>
        <div className="page-empty">
          <Gauge className="page-empty-icon" />
          <div className="page-empty-title">No APIM service selected</div>
          <p className="page-empty-text">Use the workspace selector to choose an APIM instance first.</p>
        </div>
      </div>
    );
  }

  const hasData = percentiles.length > 0 || latByModel.data.length > 0;

  return (
    <div className="db-container" ref={containerRef}>
      <div className="req-header">
        <button className="req-back" onClick={() => void navigate('/dashboard')} title="Back to Dashboard">
          <ArrowLeft size={16} />
        </button>
        <div>
          <h2 className="req-title">Performance</h2>
          <p className="req-subtitle">Latency trends, throughput patterns and efficiency analysis</p>
        </div>
      </div>

      <AnalyticsToolbar state={tb} onRefresh={handleRefresh} />

      {tb.loading && !hasData ? (
        <div className="page-empty"><span className="spinner" /></div>
      ) : !hasData ? (
        <div className="page-empty">
          <Gauge className="page-empty-icon" />
          <div className="page-empty-title">No data</div>
          <p className="page-empty-text">No performance data found for the selected time range.</p>
        </div>
      ) : (
        <div className="req-charts">
          {/* Row 1: Latency Percentiles + Throughput */}
          <div className="req-chart-row">
            <ChartCard title="Latency Percentiles (P50 / P95 / P99)" loading={tb.loading}>
              <PercentilesChart data={percentiles} />
            </ChartCard>
            <ChartCard title="Request Throughput" loading={tb.loading}>
              <ThroughputChart data={throughput} />
            </ChartCard>
          </div>

          {/* Row 2: Latency by Model + Latency by Subscription */}
          <div className="req-chart-row">
            <ChartCard title="P50 Latency by Model" loading={tb.loading}>
              <LatencyMultiChart data={latByModel.data} series={latByModel.series} />
            </ChartCard>
            <ChartCard title="P50 Latency by Subscription" loading={tb.loading}>
              <LatencyMultiChart data={latBySub.data} series={latBySub.series} />
            </ChartCard>
          </div>

          {/* Row 3: Avg Latency by Model + ms/token by Model */}
          <div className="req-chart-row">
            <ChartCard title="Avg Latency by Model" loading={tb.loading}>
              <LatencyMultiChart data={latVsTok.data} series={latVsTok.series} />
            </ChartCard>
            <ChartCard title="Avg ms per Token by Model" loading={tb.loading}>
              <MsPerTokenChart data={msPerToken.data} series={msPerToken.series} />
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

function PercentilesChart({ data }: { data: Record<string, string | number>[] }) {
  const legend = useLegendHighlight();
  if (data.length === 0) return <div className="db-chart-empty">No data</div>;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 24, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
        <XAxis dataKey="time" tick={{ fill: '#8b8ba0', fontSize: 11 }} tickFormatter={fmtChartTime} stroke="rgba(255,255,255,0.08)" minTickGap={40} />
        <YAxis tick={{ fill: '#8b8ba0', fontSize: 11 }} tickFormatter={(v) => fmtMs(Number(v))} stroke="rgba(255,255,255,0.08)" width={56} />
        <RTooltip
          contentStyle={{ background: 'var(--bg-surface, #111118)', border: '1px solid var(--border, rgba(255,255,255,0.08))', borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: 'var(--text-secondary, #8b8ba0)', marginBottom: 4 }}
          labelFormatter={fmtTooltipTime}
          formatter={(value: unknown) => fmtMs(Number(value))}
        />
        <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8, cursor: 'pointer' }}
          onMouseEnter={legend.handleMouseEnter} onMouseLeave={legend.handleMouseLeave} onClick={legend.handleClick} />
        <Line type="linear" dataKey="P50" name="P50" stroke="#89b4fa" strokeWidth={2}
          opacity={legend.opacity('P50')}
          dot={{ r: 2, fill: '#89b4fa', strokeWidth: 0 }} activeDot={{ r: 4, fill: '#89b4fa', strokeWidth: 0 }} />
        <Line type="linear" dataKey="P95" name="P95" stroke="#f9e2af" strokeWidth={2}
          opacity={legend.opacity('P95')}
          dot={{ r: 2, fill: '#f9e2af', strokeWidth: 0 }} activeDot={{ r: 4, fill: '#f9e2af', strokeWidth: 0 }} />
        <Line type="linear" dataKey="P99" name="P99" stroke="#f38ba8" strokeWidth={2} strokeDasharray="4 3"
          opacity={legend.opacity('P99')}
          dot={{ r: 2, fill: '#f38ba8', strokeWidth: 0 }} activeDot={{ r: 4, fill: '#f38ba8', strokeWidth: 0 }} />
      </LineChart>
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
        <Area type="linear" dataKey="Requests" name="Requests" stroke="#cba6f7" fill="#cba6f7" fillOpacity={0.15} strokeWidth={2}
          opacity={legend.opacity('Requests')} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function LatencyMultiChart({ data, series }: { data: Record<string, string | number>[]; series: string[] }) {
  const legend = useLegendHighlight();
  if (data.length === 0) return <div className="db-chart-empty">No data</div>;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 24, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
        <XAxis dataKey="time" tick={{ fill: '#8b8ba0', fontSize: 11 }} tickFormatter={fmtChartTime} stroke="rgba(255,255,255,0.08)" minTickGap={40} />
        <YAxis tick={{ fill: '#8b8ba0', fontSize: 11 }} tickFormatter={(v) => fmtMs(Number(v))} stroke="rgba(255,255,255,0.08)" width={56} />
        <RTooltip
          contentStyle={{ background: 'var(--bg-surface, #111118)', border: '1px solid var(--border, rgba(255,255,255,0.08))', borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: 'var(--text-secondary, #8b8ba0)', marginBottom: 4 }}
          itemStyle={{ padding: '1px 0' }}
          labelFormatter={fmtTooltipTime}
          formatter={(value: unknown) => fmtMs(Number(value))}
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

function MsPerTokenChart({ data, series }: { data: Record<string, string | number>[]; series: string[] }) {
  const legend = useLegendHighlight();
  if (data.length === 0) return <div className="db-chart-empty">No data</div>;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 24, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
        <XAxis dataKey="time" tick={{ fill: '#8b8ba0', fontSize: 11 }} tickFormatter={fmtChartTime} stroke="rgba(255,255,255,0.08)" minTickGap={40} />
        <YAxis tick={{ fill: '#8b8ba0', fontSize: 11 }} tickFormatter={(v) => `${Number(v).toFixed(1)}ms`} stroke="rgba(255,255,255,0.08)" width={56} />
        <RTooltip
          contentStyle={{ background: 'var(--bg-surface, #111118)', border: '1px solid var(--border, rgba(255,255,255,0.08))', borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: 'var(--text-secondary, #8b8ba0)', marginBottom: 4 }}
          itemStyle={{ padding: '1px 0' }}
          labelFormatter={fmtTooltipTime}
          formatter={(value: unknown) => `${Number(value).toFixed(2)} ms/token`}
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
