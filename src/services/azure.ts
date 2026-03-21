import type { IPublicClientApplication } from '@azure/msal-browser';
import { ApiManagementClient } from '@azure/arm-apimanagement';
import { SubscriptionClient } from '@azure/arm-resources-subscriptions';
import { MonitorClient } from '@azure/arm-monitor';
import { AzureMachineLearningServicesManagementClient } from '@azure/arm-machinelearning';
import type { AzureTenant, AzureSubscription, ApimService, ApimWorkspace, FoundryProject, MonitorResource, AppInsightsResource, ApimSubscription, ApimApi, ApimProduct, ApimBackend, ProviderType, ApimApiDetail, ApimApiRevision, ApimApiRelease, ApimTag } from '../types';
import { managementScope } from '../config/msal';

/**
 * Creates a TokenCredential-compatible object from an MSAL instance
 * that works with Azure SDK clients in the browser.
 */
export function createMsalCredential(msalInstance: IPublicClientApplication) {
  return {
    async getToken(scopes: string | string[]) {
      const account = msalInstance.getActiveAccount();
      if (!account) throw new Error('No active account. Please sign in.');

      const scopeArray = Array.isArray(scopes) ? scopes : [scopes];
      // Map generic scopes to management scope for ARM calls
      const resolvedScopes = scopeArray.includes('https://management.azure.com/.default')
        ? scopeArray
        : [managementScope];

      try {
        const response = await msalInstance.acquireTokenSilent({
          account,
          scopes: resolvedScopes,
          authority: `https://login.microsoftonline.com/${account.tenantId}`,
        });
        return {
          token: response.accessToken,
          expiresOnTimestamp: response.expiresOn?.getTime() ?? Date.now() + 3600_000,
        };
      } catch {
        // Fallback to interactive redirect
        await msalInstance.acquireTokenRedirect({
          scopes: resolvedScopes,
        });
        // After redirect, the page reloads — this line won't execute
        throw new Error('Redirecting for token acquisition');
      }
    },
  };
}

export type MsalCredential = ReturnType<typeof createMsalCredential>;

/**
 * Creates a TokenCredential-compatible object from a static access token
 * (e.g. obtained via `az account get-access-token`).
 */
export function createStaticCredential(token: string): MsalCredential {
  return {
    getToken() {
      return Promise.resolve({ token, expiresOnTimestamp: Date.now() + 3600_000 });
    },
  };
}

/** List all Azure subscriptions the user has access to */
export async function listSubscriptions(credential: MsalCredential): Promise<AzureSubscription[]> {
  const client = new SubscriptionClient(credential);
  const subs: AzureSubscription[] = [];
  for await (const sub of client.subscriptions.list()) {   
    if (sub.subscriptionId && sub.displayName) {
      subs.push({
        subscriptionId: sub.subscriptionId,
        displayName: sub.displayName,
        tenantId: sub.tenantId ?? '',
        state: sub.state ?? '',
      });
    }
  }
  return subs.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** List all APIM services in a subscription */
export async function listApimServices(
  credential: MsalCredential,
  subscriptionId: string,
): Promise<ApimService[]> {
  const client = new ApiManagementClient(credential, subscriptionId);
  const services: ApimService[] = [];
  for await (const svc of client.apiManagementService.list()) {
    if (svc.name && svc.id) {
      // Parse resource group from the resource ID
      const rgMatch = /resourceGroups\/([^/]+)/i.exec(svc.id);
      services.push({
        id: svc.id,
        name: svc.name,
        resourceGroup: rgMatch?.[1] ?? '',
        location: svc.location ?? '',
        subscriptionId,
        sku: svc.sku?.name ?? '',
        gatewayUrl: svc.gatewayUrl ?? '',
      });
    }
  }
  return services.sort((a, b) => a.name.localeCompare(b.name));
}

/** List workspaces for a given APIM service */
export async function listApimWorkspaces(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
): Promise<ApimWorkspace[]> {
  const client = new ApiManagementClient(credential, subscriptionId);
  const workspaces: ApimWorkspace[] = [];
  for await (const ws of client.workspace.listByService(resourceGroup, serviceName)) {
    if (ws.name) {
      workspaces.push({
        id: ws.id ?? '',
        name: ws.name,
        displayName: ws.displayName ?? ws.name,
      });
    }
  }
  return workspaces.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** List ML workspaces (Foundry projects) in a subscription */
export async function listFoundryProjects(
  credential: MsalCredential,
  subscriptionId: string,
): Promise<FoundryProject[]> {
  const client = new AzureMachineLearningServicesManagementClient(credential, subscriptionId);
  const projects: FoundryProject[] = [];
  for await (const ws of client.workspaces.listBySubscription()) {
    if (ws.name && ws.id) {
      const rgMatch = /resourceGroups\/([^/]+)/i.exec(ws.id);
      projects.push({
        id: ws.id,
        name: ws.name,
        location: ws.location ?? '',
        resourceGroup: rgMatch?.[1] ?? '',
      });
    }
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

export interface LinkedMonitorResult {
  monitorResource: MonitorResource | null;
  appInsightsResource: AppInsightsResource | null;
}

/**
 * Detect the linked Log Analytics workspace and Application Insights for an APIM service.
 *
 * Strategies (in order):
 * 1. Check APIM Loggers for applicationInsights type with resourceId → resolve
 *    the Application Insights resource → read its WorkspaceResourceId via ARM REST.
 * 2. If the logger only has credentials.instrumentationKey (no resourceId),
 *    find the App Insights resource by listing components in the subscription.
 * 3. Fall back to Azure Monitor Diagnostic Settings on the APIM resource →
 *    check for a direct workspaceId (Log Analytics).
 */
export async function getLinkedMonitorResource(
  credential: MsalCredential,
  apimService: { id: string; subscriptionId: string; resourceGroup: string; name: string },
): Promise<LinkedMonitorResult> {
  // --- Strategy 1 & 2: APIM Loggers → Application Insights → Log Analytics Workspace ---
  try {
    const apimClient = new ApiManagementClient(credential, apimService.subscriptionId);
    for await (const logger of apimClient.logger.listByService(apimService.resourceGroup, apimService.name)) {

      if (logger.loggerType !== 'applicationInsights' && logger.loggerType !== 'azureMonitor') {
        continue;
      }

      let appInsightsId = logger.resourceId ?? null;

      // Strategy 2: If no resourceId, try to find App Insights by instrumentation key
      if (!appInsightsId && logger.credentials?.instrumentationKey) {
        appInsightsId = await findAppInsightsByInstrumentationKey(
          credential,
          apimService.subscriptionId,
          logger.credentials.instrumentationKey,
        );
      }

      if (appInsightsId) {
        const aiNameMatch = (/\/components\/([^/]+)$/i.exec(appInsightsId)) ?? (/[/]([^/]+)$/.exec(appInsightsId));
        const aiRgMatch = /resourceGroups\/([^/]+)/i.exec(appInsightsId);
        const appInsightsResource: AppInsightsResource = {
          id: appInsightsId,
          name: aiNameMatch?.[1] ?? appInsightsId,
          resourceGroup: aiRgMatch?.[1] ?? '',
        };

        // Resolve the backing Log Analytics workspace
        const workspaceId = await resolveAppInsightsWorkspace(credential, appInsightsId);
        if (workspaceId) {
          const nameMatch = /\/workspaces\/([^/]+)$/i.exec(workspaceId);
          const rgMatch = /resourceGroups\/([^/]+)/i.exec(workspaceId);
          return {
            monitorResource: {
              id: workspaceId,
              name: nameMatch?.[1] ?? workspaceId,
              resourceGroup: rgMatch?.[1] ?? '',
              workspaceId,
            },
            appInsightsResource,
          };
        }

        // App Insights found but no backing workspace
        return { monitorResource: null, appInsightsResource };
      }
    }
  } catch (err) {
    console.warn('Failed to read APIM loggers:', err);
  }

  // --- Strategy 3: Azure Monitor Diagnostic Settings ---
  try {
    const monitorClient = new MonitorClient(credential, apimService.subscriptionId);
    const result = await monitorClient.diagnosticSettings.list(apimService.id);
    for (const setting of result.value ?? []) {
      if (setting.workspaceId) {
        const nameMatch = /\/workspaces\/([^/]+)$/i.exec(setting.workspaceId);
        const rgMatch = /resourceGroups\/([^/]+)/i.exec(setting.workspaceId);
        return {
          monitorResource: {
            id: setting.workspaceId,
            name: nameMatch?.[1] ?? setting.workspaceId,
            resourceGroup: rgMatch?.[1] ?? '',
            workspaceId: setting.workspaceId,
          },
          appInsightsResource: null,
        };
      }
    }
  } catch (err) {
    console.warn('Failed to read diagnostic settings:', err);
  }

  return { monitorResource: null, appInsightsResource: null };
}

/**
 * Find an Application Insights component by instrumentation key via ARM REST.
 */
async function findAppInsightsByInstrumentationKey(
  credential: MsalCredential,
  subscriptionId: string,
  instrumentationKey: string,
): Promise<string | null> {
  try {
    const tokenResult = await credential.getToken('https://management.azure.com/.default');
    const url = `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Insights/components?api-version=2020-02-02`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${tokenResult.token}` },
    });
    if (!response.ok) return null;
    const body = await response.json() as {
      value?: {
        id?: string;
        properties?: { InstrumentationKey?: string };
      }[];
    };
    for (const component of body.value ?? []) {
      if (component.properties?.InstrumentationKey === instrumentationKey && component.id) {
        return component.id;
      }
    }
  } catch (err) {
    console.warn('Failed to search App Insights by key:', err);
  }
  return null;
}

/**
 * Given an Application Insights resource ID, fetch its backing Log Analytics
 * workspace via direct ARM REST call (the SDK type doesn't expose the property).
 */
async function resolveAppInsightsWorkspace(
  credential: MsalCredential,
  appInsightsResourceId: string,
): Promise<string | null> {
  try {
    const tokenResult = await credential.getToken('https://management.azure.com/.default');
    const apiVersion = '2020-02-02';
    const url = `https://management.azure.com${appInsightsResourceId}?api-version=${apiVersion}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${tokenResult.token}` },
    });
    if (!response.ok) return null;
    const body = await response.json() as { properties?: { WorkspaceResourceId?: string } };
    return body.properties?.WorkspaceResourceId ?? null;
  } catch {
    return null;
  }
}

/** List all tenants the user has access to */
export async function listTenants(
  credential: MsalCredential,
): Promise<AzureTenant[]> {
  const client = new SubscriptionClient(credential);
  const tenants: AzureTenant[] = [];
  try {
    for await (const tenant of client.tenants.list()) {
      if (tenant.tenantId) {
        tenants.push({
          tenantId: tenant.tenantId,
          displayName: tenant.displayName ?? tenant.tenantId,
          defaultDomain: tenant.defaultDomain ?? '',
        });
      }
    }
  } catch {
    // Tenant listing may fail if permission insufficient
  }
  return tenants.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// ===================================================
// APIM Subscriptions, APIs, Products
// ===================================================

/** Parse the sid (subscription identifier) from the resource ID */
function parseSid(id: string): string {
  const m = /\/subscriptions\/([^/]+)$/i.exec(id);
  return m?.[1] ?? id;
}

/** Parse a user display name from ownerId like /users/xxx or /users/1 */
function parseOwnerName(ownerId?: string): string {
  if (!ownerId) return '';
  const m = /\/users\/(.+)$/i.exec(ownerId);
  return m?.[1] ?? ownerId;
}

/** List all APIM subscriptions for a service, including secrets */
export async function listApimSubscriptions(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
): Promise<ApimSubscription[]> {
  const token = await credential.getToken('https://management.azure.com/.default');
  if (!token) throw new Error('Failed to acquire token');

  const subs: ApimSubscription[] = [];
  let url: string | null =
    `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.ApiManagement/service/${encodeURIComponent(serviceName)}/subscriptions?api-version=${PREVIEW_API_VERSION}`;

  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token.token}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Subscription list failed: ${res.status} ${res.statusText}`);
    const body = await res.json() as {
      value: { id?: string; name?: string; properties?: {
        displayName?: string; scope?: string; state?: string;
        ownerId?: string; allowTracing?: boolean;
        createdDate?: string;
      } }[];
      nextLink?: string;
    };

    for (const sub of body.value) {
      const sid = sub.name ?? parseSid(sub.id ?? '');
      // Fetch secrets via REST (keys aren't returned on GET)
      let primaryKey = '';
      let secondaryKey = '';
      try {
        const secretsUrl = `https://management.azure.com${sub.id}/listSecrets?api-version=${PREVIEW_API_VERSION}`;
        const secretsRes = await fetch(secretsUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token.token}`, Accept: 'application/json' },
        });
        if (secretsRes.ok) {
          const secrets = await secretsRes.json() as { primaryKey?: string; secondaryKey?: string };
          primaryKey = secrets.primaryKey ?? '';
          secondaryKey = secrets.secondaryKey ?? '';
        }
      } catch { /* keys may not be accessible */ }

      const p = sub.properties ?? {};
      subs.push({
        id: sub.id ?? '',
        sid,
        displayName: p.displayName ?? sid,
        scope: p.scope ?? '',
        state: p.state ?? '',
        ownerId: p.ownerId ?? '',
        ownerName: parseOwnerName(p.ownerId),
        allowTracing: p.allowTracing ?? false,
        primaryKey,
        secondaryKey,
        createdDate: p.createdDate,
      });
    }
    url = body.nextLink ?? null;
  }
  return subs;
}

/** List all APIs in an APIM service (direct REST to capture properties.type for MCP) */
export async function listApimApis(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
): Promise<ApimApi[]> {
  const token = await credential.getToken('https://management.azure.com/.default');
  if (!token) throw new Error('Failed to acquire token');

  const apis: ApimApi[] = [];
  let url: string | null =
    `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.ApiManagement/service/${encodeURIComponent(serviceName)}/apis?api-version=2025-03-01-preview`;

  while (url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token.token}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) throw new Error(`API list failed: ${res.status} ${res.statusText}`);
    const body = await res.json() as {
      value: { id?: string; name?: string; properties?: { displayName?: string; description?: string; path?: string; apiType?: string; type?: string; mcpTools?: { name?: string }[]; agent?: { id?: string }; subscriptionKeyParameterNames?: { header?: string; query?: string } } }[];
      nextLink?: string;
    };
    for (const api of body.value) {
      if (api.name && api.id) {
        const apiType = api.properties?.type ?? api.properties?.apiType ?? 'http';
        apis.push({
          id: api.id,
          name: api.name,
          displayName: api.properties?.displayName ?? api.name,
          description: api.properties?.description ?? '',
          path: api.properties?.path ?? '',
          apiType,
          mcpTools: (api.properties?.mcpTools ?? []).map((t) => t.name ?? '').filter(Boolean),
          agentId: api.properties?.agent?.id ?? '',
          subscriptionKeyHeaderName: api.properties?.subscriptionKeyParameterNames?.header ?? undefined,
        });
      }
    }
    url = body.nextLink ?? null;
  }
  return apis.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** List all products in an APIM service */
export async function listApimProducts(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
): Promise<ApimProduct[]> {
  const client = new ApiManagementClient(credential, subscriptionId);
  const products: ApimProduct[] = [];
  for await (const p of client.product.listByService(resourceGroup, serviceName)) {
    if (p.name && p.id) {
      products.push({
        id: p.id,
        name: p.name,
        displayName: p.displayName ?? p.name,
        description: p.description ?? '',
        state: p.state ?? '',
        subscriptionRequired: p.subscriptionRequired ?? true,
        approvalRequired: p.approvalRequired ?? false,
        subscriptionsLimit: p.subscriptionsLimit ?? undefined,
      });
    }
  }
  return products.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Create a new APIM product */
export async function createApimProduct(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
  productId: string,
  params: { displayName: string; description: string; state: 'published' | 'notPublished' },
): Promise<void> {
  const client = new ApiManagementClient(credential, subscriptionId);
  await client.product.createOrUpdate(resourceGroup, serviceName, productId, {
    displayName: params.displayName,
    description: params.description,
    state: params.state,
    subscriptionRequired: true,
  });
}

/** Delete an APIM product */
export async function deleteApimProduct(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
  productId: string,
): Promise<void> {
  const client = new ApiManagementClient(credential, subscriptionId);
  await client.product.delete(resourceGroup, serviceName, productId, '*', { deleteSubscriptions: true });
}

/** Update an APIM product state (publish/unpublish) */
export async function updateApimProductState(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
  productId: string,
  state: 'published' | 'notPublished',
): Promise<void> {
  const client = new ApiManagementClient(credential, subscriptionId);
  await client.product.update(resourceGroup, serviceName, productId, '*', { state });
}

/** List APIs associated with a product */
export async function listProductApis(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
  productId: string,
): Promise<ApimApi[]> {
  const client = new ApiManagementClient(credential, subscriptionId);
  const apis: ApimApi[] = [];
  for await (const api of client.productApi.listByProduct(resourceGroup, serviceName, productId)) {
    if (api.name && api.id) {
      apis.push({
        id: api.id,
        name: api.name,
        displayName: api.displayName ?? api.name,
        path: api.path ?? '',
        description: api.description ?? '',
        apiType: '',
        mcpTools: [],
        agentId: '',
      });
    }
  }
  return apis.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Associate an API with a product */
export async function addApiToProduct(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
  productId: string,
  apiId: string,
): Promise<void> {
  const client = new ApiManagementClient(credential, subscriptionId);
  await client.productApi.createOrUpdate(resourceGroup, serviceName, productId, apiId);
}

/** Remove an API from a product */
export async function removeApiFromProduct(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
  productId: string,
  apiId: string,
): Promise<void> {
  const client = new ApiManagementClient(credential, subscriptionId);
  await client.productApi.delete(resourceGroup, serviceName, productId, apiId);
}

/** Create a new APIM subscription */
export async function createApimSubscription(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
  sid: string,
  params: { displayName: string; scope: string; allowTracing: boolean },
): Promise<void> {
  const client = new ApiManagementClient(credential, subscriptionId);
  await client.subscription.createOrUpdate(resourceGroup, serviceName, sid, {
    displayName: params.displayName,
    scope: params.scope,
    allowTracing: params.allowTracing,
    state: 'active',
  });
}

/** Delete an APIM subscription */
export async function deleteApimSubscription(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
  sid: string,
): Promise<void> {
  const client = new ApiManagementClient(credential, subscriptionId);
  await client.subscription.delete(resourceGroup, serviceName, sid, '*');
}

/** Regenerate primary key for an APIM subscription */
export async function regeneratePrimaryKey(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
  sid: string,
): Promise<void> {
  const client = new ApiManagementClient(credential, subscriptionId);
  await client.subscription.regeneratePrimaryKey(resourceGroup, serviceName, sid);
}

/** Regenerate secondary key for an APIM subscription */
export async function regenerateSecondaryKey(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
  sid: string,
): Promise<void> {
  const client = new ApiManagementClient(credential, subscriptionId);
  await client.subscription.regenerateSecondaryKey(resourceGroup, serviceName, sid);
}

/** Update the state of an APIM subscription */
export async function updateApimSubscriptionState(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
  sid: string,
  state: 'active' | 'suspended' | 'cancelled',
): Promise<void> {
  const client = new ApiManagementClient(credential, subscriptionId);
  await client.subscription.update(resourceGroup, serviceName, sid, '*', { state });
}

// ===================================================
// Provider type inference from URL
// ===================================================

export function inferProviderType(url: string): ProviderType {
  if (!url) return 'unknown';
  const lower = url.toLowerCase();
  if (lower.includes('.cognitiveservices.azure.com') || lower.includes('.services.ai.azure.com'))
    return 'foundry';
  if (lower.includes('.openai.azure.com'))
    return 'azureopenai';
  if (lower.includes('generativelanguage.googleapis.com'))
    return 'gemini';
  if (lower.includes('api.openai.com'))
    return 'openai';
  if (lower.includes('api.anthropic.com'))
    return 'anthropic';
  if (lower.includes('.amazonaws.com') || lower.includes('.api.aws'))
    return 'bedrock';
  if (lower.includes('.huggingface.co'))
    return 'huggingface';
  return 'unknown';
}

// ===================================================
// APIM Backends (Model Providers)
// ===================================================

/** List all backends in an APIM service */
export async function listApimBackends(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
): Promise<ApimBackend[]> {
  const client = new ApiManagementClient(credential, subscriptionId);

  // First pass: collect all raw backends and their pool member IDs
  const raw: { id: string; name: string; title: string; description: string; url: string; protocol: string; circuitBreaker: boolean; circuitBreakerRules: import('../types').CircuitBreakerRule[]; poolSize: number; poolMemberIds: string[]; poolMemberWeights: Map<string, { weight?: number; priority?: number }> }[] = [];
  const urlById = new Map<string, string>();
  const nameById = new Map<string, string>();

  for await (const b of client.backend.listByService(resourceGroup, serviceName)) {
    if (b.name && b.id) {
      const url = b.url ?? '';
      const idLower = b.id.toLowerCase();
      urlById.set(idLower, url);
      nameById.set(idLower, b.title ?? b.name);
      const poolMemberWeights = new Map<string, { weight?: number; priority?: number }>();
      for (const s of b.pool?.services ?? []) {
        poolMemberWeights.set(s.id.toLowerCase(), { weight: s.weight, priority: s.priority });
      }
      raw.push({
        id: b.id,
        name: b.name,
        title: b.title ?? b.name,
        description: b.description ?? '',
        url,
        protocol: b.protocol ?? 'http',
        circuitBreaker: (b.circuitBreaker?.rules?.length ?? 0) > 0,
        circuitBreakerRules: (b.circuitBreaker?.rules ?? []).map((r) => ({
          name: r.name ?? 'Unnamed rule',
          tripDuration: r.tripDuration,
          acceptRetryAfter: r.acceptRetryAfter,
          failureCount: r.failureCondition?.count,
          failurePercentage: r.failureCondition?.percentage,
          failureInterval: r.failureCondition?.interval,
          statusCodeRanges: r.failureCondition?.statusCodeRanges ?? [],
          errorReasons: r.failureCondition?.errorReasons ?? [],
        })),
        poolSize: b.pool?.services?.length ?? 0,
        poolMemberIds: b.pool?.services?.map((s) => s.id.toLowerCase()) ?? [],
        poolMemberWeights,
      });
    }
  }

  // Second pass: resolve provider type, inferring from pool members for pools
  const backends: ApimBackend[] = raw.map((b) => {
    let providerType = inferProviderType(b.url);
    if (providerType === 'unknown' && b.poolMemberIds.length > 0) {
      for (const memberId of b.poolMemberIds) {
        const memberUrl = urlById.get(memberId);
        if (memberUrl) {
          const memberType = inferProviderType(memberUrl);
          if (memberType !== 'unknown') {
            providerType = memberType;
            break;
          }
        }
      }
    }
    return {
      id: b.id,
      name: b.name,
      title: b.title,
      description: b.description,
      url: b.url,
      protocol: b.protocol,
      providerType,
      circuitBreaker: b.circuitBreaker,
      circuitBreakerRules: b.circuitBreakerRules,
      poolSize: b.poolSize,
      poolMembers: b.poolMemberIds.map((memberId) => {
        const memberUrl = urlById.get(memberId) ?? '';
        const memberName = nameById.get(memberId) ?? memberId.split('/').pop() ?? memberId;
        const wp = b.poolMemberWeights.get(memberId);
        return {
          name: memberName,
          url: memberUrl,
          weight: wp?.weight,
          priority: wp?.priority,
          providerType: inferProviderType(memberUrl),
        };
      }),
    };
  });

  return backends.sort((a, b) => a.title.localeCompare(b.title));
}

// ===================================================
// APIM API Details (Inference APIs)
// ===================================================

const PREVIEW_API_VERSION = '2025-03-01-preview';

/** Helper: GET from ARM management endpoint with preview API version */
async function armGet<T>(credential: MsalCredential, path: string): Promise<T> {
  const token = await credential.getToken('https://management.azure.com/.default');
  if (!token) throw new Error('Failed to acquire token');
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://management.azure.com${path}${sep}api-version=${PREVIEW_API_VERSION}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token.token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`ARM GET ${path} failed: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

/** Helper: build the base ARM path for an APIM API */
function apiBasePath(subscriptionId: string, resourceGroup: string, serviceName: string, apiId: string) {
  return `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.ApiManagement/service/${encodeURIComponent(serviceName)}/apis/${encodeURIComponent(apiId)}`;
}

/** Get full details for an API */
export async function getApimApiDetail(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
  apiId: string,
): Promise<ApimApiDetail> {
  const base = apiBasePath(subscriptionId, resourceGroup, serviceName, apiId);
  interface ApiResponse { id?: string; name?: string; properties?: {
    displayName?: string; description?: string; path?: string; serviceUrl?: string;
    apiVersion?: string; apiRevision?: string; subscriptionRequired?: boolean;
    subscriptionKeyParameterNames?: { header?: string; query?: string };
    protocols?: string[]; isCurrent?: boolean;
  } }
  const api = await armGet<ApiResponse>(credential, base);
  const p = api.properties ?? {};
  return {
    id: api.id ?? '',
    name: api.name ?? apiId,
    displayName: p.displayName ?? api.name ?? apiId,
    description: p.description ?? '',
    path: p.path ?? '',
    serviceUrl: p.serviceUrl ?? '',
    apiVersion: p.apiVersion ?? '',
    apiRevision: p.apiRevision ?? '1',
    subscriptionRequired: p.subscriptionRequired ?? true,
    subscriptionKeyParameterNames: {
      header: p.subscriptionKeyParameterNames?.header ?? undefined,
      query: p.subscriptionKeyParameterNames?.query ?? undefined,
    },
    protocols: p.protocols ?? [],
    isCurrent: p.isCurrent ?? true,
  };
}

/** List revisions for an API */
export async function listApimApiRevisions(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
  apiId: string,
): Promise<ApimApiRevision[]> {
  const base = apiBasePath(subscriptionId, resourceGroup, serviceName, apiId);
  interface RevResponse { value: { properties?: { apiRevision?: string; description?: string; isCurrent?: boolean; createdDateTime?: string; updatedDateTime?: string } }[] }
  const body = await armGet<RevResponse>(credential, `${base}/revisions`);
  return (body.value ?? []).map((r) => {
    const p = r.properties ?? {};
    return {
      apiRevision: p.apiRevision ?? '',
      description: p.description ?? '',
      isCurrent: p.isCurrent ?? false,
      createdDateTime: p.createdDateTime ?? '',
      updatedDateTime: p.updatedDateTime ?? '',
    };
  });
}

/** List releases for an API */
export async function listApimApiReleases(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
  apiId: string,
): Promise<ApimApiRelease[]> {
  const base = apiBasePath(subscriptionId, resourceGroup, serviceName, apiId);
  interface RelResponse { value: { name?: string; properties?: { apiId?: string; notes?: string; createdDateTime?: string } }[] }
  const body = await armGet<RelResponse>(credential, `${base}/releases`);
  return (body.value ?? []).map((r) => ({
    releaseId: r.name ?? '',
    apiId: r.properties?.apiId ?? '',
    notes: r.properties?.notes ?? '',
    createdDateTime: r.properties?.createdDateTime ?? '',
  }));
}

/** List tags for an API */
export async function listApimApiTags(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
  apiId: string,
): Promise<ApimTag[]> {
  const base = apiBasePath(subscriptionId, resourceGroup, serviceName, apiId);
  interface TagResponse { value: { id?: string; name?: string; properties?: { displayName?: string } }[] }
  const body = await armGet<TagResponse>(credential, `${base}/tags`);
  return (body.value ?? []).filter((t) => t.name).map((t) => ({
    id: t.id ?? '',
    name: t.name!,
    displayName: t.properties?.displayName ?? t.name!,
  }));
}

/** List products that contain a given API */
export async function listApiProducts(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
  apiId: string,
): Promise<ApimProduct[]> {
  const base = apiBasePath(subscriptionId, resourceGroup, serviceName, apiId);
  interface ProdResponse { value: { id?: string; name?: string; properties?: {
    displayName?: string; description?: string; state?: string;
    subscriptionRequired?: boolean; approvalRequired?: boolean; subscriptionsLimit?: number;
  } }[] }
  const body = await armGet<ProdResponse>(credential, `${base}/products`);
  return (body.value ?? []).filter((p) => p.name && p.id).map((p) => ({
    id: p.id!,
    name: p.name!,
    displayName: p.properties?.displayName ?? p.name!,
    description: p.properties?.description ?? '',
    state: p.properties?.state ?? '',
    subscriptionRequired: p.properties?.subscriptionRequired ?? true,
    approvalRequired: p.properties?.approvalRequired ?? false,
    subscriptionsLimit: p.properties?.subscriptionsLimit ?? undefined,
  }));
}

/** Get the raw policy XML for an API via direct REST call */
export async function getApiPolicyXml(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
  apiId: string,
): Promise<string> {
  const base = apiBasePath(subscriptionId, resourceGroup, serviceName, apiId);
  const token = await credential.getToken('https://management.azure.com/.default');
  if (!token) throw new Error('Failed to acquire token');
  const url = `https://management.azure.com${base}/policies/policy?api-version=${PREVIEW_API_VERSION}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token.token}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Policy fetch failed: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  // If the response is JSON, extract properties.value; otherwise treat as raw XML
  if (text.trimStart().startsWith('{')) {
    const body = JSON.parse(text) as { properties?: { value?: string } };
    return body.properties?.value ?? '';
  }
  return text;
}

/**
 * Parse `set-backend-service backend-id="xxx"` from policy XML.
 * Returns the backend-id value, or null if not found.
 */
export function parseBackendIdFromPolicy(policyXml: string): string | null {
  const match = /set-backend-service[^>]+backend-id\s*=\s*"([^"]+)"/.exec(policyXml);
  return match?.[1] ?? null;
}

/** Get debug credentials for APIM gateway tracing */
export async function listDebugCredentials(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
  apiId: string,
): Promise<string> {
  const token = await credential.getToken('https://management.azure.com/.default');
  if (!token) throw new Error('Failed to acquire token');
  const url = `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.ApiManagement/service/${encodeURIComponent(serviceName)}/gateways/managed/listDebugCredentials?api-version=${PREVIEW_API_VERSION}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      credentialsExpireAfter: 'PT1H',
      apiId,
      purposes: ['tracing'],
    }),
  });
  if (!res.ok) throw new Error(`listDebugCredentials failed: ${res.status} ${res.statusText}`);
  const body = await res.json() as { token?: string };
  return body.token ?? '';
}

/** Fetch gateway trace data for a given request ID via the ARM listTrace API */
export async function listGatewayTrace(
  credential: MsalCredential,
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
  traceId: string,
): Promise<unknown> {
  const token = await credential.getToken('https://management.azure.com/.default');
  if (!token) throw new Error('Failed to acquire token');
  const url = `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.ApiManagement/service/${encodeURIComponent(serviceName)}/gateways/managed/listTrace?api-version=2023-05-01-preview`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ traceId }),
  });
  if (!res.ok) throw new Error(`listTrace failed: ${res.status} ${res.statusText}`);
  return res.json();
}

// ===================================================
// Log Analytics Queries
// ===================================================

export type LogAnalyticsRow = Record<string, string | number | null>;

/** Execute a KQL query scoped to an Azure resource via the Microsoft.Insights/logs endpoint */
export async function queryLogAnalytics(
  credential: MsalCredential,
  resourceId: string,
  query: string,
): Promise<LogAnalyticsRow[]> {
  const token = await credential.getToken('https://management.azure.com/.default');
  if (!token) throw new Error('Failed to acquire token');
  const url = `https://management.azure.com${resourceId}/providers/Microsoft.Insights/logs?api-version=2018-08-01-preview`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Log Analytics query failed: ${res.status} ${res.statusText}`);
  const body = await res.json() as {
    tables?: { columns?: { name?: string }[]; rows?: (string | number | null)[][] }[];
  };
  const table = body.tables?.[0];
  if (!table?.columns || !table.rows) return [];
  const colNames = table.columns.map((c) => c.name ?? '');
  return table.rows.map((row) => {
    const obj: LogAnalyticsRow = {};
    for (let i = 0; i < colNames.length; i++) {
      obj[colNames[i]] = row[i] ?? null;
    }
    return obj;
  });
}
