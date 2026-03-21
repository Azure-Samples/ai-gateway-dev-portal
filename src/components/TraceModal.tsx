import { useState, useRef, useEffect, useCallback } from 'react';
import { X, ArrowDownToLine, ArrowUpFromLine, Server, AlertTriangle, Send, FileText, ArrowUp } from 'lucide-react';

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

interface Props {
  trace: TraceData;
  onClose: () => void;
}

type PanelKey = 'request' | 'inbound' | 'backend' | 'outbound' | 'onError' | 'response';

const PANELS: { key: PanelKey; label: string; icon: typeof Send }[] = [
  { key: 'request', label: 'Input Request', icon: Send },
  { key: 'inbound', label: 'Inbound', icon: ArrowDownToLine },
  { key: 'backend', label: 'Backend', icon: Server },
  { key: 'outbound', label: 'Outbound', icon: ArrowUpFromLine },
  { key: 'onError', label: 'On Error', icon: AlertTriangle },
  { key: 'response', label: 'Final Response', icon: FileText },
];

export default function TraceModal({ trace, onClose }: Props) {
  const [selected, setSelected] = useState<PanelKey>('request');
  const bodyRef = useRef<HTMLDivElement>(null);
  const [showTop, setShowTop] = useState(false);

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
    return (trace[key as 'inbound' | 'backend' | 'outbound' | 'onError'] as TraceSection[]).length > 0;
  };

  const statusClass = trace.response.statusCode < 300 ? 'trace-status-ok' : trace.response.statusCode < 500 ? 'trace-status-warn' : 'trace-status-err';

  const selectedPanel = PANELS.find((p) => p.key === selected)!;

  return (
    <div className="trace-overlay" onClick={onClose}>
      <div className="trace-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="trace-header">
          <h2>AI Gateway trace</h2>
          <div className="trace-header-meta">
            <span className={`trace-status-badge ${statusClass}`}>{trace.response.statusCode}</span>
            <span className="trace-elapsed">{trace.response.elapsedMs}ms</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div className="trace-body" ref={bodyRef}>
          {/* Pipeline visual */}
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

          {/* Selected section detail */}
          <div className="trace-sections">
            <div className="trace-section">
              <div className="trace-section-header">
                {(() => { const Icon = selectedPanel.icon; return <Icon size={14} />; })()}
                <span>{selectedPanel.label}</span>
              </div>
              <div className="trace-section-body">
                {selected === 'request' && <RequestPanel req={trace.request} />}
                {selected === 'response' && <ResponsePanel resp={trace.response} />}
                {(selected === 'inbound' || selected === 'backend' || selected === 'outbound' || selected === 'onError') && (
                  <TraceSections sections={trace[selected]} />
                )}
              </div>
            </div>
          </div>
        </div>
        {showTop && (
          <button className="trace-top-btn" onClick={scrollToTop} title="Scroll to top">
            <ArrowUp size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

function RequestPanel({ req }: { req: TraceData['request'] }) {
  return (
    <div className="trace-detail">
      <div className="trace-kv">
        <span className="trace-kv-label">URL</span>
        <code className="trace-kv-value">{req.url}</code>
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
          <pre className="trace-code">{typeof req.body === 'string' ? req.body : JSON.stringify(req.body, null, 2)}</pre>
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
          <div className="trace-sub-title">Response Content</div>
          <pre className="trace-code">{typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body)}</pre>
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
            <pre className="trace-code">{typeof s.data === 'string' ? s.data : JSON.stringify(s.data, null, 2)}</pre>
          )}
        </div>
      ))}
    </div>
  );
}
