import { useState, useEffect, useCallback } from 'react';
import {
  LayoutDashboard,
  TrendingUp, TrendingDown, Minus,
  Activity, Coins, Gauge, ShieldCheck,
  BrainCog, Plug, Bot, KeyRound, Copy, Check, ScrollText,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAzure } from '../context/AzureContext';
import { createMsalCredential, queryLogAnalytics } from '../services/azure';
import { useMsal } from '@azure/msal-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip as RTooltip, Legend,
} from 'recharts';
import AnalyticsToolbar, {
  useToolbarState, TIME_RANGES,
} from '../components/AnalyticsToolbar';
import useLegendHighlight from '../hooks/useLegendHighlight';
import type { ProviderType } from '../types';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

const PROVIDER_ICONS: Partial<Record<ProviderType, string>> = {
  foundry: '/foundry.svg',
  azureopenai: '/azureopenai.svg',
  openai: '/openai.svg',
  gemini: '/gemini.svg',
  anthropic: '/anthropic.svg',
  bedrock: '/bedrock.svg',
  huggingface: '/huggingface.svg',
};

type Baseline = '1d' | '7d' | '30d' | '365d';

const CHART_COLORS = [
  '#89b4fa', '#f9e2af', '#cba6f7', '#a6e3a1', '#f38ba8',
  '#fab387', '#74c7ec', '#94e2d5', '#f5c2e7', '#eba0ac',
  '#b4befe', '#f2cdcd',
];

interface BaselineOption { value: Baseline; label: string }
const BASELINES: BaselineOption[] = [
  { value: '1d', label: 'Past day' },
  { value: '7d', label: 'Past week' },
  { value: '30d', label: 'Past month' },
  { value: '365d', label: 'Past year' },
];

interface TileData {
  totalRequests: number;
  requestsPerMin: number;
  subscriptions: string[];
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  tokensPerMin: number;
  models: string[];
  p50Latency: number;
  p95Latency: number;
  successPct: number;
  errorPct: number;
  successCount: number;
  errorCount: number;
  errorBreakdown: Record<string, number>;
  // baseline
  baselineRequests: number;
  baselineTokens: number;
  baselineP50: number;
  baselineSuccessPct: number;
}

/* ------------------------------------------------------------------ */
/*  KQL                                                                */
/* ------------------------------------------------------------------ */

function buildDashboardKql(currentStartExpr: string, currentEndExpr: string, baselineStartExpr: string, models: string[], subs: string[]): string {
  const modelClause = models.length ? `| where ModelName in (${models.map(m => `'${m}'`).join(', ')})` : '';
  const subClause = subs.length ? `| where ApimSubscriptionId in (${subs.map(s => `'${s}'`).join(', ')})` : '';
  const endClause = currentEndExpr ? `| where TimeGenerated <= ${currentEndExpr}` : '';
  return `
let currentStart = ${currentStartExpr};
let baselineStart = ${baselineStartExpr};
let joined = ApiManagementGatewayLlmLog
| where TimeGenerated > baselineStart
| join kind=leftouter ApiManagementGatewayLogs on CorrelationId
| project TimeGenerated, ModelName, PromptTokens, CompletionTokens, TotalTokens, ResponseCode, TotalTime, ApimSubscriptionId
${modelClause}
${subClause};
let current = joined
| where TimeGenerated > currentStart
${endClause}
| summarize
    totalRequests = count(),
    totalTokens = sum(TotalTokens),
    inputTokens = sum(PromptTokens),
    outputTokens = sum(CompletionTokens),
    subscriptions = make_set(ApimSubscriptionId, 100),
    models = make_set(ModelName, 100),
    p50Latency = percentile(TotalTime, 50),
    p95Latency = percentile(TotalTime, 95),
    successCount = countif(ResponseCode >= 200 and ResponseCode < 400),
    errorCount = countif(ResponseCode >= 400),
    timeSpanSec = datetime_diff('second', max(TimeGenerated), min(TimeGenerated));
let baseline = joined
| where TimeGenerated > baselineStart and TimeGenerated <= currentStart
| summarize
    baselineRequests = count(),
    baselineTokens = sum(TotalTokens),
    baselineP50 = percentile(TotalTime, 50),
    baselineSuccessCount = countif(ResponseCode >= 200 and ResponseCode < 400),
    baselineTotal = count();
let errors = joined
| where TimeGenerated > currentStart and ResponseCode >= 400
${endClause}
| summarize errorCount = count() by tostring(ResponseCode);
current | extend placeholder = 1
| join kind=leftouter (baseline | extend placeholder = 1) on placeholder
| project-away placeholder, placeholder1
| extend errBreakdown = toscalar(errors | summarize make_bag(bag_pack(ResponseCode, errorCount)))
| extend baselineSuccessPct = iff(baselineTotal > 0, round(todouble(baselineSuccessCount) / todouble(baselineTotal) * 100, 2), 0.0)
`.trim();
}

/** Build KQL for tokens-per-subscription time series. */
function buildChartKql(
  currentStartExpr: string, currentEndExpr: string,
  granularity: string, models: string[], subs: string[],
): string {
  const modelClause = models.length ? `| where ModelName in (${models.map(m => `'${m}'`).join(', ')})` : '';
  const subClause = subs.length ? `| where ApimSubscriptionId in (${subs.map(s => `'${s}'`).join(', ')})` : '';
  const endClause = currentEndExpr ? `| where TimeGenerated <= ${currentEndExpr}` : '';
  return `
ApiManagementGatewayLlmLog
| where TimeGenerated > ${currentStartExpr}
${endClause}
| join kind=leftouter ApiManagementGatewayLogs on CorrelationId
| project TimeGenerated, TotalTokens, ApimSubscriptionId, ModelName
${modelClause}
${subClause}
| summarize Tokens = sum(TotalTokens) by bin(TimeGenerated, ${granularity}), ApimSubscriptionId
| order by TimeGenerated asc
`.trim();
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}

function fmtPct(actual: number, baseline: number): { pct: number; direction: 'up' | 'down' | 'flat' } {
  if (baseline === 0) return { pct: 0, direction: 'flat' };
  const pct = ((actual - baseline) / baseline) * 100;
  return { pct: Math.abs(Math.round(pct)), direction: pct > 1 ? 'up' : pct < -1 ? 'down' : 'flat' };
}

function fmtLatency(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
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

/* ------------------------------------------------------------------ */
/*  Tooltip component                                                  */
/* ------------------------------------------------------------------ */

function Tip({ text, children }: { text: string; children: React.ReactNode }) {
  return <span className="db-tip-wrap" title={text}>{children}</span>;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function Dashboard() {
  const { config, workspaceData } = useAzure();
  const { instance } = useMsal();
  const service = config.apimService;

  const getCredential = useCallback(() => createMsalCredential(instance), [instance]);

  /* --- Shared toolbar state ---------------------------------------- */
  const tb = useToolbarState();
  const legend = useLegendHighlight();
  const { timeRange, customStart, customEnd, modelFilter, subFilter, containerRef,
    resolvedGran, setLoading, setAllModels, setAllSubs, setLastRefresh } = tb;
  const navigate = useNavigate();

  /* --- Dashboard-specific state ----------------------------------- */
  const [baseline, setBaseline] = useState<Baseline>('30d');
  const [chartData, setChartData] = useState<Record<string, string | number>[]>([]);
  const [chartSubs, setChartSubs] = useState<string[]>([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [data, setData] = useState<TileData | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  /* --- Fetch data ------------------------------------------------- */
  const fetchData = useCallback(async () => {
    if (!service) return;
    setLoading(true);
    try {
      let currentStartExpr: string;
      let currentEndExpr = '';
      if (timeRange === 'custom' && customStart && customEnd) {
        currentStartExpr = `datetime('${new Date(customStart).toISOString()}')`;
        currentEndExpr = `datetime('${new Date(customEnd).toISOString()}')`;
      } else {
        const ago = TIME_RANGES.find((t) => t.value === timeRange)?.ago ?? '30m';
        currentStartExpr = `ago(${ago})`;
      }
      const baselineStartExpr = `ago(${baseline})`;
      const rows = await queryLogAnalytics(
        getCredential(),
        service.id,
        buildDashboardKql(currentStartExpr, currentEndExpr, baselineStartExpr, modelFilter, subFilter),
      );
      if (rows.length === 0) {
        setData(null);
        setAllModels([]);
        setAllSubs([]);
        setLastRefresh(new Date());
        return;
      }
      const r = rows[0];
      const subscriptions = parseJsonArray(r.subscriptions);
      const models = parseJsonArray(r.models);
      const totalReqs = num(r.totalRequests);
      const timeSpanSec = Math.max(num(r.timeSpanSec), 1);
      const totalTok = num(r.totalTokens);
      const successCnt = num(r.successCount);
      const errorCnt = num(r.errorCount);
      const total = successCnt + errorCnt;

      const baselineTotal = num(r.baselineRequests);
      const baselineSuccessPct = num(r.baselineSuccessPct);

      setData({
        totalRequests: totalReqs,
        requestsPerMin: Math.round((totalReqs / timeSpanSec) * 60 * 100) / 100,
        subscriptions,
        totalTokens: totalTok,
        inputTokens: num(r.inputTokens),
        outputTokens: num(r.outputTokens),
        tokensPerMin: Math.round((totalTok / timeSpanSec) * 60 * 100) / 100,
        models,
        p50Latency: num(r.p50Latency),
        p95Latency: num(r.p95Latency),
        successPct: total > 0 ? Math.round((successCnt / total) * 10000) / 100 : 100,
        errorPct: total > 0 ? Math.round((errorCnt / total) * 10000) / 100 : 0,
        successCount: successCnt,
        errorCount: errorCnt,
        errorBreakdown: parseErrorBreakdown(r.errBreakdown),
        baselineRequests: baselineTotal,
        baselineTokens: num(r.baselineTokens),
        baselineP50: num(r.baselineP50),
        baselineSuccessPct,
      });
      setAllModels(models);
      setAllSubs(subscriptions);
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Dashboard query failed:', err);
    } finally {
      setLoading(false);
    }
  }, [service, timeRange, baseline, modelFilter, subFilter, customStart, customEnd, getCredential, setLoading, setAllModels, setAllSubs, setLastRefresh]);

  /* --- Fetch chart data ------------------------------------------- */
  const fetchChart = useCallback(async () => {
    if (!service) return;
    setChartLoading(true);
    try {
      let currentStartExpr: string;
      let currentEndExpr = '';
      if (timeRange === 'custom' && customStart && customEnd) {
        currentStartExpr = `datetime('${new Date(customStart).toISOString()}')`;
        currentEndExpr = `datetime('${new Date(customEnd).toISOString()}')`;
      } else {
        const ago = TIME_RANGES.find((t) => t.value === timeRange)?.ago ?? '30m';
        currentStartExpr = `ago(${ago})`;
      }
      const rows = await queryLogAnalytics(
        getCredential(),
        service.id,
        buildChartKql(currentStartExpr, currentEndExpr, resolvedGran, modelFilter, subFilter),
      );
      // Pivot rows: group by time, columns per subscription
      const timeMap = new Map<string, Record<string, string | number>>();
      const subsSet = new Set<string>();
      for (const r of rows) {
        const t = String(r.TimeGenerated);
        const sub = String(r.ApimSubscriptionId ?? 'unknown');
        const tokens = num(r.Tokens);
        subsSet.add(sub);
        let entry = timeMap.get(t);
        if (!entry) { entry = { time: t }; timeMap.set(t, entry); }
        entry[sub] = tokens;
      }
      const subs = [...subsSet].sort();
      // Fill zeros and sort by time
      const points = [...timeMap.values()]
        .map((p) => {
          for (const s of subs) if (!(s in p)) p[s] = 0;
          return p;
        })
        .sort((a, b) => String(a.time).localeCompare(String(b.time)));
      setChartSubs(subs);
      setChartData(points);
    } catch (err) {
      console.error('Chart query failed:', err);
    } finally {
      setChartLoading(false);
    }
  }, [service, timeRange, customStart, customEnd, resolvedGran, modelFilter, subFilter, getCredential]);

  /* biome-ignore lint: fetch on mount and filter change */
  useEffect(() => { void fetchData(); void fetchChart(); }, [fetchData, fetchChart]);

  const handleRefresh = useCallback(() => { void fetchData(); void fetchChart(); }, [fetchData, fetchChart]);

  /* --- Empty state ------------------------------------------------ */
  if (!service) {
    return (
      <div className="page-container">
        <div className="page-header">
          <h1 className="page-title">Dashboard</h1>
          <p className="page-description">
            Overview of your AI Gateway resources, usage metrics, and health status.
          </p>
        </div>
        <div className="page-empty">
          <LayoutDashboard className="page-empty-icon" />
          <div className="page-empty-title">Dashboard</div>
          <p className="page-empty-text">
            Select an Azure Subscription and API Management workspace to view your dashboard.
          </p>
        </div>
      </div>
    );
  }

  /* --- Derived ---------------------------------------------------- */
  const vol = data ? fmtPct(data.totalRequests, data.baselineRequests) : null;
  const usage = data ? fmtPct(data.totalTokens, data.baselineTokens) : null;
  const perf = data ? fmtPct(data.p50Latency, data.baselineP50) : null;
  const avail = data ? fmtPct(data.successPct, data.baselineSuccessPct) : null;

  return (
    <div className="db-container" ref={containerRef}>
      {/* ── Toolbar ── */}
      <AnalyticsToolbar
        state={tb}
        onRefresh={handleRefresh}
        extra={
          <select className="db-filter-select" value={baseline} onChange={(e) => setBaseline(e.target.value as Baseline)}>
            {BASELINES.map((b) => <option key={b.value} value={b.value}>Baseline: {b.label}</option>)}
          </select>
        }
      />

      {/* ── Tiles ── */}
      {tb.loading && !data ? (
        <div className="page-empty"><span className="spinner" /></div>
      ) : !data ? (
        <div className="page-empty">
          <LayoutDashboard className="page-empty-icon" />
          <div className="page-empty-title">No data</div>
          <p className="page-empty-text">No LLM log data found for the selected time range.</p>
        </div>
      ) : (
        <div className="db-tiles">
          {/* Volume */}
          <div className="db-tile db-tile-volume db-tile-clickable" onClick={() => void navigate('/requests')} title="View request details">
            <div className="db-tile-icon db-icon-volume"><Activity size={20} /></div>
            <div className="db-tile-corners">
              <Tip text={data.subscriptions.map(s => `• ${s}`).join('\n')}>
                <span className="db-tile-corner">{data.subscriptions.length} subscriptions</span>
              </Tip>
              <Tip text={`${data.requestsPerMin.toFixed(2)} requests per minute`}>
                <span className="db-tile-corner">{fmtNum(data.requestsPerMin)} rpm</span>
              </Tip>
            </div>
            <div className="db-tile-main">
              <Tip text={`${data.totalRequests.toLocaleString()} total requests`}>
                <span className="db-tile-big">{fmtNum(data.totalRequests)}</span>
              </Tip>
              <span className="db-tile-unit">requests</span>
            </div>
            {vol && (
              <Tip text={`Current: ${data.totalRequests.toLocaleString()} | Baseline: ${data.baselineRequests.toLocaleString()} | ${vol.direction === 'up' ? '+' : vol.direction === 'down' ? '-' : ''}${vol.pct}%`}>
                <div className="db-tile-trend">
                  <TrendIcon direction={vol.direction} />
                  <span>{vol.pct}%</span>
                </div>
              </Tip>
            )}
          </div>

          {/* Usage */}
          <div className="db-tile db-tile-usage db-tile-clickable" onClick={() => void navigate('/tokens')} title="View token usage details">
            <div className="db-tile-icon db-icon-usage"><Coins size={20} /></div>
            <div className="db-tile-corners">
              <Tip text={data.models.map(m => `• ${m}`).join('\n')}>
                <span className="db-tile-corner">{data.models.length} models</span>
              </Tip>
              <Tip text={`${data.tokensPerMin.toFixed(2)} tokens per minute`}>
                <span className="db-tile-corner">{fmtNum(data.tokensPerMin)} tpm</span>
              </Tip>
            </div>
            <div className="db-tile-main">
              <Tip text={`Input: ${data.inputTokens.toLocaleString()} | Output: ${data.outputTokens.toLocaleString()} | Total: ${data.totalTokens.toLocaleString()}`}>
                <span className="db-tile-big">{fmtNum(data.totalTokens)}</span>
              </Tip>
              <span className="db-tile-unit">tokens</span>
            </div>
            {usage && (
              <Tip text={`Current: ${data.totalTokens.toLocaleString()} | Baseline: ${data.baselineTokens.toLocaleString()} | ${usage.direction === 'up' ? '+' : usage.direction === 'down' ? '-' : ''}${usage.pct}%`}>
                <div className="db-tile-trend">
                  <TrendIcon direction={usage.direction} />
                  <span>{usage.pct}%</span>
                </div>
              </Tip>
            )}
          </div>

          {/* Performance */}
          <div className="db-tile db-tile-perf db-tile-clickable" onClick={() => void navigate('/performance')} title="View performance details">
            <div className="db-tile-icon db-icon-perf"><Gauge size={20} /></div>
            <div className="db-tile-corners">
              <Tip text={`${data.totalRequests.toLocaleString()} total requests`}>
                <span className="db-tile-corner">{fmtNum(data.totalRequests)} requests</span>
              </Tip>
              <Tip text={`${data.requestsPerMin.toFixed(2)} requests per minute`}>
                <span className="db-tile-corner">{fmtNum(data.requestsPerMin)} rpm</span>
              </Tip>
            </div>
            <div className="db-tile-main">
              <Tip text={`P50: ${fmtLatency(data.p50Latency)} | P95: ${fmtLatency(data.p95Latency)}`}>
                <span className="db-tile-big">{fmtLatency(data.p50Latency)}</span>
              </Tip>
              <span className="db-tile-unit">p50 latency</span>
            </div>
            {perf && (
              <Tip text={`Current: ${fmtLatency(data.p50Latency)} | Baseline: ${fmtLatency(data.baselineP50)} | ${perf.direction === 'up' ? '+' : perf.direction === 'down' ? '-' : ''}${perf.pct}%`}>
                <div className={`db-tile-trend ${perf.direction === 'up' ? 'trend-bad' : perf.direction === 'down' ? 'trend-good' : ''}`}>
                  <TrendIcon direction={perf.direction} />
                  <span>{perf.pct}%</span>
                </div>
              </Tip>
            )}
          </div>

          {/* Availability */}
          <div className="db-tile db-tile-avail db-tile-clickable" onClick={() => void navigate('/availability')} title="View availability details">
            <div className="db-tile-icon db-icon-avail"><ShieldCheck size={20} /></div>
            <div className="db-tile-corners">
              <Tip text={`${data.successCount.toLocaleString()} successful requests`}>
                <span className="db-tile-corner">{fmtNum(data.totalRequests)} requests</span>
              </Tip>
              <Tip text={`Error breakdown: ${Object.entries(data.errorBreakdown).map(([k, v]) => `${k}: ${v.toString()}`).join(', ') || 'none'}`}>
                <span className="db-tile-corner db-tile-corner-err">{data.errorPct}% errors</span>
              </Tip>
            </div>
            <div className="db-tile-main">
              <Tip text={`Successful: ${data.successCount.toLocaleString()} | Errors: ${data.errorCount.toLocaleString()} | Total: ${data.totalRequests.toLocaleString()}`}>
                <span className="db-tile-big">{data.successPct}%</span>
              </Tip>
              <span className="db-tile-unit">successful</span>
            </div>
            {avail && (
              <Tip text={`Current: ${data.successPct}% | Baseline: ${data.baselineSuccessPct}% | ${avail.direction === 'up' ? '+' : avail.direction === 'down' ? '-' : ''}${avail.pct}%`}>
                <div className={`db-tile-trend ${avail.direction === 'up' ? 'trend-good' : avail.direction === 'down' ? 'trend-bad' : ''}`}>
                  <TrendIcon direction={avail.direction} />
                  <span>{avail.pct}%</span>
                </div>
              </Tip>
            )}
          </div>
        </div>
      )}

      {/* ── Token Usage Chart ── */}
      <div className="db-chart-section">
        <div className="db-chart-header">
          <h3 className="db-chart-title">
            <Coins size={16} />
            Tokens by Subscription
          </h3>
          <button className="db-chart-action" onClick={() => void navigate('/logs')} title="View logs">
            <ScrollText size={14} />
            View logs
          </button>
        </div>
        <div className="db-chart-body">
          {chartLoading && chartData.length === 0 ? (
            <div className="db-chart-empty"><span className="spinner" /></div>
          ) : chartData.length === 0 ? (
            <div className="db-chart-empty">No token data for the selected range</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={chartData} margin={{ top: 8, right: 24, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                <XAxis
                  dataKey="time"
                  tick={{ fill: '#8b8ba0', fontSize: 11 }}
                  tickFormatter={fmtChartTime}
                  stroke="rgba(255,255,255,0.08)"
                  minTickGap={40}
                />
                <YAxis
                  tick={{ fill: '#8b8ba0', fontSize: 11 }}
                  tickFormatter={fmtNum}
                  stroke="rgba(255,255,255,0.08)"
                  width={52}
                />
                <RTooltip
                  contentStyle={{
                    background: 'var(--bg-surface, #111118)',
                    border: '1px solid var(--border, rgba(255,255,255,0.08))',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: 'var(--text-secondary, #8b8ba0)', marginBottom: 4 }}
                  itemStyle={{ padding: '1px 0' }}
                  labelFormatter={fmtTooltipTime}
                  formatter={(value: unknown) => Number(value).toLocaleString()}
                />
                <Legend
                  wrapperStyle={{ fontSize: 12, paddingTop: 8, cursor: 'pointer' }}
                  onMouseEnter={legend.handleMouseEnter}
                  onMouseLeave={legend.handleMouseLeave}
                  onClick={legend.handleClick}
                />
                {chartSubs.map((sub, i) => {
                  const color = CHART_COLORS[i % CHART_COLORS.length];
                  return (
                    <Line
                      key={sub}
                      type="linear"
                      dataKey={sub}
                      name={sub}
                      stroke={color}
                      strokeWidth={2}
                      opacity={legend.opacity(sub)}
                      dot={{ r: 3, fill: color, strokeWidth: 0 }}
                      activeDot={{ r: 5, fill: color, strokeWidth: 0 }}
                    />
                  );
                })}
              </LineChart>
            </ResponsiveContainer>
          )}
          {chartLoading && chartData.length > 0 && (
            <div className="db-chart-loading-overlay"><span className="spinner" /></div>
          )}
        </div>
      </div>

      {/* ── Resource List Tiles ── */}
      <div className="db-list-tiles">
        <div className="db-list-tile db-tile-clickable" onClick={() => void navigate('/inference-apis')} title="View Inference APIs">
          <div className="db-list-tile-header">
            <BrainCog size={16} />
            <h3>Inference APIs</h3>
            <span className="db-list-tile-count">{workspaceData.inferenceApis.length}</span>
          </div>
          <ul className="db-list-tile-items">
            {workspaceData.inferenceApis.slice(0, 8).map((api) => (
              <li key={api.id} className="db-list-tile-item-row">
                {PROVIDER_ICONS[api.providerType] && (
                  <img src={PROVIDER_ICONS[api.providerType]} alt="" className="db-list-tile-provider-icon" />
                )}
                <span className="db-list-tile-item-name">{api.displayName}</span>
              </li>
            ))}
            {workspaceData.inferenceApis.length === 0 && <li className="db-list-tile-empty">No APIs found</li>}
            {workspaceData.inferenceApis.length > 8 && <li className="db-list-tile-more">+{workspaceData.inferenceApis.length - 8} more</li>}
          </ul>
        </div>

        <div className="db-list-tile db-tile-clickable" onClick={() => void navigate('/mcp-servers')} title="View MCP servers">
          <div className="db-list-tile-header">
            <Plug size={16} />
            <h3>MCP servers</h3>
            <span className="db-list-tile-count">{workspaceData.mcpServers.length}</span>
          </div>
          <ul className="db-list-tile-items">
            {workspaceData.mcpServers.slice(0, 8).map((s) => (
              <li key={s.id}>{s.displayName}</li>
            ))}
            {workspaceData.mcpServers.length === 0 && <li className="db-list-tile-empty">No MCP servers found</li>}
            {workspaceData.mcpServers.length > 8 && <li className="db-list-tile-more">+{workspaceData.mcpServers.length - 8} more</li>}
          </ul>
        </div>

        <div className="db-list-tile db-tile-clickable" onClick={() => void navigate('/a2a')} title="View A2A integrations">
          <div className="db-list-tile-header">
            <Bot size={16} />
            <h3>A2A integrations</h3>
            <span className="db-list-tile-count">{workspaceData.a2aServers.length}</span>
          </div>
          <ul className="db-list-tile-items">
            {workspaceData.a2aServers.slice(0, 8).map((a) => (
              <li key={a.id}>{a.displayName}</li>
            ))}
            {workspaceData.a2aServers.length === 0 && <li className="db-list-tile-empty">No A2A integrations found</li>}
            {workspaceData.a2aServers.length > 8 && <li className="db-list-tile-more">+{workspaceData.a2aServers.length - 8} more</li>}
          </ul>
        </div>

        <div className="db-list-tile db-tile-clickable" onClick={() => void navigate('/subscriptions')} title="View Subscriptions">
          <div className="db-list-tile-header">
            <KeyRound size={16} />
            <h3>Subscriptions</h3>
            <span className="db-list-tile-count">{workspaceData.subscriptions.length}</span>
          </div>
          <ul className="db-list-tile-items">
            {workspaceData.subscriptions.slice(0, 8).map((sub) => (
              <li key={sub.id} className="db-list-tile-item-row">
                <span className="db-list-tile-item-name">{sub.displayName}</span>
                {sub.primaryKey && (
                  <button
                    className="db-list-tile-copy-btn"
                    title="Copy primary key"
                    onClick={(e) => {
                      e.stopPropagation();
                      void navigator.clipboard.writeText(sub.primaryKey).then(() => {
                        setCopiedKey(sub.id);
                        setTimeout(() => setCopiedKey(null), 2000);
                      });
                    }}
                  >
                    {copiedKey === sub.id ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                )}
              </li>
            ))}
            {workspaceData.subscriptions.length === 0 && <li className="db-list-tile-empty">No subscriptions found</li>}
            {workspaceData.subscriptions.length > 8 && <li className="db-list-tile-more">+{workspaceData.subscriptions.length - 8} more</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Small helpers                                                      */
/* ------------------------------------------------------------------ */

function TrendIcon({ direction }: { direction: 'up' | 'down' | 'flat' }) {
  if (direction === 'up') return <TrendingUp size={14} />;
  if (direction === 'down') return <TrendingDown size={14} />;
  return <Minus size={14} />;
}

function num(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseJsonArray(v: string | number | null | undefined): string[] {
  if (v == null) return [];
  try {
    const arr = JSON.parse(String(v)) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string' && x !== '') : [];
  } catch {
    return [];
  }
}

function parseErrorBreakdown(v: string | number | null | undefined): Record<string, number> {
  if (v == null) return {};
  try {
    const obj = JSON.parse(String(v)) as unknown;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as Record<string, number>;
    return {};
  } catch {
    return {};
  }
}
