export interface AzureTenant {
  tenantId: string;
  displayName: string;
  defaultDomain: string;
}

export interface AzureSubscription {
  subscriptionId: string;
  displayName: string;
  tenantId: string;
  state: string;
}

export interface ApimService {
  id: string;
  name: string;
  resourceGroup: string;
  location: string;
  subscriptionId: string;
  sku: string;
  gatewayUrl: string;
}

export interface ApimWorkspace {
  id: string;
  name: string;
  displayName: string;
}

export interface FoundryProject {
  id: string;
  name: string;
  location: string;
  resourceGroup: string;
}

export interface MonitorResource {
  id: string;
  name: string;
  resourceGroup: string;
  workspaceId: string;
}

export interface AppInsightsResource {
  id: string;
  name: string;
  resourceGroup: string;
}

export interface UserProfile {
  name: string;
  email: string;
  tenantId: string;
  tenantName?: string;
  objectId: string;
}

export type ThemeMode = 'light' | 'dark' | 'system';

export interface ApimSubscription {
  id: string;
  sid: string;
  displayName: string;
  scope: string;
  state: string;
  ownerId: string;
  ownerName: string;
  allowTracing: boolean;
  primaryKey: string;
  secondaryKey: string;
  createdDate?: string;
}

export interface ApimApi {
  id: string;
  name: string;
  displayName: string;
  description: string;
  path: string;
  apiType: string;
  mcpTools: string[];
  agentId: string;
  subscriptionKeyHeaderName?: string;
}

export interface ApimProduct {
  id: string;
  name: string;
  displayName: string;
  description: string;
  state: string;
  subscriptionRequired: boolean;
  approvalRequired: boolean;
  subscriptionsLimit?: number;
}

export type ProviderType =
  | 'foundry'
  | 'azureopenai'
  | 'openai'
  | 'gemini'
  | 'anthropic'
  | 'bedrock'
  | 'huggingface'
  | 'unknown';

export interface PoolMember {
  name: string;
  url: string;
  weight?: number;
  priority?: number;
  providerType: ProviderType;
}

export interface CircuitBreakerRule {
  name: string;
  tripDuration?: string;
  acceptRetryAfter?: boolean;
  failureCount?: number;
  failurePercentage?: number;
  failureInterval?: string;
  statusCodeRanges: { min?: number; max?: number }[];
  errorReasons: string[];
}

export interface ApimBackend {
  id: string;
  name: string;
  title: string;
  description: string;
  url: string;
  protocol: string;
  providerType: ProviderType;
  circuitBreaker: boolean;
  circuitBreakerRules: CircuitBreakerRule[];
  poolSize: number;
  poolMembers: PoolMember[];
}

export interface ApimApiDetail {
  id: string;
  name: string;
  displayName: string;
  description: string;
  path: string;
  serviceUrl: string;
  apiVersion: string;
  apiRevision: string;
  subscriptionRequired: boolean;
  subscriptionKeyParameterNames: { header?: string; query?: string };
  protocols: string[];
  isCurrent: boolean;
}

export interface ApimApiRevision {
  apiRevision: string;
  description: string;
  isCurrent: boolean;
  createdDateTime: string;
  updatedDateTime: string;
}

export interface ApimApiRelease {
  releaseId: string;
  apiId: string;
  notes: string;
  createdDateTime: string;
}

export interface ApimTag {
  id: string;
  name: string;
  displayName: string;
}

export interface InferenceApi extends ApimApi {
  backendId: string;
  providerType: ProviderType;
  tags: ApimTag[];
}

export type McpSource = 'mcp-server' | 'api';

export interface McpServer extends ApimApi {
  source: McpSource;
  tags: ApimTag[];
}

export interface A2aServer extends ApimApi {
  tags: ApimTag[];
}

export interface PortalConfig {
  subscription: AzureSubscription | null;
  apimService: ApimService | null;
  apimWorkspace: ApimWorkspace | null;
  monitorResource: MonitorResource | null;
  appInsightsResource: AppInsightsResource | null;
  foundryProject: FoundryProject | null;
}
