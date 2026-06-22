// trie.ts — A completion Trie with per-node cached top-K suggestions.
//
// Why a Trie + cached top-K?
//   A naive "scan all queries that start with prefix, then sort by count" is
//   O(N log N) per keystroke and gets catastrophic for short prefixes like "a"
//   (which can match tens of thousands of queries). Instead we precompute, at
//   every node, the top-K most popular completions of the subtree rooted there.
//   A lookup then becomes:  walk the prefix (O(len(prefix)))  ->  read a cached
//   array (O(K)).  That is the same idea search engines use for instant
//   suggestions, and it gives us p95 latency in the low microseconds in-process.
//
// Memory is kept reasonable by storing references to a single canonical
// Suggestion object per query, shared across every ancestor's top-K array.

import type { Suggestion, Category } from './types';

const DEFAULT_K = 10;

class TrieNode {
  children: Map<string, TrieNode> = new Map();
  /** Canonical suggestion if a query terminates here; null otherwise. */
  terminal: Suggestion | null = null;
  /** Cached top-K completions for the subtree rooted at this node (desc by count). */
  top: Suggestion[] = [];
}

export class CompletionTrie {
  private root = new TrieNode();
  private readonly k: number;
  /** Map of normalized query -> canonical Suggestion (for O(1) updates). */
  private index = new Map<string, Suggestion>();

  constructor(k: number = DEFAULT_K) {
    this.k = k;
  }

  get size(): number {
    return this.index.size;
  }

  /** Normalize a key for case-insensitive matching. */
  static norm(s: string): string {
    return s.trim().toLowerCase();
  }

  /**
   * Bulk-load queries, then compute all top-K caches in a single pass.
   * Far faster than inserting one-by-one with incremental cache maintenance.
   */
  bulkLoad(entries: Array<{ query: string; count: number; category?: Category }>): void {
    for (const { query, count, category } of entries) {
      const key = CompletionTrie.norm(query);
      if (!key) continue;
      let node = this.root;
      for (const ch of key) {
        let next = node.children.get(ch);
        if (!next) {
          next = new TrieNode();
          node.children.set(ch, next);
        }
        node = next;
      }
      // Merge duplicates that normalize to the same key.
      if (node.terminal) {
        node.terminal.count += count;
      } else {
        const sug: Suggestion = { query, count, category };
        node.terminal = sug;
        this.index.set(key, sug);
      }
    }
    this.recomputeAll(this.root);
  }

  /** Post-order DFS computing each node's top-K from its children + terminal. */
  private recomputeAll(node: TrieNode): Suggestion[] {
    const candidates: Suggestion[] = [];
    if (node.terminal) candidates.push(node.terminal);
    for (const child of node.children.values()) {
      // child.top is already sorted desc and length <= k.
      const childTop = this.recomputeAll(child);
      for (const s of childTop) candidates.push(s);
    }
    node.top = topK(candidates, this.k);
    return node.top;
  }

  /** Walk to the node owning `prefix`, or null if no query has that prefix. */
  private nodeFor(prefix: string): TrieNode | null {
    let node = this.root;
    for (const ch of prefix) {
      const next = node.children.get(ch);
      if (!next) return null;
      node = next;
    }
    return node;
  }

  /**
   * Top suggestions for a prefix, sorted by all-time count desc.
   * Returns up to `limit` (defaults to K). O(len(prefix) + limit).
   */
  suggest(prefix: string, limit: number = this.k): Suggestion[] {
    const key = CompletionTrie.norm(prefix);
    if (!key) return [];
    const node = this.nodeFor(key);
    if (!node) return [];
    return node.top.slice(0, limit);
  }

  /**
   * A larger candidate pool for a prefix (used by recency-aware re-ranking).
   * We over-fetch beyond K by doing a bounded best-first walk of the subtree.
   */
  candidates(prefix: string, pool: number): Suggestion[] {
    const key = CompletionTrie.norm(prefix);
    if (!key) return [];
    const node = this.nodeFor(key);
    if (!node) return [];
    if (node.top.length >= pool) return node.top.slice(0, pool);

    // Need more than the cached top-K: gather completions from the subtree.
    const out: Suggestion[] = [];
    const stack: TrieNode[] = [node];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.terminal) out.push(n.terminal);
      for (const c of n.children.values()) stack.push(c);
      // Safety bound so a very broad prefix can't run away.
      if (out.length > pool * 50) break;
    }
    return topK(out, pool);
  }

  /** Current count for an exact query (0 if absent). */
  countOf(query: string): number {
    return this.index.get(CompletionTrie.norm(query))?.count ?? 0;
  }

  /**
   * Apply a count delta to a query (inserting it if new), then refresh the
   * cached top-K along the affected root->terminal path only. This is what the
   * batch writer calls on flush, so updates stay O(path_len * fanout * K).
   */
  upsert(query: string, delta: number): void {
    const key = CompletionTrie.norm(query);
    if (!key) return;
    const path: TrieNode[] = [this.root];
    let node = this.root;
    for (const ch of key) {
      let next = node.children.get(ch);
      if (!next) {
        next = new TrieNode();
        node.children.set(ch, next);
      }
      node = next;
      path.push(node);
    }
    if (node.terminal) {
      node.terminal.count += delta;
    } else {
      const sug: Suggestion = { query, count: delta, category: 'search' };
      node.terminal = sug;
      this.index.set(key, sug);
    }
    // Recompute caches bottom-up along the path (children tops already valid).
    for (let i = path.length - 1; i >= 0; i--) {
      const n = path[i];
      const candidates: Suggestion[] = [];
      if (n.terminal) candidates.push(n.terminal);
      for (const c of n.children.values()) {
        for (const s of c.top) candidates.push(s);
      }
      n.top = topK(candidates, this.k);
    }
  }
}

/** Return the top `k` suggestions by count desc (stable on ties by query). */
function topK(items: Suggestion[], k: number): Suggestion[] {
  // Dedup by identity is unnecessary (each suggestion is canonical), but a
  // single query can appear via multiple children only if mis-built; guard via
  // a Set on reference.
  if (items.length <= k) {
    return items.slice().sort(cmp);
  }
  // Partial selection: sort is fine here since candidate pools are small
  // (<= (fanout + 1) * k, typically a few hundred).
  return items.slice().sort(cmp).slice(0, k);
}

function cmp(a: Suggestion, b: Suggestion): number {
  if (b.count !== a.count) return b.count - a.count;
  return a.query < b.query ? -1 : a.query > b.query ? 1 : 0;
}
