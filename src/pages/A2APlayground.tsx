import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Bot, Send, Square, Trash2, Copy, Check, Bug,
  ChevronDown, User, Loader2, BrainCog, Plug, Play,
  PlugZap, Unplug,
} from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  ClientFactory,
  ClientFactoryOptions,
  JsonRpcTransportFactory,
  RestTransportFactory,
} from '@a2a-js/sdk/client';
import type { Client } from '@a2a-js/sdk/client';
import type {
  AgentCard,
  MessageSendParams,
  Part,
} from '@a2a-js/sdk';
import { useAzure, type WorkspaceData } from '../context/AzureContext';
import { useMsal } from '@azure/msal-react';
import TraceModal, { type TraceData, type TraceSection } from '../components/TraceModal';
import { listDebugCredentials, listGatewayTrace } from '../services/azure';
import type { A2aServer, ApimSubscription } from '../types';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
  taskId?: string;
  taskState?: string;
  artifacts?: { name?: string; content: string }[];
  latencyMs?: number;
  trace?: TraceData;
  isStreaming?: boolean;
}

/* ------------------------------------------------------------------ */
/*  APIM trace helpers (shared with Playground / McpPlayground)        */
/* ------------------------------------------------------------------ */

interface ApimTraceEntry {
  source?: string;
  timestamp?: string;
  elapsed?: string;
  message?: string;
  data?: unknown;
}

function parseElapsedTimespan(ts?: string): number | undefined {
  if (!ts) return undefined;
  const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(ts);
  if (m) return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
  const n = parseFloat(ts);
  return isNaN(n) ? undefined : n;
}

function parseApimTraceEntries(entries?: ApimTraceEntry[]): TraceSection[] {
  if (!entries || entries.length === 0) return [];
  return entries.map((e) => ({
    source: e.source ?? 'unknown',
    timestamp: e.timestamp,
    elapsed: parseElapsedTimespan(e.elapsed),
    message: e.message ?? '',
    data: e.data,
  }));
}

async function buildTraceData(
  requestInfo: { url: string; method: string; headers: Record<string, string>; body: unknown },
  respHeaders: Record<string, string>,
  response: { statusCode: number; elapsedMs: number; body: unknown },
  fetchTraceFn?: () => Promise<unknown>,
  authToken?: string,
): Promise<TraceData> {
  let inbound: TraceSection[] = [];
  let backend: TraceSection[] = [];
  let outbound: TraceSection[] = [];
  let onError: TraceSection[] = [];

  if (fetchTraceFn) {
    try {
      const traceJson = await fetchTraceFn() as Record<string, unknown>;
      const records = (traceJson.traceEntries ?? traceJson.traceRecords ?? traceJson) as {
        inbound?: ApimTraceEntry[];
        backend?: ApimTraceEntry[];
        outbound?: ApimTraceEntry[];
        'on-error'?: ApimTraceEntry[];
      };
      inbound = parseApimTraceEntries(records.inbound);
      backend = parseApimTraceEntries(records.backend);
      outbound = parseApimTraceEntries(records.outbound);
      onError = parseApimTraceEntries(records['on-error']);
    } catch (err) {
      console.warn('Failed to fetch trace data:', err);
    }
  }

  const queryParams: Record<string, string> = {};
  try {
    const urlObj = new URL(requestInfo.url, window.location.origin);
    urlObj.searchParams.forEach((v, k) => { queryParams[k] = v; });
  } catch { /* skip */ }

  return {
    authToken,
    request: { url: requestInfo.url, method: requestInfo.method, headers: requestInfo.headers, queryParams, body: requestInfo.body },
    inbound, backend, outbound, onError,
    response: { statusCode: response.statusCode, elapsedMs: response.elapsedMs, headers: respHeaders, body: response.body },
  };
}

/* ------------------------------------------------------------------ */
/*  A2A helpers                                                        */
/* ------------------------------------------------------------------ */

function partsToText(parts: Part[]): string {
  return parts.map((p) => {
    if (p.kind === 'text') return p.text;
    if (p.kind === 'data') return '```json\n' + JSON.stringify(p.data, null, 2) + '\n```';
    if (p.kind === 'file') {
      const f = p.file;
      const name = ('name' in f ? f.name : undefined) ?? 'file';
      return `[File: ${name}]`;
    }
    return '';
  }).join('\n');
}

function taskStateLabel(state: string): string {
  const labels: Record<string, string> = {
    submitted: '📋 Submitted',
    working: '⏳ Working',
    'input-required': '❓ Input Required',
    completed: '✅ Completed',
    canceled: '🚫 Canceled',
    failed: '❌ Failed',
    rejected: '🚷 Rejected',
    'auth-required': '🔒 Auth Required',
    unknown: '❔ Unknown',
  };
  return labels[state] ?? state;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function A2APlayground() {
  const { workspaceData, config, getCredential }: {
    workspaceData: WorkspaceData;
    config: { apimService: { gatewayUrl: string; subscriptionId: string; resourceGroup: string; name: string } | null; apimWorkspace: unknown };
    getCredential: ReturnType<typeof useAzure>['getCredential'];
  } = useAzure();
  const navigate = useNavigate();
  const location = useLocation();

  /* --- Config state ----------------------------------------------- */
  const [selectedApi, setSelectedApi] = useState<A2aServer | null>(null);
  const [selectedSub, setSelectedSub] = useState<ApimSubscription | null>(null);
  const [tracingEnabled, setTracingEnabled] = useState(false);
  const [streaming, setStreaming] = useState(true);
  const [sendBearerToken, setSendBearerToken] = useState(false);
  const [bearerScope, setBearerScope] = useState('');
  const { instance: msalInstance } = useMsal();

  /* --- Connection state ------------------------------------------- */
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [agentCard, setAgentCard] = useState<AgentCard | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const clientRef = useRef<Client | null>(null);

  /* --- Chat state ------------------------------------------------- */
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showTrace, setShowTrace] = useState<TraceData | null>(null);
  const [contextId, setContextId] = useState<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /* --- Request capture for tracing -------------------------------- */
  const lastFetchRef = useRef<{
    reqUrl: string;
    reqMethod: string;
    reqHeaders: Record<string, string>;
    reqBody: string;
    respHeaders: Record<string, string>;
    statusCode: number;
    latencyMs: number;
  }>({ reqUrl: '', reqMethod: '', reqHeaders: {}, reqBody: '', respHeaders: {}, statusCode: 0, latencyMs: 0 });

  /* --- Derived ---------------------------------------------------- */
  const a2aServers = workspaceData.a2aServers;
  const subs = workspaceData.subscriptions.filter((s) => s.state === 'active');
  const noWorkspace = !config.apimService;

  /* --- Auto-select from navigation state -------------------------- */
  useEffect(() => {
    const state = location.state as { a2aServer?: A2aServer } | null;
    if (state?.a2aServer) {
      setSelectedApi(state.a2aServer);
      window.history.replaceState({}, '');
    }
  }, [location.state]);

  /* --- Scroll to bottom ------------------------------------------- */
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /* --- Auto-resize textarea --------------------------------------- */
  const autoResize = useCallback(() => {
    const el = inputRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  }, []);

  /* --- Build request headers -------------------------------------- */
  const buildHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const headers: Record<string, string> = {};

    if (selectedApi?.subscriptionRequired && selectedSub) {
      headers[selectedApi.subscriptionKeyHeaderName ?? 'Ocp-Apim-Subscription-Key'] = selectedSub.primaryKey;
    }

    if (sendBearerToken) {
      const scope = bearerScope.trim() || 'https://management.azure.com/.default';
      const account = msalInstance.getActiveAccount();
      if (account) {
        try {
          const tokenResult = await msalInstance.acquireTokenSilent({ account, scopes: [scope] });
          headers.Authorization = `Bearer ${tokenResult.accessToken}`;
        } catch {
          try {
            const tokenResult = await msalInstance.acquireTokenPopup({ scopes: [scope] });
            headers.Authorization = `Bearer ${tokenResult.accessToken}`;
          } catch (err) {
            console.warn('[bearer] Failed to acquire token:', err);
          }
        }
      }
    }

    if (tracingEnabled && selectedSub?.allowTracing && config.apimService && selectedApi) {
      try {
        const debugToken = await listDebugCredentials(
          getCredential(),
          config.apimService.subscriptionId,
          config.apimService.resourceGroup,
          config.apimService.name,
          selectedApi.id,
        );
        if (debugToken) {
          headers['Ocp-Apim-Trace'] = 'true';
          headers['Apim-Debug-Authorization'] = debugToken;
        }
      } catch (err) {
        console.warn('[trace] Failed to get debug credentials:', err);
      }
    }

    if (import.meta.env.DEV && config.apimService) {
      headers['X-Gateway-Base'] = config.apimService.gatewayUrl.replace(/\/$/, '');
    }

    return headers;
  }, [selectedApi, selectedSub, sendBearerToken, bearerScope, msalInstance, tracingEnabled, config, getCredential]);

  /* --- Ref to always-current buildHeaders callback ---------------- */
  const buildHeadersRef = useRef(buildHeaders);
  buildHeadersRef.current = buildHeaders;

  /* --- Custom fetch for A2A SDK ----------------------------------- */
  const customFetch = useCallback(async (url: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
    let targetUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;

    const customHeaders = await buildHeadersRef.current();

    // In dev mode, rewrite external URLs to go through the gateway proxy
    if (import.meta.env.DEV) {
      const isExternal = targetUrl.startsWith('http') && !targetUrl.startsWith(window.location.origin);
      if (isExternal) {
        try {
          const urlObj = new URL(targetUrl);
          targetUrl = `/gateway-proxy${urlObj.pathname}${urlObj.search}`;
        } catch { /* skip */ }
      }
    }

    // Merge headers: SDK headers + custom headers (custom headers take precedence)
    const sdkHeaders: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => { sdkHeaders[k] = v; });
      } else if (typeof init.headers === 'object' && !Array.isArray(init.headers)) {
        Object.assign(sdkHeaders, init.headers);
      }
    }
    // Remove lowercased keys that our custom headers will re-add with original casing
    for (const key of Object.keys(customHeaders)) {
      delete sdkHeaders[key.toLowerCase()];
    }
    const mergedHeaders = { ...sdkHeaders, ...customHeaders };

    const startTime = Date.now();
    const resp = await fetch(targetUrl, { ...init, headers: mergedHeaders });
    const latencyMs = Date.now() - startTime;

    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => { respHeaders[k] = v; });

    lastFetchRef.current = {
      reqUrl: targetUrl,
      reqMethod: init?.method ?? 'GET',
      reqHeaders: mergedHeaders,
      reqBody: typeof init?.body === 'string' ? init.body : '',
      respHeaders,
      statusCode: resp.status,
      latencyMs,
    };

    // APIM gateway may return a different Content-Type for SSE streams.
    // The A2A SDK strictly checks for 'text/event-stream', so fix it up
    // when the SDK requested SSE and the response is successful.
    const acceptHeader = mergedHeaders.Accept ?? mergedHeaders.accept ?? '';
    const respContentType = resp.headers.get('Content-Type') ?? '';
    if (
      resp.ok &&
      acceptHeader.includes('text/event-stream') &&
      !respContentType.startsWith('text/event-stream')
    ) {
      const fixedHeaders = new Headers(resp.headers);
      fixedHeaders.set('Content-Type', 'text/event-stream');
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: fixedHeaders,
      });
    }

    return resp;
  }, []);

  /* --- Build trace for last request ------------------------------- */
  const buildEntryTrace = useCallback(async (resultBody?: unknown): Promise<TraceData | undefined> => {
    const { reqUrl, reqMethod, reqHeaders, reqBody, respHeaders, statusCode, latencyMs } = lastFetchRef.current;
    if (!reqUrl) return undefined;

    const authToken = reqHeaders.Authorization?.replace(/^Bearer\s+/i, '') ?? reqHeaders.authorization?.replace(/^Bearer\s+/i, '');
    const subKeyHeader = selectedApi?.subscriptionKeyHeaderName ?? 'Ocp-Apim-Subscription-Key';
    const maskedHeaders = { ...reqHeaders };
    for (const key of Object.keys(maskedHeaders)) {
      if (key.toLowerCase() === subKeyHeader.toLowerCase() || key.toLowerCase() === 'authorization' || key.toLowerCase() === 'apim-debug-authorization') {
        maskedHeaders[key] = '***';
      }
    }

    const apimTraceId = respHeaders['apim-trace-id'];
    const fetchTraceFn = (tracingEnabled && apimTraceId && config.apimService)
      ? () => listGatewayTrace(
          getCredential(),
          config.apimService!.subscriptionId,
          config.apimService!.resourceGroup,
          config.apimService!.name,
          apimTraceId,
        )
      : undefined;

    let parsedReqBody: unknown = reqBody;
    try { parsedReqBody = JSON.parse(reqBody) as unknown; } catch { /* keep string */ }

    // In dev mode, replace the local proxy URL with the real gateway URL for display
    let displayUrl = reqUrl;
    if (import.meta.env.DEV && config.apimService) {
      const proxyPrefix = '/gateway-proxy';
      if (displayUrl.startsWith(proxyPrefix)) {
        displayUrl = config.apimService.gatewayUrl.replace(/\/$/, '') + displayUrl.slice(proxyPrefix.length);
      }
    }

    return buildTraceData(
      { url: displayUrl, method: reqMethod, headers: maskedHeaders, body: parsedReqBody },
      respHeaders,
      { statusCode, elapsedMs: latencyMs, body: resultBody ?? '' },
      fetchTraceFn,
      authToken,
    );
  }, [tracingEnabled, config, getCredential, selectedApi]);

  /* --- Build URL helper ------------------------------------------- */
  const buildUrl = useCallback((path: string): string => {
    if (!config.apimService) return '';
    const gatewayBase = config.apimService.gatewayUrl.replace(/\/$/, '');
    if (import.meta.env.DEV) {
      return `/gateway-proxy${path}`;
    }
    return `${gatewayBase}${path}`;
  }, [config.apimService]);

  /* --- Connect to A2A agent --------------------------------------- */
  const connect = useCallback(async () => {
    if (!selectedApi || !config.apimService) return;

    setConnecting(true);
    setConnectionError('');
    setAgentCard(null);
    clientRef.current = null;

    try {
      const gatewayBase = config.apimService.gatewayUrl.replace(/\/$/, '');
      const apiPath = `/${selectedApi.path.replace(/^\//, '')}`;

      // 1. Fetch agent card
      const agentCardUrl = buildUrl(`${apiPath}/agent-card.json`);
      const headers = await buildHeaders();
      const cardResp = await fetch(agentCardUrl, { headers });
      if (!cardResp.ok) {
        throw new Error(`Failed to fetch agent card: ${cardResp.status} ${cardResp.statusText}`);
      }
      const card = await cardResp.json() as AgentCard;

      // 2. Fix agent card URL to route through APIM gateway
      card.url = import.meta.env.DEV
        ? `${window.location.origin}/gateway-proxy${apiPath}`
        : `${gatewayBase}${apiPath}`;
      // Clear additional interfaces to avoid URL mismatches with backend
      card.additionalInterfaces = [];

      // 3. Create client factory with custom fetch
      // Pass acceptedOutputModes from the agent card so the server-side
      // validation of the configuration field succeeds.
      const outputModes = (card as AgentCard & { defaultOutputModes?: string[] }).defaultOutputModes;
      const factory = new ClientFactory(
        ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
          transports: [
            new JsonRpcTransportFactory({ fetchImpl: customFetch }),
            new RestTransportFactory({ fetchImpl: customFetch }),
          ],
          clientConfig: {
            acceptedOutputModes: outputModes && outputModes.length > 0 ? outputModes : ['text'],
          },
        }),
      );

      // 4. Create client from agent card
      const client = await factory.createFromAgentCard(card);

      clientRef.current = client;
      setAgentCard(card);
      setConnected(true);
      setMessages([]);
      setContextId(undefined);
    } catch (err) {
      console.error('Failed to connect to A2A agent:', err);
      setConnectionError((err as Error).message);
    } finally {
      setConnecting(false);
    }
  }, [selectedApi, config.apimService, buildUrl, buildHeaders, customFetch]);

  /* --- Disconnect ------------------------------------------------- */
  const disconnect = useCallback(() => {
    clientRef.current = null;
    setConnected(false);
    setAgentCard(null);
    setMessages([]);
    setContextId(undefined);
    setConnectionError('');
  }, []);

  /* --- Reset on API/Sub change ------------------------------------ */
  useEffect(() => {
    if (connected) {
      disconnect();
    }
  }, [selectedApi, selectedSub]); // eslint-disable-line react-hooks/exhaustive-deps

  /* --- Send message ----------------------------------------------- */
  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !clientRef.current || isRunning) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
    };

    const agentId = crypto.randomUUID();
    const agentMsg: ChatMessage = {
      id: agentId,
      role: 'agent',
      content: '',
      isStreaming: true,
    };

    setMessages((prev) => [...prev, userMsg, agentMsg]);
    setInput('');
    setIsRunning(true);

    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }

    const controller = new AbortController();
    abortRef.current = controller;
    const startTime = Date.now();

    const messageId = crypto.randomUUID();
    const sendParams: MessageSendParams = {
      message: {
        messageId,
        role: 'user',
        parts: [{ kind: 'text', text }],
        kind: 'message',
        ...(contextId ? { contextId } : {}),
      },
    };

    const updateMsg = (updates: Partial<ChatMessage>) => {
      setMessages((prev) => prev.map((m) => m.id === agentId ? { ...m, ...updates } : m));
    };

    try {
      if (streaming) {
        // --- Streaming mode ---
        const stream = clientRef.current.sendMessageStream(sendParams, { signal: controller.signal });
        let fullContent = '';
        let currentTaskId: string | undefined;
        let currentTaskState: string | undefined;
        const artifacts: { name?: string; content: string }[] = [];
        const streamEvents: unknown[] = [];

        for await (const event of stream) {
          streamEvents.push(event);
          if (event.kind === 'message') {
            fullContent = partsToText(event.parts);
            if (event.contextId) setContextId(event.contextId);
            updateMsg({ content: fullContent });
          } else if (event.kind === 'task') {
            currentTaskId = event.id;
            currentTaskState = event.status.state;
            if (event.contextId) setContextId(event.contextId);
            // Extract text from task history or status message
            if (event.status.message) {
              fullContent = partsToText(event.status.message.parts);
            }
            if (event.artifacts) {
              for (const a of event.artifacts) {
                artifacts.push({ name: a.name, content: partsToText(a.parts) });
              }
            }
            updateMsg({
              content: fullContent || `Task ${event.id}: ${taskStateLabel(event.status.state)}`,
              taskId: currentTaskId,
              taskState: currentTaskState,
              artifacts: artifacts.length > 0 ? [...artifacts] : undefined,
            });
          } else if (event.kind === 'status-update') {
            currentTaskState = event.status.state;
            if (event.status.message) {
              fullContent = partsToText(event.status.message.parts);
            }
            updateMsg({
              content: fullContent || `Task: ${taskStateLabel(event.status.state)}`,
              taskId: currentTaskId ?? event.taskId,
              taskState: currentTaskState,
            });
          } else if (event.kind === 'artifact-update') {
            artifacts.push({
              name: event.artifact.name,
              content: partsToText(event.artifact.parts),
            });
            updateMsg({ artifacts: [...artifacts] });
          }
        }

        const latencyMs = Date.now() - startTime;
        const trace = await buildEntryTrace(streamEvents);
        updateMsg({
          isStreaming: false,
          latencyMs,
          trace,
          content: fullContent || (currentTaskState ? taskStateLabel(currentTaskState) : '(empty response)'),
        });
      } else {
        // --- Non-streaming mode ---
        const result = await clientRef.current.sendMessage(sendParams, { signal: controller.signal });
        const latencyMs = Date.now() - startTime;

        let content = '';
        let taskId: string | undefined;
        let taskState: string | undefined;
        let artifacts: { name?: string; content: string }[] | undefined;

        if (result.kind === 'message') {
          content = partsToText(result.parts);
          if (result.contextId) setContextId(result.contextId);
        } else if (result.kind === 'task') {
          taskId = result.id;
          taskState = result.status.state;
          if (result.contextId) setContextId(result.contextId);
          // Extract content from task
          if (result.status.message) {
            content = partsToText(result.status.message.parts);
          }
          // Check history for agent messages
          if (!content && result.history) {
            const agentMsgs = result.history.filter((h) => h.role === 'agent');
            if (agentMsgs.length > 0) {
              content = partsToText(agentMsgs[agentMsgs.length - 1].parts);
            }
          }
          if (result.artifacts && result.artifacts.length > 0) {
            artifacts = result.artifacts.map((a) => ({ name: a.name, content: partsToText(a.parts) }));
          }
          if (!content) {
            content = `Task ${result.id}: ${taskStateLabel(result.status.state)}`;
          }
        }

        const trace = await buildEntryTrace(result);

        updateMsg({
          content: content || '(empty response)',
          isStreaming: false,
          latencyMs,
          taskId,
          taskState,
          artifacts,
          trace,
        });
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        const latencyMs = Date.now() - startTime;
        const trace = await buildEntryTrace((err as Error).message);
        updateMsg({
          content: `Error: ${(err as Error).message}`,
          isStreaming: false,
          latencyMs,
          trace,
        });
      }
    } finally {
      setIsRunning(false);
      abortRef.current = null;
    }
  }, [input, isRunning, streaming, contextId, buildEntryTrace]);

  /* --- Stop ------------------------------------------------------- */
  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    setMessages((prev) => prev.map((m) => m.isStreaming ? { ...m, isStreaming: false } : m));
    setIsRunning(false);
  }, []);

  /* --- Delete message --------------------------------------------- */
  const deleteMessage = useCallback((id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  /* --- Copy message ----------------------------------------------- */
  const copyMessage = useCallback((id: string, content: string) => {
    void navigator.clipboard.writeText(content);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  }, []);

  /* --- Clear conversation ----------------------------------------- */
  const clearConversation = useCallback(() => {
    setMessages([]);
    setContextId(undefined);
  }, []);

  /* --- Key handlers ----------------------------------------------- */
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }, [handleSend]);

  /* ================================================================ */
  /*  Render                                                           */
  /* ================================================================ */

  const canSend = connected && !!clientRef.current && input.trim().length > 0 && !isRunning;

  return (
    <div className="pg-outer">
      {/* Tab bar */}
      <div className="pg-tabs">
        <button className="pg-tab" onClick={() => { void navigate('/playground'); }}>
          <BrainCog size={14} /> Model
        </button>
        <button className="pg-tab" onClick={() => { void navigate('/mcp-playground'); }}>
          <Plug size={14} /> MCP
        </button>
        <button className="pg-tab active">
          <Bot size={14} /> A2A
        </button>
      </div>

      <div className="pg-layout">
        {/* ---- Left: Configuration Panel ---- */}
        <div className="pg-config">
          <div className="pg-config-header">
            <Play size={16} />
            <span>A2A playground</span>
          </div>

          <div className="pg-config-body">
            {noWorkspace ? (
              <div className="pg-config-empty">Select an APIM instance to get started.</div>
            ) : (
              <>
                {/* A2A API */}
                <div className="pg-field">
                  <label className="pg-label">A2A API</label>
                  <select
                    className="pg-select"
                    value={selectedApi?.name ?? ''}
                    onChange={(e) => {
                      const api = a2aServers.find((a) => a.name === e.target.value) ?? null;
                      setSelectedApi(api);
                    }}
                    disabled={connected}
                  >
                    <option value="">Select an A2A API…</option>
                    {a2aServers.map((api) => (
                      <option key={api.name} value={api.name}>{api.displayName}</option>
                    ))}
                  </select>
                </div>

                {/* Subscription */}
                <div className="pg-field">
                  <label className="pg-label">Subscription (API Key)</label>
                  <select
                    className="pg-select"
                    value={selectedSub?.sid ?? ''}
                    onChange={(e) => {
                      const sub = subs.find((s) => s.sid === e.target.value) ?? null;
                      setSelectedSub(sub);
                      if (sub && !sub.allowTracing) setTracingEnabled(false);
                    }}
                    disabled={connected}
                  >
                    <option value="">Select a subscription…</option>
                    {subs.map((s) => (
                      <option key={s.sid} value={s.sid}>{s.displayName}</option>
                    ))}
                  </select>
                </div>

                {/* Tracing */}
                {selectedSub && (
                  <label className="pg-toggle">
                    <span>Tracing</span>
                    <button
                      className={`pg-toggle-switch${tracingEnabled ? ' on' : ''}${!selectedSub.allowTracing ? ' disabled' : ''}`}
                      onClick={() => { if (selectedSub.allowTracing) setTracingEnabled(!tracingEnabled); }}
                      role="switch"
                      aria-checked={tracingEnabled}
                      title={!selectedSub.allowTracing ? 'Tracing not allowed on this subscription' : ''}
                    >
                      <span className="pg-toggle-thumb" />
                    </button>
                    {!selectedSub.allowTracing && (
                      <span className="pg-toggle-hint">Not allowed</span>
                    )}
                  </label>
                )}

                {/* Streaming */}
                <label className="pg-toggle">
                  <span>Streaming</span>
                  <button
                    className={`pg-toggle-switch${streaming ? ' on' : ''}`}
                    onClick={() => setStreaming(!streaming)}
                    role="switch"
                    aria-checked={streaming}
                  >
                    <span className="pg-toggle-thumb" />
                  </button>
                </label>

                {/* Send bearer token */}
                <label className="pg-toggle">
                  <span>Send bearer token</span>
                  <button
                    className={`pg-toggle-switch${sendBearerToken ? ' on' : ''}`}
                    onClick={() => setSendBearerToken(!sendBearerToken)}
                    role="switch"
                    aria-checked={sendBearerToken}
                    title="Acquire an Entra ID bearer token and send it in the Authorization header"
                  >
                    <span className="pg-toggle-thumb" />
                  </button>
                </label>

                {sendBearerToken && (
                  <div className="pg-field">
                    <label className="pg-label">Token scope</label>
                    <input
                      type="text"
                      className="pg-input"
                      placeholder="https://management.azure.com/.default"
                      value={bearerScope}
                      onChange={(e) => setBearerScope(e.target.value)}
                      disabled={isRunning}
                    />
                  </div>
                )}

                {/* Connect / Disconnect button */}
                <div className="pg-field" style={{ marginTop: 8 }}>
                  {!connected ? (
                    <button
                      className="a2a-pg-connect-btn"
                      onClick={() => void connect()}
                      disabled={!selectedApi || connecting}
                    >
                      {connecting ? <Loader2 size={14} className="pg-spinner" /> : <PlugZap size={14} />}
                      {connecting ? 'Connecting…' : 'Connect'}
                    </button>
                  ) : (
                    <button className="a2a-pg-connect-btn a2a-pg-disconnect" onClick={disconnect}>
                      <Unplug size={14} /> Disconnect
                    </button>
                  )}
                </div>

                {connectionError && (
                  <div className="a2a-pg-error">{connectionError}</div>
                )}

                {/* Agent Card Info */}
                {agentCard && (
                  <div className="a2a-pg-card">
                    <div className="a2a-pg-card-header">
                      <span>{agentCard.name}</span>
                      {agentCard.description && <span className="a2a-pg-card-header-desc">{agentCard.description}</span>}
                    </div>
                    <div className="a2a-pg-card-meta">
                      <span className="a2a-pg-tag mode">{agentCard.protocolVersion}</span>
                      {agentCard.version && <span className="a2a-pg-tag mode">v{agentCard.version}</span>}
                      {agentCard.preferredTransport && <span className="a2a-pg-tag mode">{agentCard.preferredTransport}</span>}
                      {agentCard.provider && (
                        <span className="a2a-pg-tag mode" title="Provider">{agentCard.provider.organization}</span>
                      )}
                    </div>
                    <div className="a2a-pg-card-meta">
                      {agentCard.capabilities.streaming != null && (
                        <span className="a2a-pg-tag mode">{agentCard.capabilities.streaming ? '⚡ Streaming' : 'No Streaming'}</span>
                      )}
                      {agentCard.defaultInputModes.map((m) => (
                        <span key={`in-${m}`} className="a2a-pg-tag mode" title="Input mode">↓ {m}</span>
                      ))}
                      {agentCard.defaultOutputModes.map((m) => (
                        <span key={`out-${m}`} className="a2a-pg-tag mode" title="Output mode">↑ {m}</span>
                      ))}
                    </div>
                    {agentCard.skills.length > 0 && (
                      <div className="a2a-pg-skills-list">
                        {agentCard.skills.map((s) => (
                          <div key={s.id} className="a2a-pg-skill-item">
                            <div className="a2a-pg-skill-top">
                              <span className="a2a-pg-skill-name">{s.name}</span>
                              {s.tags.length > 0 && (
                                <div className="a2a-pg-tags">
                                  {s.tags.map((t) => (
                                    <span key={t} className="a2a-pg-tag">{t}</span>
                                  ))}
                                </div>
                              )}
                            </div>
                            {s.description && <div className="a2a-pg-skill-desc">{s.description}</div>}
                            {s.examples && s.examples.length > 0 && (
                              <div className="a2a-pg-examples">
                                <span className="a2a-pg-examples-label">Try these prompts:</span>
                                {s.examples.map((ex) => (
                                  <button
                                    key={ex}
                                    className="a2a-pg-example"
                                    title="Click to use as prompt"
                                    onClick={() => { setInput(ex); inputRef.current?.focus(); }}
                                  >
                                    {ex}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* ---- Right: Chat Panel ---- */}
        <div className="pg-chat">
          {/* Chat header */}
          <div className="pg-chat-header">
            <div className="pg-chat-header-info">
              <span className="pg-chat-title">{agentCard?.name ?? selectedApi?.displayName ?? 'A2A Chat'}</span>
              {connected && <span className="a2a-pg-status connected">Connected</span>}
              {!connected && selectedApi && <span className="a2a-pg-status">Disconnected</span>}
            </div>
            <div className="pg-chat-header-actions">
              {messages.length > 0 && (
                <button className="pg-icon-btn" onClick={clearConversation} title="Clear conversation">
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          </div>

          {/* Messages */}
          <div className="pg-messages">
            {messages.length === 0 ? (
              <div className="pg-messages-empty">
                <Bot size={32} style={{ opacity: 0.3 }} />
                <p>{connected ? 'Send a message to start the conversation' : 'Connect to an A2A agent to start chatting'}</p>
              </div>
            ) : (
              messages.map((msg) => (
                <div key={msg.id} className={`pg-msg ${msg.role === 'user' ? 'pg-msg-user' : 'pg-msg-assistant'}`}>
                  <div className="pg-msg-avatar">
                    {msg.role === 'user' ? <User size={14} /> : <Bot size={14} />}
                  </div>
                  <div className="pg-msg-body">
                    <div className="pg-msg-content">
                      {msg.content || (msg.isStreaming ? <Loader2 size={16} className="pg-spinner" /> : null)}
                    </div>

                    {/* Task state badge */}
                    {msg.taskState && (
                      <div className="a2a-pg-task-badge">
                        <span className={`a2a-pg-task-state a2a-pg-state-${msg.taskState}`}>
                          {taskStateLabel(msg.taskState)}
                        </span>
                        {msg.taskId && <span className="a2a-pg-task-id">Task: {msg.taskId.slice(0, 8)}…</span>}
                      </div>
                    )}

                    {/* Artifacts */}
                    {msg.artifacts && msg.artifacts.length > 0 && (
                      <div className="a2a-pg-artifacts">
                        <div className="a2a-pg-artifacts-header">
                          <ChevronDown size={12} /> Artifacts ({msg.artifacts.length})
                        </div>
                        {msg.artifacts.map((a, i) => (
                          <div key={i} className="a2a-pg-artifact">
                            {a.name && <div className="a2a-pg-artifact-name">{a.name}</div>}
                            <pre className="a2a-pg-artifact-content">{a.content}</pre>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Message meta bar */}
                    {msg.role === 'agent' && !msg.isStreaming && msg.content && (
                      <div className="pg-msg-meta">
                        {msg.latencyMs != null && <span className="pg-msg-meta-item">{msg.latencyMs}ms</span>}

                        {/* Trace / Debug */}
                        {msg.trace && (
                          <button className="pg-msg-meta-btn" onClick={() => setShowTrace(msg.trace!)} title="View request details">
                            <Bug size={13} />
                          </button>
                        )}

                        <span className="pg-msg-meta-sep" />

                        <button className="pg-msg-meta-btn" onClick={() => copyMessage(msg.id, msg.content)} title="Copy">
                          {copiedId === msg.id ? <Check size={13} /> : <Copy size={13} />}
                        </button>
                        <button className="pg-msg-meta-btn" onClick={() => deleteMessage(msg.id)} title="Delete message">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )}

                    {/* User message actions */}
                    {msg.role === 'user' && (
                      <div className="pg-msg-meta">
                        <button className="pg-msg-meta-btn" onClick={() => copyMessage(msg.id, msg.content)} title="Copy">
                          {copiedId === msg.id ? <Check size={13} /> : <Copy size={13} />}
                        </button>
                        <button className="pg-msg-meta-btn" onClick={() => deleteMessage(msg.id)} title="Delete">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Input area */}
          <div className="pg-input-bar">
            <textarea
              ref={inputRef}
              className="pg-input-textarea"
              placeholder={!connected ? 'Connect to an A2A agent to start chatting' : 'Type a message… (Enter to send, Shift+Enter for new line)'}
              value={input}
              onChange={(e) => { setInput(e.target.value); autoResize(); }}
              onKeyDown={handleKeyDown}
              rows={1}
              disabled={!connected}
            />
            <div className="pg-input-actions">
              {isRunning ? (
                <button className="pg-send-btn pg-stop-btn" onClick={handleStop} title="Stop">
                  <Square size={14} />
                </button>
              ) : (
                <button className="pg-send-btn" disabled={!canSend} onClick={() => void handleSend()} title="Send">
                  <Send size={14} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ---- Trace Modal ---- */}
        {showTrace && (
          <TraceModal
            trace={showTrace}
            allTraces={messages.filter((m) => m.trace).map((m) => {
              let label: string;
              if (m.role === 'user') {
                label = m.content.slice(0, 50);
              } else {
                const idx = messages.indexOf(m);
                const prevUser = messages.slice(0, idx).reverse().find((p) => p.role === 'user');
                label = prevUser ? prevUser.content.slice(0, 50) : 'Response';
              }
              return {
                id: m.id,
                label,
                role: m.role === 'user' ? 'user' as const : 'assistant' as const,
                trace: m.trace!,
                latencyMs: m.latencyMs,
              };
            })}
            initialTraceId={messages.find((m) => m.trace === showTrace)?.id}
            onClose={() => setShowTrace(null)}
          />
        )}
      </div>
    </div>
  );
}
