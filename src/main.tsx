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

async function startApp() {
  await msalInstance.initialize();

  // Must be called to handle redirect response after loginRedirect
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
