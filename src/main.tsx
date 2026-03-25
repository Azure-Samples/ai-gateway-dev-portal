import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PublicClientApplication, EventType } from '@azure/msal-browser';
import { MsalProvider } from '@azure/msal-react';
import { msalConfig } from './config/msal';
import { ThemeProvider } from './context/ThemeContext';
import { TokenAuthProvider } from './context/TokenAuthContext';
import App from './App';
import './index.css';

const msalInstance = new PublicClientApplication(msalConfig);

// If this page was opened as an MSAL popup (acquireTokenPopup), the URL
// contains an auth response in the hash. Don't initialize the full app —
// the parent window's MSAL instance will read the popup URL and close it.
const isPopupResponse = !!window.opener && window.location.hash.includes('code=');

async function startApp() {
  if (isPopupResponse) return;

  await msalInstance.initialize();

  // Handle redirect responses (loginRedirect / acquireTokenRedirect).
  await msalInstance.handleRedirectPromise();

  const accounts = msalInstance.getAllAccounts();
  if (accounts.length > 0) {
    msalInstance.setActiveAccount(accounts[0]);
  }

  // Listen for sign-in events
  msalInstance.addEventCallback((event) => {
    if (
      event.eventType === EventType.LOGIN_SUCCESS &&
      event.payload &&
      typeof event.payload === 'object' &&
      'account' in event.payload &&
      event.payload.account
    ) {
      msalInstance.setActiveAccount(event.payload.account as Parameters<typeof msalInstance.setActiveAccount>[0]);
    }
  });

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <MsalProvider instance={msalInstance}>
        <TokenAuthProvider>
          <ThemeProvider>
            <App />
          </ThemeProvider>
        </TokenAuthProvider>
      </MsalProvider>
    </StrictMode>,
  );
}

void startApp();
