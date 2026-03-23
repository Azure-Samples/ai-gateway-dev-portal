import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Plug, PlugZap, Unplug, Play, Bug, ChevronDown,
  FolderOpen, MessageSquare, Wrench, Loader2, Copy, Check, X,
  RefreshCw, BrainCog, Bot,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ListResourcesResultSchema,
  ListPromptsResultSchema,
  ListToolsResultSchema,
  CallToolResultSchema,
  ReadResourceResultSchema,
  GetPromptResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import { useAzure, type WorkspaceData } from '../context/AzureContext';
import TraceModal, { type TraceData, type TraceSection, type TraceEntry } from '../components/TraceModal';
import { listDebugCredentials, listGatewayTrace } from '../services/azure';
import type { McpServer, ApimSubscription } from '../types';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
type McpTab = 'resources' | 'prompts' | 'tools';

interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

interface McpPrompt {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface HistoryEntry {
  id: string;
  method: string;
  toolName?: string;
  args?: string;
  result?: string;
  error?: string;
  latencyMs: number;
  timestamp: Date;
  trace?: TraceData;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="mcp-pg-copy-btn"
      onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      title="Copy"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  APIM trace helpers (reused from Playground)                        */
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
    request: { url: requestInfo.url, method: requestInfo.method, headers: requestInfo.headers, queryParams, body: requestInfo.body },
    inbound, backend, outbound, onError,
    response: { statusCode: response.statusCode, elapsedMs: response.elapsedMs, headers: respHeaders, body: response.body },
  };
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function McpPlayground() {
  const { workspaceData, config, getCredential }: {
    workspaceData: WorkspaceData;
    config: { apimService: { gatewayUrl: string; subscriptionId: string; resourceGroup: string; name: string } | null; apimWorkspace: unknown };
    getCredential: ReturnType<typeof useAzure>['getCredential'];
  } = useAzure();

  /* --- Config state ----------------------------------------------- */
  const [selectedServer, setSelectedServer] = useState<McpServer | null>(null);
  const [selectedSub, setSelectedSub] = useState<ApimSubscription | null>(null);
  const [tracingEnabled, setTracingEnabled] = useState(false);

  /* --- Connection state ------------------------------------------- */
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [capabilities, setCapabilities] = useState<ServerCapabilities | null>(null);
  const clientRef = useRef<Client | null>(null);
  const transportRef = useRef<StreamableHTTPClientTransport | null>(null);
  const lastFetchRef = useRef<{
    reqUrl: string; reqMethod: string; reqHeaders: Record<string, string>; reqBody: unknown;
    respHeaders: Record<string, string>; statusCode: number; respBody: unknown;
  }>({ reqUrl: '', reqMethod: '', reqHeaders: {}, reqBody: undefined, respHeaders: {}, statusCode: 0, respBody: undefined });

  /* --- Data state ------------------------------------------------- */
  const [activeTab, setActiveTab] = useState<McpTab>('tools');
  const [resources, setResources] = useState<McpResource[]>([]);
  const [prompts, setPrompts] = useState<McpPrompt[]>([]);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showTraceId, setShowTraceId] = useState<string | null>(null);
  const [executing, setExecuting] = useState<string | null>(null);
  const [expandedTool, setExpandedTool] = useState<string | null>(null);
  const [toolArgs, setToolArgs] = useState<Record<string, string>>({});
  const [expandedHistory, setExpandedHistory] = useState<string | null>(null);
  const [resourceContent, setResourceContent] = useState<{ uri: string; content: string } | null>(null);
  const [promptResult, setPromptResult] = useState<{ name: string; messages: unknown[] } | null>(null);
  const [promptArgs, setPromptArgs] = useState<Record<string, string>>({});
  const [expandedPrompt, setExpandedPrompt] = useState<string | null>(null);

  /* --- Derived ---------------------------------------------------- */
  const mcpServers = workspaceData.mcpServers;
  const subs = workspaceData.subscriptions.filter((s) => s.state === 'active');
  const noWorkspace = !config.apimService;

  /* --- Tracing header helper -------------------------------------- */
  const getTracingHeaders = useCallback(async (): Promise<Record<string, string>> => {
    if (!tracingEnabled || !selectedSub?.allowTracing || !config.apimService || !selectedServer) return {};
    try {
      const debugToken = await listDebugCredentials(
        getCredential(),
        config.apimService.subscriptionId,
        config.apimService.resourceGroup,
        config.apimService.name,
        selectedServer.id,
      );
      if (debugToken) {
        return { 'Ocp-Apim-Trace': 'true', 'Apim-Debug-Authorization': debugToken };
      }
    } catch (err) {
      console.warn('[trace] Failed to get debug credentials:', err);
    }
    return {};
  }, [tracingEnabled, selectedSub, config.apimService, selectedServer, getCredential]);

  /* --- Build trace from response headers -------------------------- */
  const buildEntryTrace = useCallback(async (
    url: string,
    method: string,
    reqHeaders: Record<string, string>,
    body: unknown,
    respHeaders: Record<string, string>,
    statusCode: number,
    latencyMs: number,
    respBody: unknown,
  ): Promise<TraceData | undefined> => {
    // Mask the subscription key header (use the configured name, not hardcoded default)
    const subKeyHeader = selectedServer?.subscriptionKeyHeaderName ?? 'Ocp-Apim-Subscription-Key';
    const maskedHeaders = { ...reqHeaders };
    for (const key of Object.keys(maskedHeaders)) {
      if (key.toLowerCase() === subKeyHeader.toLowerCase()) {
        maskedHeaders[key] = '***';
      }
    }
    // Only fetch APIM trace when tracing is enabled and a trace ID is available
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
    return buildTraceData(
      { url, method, headers: maskedHeaders, body },
      respHeaders,
      { statusCode, elapsedMs: latencyMs, body: respBody },
      fetchTraceFn,
    );
  }, [tracingEnabled, config.apimService, getCredential, selectedServer]);

  /* --- Connect ---------------------------------------------------- */
  const connect = useCallback(async () => {
    if (!selectedServer || !config.apimService) return;

    // Disconnect first if already connected
    if (clientRef.current) {
      try { await clientRef.current.close(); } catch { /* ignore */ }
      clientRef.current = null;
      transportRef.current = null;
    }

    setStatus('connecting');
    setResources([]);
    setPrompts([]);
    setTools([]);
    setCapabilities(null);

    try {
      const gatewayBase = config.apimService.gatewayUrl.replace(/\/$/, '');
      const mcpSuffix = selectedServer.source === 'mcp-server' ? '' : '/mcp';
      const mcpPath = `/${selectedServer.path.replace(/^\//, '')}${mcpSuffix}`;

      // Build headers: subscription key + tracing + gateway proxy
      const subKeyHeader = selectedServer.subscriptionKeyHeaderName ?? 'Ocp-Apim-Subscription-Key';
      const headers: Record<string, string> = {};
      if (selectedServer.subscriptionRequired && selectedSub) {
        headers[subKeyHeader] = selectedSub.primaryKey;
      }

      // Add tracing headers
      const tracingHeaders = await getTracingHeaders();
      Object.assign(headers, tracingHeaders);

      // In dev mode, use gateway proxy
      if (import.meta.env.DEV) {
        headers['X-Gateway-Base'] = gatewayBase;
      }

      const baseUrl = import.meta.env.DEV
        ? new URL(`/gateway-proxy${mcpPath}`, window.location.origin)
        : new URL(mcpPath, gatewayBase);

      const transport = new StreamableHTTPClientTransport(baseUrl, {
        requestInit: { headers },
        fetch: async (url: string | URL | globalThis.Request, init?: RequestInit) => {
          // Get fresh tracing headers for each request
          const freshTracingHeaders = await getTracingHeaders();

          // Merge SDK headers (may be Headers object), base headers, and tracing headers
          // SDK's _commonHeaders() includes our requestInit headers (lowercased); we must
          // avoid duplicating headers with different casing (browsers send both, Node joins them).
          const sdkHeaders: Record<string, string> = {};
          if (init?.headers) {
            if (init.headers instanceof Headers) {
              init.headers.forEach((v, k) => { sdkHeaders[k] = v; });
            } else if (typeof init.headers === 'object') {
              Object.assign(sdkHeaders, init.headers);
            }
          }
          // Remove lowercased keys that our base headers will re-add with original casing
          for (const key of Object.keys(headers)) {
            delete sdkHeaders[key.toLowerCase()];
          }
          const mergedHeaders: Record<string, string> = { ...sdkHeaders, ...headers, ...freshTracingHeaders };

          const finalInit = {
            ...init,
            headers: mergedHeaders,
          };

          const rawUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
          let reqUrl: string;
          try { reqUrl = new URL(rawUrl).pathname.replace(/^\/gateway-proxy/, ''); } catch { reqUrl = rawUrl; }
          const reqMethod = finalInit.method ?? 'POST';
          const reqHeaders = finalInit.headers;
          const reqBody: unknown = finalInit.body ? (() => { try { return JSON.parse(finalInit.body as string) as unknown; } catch { return finalInit.body; } })() : undefined;

          const response = await fetch(url, finalInit);

          const respHeaders: Record<string, string> = {};
          response.headers.forEach((v, k) => { respHeaders[k] = v; });

          let respBody: unknown = undefined;
          // Try to clone and read body for trace (skip SSE streams — reading blocks the return)
          try {
            const ct = response.headers.get('content-type') ?? '';
            if (ct.includes('json')) {
              const cloned = response.clone();
              respBody = await cloned.json();
            } else if (!ct.includes('text/event-stream')) {
              const cloned = response.clone();
              respBody = await cloned.text();
            }
          } catch {
            respBody = undefined;
          }

          // Only capture POST requests for tracing (GET requests are SSE listener setups)
          if (reqMethod === 'POST') {
            lastFetchRef.current = { reqUrl, reqMethod, reqHeaders, reqBody, respHeaders, statusCode: response.status, respBody };
          }

          return response;
        },
      });

      const client = new Client(
        { name: 'ai-gateway-dev-portal', version: '1.0.0' },
        { capabilities: { sampling: {} } },
      );

      // Store refs to capture response info after connect
      transportRef.current = transport;

      await client.connect(transport, { timeout: 120000 });
      clientRef.current = client;

      // Capture initialize trace before listing calls overwrite lastFetchRef
      const initLf = { ...lastFetchRef.current };

      const caps = client.getServerCapabilities() ?? null;
      setCapabilities(caps);

      // Fetch initial data and capture traces for each listing call
      const listEntries: HistoryEntry[] = [];
      const fetches: Promise<void>[] = [];

      if (caps?.resources) {
        fetches.push((async () => {
          const start = Date.now();
          try {
            const r = await client.request({ method: 'resources/list', params: {} }, ListResourcesResultSchema, { timeout: 120000 });
            setResources((r.resources ?? []) as McpResource[]);
            const latencyMs = Date.now() - start;
            const lf = lastFetchRef.current;
            const trace = await buildEntryTrace(lf.reqUrl, lf.reqMethod, lf.reqHeaders, lf.reqBody, lf.respHeaders, lf.statusCode, latencyMs, lf.respBody ?? r);
            listEntries.push({ id: crypto.randomUUID(), method: 'resources/list', latencyMs, timestamp: new Date(), trace });
          } catch (e) { console.warn('Failed to list resources:', e); }
        })());
      }

      if (caps?.prompts) {
        fetches.push((async () => {
          const start = Date.now();
          try {
            const r = await client.request({ method: 'prompts/list', params: {} }, ListPromptsResultSchema, { timeout: 120000 });
            setPrompts((r.prompts ?? []) as McpPrompt[]);
            const latencyMs = Date.now() - start;
            const lf = lastFetchRef.current;
            const trace = await buildEntryTrace(lf.reqUrl, lf.reqMethod, lf.reqHeaders, lf.reqBody, lf.respHeaders, lf.statusCode, latencyMs, lf.respBody ?? r);
            listEntries.push({ id: crypto.randomUUID(), method: 'prompts/list', latencyMs, timestamp: new Date(), trace });
          } catch (e) { console.warn('Failed to list prompts:', e); }
        })());
      }

      if (caps?.tools) {
        fetches.push((async () => {
          const start = Date.now();
          try {
            const r = await client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema, { timeout: 120000 });
            setTools((r.tools ?? []) as McpTool[]);
            const latencyMs = Date.now() - start;
            const lf = lastFetchRef.current;
            const trace = await buildEntryTrace(lf.reqUrl, lf.reqMethod, lf.reqHeaders, lf.reqBody, lf.respHeaders, lf.statusCode, latencyMs, lf.respBody ?? r);
            listEntries.push({ id: crypto.randomUUID(), method: 'tools/list', latencyMs, timestamp: new Date(), trace });
          } catch (e) { console.warn('Failed to list tools:', e); }
        })());
      }

      await Promise.all(fetches);

      // Determine best default tab
      if (caps?.tools) setActiveTab('tools');
      else if (caps?.resources) setActiveTab('resources');
      else if (caps?.prompts) setActiveTab('prompts');

      setStatus('connected');

      // Build initialize trace from captured data
      const connectTrace = await buildEntryTrace(
        initLf.reqUrl, initLf.reqMethod, initLf.reqHeaders, initLf.reqBody,
        initLf.respHeaders, initLf.statusCode, 0, initLf.respBody,
      );

      // Add initialize + listing entries to history (newest first)
      const newEntries: HistoryEntry[] = [
        ...listEntries.reverse(),
        { id: crypto.randomUUID(), method: 'initialize', latencyMs: 0, timestamp: new Date(), trace: connectTrace },
      ];
      setHistory((prev) => [...newEntries, ...prev]);
    } catch (err) {
      console.error('MCP connection failed:', err);
      setStatus('error');
    }
  }, [selectedServer, selectedSub, config.apimService, getTracingHeaders, buildEntryTrace]);

  /* --- Disconnect ------------------------------------------------- */
  const disconnect = useCallback(async () => {
    try {
      if (transportRef.current) {
        await transportRef.current.terminateSession();
      }
      if (clientRef.current) {
        await clientRef.current.close();
      }
    } catch { /* ignore */ }
    clientRef.current = null;
    transportRef.current = null;
    setStatus('disconnected');
    setCapabilities(null);
    setResources([]);
    setPrompts([]);
    setTools([]);
  }, []);

  /* --- Cleanup on unmount ---------------------------------------- */
  useEffect(() => {
    return () => {
      if (clientRef.current) {
        void clientRef.current.close().catch(() => { /* ignore */ });
      }
    };
  }, []);

  /* --- Execute tool ---------------------------------------------- */
  const executeTool = useCallback(async (toolName: string, argsJson: string) => {
    if (!clientRef.current) return;
    setExecuting(toolName);
    const startTime = Date.now();
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = argsJson.trim() ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
    } catch {
      setHistory((prev) => [{
        id: crypto.randomUUID(),
        method: 'tools/call',
        toolName,
        args: argsJson,
        error: 'Invalid JSON arguments',
        latencyMs: 0,
        timestamp: new Date(),
      }, ...prev]);
      setExecuting(null);
      return;
    }

    try {
      const result = await clientRef.current.request(
        { method: 'tools/call', params: { name: toolName, arguments: parsedArgs } },
        CallToolResultSchema,
      );
      const latencyMs = Date.now() - startTime;
      const resultText = JSON.stringify(result, null, 2);
      const lf = lastFetchRef.current;
      const trace = await buildEntryTrace(lf.reqUrl, lf.reqMethod, lf.reqHeaders, lf.reqBody, lf.respHeaders, lf.statusCode, latencyMs, lf.respBody ?? result);

      setHistory((prev) => [{
        id: crypto.randomUUID(),
        method: 'tools/call',
        toolName,
        args: argsJson,
        result: resultText,
        latencyMs,
        timestamp: new Date(),
        trace,
      }, ...prev]);
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const lf = lastFetchRef.current;
      const trace = await buildEntryTrace(lf.reqUrl, lf.reqMethod, lf.reqHeaders, lf.reqBody, lf.respHeaders, lf.statusCode, latencyMs, lf.respBody);
      setHistory((prev) => [{
        id: crypto.randomUUID(),
        method: 'tools/call',
        toolName,
        args: argsJson,
        error: err instanceof Error ? err.message : String(err),
        latencyMs,
        timestamp: new Date(),
        trace,
      }, ...prev]);
    } finally {
      setExecuting(null);
    }
  }, [buildEntryTrace]);

  /* --- Read resource --------------------------------------------- */
  const readResource = useCallback(async (uri: string) => {
    if (!clientRef.current) return;
    setExecuting(uri);
    const startTime = Date.now();
    try {
      const result = await clientRef.current.request(
        { method: 'resources/read', params: { uri } },
        ReadResourceResultSchema,
      );
      const latencyMs = Date.now() - startTime;
      const content = (result.contents ?? []).map((c: { text?: string; uri?: string }) => c.text ?? '').join('\n');
      setResourceContent({ uri, content });
      const lf = lastFetchRef.current;
      const trace = await buildEntryTrace(lf.reqUrl, lf.reqMethod, lf.reqHeaders, lf.reqBody, lf.respHeaders, lf.statusCode, latencyMs, lf.respBody ?? result);
      setHistory((prev) => [{
        id: crypto.randomUUID(),
        method: 'resources/read',
        toolName: uri,
        result: content,
        latencyMs,
        timestamp: new Date(),
        trace,
      }, ...prev]);
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const lf = lastFetchRef.current;
      const trace = await buildEntryTrace(lf.reqUrl, lf.reqMethod, lf.reqHeaders, lf.reqBody, lf.respHeaders, lf.statusCode, latencyMs, lf.respBody);
      setHistory((prev) => [{
        id: crypto.randomUUID(),
        method: 'resources/read',
        toolName: uri,
        error: err instanceof Error ? err.message : String(err),
        latencyMs,
        timestamp: new Date(),
        trace,
      }, ...prev]);
    } finally {
      setExecuting(null);
    }
  }, [buildEntryTrace]);

  /* --- Get prompt ------------------------------------------------ */
  const getPrompt = useCallback(async (name: string, args: Record<string, string>) => {
    if (!clientRef.current) return;
    setExecuting(name);
    const startTime = Date.now();
    try {
      const result = await clientRef.current.request(
        { method: 'prompts/get', params: { name, arguments: args } },
        GetPromptResultSchema,
      );
      const latencyMs = Date.now() - startTime;
      setPromptResult({ name, messages: result.messages ?? [] });
      const lf = lastFetchRef.current;
      const trace = await buildEntryTrace(lf.reqUrl, lf.reqMethod, lf.reqHeaders, lf.reqBody, lf.respHeaders, lf.statusCode, latencyMs, lf.respBody ?? result);
      setHistory((prev) => [{
        id: crypto.randomUUID(),
        method: 'prompts/get',
        toolName: name,
        args: JSON.stringify(args),
        result: JSON.stringify(result.messages, null, 2),
        latencyMs,
        timestamp: new Date(),
        trace,
      }, ...prev]);
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const lf = lastFetchRef.current;
      const trace = await buildEntryTrace(lf.reqUrl, lf.reqMethod, lf.reqHeaders, lf.reqBody, lf.respHeaders, lf.statusCode, latencyMs, lf.respBody);
      setHistory((prev) => [{
        id: crypto.randomUUID(),
        method: 'prompts/get',
        toolName: name,
        args: JSON.stringify(args),
        error: err instanceof Error ? err.message : String(err),
        latencyMs,
        timestamp: new Date(),
        trace,
      }, ...prev]);
    } finally {
      setExecuting(null);
    }
  }, [buildEntryTrace]);

  /* --- Render ---------------------------------------------------- */
  const isConnected = status === 'connected';
  const navigate = useNavigate();

  return (
    <div className="pg-outer">
      {/* Tab bar */}
      <div className="pg-tabs">
        <button className="pg-tab" onClick={() => { void navigate('/playground'); }}>
          <BrainCog size={14} /> Model
        </button>
        <button className="pg-tab active">
          <Plug size={14} /> MCP
        </button>
        <button className="pg-tab" onClick={() => { void navigate('/playground', { state: { tab: 'a2a' } }); }}>
          <Bot size={14} /> A2A
        </button>
      </div>

      <div className="mcp-pg-layout">
        {/* ── Left: Config Panel ── */}
        <div className="pg-config">
          <div className="pg-config-header">
            <Play size={16} />
            <span>MCP Playground</span>
          </div>

          <div className="pg-config-body">
            {noWorkspace ? (
              <div className="pg-config-empty">Select an APIM instance to get started.</div>
            ) : (
              <>
                {/* MCP Server selection */}
                <div className="pg-field">
                  <label className="pg-label">MCP Server</label>
                  <select
                    className="pg-select"
                    value={selectedServer?.name ?? ''}
                    disabled={isConnected}
                    onChange={(e) => {
                      const srv = mcpServers.find((s) => s.name === e.target.value) ?? null;
                      setSelectedServer(srv);
                      setSelectedSub(null);
                      setTracingEnabled(false);
                    }}
                  >
                    <option value="">Select an MCP server…</option>
                    {mcpServers.map((s) => (
                      <option key={s.name} value={s.name}>{s.displayName}</option>
                    ))}
                  </select>
                </div>

                {/* Subscription (mandatory if required) */}
                {selectedServer?.subscriptionRequired && (
                  <div className="pg-field">
                    <label className="pg-label">Subscription</label>
                    <select
                      className="pg-select"
                      value={selectedSub?.sid ?? ''}
                      disabled={isConnected}
                      onChange={(e) => {
                        const sub = subs.find((s) => s.sid === e.target.value) ?? null;
                        setSelectedSub(sub);
                        if (!sub?.allowTracing) setTracingEnabled(false);
                      }}
                    >
                      <option value="">Select a subscription…</option>
                      {subs.map((s) => (
                        <option key={s.sid} value={s.sid}>{s.displayName}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Tracing toggle */}
                {selectedSub && (
                  <label className="pg-toggle">
                    <span>Tracing</span>
                    <button
                      className={`pg-toggle-switch${tracingEnabled ? ' on' : ''}${!selectedSub.allowTracing ? ' disabled' : ''}`}
                      onClick={() => {
                        if (selectedSub.allowTracing) setTracingEnabled(!tracingEnabled);
                      }}
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

                {/* Connect / Disconnect */}
                <div className="mcp-pg-connect-actions">
                  {status === 'disconnected' || status === 'error' ? (
                    <button
                      className="mcp-pg-connect-btn"
                      disabled={!selectedServer || (selectedServer.subscriptionRequired ? selectedSub == null : false)}
                      onClick={() => void connect()}
                    >
                      <PlugZap size={14} /> Connect
                    </button>
                  ) : status === 'connecting' ? (
                    <button className="mcp-pg-connect-btn" disabled>
                      <Loader2 size={14} className="spin" /> Connecting…
                    </button>
                  ) : (
                    <>
                      <button className="mcp-pg-connect-btn mcp-pg-reconnect-btn" onClick={() => void connect()}>
                        <RefreshCw size={14} /> Reconnect
                      </button>
                      <button className="mcp-pg-disconnect-btn" onClick={() => void disconnect()}>
                        <Unplug size={14} /> Disconnect
                      </button>
                    </>
                  )}
                </div>

                {status === 'error' && (
                  <div className="mcp-pg-error">Connection failed. Check server and subscription settings.</div>
                )}

                {/* Connection info */}
                {isConnected && capabilities && (
                  <div className="mcp-pg-caps">
                    <div className="pg-label">Server capabilities</div>
                    <div className="mcp-pg-cap-badges">
                      {capabilities.resources && <span className="mcp-pg-cap-badge">Resources</span>}
                      {capabilities.prompts && <span className="mcp-pg-cap-badge">Prompts</span>}
                      {capabilities.tools && <span className="mcp-pg-cap-badge">Tools</span>}
                      {capabilities.logging && <span className="mcp-pg-cap-badge">Logging</span>}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* ── Right: Content area ── */}
        <div className="mcp-pg-content">
          {!isConnected ? (
            <div className="pg-coming-soon">
              <Plug className="page-empty-icon" />
              <div className="page-empty-title">
                {status === 'connecting' ? 'Connecting…' : 'MCP Playground'}
              </div>
              <p className="page-empty-text">
                {status === 'connecting'
                  ? 'Establishing connection to the MCP server…'
                  : 'Select an MCP server and connect to start exploring resources, prompts, and tools.'
                }
              </p>
              {status === 'connecting' && <Loader2 className="spin" size={24} />}
            </div>
          ) : (
            <div className="mcp-pg-connected">
              {/* Tabs */}
              <div className="mcp-pg-tabs">
                {capabilities?.resources && (
                  <button
                    className={`mcp-pg-tab${activeTab === 'resources' ? ' active' : ''}`}
                    onClick={() => setActiveTab('resources')}
                  >
                    <FolderOpen size={14} /> Resources ({resources.length})
                  </button>
                )}
                {capabilities?.prompts && (
                  <button
                    className={`mcp-pg-tab${activeTab === 'prompts' ? ' active' : ''}`}
                    onClick={() => setActiveTab('prompts')}
                  >
                    <MessageSquare size={14} /> Prompts ({prompts.length})
                  </button>
                )}
                {capabilities?.tools && (
                  <button
                    className={`mcp-pg-tab${activeTab === 'tools' ? ' active' : ''}`}
                    onClick={() => setActiveTab('tools')}
                  >
                    <Wrench size={14} /> Tools ({tools.length})
                  </button>
                )}
              </div>

              <div className="mcp-pg-tab-content">
                {/* ── Resources tab ── */}
                {activeTab === 'resources' && (
                  <div className="mcp-pg-list">
                    {resources.length === 0 ? (
                      <div className="mcp-pg-empty">No resources available.</div>
                    ) : resources.map((r) => (
                      <div key={r.uri} className="mcp-pg-item">
                        <div className="mcp-pg-item-header">
                          <div className="mcp-pg-item-info">
                            <span className="mcp-pg-item-name">{r.name}</span>
                            <span className="mcp-pg-item-meta">{r.uri}</span>
                          </div>
                          <button
                            className="mcp-pg-run-btn"
                            disabled={executing === r.uri}
                            onClick={() => void readResource(r.uri)}
                          >
                            {executing === r.uri ? <Loader2 size={12} className="spin" /> : <Play size={12} />}
                            Read
                          </button>
                        </div>
                        {r.description && <div className="mcp-pg-item-desc">{r.description}</div>}
                        {resourceContent?.uri === r.uri && (
                          <div className="mcp-pg-result">
                            <div className="mcp-pg-result-header">
                              <span>Content</span>
                              <button className="mcp-pg-result-close" onClick={() => setResourceContent(null)}><X size={12} /></button>
                            </div>
                            <pre className="mcp-pg-result-body">{resourceContent.content}</pre>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* ── Prompts tab ── */}
                {activeTab === 'prompts' && (
                  <div className="mcp-pg-list">
                    {prompts.length === 0 ? (
                      <div className="mcp-pg-empty">No prompts available.</div>
                    ) : prompts.map((p) => (
                      <div key={p.name} className="mcp-pg-item">
                        <div className="mcp-pg-item-header" onClick={() => setExpandedPrompt(expandedPrompt === p.name ? null : p.name)} style={{ cursor: 'pointer' }}>
                          <div className="mcp-pg-item-info">
                            <span className="mcp-pg-item-name">{p.name}</span>
                            {p.arguments && p.arguments.length > 0 && (
                              <span className="mcp-pg-item-meta">{p.arguments.length} argument{p.arguments.length !== 1 ? 's' : ''}</span>
                            )}
                          </div>
                          <ChevronDown size={14} className={`mcp-pg-chevron${expandedPrompt === p.name ? ' open' : ''}`} />
                        </div>
                        {p.description && <div className="mcp-pg-item-desc">{p.description}</div>}
                        {expandedPrompt === p.name && (
                          <div className="mcp-pg-tool-form">
                            {p.arguments?.map((a) => (
                              <div key={a.name} className="mcp-pg-tool-field">
                                <label className="mcp-pg-tool-label">
                                  {a.name}{a.required && <span className="mcp-pg-required">*</span>}
                                </label>
                                {a.description && <span className="mcp-pg-tool-hint">{a.description}</span>}
                                <input
                                  className="pg-input"
                                  type="text"
                                  value={promptArgs[`${p.name}.${a.name}`] ?? ''}
                                  onChange={(e) => setPromptArgs((prev) => ({ ...prev, [`${p.name}.${a.name}`]: e.target.value }))}
                                  placeholder={a.description ?? a.name}
                                />
                              </div>
                            ))}
                            <button
                              className="mcp-pg-run-btn"
                              disabled={executing === p.name}
                              onClick={() => {
                                const args: Record<string, string> = {};
                                p.arguments?.forEach((a) => {
                                  const val = promptArgs[`${p.name}.${a.name}`];
                                  if (val) args[a.name] = val;
                                });
                                void getPrompt(p.name, args);
                              }}
                            >
                              {executing === p.name ? <Loader2 size={12} className="spin" /> : <Play size={12} />}
                              Get prompt
                            </button>
                            {promptResult?.name === p.name && (
                              <div className="mcp-pg-result">
                                <div className="mcp-pg-result-header">
                                  <span>Messages</span>
                                  <button className="mcp-pg-result-close" onClick={() => setPromptResult(null)}><X size={12} /></button>
                                </div>
                                <pre className="mcp-pg-result-body">{JSON.stringify(promptResult.messages, null, 2)}</pre>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* ── Tools tab ── */}
                {activeTab === 'tools' && (
                  <div className="mcp-pg-list">
                    {tools.length === 0 ? (
                      <div className="mcp-pg-empty">No tools available.</div>
                    ) : tools.map((t) => (
                      <div key={t.name} className="mcp-pg-item">
                        <div
                          className="mcp-pg-item-header"
                          onClick={() => setExpandedTool(expandedTool === t.name ? null : t.name)}
                          style={{ cursor: 'pointer' }}
                        >
                          <div className="mcp-pg-item-info">
                            <span className="mcp-pg-item-name">{t.name}</span>
                            {t.inputSchema?.properties != null && (
                              <span className="mcp-pg-item-meta">
                                {Object.keys(t.inputSchema.properties as Record<string, unknown>).length} param{Object.keys(t.inputSchema.properties as Record<string, unknown>).length !== 1 ? 's' : ''}
                              </span>
                            )}
                          </div>
                          <ChevronDown size={14} className={`mcp-pg-chevron${expandedTool === t.name ? ' open' : ''}`} />
                        </div>
                        {t.description && <div className="mcp-pg-item-desc">{t.description}</div>}
                        {expandedTool === t.name && (
                          <div className="mcp-pg-tool-form">
                            <label className="mcp-pg-tool-label">Arguments (JSON)</label>
                            <textarea
                              className="pg-textarea"
                              rows={4}
                              value={toolArgs[t.name] ?? (t.inputSchema?.properties ? JSON.stringify(
                                Object.fromEntries(
                                  Object.keys(t.inputSchema.properties as Record<string, unknown>).map((k) => [k, ''])
                                ), null, 2) : '{}')}
                              onChange={(e) => setToolArgs((prev) => ({ ...prev, [t.name]: e.target.value }))}
                              placeholder='{ "key": "value" }'
                            />
                            <button
                              className="mcp-pg-run-btn"
                              disabled={!!executing}
                              onClick={() => void executeTool(t.name, toolArgs[t.name] ?? '{}')}
                            >
                              {executing === t.name ? <Loader2 size={12} className="spin" /> : <Play size={12} />}
                              Execute
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── History panel ── */}
              {history.length > 0 && (
                <div className="mcp-pg-history">
                  <div className="mcp-pg-history-header">
                    <span>Execution History</span>
                    <button className="mcp-pg-history-clear" onClick={() => setHistory([])} title="Clear history">
                      <X size={12} /> Clear
                    </button>
                  </div>
                  <div className="mcp-pg-history-list">
                    {[...history].reverse().map((h, idx) => (
                      <div key={h.id} className={`mcp-pg-history-item${h.error ? ' error' : ''}`}>
                        <div className="mcp-pg-history-item-header" onClick={() => setExpandedHistory(expandedHistory === h.id ? null : h.id)} style={{ cursor: 'pointer' }}>
                          <div className="mcp-pg-history-info">
                            <span className="mcp-pg-history-method">{idx + 1}. {h.method}</span>
                            {h.toolName && <span className="mcp-pg-history-tool">{h.toolName}</span>}
                            <span className="mcp-pg-history-latency">{h.latencyMs}ms</span>
                          </div>
                          <div className="mcp-pg-history-actions">
                            {h.trace && (
                              <button
                                className="mcp-pg-trace-btn"
                                onClick={(e) => { e.stopPropagation(); setShowTraceId(h.id); }}
                                title="View AI Gateway trace"
                              >
                                <Bug size={14} />
                              </button>
                            )}
                            <ChevronDown size={14} className={`mcp-pg-chevron${expandedHistory === h.id ? ' open' : ''}`} />
                          </div>
                        </div>
                        {expandedHistory === h.id && (
                          <div className="mcp-pg-history-detail">
                            {h.args && (
                              <div className="mcp-pg-history-section">
                                <div className="mcp-pg-history-section-label">Arguments</div>
                                <pre className="mcp-pg-result-body">{h.args}</pre>
                              </div>
                            )}
                            {h.result && (
                              <div className="mcp-pg-history-section">
                                <div className="mcp-pg-history-section-label">
                                  Result <CopyBtn text={h.result} />
                                </div>
                                <pre className="mcp-pg-result-body">{h.result}</pre>
                              </div>
                            )}
                            {h.error && (
                              <div className="mcp-pg-history-section error">
                                <div className="mcp-pg-history-section-label">Error</div>
                                <pre className="mcp-pg-result-body mcp-pg-error-text">{h.error}</pre>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Trace modal */}
      {showTraceId && (() => {
        const clickedEntry = history.find((h) => h.id === showTraceId);
        if (!clickedEntry?.trace) return null;
        const allTraces: TraceEntry[] = history
          .filter((h) => h.trace)
          .reverse()
          .map((h) => ({
            id: h.id,
            label: h.toolName ? `${h.method} → ${h.toolName}` : h.method,
            role: 'user' as const,
            trace: h.trace!,
            latencyMs: h.latencyMs,
          }));
        return (
          <TraceModal
            trace={clickedEntry.trace}
            allTraces={allTraces}
            initialTraceId={showTraceId}
            onClose={() => setShowTraceId(null)}
          />
        );
      })()}
    </div>
  );
}
