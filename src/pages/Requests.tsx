import { useState, useEffect, useCallback } from 'react';
import { Activity, ArrowLeft } from 'lucide-react';
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

/** Requests over time per subscription */
function kqlReqBySub(start: string, end: string, gran: string, models: string[], subs: string[]) {
  const { m, s } = filterClauses(models, subs);
  const endC = end ? `| where TimeGenerated <= ${end}` : '';
  return `
ApiManagementGatewayLlmLog
| where TimeGenerated > ${start}
${endC}
| join kind=leftouter ApiManagementGatewayLogs on CorrelationId
| project TimeGenerated, ApimSubscriptionId, ModelName
${m}
${s}
| summarize Requests = count() by bin(TimeGenerated, ${gran}), ApimSubscriptionId
| order by TimeGenerated asc
`.trim();
}

/** Requests over time per model */
function kqlReqByModel(start: string, end: string, gran: string, models: string[], subs: string[]) {
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
| summarize Requests = count() by bin(TimeGenerated, ${gran}), ModelName
| order by TimeGenerated asc
`.trim();
}

/** Success vs. error over time */
function kqlSuccessError(start: string, end: string, gran: string, models: string[], subs: string[]) {
  const { m, s } = filterClauses(models, subs);
  const endC = end ? `| where TimeGenerated <= ${end}` : '';
  return `
ApiManagementGatewayLlmLog
| where TimeGenerated > ${start}
${endC}
| join kind=leftouter ApiManagementGatewayLogs on CorrelationId
| project TimeGenerated, ResponseCode, ModelName, ApimSubscriptionId
${m}
${s}
| extend Status = iff(ResponseCode >= 200 and ResponseCode < 400, "Success", "Error")
| summarize Count = count() by bin(TimeGenerated, ${gran}), Status
| order by TimeGenerated asc
`.trim();
}

/** Latency percentiles over time */
function kqlLatency(start: string, end: string, gran: string, models: string[], subs: string[]) {
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

/** Error breakdown by status code over time */
function kqlErrorCodes(start: string, end: string, gran: string, models: string[], subs: string[]) {
  const { m, s } = filterClauses(models, subs);
  const endC = end ? `| where TimeGenerated <= ${end}` : '';
  return `
ApiManagementGatewayLlmLog
| where TimeGenerated > ${start}
${endC}
| join kind=leftouter ApiManagementGatewayLogs on CorrelationId
| project TimeGenerated, ResponseCode, ModelName, ApimSubscriptionId
${m}
${s}
| where ResponseCode >= 400
| summarize Count = count() by bin(TimeGenerated, ${gran}), tostring(ResponseCode)
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

function fmtMs(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}s`;
  return `${Math.round(v)}ms`;
}

function num(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/* ------------------------------------------------------------------ */
/*  Pivot helper — converts KQL rows into Recharts data points         */
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

export default function Requests() {
  const { config } = useAzure();
  const { instance } = useMsal();
  const service = config.apimService;
  const navigate = useNavigate();
  const getCredential = useCallback(() => createMsalCredential(instance), [instance]);

  /* ── Shared toolbar ── */
  const tb = useToolbarState();
  const { timeRange, customStart, customEnd, modelFilter, subFilter, containerRef,
    resolvedGran, setLoading, setAllModels, setAllSubs, setLastRefresh } = tb;

  /* ── Chart data ── */
  const [reqBySub, setReqBySub] = useState<{ data: Record<string, string | number>[]; series: string[] }>({ data: [], series: [] });
  const [reqByModel, setReqByModel] = useState<{ data: Record<string, string | number>[]; series: string[] }>({ data: [], series: [] });
  const [successError, setSuccessError] = useState<{ data: Record<string, string | number>[]; series: string[] }>({ data: [], series: [] });
  const [latency, setLatency] = useState<Record<string, string | number>[]>([]);
  const [errorCodes, setErrorCodes] = useState<{ data: Record<string, string | number>[]; series: string[] }>({ data: [], series: [] });

  /* ── Fetch ── */
  const fetchAll = useCallback(async () => {
    if (!service) return;
    setLoading(true);
    try {
      const { start, end } = timeExprs(timeRange, customStart, customEnd);
      const cred = getCredential();
      const [r1, r2, r3, r4, r5] = await Promise.all([
        queryLogAnalytics(cred, service.id, kqlReqBySub(start, end, resolvedGran, modelFilter, subFilter)),
        queryLogAnalytics(cred, service.id, kqlReqByModel(start, end, resolvedGran, modelFilter, subFilter)),
        queryLogAnalytics(cred, service.id, kqlSuccessError(start, end, resolvedGran, modelFilter, subFilter)),
        queryLogAnalytics(cred, service.id, kqlLatency(start, end, resolvedGran, modelFilter, subFilter)),
        queryLogAnalytics(cred, service.id, kqlErrorCodes(start, end, resolvedGran, modelFilter, subFilter)),
      ]);
      setReqBySub(pivot(r1, 'TimeGenerated', 'ApimSubscriptionId', 'Requests'));
      setReqByModel(pivot(r2, 'TimeGenerated', 'ModelName', 'Requests'));
      setSuccessError(pivot(r3, 'TimeGenerated', 'Status', 'Count'));
      // latency is single-series (P50, P95, P99)
      setLatency(
        r4.map((r) => ({
          time: String(r.TimeGenerated),
          P50: num(r.P50),
          P95: num(r.P95),
          P99: num(r.P99),
        })).sort((a, b) => String(a.time).localeCompare(String(b.time))),
      );
      setErrorCodes(pivot(r5, 'TimeGenerated', 'ResponseCode', 'Count'));
      // Populate toolbar filter options from reqBySub + reqByModel
      const subs = new Set<string>();
      const models = new Set<string>();
      for (const r of r1) subs.add(String(r.ApimSubscriptionId ?? ''));
      for (const r of r2) models.add(String(r.ModelName ?? ''));
      setAllSubs([...subs].filter(Boolean).sort());
      setAllModels([...models].filter(Boolean).sort());
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Requests query failed:', err);
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
          <h1 className="page-title">Requests</h1>
          <p className="page-description">Deep dive into request trends and patterns.</p>
        </div>
        <div className="page-empty">
          <Activity className="page-empty-icon" />
          <div className="page-empty-title">No APIM service selected</div>
          <p className="page-empty-text">Use the workspace selector to choose an APIM instance first.</p>
        </div>
      </div>
    );
  }

  const hasData = reqBySub.data.length > 0 || reqByModel.data.length > 0;

  /* ── Render ── */
  return (
    <div className="db-container" ref={containerRef}>
      {/* ── Back + Title ── */}
      <div className="req-header">
        <button className="req-back" onClick={() => void navigate('/dashboard')} title="Back to Dashboard">
          <ArrowLeft size={16} />
        </button>
        <div>
          <h2 className="req-title">Requests</h2>
          <p className="req-subtitle">Request trends, patterns and error analysis</p>
        </div>
      </div>

      {/* ── Toolbar ── */}
      <AnalyticsToolbar state={tb} onRefresh={handleRefresh} />

      {/* ── Charts ── */}
      {tb.loading && !hasData ? (
        <div className="page-empty"><span className="spinner" /></div>
      ) : !hasData ? (
        <div className="page-empty">
          <Activity className="page-empty-icon" />
          <div className="page-empty-title">No data</div>
          <p className="page-empty-text">No request data found for the selected time range.</p>
        </div>
      ) : (
        <div className="req-charts">
          {/* Row 1: Requests by Subscription + Requests by Model */}
          <div className="req-chart-row">
            <ChartCard title="Requests by Subscription" loading={tb.loading}>
              <TimeLineChart data={reqBySub.data} series={reqBySub.series} />
            </ChartCard>
            <ChartCard title="Requests by Model" loading={tb.loading}>
              <TimeLineChart data={reqByModel.data} series={reqByModel.series} />
            </ChartCard>
          </div>

          {/* Row 2: Success vs Error + Latency percentiles */}
          <div className="req-chart-row">
            <ChartCard title="Success vs. Error" loading={tb.loading}>
              <SuccessErrorChart data={successError.data} series={successError.series} />
            </ChartCard>
            <ChartCard title="Latency Percentiles" loading={tb.loading}>
              <LatencyChart data={latency} />
            </ChartCard>
          </div>

          {/* Row 3: Error codes */}
          {errorCodes.data.length > 0 && (
            <div className="req-chart-row req-chart-full">
              <ChartCard title="Error Codes Over Time" loading={tb.loading}>
                <TimeLineChart data={errorCodes.data} series={errorCodes.series} />
              </ChartCard>
            </div>
          )}
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

function TimeLineChart({ data, series }: { data: Record<string, string | number>[]; series: string[] }) {
  const legend = useLegendHighlight();
  if (data.length === 0) return <div className="db-chart-empty">No data</div>;
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
          formatter={(value: unknown) => Number(value).toLocaleString()}
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

function SuccessErrorChart({ data, series }: { data: Record<string, string | number>[]; series: string[] }) {
  const legend = useLegendHighlight();
  if (data.length === 0) return <div className="db-chart-empty">No data</div>;
  const colorMap: Record<string, string> = { Success: '#a6e3a1', Error: '#f38ba8' };
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
        {series.map((s) => (
          <Area key={s} type="linear" dataKey={s} name={s}
            stroke={colorMap[s] ?? '#89b4fa'} fill={colorMap[s] ?? '#89b4fa'} fillOpacity={0.15} strokeWidth={2}
            opacity={legend.opacity(s)} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

function LatencyChart({ data }: { data: Record<string, string | number>[] }) {
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
