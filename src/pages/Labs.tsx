import { useState, useEffect, useMemo } from 'react';
import { FlaskConical, Search, ChevronDown, User, Github } from 'lucide-react';

const LABS_URL = 'https://raw.githubusercontent.com/Azure-Samples/AI-Gateway/refs/heads/main/docs/labs-config.json';
const IMG_BASE = 'https://raw.githubusercontent.com/Azure-Samples/AI-Gateway/refs/heads/main/';

interface Lab {
  id: string;
  name: string;
  architectureDiagram: string;
  categories: string[];
  services: string[];
  shortDescription: string;
  detailedDescription: string;
  authors: string[];
  githubPath: string;
  tags: string[];
  lastCommitDate?: string;
}

type SortMode = 'newest' | 'oldest' | 'az' | 'za';

export default function Labs() {
  const [labs, setLabs] = useState<Lab[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [serviceFilter, setServiceFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [sort, setSort] = useState<SortMode>('newest');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch(LABS_URL)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status.toString()}`); return r.json() as Promise<Lab[]>; })
      .then(setLabs)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load labs'))
      .finally(() => setLoading(false));
  }, []);

  const allCategories = useMemo(() => [...new Set(labs.flatMap((l) => l.categories))].sort(), [labs]);
  const allServices = useMemo(() => [...new Set(labs.flatMap((l) => l.services))].sort(), [labs]);
  const allTags = useMemo(() => [...new Set(labs.flatMap((l) => l.tags).filter(Boolean))].sort(), [labs]);

  const filtered = useMemo(() => {
    let list = labs;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((l) =>
        l.name.toLowerCase().includes(q) ||
        l.shortDescription.toLowerCase().includes(q) ||
        l.detailedDescription.toLowerCase().includes(q) ||
        l.authors.some((a) => a.toLowerCase().includes(q))
      );
    }
    if (categoryFilter) list = list.filter((l) => l.categories.includes(categoryFilter));
    if (serviceFilter) list = list.filter((l) => l.services.includes(serviceFilter));
    if (tagFilter) list = list.filter((l) => l.tags.includes(tagFilter));

    const sorted = [...list];
    switch (sort) {
      case 'newest': sorted.sort((a, b) => (b.lastCommitDate ?? '').localeCompare(a.lastCommitDate ?? '')); break;
      case 'oldest': sorted.sort((a, b) => (a.lastCommitDate ?? '').localeCompare(b.lastCommitDate ?? '')); break;
      case 'az': sorted.sort((a, b) => a.name.localeCompare(b.name)); break;
      case 'za': sorted.sort((a, b) => b.name.localeCompare(a.name)); break;
    }
    return sorted;
  }, [labs, search, categoryFilter, serviceFilter, tagFilter, sort]);

  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  if (loading) {
    return (
      <div className="page-container">
        <div className="page-header">
          <h1 className="page-title">Labs</h1>
        </div>
        <div className="page-empty"><span className="spinner" /></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-container">
        <div className="page-header">
          <h1 className="page-title">Labs</h1>
        </div>
        <div className="page-empty">
          <FlaskConical className="page-empty-icon" />
          <div className="page-empty-title">Failed to load labs</div>
          <p className="page-empty-text">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-title">Labs</h1>
        <p className="page-description">
          Hands-on experiments for the AI Gateway — {labs.length} labs available.
        </p>
      </div>

      {/* Toolbar */}
      <div className="sub-toolbar">
        <div className="sub-search">
          <Search size={14} className="sub-search-icon" />
          <input
            type="text"
            placeholder="Search labs…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="sub-filters">
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="">All categories</option>
            {allCategories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={serviceFilter} onChange={(e) => setServiceFilter(e.target.value)}>
            <option value="">All services</option>
            {allServices.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {allTags.length > 0 && (
            <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
              <option value="">All tags</option>
              {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          <select value={sort} onChange={(e) => setSort(e.target.value as SortMode)}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="az">Name A → Z</option>
            <option value="za">Name Z → A</option>
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="page-empty">
          <FlaskConical className="page-empty-icon" />
          <div className="page-empty-title">No matching labs</div>
          <p className="page-empty-text">Try adjusting your search or filters.</p>
        </div>
      ) : (
        <div className="labs-grid">
          {filtered.map((lab) => {
            const isExpanded = expanded.has(lab.id);
            return (
              <div key={lab.id} className={`labs-card${isExpanded ? ' expanded' : ''}`} onClick={() => toggle(lab.id)}>
                {lab.architectureDiagram && (
                  <img
                    src={`${IMG_BASE}${lab.architectureDiagram}`}
                    alt={lab.name}
                    className="labs-card-img"
                    loading="lazy"
                  />
                )}
                <div className="labs-card-body">
                  <div className="labs-card-title">{lab.name}</div>
                  <p className="labs-card-desc">
                    {isExpanded ? lab.detailedDescription : lab.shortDescription}
                    {!isExpanded && <ChevronDown size={13} className="labs-card-expand-hint" />}
                  </p>
                  {isExpanded && (
                    <ChevronDown size={14} className="labs-card-collapse-hint" />
                  )}
                  <div className="labs-card-authors">
                    {lab.authors.map((a) => (
                      <a key={a} className="labs-card-author" href={`https://github.com/${a}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}><User size={11} />{a}</a>
                    ))}
                  </div>
                  {lab.lastCommitDate && (
                    <div className="labs-card-date">
                      {new Date(lab.lastCommitDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                    </div>
                  )}
                  <div className="labs-card-tags">
                    {lab.categories.map((c) => <span key={c} className="labs-tag labs-tag-cat">{c}</span>)}
                    {lab.services.map((s) => <span key={s} className="labs-tag labs-tag-svc">{s}</span>)}
                  </div>
                  <a
                    href={lab.githubPath}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="labs-card-btn"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Open on GitHub <Github size={13} />
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
