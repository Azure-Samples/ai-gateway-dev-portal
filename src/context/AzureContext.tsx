import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import { useMsal, useIsAuthenticated } from '@azure/msal-react';
import type {
  AzureTenant,
  AzureSubscription,
  ApimService,
  ApimWorkspace,
  FoundryProject,
  MonitorResource,
  UserProfile,
  PortalConfig,
  ApimBackend,
  ApimApi,
  ApimProduct,
  ApimSubscription,
  InferenceApi,
  ProviderType,
  McpServer,
  McpSource,
  A2aServer,
} from '../types';
import {
  listSubscriptions,
  listApimServices,
  listApimWorkspaces,
  listFoundryProjects,
  getLinkedMonitorResource,
  createMsalCredential,
  createStaticCredential,
  type MsalCredential,
  listTenants,
  listApimBackends,
  listApimApis,
  listApimProducts,
  listApimSubscriptions,
  getApiPolicyXml,
  parseBackendIdFromPolicy,
  listApimApiTags,
  type LinkedMonitorResult,
} from '../services/azure';
import { useTokenAuth } from './TokenAuthContext';

interface LoadingState {
  subscriptions: boolean;
  apimServices: boolean;
  apimWorkspaces: boolean;
  foundryProjects: boolean;
}

export interface WorkspaceLoadStep {
  label: string;
  status: 'pending' | 'loading' | 'done' | 'error';
}

export interface WorkspaceData {
  backends: ApimBackend[];
  apis: ApimApi[];
  inferenceApis: InferenceApi[];
  mcpServers: McpServer[];
  a2aServers: A2aServer[];
  products: ApimProduct[];
  subscriptions: ApimSubscription[];
}

export interface AzureContextType {
  userProfile: UserProfile | null;
  tenants: AzureTenant[];
  subscriptions: AzureSubscription[];
  apimServices: ApimService[];
  apimWorkspaces: ApimWorkspace[];
  foundryProjects: FoundryProject[];
  monitorResources: MonitorResource[];
  config: PortalConfig;
  loading: LoadingState;
  workspaceData: WorkspaceData;
  workspaceLoadSteps: WorkspaceLoadStep[];
  workspaceLoading: boolean;
  dataVersion: number;
  selectSubscription: (sub: AzureSubscription) => Promise<void>;
  selectApimService: (service: ApimService) => Promise<void>;
  selectApimWorkspace: (workspace: ApimWorkspace) => void;
  setMonitorResource: (resource: MonitorResource | null) => void;
  setFoundryProject: (project: FoundryProject | null) => void;
  refreshSubscriptions: () => Promise<void>;
  refreshWorkspaceData: () => Promise<void>;
  setWorkspaceData: React.Dispatch<React.SetStateAction<WorkspaceData>>;
  switchDirectory: (tenant: AzureTenant) => void;
  getCredential: () => MsalCredential;
}

const AzureContext = createContext<AzureContextType | null>(null);

export function AzureProvider({ children }: { children: ReactNode }) {
  const { instance, accounts } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const { token: staticToken, isAuthenticated: isTokenAuth } = useTokenAuth();

  const [subscriptions, setSubscriptions] = useState<AzureSubscription[]>([]);
  const [tenants, setTenants] = useState<AzureTenant[]>([]);
  const [apimServices, setApimServices] = useState<ApimService[]>([]);
  const [apimWorkspaces, setApimWorkspaces] = useState<ApimWorkspace[]>([]);
  const [foundryProjects, setFoundryProjects] = useState<FoundryProject[]>([]);
  const [monitorResources] = useState<MonitorResource[]>([]);

  const [dataVersion, setDataVersion] = useState(0);

  const [workspaceData, setWorkspaceData] = useState<WorkspaceData>({
    backends: [],
    apis: [],
    inferenceApis: [],
    mcpServers: [],
    a2aServers: [],
    products: [],
    subscriptions: [],
  });

  const initialSteps: WorkspaceLoadStep[] = [
    { label: 'Model providers', status: 'pending' },
    { label: 'Inference APIs', status: 'pending' },
    { label: 'MCP servers', status: 'pending' },
    { label: 'A2A', status: 'pending' },
    { label: 'Products', status: 'pending' },
    { label: 'Subscriptions', status: 'pending' },
  ];

  const [workspaceLoadSteps, setWorkspaceLoadSteps] = useState<WorkspaceLoadStep[]>(initialSteps);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);

  const [config, setConfig] = useState<PortalConfig>({
    subscription: null,
    apimService: null,
    apimWorkspace: null,
    monitorResource: null,
    appInsightsResource: null,
    foundryProject: null,
  });

  const [loading, setLoading] = useState<LoadingState>({
    subscriptions: false,
    apimServices: false,
    apimWorkspaces: false,
    foundryProjects: false,
  });

  const account = accounts[0] ?? null;

  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);

  // Sync profile from MSAL account
  useEffect(() => {
    if (account) {
      setUserProfile({
        name: account.name ?? '',
        email: account.username ?? '',
        tenantId: account.tenantId ?? '',
        objectId: account.localAccountId ?? '',
      });
    } else {
      setUserProfile(null);
    }
  }, [account]);

  const getCredential = useCallback(() => {
    if (isTokenAuth && staticToken) {
      return createStaticCredential(staticToken);
    }
    return createMsalCredential(instance);
  }, [instance, isTokenAuth, staticToken]);

  const refreshSubscriptions = useCallback(async () => {
    setLoading((l) => ({ ...l, subscriptions: true }));
    try {
      const subs = await listSubscriptions(getCredential());
      setSubscriptions(subs);
    } catch (err) {
      console.error('Failed to load subscriptions:', err);
    } finally {
      setLoading((l) => ({ ...l, subscriptions: false }));
    }
  }, [getCredential]);

  // Auto-load subscriptions and tenants on auth
  useEffect(() => {
    if (isTokenAuth && staticToken) {
      // Token-based auth — load subscriptions using static credential
      void refreshSubscriptions();
      listTenants(createStaticCredential(staticToken)).then((tenantList) => {
        setTenants(tenantList);
      }).catch(() => { /* tenant listing may fail */ });
      return;
    }
    if (isAuthenticated && account) {
      instance.setActiveAccount(account);
      void refreshSubscriptions();
      // Load tenants and resolve current tenant display name
      listTenants(createMsalCredential(instance)).then((tenantList) => {
        setTenants(tenantList);
        const current = tenantList.find((t) => t.tenantId === account.tenantId);
        if (current) {
          setUserProfile((p) => p ? { ...p, tenantName: current.displayName } : p);
        }
      }).catch(() => { /* tenant listing may fail */ });
    }
  }, [isAuthenticated, account, instance, refreshSubscriptions, isTokenAuth, staticToken]);

  const selectSubscription = useCallback(
    async (sub: AzureSubscription) => {
      setConfig((c) => ({
        ...c,
        subscription: sub,
        apimService: null,
        apimWorkspace: null,
      }));
      setApimServices([]);
      setApimWorkspaces([]);

      // Auto-fetch APIM services
      setLoading((l) => ({ ...l, apimServices: true }));
      try {
        const [services, projects] = await Promise.all([
          listApimServices(getCredential(), sub.subscriptionId),
          listFoundryProjects(getCredential(), sub.subscriptionId),
        ]);
        setApimServices(services);
        setFoundryProjects(projects);
      } catch (err) {
        console.error('Failed to load APIM services:', err);
      } finally {
        setLoading((l) => ({ ...l, apimServices: false }));
      }
    },
    [getCredential],
  );

  const selectApimService = useCallback(
    async (service: ApimService) => {
      setConfig((c) => ({ ...c, apimService: service, apimWorkspace: null, monitorResource: null, appInsightsResource: null }));
      setApimWorkspaces([]);

      // Workspaces only supported on Premium and PremiumV2 tiers
      const supportsWorkspaces = /^premium(v2)?$/i.test(service.sku);

      setLoading((l) => ({ ...l, apimWorkspaces: true }));
      try {
        const workspacesPromise = supportsWorkspaces
          ? listApimWorkspaces(
              getCredential(),
              service.subscriptionId,
              service.resourceGroup,
              service.name,
            ).catch((err) => {
              console.warn('Failed to load APIM workspaces:', err);
              return [] as ApimWorkspace[];
            })
          : Promise.resolve([] as ApimWorkspace[]);

        const monitorPromise = getLinkedMonitorResource(getCredential(), service).catch((err) => {
          console.warn('Failed to detect linked monitor:', err);
          return { monitorResource: null, appInsightsResource: null } as LinkedMonitorResult;
        });

        const [workspaces, linkedResources] = await Promise.all([workspacesPromise, monitorPromise]);
        setApimWorkspaces(workspaces);
        setConfig((c) => ({
          ...c,
          monitorResource: linkedResources.monitorResource,
          appInsightsResource: linkedResources.appInsightsResource,
        }));
      } catch (err) {
        console.error('Failed to load APIM workspaces:', err);
      } finally {
        setLoading((l) => ({ ...l, apimWorkspaces: false }));
      }
    },
    [getCredential],
  );

  const selectApimWorkspace = useCallback((workspace: ApimWorkspace) => {
    setConfig((c) => ({ ...c, apimWorkspace: workspace }));
  }, []);

  const refreshWorkspaceData = useCallback(async () => {
    const service = config.apimService;
    if (!service) return;

    const steps: WorkspaceLoadStep[] = [
      { label: 'Model providers', status: 'pending' },
      { label: 'Inference APIs', status: 'pending' },
      { label: 'MCP servers', status: 'pending' },
      { label: 'A2A', status: 'pending' },
      { label: 'Products', status: 'pending' },
      { label: 'Subscriptions', status: 'pending' },
    ];
    setWorkspaceLoadSteps([...steps]);
    setWorkspaceLoading(true);
    setDataVersion((v) => v + 1);

    const cred = getCredential();
    const { subscriptionId, resourceGroup, name } = service;

    const updateStep = (index: number, status: WorkspaceLoadStep['status']) => {
      steps[index] = { ...steps[index], status };
      setWorkspaceLoadSteps([...steps]);
    };

    // Load sequentially so progress is visible
    // Model providers (backends)
    let backends: ApimBackend[] = [];
    updateStep(0, 'loading');
    try {
      backends = await listApimBackends(cred, subscriptionId, resourceGroup, name);
      setWorkspaceData((d) => ({ ...d, backends }));
      updateStep(0, 'done');
    } catch { updateStep(0, 'error'); }

    // Inference APIs — fetch all APIs, then check each policy for set-backend-service
    let allApis: ApimApi[] = [];
    updateStep(1, 'loading');
    updateStep(2, 'loading');
    updateStep(3, 'loading');
    try {
      allApis = await listApimApis(cred, subscriptionId, resourceGroup, name);
      setWorkspaceData((d) => ({ ...d, apis: allApis }));

      // Build a map of backend name → providerType (only model-provider backends)
      const backendMap = new Map<string, ProviderType>();
      for (const b of backends) {
        if (b.providerType !== 'unknown') {
          backendMap.set(b.name, b.providerType);
        }
      }

      // Run Inference APIs, MCP Servers, and A2A detection in parallel
      const [inferenceResult, mcpResult, a2aResult] = await Promise.allSettled([
        // Inference APIs
        (async () => {
          const results = await Promise.allSettled(
            allApis.map(async (api) => {
              const [policyXml, tags] = await Promise.all([
                getApiPolicyXml(cred, subscriptionId, resourceGroup, name, api.name).catch(() => ''),
                listApimApiTags(cred, subscriptionId, resourceGroup, name, api.name).catch(() => []),
              ]);
              const backendId = parseBackendIdFromPolicy(policyXml);
              if (backendId && backendMap.has(backendId)) {
                return { ...api, backendId, providerType: backendMap.get(backendId)!, tags } as InferenceApi;
              }
              return null;
            }),
          );
          const inferenceApis: InferenceApi[] = [];
          for (const r of results) {
            if (r.status === 'fulfilled' && r.value) inferenceApis.push(r.value);
          }
          inferenceApis.sort((a, b) => a.displayName.localeCompare(b.displayName));
          setWorkspaceData((d) => ({ ...d, inferenceApis }));
          updateStep(1, 'done');
        })(),

        // MCP Servers
        (async () => {
          const mcpApis = allApis.filter((a) => a.apiType.toLowerCase().includes('mcp'));
          const mcpResults = await Promise.allSettled(
            mcpApis.map(async (api) => {
              const tags = await listApimApiTags(cred, subscriptionId, resourceGroup, name, api.name).catch(() => []);
              return {
                ...api,
                source: (api.mcpTools.length > 0 ? 'api' : 'mcp-server') as McpSource,
                tags,
              } as McpServer;
            }),
          );
          const mcpServers: McpServer[] = [];
          for (const r of mcpResults) {
            if (r.status === 'fulfilled') mcpServers.push(r.value);
          }
          mcpServers.sort((a, b) => a.displayName.localeCompare(b.displayName));
          setWorkspaceData((d) => ({ ...d, mcpServers }));
          updateStep(2, 'done');
        })(),

        // A2A Servers
        (async () => {
          const a2aApis = allApis.filter((a) => a.apiType.toLowerCase().includes('a2a'));
          const a2aResults = await Promise.allSettled(
            a2aApis.map(async (api) => {
              const tags = await listApimApiTags(cred, subscriptionId, resourceGroup, name, api.name).catch(() => []);
              return { ...api, tags } as A2aServer;
            }),
          );
          const a2aServers: A2aServer[] = [];
          for (const r of a2aResults) {
            if (r.status === 'fulfilled') a2aServers.push(r.value);
          }
          a2aServers.sort((a, b) => a.displayName.localeCompare(b.displayName));
          setWorkspaceData((d) => ({ ...d, a2aServers }));
          updateStep(3, 'done');
        })(),
      ]);

      if (inferenceResult.status === 'rejected') updateStep(1, 'error');
      if (mcpResult.status === 'rejected') updateStep(2, 'error');
      if (a2aResult.status === 'rejected') updateStep(3, 'error');
    } catch {
      updateStep(1, 'error');
      updateStep(2, 'error');
      updateStep(3, 'error');
    }

    // Products
    updateStep(4, 'loading');
    try {
      const products = await listApimProducts(cred, subscriptionId, resourceGroup, name);
      setWorkspaceData((d) => ({ ...d, products }));
      updateStep(4, 'done');
    } catch { updateStep(4, 'error'); }

    // Subscriptions
    updateStep(5, 'loading');
    try {
      const subs = await listApimSubscriptions(cred, subscriptionId, resourceGroup, name);
      setWorkspaceData((d) => ({ ...d, subscriptions: subs }));
      updateStep(5, 'done');
    } catch { updateStep(5, 'error'); }

    setWorkspaceLoading(false);
  }, [config.apimService, getCredential]);

  // Auto-load workspace data when APIM service changes
  useEffect(() => {
    if (config.apimService) {
      void refreshWorkspaceData();
    } else {
      setWorkspaceData({ backends: [], apis: [], inferenceApis: [], mcpServers: [], a2aServers: [], products: [], subscriptions: [] });
    }
  }, [config.apimService]); // eslint-disable-line react-hooks/exhaustive-deps

  const setMonitorResource = useCallback((resource: MonitorResource | null) => {
    setConfig((c) => ({ ...c, monitorResource: resource }));
  }, []);

  const setFoundryProject = useCallback((project: FoundryProject | null) => {
    setConfig((c) => ({ ...c, foundryProject: project }));
  }, []);

  const switchDirectory = useCallback((tenant: AzureTenant) => {
    // Re-authenticate against the selected tenant
    void instance.loginRedirect({
      scopes: ['https://management.azure.com/user_impersonation'],
      authority: `https://login.microsoftonline.com/${tenant.tenantId}`,
      prompt: 'login',
    });
  }, [instance]);

  return (
    <AzureContext.Provider
      value={{
        userProfile,
        tenants,
        subscriptions,
        apimServices,
        apimWorkspaces,
        foundryProjects,
        monitorResources,
        config,
        loading,
        workspaceData,
        workspaceLoadSteps,
        workspaceLoading,
        dataVersion,
        selectSubscription,
        selectApimService,
        selectApimWorkspace,
        setMonitorResource,
        setFoundryProject,
        refreshSubscriptions,
        refreshWorkspaceData,
        setWorkspaceData,
        switchDirectory,
        getCredential,
      }}
    >
      {children}
    </AzureContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAzure(): AzureContextType {
  const ctx = useContext(AzureContext);
  if (!ctx) throw new Error('useAzure must be used within AzureProvider');
  return ctx;
}
