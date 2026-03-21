import { useState, useEffect, useCallback, useRef } from 'react';
import { Package, Plus, Search, X, ChevronDown, Globe, GlobeLock, Trash2 } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useAzure } from '../context/AzureContext';
import {
  createMsalCredential,
  listApimProducts,
  createApimProduct,
  deleteApimProduct,
  updateApimProductState,
  listProductApis,
  addApiToProduct,
  removeApiFromProduct,
} from '../services/azure';
import { useMsal } from '@azure/msal-react';
import type { ApimProduct, ApimApi } from '../types';
import ConfirmModal from '../components/ConfirmModal';

type PanelMode = 'detail' | 'create';

interface ConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  action: () => Promise<void>;
}

const ACTION_CONFIRMS: Record<string, (p: ApimProduct) => Omit<ConfirmState, 'action'>> = {
  publish: (p) => ({
    title: 'Publish product',
    message: `Are you sure you want to publish "${p.displayName}"? It will become visible to developers.`,
    confirmLabel: 'Publish',
    danger: false,
  }),
  unpublish: (p) => ({
    title: 'Unpublish product',
    message: `Are you sure you want to unpublish "${p.displayName}"? Developers will no longer see it.`,
    confirmLabel: 'Unpublish',
    danger: false,
  }),
  delete: (p) => ({
    title: 'Delete product',
    message: `Are you sure you want to delete "${p.displayName}"? All associated subscriptions will also be deleted.`,
    confirmLabel: 'Delete',
    danger: true,
  }),
};

export default function Products() {
  const { config, workspaceData, workspaceLoading, setWorkspaceData } = useAzure();
  const { instance } = useMsal();

  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState<'all' | 'published' | 'notPublished'>('all');

  // Panel state
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<PanelMode>('detail');
  const [selectedProduct, setSelectedProduct] = useState<ApimProduct | null>(null);
  const [productApis, setProductApis] = useState<ApimApi[]>([]);
  const [loadingApis, setLoadingApis] = useState(false);

  // Create form
  const [formName, setFormName] = useState('');
  const [formDisplayName, setFormDisplayName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formPublished, setFormPublished] = useState(false);
  const [formSelectedApis, setFormSelectedApis] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // Confirm modal
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const service = config.apimService;

  const getCredential = useCallback(() => createMsalCredential(instance), [instance]);

  /** Re-fetch products after a mutation and update shared context */
  const refresh = useCallback(async () => {
    if (!service) return;
    try {
      const prods = await listApimProducts(getCredential(), service.subscriptionId, service.resourceGroup, service.name);
      setWorkspaceData((d) => ({ ...d, products: prods }));
    } catch (err) {
      console.error('Failed to refresh products:', err);
    }
  }, [service, getCredential, setWorkspaceData]);

  const products = workspaceData.products;
  const allApis = workspaceData.apis;

  const filtered = products.filter((p) => {
    if (search && !p.displayName.toLowerCase().includes(search.toLowerCase())) return false;
    if (stateFilter !== 'all' && p.state !== stateFilter) return false;
    return true;
  });

  const loadProductApis = useCallback(async (product: ApimProduct) => {
    if (!service) return;
    setLoadingApis(true);
    try {
      const apis = await listProductApis(getCredential(), service.subscriptionId, service.resourceGroup, service.name, product.name);
      setProductApis(apis);
    } catch {
      setProductApis([]);
    } finally {
      setLoadingApis(false);
    }
  }, [service, getCredential]);

  const openDetail = (product: ApimProduct) => {
    setSelectedProduct(product);
    setPanelMode('detail');
    setPanelOpen(true);
    void loadProductApis(product);
  };

  const location = useLocation();
  useEffect(() => {
    const selectId = (location.state as { selectId?: string } | null)?.selectId;
    if (selectId) {
      const item = workspaceData.products.find((p) => p.name === selectId);
      if (item) openDetail(item);
      window.history.replaceState({}, '');
    }
  }, [location.state, workspaceData.products]); // eslint-disable-line react-hooks/exhaustive-deps

  const openCreate = () => {
    setSelectedProduct(null);
    setFormName('');
    setFormDisplayName('');
    setFormDescription('');
    setFormPublished(false);
    setFormSelectedApis([]);
    setPanelMode('create');
    setPanelOpen(true);
  };

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    setSelectedProduct(null);
    setProductApis([]);
  }, []);

  useEffect(() => {
    window.addEventListener('close-detail-panel', closePanel);
    return () => window.removeEventListener('close-detail-panel', closePanel);
  }, [closePanel]);

  const handleSave = async () => {
    if (!service || !formName || !formDisplayName || !formDescription) return;
    setSaving(true);
    try {
      await createApimProduct(
        getCredential(),
        service.subscriptionId,
        service.resourceGroup,
        service.name,
        formName,
        {
          displayName: formDisplayName,
          description: formDescription,
          state: formPublished ? 'published' : 'notPublished',
        },
      );
      // Associate selected APIs
      for (const apiId of formSelectedApis) {
        await addApiToProduct(
          getCredential(),
          service.subscriptionId,
          service.resourceGroup,
          service.name,
          formName,
          apiId,
        );
      }
      closePanel();
      await refresh();
    } catch (err) {
      console.error('Failed to create product:', err);
    } finally {
      setSaving(false);
    }
  };

  const executeAction = useCallback(async (action: string, product: ApimProduct) => {
    if (!service) return;
    const cred = getCredential();
    const { subscriptionId, resourceGroup, name } = service;
    switch (action) {
      case 'publish':
        await updateApimProductState(cred, subscriptionId, resourceGroup, name, product.name, 'published');
        break;
      case 'unpublish':
        await updateApimProductState(cred, subscriptionId, resourceGroup, name, product.name, 'notPublished');
        break;
      case 'delete':
        await deleteApimProduct(cred, subscriptionId, resourceGroup, name, product.name);
        break;
    }
    closePanel();
    await refresh();
  }, [service, getCredential, refresh, closePanel]);

  const handleAction = useCallback((action: string, product: ApimProduct) => {
    const confirmBuilder = ACTION_CONFIRMS[action];
    if (!confirmBuilder) return;
    setConfirmState({
      ...confirmBuilder(product),
      action: async () => {
        setConfirmState(null);
        try {
          await executeAction(action, product);
        } catch (err) {
          console.error(`Failed to ${action}:`, err);
        }
      },
    });
  }, [executeAction]);

  const handleRemoveApi = useCallback(async (apiName: string) => {
    if (!service || !selectedProduct) return;
    try {
      await removeApiFromProduct(
        getCredential(),
        service.subscriptionId,
        service.resourceGroup,
        service.name,
        selectedProduct.name,
        apiName,
      );
      setProductApis((prev) => prev.filter((a) => a.name !== apiName));
    } catch (err) {
      console.error('Failed to remove API:', err);
    }
  }, [service, selectedProduct, getCredential]);

  const toggleFormApi = (apiName: string) => {
    setFormSelectedApis((prev) =>
      prev.includes(apiName) ? prev.filter((n) => n !== apiName) : [...prev, apiName],
    );
  };

  const accessControlLabel = (p: ApimProduct) => {
    if (!p.subscriptionRequired) return 'Open';
    return p.approvalRequired ? 'Subscription + Approval' : 'Subscription';
  };

  if (!service) {
    return (
      <div className="page-container">
        <div className="page-header">
          <h1 className="page-title">Products</h1>
          <p className="page-description">Select an APIM service to manage products.</p>
        </div>
        <div className="page-empty">
          <Package className="page-empty-icon" />
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
          <h1 className="page-title">Products</h1>
          <p className="page-description">Manage Products that group your Inference APIs and MCPs for consumer access.</p>
        </div>
        <button className="sub-btn-primary" onClick={openCreate}>
          <Plus size={14} />
          Add product
        </button>
      </div>

      {/* Toolbar */}
      <div className="sub-toolbar">
        <div className="sub-search">
          <Search size={14} className="sub-search-icon" />
          <input
            type="text"
            placeholder="Search products…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="sub-filters">
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value as typeof stateFilter)}>
            <option value="all">All states</option>
            <option value="published">Published</option>
            <option value="notPublished">Not published</option>
          </select>
        </div>
      </div>

      {/* Table */}
      {workspaceLoading ? (
        <div className="page-empty"><span className="spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="page-empty">
          <Package className="page-empty-icon" />
          <div className="page-empty-title">
            {products.length === 0 ? 'No products found' : 'No matching products'}
          </div>
          <p className="page-empty-text">
            {products.length === 0
              ? 'Products let you bundle APIs and manage developer access.'
              : 'Try adjusting your search or filters.'}
          </p>
        </div>
      ) : (
        <div className="sub-table-wrap">
          <table className="sub-table">
            <thead>
              <tr>
                <th>Display name</th>
                <th>Description</th>
                <th>Access control</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((prod) => (
                <tr
                  key={prod.id}
                  className={`sub-row${selectedProduct?.id === prod.id ? ' selected' : ''}`}
                  onClick={() => openDetail(prod)}
                >
                  <td className="sub-name-cell">{prod.displayName}</td>
                  <td className="prod-desc-cell">{prod.description || '—'}</td>
                  <td><span className="sub-scope-badge">{accessControlLabel(prod)}</span></td>
                  <td>
                    <span className={`sub-state-badge sub-state-${prod.state === 'published' ? 'active' : 'suspended'}`}>
                      {prod.state === 'published' ? 'Published' : 'Not published'}
                    </span>
                  </td>
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
              <h2>{panelMode === 'create' ? 'Add product' : selectedProduct?.displayName}</h2>
              <button className="icon-btn" onClick={closePanel}><X size={16} /></button>
            </div>

            {panelMode === 'detail' && selectedProduct && (
              <div className="sub-panel-body">
                <div className="sub-panel-actions">
                  <button
                    className="sub-btn-secondary"
                    disabled={selectedProduct.state === 'published'}
                    onClick={() => handleAction('publish', selectedProduct)}
                  >
                    <Globe size={13} /> Publish
                  </button>
                  <button
                    className="sub-btn-secondary"
                    disabled={selectedProduct.state !== 'published'}
                    onClick={() => handleAction('unpublish', selectedProduct)}
                  >
                    <GlobeLock size={13} /> Unpublish
                  </button>
                  <ActionsDropdown product={selectedProduct} onAction={handleAction} />
                </div>
                <div className="sub-panel-fields">
                  <div className="sub-panel-field">
                    <label>Name (ID)</label>
                    <span>{selectedProduct.name}</span>
                  </div>
                  <div className="sub-panel-field">
                    <label>Display name</label>
                    <span>{selectedProduct.displayName}</span>
                  </div>
                  <div className="sub-panel-field">
                    <label>Description</label>
                    <span>{selectedProduct.description || '—'}</span>
                  </div>
                  <div className="sub-panel-field">
                    <label>State</label>
                    <span className={`sub-state-badge sub-state-${selectedProduct.state === 'published' ? 'active' : 'suspended'}`}>
                      {selectedProduct.state === 'published' ? 'Published' : 'Not published'}
                    </span>
                  </div>
                  <div className="sub-panel-field">
                    <label>Access control</label>
                    <span>{accessControlLabel(selectedProduct)}</span>
                  </div>
                </div>

                {/* Associated APIs */}
                <div className="prod-apis-section">
                  <div className="prod-apis-title">Associated APIs</div>
                  {loadingApis ? (
                    <span className="spinner spinner-sm" />
                  ) : productApis.length === 0 ? (
                    <div className="prod-apis-empty">No APIs associated with this product.</div>
                  ) : (
                    <div className="prod-apis-list">
                      {productApis.map((api) => (
                        <div key={api.name} className="prod-api-item">
                          <span className="prod-api-name">{api.displayName}</span>
                          <span className="prod-api-path">/{api.path}</span>
                          <button
                            className="prod-api-remove"
                            title="Remove API"
                            onClick={() => void handleRemoveApi(api.name)}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {panelMode === 'create' && (
              <div className="sub-panel-body">
                <div className="sub-panel-form">
                  <div className="sub-form-group">
                    <label>Name</label>
                    <input
                      type="text"
                      placeholder="unique-product-id"
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                    />
                    <span className="sub-form-hint">Unique identifier for the product</span>
                  </div>
                  <div className="sub-form-group">
                    <label>Display name</label>
                    <input
                      type="text"
                      placeholder="My Product"
                      value={formDisplayName}
                      onChange={(e) => setFormDisplayName(e.target.value)}
                    />
                  </div>
                  <div className="sub-form-group">
                    <label>Description</label>
                    <textarea
                      placeholder="Describe your product…"
                      value={formDescription}
                      onChange={(e) => setFormDescription(e.target.value)}
                      rows={3}
                    />
                  </div>
                  <div className="sub-form-group">
                    <label>Published</label>
                    <button
                      type="button"
                      className={`sub-toggle${formPublished ? ' active' : ''}`}
                      onClick={() => setFormPublished(!formPublished)}
                      role="switch"
                      aria-checked={formPublished}
                    >
                      <span className="sub-toggle-thumb" />
                    </button>
                  </div>

                  {/* API selector */}
                  <div className="sub-form-group">
                    <label>Associate APIs</label>
                    {allApis.length === 0 ? (
                      <span className="sub-form-hint">No APIs available in this service.</span>
                    ) : (
                      <div className="prod-api-picker">
                        {allApis.map((api) => {
                          const checked = formSelectedApis.includes(api.name);
                          return (
                            <label key={api.name} className={`prod-api-pick-item${checked ? ' checked' : ''}`}>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleFormApi(api.name)}
                              />
                              <span>{api.displayName}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
                <div className="sub-panel-footer">
                  <button className="sub-btn-secondary" onClick={closePanel}>Cancel</button>
                  <button
                    className="sub-btn-primary"
                    onClick={() => void handleSave()}
                    disabled={saving || !formName || !formDisplayName || !formDescription}
                  >
                    {saving ? <span className="spinner spinner-sm" /> : 'Create'}
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

function ActionsDropdown({ product, onAction }: { product: ApimProduct; onAction: (action: string, product: ApimProduct) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="sub-actions-dropdown" ref={ref}>
      <button className="sub-btn-danger" onClick={() => setOpen(!open)}>
        Actions <ChevronDown size={13} className={open ? 'chevron-open' : ''} />
      </button>
      {open && (
        <div className="sub-actions-menu">
          <button
            className="sub-actions-item"
            disabled={product.state === 'published'}
            onClick={() => { setOpen(false); onAction('publish', product); }}
          >
            <Globe size={13} /> Publish
          </button>
          <button
            className="sub-actions-item"
            disabled={product.state !== 'published'}
            onClick={() => { setOpen(false); onAction('unpublish', product); }}
          >
            <GlobeLock size={13} /> Unpublish
          </button>
          <button
            className="sub-actions-item danger"
            onClick={() => { setOpen(false); onAction('delete', product); }}
          >
            <Trash2 size={13} /> Delete product
          </button>
        </div>
      )}
    </div>
  );
}
