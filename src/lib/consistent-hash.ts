// consistent-hash.ts — A consistent-hashing ring with virtual nodes.
//
// Used to decide which logical cache node owns a given prefix key. Consistent
// hashing means that adding/removing a cache node only remaps ~1/N of the keys
// instead of reshuffling everything (which a plain `hash(key) % N` would do).
// Virtual nodes (a.k.a. replicas) spread each physical node across many points
// on the ring so the key distribution stays balanced.

/** 32-bit FNV-1a hash -> unsigned int. Fast, stable, good spread for strings. */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619, kept in 32-bit range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

interface RingPoint {
  hash: number;
  node: string;
}

export class ConsistentHashRing {
  /** Sorted-by-hash list of virtual-node points on the ring. */
  private ring: RingPoint[] = [];
  private nodes = new Set<string>();
  private readonly vnodes: number;

  constructor(nodeIds: string[], virtualNodesPerNode = 150) {
    this.vnodes = virtualNodesPerNode;
    for (const id of nodeIds) this.addNode(id, false);
    this.sort();
  }

  private sort(): void {
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  addNode(nodeId: string, resort = true): void {
    if (this.nodes.has(nodeId)) return;
    this.nodes.add(nodeId);
    for (let i = 0; i < this.vnodes; i++) {
      this.ring.push({ hash: fnv1a(`${nodeId}#${i}`), node: nodeId });
    }
    if (resort) this.sort();
  }

  removeNode(nodeId: string): void {
    if (!this.nodes.has(nodeId)) return;
    this.nodes.delete(nodeId);
    this.ring = this.ring.filter((p) => p.node !== nodeId);
  }

  get nodeIds(): string[] {
    return [...this.nodes];
  }

  /** The node that owns `key`: first ring point clockwise from hash(key). */
  getNode(key: string): string {
    if (this.ring.length === 0) throw new Error('hash ring is empty');
    const h = fnv1a(key);
    const idx = this.firstPointAtOrAfter(h);
    return this.ring[idx].node;
  }

  /** Binary search for the first ring point with hash >= h (wraps to 0). */
  private firstPointAtOrAfter(h: number): number {
    let lo = 0;
    let hi = this.ring.length - 1;
    if (h > this.ring[hi].hash) return 0; // wrap around the ring
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ring[mid].hash < h) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Debug view of how a key routes: the owning node, the key's hash, and the
   * ring point it landed on. Powers GET /cache/debug.
   */
  routeInfo(key: string): { node: string; keyHash: number; ringPos: number } {
    const h = fnv1a(key);
    const idx = this.firstPointAtOrAfter(h);
    return { node: this.ring[idx].node, keyHash: h, ringPos: this.ring[idx].hash };
  }

  /** Approximate share of the ring owned by each node (load-balance check). */
  distribution(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const id of this.nodes) counts[id] = 0;
    let prev = this.ring.length ? this.ring[this.ring.length - 1].hash : 0;
    const SPAN = 0x100000000; // 2^32
    for (const p of this.ring) {
      const span = (p.hash - prev + SPAN) % SPAN;
      counts[p.node] += span;
      prev = p.hash;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
    const pct: Record<string, number> = {};
    for (const [id, c] of Object.entries(counts)) {
      pct[id] = +((c / total) * 100).toFixed(2);
    }
    return pct;
  }
}
