import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { Search, Zap, Server, ArrowLeftRight, Package, KeyRound, Cpu } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAzure, type WorkspaceData } from '../context/AzureContext';

interface SearchResult {
  category: 'model-providers' | 'inference-apis' | 'mcp-servers' | 'a2a' | 'products' | 'subscriptions';
  label: string;
  name: string;
  description: string;
  route: string;
  itemId: string;
}

const CATEGORY_META: Record<SearchResult['category'], { icon: typeof Search; title: string }> = {
  'model-providers': { icon: Cpu, title: 'Model Providers' },
  'inference-apis': { icon: Zap, title: 'Inference APIs' },
  'mcp-servers': { icon: Server, title: 'MCP Servers' },
  'a2a': { icon: ArrowLeftRight, title: 'A2A' },
  'products': { icon: Package, title: 'Products' },
  'subscriptions': { icon: KeyRound, title: 'Subscriptions' },
};

export default function SearchBar() {
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { workspaceData }: { workspaceData: WorkspaceData } = useAzure();

  // Ctrl+K shortcut to focus search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const results = useMemo<SearchResult[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const matches: SearchResult[] = [];
    const match = (text: string) => text.toLowerCase().includes(q);

    for (const b of workspaceData.backends) {
      if (b.providerType === 'unknown') continue;
      if (match(b.title) || match(b.name) || match(b.description)) {
        matches.push({ category: 'model-providers', label: b.title ?? b.name, name: b.name, description: b.description, route: '/model-providers', itemId: b.name });
      }
    }
    for (const a of workspaceData.inferenceApis) {
      if (match(a.displayName) || match(a.path) || match(a.description)) {
        matches.push({ category: 'inference-apis', label: a.displayName, name: a.path, description: a.description, route: '/inference-apis', itemId: a.name });
      }
    }
    for (const m of workspaceData.mcpServers) {
      if (match(m.displayName) || match(m.path) || match(m.description)) {
        matches.push({ category: 'mcp-servers', label: m.displayName, name: m.path, description: m.description, route: '/mcp-servers', itemId: m.name });
      }
    }
    for (const a of workspaceData.a2aServers) {
      if (match(a.displayName) || match(a.path) || match(a.description) || match(a.agentId)) {
        matches.push({ category: 'a2a', label: a.displayName, name: a.agentId ?? a.path, description: a.description, route: '/a2a', itemId: a.name });
      }
    }
    for (const p of workspaceData.products) {
      if (match(p.displayName) || match(p.name) || match(p.description)) {
        matches.push({ category: 'products', label: p.displayName, name: p.name, description: p.description, route: '/products', itemId: p.name });
      }
    }
    for (const s of workspaceData.subscriptions) {
      if (match(s.displayName) || match(s.sid) || match(s.scope)) {
        matches.push({ category: 'subscriptions', label: s.displayName, name: s.sid, description: s.scope, route: '/subscriptions', itemId: s.sid });
      }
    }
    return matches.slice(0, 20);
  }, [query, workspaceData]);

  // Group results by category
  const grouped = useMemo(() => {
    const map = new Map<SearchResult['category'], SearchResult[]>();
    for (const r of results) {
      const list = map.get(r.category) ?? [];
      list.push(r);
      map.set(r.category, list);
    }
    return map;
  }, [results]);

  // Close detail panel when search results appear
  useEffect(() => {
    if (open && results.length > 0) {
      window.dispatchEvent(new CustomEvent('close-detail-panel'));
    }
  }, [open, results.length]);

  const handleSelect = useCallback((result: SearchResult) => {
    setOpen(false);
    setQuery('');
    void navigate(result.route, { state: { selectId: result.itemId } });
  }, [navigate]);

  return (
    <div className="search-bar-wrapper" ref={wrapperRef}>
      <div className="search-bar" onClick={() => inputRef.current?.focus()}>
        <Search className="search-bar-icon" />
        <input
          ref={inputRef}
          type="text"
          placeholder="Search (Ctrl + K)"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          aria-label="Search"
        />
        <span className="search-bar-shortcut">
          <kbd>Ctrl</kbd>
          <kbd>K</kbd>
        </span>
      </div>

      {open && query.trim() && (
        <div className="search-results">
          {results.length === 0 ? (
            <div className="search-results-empty">No results found</div>
          ) : (
            [...grouped.entries()].map(([category, items]) => {
              const meta = CATEGORY_META[category];
              const Icon = meta.icon;
              return (
                <div key={category} className="search-results-group">
                  <div className="search-results-group-title">
                    <Icon size={13} />
                    {meta.title}
                  </div>
                  {items.map((item, i) => (
                    <button
                      key={`${category}-${i}`}
                      className="search-result-item"
                      onClick={() => handleSelect(item)}
                    >
                      <span className="search-result-label">{item.label}</span>
                      <span className="search-result-name">{item.name}</span>
                    </button>
                  ))}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
