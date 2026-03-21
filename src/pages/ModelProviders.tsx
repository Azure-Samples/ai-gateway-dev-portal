import { useState, useEffect, useCallback } from 'react';
import { CloudCog, Search, ExternalLink, ShieldCheck, Layers, Copy, Check } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useAzure } from '../context/AzureContext';
import type { ApimBackend, ProviderType } from '../types';

const PROVIDER_LABELS: Record<ProviderType, string> = {
  foundry: 'Foundry',
  azureopenai: 'Azure OpenAI',
  openai: 'OpenAI',
  gemini: 'Gemini',
  anthropic: 'Anthropic',
  bedrock: 'Bedrock',
  huggingface: 'Hugging Face',
  unknown: 'Other',
};

const PROVIDER_ICONS: Partial<Record<ProviderType, string>> = {
  foundry: '/foundry.svg',
  azureopenai: '/azureopenai.svg',
  openai: '/openai.svg',
  gemini: '/gemini.svg',
  anthropic: '/anthropic.svg',
  bedrock: '/bedrock.svg',
  huggingface: '/huggingface.svg',
};

function ProviderBadge({ type }: { type: ProviderType }) {
  const icon = PROVIDER_ICONS[type];
  return (
    <span className="mp-provider-badge">
      {icon ? <img src={icon} alt="" className="mp-provider-icon" /> : null}
      {PROVIDER_LABELS[type]}
    </span>
  );
}

function CopyableUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <span className="mp-url-cell" title={url}>
      <span className="mp-url-text">{url}</span>
      <button className="mp-url-copy" onClick={(e) => { e.stopPropagation(); copy(); }}>
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </span>
  );
}

export default function ModelProviders() {
  const { config, workspaceData, workspaceLoading } = useAzure();

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<ProviderType | 'all'>('all');

  // Detail panel
  const location = useLocation();
  const selectId = (location.state as { selectId?: string } | null)?.selectId;
  const [selected, setSelected] = useState<ApimBackend | null>(() => {
    if (selectId) {
      const item = workspaceData.backends.find((b) => b.name === selectId);
      if (item) {
        window.history.replaceState({}, '');
        return item;
      }
    }
    return null;
  });

  const closePanel = useCallback(() => setSelected(null), []);

  useEffect(() => {
    window.addEventListener('close-detail-panel', closePanel);
    return () => window.removeEventListener('close-detail-panel', closePanel);
  }, [closePanel]);

  const service = config.apimService;

  const modelProviders = workspaceData.backends.filter((b) => b.providerType !== 'unknown');

  const providerTypes = [...new Set(modelProviders.map((b) => b.providerType))].sort();

  const filtered = modelProviders.filter((b) => {
    if (search) {
      const q = search.toLowerCase();
      if (!b.title.toLowerCase().includes(q) && !b.url.toLowerCase().includes(q) && !b.description.toLowerCase().includes(q)) return false;
    }
    if (typeFilter !== 'all' && b.providerType !== typeFilter) return false;
    return true;
  });

  if (!service) {
    return (
      <div className="page-container">
        <div className="page-header">
          <h1 className="page-title">Model Providers</h1>
          <p className="page-description">Select an APIM service to view model providers.</p>
        </div>
        <div className="page-empty">
          <CloudCog className="page-empty-icon" />
          <div className="page-empty-title">No APIM service selected</div>
          <p className="page-empty-text">Use the workspace selector to choose an APIM instance first.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container sub-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Model Providers</h1>
          <p className="page-description">APIM backends that route requests to AI model endpoints.</p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="sub-toolbar">
        <div className="sub-search">
          <Search size={14} className="sub-search-icon" />
          <input
            type="text"
            placeholder="Search backends…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="sub-filters">
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as ProviderType | 'all')}>
            <option value="all">All types</option>
            {providerTypes.map((t) => (
              <option key={t} value={t}>{PROVIDER_LABELS[t]}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Table */}
      {workspaceLoading ? (
        <div className="page-empty"><span className="spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="page-empty">
          <CloudCog className="page-empty-icon" />
          <div className="page-empty-title">
            {modelProviders.length === 0 ? 'No model providers found' : 'No matching providers'}
          </div>
          <p className="page-empty-text">
            {modelProviders.length === 0
              ? 'Connect to Microsoft Foundry, Google Gemini, AWS Bedrock, or other model providers.'
              : 'Try adjusting your search or filters.'}
          </p>
        </div>
      ) : (
        <div className="sub-table-wrap">
          <table className="sub-table">
            <thead>
              <tr>
                <th>Backend name</th>
                <th>Type</th>
                <th>Description</th>
                <th>Runtime URL</th>
                <th>Circuit breaker</th>
                <th>Load balancer pool</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((b) => (
                <tr
                  key={b.id}
                  className={`sub-row${selected?.id === b.id ? ' selected' : ''}`}
                  onClick={() => setSelected(b)}
                >
                  <td className="sub-name-cell">{b.title}</td>
                  <td><ProviderBadge type={b.providerType} /></td>
                  <td className="prod-desc-cell">{b.description || '—'}</td>
                  <td><CopyableUrl url={b.url} /></td>
                  <td>
                    {b.circuitBreaker ? (
                      <span className="sub-state-badge sub-state-active">
                        <ShieldCheck size={12} /> Enabled
                      </span>
                    ) : (
                      <span className="mp-disabled-text">—</span>
                    )}
                  </td>
                  <td>
                    {b.poolSize > 0 ? (
                      <span className="sub-scope-badge">
                        <Layers size={12} /> {b.poolSize} backends
                      </span>
                    ) : (
                      <span className="mp-disabled-text">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail panel */}
      {selected && (
        <DetailPanel
          selected={selected}
          onClose={closePanel}
        />
      )}
    </div>
  );
}

function DetailPanel({ selected, onClose }: {
  selected: ApimBackend;
  onClose: () => void;
}) {
  const hasPool = selected.poolMembers.length > 0;
  const hasCb = selected.circuitBreakerRules.length > 0;
  const hasTabs = hasPool || hasCb;
  const [tab, setTab] = useState<'details' | 'pool' | 'cb'>('details');

  const extractFoundryName = (url: string) =>
    /^https?:\/\/([^.]+)\.cognitiveservices\.azure\.com/i.exec(url)?.[1] ?? null;

  const foundryResourceName = selected.providerType === 'foundry'
    ? extractFoundryName(selected.url)
      ?? selected.poolMembers.map((m) => extractFoundryName(m.url)).find(Boolean)
      ?? null
    : null;

  return (
    <div className="sub-panel-overlay" onClick={onClose}>
      <div className="sub-panel" onClick={(e) => e.stopPropagation()}>
        <div className="sub-panel-header">
          <h2>{selected.title}</h2>
          <button className="icon-btn" onClick={onClose}>
            <span style={{ fontSize: 18 }}>&times;</span>
          </button>
        </div>
        {hasTabs && (
          <div className="mp-panel-tabs">
            <button className={`mp-panel-tab${tab === 'details' ? ' active' : ''}`} onClick={() => setTab('details')}>Details</button>
            {hasPool && (
              <button className={`mp-panel-tab${tab === 'pool' ? ' active' : ''}`} onClick={() => setTab('pool')}>
                Pool Backends <span className="mp-panel-tab-count">{selected.poolMembers.length}</span>
              </button>
            )}
            {hasCb && (
              <button className={`mp-panel-tab${tab === 'cb' ? ' active' : ''}`} onClick={() => setTab('cb')}>
                Circuit Breaker <span className="mp-panel-tab-count">{selected.circuitBreakerRules.length}</span>
              </button>
            )}
          </div>
        )}
        <div className="sub-panel-body">
          {tab === 'details' && (
            <>
              <div className="sub-panel-fields">
                <div className="sub-panel-field">
                  <label>Name (ID)</label>
                  <span>{selected.name}</span>
                </div>
                <div className="sub-panel-field">
                  <label>Display name</label>
                  <span>{selected.title}</span>
                </div>
                <div className="sub-panel-field">
                  <label>Type</label>
                  <ProviderBadge type={selected.providerType} />
                </div>
                <div className="sub-panel-field">
                  <label>Description</label>
                  <span>{selected.description || '—'}</span>
                </div>
                {foundryResourceName && (
                  <div className="sub-panel-field">
                    <label>Foundry resource</label>
                    <span>{foundryResourceName}</span>
                  </div>
                )}
                {selected.poolMembers.length === 0 && (
                  <div className="sub-panel-field">
                    <label>Runtime URL</label>
                    <span className="mp-panel-url">
                      {selected.url}
                      <a
                        href={selected.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mp-external-link"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <ExternalLink size={12} />
                      </a>
                    </span>
                  </div>
                )}
              </div>
            </>
          )}
          {tab === 'pool' && (
            <div className="mp-pool-table-wrap">
              <table className="sub-table mp-pool-table">
                <thead>
                  <tr>
                    <th>Backend</th>
                    <th>Type</th>
                    <th>URL</th>
                    <th>Weight</th>
                    <th>Priority</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.poolMembers.map((m, i) => (
                    <tr key={i}>
                      <td className="sub-name-cell">{m.name}</td>
                      <td><ProviderBadge type={m.providerType} /></td>
                      <td className="mp-pool-url-cell" title={m.url}>{m.url || '—'}</td>
                      <td>{m.weight ?? '—'}</td>
                      <td>{m.priority ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {tab === 'cb' && (
            <div className="mp-cb-rules">
              {selected.circuitBreakerRules.map((rule, i) => (
                <div key={i} className="mp-cb-rule">
                  <div className="mp-cb-rule-header">{rule.name}</div>
                  <div className="sub-panel-fields">
                    <div className="sub-panel-field">
                      <label>Trip duration</label>
                      <span>{rule.tripDuration ?? '—'}</span>
                    </div>
                    <div className="sub-panel-field">
                      <label>Accept Retry-After</label>
                      <span className={`mp-toggle-pill${rule.acceptRetryAfter ? ' on' : ''}`}>
                        <span className="mp-toggle-knob" />
                        <span className="mp-toggle-text">{rule.acceptRetryAfter ? 'Yes' : 'No'}</span>
                      </span>
                    </div>
                    {rule.failureCount != null && (
                      <div className="sub-panel-field">
                        <label>Failure count</label>
                        <span>{rule.failureCount}</span>
                      </div>
                    )}
                    {rule.failurePercentage != null && (
                      <div className="sub-panel-field">
                        <label>Failure percentage</label>
                        <span>{rule.failurePercentage}%</span>
                      </div>
                    )}
                    {rule.failureInterval && (
                      <div className="sub-panel-field">
                        <label>Failure interval</label>
                        <span>{rule.failureInterval}</span>
                      </div>
                    )}
                    {rule.statusCodeRanges.length > 0 && (
                      <div className="sub-panel-field">
                        <label>Status code ranges</label>
                        <span className="mp-cb-codes">
                          {rule.statusCodeRanges.map((r, j) => (
                            <span key={j} className="mp-cb-code-badge">
                              {r.min === r.max ? r.min : `${r.min ?? '?'}–${r.max ?? '?'}`}
                            </span>
                          ))}
                        </span>
                      </div>
                    )}
                    {rule.errorReasons.length > 0 && (
                      <div className="sub-panel-field">
                        <label>Error reasons</label>
                        <span>{rule.errorReasons.join(', ')}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
