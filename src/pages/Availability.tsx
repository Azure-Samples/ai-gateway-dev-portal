import { useState, useEffect, useCallback } from 'react';
import { ShieldCheck, ArrowLeft } from 'lucide-react';
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

/** Success vs Error over time */
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

/** Success rate over time (percentage) */
function kqlSuccessRate(start: string, end: string, gran: string, models: string[], subs: string[]) {
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
| summarize Total = count(), Success = countif(ResponseCode >= 200 and ResponseCode < 400) by bin(TimeGenerated, ${gran})
| extend SuccessRate = round(todouble(Success) / todouble(Total) * 100, 2)
| project TimeGenerated, SuccessRate
| order by TimeGenerated asc
`.trim();
}

/** Error codes breakdown over time */
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

/** Error rate per model */
function kqlErrorByModel(start: string, end: string, gran: string, models: string[], subs: string[]) {
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
| summarize Total = count(), Errors = countif(ResponseCode >= 400) by bin(TimeGenerated, ${gran}), ModelName
| extend ErrorRate = round(todouble(Errors) / todouble(Total) * 100, 2)
| project TimeGenerated, ModelName, ErrorRate
| order by TimeGenerated asc
`.trim();
}

/** Error rate per subscription */
function kqlErrorBySub(start: string, end: string, gran: string, models: string[], subs: string[]) {
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
| summarize Total = count(), Errors = countif(ResponseCode >= 400) by bin(TimeGenerated, ${gran}), ApimSubscriptionId
| extend ErrorRate = round(todouble(Errors) / todouble(Total) * 100, 2)
| project TimeGenerated, ApimSubscriptionId, ErrorRate
| order by TimeGenerated asc
`.trim();
}

/** Throttling (429) over time */
function kqlThrottling(start: string, end: string, gran: string, models: string[], subs: string[]) {
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
| summarize Total = count(), Throttled = countif(ResponseCode == 429) by bin(TimeGenerated, ${gran})
| project TimeGenerated, Total, Throttled
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

export default function Availability() {
  const { config } = useAzure();
  const { instance } = useMsal();
  const service = config.apimService;
  const navigate = useNavigate();
  const getCredential = useCallback(() => createMsalCredential(instance), [instance]);

  const tb = useToolbarState();
  const { timeRange, customStart, customEnd, modelFilter, subFilter, containerRef,
    resolvedGran, setLoading, setAllModels, setAllSubs, setLastRefresh } = tb;

  /* ── Chart data ── */
  const [successError, setSuccessError] = useState<{ data: Record<string, string | number>[]; series: string[] }>({ data: [], series: [] });
  const [successRate, setSuccessRate] = useState<Record<string, string | number>[]>([]);
  const [errorCodes, setErrorCodes] = useState<{ data: Record<string, string | number>[]; series: string[] }>({ data: [], series: [] });
  const [errByModel, setErrByModel] = useState<{ data: Record<string, string | number>[]; series: string[] }>({ data: [], series: [] });
  const [errBySub, setErrBySub] = useState<{ data: Record<string, string | number>[]; series: string[] }>({ data: [], series: [] });
  const [throttling, setThrottling] = useState<Record<string, string | number>[]>([]);

  /* ── Fetch ── */
  const fetchAll = useCallback(async () => {
    if (!service) return;
    setLoading(true);
    try {
      const { start, end } = timeExprs(timeRange, customStart, customEnd);
      const cred = getCredential();
      const [r1, r2, r3, r4, r5, r6] = await Promise.all([
        queryLogAnalytics(cred, service.id, kqlSuccessError(start, end, resolvedGran, modelFilter, subFilter)),
        queryLogAnalytics(cred, service.id, kqlSuccessRate(start, end, resolvedGran, modelFilter, subFilter)),
        queryLogAnalytics(cred, service.id, kqlErrorCodes(start, end, resolvedGran, modelFilter, subFilter)),
        queryLogAnalytics(cred, service.id, kqlErrorByModel(start, end, resolvedGran, modelFilter, subFilter)),
        queryLogAnalytics(cred, service.id, kqlErrorBySub(start, end, resolvedGran, modelFilter, subFilter)),
        queryLogAnalytics(cred, service.id, kqlThrottling(start, end, resolvedGran, modelFilter, subFilter)),
      ]);

      setSuccessError(pivot(r1, 'TimeGenerated', 'Status', 'Count'));

      setSuccessRate(
        r2.map((r) => ({
          time: String(r.TimeGenerated),
          SuccessRate: num(r.SuccessRate),
        })).sort((a, b) => String(a.time).localeCompare(String(b.time))),
      );

      setErrorCodes(pivot(r3, 'TimeGenerated', 'ResponseCode', 'Count'));
      setErrByModel(pivot(r4, 'TimeGenerated', 'ModelName', 'ErrorRate'));
      setErrBySub(pivot(r5, 'TimeGenerated', 'ApimSubscriptionId', 'ErrorRate'));

      setThrottling(
        r6.map((r) => ({
          time: String(r.TimeGenerated),
          Total: num(r.Total),
          Throttled: num(r.Throttled),
        })).sort((a, b) => String(a.time).localeCompare(String(b.time))),
      );

      // Populate toolbar filters
      const subs = new Set<string>();
      const models = new Set<string>();
      for (const r of r5) subs.add(String(r.ApimSubscriptionId ?? ''));
      for (const r of r4) models.add(String(r.ModelName ?? ''));
      setAllSubs([...subs].filter(Boolean).sort());
      setAllModels([...models].filter(Boolean).sort());
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Availability query failed:', err);
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
          <h1 className="page-title">Availability</h1>
          <p className="page-description">Deep dive into availability, errors and throttling.</p>
        </div>
        <div className="page-empty">
          <ShieldCheck className="page-empty-icon" />
          <div className="page-empty-title">No APIM service selected</div>
          <p className="page-empty-text">Use the workspace selector to choose an APIM instance first.</p>
        </div>
      </div>
    );
  }

  const hasData = successError.data.length > 0 || successRate.length > 0;

  return (
    <div className="db-container" ref={containerRef}>
      <div className="req-header">
        <button className="req-back" onClick={() => void navigate('/dashboard')} title="Back to Dashboard">
          <ArrowLeft size={16} />
        </button>
        <div>
          <h2 className="req-title">Availability</h2>
          <p className="req-subtitle">Success rates, error analysis and throttling patterns</p>
        </div>
      </div>

      <AnalyticsToolbar state={tb} onRefresh={handleRefresh} />

      {tb.loading && !hasData ? (
        <div className="page-empty"><span className="spinner" /></div>
      ) : !hasData ? (
        <div className="page-empty">
          <ShieldCheck className="page-empty-icon" />
          <div className="page-empty-title">No data</div>
          <p className="page-empty-text">No availability data found for the selected time range.</p>
        </div>
      ) : (
        <div className="req-charts">
          {/* Row 1: Success vs Error + Success Rate */}
          <div className="req-chart-row">
            <ChartCard title="Success vs Error" loading={tb.loading}>
              <SuccessErrorChart data={successError.data} series={successError.series} />
            </ChartCard>
            <ChartCard title="Success Rate (%)" loading={tb.loading}>
              <SuccessRateChart data={successRate} />
            </ChartCard>
          </div>

          {/* Row 2: Error Codes + Throttling */}
          <div className="req-chart-row">
            <ChartCard title="Error Codes Over Time" loading={tb.loading}>
              <TimeLineChart data={errorCodes.data} series={errorCodes.series} />
            </ChartCard>
            <ChartCard title="Throttling (429)" loading={tb.loading}>
              <ThrottlingChart data={throttling} />
            </ChartCard>
          </div>

          {/* Row 3: Error Rate by Model + Error Rate by Subscription */}
          <div className="req-chart-row">
            <ChartCard title="Error Rate by Model (%)" loading={tb.loading}>
              <RateMultiChart data={errByModel.data} series={errByModel.series} />
            </ChartCard>
            <ChartCard title="Error Rate by Subscription (%)" loading={tb.loading}>
              <RateMultiChart data={errBySub.data} series={errBySub.series} />
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

function SuccessRateChart({ data }: { data: Record<string, string | number>[] }) {
  const legend = useLegendHighlight();
  if (data.length === 0) return <div className="db-chart-empty">No data</div>;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 8, right: 24, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
        <XAxis dataKey="time" tick={{ fill: '#8b8ba0', fontSize: 11 }} tickFormatter={fmtChartTime} stroke="rgba(255,255,255,0.08)" minTickGap={40} />
        <YAxis tick={{ fill: '#8b8ba0', fontSize: 11 }} domain={[0, 100]} tickFormatter={(v) => `${Number(v)}%`} stroke="rgba(255,255,255,0.08)" width={48} />
        <RTooltip
          contentStyle={{ background: 'var(--bg-surface, #111118)', border: '1px solid var(--border, rgba(255,255,255,0.08))', borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: 'var(--text-secondary, #8b8ba0)', marginBottom: 4 }}
          labelFormatter={fmtTooltipTime}
          formatter={(value: unknown) => `${Number(value).toFixed(2)}%`}
        />
        <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8, cursor: 'pointer' }}
          onMouseEnter={legend.handleMouseEnter} onMouseLeave={legend.handleMouseLeave} onClick={legend.handleClick} />
        <Area type="linear" dataKey="SuccessRate" name="Success Rate" stroke="#a6e3a1" fill="#a6e3a1" fillOpacity={0.15} strokeWidth={2}
          opacity={legend.opacity('SuccessRate')} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function ThrottlingChart({ data }: { data: Record<string, string | number>[] }) {
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
        <Area type="linear" dataKey="Total" name="Total Requests" stroke="#89b4fa" fill="#89b4fa" fillOpacity={0.10} strokeWidth={2}
          opacity={legend.opacity('Total')} />
        <Area type="linear" dataKey="Throttled" name="Throttled (429)" stroke="#f38ba8" fill="#f38ba8" fillOpacity={0.20} strokeWidth={2}
          opacity={legend.opacity('Throttled')} />
      </AreaChart>
    </ResponsiveContainer>
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

function RateMultiChart({ data, series }: { data: Record<string, string | number>[]; series: string[] }) {
  const legend = useLegendHighlight();
  if (data.length === 0) return <div className="db-chart-empty">No data</div>;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 24, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
        <XAxis dataKey="time" tick={{ fill: '#8b8ba0', fontSize: 11 }} tickFormatter={fmtChartTime} stroke="rgba(255,255,255,0.08)" minTickGap={40} />
        <YAxis tick={{ fill: '#8b8ba0', fontSize: 11 }} domain={[0, 'auto']} tickFormatter={(v) => `${Number(v).toFixed(0)}%`} stroke="rgba(255,255,255,0.08)" width={48} />
        <RTooltip
          contentStyle={{ background: 'var(--bg-surface, #111118)', border: '1px solid var(--border, rgba(255,255,255,0.08))', borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: 'var(--text-secondary, #8b8ba0)', marginBottom: 4 }}
          itemStyle={{ padding: '1px 0' }}
          labelFormatter={fmtTooltipTime}
          formatter={(value: unknown) => `${Number(value).toFixed(2)}%`}
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
