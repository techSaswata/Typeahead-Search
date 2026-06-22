'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type Category = 'wiki' | 'movie' | 'person' | 'place' | 'query' | 'search';
interface Suggestion {
  query: string;
  count: number;
  category?: Category;
  score?: number;
}

const CAT_META: Record<Category, { label: string; icon: string }> = {
  wiki: { label: 'Wikipedia', icon: '📖' },
  movie: { label: 'Film/TV', icon: '🎬' },
  person: { label: 'Person', icon: '👤' },
  place: { label: 'Place', icon: '📍' },
  query: { label: 'Search', icon: '🔎' },
  search: { label: 'Live', icon: '⚡' },
};
const FILTERS: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'Everything' },
  { key: 'wiki', label: '📖 Wikipedia' },
  { key: 'movie', label: '🎬 Film/TV' },
  { key: 'person', label: '👤 People' },
  { key: 'place', label: '📍 Places' },
  { key: 'query', label: '🔎 Queries' },
];
interface SuggestResponse {
  prefix: string;
  mode: 'popular' | 'trending';
  suggestions: Suggestion[];
  cacheHit: boolean;
  cacheNode: string | null;
  latencyMs: number;
}
interface TrendingItem {
  query: string;
  score: number;
}
type Mode = 'popular' | 'trending';

const DEBOUNCE_MS = 110;

export default function Home() {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('popular');
  const [category, setCategory] = useState<string>('all');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ latencyMs: number; cacheHit: boolean; node: string | null }>({
    latencyMs: 0,
    cacheHit: false,
    node: null,
  });
  const [response, setResponse] = useState<{ message: string; query: string } | null>(null);
  const [trending, setTrending] = useState<TrendingItem[]>([]);
  const [metrics, setMetrics] = useState<any>(null);
  const [showMetrics, setShowMetrics] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const reqSeq = useRef(0);

  // Shareable URLs: /?q=you[&mode=trending] pre-fills the search on load.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const q = sp.get('q');
    if (sp.get('mode') === 'trending') setMode('trending');
    const cat = sp.get('category');
    if (cat) setCategory(cat);
    if (q) {
      setQuery(q);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Fetch suggestions (debounced, abortable, race-safe) ────────────────
  const fetchSuggestions = useCallback(
    (q: string, m: Mode, cat: string) => {
      if (q.trim().length === 0) {
        setSuggestions([]);
        setOpen(false);
        setLoading(false);
        return;
      }
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const seq = ++reqSeq.current;
      setLoading(true);
      fetch(`/suggest?q=${encodeURIComponent(q)}&mode=${m}&category=${cat}`, { signal: ctrl.signal })
        .then((r) => {
          if (!r.ok) throw new Error(`suggest failed (${r.status})`);
          return r.json() as Promise<SuggestResponse>;
        })
        .then((data) => {
          if (seq !== reqSeq.current) return; // stale response, ignore
          setSuggestions(data.suggestions);
          setMeta({ latencyMs: data.latencyMs, cacheHit: data.cacheHit, node: data.cacheNode });
          setActive(-1);
          setOpen(true);
          setError(null);
        })
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          setError(e instanceof Error ? e.message : 'request failed');
        })
        .finally(() => {
          if (seq === reqSeq.current) setLoading(false);
        });
    },
    []
  );

  // Debounce input changes (PRD §4.1: avoid unnecessary backend calls).
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(query, mode, category), DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, mode, category, fetchSuggestions]);

  // ── Trending: poll every 4s and after each search ──────────────────────
  const loadTrending = useCallback(() => {
    fetch('/trending?limit=12')
      .then((r) => r.json())
      .then((d) => setTrending(d.trending ?? []))
      .catch(() => {});
  }, []);

  const loadMetrics = useCallback(() => {
    fetch('/metrics')
      .then((r) => r.json())
      .then(setMetrics)
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadTrending();
    loadMetrics();
    const t = setInterval(() => {
      loadTrending();
      loadMetrics();
    }, 4000);
    return () => clearInterval(t);
  }, [loadTrending, loadMetrics]);

  // ── Submit a search (POST /search) ─────────────────────────────────────
  const submitSearch = useCallback(
    async (raw: string) => {
      const q = raw.trim();
      if (!q) return;
      setOpen(false);
      setError(null);
      try {
        const r = await fetch('/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q }),
        });
        if (!r.ok) throw new Error(`search failed (${r.status})`);
        const data = await r.json();
        setResponse({ message: data.message, query: q });
        // Refresh trending so the just-searched query bubbles up.
        setTimeout(loadTrending, 150);
        setTimeout(loadMetrics, 150);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'search failed');
      }
    },
    [loadTrending, loadMetrics]
  );

  // ── Keyboard navigation ────────────────────────────────────────────────
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open && suggestions.length) setOpen(true);
      setActive((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = active >= 0 && active < suggestions.length ? suggestions[active].query : query;
      setQuery(chosen);
      submitSearch(chosen);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActive(-1);
    }
  };

  const pickSuggestion = (s: Suggestion) => {
    setQuery(s.query);
    submitSearch(s.query);
  };

  const clear = () => {
    setQuery('');
    setSuggestions([]);
    setOpen(false);
    setResponse(null);
    inputRef.current?.focus();
  };

  const fmt = (n: number) =>
    n >= 1_000_000 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);

  return (
    <main className="page">
      <header className="masthead">
        <h1 className="wordmark">
          typeahead<span className="dot">.</span>
        </h1>
        <p className="tagline">
          Search everything — Wikipedia · films · people · places · real queries.
          Trie-backed · consistent-hashing cache · recency-aware trending · batched writes.
        </p>
      </header>

      {/* ── Search bar ── */}
      <div className="searchwrap">
        <div className={`searchbar${open && suggestions.length ? ' open' : ''}`}>
          <span className="searchicon" aria-hidden>
            <SearchIcon />
          </span>
          <input
            ref={inputRef}
            className="searchinput"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => suggestions.length && setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            placeholder="Search anything — people, films, places, topics…"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Search"
            aria-expanded={open}
            aria-autocomplete="list"
          />
          {loading && <span className="spinner" aria-label="loading" />}
          {query && !loading && (
            <button className="clearbtn" onClick={clear} aria-label="Clear" title="Clear">
              ×
            </button>
          )}
          <button className="gobtn" onClick={() => submitSearch(query)}>
            Search
          </button>
        </div>

        {/* ── Suggestions dropdown ── */}
        {open && (
          <div className="dropdown" role="listbox">
            <div className="divider" />
            {suggestions.length === 0 ? (
              <div className="empty">No suggestions for “{query}”.</div>
            ) : (
              suggestions.map((s, i) => (
                <div
                  key={s.query}
                  role="option"
                  aria-selected={i === active}
                  className={`suggestion${i === active ? ' active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickSuggestion(s);
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  <span className="sicon" aria-hidden>
                    <SearchIcon small />
                  </span>
                  <span className="stext">{highlight(s.query, query)}</span>
                  <span className="smeta">
                    {s.category && CAT_META[s.category] && (
                      <span className={`cattag cat-${s.category}`}>
                        {CAT_META[s.category].icon} {CAT_META[s.category].label}
                      </span>
                    )}
                    {mode === 'trending' && s.score !== undefined && (
                      <span className="badge">▲ {s.score.toFixed(1)}</span>
                    )}
                    <span>{fmt(s.count)}</span>
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* ── Search response ── */}
      {response && (
        <div className="response">
          <span className="pill">{`{ "message": "${response.message}" }`}</span>
          <span className="rtext">
            Recorded <b>“{response.query}”</b> → buffered for batched write &amp; counted toward trending.
          </span>
        </div>
      )}

      {error && <div className="errorbar">⚠ {error}</div>}

      {/* ── Controls ── */}
      <div className="controls">
        <div className="segmented" role="tablist" aria-label="Ranking mode">
          <button className={mode === 'popular' ? 'on' : ''} onClick={() => setMode('popular')}>
            Popular
          </button>
          <button className={mode === 'trending' ? 'on' : ''} onClick={() => setMode('trending')}>
            Trending
          </button>
        </div>
        <div className="meta-inline cacheline">
          <span>
            latency <b>{meta.latencyMs.toFixed(3)} ms</b>
          </span>
          <span>
            cache{' '}
            <b className={meta.cacheHit ? 'tag-hit' : 'tag-miss'}>{meta.cacheHit ? 'HIT' : 'MISS'}</b>
          </span>
          {meta.node && (
            <span>
              node <b>{meta.node}</b>
            </span>
          )}
        </div>
      </div>

      {/* ── Category filter ── */}
      <div className="filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`filter${category === f.key ? ' on' : ''}`}
            onClick={() => setCategory(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* ── Trending ── */}
      <section className="section">
        <h2>
          <span className="live" /> Trending now
        </h2>
        <div className="chips">
          {trending.length === 0 ? (
            <span className="empty-chip">No recent activity yet — run a few searches to see trending.</span>
          ) : (
            trending.map((t, i) => (
              <button
                key={t.query}
                className="chip"
                onClick={() => {
                  setQuery(t.query);
                  submitSearch(t.query);
                }}
                title={`recency score ${t.score}`}
              >
                <span className="rank">{i + 1}</span>
                {t.query}
                <span className="score">▲{t.score.toFixed(1)}</span>
              </button>
            ))
          )}
        </div>
      </section>

      {/* ── Metrics panel ── */}
      <div className="controls" style={{ marginTop: 28 }}>
        <h2 style={{ margin: 0, fontSize: 12, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--muted-dim)' }}>
          System metrics
        </h2>
        <div className="toggles">
          <button className={`ghostbtn${showMetrics ? ' on' : ''}`} onClick={() => setShowMetrics((v) => !v)}>
            {showMetrics ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      {showMetrics && metrics && (
        <>
          <div className="panel">
            <h3>Suggestion latency · dataset</h3>
            <div className="grid">
              <Metric k="p50" v={`${metrics.suggestLatency.p50Ms.toFixed(3)}`} unit="ms" />
              <Metric k="p95" v={`${metrics.suggestLatency.p95Ms.toFixed(3)}`} unit="ms" />
              <Metric k="p99" v={`${metrics.suggestLatency.p99Ms.toFixed(3)}`} unit="ms" />
              <Metric k="requests" v={fmt(metrics.suggestLatency.count)} />
              <Metric k="trie size" v={fmt(metrics.dataset.trieSize)} />
              <Metric k="store rows" v={fmt(metrics.dataset.storeRows)} />
            </div>
          </div>

          <div className="panel">
            <h3>Distributed cache · {metrics.cache.nodes.length} nodes · consistent hashing</h3>
            <div className="grid" style={{ marginBottom: 14 }}>
              <Metric k="overall hit rate" v={`${(metrics.cache.overallHitRate * 100).toFixed(1)}`} unit="%" />
              <Metric k="hits" v={fmt(metrics.cache.totalHits)} />
              <Metric k="misses" v={fmt(metrics.cache.totalMisses)} />
              <Metric k="TTL" v={`${metrics.config.cacheTtlMs / 1000}`} unit="s" />
            </div>
            <div className="nodes">
              {metrics.cache.nodes.map((n: any) => (
                <div className="node" key={n.id}>
                  <div className="nid">{n.id}</div>
                  <div className="nbar">
                    <span style={{ width: `${(metrics.cache.ringDistribution[n.id] ?? 0).toFixed(0)}%` }} />
                  </div>
                  <div className="nstat">
                    {(metrics.cache.ringDistribution[n.id] ?? 0).toFixed(1)}% ring · {n.size} keys · {(n.hitRate * 100).toFixed(0)}% hit
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <h3>Batch writes · write reduction</h3>
            <div className="grid">
              <Metric k="searches accepted" v={fmt(metrics.batchWrites.eventsAccepted)} />
              <Metric k="db row-writes" v={fmt(metrics.batchWrites.rowsWritten)} />
              <Metric k="flushes" v={fmt(metrics.batchWrites.flushes)} />
              <Metric k="buffered now" v={fmt(metrics.batchWrites.bufferedNow)} />
              <Metric k="write reduction" v={`${metrics.batchWrites.reduction.savedPct.toFixed(1)}`} unit="%" />
              <Metric k="events / write" v={`${metrics.batchWrites.reduction.ratio}×`} />
            </div>
          </div>
        </>
      )}

      <footer className="footer">
        <p>
          Keyboard: <kbd>↑</kbd> <kbd>↓</kbd> navigate · <kbd>Enter</kbd> search · <kbd>Esc</kbd> close. APIs:{' '}
          <a href="/suggest?q=you">/suggest</a> · <a href="/trending">/trending</a> ·{' '}
          <a href="/cache/debug?prefix=you">/cache/debug</a> · <a href="/metrics">/metrics</a>
        </p>
      </footer>
    </main>
  );
}

function Metric({ k, v, unit }: { k: string; v: string; unit?: string }) {
  return (
    <div className="metric">
      <div className="k">{k}</div>
      <div className="v">
        {v}
        {unit && <small> {unit}</small>}
      </div>
    </div>
  );
}

/** Bold the part of the suggestion beyond the typed prefix (Google style). */
function highlight(text: string, prefix: string) {
  const p = prefix.trim();
  if (p && text.toLowerCase().startsWith(p.toLowerCase())) {
    return (
      <>
        <span className="match">{text.slice(0, p.length)}</span>
        <span className="rest">{text.slice(p.length)}</span>
      </>
    );
  }
  return <span className="rest">{text}</span>;
}

function SearchIcon({ small }: { small?: boolean }) {
  const s = small ? 16 : 20;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" strokeLinecap="round" />
    </svg>
  );
}
