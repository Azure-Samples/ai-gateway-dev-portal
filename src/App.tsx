import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import {
  AuthenticatedTemplate,
  UnauthenticatedTemplate,
  useMsal,
} from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import { AzureProvider } from './context/AzureContext';
import { SharedFiltersProvider } from './components/AnalyticsToolbar';
import { useTokenAuth } from './context/TokenAuthContext';
import Layout from './components/Layout';
import LoginPage from './components/LoginPage';
import Dashboard from './pages/Dashboard';
import ModelProviders from './pages/ModelProviders';
import InferenceApis from './pages/InferenceApis';
import McpServers from './pages/McpServers';
import A2A from './pages/A2A';
import Products from './pages/Products';
import Subscriptions from './pages/Subscriptions';
import Playground from './pages/Playground';

import Logs from './pages/Logs';
import Requests from './pages/Requests';
import Tokens from './pages/Tokens';
import Performance from './pages/Performance';
import Availability from './pages/Availability';
import Labs from './pages/Labs';
import Evals from './pages/Evals';

function LoadingScreen() {
  return (
    <div className="login-page">
      <div className="login-bg" />
      <div className="login-card" style={{ gap: 20, padding: '40px 48px' }}>
        <img src="/ai-gateway.svg" alt="" className="login-logo-icon" />
        <span className="spinner" />
        <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
          Signing in…
        </p>
      </div>
    </div>
  );
}

function AuthenticatedRoutes() {
  return (
    <AzureProvider>
      <SharedFiltersProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="model-providers" element={<ModelProviders />} />
            <Route path="inference-apis" element={<InferenceApis />} />
            <Route path="mcp-servers" element={<McpServers />} />
            <Route path="a2a" element={<A2A />} />
            <Route path="products" element={<Products />} />
            <Route path="subscriptions" element={<Subscriptions />} />
            <Route path="playground" element={<Playground />} />

            <Route path="logs" element={<Logs />} />
            <Route path="requests" element={<Requests />} />
            <Route path="tokens" element={<Tokens />} />
            <Route path="performance" element={<Performance />} />
            <Route path="availability" element={<Availability />} />
            <Route path="labs" element={<Labs />} />
            <Route path="evals" element={<Evals />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Route>
        </Routes>
      </SharedFiltersProvider>
    </AzureProvider>
  );
}

function AppContent() {
  const { inProgress } = useMsal();
  const { isAuthenticated: isTokenAuth } = useTokenAuth();

  // Token-based auth bypasses MSAL entirely
  if (isTokenAuth) {
    return <AuthenticatedRoutes />;
  }

  // Show loading while MSAL is handling the redirect
  if (inProgress !== InteractionStatus.None) {
    return <LoadingScreen />;
  }

  return (
    <>
      <UnauthenticatedTemplate>
        <LoginPage />
      </UnauthenticatedTemplate>

      <AuthenticatedTemplate>
        <AuthenticatedRoutes />
      </AuthenticatedTemplate>
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}
