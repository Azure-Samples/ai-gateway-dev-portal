import { useState, useEffect, useCallback, useRef } from 'react';
import { ScrollText, Search, X, ArrowUp, ArrowDown, ArrowUpDown, ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAzure } from '../context/AzureContext';
import { createMsalCredential, queryLogAnalytics } from '../services/azure';
import { useMsal } from '@azure/msal-react';
import AnalyticsToolbar, {
  useToolbarState, TIME_RANGES,
  type TimeRange,
} from '../components/AnalyticsToolbar';

interface LlmLogRow {
  timestamp: string;
  model: string;
  subscription: string;
  tokens: number;
  input: string;
  output: string;
  id: string;
}

function buildKql(timeRange: TimeRange, customStart: string, customEnd: string): string {
  let timeFilter: string;
  if (timeRange === 'custom' && customStart && customEnd) {
    timeFilter = `| where TimeGenerated > datetime('${new Date(customStart).toISOString()}') and TimeGenerated <= datetime('${new Date(customEnd).toISOString()}')`;
  } else {
    const ago = TIME_RANGES.find((t) => t.value === timeRange)?.ago ?? '24h';
    timeFilter = `| where TimeGenerated > ago(${ago})`;
  }
  return `ApiManagementGatewayLlmLog
${timeFilter}
| extend RequestArray = parse_json(RequestMessages)
| extend ResponseArray = parse_json(ResponseMessages)
| mv-expand RequestArray
| mv-expand ResponseArray
| project CorrelationId, RequestContent = tostring(RequestArray.content), ResponseContent = tostring(ResponseArray.content), ModelName, TotalTokens, DeploymentName, TimeGenerated
| summarize input = strcat_array(make_list(RequestContent), ' '), output = strcat_array(make_list(ResponseContent), ' '), ModelName = take_any(ModelName), TotalTokens = sum(TotalTokens), DeploymentName = take_any(DeploymentName), TimeGenerated = max(TimeGenerated) by CorrelationId
| where isnotempty(input) and isnotempty(output)
| join kind=leftouter (ApiManagementGatewayLogs | project CorrelationId, ApimSubscriptionId) on CorrelationId
| project timestamp = TimeGenerated, model = ModelName, subscription = ApimSubscriptionId, tokens = TotalTokens, input, output, id = CorrelationId
| order by timestamp desc`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return ts;
  }
}

export default function Logs() {
  const { config } = useAzure();
  const { instance } = useMsal();
  const navigate = useNavigate();

  const tb = useToolbarState();
  const { timeRange, customStart, customEnd, containerRef,
    setLoading, setAllModels, setAllSubs, setLastRefresh } = tb;
  const [search, setSearch] = useState('');

  type SortKey = 'timestamp' | 'subscription' | 'model' | 'tokens';
  type SortDir = 'asc' | 'desc';
  const [sortKey, setSortKey] = useState<SortKey>('timestamp');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'tokens' ? 'desc' : 'asc'); }
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown size={12} className="logs-sort-icon logs-sort-idle" />;
    return sortDir === 'asc'
      ? <ArrowUp size={12} className="logs-sort-icon" />
      : <ArrowDown size={12} className="logs-sort-icon" />;
  };
  const [rows, setRows] = useState<LlmLogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<LlmLogRow | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);

  const service = config.apimService;

  const getCredential = useCallback(() => createMsalCredential(instance), [instance]);

  const fetchLogs = useCallback(async () => {
    if (!service) return;
    setLoading(true);
    setError(null);
    try {
      const result = await queryLogAnalytics(getCredential(), service.id, buildKql(timeRange, customStart, customEnd));
      const mapped = result.map((r) => ({
          timestamp: String(r.timestamp ?? ''),
          model: String(r.model ?? ''),
          subscription: String(r.subscription ?? ''),
          tokens: Number(r.tokens ?? 0),
          input: String(r.input ?? ''),
          output: String(r.output ?? ''),
          id: String(r.id ?? ''),
        }));
      setRows(mapped);
      setAllModels([...new Set(mapped.map((r) => r.model).filter(Boolean))].sort());
      setAllSubs([...new Set(mapped.map((r) => r.subscription).filter(Boolean))].sort());
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Failed to query logs:', err);
      setError(err instanceof Error ? err.message : 'Failed to query logs');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [service, getCredential, timeRange, customStart, customEnd, setLoading, setAllModels, setAllSubs, setLastRefresh]);

  useEffect(() => {
    if (service) void fetchLogs();
  }, [service, fetchLogs]);

  const closePanel = useCallback(() => setSelected(null), []);

  useEffect(() => {
    window.addEventListener('close-detail-panel', closePanel);
    return () => window.removeEventListener('close-detail-panel', closePanel);
  }, [closePanel]);

  // Client-side filtering
  const filtered = rows.filter((r) => {
    if (tb.modelFilter.length > 0 && !tb.modelFilter.includes(r.model)) return false;
    if (tb.subFilter.length > 0 && !tb.subFilter.includes(r.subscription)) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!r.input.toLowerCase().includes(q) && !r.output.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    switch (sortKey) {
      case 'timestamp': return dir * a.timestamp.localeCompare(b.timestamp);
      case 'subscription': return dir * a.subscription.localeCompare(b.subscription);
      case 'model': return dir * a.model.localeCompare(b.model);
      case 'tokens': return dir * (a.tokens - b.tokens);
    }
  });

  if (!service) {
    return (
      <div className="page-container">
        <div className="page-header">
          <h1 className="page-title">Logs</h1>
          <p className="page-description">
            View request logs and diagnostic traces from Azure Monitor.
          </p>
        </div>
        <div className="page-empty">
          <ScrollText className="page-empty-icon" />
          <div className="page-empty-title">No APIM service selected</div>
          <p className="page-empty-text">
            Use the workspace selector to choose an APIM instance first.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="db-container logs-page" ref={containerRef}>
      <div className="req-header">
        <button className="req-back" onClick={() => void navigate('/dashboard')} title="Back to Dashboard">
          <ArrowLeft size={16} />
        </button>
        <div>
          <h2 className="req-title">Logs</h2>
          <p className="req-subtitle">Request logs and diagnostic traces from Azure Monitor</p>
        </div>
      </div>

      {/* Toolbar */}
      <AnalyticsToolbar
        state={tb}
        onRefresh={() => void fetchLogs()}
        hideGranularity
        extra={
          <div className="sub-search" style={{ marginLeft: 4 }}>
            <Search size={14} className="sub-search-icon" />
            <input
              type="text"
              placeholder="Search input / output…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        }
      />

      {/* Content */}
      {tb.loading && rows.length === 0 ? (
        <div className="page-empty"><span className="spinner" /></div>
      ) : error ? (
        <div className="page-empty">
          <ScrollText className="page-empty-icon" />
          <div className="page-empty-title">Query failed</div>
          <p className="page-empty-text">{error}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="page-empty">
          <ScrollText className="page-empty-icon" />
          <div className="page-empty-title">
            {rows.length === 0 ? 'No logs found' : 'No matching logs'}
          </div>
          <p className="page-empty-text">
            {rows.length === 0
              ? 'No LLM requests found in the selected time range.'
              : 'Try adjusting your search or filters.'}
          </p>
        </div>
      ) : (
        <div className="sub-table-wrap">
          <table className="sub-table logs-table">
            <thead>
              <tr>
                <th className="logs-sortable" onClick={() => toggleSort('timestamp')}>Timestamp <SortIcon col="timestamp" /></th>
                <th className="logs-sortable" onClick={() => toggleSort('subscription')}>Subscription <SortIcon col="subscription" /></th>
                <th className="logs-sortable" onClick={() => toggleSort('model')}>Model <SortIcon col="model" /></th>
                <th className="logs-sortable" onClick={() => toggleSort('tokens')}>Tokens <SortIcon col="tokens" /></th>
                <th>Input</th>
                <th>Output</th>
                <th>ID</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr
                  key={row.id}
                  className={`sub-row${selected?.id === row.id ? ' selected' : ''}`}
                  onClick={() => setSelected(row)}
                >
                  <td className="logs-ts-cell">{formatTimestamp(row.timestamp)}</td>
                  <td className="logs-sub-cell">{row.subscription || '—'}</td>
                  <td><span className="logs-model-badge">{row.model || '—'}</span></td>
                  <td className="logs-tokens-cell">{row.tokens.toLocaleString()}</td>
                  <td className="logs-text-cell" title={row.input}>{truncate(row.input, 80)}</td>
                  <td className="logs-text-cell" title={row.output}>{truncate(row.output, 80)}</td>
                  <td className="logs-id-cell" title={row.id}>{truncate(row.id, 12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail Panel */}
      {selected && (
        <div className="sub-panel-overlay" onClick={closePanel}>
          <div className="sub-panel logs-panel" ref={panelRef} onClick={(e) => e.stopPropagation()}>
            <div className="sub-panel-header">
              <h2>Request details</h2>
              <button className="icon-btn" onClick={closePanel}><X size={16} /></button>
            </div>
            <div className="sub-panel-body">
              <div className="sub-panel-fields">
                <div className="sub-panel-field">
                  <label>Correlation ID</label>
                  <span className="logs-detail-mono">{selected.id}</span>
                </div>
                <div className="sub-panel-field">
                  <label>Timestamp</label>
                  <span>{new Date(selected.timestamp).toLocaleString()}</span>
                </div>
                <div className="sub-panel-field">
                  <label>Subscription</label>
                  <span>{selected.subscription || '—'}</span>
                </div>
                <div className="sub-panel-field">
                  <label>Model</label>
                  <span className="logs-model-badge">{selected.model || '—'}</span>
                </div>
                <div className="sub-panel-field">
                  <label>Tokens</label>
                  <span>{selected.tokens.toLocaleString()}</span>
                </div>
              </div>
              <div className="logs-detail-section">
                <label className="logs-detail-label">Input</label>
                <div className="logs-detail-text">{selected.input}</div>
              </div>
              <div className="logs-detail-section">
                <label className="logs-detail-label">Output</label>
                <div className="logs-detail-text">{selected.output}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
