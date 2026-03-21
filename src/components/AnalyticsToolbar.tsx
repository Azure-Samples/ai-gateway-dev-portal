/* eslint-disable react-refresh/only-export-components */
import { useState, useEffect, useCallback, useRef, useMemo, createContext, useContext } from 'react';
import { Maximize, Minimize, RefreshCw, ChevronDown } from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Shared types & constants                                           */
/* ------------------------------------------------------------------ */

export type TimeRange = '30m' | '1h' | '3h' | '6h' | '12h' | '24h' | '3d' | '7d' | '30d' | 'custom';
export type AutoRefresh = 0 | 1 | 5 | 15 | 30;
export type Granularity = 'auto' | '1m' | '5m' | '15m' | '30m' | '1h' | '6h' | '12h' | '1d' | '7d' | '30d';

export interface TimeRangeOption { value: TimeRange; label: string; ago: string }
export const TIME_RANGES: TimeRangeOption[] = [
  { value: '30m', label: 'Past 30 minutes', ago: '30m' },
  { value: '1h', label: 'Past hour', ago: '1h' },
  { value: '3h', label: 'Past 3 hours', ago: '3h' },
  { value: '6h', label: 'Past 6 hours', ago: '6h' },
  { value: '12h', label: 'Past 12 hours', ago: '12h' },
  { value: '24h', label: 'Past 24 hours', ago: '24h' },
  { value: '3d', label: 'Past 3 days', ago: '3d' },
  { value: '7d', label: 'Past 7 days', ago: '7d' },
  { value: '30d', label: 'Past 30 days', ago: '30d' },
];

const AUTO_REFRESH_OPTIONS: { value: AutoRefresh; label: string }[] = [
  { value: 0, label: 'Off' },
  { value: 1, label: 'Every 1 min' },
  { value: 5, label: 'Every 5 min' },
  { value: 15, label: 'Every 15 min' },
  { value: 30, label: 'Every 30 min' },
];

export const GRANULARITIES: { value: Granularity; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: '1m', label: '1 min' },
  { value: '5m', label: '5 min' },
  { value: '15m', label: '15 min' },
  { value: '30m', label: '30 min' },
  { value: '1h', label: '1 hour' },
  { value: '6h', label: '6 hours' },
  { value: '12h', label: '12 hours' },
  { value: '1d', label: '1 day' },
  { value: '7d', label: '1 week' },
  { value: '30d', label: '1 month' },
];

export const fmtLocal = (d: Date) => d.toISOString().slice(0, 16);

/** Resolve 'auto' granularity to a concrete KQL timespan based on range. */
export function resolveGranularity(gran: Granularity, tr: TimeRange, cs: string, ce: string): string {
  if (gran !== 'auto') return gran;
  if (tr === 'custom' && cs && ce) {
    const mins = (new Date(ce).getTime() - new Date(cs).getTime()) / 60_000;
    if (mins <= 60) return '1m';
    if (mins <= 180) return '5m';
    if (mins <= 360) return '15m';
    if (mins <= 720) return '30m';
    if (mins <= 1440) return '1h';
    if (mins <= 4320) return '6h';
    if (mins <= 10080) return '12h';
    if (mins <= 43200) return '1d';
    return '7d';
  }
  const map: Record<string, string> = {
    '30m': '1m', '1h': '1m', '3h': '5m', '6h': '15m',
    '12h': '30m', '24h': '1h', '3d': '6h', '7d': '12h', '30d': '1d',
  };
  return map[tr] ?? '1h';
}

/* ------------------------------------------------------------------ */
/*  MultiSelect                                                        */
/* ------------------------------------------------------------------ */

export function MultiSelect({ label, options, selected, onChange, show, onToggle, menuRef }: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (v: string[]) => void;
  show: boolean;
  onToggle: () => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [draft, setDraft] = useState<string[]>(selected);

  const open = () => {
    setDraft(selected);
    onToggle();
  };

  const allSelected = draft.length === 0;
  const toggle = (v: string) => {
    setDraft((d) => d.includes(v) ? d.filter((s) => s !== v) : [...d, v]);
  };
  const selectAll = () => setDraft([]);
  const clearAll = () => setDraft([]);
  const apply = () => {
    onChange(draft);
    onToggle();
  };

  const displayLabel = selected.length === 0
    ? `All ${label.toLowerCase()}`
    : selected.length === 1
      ? selected[0]
      : `${selected.length} of ${options.length} ${label.toLowerCase()}`;
  return (
    <div className="db-multi-wrap" ref={menuRef}>
      <button className="db-filter-select db-multi-btn" onClick={show ? onToggle : open}>
        {displayLabel}
        <ChevronDown size={12} />
      </button>
      {show && (
        <div className="db-multi-menu">
          {options.length === 0 && <span className="db-multi-empty">No data</span>}
          {options.length > 0 && (
            <label className="db-multi-item db-multi-all">
              <input type="checkbox" checked={allSelected} onChange={allSelected ? clearAll : selectAll} />
              Select all
            </label>
          )}
          {options.map((o) => (
            <label key={o} className="db-multi-item">
              <input type="checkbox" checked={draft.includes(o)} onChange={() => toggle(o)} />
              {o}
            </label>
          ))}
          <div className="db-multi-footer">
            <button className="db-multi-apply" onClick={apply}>Apply</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function timeAgoLabel(date: Date): string {
  const diff = Math.round((Date.now() - date.getTime()) / 60_000);
  if (diff < 1) return '';
  if (diff === 1) return 'Refreshed 1 minute ago';
  if (diff < 60) return `Refreshed ${diff.toString()} minutes ago`;
  return `Refreshed ${Math.floor(diff / 60).toString()}h ${(diff % 60).toString()}m ago`;
}

/* ------------------------------------------------------------------ */
/*  Shared filter context (persists across page navigations)           */
/* ------------------------------------------------------------------ */

interface SharedFilters {
  timeRange: TimeRange;
  setTimeRange: (v: TimeRange) => void;
  customStart: string;
  setCustomStart: (v: string) => void;
  customEnd: string;
  setCustomEnd: (v: string) => void;
  modelFilter: string[];
  setModelFilter: (v: string[]) => void;
  subFilter: string[];
  setSubFilter: (v: string[]) => void;
  granularity: Granularity;
  setGranularity: (v: Granularity) => void;
}

const SharedFiltersContext = createContext<SharedFilters | null>(null);

export function SharedFiltersProvider({ children }: { children: React.ReactNode }) {
  const [timeRange, setTimeRange] = useState<TimeRange>('30m');
  const [customStart, setCustomStart] = useState(() => fmtLocal(new Date(Date.now() - 30 * 60_000)));
  const [customEnd, setCustomEnd] = useState(() => fmtLocal(new Date()));
  const [modelFilter, setModelFilter] = useState<string[]>([]);
  const [subFilter, setSubFilter] = useState<string[]>([]);
  const [granularity, setGranularity] = useState<Granularity>('auto');

  const value = useMemo(() => ({
    timeRange, setTimeRange,
    customStart, setCustomStart,
    customEnd, setCustomEnd,
    modelFilter, setModelFilter,
    subFilter, setSubFilter,
    granularity, setGranularity,
  }), [timeRange, customStart, customEnd, modelFilter, subFilter, granularity]);

  return (
    <SharedFiltersContext.Provider value={value}>
      {children}
    </SharedFiltersContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/*  Hook: useToolbarState — shared filter state for analytics pages    */
/* ------------------------------------------------------------------ */

export interface ToolbarState {
  timeRange: TimeRange;
  setTimeRange: (v: TimeRange) => void;
  customStart: string;
  setCustomStart: (v: string) => void;
  customEnd: string;
  setCustomEnd: (v: string) => void;
  modelFilter: string[];
  setModelFilter: (v: string[]) => void;
  subFilter: string[];
  setSubFilter: (v: string[]) => void;
  loading: boolean;
  setLoading: (v: boolean) => void;
  lastRefresh: Date | null;
  setLastRefresh: (v: Date | null) => void;
  allModels: string[];
  setAllModels: (v: string[]) => void;
  allSubs: string[];
  setAllSubs: (v: string[]) => void;
  granularity: Granularity;
  setGranularity: (v: Granularity) => void;
  resolvedGran: string;
  isFullscreen: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

export function useToolbarState(): ToolbarState {
  const shared = useContext(SharedFiltersContext);
  if (!shared) throw new Error('useToolbarState must be used inside <SharedFiltersProvider>');
  const { timeRange, setTimeRange, customStart, setCustomStart, customEnd, setCustomEnd,
    modelFilter, setModelFilter, subFilter, setSubFilter, granularity, setGranularity } = shared;

  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [allModels, setAllModels] = useState<string[]>([]);
  const [allSubs, setAllSubs] = useState<string[]>([]);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = () => {
      const fs = !!document.fullscreenElement;
      setIsFullscreen(fs);
      // Sync theme onto the container so CSS variables resolve inside :fullscreen
      if (containerRef.current) {
        if (fs) {
          const theme = document.documentElement.getAttribute('data-theme');
          if (theme) containerRef.current.setAttribute('data-theme', theme);
        } else {
          containerRef.current.removeAttribute('data-theme');
        }
      }
    };
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, [containerRef]);

  const resolvedGran = useMemo(
    () => resolveGranularity(granularity, timeRange, customStart, customEnd),
    [granularity, timeRange, customStart, customEnd],
  );

  return {
    timeRange, setTimeRange,
    customStart, setCustomStart,
    customEnd, setCustomEnd,
    modelFilter, setModelFilter,
    subFilter, setSubFilter,
    loading, setLoading,
    lastRefresh, setLastRefresh,
    allModels, setAllModels,
    allSubs, setAllSubs,
    granularity, setGranularity, resolvedGran,
    isFullscreen, containerRef,
  };
}

/* ------------------------------------------------------------------ */
/*  AnalyticsToolbar component                                         */
/* ------------------------------------------------------------------ */

export interface AnalyticsToolbarProps {
  state: ToolbarState;
  onRefresh: () => void;
  /** Extra toolbar items (e.g. baseline selector) placed after filters */
  extra?: React.ReactNode;
  /** Hide model/subscription multi-select filters */
  hideMultiFilters?: boolean;
  /** Hide the granularity dropdown */
  hideGranularity?: boolean;
}

export default function AnalyticsToolbar({ state, onRefresh, extra, hideMultiFilters, hideGranularity }: AnalyticsToolbarProps) {
  const {
    timeRange, setTimeRange,
    customStart, setCustomStart, customEnd, setCustomEnd,
    modelFilter, setModelFilter, subFilter, setSubFilter,
    loading, lastRefresh,
    isFullscreen, containerRef,
    allModels, allSubs,
    granularity, setGranularity, resolvedGran,
  } = state;

  const [autoRefresh, setAutoRefresh] = useState<AutoRefresh>(0);
  const [showAutoRefresh, setShowAutoRefresh] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showSubMenu, setShowSubMenu] = useState(false);
  const [lastRefreshLabel, setLastRefreshLabel] = useState('');
  const autoRefreshRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const subMenuRef = useRef<HTMLDivElement>(null);

  // Outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (autoRefreshRef.current && !autoRefreshRef.current.contains(e.target as Node))
        setShowAutoRefresh(false);
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node))
        setShowModelMenu(false);
      if (subMenuRef.current && !subMenuRef.current.contains(e.target as Node))
        setShowSubMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Auto-refresh interval
  useEffect(() => {
    if (autoRefresh === 0) return;
    const id = setInterval(() => onRefresh(), autoRefresh * 60_000);
    return () => clearInterval(id);
  }, [autoRefresh, onRefresh]);

  // Last refresh label
  useEffect(() => {
    if (!lastRefresh) return;
    const tick = () => setLastRefreshLabel(timeAgoLabel(lastRefresh));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [lastRefresh]);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement && containerRef.current) {
      containerRef.current.requestFullscreen().catch(() => { /* ignore */ });
    } else if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => { /* ignore */ });
    }
  }, [containerRef]);

  return (
    <div className="db-toolbar">
      <div className="db-toolbar-left">
        <button className="icon-btn" onClick={toggleFullscreen} title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
          {isFullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
        </button>

        <div className="db-refresh-wrap" ref={autoRefreshRef}>
          <button
            className={`icon-btn${autoRefresh ? ' db-auto-active' : ''}`}
            onClick={() => onRefresh()}
            disabled={loading}
            title="Refresh"
          >
            <RefreshCw size={15} className={loading ? 'wl-spin' : ''} />
          </button>
          <button className="db-refresh-chevron" onClick={() => setShowAutoRefresh(!showAutoRefresh)}>
            <ChevronDown size={12} />
          </button>
          {showAutoRefresh && (
            <div className="db-refresh-menu">
              {AUTO_REFRESH_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  className={`db-refresh-item${autoRefresh === o.value ? ' active' : ''}`}
                  onClick={() => { setAutoRefresh(o.value); setShowAutoRefresh(false); }}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <select className="db-filter-select" value={timeRange} onChange={(e) => setTimeRange(e.target.value as TimeRange)}>
          {TIME_RANGES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          <option value="custom">Custom</option>
        </select>

        {timeRange === 'custom' && (
          <>
            <label className="db-filter-label">
              From
              <input type="datetime-local" className="db-filter-input" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
            </label>
            <label className="db-filter-label">
              To
              <input type="datetime-local" className="db-filter-input" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
            </label>
          </>
        )}

        {!hideMultiFilters && (
          <>
            <MultiSelect
              label="Models"
              options={allModels}
              selected={modelFilter}
              onChange={setModelFilter}
              show={showModelMenu}
              onToggle={() => setShowModelMenu(!showModelMenu)}
              menuRef={modelMenuRef}
            />
            <MultiSelect
              label="Subscriptions"
              options={allSubs}
              selected={subFilter}
              onChange={setSubFilter}
              show={showSubMenu}
              onToggle={() => setShowSubMenu(!showSubMenu)}
              menuRef={subMenuRef}
            />
          </>
        )}

        {!hideGranularity && (
          <select className="db-filter-select" value={granularity} onChange={(e) => setGranularity(e.target.value as Granularity)} title="Time granularity for chart data points">
            {GRANULARITIES.map((g) => (
              <option key={g.value} value={g.value}>
                {g.value === 'auto' ? `⏱ Auto (${resolvedGran})` : `⏱ ${g.label}`}
              </option>
            ))}
          </select>
        )}

        {extra}
      </div>

      <div className="db-toolbar-right">
        {lastRefreshLabel && <span className="db-refresh-label">{lastRefreshLabel}</span>}
      </div>
    </div>
  );
}
