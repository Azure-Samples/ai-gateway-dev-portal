import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Layers, ChevronRight, ArrowLeft, RefreshCw, MapPin, FolderOpen, Gauge, Globe, Copy, Check, ExternalLink } from 'lucide-react';
import { useAzure } from '../context/AzureContext';

type Step = 'subscription' | 'service' | 'workspace';

const supportsWorkspaces = (sku: string) => /^premium(v2)?$/i.test(sku);

export default function WorkspaceSelector() {
  const {
    subscriptions,
    apimServices,
    apimWorkspaces,
    config,
    loading,
    selectSubscription,
    selectApimService,
    selectApimWorkspace,
    refreshWorkspaceData,
    workspaceLoading,
  } = useAzure();

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('subscription');
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [copiedField, setCopiedField] = useState<string | null>(null);

  const copyValue = (field: string, value: string | undefined) => {
    if (value) {
      void navigator.clipboard.writeText(value);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    }
  };

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener('mousedown', handler);
      setTimeout(() => searchRef.current?.focus(), 50);
    }
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Reset filter when step changes
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setFilter('');
    setTimeout(() => searchRef.current?.focus(), 50);
  }, [step]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Determine starting step when opening
  const handleOpen = () => {
    if (!open) {
      if (config.apimService) setStep('workspace');
      else if (config.subscription) setStep('service');
      else setStep('subscription');
      window.dispatchEvent(new CustomEvent('close-detail-panel'));
    }
    setOpen(!open);
    setFilter('');
  };

  // Build label
  const label = config.apimWorkspace
    ? config.apimWorkspace.displayName
    : config.apimService
      ? config.apimService.name
      : 'Select workspace';

  const subtitle = config.apimService && !config.apimWorkspace
    ? config.subscription?.displayName
    : config.apimWorkspace
      ? config.apimService?.name
      : null;

  // Filtered lists
  const q = filter.toLowerCase();
  const filteredSubs = subscriptions.filter((s) =>
    s.displayName.toLowerCase().includes(q),
  );
  const filteredServices = apimServices.filter((s) =>
    s.name.toLowerCase().includes(q),
  );
  const filteredWorkspaces = apimWorkspaces.filter((w) =>
    w.displayName.toLowerCase().includes(q),
  );

  const stepTitle =
    step === 'subscription'
      ? 'Select subscription'
      : step === 'service'
        ? 'Select APIM instance'
        : 'Select workspace';

  const isLoading =
    (step === 'subscription' && loading.subscriptions) ||
    (step === 'service' && loading.apimServices) ||
    (step === 'workspace' && loading.apimWorkspaces);

  return (
    <div className="workspace-selector" ref={ref}>
      <button
        className="workspace-selector-btn"
        aria-expanded={open}
        onClick={handleOpen}
      >
        <Layers size={14} style={{ opacity: 0.6, flexShrink: 0 }} />
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span className="workspace-selector-label">{label}</span>
          {subtitle && (
            <span style={{ fontSize: 10, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {subtitle}
            </span>
          )}
        </div>
        <ChevronDown className="chevron" />
      </button>

      {open && (
        <div className="workspace-dropdown" style={{ minWidth: 320 }}>
          {/* Step header */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 8px 0',
          }}>
            {step !== 'subscription' && (
              <button
                className="icon-btn"
                style={{ width: 24, height: 24 }}
                onClick={() => {
                  if (step === 'workspace') setStep('service');
                  else if (step === 'service') setStep('subscription');
                }}
                aria-label="Back"
              >
                <ArrowLeft size={14} />
              </button>
            )}
            <span style={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: 'var(--text-tertiary)',
            }}>
              {stepTitle}
            </span>
          </div>

          {/* Filter — hide on workspace step when tier has no workspaces */}
          {!(step === 'workspace' && config.apimService && !supportsWorkspaces(config.apimService.sku)) && (
            <div className="workspace-dropdown-search">
              <input
                ref={searchRef}
                type="text"
                placeholder={`Filter…`}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
          )}

          {/* List */}
          <div className="workspace-dropdown-list">
            {isLoading ? (
              <div className="workspace-dropdown-empty">
                <span className="spinner spinner-sm" />
              </div>
            ) : step === 'subscription' ? (
              filteredSubs.length === 0 ? (
                <div className="workspace-dropdown-empty">
                  {subscriptions.length === 0 ? 'No subscriptions found' : 'No matches'}
                </div>
              ) : (
                filteredSubs.map((sub) => (
                  <button
                    key={sub.subscriptionId}
                    className={`workspace-dropdown-item${
                      config.subscription?.subscriptionId === sub.subscriptionId ? ' active' : ''
                    }`}
                    onClick={() => void (async () => {
                      await selectSubscription(sub);
                      setStep('service');
                      setFilter('');
                    })()}
                  >
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub.displayName}</span>
                    <ChevronRight size={12} style={{ opacity: 0.4, flexShrink: 0 }} />
                  </button>
                ))
              )
            ) : step === 'service' ? (
              filteredServices.length === 0 ? (
                <div className="workspace-dropdown-empty">
                  {apimServices.length === 0 ? 'No APIM instances found' : 'No matches'}
                </div>
              ) : (
              filteredServices.map((svc) => (
                  <button
                    key={svc.id}
                    className={`workspace-dropdown-item${
                      config.apimService?.id === svc.id ? ' active' : ''
                    }`}
                    onClick={() => void (async () => {
                      await selectApimService(svc);
                      setStep('workspace');
                      setFilter('');
                    })()}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{svc.name}</div>
                      <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>{svc.resourceGroup} · {svc.location}</div>
                    </div>
                    <ChevronRight size={12} style={{ opacity: 0.4, flexShrink: 0 }} />
                  </button>
                ))
              )
            ) : (
              <>
              {config.apimService && supportsWorkspaces(config.apimService.sku) && (
                filteredWorkspaces.length === 0 ? (
                  <div className="workspace-dropdown-empty">
                    {apimWorkspaces.length === 0 ? 'No workspaces found' : 'No matches'}
                  </div>
                ) : (
                  filteredWorkspaces.map((ws) => (
                  <button
                    key={ws.id}
                    className={`workspace-dropdown-item${
                      config.apimWorkspace?.id === ws.id ? ' active' : ''
                    }`}
                    onClick={() => {
                      selectApimWorkspace(ws);
                      setOpen(false);
                      setFilter('');
                    }}
                  >
                    {ws.displayName}
                  </button>
                  ))
                )
              )}
                {config.apimService && (
                  <div className="ws-props">
                    <div className="ws-prop"><Layers size={12} /><span className="ws-prop-label">Instance name</span><a className="ws-prop-value ws-prop-link" href={`https://portal.azure.com/#@/resource/subscriptions/${config.apimService.subscriptionId}/resourceGroups/${encodeURIComponent(config.apimService.resourceGroup)}/providers/Microsoft.ApiManagement/service/${encodeURIComponent(config.apimService.name)}/overview`} target="_blank" rel="noopener noreferrer">{config.apimService.name}<ExternalLink size={10} /></a></div>
                    <div className="ws-prop"><MapPin size={12} /><span className="ws-prop-label">Region</span><span className="ws-prop-value">{config.apimService.location}</span></div>
                    <div className="ws-prop ws-prop-copyable" onClick={() => copyValue('rg', config.apimService!.resourceGroup)}><FolderOpen size={12} /><span className="ws-prop-label">Resource group</span><span className="ws-prop-value">{config.apimService.resourceGroup}</span>{config.apimService.resourceGroup && <span className="ws-prop-copy">{copiedField === 'rg' ? <Check size={11} /> : <Copy size={11} />}</span>}</div>
                    <div className="ws-prop"><Gauge size={12} /><span className="ws-prop-label">Tier</span><span className="ws-prop-value">{config.apimService.sku || '—'}</span></div>
                    <div className="ws-prop ws-prop-copyable" onClick={() => copyValue('gw', config.apimService!.gatewayUrl)}><Globe size={12} /><span className="ws-prop-label">Gateway URL</span><span className="ws-prop-value">{config.apimService.gatewayUrl || '—'}</span>{config.apimService.gatewayUrl && <span className="ws-prop-copy">{copiedField === 'gw' ? <Check size={11} /> : <Copy size={11} />}</span>}</div>
                  </div>
                )}
                <button
                  className="ws-reload-btn"
                  disabled={workspaceLoading}
                  onClick={() => void refreshWorkspaceData()}
                >
                  <RefreshCw size={14} className={workspaceLoading ? 'wl-spin' : ''} />
                  Reload configuration
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
