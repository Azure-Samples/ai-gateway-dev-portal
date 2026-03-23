import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { X, ArrowDownToLine, ArrowUpFromLine, Server, AlertTriangle, Send, FileText, ArrowUp, MessageSquare, Wrench, ChevronRight, ChevronDown, List, ShieldCheck, Copy, Check } from 'lucide-react';

export interface TraceData {
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    queryParams: Record<string, string>;
    body: unknown;
  };
  inbound: TraceSection[];
  backend: TraceSection[];
  outbound: TraceSection[];
  onError: TraceSection[];
  response: {
    statusCode: number;
    elapsedMs: number;
    headers: Record<string, string>;
    body: unknown;
  };
}

export interface TraceSection {
  source: string;
  timestamp?: string;
  elapsed?: number;
  message: string;
  data?: unknown;
}

export interface TraceEntry {
  id: string;
  label: string;
  role: 'user' | 'assistant';
  trace: TraceData;
  model?: string;
  latencyMs?: number;
}

interface McpToolNode {
  id: string;
  name: string;
  serverLabel: string;
  arguments?: string;
  output?: string;
  type: 'list_tools' | 'call' | 'approval_request';
}

interface Props {
  trace: TraceData;
  allTraces?: TraceEntry[];
  initialTraceId?: string;
  onClose: () => void;
}

type PanelKey = 'request' | 'inbound' | 'backend' | 'outbound' | 'onError' | 'response';

function tryFormatJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="trace-copy-btn"
      title="Copy to clipboard"
      onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

function CodeBlock({ content }: { content: string }) {
  return (
    <div className="trace-code-wrap">
      <CopyBtn text={content} />
      <pre className="trace-code">{content}</pre>
    </div>
  );
}

const PANELS: { key: PanelKey; label: string; icon: typeof Send }[] = [
  { key: 'request', label: 'Input Request', icon: Send },
  { key: 'inbound', label: 'Inbound', icon: ArrowDownToLine },
  { key: 'backend', label: 'Backend', icon: Server },
  { key: 'outbound', label: 'Outbound', icon: ArrowUpFromLine },
  { key: 'onError', label: 'On Error', icon: AlertTriangle },
  { key: 'response', label: 'Final Response', icon: FileText },
];

export default function TraceModal({ trace, allTraces, initialTraceId, onClose }: Props) {
  const [activeTrace, setActiveTrace] = useState<TraceData>(trace);
  const [activeTraceId, setActiveTraceId] = useState<string | undefined>(initialTraceId);
  const [activeTool, setActiveTool] = useState<McpToolNode | null>(null);
  const [selected, setSelected] = useState<PanelKey>('request');
  const bodyRef = useRef<HTMLDivElement>(null);
  const [showTop, setShowTop] = useState(false);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => new Set(allTraces?.map((t) => t.id) ?? []));

  const onScroll = useCallback(() => {
    if (bodyRef.current) setShowTop(bodyRef.current.scrollTop > 200);
  }, []);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [onScroll]);

  const scrollToTop = () => bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });

  const hasData = (key: PanelKey): boolean => {
    if (key === 'request' || key === 'response') return true;
    return activeTrace[key].length > 0;
  };

  const selectTrace = (entry: TraceEntry) => {
    setActiveTrace(entry.trace);
    setActiveTraceId(entry.id);
    setActiveTool(null);
    setSelected('request');
    bodyRef.current?.scrollTo({ top: 0 });
  };

  const selectTool = (entry: TraceEntry, tool: McpToolNode) => {
    setActiveTrace(entry.trace);
    setActiveTraceId(entry.id);
    setActiveTool(tool);
    bodyRef.current?.scrollTo({ top: 0 });
  };

  const toggleNode = (id: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Extract MCP tool nodes from a trace's response body
  const mcpToolsForTrace = useMemo(() => {
    const map = new Map<string, McpToolNode[]>();
    for (const entry of allTraces ?? []) {
      const tools = extractMcpTools(entry.trace.response.body);
      if (tools.length > 0) map.set(entry.id, tools);
    }
    return map;
  }, [allTraces]);

  const showTree = allTraces && allTraces.length > 0;

  const statusClass = activeTrace.response.statusCode < 300 ? 'trace-status-ok' : activeTrace.response.statusCode < 500 ? 'trace-status-warn' : 'trace-status-err';

  const selectedPanel = PANELS.find((p) => p.key === selected)!;

  return (
    <div className="trace-overlay" onClick={onClose}>
      <div className={`trace-dialog${showTree ? ' trace-dialog-wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="trace-header">
          <h2>AI Gateway trace</h2>
          <div className="trace-header-meta">
            <span className={`trace-status-badge ${statusClass}`}>{activeTrace.response.statusCode}</span>
            <span className="trace-elapsed">{activeTrace.response.elapsedMs}ms</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div className="trace-main">
          {/* Tree sidebar */}
          {showTree && (
            <div className="trace-tree">
              <div className="trace-tree-title">History</div>
              {allTraces.map((entry, idx) => {
                const isExpanded = expandedNodes.has(entry.id);
                const isActive = activeTraceId === entry.id && !activeTool;
                const tools = (mcpToolsForTrace.get(entry.id) ?? []).filter((t) => t.type !== 'list_tools');
                const hasChildren = tools.length > 0;
                const entryStatus = entry.trace.response.statusCode < 300 ? 'ok' : entry.trace.response.statusCode < 500 ? 'warn' : 'err';
                return (
                  <div key={entry.id} className="trace-tree-group">
                    <button
                      className={`trace-tree-node${isActive ? ' active' : ''}`}
                      onClick={() => { selectTrace(entry); if (hasChildren && !isExpanded) toggleNode(entry.id); }}
                    >
                      {hasChildren ? (
                        <span className="trace-tree-toggle" onClick={(e) => { e.stopPropagation(); toggleNode(entry.id); }}>
                          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        </span>
                      ) : <span className="trace-tree-toggle-spacer" />}
                      <MessageSquare size={12} />
                      <span className="trace-tree-label">{idx + 1}. {entry.label}</span>
                      <span className={`trace-tree-status trace-tree-status-${entryStatus}`} />
                    </button>
                    {hasChildren && isExpanded && (
                      <div className="trace-tree-children">
                        {tools.map((tool) => (
                          <button
                            key={tool.id}
                            className={`trace-tree-leaf${activeTool?.id === tool.id ? ' active' : ''}`}
                            onClick={() => selectTool(entry, tool)}
                          >
                            {tool.type === 'list_tools' ? <List size={11} /> : tool.type === 'approval_request' ? <ShieldCheck size={11} /> : <Wrench size={11} />}
                            <span className="trace-tree-leaf-label" title={tool.type === 'list_tools' ? `Discover tools on ${tool.serverLabel}` : tool.arguments}>
                              {tool.name}
                            </span>
                            <span className="trace-tree-leaf-type">{tool.serverLabel}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Main content */}
          <div className="trace-content">
            {activeTool ? (
              /* Tool detail view */
              <>
                <div className="trace-tool-header">
                  <div className="trace-tool-header-server">
                    <Server size={13} />
                    <span>{activeTool.serverLabel}</span>
                  </div>
                  <div className="trace-tool-header-detail">
                    {activeTool.type === 'list_tools' ? <List size={14} /> : activeTool.type === 'approval_request' ? <ShieldCheck size={14} /> : <Wrench size={14} />}
                    <span className="trace-tool-header-name">{activeTool.type === 'list_tools' ? 'Tool Discovery' : activeTool.type === 'approval_request' ? 'Approval Request' : activeTool.name}</span>
                    <code className="trace-tool-type-badge" data-type={activeTool.type}>
                      {activeTool.type === 'list_tools' ? 'list_tools' : activeTool.type === 'approval_request' ? 'approval_request' : 'call'}
                    </code>
                  </div>
                </div>
                <div className="trace-body" ref={bodyRef}>
                  <div className="trace-sections">
                    <div className="trace-section">
                      <div className="trace-section-header">
                        <Send size={14} />
                        <span>{activeTool.type === 'list_tools' ? 'Discovery Request' : 'Tool Input'}</span>
                      </div>
                      <div className="trace-section-body">
                        <div className="trace-detail">
                          {activeTool.arguments && (
                            <>
                              <div className="trace-sub-title">Arguments</div>
                              <CodeBlock content={tryFormatJson(activeTool.arguments)} />
                            </>
                          )}
                          {!activeTool.arguments && activeTool.type === 'list_tools' && (
                            <div className="trace-empty">No input — discovery request</div>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="trace-section">
                      <div className="trace-section-header">
                        <FileText size={14} />
                        <span>{activeTool.type === 'list_tools' ? 'Available Tools' : 'Tool Output'}</span>
                      </div>
                      <div className="trace-section-body">
                        <div className="trace-detail">
                          {activeTool.type === 'list_tools' && activeTool.output ? (
                            <ToolsList output={activeTool.output} />
                          ) : activeTool.output ? (
                            <CodeBlock content={tryFormatJson(activeTool.output)} />
                          ) : (
                            <div className="trace-empty">No output captured</div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              /* Normal trace view */
              <>
                <div className="trace-pipeline">
                  {PANELS.map((p, i) => {
                    const Icon = p.icon;
                    const has = hasData(p.key);
                    return (
                      <div key={p.key} className="trace-pipeline-step">
                        {i > 0 && <div className={`trace-pipeline-connector${has ? ' has-data' : ''}`} />}
                        <button
                          className={`trace-pipeline-node${selected === p.key ? ' active' : ''}${has ? ' has-data' : ' empty'}`}
                          onClick={() => has && setSelected(p.key)}
                        >
                          <Icon size={13} />
                          <span>{p.label}</span>
                          {has && p.key !== 'request' && p.key !== 'response' && <span className="trace-pipeline-dot" />}
                        </button>
                      </div>
                    );
                  })}
                </div>

                <div className="trace-body" ref={bodyRef}>
                  <div className="trace-sections">
                    <div className="trace-section">
                      <div className="trace-section-header">
                        {(() => { const Icon = selectedPanel.icon; return <Icon size={14} />; })()}
                        <span>{selectedPanel.label}</span>
                      </div>
                      <div className="trace-section-body">
                        {selected === 'request' && <RequestPanel req={activeTrace.request} />}
                        {selected === 'response' && <ResponsePanel resp={activeTrace.response} />}
                        {(selected === 'inbound' || selected === 'backend' || selected === 'outbound' || selected === 'onError') && (
                          <TraceSections sections={activeTrace[selected]} />
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
            {showTop && (
              <button className="trace-top-btn" onClick={scrollToTop} title="Scroll to top">
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RequestPanel({ req }: { req: TraceData['request'] }) {
  const displayUrl = req.url.replace(/^\/gateway-proxy/, '');
  return (
    <div className="trace-detail">
      <div className="trace-kv">
        <span className="trace-kv-label">URL</span>
        <code className="trace-kv-value">{displayUrl}</code>
        <CopyBtn text={displayUrl} />
      </div>
      <div className="trace-kv">
        <span className="trace-kv-label">Method</span>
        <code className="trace-kv-value">{req.method}</code>
      </div>
      {Object.keys(req.queryParams).length > 0 && (
        <>
          <div className="trace-sub-title">Query String Parameters</div>
          {Object.entries(req.queryParams).map(([k, v]) => (
            <div className="trace-kv" key={k}>
              <span className="trace-kv-label">{k}</span>
              <code className="trace-kv-value">{v}</code>
            </div>
          ))}
        </>
      )}
      <div className="trace-sub-title">Request Headers</div>
      {Object.entries(req.headers).map(([k, v]) => (
        <div className="trace-kv" key={k}>
          <span className="trace-kv-label">{k}</span>
          <code className="trace-kv-value">{v}</code>
        </div>
      ))}
      {req.body != null && (
        <>
          <div className="trace-sub-title">Request Payload</div>
          <CodeBlock content={typeof req.body === 'string' ? req.body : JSON.stringify(req.body, null, 2)} />
        </>
      )}
    </div>
  );
}

function ResponsePanel({ resp }: { resp: TraceData['response'] }) {
  const statusClass = resp.statusCode < 300 ? 'trace-status-ok' : resp.statusCode < 500 ? 'trace-status-warn' : 'trace-status-err';
  return (
    <div className="trace-detail">
      <div className="trace-kv">
        <span className="trace-kv-label">Status Code</span>
        <code className={`trace-kv-value ${statusClass}`}>{resp.statusCode}</code>
      </div>
      <div className="trace-kv">
        <span className="trace-kv-label">Elapsed Time</span>
        <code className="trace-kv-value">{resp.elapsedMs}ms</code>
      </div>
      <div className="trace-sub-title">Response Headers</div>
      {Object.entries(resp.headers).map(([k, v]) => (
        <div className="trace-kv" key={k}>
          <span className="trace-kv-label">{k}</span>
          <code className="trace-kv-value">{v}</code>
        </div>
      ))}
      {resp.body != null && (
        <>
          <div className="trace-sub-title">Response Payload</div>
          <CodeBlock content={typeof resp.body === 'string' ? tryFormatJson(resp.body) : JSON.stringify(resp.body, null, 2)} />
        </>
      )}
    </div>
  );
}

function TraceSections({ sections }: { sections: TraceSection[] }) {
  if (sections.length === 0) {
    return <div className="trace-detail trace-empty">No trace entries</div>;
  }
  return (
    <div className="trace-detail">
      {sections.map((s, i) => (
        <div key={i} className="trace-entry">
          <div className="trace-entry-header">
            <span className="trace-entry-source">{s.source}</span>
            {s.elapsed != null && <span className="trace-entry-elapsed">{(s.elapsed * 1000).toFixed(3)}ms</span>}
            {s.timestamp && <span className="trace-entry-time">{s.timestamp}</span>}
          </div>
          {s.message && s.data == null && (
            <div className="trace-entry-message">{s.message}</div>
          )}
          {s.data != null && (
            <CodeBlock content={typeof s.data === 'string' ? s.data : JSON.stringify(s.data, null, 2)} />
          )}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ToolsList – structured display of list_tools output               */
/* ------------------------------------------------------------------ */

interface ToolItem { name?: string; description?: string; inputSchema?: unknown }

function ToolsList({ output }: { output: string }) {
  let parsed: ToolItem[] | null = null;
  try {
    const data = JSON.parse(output) as unknown;
    if (Array.isArray(data)) parsed = data as ToolItem[];
  } catch { /* fall through to raw display */ }

  if (!parsed || parsed.length === 0) {
    return <CodeBlock content={tryFormatJson(output)} />;
  }

  return (
    <div className="trace-tools-list">
      <div className="trace-tools-count">{parsed.length} tool{parsed.length !== 1 ? 's' : ''} available</div>
      {parsed.map((tool, i) => (
        <div key={i} className="trace-tools-item">
          <div className="trace-tools-item-header">
            <Wrench size={12} />
            <span className="trace-tools-item-name">{tool.name ?? `tool_${i}`}</span>
          </div>
          {tool.description && <div className="trace-tools-item-desc">{tool.description}</div>}
          {tool.inputSchema != null && (
            <details className="trace-tools-item-schema">
              <summary>Input schema</summary>
              <pre className="trace-code">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  extractMcpTools – parse SSE response body for MCP tool events     */
/* ------------------------------------------------------------------ */

function extractMcpTools(body: unknown): McpToolNode[] {
  if (typeof body !== 'string') return [];
  const toolsMap = new Map<string, McpToolNode>();
  const lines = body.split('\n');

  const addItem = (item: { type?: string; id?: string; name?: string; server_label?: string; arguments?: string; output?: string; tools?: unknown[] }) => {
    if (item.type === 'mcp_list_tools') {
      const id = item.id ?? `lt-${toolsMap.size}`;
      if (!toolsMap.has(id)) {
        const listOutput = item.output ?? (item.tools ? JSON.stringify(item.tools, null, 2) : undefined);
        toolsMap.set(id, { id, name: 'list_tools', serverLabel: item.server_label ?? '', output: listOutput, type: 'list_tools' });
      }
    } else if (item.type === 'mcp_call') {
      const id = item.id ?? `mc-${toolsMap.size}`;
      if (!toolsMap.has(id)) {
        toolsMap.set(id, { id, name: item.name ?? 'call', serverLabel: item.server_label ?? '', arguments: item.arguments, output: item.output, type: 'call' });
      }
    } else if (item.type === 'mcp_approval_request') {
      const id = item.id ?? `ap-${toolsMap.size}`;
      if (!toolsMap.has(id)) {
        toolsMap.set(id, { id, name: item.name ?? 'approval', serverLabel: item.server_label ?? '', arguments: item.arguments, output: item.output, type: 'approval_request' });
      }
    }
  };

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const evt = JSON.parse(payload) as {
        type?: string;
        item?: { type?: string; id?: string; name?: string; server_label?: string; arguments?: string; output?: string; tools?: unknown[] };
        response?: { output?: { type?: string; id?: string; name?: string; server_label?: string; arguments?: string; output?: string; tools?: unknown[] }[] };
      };
      if (evt.type === 'response.output_item.done' && evt.item) {
        addItem(evt.item);
      }
      // Also extract from response.completed to catch items missing individual done events
      if (evt.type === 'response.completed' && evt.response?.output) {
        for (const item of evt.response.output) {
          addItem(item);
        }
      }
    } catch { /* skip malformed lines */ }
  }
  const result = Array.from(toolsMap.values());
  result.sort((a, b) => {
    if (a.type === 'list_tools' && b.type !== 'list_tools') return -1;
    if (a.type !== 'list_tools' && b.type === 'list_tools') return 1;
    return 0;
  });
  return result;
}
