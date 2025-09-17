import Database from 'better-sqlite3';
import { config } from '../config';
import { logger } from '../utils/logger';
import { incEventsWritten24h, incQuotesErrors, incQuotesWritten, incQuotesWritten24h } from '../feeds/state';

let DB: Database.Database | null = null;

function ensureDb(): Database.Database {
  if (DB) return DB;
  // Fallback to own handle if not initialized by caller
  const db = new Database(config.dbPath);
  // light pragmas
  try { db.pragma('journal_mode = WAL'); } catch {}
  try { db.pragma('foreign_keys = ON'); } catch {}
  try { db.pragma('busy_timeout = 3000'); } catch {}
  DB = db;
  return db;
}

export function setMetricsDb(db: Database.Database) {
  DB = db;
}

// saveEvent: insert one row; tolerate duplicate attempts gracefully
export function saveEvent(e: {
  ts: number;
  signature?: string;
  mint: string;
  origin: string;
  buyers: number;
  unique: number;
  same: number;
  priceJumps: number;
  depth: number;
  creator?: string;
  snapshot?: any;
}): void {
  const db = ensureDb();
  try {
    const stmt = db.prepare(
      `INSERT INTO events (ts, signature, mint, origin, buyers, unique_funders, same_funder_ratio, price_jumps, depth_est, creator, snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const snapJson = e?.snapshot !== undefined ? JSON.stringify(e.snapshot) : null;
    stmt.run(
      Math.floor(e.ts || Date.now()),
      e.signature ?? null,
      e.mint,
      e.origin,
      e.buyers ?? null,
      e.unique ?? null,
      e.same ?? null,
      e.priceJumps ?? null,
      e.depth ?? null,
      e.creator ?? null,
      snapJson
    );
    try { incEventsWritten24h(1); } catch {}
  } catch (err) {
    // Swallow unique/constraint errors (idempotency); log others at debug
    const msg = (err as Error)?.message || '';
    if (!/UNIQUE|constraint/i.test(msg)) {
      logger.debug('saveEvent error:', msg);
    }
  }
}

// saveQuotes: bulk insert; swallow UNIQUE conflicts
export function saveQuotes(qs: Array<{
  ts: number;
  mint: string;
  origin: string;
  route: 'pumpfun';
  sizeSol: number;
  estFillPriceSol: number | null;
  estSlippageBps: number | null;
  reserves?: any;
}>): void {
  if (!qs || qs.length === 0) return;
  const db = ensureDb();
  try {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO quotes (ts, mint, origin, route, size_sol, est_fill_price_sol, est_slippage_bps, reserves_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = db.transaction(() => {
      for (const q of qs) {
        try {
          stmt.run(
            Math.floor(q.ts || Date.now()),
            q.mint,
            q.origin,
            q.route,
            q.sizeSol,
            q.estFillPriceSol,
            q.estSlippageBps,
            q.reserves !== undefined ? JSON.stringify(q.reserves) : null
          );
        } catch (err) {
          // Ignore UNIQUE per PK; count other errors
          const msg = (err as Error)?.message || '';
          if (!/UNIQUE|constraint/i.test(msg)) {
            try { incQuotesErrors(1); } catch {}
            logger.debug('saveQuotes item error:', msg);
          }
        }
      }
    });
    tx();
    try {
      incQuotesWritten(qs.length);
      incQuotesWritten24h(qs.length);
    } catch {}
  } catch (err) {
    try { incQuotesErrors(qs.length); } catch {}
    const msg = (err as Error)?.message || '';
    logger.debug('saveQuotes error:', msg);
  }
}

