// store.ts — The PRIMARY data store (SQLite via better-sqlite3).
//
// This is the durable source of truth for query counts. The hot read path
// (suggestions) never touches it directly — it is served from the in-memory
// Trie + distributed cache. SQLite is hit only for (a) the one-time seed/load
// at boot and (b) batched writes from the flusher. We deliberately count every
// physical read/write so the performance report can show how much batching
// reduces DB write pressure.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const DB_PATH = path.join(process.cwd(), 'data', 'typeahead.db');
const TSV_PATH = path.join(process.cwd(), 'data', 'queries.tsv');

export class PrimaryStore {
  private db: Database.Database;
  private upsertStmt: Database.Statement;
  /** Physical DB operation counters (for the performance report). */
  metrics = { reads: 0, writes: 0, batches: 0, seededRows: 0 };

  constructor() {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    this.db = new Database(DB_PATH);
    // WAL gives us concurrent reads during writes and good throughput; NORMAL
    // synchronous is the standard durability/speed trade-off for WAL.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS queries (
        query      TEXT PRIMARY KEY,
        count      INTEGER NOT NULL,
        category   TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    // On conflict we add to the count but keep the original category (a query
    // submitted by a user shouldn't relabel a Wikipedia/IMDb/etc. entry).
    this.upsertStmt = this.db.prepare(`
      INSERT INTO queries (query, count, category, updated_at)
      VALUES (@query, @count, 'search', @ts)
      ON CONFLICT(query) DO UPDATE SET
        count = count + @count,
        updated_at = @ts
    `);
  }

  /** Number of rows currently in the store. */
  rowCount(): number {
    this.metrics.reads++;
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM queries').get() as { n: number };
    return row.n;
  }

  /**
   * If the store is empty, seed it from data/queries.tsv (one "query\tcount"
   * per line, already sorted by count desc). At most `maxRows` are loaded.
   * Returns the number of rows seeded (0 if already populated).
   */
  async seedIfEmpty(maxRows = Infinity): Promise<number> {
    if (this.rowCount() > 0) return 0;
    if (!fs.existsSync(TSV_PATH)) {
      throw new Error(
        `Dataset not found at ${TSV_PATH}. Run "npm run dataset" to build it first.`
      );
    }
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO queries (query, count, category, updated_at) VALUES (?, ?, ?, 0)'
    );
    const rl = readline.createInterface({
      input: fs.createReadStream(TSV_PATH),
      crlfDelay: Infinity,
    });
    let n = 0;
    const batch: Array<[string, number, string]> = [];
    const flush = this.db.transaction((rows: Array<[string, number, string]>) => {
      for (const [q, c, cat] of rows) insert.run(q, c, cat);
    });
    for await (const line of rl) {
      // Format: query \t count \t category
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      const q = parts[0];
      const c = parseInt(parts[1], 10);
      const cat = parts[2] || 'query';
      if (!q || !Number.isFinite(c)) continue;
      batch.push([q, c, cat]);
      if (batch.length >= 5000) {
        flush(batch.splice(0));
        n += 5000;
      }
      if (n + batch.length >= maxRows) break;
    }
    if (batch.length) {
      flush(batch);
      n += batch.length;
    }
    this.metrics.seededRows = n;
    this.metrics.writes += n; // seeding is a write, but a one-time bulk one
    return n;
  }

  /** Stream every (query, count, category) row — used to build the Trie. */
  *all(): Generator<{ query: string; count: number; category: string }> {
    this.metrics.reads++;
    const stmt = this.db.prepare('SELECT query, count, category FROM queries');
    for (const row of stmt.iterate() as IterableIterator<{
      query: string;
      count: number;
      category: string;
    }>) {
      yield row;
    }
  }

  /**
   * Apply a batch of aggregated count deltas in a SINGLE transaction.
   * This is the whole point of batching: N user searches collapse into one
   * transaction with <= (distinct queries) row writes, instead of N writes.
   */
  applyBatch(deltas: Map<string, number>, ts: number): number {
    if (deltas.size === 0) return 0;
    const txn = this.db.transaction((entries: Array<[string, number]>) => {
      for (const [query, count] of entries) {
        this.upsertStmt.run({ query, count, ts });
      }
    });
    txn([...deltas.entries()]);
    this.metrics.writes += deltas.size;
    this.metrics.batches++;
    return deltas.size;
  }

  close(): void {
    this.db.close();
  }
}
