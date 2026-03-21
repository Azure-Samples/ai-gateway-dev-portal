import { useState, useRef, useEffect } from 'react';
import { useMsal } from '@azure/msal-react';
import { loginRequest } from '../config/msal';
import { LogIn, Terminal, Copy, Check, ChevronDown } from 'lucide-react';
import { useTokenAuth } from '../context/TokenAuthContext';

export default function LoginPage() {
  const { instance } = useMsal();
  const { signIn } = useTokenAuth();
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [tokenValue, setTokenValue] = useState('');
  const [cmdCopied, setCmdCopied] = useState(false);
  const [tenantHint, setTenantHint] = useState(localStorage.getItem('customTenant') ?? '');
  const [clientIdHint, setClientIdHint] = useState(localStorage.getItem('customClientId') ?? '');
  const [showClientId, setShowClientId] = useState(!!localStorage.getItem('customClientId'));
  const [showTenantMenu, setShowTenantMenu] = useState(false);
  const tenantMenuRef = useRef<HTMLDivElement>(null);

  // Auto-trigger login after reload with custom client ID
  const pendingLoginRef = useRef(false);
  useEffect(() => {
    if (localStorage.getItem('pendingLogin')) {
      localStorage.removeItem('pendingLogin');
      pendingLoginRef.current = true;
      handleLogin();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (tenantMenuRef.current && !tenantMenuRef.current.contains(e.target as Node)) {
        setShowTenantMenu(false);
      }
    };
    if (showTenantMenu) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showTenantMenu]);

  const handleLogin = () => void (async () => {
    setSigningIn(true);
    setError(null);
    try {
      const tenant = tenantHint.trim();
      const clientId = clientIdHint.trim();
      if (clientId && !tenant) {
        setError('A Tenant ID is required when providing a Client ID.');
        setSigningIn(false);
        return;
      }
      // Persist custom values so they survive the redirect
      if (clientId && !pendingLoginRef.current) {
        localStorage.setItem('customClientId', clientId);
        localStorage.setItem('customTenant', tenant);
        localStorage.setItem('pendingLogin', '1');
        // Reload so MSAL initializes with the custom client ID
        window.location.reload();
        return;
      } else if (!clientId) {
        localStorage.removeItem('customClientId');
        if (tenant) {
          localStorage.setItem('customTenant', tenant);
        } else {
          localStorage.removeItem('customTenant');
        }
      }
      const extraParams: Record<string, string> = {};
      if (tenant) {
        extraParams.authority = `https://login.microsoftonline.com/${tenant}`;
      }
      await instance.loginRedirect({
        ...loginRequest,
        ...(tenant ? { authority: `https://login.microsoftonline.com/${tenant}` } : {}),
      });
    } catch (err) {
      if (err instanceof Error && !err.message.includes('user_cancelled')) {
        setError(err.message);
      }
      setSigningIn(false);
    }
  })();

  const handleTokenLogin = () => {
    const trimmed = tokenValue.trim();
    if (!trimmed) {
      setError('Please paste a valid access token.');
      return;
    }
    setError(null);
    signIn(trimmed);
  };

  return (
    <div className="login-page">
      <div className="login-bg" />
      <div className="login-card">
        <div className="login-logo">
          <img src="/ai-gateway.svg" alt="" className="login-logo-icon" />
          <h1 className="login-title">AI Gateway Dev Portal</h1>
        </div>
        <p className="login-subtitle">
          Sign in with your Azure credentials to access
          Models, MCP servers, A2A and more.
        </p>
        {error && <p className="login-error">{error}</p>}

        {!showToken ? (
          <>
            <div className="login-split-btn" ref={tenantMenuRef}>
              <button
                className="login-btn login-split-main"
                onClick={handleLogin}
                disabled={signingIn}
              >
                {signingIn ? (
                  <span className="spinner spinner-sm" />
                ) : (
                  <LogIn className="login-btn-icon" />
                )}
                {signingIn ? 'Signing in…' : (clientIdHint ? 'Sign in with your app' : tenantHint ? 'Sign in to your tenant' : 'Sign in with SSO')}
              </button>
              <button
                className="login-btn login-split-toggle"
                onClick={() => setShowTenantMenu(!showTenantMenu)}
                disabled={signingIn}
                aria-label="Select tenant"
              >
                <ChevronDown size={14} className={showTenantMenu ? 'chevron-open' : ''} />
              </button>
              {showTenantMenu && (
                <div className="login-tenant-menu">
                  <label className="login-tenant-menu-label">Tenant ID or domain (optional)</label>
                  <input
                    type="text"
                    className="login-tenant-input"
                    placeholder="e.g. contoso.onmicrosoft.com"
                    value={tenantHint}
                    onChange={(e) => setTenantHint(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { setShowTenantMenu(false); handleLogin(); } }}
                    autoFocus
                  />
                  {!showClientId ? (
                    <button
                      type="button"
                      className="login-tenant-menu-link"
                      onClick={() => setShowClientId(true)}
                    >
                      Bring your own app registration
                    </button>
                  ) : (
                    <>
                      <label className="login-tenant-menu-label" style={{ marginTop: 8 }}>Client ID (optional)</label>
                      <input
                        type="text"
                        className="login-tenant-input"
                        placeholder=""
                        value={clientIdHint}
                        onChange={(e) => setClientIdHint(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { setShowTenantMenu(false); handleLogin(); } }}
                      />
                      <span className="login-tenant-menu-hint">Leave empty to use the default app registration</span>
                    </>
                  )}
                </div>
              )}
            </div>
            <button className="login-token-toggle" onClick={() => setShowToken(true)}>
              <Terminal size={14} />
              Sign in with access token
            </button>
          </>
        ) : (
          <div className="login-token-form">
            <div className="login-token-hint">
              Run in a terminal to get your token:
              <span className="login-token-cmd-wrap">
                <code className="login-token-cmd">az account get-access-token --query accessToken -o tsv</code>
                <button
                  className="login-token-cmd-copy"
                  title="Copy command"
                  onClick={() => {
                    void navigator.clipboard.writeText('az account get-access-token --query accessToken -o tsv');
                    setCmdCopied(true);
                    setTimeout(() => setCmdCopied(false), 1500);
                  }}
                >
                  {cmdCopied ? <Check size={13} /> : <Copy size={13} />}
                </button>
              </span>
            </div>
            <textarea
              className="login-token-input"
              placeholder="Paste your Azure access token here…"
              value={tokenValue}
              onChange={(e) => setTokenValue(e.target.value)}
              rows={3}
            />
            <div className="login-token-actions">
              <button className="login-btn" onClick={handleTokenLogin} disabled={!tokenValue.trim()}>
                <Terminal size={16} />
                Sign in
              </button>
              <button className="login-token-back" onClick={() => { setShowToken(false); setError(null); }}>
                Back to sign-in options
              </button>
            </div>
          </div>
        )}

        <p className="login-footer">
          Powered by Azure API Management
        </p>
      </div>
    </div>
  );
}
