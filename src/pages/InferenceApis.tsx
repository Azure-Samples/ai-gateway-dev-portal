import { useState, useCallback, useEffect } from 'react';
import { BrainCog, Search, Copy, Check, X, Play } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAzure } from '../context/AzureContext';
import {
  createMsalCredential,
  getApimApiDetail,
  listApimApiRevisions,
  listApimApiReleases,
  listApiProducts,
} from '../services/azure';
import { useMsal } from '@azure/msal-react';
import type { InferenceApi, ApimApiDetail, ApimApiRevision, ApimApiRelease, ApimProduct, ProviderType } from '../types';

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

function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <span className="ia-copy-value">
      <span className="ia-copy-text">{value}</span>
      <button className="ia-copy-btn" onClick={copy} title="Copy">
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </span>
  );
}

interface ApiDetailData {
  detail: ApimApiDetail;
  revisions: ApimApiRevision[];
  releases: ApimApiRelease[];
  products: ApimProduct[];
}

export default function InferenceApis() {
  const { config, workspaceData, workspaceLoading } = useAzure();
  const { instance } = useMsal();

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<ProviderType | 'all'>('all');
  const [tagFilter, setTagFilter] = useState<string>('all');

  // Detail panel
  const [selectedApi, setSelectedApi] = useState<InferenceApi | null>(null);
  const [detailData, setDetailData] = useState<ApiDetailData | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'subscription' | 'revisions' | 'releases' | 'products'>('overview');

  const service = config.apimService;
  const getCredential = useCallback(() => createMsalCredential(instance), [instance]);

  const inferenceApis = workspaceData.inferenceApis;

  // Derive available filter options
  const providerTypes = [...new Set(inferenceApis.map((a) => a.providerType))].sort();
  const allTags = [...new Set(inferenceApis.flatMap((a) => a.tags.map((t) => t.displayName)))].sort();

  const loadDetail = useCallback(async (api: InferenceApi) => {
    if (!service) return;
    setLoadingDetail(true);
    const cred = getCredential();
    const { subscriptionId, resourceGroup, name } = service;
    try {
      const [detail, revisions, releases, products] = await Promise.all([
        getApimApiDetail(cred, subscriptionId, resourceGroup, name, api.name),
        listApimApiRevisions(cred, subscriptionId, resourceGroup, name, api.name).catch(() => [] as ApimApiRevision[]),
        listApimApiReleases(cred, subscriptionId, resourceGroup, name, api.name).catch(() => [] as ApimApiRelease[]),
        listApiProducts(cred, subscriptionId, resourceGroup, name, api.name).catch(() => [] as ApimProduct[]),
      ]);
      setDetailData({ detail, revisions, releases, products });
    } catch (err) {
      console.error('Failed to load API details:', err);
      setDetailData(null);
    } finally {
      setLoadingDetail(false);
    }
  }, [service, getCredential]);

  const openDetail = (api: InferenceApi) => {
    setSelectedApi(api);
    setActiveTab('overview');
    void loadDetail(api);
  };

  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const selectId = (location.state as { selectId?: string } | null)?.selectId;
    if (selectId) {
      const item = inferenceApis.find((a) => a.name === selectId);
      if (item) openDetail(item);
      window.history.replaceState({}, '');
    }
  }, [location.state, inferenceApis]); // eslint-disable-line react-hooks/exhaustive-deps

  const closePanel = useCallback(() => {
    setSelectedApi(null);
    setDetailData(null);
  }, []);

  useEffect(() => {
    window.addEventListener('close-detail-panel', closePanel);
    return () => window.removeEventListener('close-detail-panel', closePanel);
  }, [closePanel]);

  const filtered = inferenceApis.filter((a) => {
    if (search) {
      const q = search.toLowerCase();
      if (!a.displayName.toLowerCase().includes(q) && !a.path.toLowerCase().includes(q)) return false;
    }
    if (typeFilter !== 'all' && a.providerType !== typeFilter) return false;
    if (tagFilter !== 'all' && !a.tags.some((t) => t.displayName === tagFilter)) return false;
    return true;
  });

  const baseUrl = service
    ? `https://${service.name}.azure-api.net`
    : '';

  if (!service) {
    return (
      <div className="page-container">
        <div className="page-header">
          <h1 className="page-title">Inference APIs</h1>
          <p className="page-description">Select an APIM service to view inference APIs.</p>
        </div>
        <div className="page-empty">
          <BrainCog className="page-empty-icon" />
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
          <h1 className="page-title">Inference APIs</h1>
          <p className="page-description">API endpoints routed to AI model providers through the gateway.</p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="sub-toolbar">
        <div className="sub-search">
          <Search size={14} className="sub-search-icon" />
          <input
            type="text"
            placeholder="Search APIs…"
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
          {allTags.length > 0 && (
            <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
              <option value="all">All tags</option>
              {allTags.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Table */}
      {workspaceLoading ? (
        <div className="page-empty"><span className="spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="page-empty">
          <BrainCog className="page-empty-icon" />
          <div className="page-empty-title">
            {inferenceApis.length === 0 ? 'No inference APIs found' : 'No matching APIs'}
          </div>
          <p className="page-empty-text">
            {inferenceApis.length === 0
              ? 'Inference APIs are detected from APIs that have a set-backend-service policy pointing to a model provider.'
              : 'Try adjusting your search or filters.'}
          </p>
        </div>
      ) : (
        <div className="sub-table-wrap">
          <table className="sub-table">
            <thead>
              <tr>
                <th>Display name</th>
                <th>Path</th>
                <th>Type</th>
                <th>Backend</th>
                <th>Tags</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((api) => (
                <tr
                  key={api.id}
                  className={`sub-row${selectedApi?.id === api.id ? ' selected' : ''}`}
                  onClick={() => openDetail(api)}
                >
                  <td className="sub-name-cell">{api.displayName}</td>
                  <td className="ia-path-cell">/{api.path}</td>
                  <td><ProviderBadge type={api.providerType} /></td>
                  <td className="ia-backend-cell">{api.backendId}</td>
                  <td>
                    {api.tags.length > 0 ? (
                      <div className="ia-tags-inline">
                        {api.tags.map((tag) => (
                          <span key={tag.id} className="ia-tag">{tag.displayName}</span>
                        ))}
                      </div>
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
      {selectedApi && (
        <div className="sub-panel-overlay" onClick={closePanel}>
          <div className="sub-panel ia-panel" onClick={(e) => e.stopPropagation()}>
            <div className="sub-panel-header">
              <h2>{selectedApi.displayName}</h2>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  className="sub-btn-primary"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}
                  onClick={() => navigate('/playground', { state: { inferenceApi: selectedApi } })}
                >
                  <Play size={13} /> Use in playground
                </button>
                <button className="icon-btn" onClick={closePanel}><X size={16} /></button>
              </div>
            </div>

            {/* Tabs */}
            <div className="ia-tabs">
              {(['overview', 'subscription', 'revisions', 'releases', 'products'] as const).map((tab) => (
                <button
                  key={tab}
                  className={`ia-tab${activeTab === tab ? ' active' : ''}`}
                  onClick={() => setActiveTab(tab)}
                >
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>

            <div className="sub-panel-body">
              {loadingDetail ? (
                <div className="page-empty"><span className="spinner spinner-sm" /></div>
              ) : !detailData ? (
                <div className="ia-error">Failed to load API details.</div>
              ) : (
                <>
                  {activeTab === 'overview' && (
                    <div className="ia-overview">
                      <div className="sub-panel-fields">
                        <div className="sub-panel-field">
                          <label>Model provider</label>
                          <ProviderBadge type={selectedApi.providerType} />
                        </div>
                        <div className="sub-panel-field">
                          <label>Backend</label>
                          <span className="ia-mono">{selectedApi.backendId}</span>
                        </div>
                        <div className="sub-panel-field">
                          <label>Description</label>
                          <span>{detailData.detail.description || '—'}</span>
                        </div>
                        <div className="sub-panel-field">
                          <label>Base URL</label>
                          <CopyValue value={`${baseUrl}/${detailData.detail.path}`} />
                        </div>
                        <div className="sub-panel-field">
                          <label>API version</label>
                          <span>{detailData.detail.apiVersion || '—'}</span>
                        </div>
                        <div className="sub-panel-field">
                          <label>Current revision</label>
                          <span>Rev. {detailData.detail.apiRevision}</span>
                        </div>
                      </div>

                      {/* Tags */}
                      {selectedApi.tags.length > 0 && (
                        <div className="ia-section">
                          <div className="ia-section-title">Tags</div>
                          <div className="ia-tags">
                            {selectedApi.tags.map((tag) => (
                              <span key={tag.id} className="ia-tag">{tag.displayName}</span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {activeTab === 'subscription' && (
                    <div className="ia-overview">
                      <div className="sub-panel-fields">
                        <div className="sub-panel-field">
                          <label>Required</label>
                          <span className={`ia-toggle ${detailData.detail.subscriptionRequired ? 'on' : 'off'}`}>
                            <span className="ia-toggle-track"><span className="ia-toggle-thumb" /></span>
                            {detailData.detail.subscriptionRequired ? 'Yes' : 'No'}
                          </span>
                        </div>
                        {detailData.detail.subscriptionRequired && (
                          <>
                            <div className="sub-panel-field">
                              <label>Header name</label>
                              <CopyValue value={detailData.detail.subscriptionKeyParameterNames.header ?? '—'} />
                            </div>
                            <div className="sub-panel-field">
                              <label>Query parameter</label>
                              <CopyValue value={detailData.detail.subscriptionKeyParameterNames.query ?? '—'} />
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  )}

                  {activeTab === 'revisions' && (
                    <div className="ia-revisions">
                      {detailData.revisions.length === 0 ? (
                        <div className="ia-empty-tab">No revisions found.</div>
                      ) : (
                        <div className="ia-revision-list">
                          {detailData.revisions.map((rev) => (
                            <div key={rev.apiRevision} className={`ia-revision-item${rev.isCurrent ? ' current' : ''}`}>
                              <div className="ia-revision-header">
                                <span className="ia-revision-num">Rev. {rev.apiRevision}</span>
                                {rev.isCurrent && <span className="sub-state-badge sub-state-active">Current</span>}
                              </div>
                              {rev.description && <div className="ia-revision-desc">{rev.description}</div>}
                              <div className="ia-revision-date">
                                {rev.createdDateTime ? new Date(rev.createdDateTime).toLocaleDateString() : ''}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {activeTab === 'releases' && (
                    <div className="ia-releases">
                      {detailData.releases.length === 0 ? (
                        <div className="ia-empty-tab">No releases (change log entries) found.</div>
                      ) : (
                        <div className="ia-release-list">
                          {detailData.releases.map((rel) => (
                            <div key={rel.releaseId} className="ia-release-item">
                              <div className="ia-release-header">
                                <span className="ia-release-id">{rel.releaseId}</span>
                                <span className="ia-release-date">
                                  {rel.createdDateTime ? new Date(rel.createdDateTime).toLocaleDateString() : ''}
                                </span>
                              </div>
                              {rel.notes && <div className="ia-release-notes">{rel.notes}</div>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {activeTab === 'products' && (
                    <div className="ia-products">
                      {detailData.products.length === 0 ? (
                        <div className="ia-empty-tab">This API is not associated with any product.</div>
                      ) : (
                        <div className="ia-product-list">
                          {detailData.products.map((prod) => (
                            <div key={prod.id} className="ia-product-item">
                              <div className="ia-product-name">{prod.displayName}</div>
                              <div className="ia-product-meta">
                                <span className={`sub-state-badge sub-state-${prod.state === 'published' ? 'active' : 'suspended'}`}>
                                  {prod.state === 'published' ? 'Published' : 'Not published'}
                                </span>
                                {prod.subscriptionRequired && (
                                  <span className="sub-scope-badge">Subscription required</span>
                                )}
                              </div>
                              {prod.description && <div className="ia-product-desc">{prod.description}</div>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
