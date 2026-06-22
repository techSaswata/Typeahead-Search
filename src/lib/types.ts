// Shared domain types for the typeahead engine.

/** Category of a query's originating dataset (powers the UI tag + filtering). */
export type Category = 'wiki' | 'movie' | 'person' | 'place' | 'query' | 'search';

/** A single suggestion returned to the client. */
export interface Suggestion {
  /** The full query string (original casing). */
  query: string;
  /** Unified popularity (log-normalized + summed across source datasets). */
  count: number;
  /** Which source dataset this query primarily comes from. */
  category?: Category;
  /** Recency-aware score (only meaningful in "trending" ranking mode). */
  score?: number;
}

export type RankingMode = 'popular' | 'trending';

/** Result of a suggest lookup, including cache provenance for the UI/metrics. */
export interface SuggestResult {
  prefix: string;
  mode: RankingMode;
  suggestions: Suggestion[];
  /** Whether this prefix's result was served from the distributed cache. */
  cacheHit: boolean;
  /** Which logical cache node owns this prefix (consistent hashing). */
  cacheNode: string;
  /** Server-side latency in milliseconds. */
  latencyMs: number;
}

/** A pending search submission queued for batched write. */
export interface SearchEvent {
  query: string;
  /** Unix epoch ms when the search was submitted. */
  ts: number;
}
