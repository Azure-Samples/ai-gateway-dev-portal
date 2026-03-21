import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Play, Send, Square, Trash2, Copy, Check, Bug, Code,
  ChevronDown, ChevronUp, Bot, User, Loader2, Server, ArrowLeftRight,
} from 'lucide-react';
import { useAzure, type WorkspaceData } from '../context/AzureContext';
import { useLocation } from 'react-router-dom';
import TraceModal, { type TraceData, type TraceSection } from '../components/TraceModal';
import CodeModal from '../components/CodeModal';
import { listDebugCredentials, listGatewayTrace } from '../services/azure';
import type { InferenceApi, ApimSubscription, McpServer } from '../types';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type ApiType = 'completions' | 'responses';
type SdkType = 'openai' | 'langchain' | 'agentframework';

interface TokenUsage {
  total: number;
  prompt: number;
  completion: number;
  cached: number;
}

interface CodeInfo {
  url: string;
  body: unknown;
  apiType: ApiType;
  sdkType: SdkType;
  apiVersion: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string;
  latencyMs?: number;
  tokens?: TokenUsage;
  trace?: TraceData;
  codeInfo?: CodeInfo;
  isStreaming?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function Playground() {
  const { workspaceData, config, getCredential }: { workspaceData: WorkspaceData; getCredential: ReturnType<typeof useAzure>['getCredential']; config: { apimService: { gatewayUrl: string; subscriptionId: string; resourceGroup: string; name: string } | null; apimWorkspace: unknown } } = useAzure();
  const location = useLocation();

  const [playgroundTab, setPlaygroundTab] = useState<'model' | 'mcp' | 'a2a'>('model');

  /* --- Configuration state ---------------------------------------- */
  const [selectedApi, setSelectedApi] = useState<InferenceApi | null>(null);
  const [model, setModel] = useState('');
  const [selectedSub, setSelectedSub] = useState<ApimSubscription | null>(null);
  const [systemPrompt, setSystemPrompt] = useState('You are an AI assistant that helps people find information.');
  const [selectedMcpServers, setSelectedMcpServers] = useState<McpServer[]>([]);
  const [streaming, setStreaming] = useState(true);
  const [tracing, setTracing] = useState(false);
  const [apiType, setApiType] = useState<ApiType>('completions');
  const [sdkType, setSdkType] = useState<SdkType>('openai');
  const [apiVersion, setApiVersion] = useState('2025-03-01-preview');

  /* --- Chat state ------------------------------------------------- */
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedTokens, setExpandedTokens] = useState<string | null>(null);
  const [showTrace, setShowTrace] = useState<TraceData | null>(null);
  const [showCode, setShowCode] = useState<CodeInfo | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /* --- Derived ---------------------------------------------------- */
  const inferenceApis = workspaceData.inferenceApis;
  const subs = workspaceData.subscriptions.filter((s) => s.state === 'active');
  const mcpServers = workspaceData.mcpServers;

  /* --- Pre-select API/subscription from navigation state ---------- */
  useEffect(() => {
    const state = location.state as { inferenceApi?: InferenceApi; subscription?: ApimSubscription } | null;
    if (state?.inferenceApi) {
      setSelectedApi(state.inferenceApi);
      setPlaygroundTab('model');
    }
    if (state?.subscription) {
      setSelectedSub(state.subscription);
      setPlaygroundTab('model');
    }
    if (state?.inferenceApi || state?.subscription) {
      // Clear the state so refreshing doesn't re-apply
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

  /* --- Build request URL ------------------------------------------ */
  const buildUrl = useCallback(() => {
    if (!config.apimService || !selectedApi) return '';
    const path = selectedApi.path.replace(/^\//, '');
    const deployment = encodeURIComponent(model);
    const suffix = apiType === 'completions'
      ? `/${path}/deployments/${deployment}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`
      : `/${path}/deployments/${deployment}/responses?api-version=${encodeURIComponent(apiVersion)}`;

    // In dev, route through Vite proxy to avoid CORS; in prod, call the gateway directly
    if (import.meta.env.DEV) {
      return `/gateway-proxy${suffix}`;
    }
    const base = config.apimService.gatewayUrl.replace(/\/$/, '');
    return `${base}${suffix}`;
  }, [config.apimService, selectedApi, apiType, apiVersion, model]);

  /* --- Build request body ----------------------------------------- */
  const buildBody = useCallback((userMsg: string) => {
    if (apiType === 'completions') {
      const chatMsgs = [
        { role: 'system' as const, content: systemPrompt },
        ...messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
        { role: 'user' as const, content: userMsg },
      ];

      const body: Record<string, unknown> = {
        model,
        messages: chatMsgs,
        stream: streaming,
      };

      if (selectedMcpServers.length > 0) {
        body.tools = selectedMcpServers.map((s) => ({
          type: 'function',
          function: { name: s.name, description: s.displayName },
        }));
      }

      return body;
    }

    // Responses API
    const inputItems = [
      ...messages.filter((m) => m.role !== 'system').map((m) => ({
        type: 'message',
        role: m.role,
        content: m.content,
      })),
      { type: 'message', role: 'user', content: userMsg },
    ];

    const body: Record<string, unknown> = {
      model,
      instructions: systemPrompt,
      input: inputItems,
      stream: streaming,
    };

    if (selectedMcpServers.length > 0) {
      body.tools = selectedMcpServers.map((s) => ({
        type: 'mcp',
        server_label: s.name,
        server_url: s.path,
      }));
    }

    return body;
  }, [apiType, messages, model, systemPrompt, streaming, selectedMcpServers]);

  /* --- Parse SSE stream ------------------------------------------- */
  const parseStream = useCallback(async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    assistantId: string,
    startTime: number,
    respHeaders: Record<string, string>,
    requestInfo: { url: string; method: string; headers: Record<string, string>; body: unknown },
    fetchTraceFn?: () => Promise<unknown>,
  ) => {
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let usedModel = '';
    let usage: TokenUsage | undefined;

    const updateMessage = (content: string, done: boolean, extra?: Partial<ChatMessage>) => {
      setMessages((prev) => prev.map((m) =>
        m.id === assistantId
          ? { ...m, content, isStreaming: !done, ...extra }
          : m,
      ));
    };

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;

          // Completions API stream
          if (apiType === 'completions') {
            if (parsed.model) usedModel = parsed.model as string;
            const choices = parsed.choices as { delta?: { content?: string }; finish_reason?: string }[] | undefined;
            if (choices?.[0]?.delta?.content) {
              fullContent += choices[0].delta.content;
              updateMessage(fullContent, false);
            }
            if (parsed.usage) {
              const u = parsed.usage as { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
              usage = {
                total: u.total_tokens ?? 0,
                prompt: u.prompt_tokens ?? 0,
                completion: u.completion_tokens ?? 0,
                cached: u.prompt_tokens_details?.cached_tokens ?? 0,
              };
            }
          } else {
            // Responses API stream
            if (parsed.type === 'response.output_text.delta') {
              fullContent += (parsed.delta as string) ?? '';
              updateMessage(fullContent, false);
            }
            if (parsed.type === 'response.completed') {
              const resp = parsed.response as { model?: string; usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number } } | undefined;
              if (resp?.model) usedModel = resp.model;
              if (resp?.usage) {
                usage = {
                  total: resp.usage.total_tokens ?? 0,
                  prompt: resp.usage.input_tokens ?? 0,
                  completion: resp.usage.output_tokens ?? 0,
                  cached: 0,
                };
              }
            }
          }
        } catch { /* skip invalid JSON */ }
      }
    }

    const latencyMs = Date.now() - startTime;

    // Always build trace data (tracing sections are populated only when tracing is enabled)
    const trace = await buildTraceData(requestInfo, respHeaders, {
      statusCode: 200,
      elapsedMs: latencyMs,
      body: fullContent,
    }, fetchTraceFn);

    updateMessage(fullContent || '(empty response)', true, {
      model: usedModel || model,
      latencyMs,
      tokens: usage,
      trace,
    });
  }, [apiType, model, tracing]);

  /* --- Send message ----------------------------------------------- */
  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !selectedApi || !selectedSub || isRunning) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
    };

    const assistantId = crypto.randomUUID();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      isStreaming: true,
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput('');
    setIsRunning(true);

    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }

    const url = buildUrl();
    const body = buildBody(text);
    const codeInfo: CodeInfo = { url, body, apiType, sdkType, apiVersion };
    const subKeyHeader = selectedApi.subscriptionKeyHeaderName ?? 'Ocp-Apim-Subscription-Key';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [subKeyHeader]: selectedSub.primaryKey,
    };
    if (import.meta.env.DEV && config.apimService) {
      headers['X-Gateway-Base'] = config.apimService.gatewayUrl.replace(/\/$/, '');
    }
    if (tracing && selectedSub.allowTracing && config.apimService && selectedApi) {
      try {
        const debugToken = await listDebugCredentials(
          getCredential(),
          config.apimService.subscriptionId,
          config.apimService.resourceGroup,
          config.apimService.name,
          selectedApi.id,
        );
        if (debugToken) {
          headers['Apim-Debug-Authorization'] = debugToken;
          headers['Ocp-Apim-Trace'] = 'true';
        }
      } catch (err) {
        console.warn('[trace] Failed to get debug credentials:', err);
      }
    }

    const controller = new AbortController();
    abortRef.current = controller;
    const startTime = Date.now();

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => { respHeaders[k] = v; });

      const requestInfo = { url, method: 'POST', headers: { ...headers, [subKeyHeader]: '***' }, body };

      // Build trace fetcher if tracing is active and we got a trace ID
      const apimTraceId = respHeaders['apim-trace-id'];
      const fetchTraceFn = (tracing && apimTraceId && config.apimService)
        ? () => listGatewayTrace(
            getCredential(),
            config.apimService!.subscriptionId,
            config.apimService!.resourceGroup,
            config.apimService!.name,
            apimTraceId,
          )
        : undefined;

      if (!resp.ok) {
        const errText = await resp.text();
        const latencyMs = Date.now() - startTime;
        const trace = await buildTraceData(requestInfo, respHeaders, {
          statusCode: resp.status,
          elapsedMs: latencyMs,
          body: errText,
        }, fetchTraceFn);
        setMessages((prev) => prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: `Error ${resp.status}: ${errText}`, isStreaming: false, latencyMs, trace, codeInfo, model: model || undefined }
            : m,
        ));
        return;
      }

      if (streaming && resp.body) {
        await parseStream(resp.body.getReader(), assistantId, startTime, respHeaders, requestInfo, fetchTraceFn);
        // Attach codeInfo after stream completes
        setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, codeInfo } : m));
      } else {
        const rawText = await resp.text();
        const json = JSON.parse(rawText) as Record<string, unknown>;
        const latencyMs = Date.now() - startTime;

        let content = '';
        let usedModel = model;
        let usage: TokenUsage | undefined;

        if (apiType === 'completions') {
          const choices = json.choices as { message?: { content?: string } }[] | undefined;
          content = choices?.[0]?.message?.content ?? '';
          if (json.model) usedModel = json.model as string;
          if (json.usage) {
            const u = json.usage as { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
            usage = { total: u.total_tokens ?? 0, prompt: u.prompt_tokens ?? 0, completion: u.completion_tokens ?? 0, cached: u.prompt_tokens_details?.cached_tokens ?? 0 };
          }
        } else {
          const output = json.output as { type?: string; content?: { type?: string; text?: string }[] }[] | undefined;
          content = output?.find((o) => o.type === 'message')?.content?.find((c) => c.type === 'output_text')?.text ?? JSON.stringify(json);
          if (json.model) usedModel = json.model as string;
          if (json.usage) {
            const u = json.usage as { total_tokens?: number; input_tokens?: number; output_tokens?: number };
            usage = { total: u.total_tokens ?? 0, prompt: u.input_tokens ?? 0, completion: u.output_tokens ?? 0, cached: 0 };
          }
        }

        const trace = await buildTraceData(requestInfo, respHeaders, {
          statusCode: resp.status,
          elapsedMs: latencyMs,
          body: rawText,
        }, fetchTraceFn);

        setMessages((prev) => prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: content || '(empty response)', isStreaming: false, model: usedModel, latencyMs, tokens: usage, trace, codeInfo }
            : m,
        ));
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setMessages((prev) => prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: `Error: ${(err as Error).message}`, isStreaming: false }
            : m,
        ));
      }
    } finally {
      setIsRunning(false);
      abortRef.current = null;
    }
  }, [input, selectedApi, selectedSub, isRunning, buildUrl, buildBody, streaming, tracing, model, apiType, sdkType, apiVersion, config, getCredential, parseStream]);

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
  }, []);

  /* --- Toggle MCP server ------------------------------------------ */
  const toggleMcpServer = useCallback((server: McpServer) => {
    setSelectedMcpServers((prev) => {
      const exists = prev.find((s) => s.name === server.name);
      if (exists) return prev.filter((s) => s.name !== server.name);
      return [...prev, server];
    });
  }, []);

  /* --- Key handlers ----------------------------------------------- */
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }, [handleSend]);

  /* --- MCP dropdown ----------------------------------------------- */
  const [mcpOpen, setMcpOpen] = useState(false);
  const mcpRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (mcpRef.current && !mcpRef.current.contains(e.target as Node)) setMcpOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  /* ================================================================ */
  /*  Render                                                           */
  /* ================================================================ */

  const noWorkspace = !config.apimService;
  const canSend = !!selectedApi && !!selectedSub && input.trim().length > 0 && !isRunning;

  return (
    <div className="pg-outer">
      {/* Tab bar */}
      <div className="pg-tabs">
        <button className={`pg-tab${playgroundTab === 'model' ? ' active' : ''}`} onClick={() => setPlaygroundTab('model')}>
          <Play size={14} /> Model
        </button>
        <button className={`pg-tab${playgroundTab === 'mcp' ? ' active' : ''}`} onClick={() => setPlaygroundTab('mcp')}>
          <Server size={14} /> MCP
        </button>
        <button className={`pg-tab${playgroundTab === 'a2a' ? ' active' : ''}`} onClick={() => setPlaygroundTab('a2a')}>
          <ArrowLeftRight size={14} /> A2A
        </button>
      </div>

      {playgroundTab === 'mcp' && (
        <div className="pg-coming-soon">
          <Server className="page-empty-icon" />
          <div className="page-empty-title">MCP Playground</div>
          <p className="page-empty-text">Coming soon — interact with MCP servers directly from the playground.</p>
        </div>
      )}

      {playgroundTab === 'a2a' && (
        <div className="pg-coming-soon">
          <ArrowLeftRight className="page-empty-icon" />
          <div className="page-empty-title">A2A Playground</div>
          <p className="page-empty-text">Coming soon — test agent-to-agent communications from the playground.</p>
        </div>
      )}

    {playgroundTab === 'model' && (
    <div className="pg-layout">
      {/* ---- Left: Configuration Panel ---- */}
      <div className="pg-config">
        <div className="pg-config-header">
          <Play size={16} />
          <span>Model playground</span>
        </div>

        <div className="pg-config-body">
          {noWorkspace ? (
            <div className="pg-config-empty">Select an APIM instance to get started.</div>
          ) : (
            <>
              {/* API Type + SDK */}
              <div className="pg-field-row">
                <div className="pg-field" style={{ flex: 1 }}>
                  <label className="pg-label">API Type</label>
                  <select className="pg-select" value={apiType} onChange={(e) => {
                    const t = e.target.value as ApiType;
                    setApiType(t);
                    setApiVersion(t === 'completions' ? '2025-03-01-preview' : '2025-03-01');
                  }}>
                    <option value="completions">Completions API</option>
                    <option value="responses">Responses API</option>
                  </select>
                </div>
                <div className="pg-field" style={{ flex: 1 }}>
                  <label className="pg-label">SDK</label>
                  <select className="pg-select" value={sdkType} onChange={(e) => setSdkType(e.target.value as SdkType)}>
                    <option value="openai">OpenAI SDK</option>
                    <option value="langchain">LangChain</option>
                    <option value="agentframework">Agent Framework</option>
                  </select>
                </div>
              </div>

              {/* Inference API */}
              <div className="pg-field">
                <label className="pg-label">Inference API</label>
                <select
                  className="pg-select"
                  value={selectedApi?.name ?? ''}
                  onChange={(e) => {
                    const api = inferenceApis.find((a) => a.name === e.target.value) ?? null;
                    setSelectedApi(api);
                  }}
                >
                  <option value="">Select an inference API…</option>
                  {inferenceApis.map((api) => (
                    <option key={api.name} value={api.name}>{api.displayName}</option>
                  ))}
                </select>
              </div>

              {/* Model */}
              <div className="pg-field">
                <label className="pg-label">Model</label>
                <input
                  className="pg-input"
                  type="text"
                  placeholder="e.g. gpt-4.1-mini"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              </div>

              {/* API Version */}
              <div className="pg-field">
                <label className="pg-label">API Version</label>
                <input
                  className="pg-input"
                  type="text"
                  placeholder="e.g. 2024-10-21"
                  value={apiVersion}
                  onChange={(e) => setApiVersion(e.target.value)}
                />
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
                    if (sub && !sub.allowTracing) setTracing(false);
                  }}
                >
                  <option value="">Select a subscription…</option>
                  {subs.map((s) => (
                    <option key={s.sid} value={s.sid}>{s.displayName}</option>
                  ))}
                </select>
              </div>

              {/* Tracing (visible when subscription selected) */}
              {selectedSub && (
                <label className="pg-toggle">
                  <span>Tracing</span>
                  <button
                    className={`pg-toggle-switch${tracing ? ' on' : ''}${!selectedSub.allowTracing ? ' disabled' : ''}`}
                    onClick={() => {
                      if (selectedSub.allowTracing) setTracing(!tracing);
                    }}
                    role="switch"
                    aria-checked={tracing}
                    title={!selectedSub.allowTracing ? 'Tracing not allowed on this subscription' : ''}
                  >
                    <span className="pg-toggle-thumb" />
                  </button>
                  {!selectedSub.allowTracing && (
                    <span className="pg-toggle-hint">Not allowed</span>
                  )}
                </label>
              )}

              {/* Instructions */}
              <div className="pg-field">
                <label className="pg-label">Instructions</label>
                <textarea
                  className="pg-textarea"
                  rows={3}
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="System prompt / instructions…"
                />
              </div>

              {/* MCP Servers (tools) */}
              {mcpServers.length > 0 && (
                <div className="pg-field" ref={mcpRef}>
                  <label className="pg-label">Tools (MCP Servers)</label>
                  <button className="pg-select pg-multi-btn" onClick={() => setMcpOpen(!mcpOpen)}>
                    <span>{selectedMcpServers.length === 0 ? 'None selected' : `${selectedMcpServers.length} selected`}</span>
                    <ChevronDown size={14} />
                  </button>
                  {mcpOpen && (
                    <div className="pg-multi-dropdown">
                      {mcpServers.map((s) => (
                        <label key={s.name} className="pg-multi-item">
                          <input
                            type="checkbox"
                            checked={selectedMcpServers.some((sel) => sel.name === s.name)}
                            onChange={() => toggleMcpServer(s)}
                          />
                          <span>{s.displayName}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Toggles */}
              <div className="pg-toggles">
                <label className="pg-toggle">
                  <span>Streaming</span>
                  <button className={`pg-toggle-switch${streaming ? ' on' : ''}`} onClick={() => setStreaming(!streaming)} role="switch" aria-checked={streaming}>
                    <span className="pg-toggle-thumb" />
                  </button>
                </label>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ---- Right: Chat Panel ---- */}
      <div className="pg-chat">
        {/* Chat header */}
        <div className="pg-chat-header">
          <div className="pg-chat-header-info">
            <span className="pg-chat-title">{selectedApi?.displayName ?? 'Chat'}</span>
            {model && <span className="pg-chat-model">{model}</span>}
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
              <p>Send a message to start the conversation</p>
            </div>
          ) : (
            messages.map((msg) => (
              <div key={msg.id} className={`pg-msg pg-msg-${msg.role}`}>
                <div className="pg-msg-avatar">
                  {msg.role === 'user' ? <User size={14} /> : <Bot size={14} />}
                </div>
                <div className="pg-msg-body">
                  <div className="pg-msg-content">
                    {msg.content || (msg.isStreaming ? <Loader2 size={16} className="pg-spinner" /> : null)}
                  </div>

                  {/* Message meta bar */}
                  {msg.role === 'assistant' && !msg.isStreaming && msg.content && (
                    <div className="pg-msg-meta">
                      {/* Model */}
                      {msg.model && <span className="pg-msg-meta-item pg-msg-model">{msg.model}</span>}

                      {/* Latency */}
                      {msg.latencyMs != null && <span className="pg-msg-meta-item">{msg.latencyMs}ms</span>}

                      {/* Tokens */}
                      {msg.tokens && (
                        <span className="pg-msg-meta-item pg-msg-tokens-wrap">
                          <button className="pg-msg-tokens-btn" onClick={() => setExpandedTokens(expandedTokens === msg.id ? null : msg.id)}>
                            {msg.tokens.total} tokens
                            {expandedTokens === msg.id ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                          </button>
                          {expandedTokens === msg.id && (
                            <div className="pg-msg-tokens-detail">
                              <div>Input: {msg.tokens.prompt}</div>
                              <div>Output: {msg.tokens.completion}</div>
                              {msg.tokens.cached > 0 && <div>Cached: {msg.tokens.cached}</div>}
                            </div>
                          )}
                        </span>
                      )}

                      {/* Code */}
                      {msg.codeInfo && (
                        <button className="pg-msg-meta-btn" onClick={() => setShowCode(msg.codeInfo!)} title="View source code">
                          <Code size={13} />
                        </button>
                      )}

                      {/* Trace / Debug */}
                      {msg.trace && (
                        <button className="pg-msg-meta-btn" onClick={() => setShowTrace(msg.trace!)} title="View request details">
                          <Bug size={13} />
                        </button>
                      )}

                      {/* Separator */}
                      <span className="pg-msg-meta-sep" />

                      {/* Copy */}
                      <button className="pg-msg-meta-btn" onClick={() => copyMessage(msg.id, msg.content)} title="Copy">
                        {copiedId === msg.id ? <Check size={13} /> : <Copy size={13} />}
                      </button>

                      {/* Delete */}
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
            placeholder={selectedApi ? 'Type a message… (Enter to send, Shift+Enter for new line)' : 'Select an inference API to get started'}
            value={input}
            onChange={(e) => { setInput(e.target.value); autoResize(); }}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={!selectedApi || !selectedSub}
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
      {showTrace && <TraceModal trace={showTrace} onClose={() => setShowTrace(null)} />}

      {/* ---- Code Modal ---- */}
      {showCode && <CodeModal url={showCode.url} body={showCode.body} apiType={showCode.apiType} sdkType={showCode.sdkType} apiVersion={showCode.apiVersion} onClose={() => setShowCode(null)} />}
    </div>
    )}
    </div>
  );
}

/* ================================================================== */
/*  Helpers                                                            */
/* ================================================================== */

async function buildTraceData(
  requestInfo: { url: string; method: string; headers: Record<string, string>; body: unknown },
  respHeaders: Record<string, string>,
  response: { statusCode: number; elapsedMs: number; body: unknown },
  fetchTraceFn?: () => Promise<unknown>,
): Promise<TraceData> {
  // Build trace sections
  let inbound: TraceSection[] = [];
  let backend: TraceSection[] = [];
  let outbound: TraceSection[] = [];
  let onError: TraceSection[] = [];

  // If a trace fetcher is provided (debug credentials were used), fetch trace via ARM API
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

  // Extract query params from URL
  const queryParams: Record<string, string> = {};
  try {
    const urlObj = new URL(requestInfo.url);
    urlObj.searchParams.forEach((v, k) => { queryParams[k] = v; });
  } catch { /* invalid URL */ }

  return {
    request: {
      url: requestInfo.url,
      method: requestInfo.method,
      headers: requestInfo.headers,
      queryParams,
      body: requestInfo.body,
    },
    inbound,
    backend,
    outbound,
    onError,
    response: {
      statusCode: response.statusCode,
      elapsedMs: response.elapsedMs,
      headers: respHeaders,
      body: response.body,
    },
  };
}

interface ApimTraceEntry {
  source?: string;
  timestamp?: string;
  elapsed?: string;
  message?: string;
  data?: unknown;
}

function parseElapsedTimespan(ts?: string): number | undefined {
  if (!ts) return undefined;
  // Handle "HH:MM:SS.fraction" timespan format
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
