import { useState, useRef, useEffect, useCallback } from 'react';
import { LogOut, Sun, Moon, Monitor, Copy, Check, ChevronDown, Building2, ShieldCheck, KeyRound } from 'lucide-react';
import { useMsal } from '@azure/msal-react';
import { useTheme } from '../context/ThemeContext';
import { useAzure } from '../context/AzureContext';
import { useTokenAuth } from '../context/TokenAuthContext';
import type { ThemeMode } from '../types';
import packageJson from '../../package.json';

const APP_VERSION = packageJson.version;

const themeOptions: { value: ThemeMode; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
];

function CopyValue({ value, fallback }: { value: string | undefined; fallback?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    if (!value) return;
    void navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [value]);

  if (!value) return <span className="user-menu-field-value"><span className="muted">{fallback ?? '—'}</span></span>;

  return (
    <span className="user-menu-field-value user-menu-copyable" onClick={handleCopy} title="Click to copy">
      <span>{value}</span>
      <span className="user-menu-copy-icon">
        {copied ? <Check size={11} /> : <Copy size={11} />}
      </span>
    </span>
  );
}

export default function UserMenu() {
  const { instance } = useMsal();
  const { theme, setTheme } = useTheme();
  const { userProfile, config, tenants, switchDirectory } = useAzure();
  const { isAuthenticated: isTokenAuth, signOut: tokenSignOut } = useTokenAuth();
  const [open, setOpen] = useState(false);
  const [dirSwitcherOpen, setDirSwitcherOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const initials = userProfile?.name
    ? userProfile.name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
    : '?';

  const handleSignOut = () => {
    localStorage.removeItem('customClientId');
    localStorage.removeItem('customTenant');
    if (isTokenAuth) {
      tokenSignOut();
    } else {
      void instance.logoutRedirect();
    }
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className="user-btn"
        onClick={() => setOpen(!open)}
        aria-label="User menu"
        title={isTokenAuth ? 'Azure access token' : userProfile?.name ?? 'User'}
      >
        {isTokenAuth && !userProfile?.name ? <KeyRound size={16} /> : initials}
      </button>

      {open && (
        <>
          <div className="user-menu-overlay" onClick={() => setOpen(false)} />
          <div className="user-menu">
            {/* Profile header */}
            <div className="user-menu-header">
              <div className="user-menu-name">{isTokenAuth && !userProfile?.name ? 'Azure access token' : userProfile?.name ?? 'Unknown'}</div>
              <div className="user-menu-email">{userProfile?.email ?? ''}</div>
            </div>

            {/* Directory / Tenant */}
            <div className="user-menu-section">
              <div className="user-menu-section-title">Directory</div>
              {userProfile?.tenantName && (
                <div className="user-menu-field">
                  <span className="user-menu-field-label">Tenant</span>
                  <CopyValue value={userProfile.tenantName} />
                </div>
              )}
              <div className="user-menu-field">
                <span className="user-menu-field-label">Tenant ID</span>
                <CopyValue value={userProfile?.tenantId} />
              </div>
              {tenants.length > 1 && (
                <div className="dir-switcher">
                  <button
                    className="dir-switcher-btn"
                    onClick={() => setDirSwitcherOpen(!dirSwitcherOpen)}
                  >
                    <Building2 size={14} />
                    Switch directory
                    <ChevronDown size={14} className={`dir-switcher-chevron${dirSwitcherOpen ? ' open' : ''}`} />
                  </button>
                  {dirSwitcherOpen && (
                    <div className="dir-switcher-list">
                      {tenants.map((t) => {
                        const isCurrent = t.tenantId === userProfile?.tenantId;
                        const adminConsentUrl = `https://login.microsoftonline.com/${t.tenantId}/adminconsent?client_id=${import.meta.env.VITE_AZURE_CLIENT_ID}`;
                        return (
                          <div key={t.tenantId} className="dir-switcher-item-row">
                            <button
                              className={`dir-switcher-item${isCurrent ? ' current' : ''}`}
                              onClick={() => {
                                if (!isCurrent) switchDirectory(t);
                              }}
                              disabled={isCurrent}
                            >
                              <div className="dir-switcher-item-name">
                                {t.displayName || t.tenantId}
                                {isCurrent && <span className="dir-switcher-current-badge">Current</span>}
                              </div>
                              {t.defaultDomain && (
                                <div className="dir-switcher-item-domain">{t.defaultDomain}</div>
                              )}
                            </button>
                            {!isCurrent && (
                              <a
                                href={adminConsentUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="dir-switcher-consent-link"
                                title="Request admin consent for this tenant"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <ShieldCheck size={14} />
                              </a>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Azure Resources */}
            <div className="user-menu-section">
              <div className="user-menu-section-title">Azure Resources</div>
              <div className="user-menu-field">
                <span className="user-menu-field-label">Subscription</span>
                <CopyValue value={config.subscription?.displayName} fallback="Not selected" />
              </div>
              <div className="user-menu-field">
                <span className="user-menu-field-label">APIM Instance</span>
                <CopyValue value={config.apimService?.name} fallback="Not selected" />
              </div>
              <div className="user-menu-field">
                <span className="user-menu-field-label">Workspace</span>
                <CopyValue value={config.apimWorkspace?.displayName} fallback="Not selected" />
              </div>
              <div className="user-menu-field">
                <span className="user-menu-field-label">API Center</span>
                <CopyValue value={config.apiCenterName ?? undefined} fallback="Not linked" />
              </div>
              <div className="user-menu-field">
                <span className="user-menu-field-label">Monitor</span>
                <CopyValue value={config.monitorResource?.name} fallback="Not linked" />
              </div>
              <div className="user-menu-field">
                <span className="user-menu-field-label">App Insights</span>
                <CopyValue value={config.appInsightsResource?.name} fallback="Not linked" />
              </div>
              <div className="user-menu-field">
                <span className="user-menu-field-label">Foundry</span>
                <CopyValue value={config.foundryProject?.name} fallback="Not linked" />
              </div>
            </div>

            {/* Theme */}
            <div className="theme-selector">
              <div className="theme-selector-label">Theme</div>
              <div className="theme-selector-options">
                {themeOptions.map(({ value, label, Icon }) => (
                  <button
                    key={value}
                    className={`theme-option${theme === value ? ' active' : ''}`}
                    onClick={() => setTheme(value)}
                  >
                    <Icon className="theme-option-icon" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Sign out */}
            <div className="user-menu-footer">
              <button className="user-menu-signout" onClick={handleSignOut}>
                <LogOut size={15} />
                Sign out
              </button>
              <span className="user-menu-version">v{APP_VERSION}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
