// cache.ts — A distributed suggestion cache built from N logical cache nodes,
// with prefix keys routed to nodes via consistent hashing.
//
// Each logical node is an independent LRU+TTL map (simulating a separate cache
// server such as a Redis/Memcached instance). The DistributedCache picks the
// owning node for a key using the consistent-hashing ring, so:
//   - a given prefix always hits the same node (good locality),
//   - adding/removing a node only disturbs ~1/N of keys,
//   - load is spread evenly thanks to virtual nodes.
//
// Entries expire by TTL so freshly-updated rankings eventually show through,
// and we also support targeted invalidation when a submitted query changes the
// ranking of every prefix of that query.

import { ConsistentHashRing } from './consistent-hash';
import type { Suggestion, RankingMode } from './types';

interface Entry {
  value: Suggestion[];
  expiresAt: number;
}

/** A single logical cache node: bounded LRU with per-entry TTL. */
class CacheNode {
  private map = new Map<string, Entry>(); // insertion-order = LRU order
  hits = 0;
  misses = 0;
  evictions = 0;
  expirations = 0;

  constructor(
    readonly id: string,
    private capacity: number,
    private ttlMs: number
  ) {}

  get(key: string, now: number): Suggestion[] | null {
    const e = this.map.get(key);
    if (!e) {
      this.misses++;
      return null;
    }
    if (e.expiresAt <= now) {
      this.map.delete(key);
      this.expirations++;
      this.misses++;
      return null;
    }
    // LRU touch: re-insert to move to the most-recently-used end.
    this.map.delete(key);
    this.map.set(key, e);
    this.hits++;
    return e.value;
  }

  set(key: string, value: Suggestion[], now: number): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: now + this.ttlMs });
    while (this.map.size > this.capacity) {
      // Evict least-recently-used (first inserted).
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
      this.evictions++;
    }
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  /** Drop every key whose prefix part starts with `prefix` (invalidation). */
  invalidatePrefixSpace(predicate: (key: string) => boolean): number {
    let n = 0;
    for (const key of [...this.map.keys()]) {
      if (predicate(key)) {
        this.map.delete(key);
        n++;
      }
    }
    return n;
  }

  get size(): number {
    return this.map.size;
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      id: this.id,
      size: this.size,
      capacity: this.capacity,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expirations: this.expirations,
      hitRate: total ? +(this.hits / total).toFixed(4) : 0,
    };
  }
}

export interface CacheDebugInfo {
  key: string;
  node: string;
  keyHash: number;
  ringPos: number;
  hit: boolean;
}

export class DistributedCache {
  private ring: ConsistentHashRing;
  private nodes = new Map<string, CacheNode>();
  private ttlMs: number;

  constructor(opts: {
    nodeIds: string[];
    capacityPerNode: number;
    ttlMs: number;
    virtualNodesPerNode?: number;
  }) {
    this.ttlMs = opts.ttlMs;
    this.ring = new ConsistentHashRing(opts.nodeIds, opts.virtualNodesPerNode ?? 150);
    for (const id of opts.nodeIds) {
      this.nodes.set(id, new CacheNode(id, opts.capacityPerNode, opts.ttlMs));
    }
  }

  /** Build the cache key from ranking mode + category filter + normalized prefix. */
  static key(mode: RankingMode, prefix: string, category = 'all'): string {
    return `${mode}:${category}:${prefix.trim().toLowerCase()}`;
  }

  /** Extract the prefix portion (after the 2nd colon) of a cache key. */
  private static prefixOf(key: string): string {
    const first = key.indexOf(':');
    const second = key.indexOf(':', first + 1);
    return key.slice(second + 1);
  }

  private ownerOf(key: string): CacheNode {
    const id = this.ring.getNode(key);
    return this.nodes.get(id)!;
  }

  get(mode: RankingMode, prefix: string, now: number, category = 'all'): Suggestion[] | null {
    const key = DistributedCache.key(mode, prefix, category);
    return this.ownerOf(key).get(key, now);
  }

  set(mode: RankingMode, prefix: string, value: Suggestion[], now: number, category = 'all'): void {
    const key = DistributedCache.key(mode, prefix, category);
    this.ownerOf(key).set(key, value, now);
  }

  /**
   * Invalidate every cached prefix that is a prefix of `query` — those are
   * exactly the cache entries whose ranking could change when `query` is
   * searched. Cheap and precise compared to flushing the whole cache.
   */
  invalidateForQuery(query: string): number {
    const q = query.trim().toLowerCase();
    let n = 0;
    for (const node of this.nodes.values()) {
      n += node.invalidatePrefixSpace((key) => {
        const prefix = DistributedCache.prefixOf(key);
        return q.startsWith(prefix); // prefix is an actual prefix of the query
      });
    }
    return n;
  }

  /** Inspect how a prefix routes and whether it is currently cached. */
  debug(mode: RankingMode, prefix: string, now: number, category = 'all'): CacheDebugInfo {
    const key = DistributedCache.key(mode, prefix, category);
    const info = this.ring.routeInfo(key);
    const node = this.nodes.get(info.node)!;
    // Peek without affecting LRU/metrics where possible: replicate get logic.
    const present = (() => {
      const e = (node as unknown as { map: Map<string, Entry> }).map.get(key);
      return !!e && e.expiresAt > now;
    })();
    return {
      key,
      node: info.node,
      keyHash: info.keyHash,
      ringPos: info.ringPos,
      hit: present,
    };
  }

  ringDistribution(): Record<string, number> {
    return this.ring.distribution();
  }

  stats() {
    const perNode = [...this.nodes.values()].map((n) => n.stats());
    const hits = perNode.reduce((a, n) => a + n.hits, 0);
    const misses = perNode.reduce((a, n) => a + n.misses, 0);
    const total = hits + misses;
    return {
      nodes: perNode,
      totalHits: hits,
      totalMisses: misses,
      overallHitRate: total ? +(hits / total).toFixed(4) : 0,
      ttlMs: this.ttlMs,
      ringDistribution: this.ring.distribution(),
    };
  }

  get nodeIds(): string[] {
    return this.ring.nodeIds;
  }
}
