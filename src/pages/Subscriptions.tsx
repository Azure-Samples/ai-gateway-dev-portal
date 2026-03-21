import { useState, useEffect, useCallback, useRef } from 'react';
import { KeyRound, Plus, Search, Copy, Check, X, Play, Pencil, ChevronDown, RefreshCw, Pause, CirclePlay, Ban, Trash2 } from 'lucide-react';
import { useAzure } from '../context/AzureContext';
import { createMsalCredential, listApimSubscriptions, createApimSubscription, deleteApimSubscription, regeneratePrimaryKey, regenerateSecondaryKey, updateApimSubscriptionState } from '../services/azure';
import { useMsal } from '@azure/msal-react';
import type { ApimSubscription } from '../types';
import { useNavigate, useLocation } from 'react-router-dom';
import ConfirmModal from '../components/ConfirmModal';

interface ConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  action: () => Promise<void>;
}

const ACTION_CONFIRMS: Record<string, (sub: ApimSubscription) => Omit<ConfirmState, 'action'>> = {
  regenPrimary: () => ({
    title: 'Regenerate primary key',
    message: 'Are you sure you want to regenerate the primary key? Existing consumers using this key will lose access.',
    confirmLabel: 'Regenerate',
    danger: true,
  }),
  regenSecondary: () => ({
    title: 'Regenerate secondary key',
    message: 'Are you sure you want to regenerate the secondary key? Existing consumers using this key will lose access.',
    confirmLabel: 'Regenerate',
    danger: true,
  }),
  suspend: (sub) => ({
    title: 'Suspend subscription',
    message: `Are you sure you want to suspend "${sub.displayName}"?`,
    confirmLabel: 'Suspend',
    danger: false,
  }),
  activate: (sub) => ({
    title: 'Activate subscription',
    message: `Are you sure you want to activate "${sub.displayName}"?`,
    confirmLabel: 'Activate',
    danger: false,
  }),
  cancel: (sub) => ({
    title: 'Cancel subscription',
    message: `Are you sure you want to cancel "${sub.displayName}"? This cannot be undone.`,
    confirmLabel: 'Cancel subscription',
    danger: true,
  }),
  delete: (sub) => ({
    title: 'Delete subscription',
    message: `Are you sure you want to delete "${sub.displayName}"?`,
    confirmLabel: 'Delete',
    danger: true,
  }),
};

type ScopeFilter = 'all' | 'apis' | 'products';
type StateFilter = 'all' | 'submitted';
type PanelMode = 'detail' | 'create' | 'edit';
type ScopeType = 'allApis' | 'api' | 'product';

function scopeLabel(scope: string): string {
  if (scope === '/apis' || scope.endsWith('/apis')) return 'All APIs';
  if (scope.includes('/apis/')) {
    const m = /\/apis\/([^/]+)/.exec(scope);
    return m ? `API: ${m[1]}` : 'API';
  }
  if (scope.includes('/products/')) {
    const m = /\/products\/([^/]+)/.exec(scope);
    return m ? `Product: ${m[1]}` : 'Product';
  }
  return scope || '—';
}

function scopeCategory(scope: string): 'apis' | 'products' | 'other' {
  if (scope === '/apis' || scope.endsWith('/apis') || scope.includes('/apis/')) return 'apis';
  if (scope.includes('/products/')) return 'products';
  return 'other';
}

function MaskedKey({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const masked = value ? '••••••••••••••••' : '—';
  const handleCopy = () => {
    if (!value) return;
    void navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <span className="sub-key-cell">
      <span className="sub-key-masked">{masked}</span>
      {value && (
        <button className="sub-key-copy" onClick={(e) => { e.stopPropagation(); handleCopy(); }} title="Copy key">
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      )}
    </span>
  );
}

function ActionsDropdown({ sub, onAction }: { sub: ApimSubscription; onAction: (action: string, sub: ApimSubscription) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggleMenu = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setOpen(!open);
  };

  const isActive = sub.state === 'active';
  const isSuspended = sub.state === 'suspended';
  const isCancelled = sub.state === 'cancelled';

  const actions: { key: string; label: string; icon: typeof RefreshCw; disabled: boolean; danger: boolean }[] = [
    { key: 'regenPrimary', label: 'Regenerate primary key', icon: RefreshCw, disabled: false, danger: false },
    { key: 'regenSecondary', label: 'Regenerate secondary key', icon: RefreshCw, disabled: false, danger: false },
    { key: 'suspend', label: 'Suspend subscription', icon: Pause, disabled: !isActive, danger: false },
    { key: 'activate', label: 'Activate subscription', icon: CirclePlay, disabled: !isSuspended, danger: false },
    { key: 'cancel', label: 'Cancel subscription', icon: Ban, disabled: isCancelled, danger: true },
    { key: 'delete', label: 'Delete subscription', icon: Trash2, disabled: false, danger: true },
  ];

  return (
    <div className="sub-actions-dropdown" ref={ref}>
      <button className="sub-btn-danger" ref={btnRef} onClick={toggleMenu}>
        Actions <ChevronDown size={13} className={open ? 'chevron-open' : ''} />
      </button>
      {open && (
        <div className="sub-actions-menu" style={{ position: 'fixed', top: menuPos.top, right: menuPos.right }}>
          {actions.map(({ key, label, icon: Icon, disabled, danger }) => (
            <button
              key={key}
              className={`sub-actions-item${danger ? ' danger' : ''}${disabled ? ' disabled' : ''}`}
              disabled={disabled}
              onClick={() => { setOpen(false); onAction(key, sub); }}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Subscriptions() {
  const { config, workspaceData, workspaceLoading, setWorkspaceData } = useAzure();
  const { instance } = useMsal();
  const navigate = useNavigate();

  const [search, setSearch] = useState('');
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');

  // Panel state
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<PanelMode>('detail');
  const [selectedSub, setSelectedSub] = useState<ApimSubscription | null>(null);

  // Create/Edit form
  const [formName, setFormName] = useState('');
  const [formDisplayName, setFormDisplayName] = useState('');
  const [formAllowTracing, setFormAllowTracing] = useState(false);
  const [formScopeType, setFormScopeType] = useState<ScopeType>('allApis');
  const [formApiId, setFormApiId] = useState('');
  const [formProductId, setFormProductId] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);

  const service = config.apimService;

  const getCredential = useCallback(() => createMsalCredential(instance), [instance]);

  /** Re-fetch subscriptions after a mutation and update shared context */
  const refresh = useCallback(async () => {
    if (!service) return;
    try {
      const subs = await listApimSubscriptions(getCredential(), service.subscriptionId, service.resourceGroup, service.name);
      setWorkspaceData((d) => ({ ...d, subscriptions: subs }));
    } catch (err) {
      console.error('Failed to refresh subscriptions:', err);
    }
  }, [service, getCredential, setWorkspaceData]);

  const subscriptions = workspaceData.subscriptions;
  const apis = workspaceData.apis;
  const products = workspaceData.products;

  // Filtered subscriptions
  const filtered = subscriptions.filter((s) => {
    if (search && !s.displayName.toLowerCase().includes(search.toLowerCase())) return false;
    if (scopeFilter === 'apis' && scopeCategory(s.scope) !== 'apis') return false;
    if (scopeFilter === 'products' && scopeCategory(s.scope) !== 'products') return false;
    if (stateFilter === 'submitted' && s.state !== 'submitted') return false;
    return true;
  });

  const openDetail = (sub: ApimSubscription) => {
    setSelectedSub(sub);
    setPanelMode('detail');
    setPanelOpen(true);
  };

  const location = useLocation();
  useEffect(() => {
    const selectId = (location.state as { selectId?: string } | null)?.selectId;
    if (selectId) {
      const item = workspaceData.subscriptions.find((s) => s.sid === selectId);
      if (item) openDetail(item);
      window.history.replaceState({}, '');
    }
  }, [location.state, workspaceData.subscriptions]);

  const openCreate = () => {
    setSelectedSub(null);
    setFormName('');
    setFormDisplayName('');
    setFormAllowTracing(false);
    setFormScopeType('allApis');
    setFormApiId(apis[0]?.name ?? '');
    setFormProductId(products[0]?.name ?? '');
    setPanelMode('create');
    setPanelOpen(true);
  };

  const openEdit = (sub: ApimSubscription) => {
    setSelectedSub(sub);
    setFormName(sub.sid);
    setFormDisplayName(sub.displayName);
    setFormAllowTracing(sub.allowTracing);
    if (sub.scope === '/apis' || sub.scope.endsWith('/apis')) {
      setFormScopeType('allApis');
    } else if (sub.scope.includes('/apis/')) {
      setFormScopeType('api');
      const m = /\/apis\/([^/]+)/.exec(sub.scope);
      setFormApiId(m?.[1] ?? '');
    } else if (sub.scope.includes('/products/')) {
      setFormScopeType('product');
      const m = /\/products\/([^/]+)/.exec(sub.scope);
      setFormProductId(m?.[1] ?? '');
    }
    setPanelMode('edit');
    setPanelOpen(true);
  };

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    setSelectedSub(null);
  }, []);

  useEffect(() => {
    window.addEventListener('close-detail-panel', closePanel);
    return () => window.removeEventListener('close-detail-panel', closePanel);
  }, [closePanel]);

  const buildScope = (): string => {
    if (formScopeType === 'allApis') return '/apis';
    if (formScopeType === 'api') return `/apis/${formApiId}`;
    return `/products/${formProductId}`;
  };

  const handleSave = async () => {
    if (!service || !formName || !formDisplayName) return;
    setSaving(true);
    try {
      await createApimSubscription(
        getCredential(),
        service.subscriptionId,
        service.resourceGroup,
        service.name,
        formName,
        { displayName: formDisplayName, scope: buildScope(), allowTracing: formAllowTracing },
      );
      closePanel();
      await refresh();
    } catch (err) {
      console.error('Failed to save subscription:', err);
      alert('Failed to save subscription. Check the console for details.');
    } finally {
      setSaving(false);
    }
  };

  const executeAction = useCallback(async (action: string, sub: ApimSubscription) => {
    if (!service) return;
    const cred = getCredential();
    const { subscriptionId, resourceGroup, name } = service;
    switch (action) {
      case 'regenPrimary':
        await regeneratePrimaryKey(cred, subscriptionId, resourceGroup, name, sub.sid);
        break;
      case 'regenSecondary':
        await regenerateSecondaryKey(cred, subscriptionId, resourceGroup, name, sub.sid);
        break;
      case 'suspend':
        await updateApimSubscriptionState(cred, subscriptionId, resourceGroup, name, sub.sid, 'suspended');
        break;
      case 'activate':
        await updateApimSubscriptionState(cred, subscriptionId, resourceGroup, name, sub.sid, 'active');
        break;
      case 'cancel':
        await updateApimSubscriptionState(cred, subscriptionId, resourceGroup, name, sub.sid, 'cancelled');
        break;
      case 'delete':
        await deleteApimSubscription(cred, subscriptionId, resourceGroup, name, sub.sid);
        break;
    }
    closePanel();
    await refresh();
  }, [service, getCredential, closePanel, refresh]);

  const handleAction = useCallback((action: string, sub: ApimSubscription) => {
    const confirmBuilder = ACTION_CONFIRMS[action];
    if (!confirmBuilder) return;
    setConfirmState({
      ...confirmBuilder(sub),
      action: async () => {
        setConfirmState(null);
        try {
          await executeAction(action, sub);
        } catch (err) {
          console.error(`Failed to ${action}:`, err);
        }
      },
    });
  }, [executeAction]);

  if (!service) {
    return (
      <div className="page-container">
        <div className="page-header">
          <h1 className="page-title">Subscriptions</h1>
          <p className="page-description">Select an APIM service to manage subscriptions.</p>
        </div>
        <div className="page-empty">
          <KeyRound className="page-empty-icon" />
          <div className="page-empty-title">No APIM service selected</div>
          <p className="page-empty-text">Use the workspace selector to choose an APIM instance first.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container sub-page">
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h1 className="page-title">Subscriptions</h1>
          <p className="page-description">Manage API subscriptions, keys, and access for consumers.</p>
        </div>
        <button className="sub-btn-primary" onClick={openCreate}>
          <Plus size={14} />
          Add subscription
        </button>
      </div>

      {/* Toolbar: search + filters */}
      <div className="sub-toolbar">
        <div className="sub-search">
          <Search size={14} className="sub-search-icon" />
          <input
            type="text"
            placeholder="Search subscriptions…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="sub-filters">
          <select value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value as ScopeFilter)}>
            <option value="all">All scopes</option>
            <option value="apis">All APIs</option>
            <option value="products">All Products</option>
          </select>
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value as StateFilter)}>
            <option value="all">All states</option>
            <option value="submitted">Pending approval</option>
          </select>
        </div>
      </div>

      {/* Table */}
      {workspaceLoading ? (
        <div className="page-empty"><span className="spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="page-empty">
          <KeyRound className="page-empty-icon" />
          <div className="page-empty-title">
            {subscriptions.length === 0 ? 'No subscriptions found' : 'No matching subscriptions'}
          </div>
          <p className="page-empty-text">
            {subscriptions.length === 0
              ? 'Subscriptions provide API consumers with authenticated access to your APIs.'
              : 'Try adjusting your search or filters.'}
          </p>
        </div>
      ) : (
        <div className="sub-table-wrap">
          <table className="sub-table">
            <thead>
              <tr>
                <th>Display name</th>
                <th>Primary key</th>
                <th>Secondary key</th>
                <th>Scope</th>
                <th>State</th>
                <th>Owner</th>
                <th>Allow tracing</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((sub) => (
                <tr
                  key={sub.id}
                  className={`sub-row${selectedSub?.id === sub.id ? ' selected' : ''}`}
                  onClick={() => openDetail(sub)}
                >
                  <td className="sub-name-cell">{sub.displayName}</td>
                  <td><MaskedKey value={sub.primaryKey} /></td>
                  <td><MaskedKey value={sub.secondaryKey} /></td>
                  <td><span className="sub-scope-badge">{scopeLabel(sub.scope)}</span></td>
                  <td><span className={`sub-state-badge sub-state-${sub.state}`}>{sub.state}</span></td>
                  <td className="sub-owner-cell">{sub.ownerName || '—'}</td>
                  <td>{sub.allowTracing ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Side Panel */}
      {panelOpen && (
        <div className="sub-panel-overlay" onClick={closePanel}>
          <div className="sub-panel" ref={panelRef} onClick={(e) => e.stopPropagation()}>
            <div className="sub-panel-header">
              <h2>{panelMode === 'create' ? 'Add subscription' : panelMode === 'edit' ? 'Edit subscription' : selectedSub?.displayName}</h2>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {panelMode === 'detail' && selectedSub && (
                  <button
                    className="sub-btn-primary"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}
                    onClick={() => navigate('/playground', { state: { subscription: selectedSub } })}
                  >
                    <Play size={13} /> Use in playground
                  </button>
                )}
                <button className="icon-btn" onClick={closePanel}><X size={16} /></button>
              </div>
            </div>

            {panelMode === 'detail' && selectedSub && (
              <div className="sub-panel-body">
                <div className="sub-panel-actions">
                  <button className="sub-btn-secondary" onClick={() => openEdit(selectedSub)}>
                    <Pencil size={13} /> Edit
                  </button>
                  <ActionsDropdown sub={selectedSub} onAction={handleAction} />
                </div>
                <div className="sub-panel-fields">
                  <div className="sub-panel-field">
                    <label>Name (ID)</label>
                    <span>{selectedSub.sid}</span>
                  </div>
                  <div className="sub-panel-field">
                    <label>Display name</label>
                    <span>{selectedSub.displayName}</span>
                  </div>
                  <div className="sub-panel-field">
                    <label>Scope</label>
                    <span>{scopeLabel(selectedSub.scope)}</span>
                  </div>
                  <div className="sub-panel-field">
                    <label>State</label>
                    <span className={`sub-state-badge sub-state-${selectedSub.state}`}>{selectedSub.state}</span>
                  </div>
                  <div className="sub-panel-field">
                    <label>Owner</label>
                    <span>{selectedSub.ownerName || '—'}</span>
                  </div>
                  <div className="sub-panel-field">
                    <label>Allow tracing</label>
                    <span>{selectedSub.allowTracing ? 'Yes' : 'No'}</span>
                  </div>
                  <div className="sub-panel-field">
                    <label>Primary key</label>
                    <MaskedKey value={selectedSub.primaryKey} />
                  </div>
                  <div className="sub-panel-field">
                    <label>Secondary key</label>
                    <MaskedKey value={selectedSub.secondaryKey} />
                  </div>
                  {selectedSub.createdDate && (
                    <div className="sub-panel-field">
                      <label>Created</label>
                      <span>{new Date(selectedSub.createdDate).toLocaleDateString()}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {(panelMode === 'create' || panelMode === 'edit') && (
              <div className="sub-panel-body">
                <div className="sub-panel-form">
                  <div className="sub-form-group">
                    <label>Name</label>
                    <input
                      type="text"
                      placeholder="unique-subscription-id"
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      disabled={panelMode === 'edit'}
                    />
                    <span className="sub-form-hint">Unique identifier for the subscription</span>
                  </div>
                  <div className="sub-form-group">
                    <label>Display name</label>
                    <input
                      type="text"
                      placeholder="My Subscription"
                      value={formDisplayName}
                      onChange={(e) => setFormDisplayName(e.target.value)}
                    />
                  </div>
                  <div className="sub-form-group">
                    <label>Allow tracing</label>
                    <button
                      type="button"
                      className={`sub-toggle${formAllowTracing ? ' active' : ''}`}
                      onClick={() => setFormAllowTracing(!formAllowTracing)}
                      role="switch"
                      aria-checked={formAllowTracing}
                    >
                      <span className="sub-toggle-thumb" />
                    </button>
                  </div>
                  <div className="sub-form-group">
                    <label>Scope</label>
                    <select value={formScopeType} onChange={(e) => setFormScopeType(e.target.value as ScopeType)}>
                      <option value="allApis">All APIs</option>
                      <option value="api">API</option>
                      <option value="product">Product</option>
                    </select>
                  </div>
                  {formScopeType === 'api' && (
                    <div className="sub-form-group">
                      <label>API</label>
                      <select value={formApiId} onChange={(e) => setFormApiId(e.target.value)}>
                        {apis.map((a) => (
                          <option key={a.name} value={a.name}>{a.displayName}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {formScopeType === 'product' && (
                    <div className="sub-form-group">
                      <label>Product</label>
                      <select value={formProductId} onChange={(e) => setFormProductId(e.target.value)}>
                        {products.map((p) => (
                          <option key={p.name} value={p.name}>{p.displayName}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
                <div className="sub-panel-footer">
                  <button className="sub-btn-secondary" onClick={closePanel}>Cancel</button>
                  <button
                    className="sub-btn-primary"
                    onClick={() => void handleSave()}
                    disabled={saving || !formName || !formDisplayName}
                  >
                    {saving ? <span className="spinner spinner-sm" /> : panelMode === 'create' ? 'Create' : 'Save'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Confirm Modal */}
      <ConfirmModal
        open={confirmState !== null}
        title={confirmState?.title ?? ''}
        message={confirmState?.message ?? ''}
        confirmLabel={confirmState?.confirmLabel ?? 'Confirm'}
        danger={confirmState?.danger ?? false}
        onConfirm={() => void confirmState?.action()}
        onCancel={() => setConfirmState(null)}
      />
    </div>
  );
}
