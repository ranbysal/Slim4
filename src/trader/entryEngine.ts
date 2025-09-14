import Database from 'better-sqlite3';
import { config, Origin } from '../config';
import { getSnapshot } from '../microstructure/firstNBlocks';
import { safetyGate } from '../risk/safetyGate';
import { convictionFromMicro } from '../alpha/conviction';
import { bumpSummary, sendDecisionAlert } from '../utils/telegram';
import { logger } from '../utils/logger';

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(config.dbPath);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 3000');
    } catch {}
  }
  return db;
}

function ensureOrdersDecisionColumns(d: Database.Database) {
  try {
    const cols = d.prepare("PRAGMA table_info(orders)").all() as { name: string }[];
    const names = new Set(cols.map(c => c.name));
    const addCol = (sql: string) => { try { d.exec(sql); } catch {} };
    if (!names.has('mint')) addCol("ALTER TABLE orders ADD COLUMN mint TEXT");
    if (!names.has('origin')) addCol("ALTER TABLE orders ADD COLUMN origin TEXT");
    if (!names.has('decided_ts')) addCol("ALTER TABLE orders ADD COLUMN decided_ts INTEGER");
    if (!names.has('size_tier')) addCol("ALTER TABLE orders ADD COLUMN size_tier TEXT");
    if (!names.has('notes')) addCol("ALTER TABLE orders ADD COLUMN notes TEXT");
  } catch (e) {
    logger.warn('ensureOrdersDecisionColumns error:', (e as Error)?.message ?? e);
  }
}

const lastDecisionTs: Map<string, number> = new Map();

function mintShort(m: string): string {
  if (!m) return '';
  if (m.length <= 10) return m;
  return `${m.slice(0, 4)}…${m.slice(-4)}`;
}

export async function evaluateMint(mint: string, origin: Origin, nowTs: number): Promise<void> {
  try {
    // Cooldown per mint
    const last = lastDecisionTs.get(mint) || 0;
    const cooldownMs = (config.entry.cooldownSec || 60) * 1000;
    if (nowTs - last < cooldownMs) return;
    lastDecisionTs.set(mint, nowTs);

    const snapshot = getSnapshot(mint);
    const verdict = safetyGate(snapshot, origin);

    const d = getDb();
    ensureOrdersDecisionColumns(d);

    if (!verdict.pass) {
      const insert = d.prepare(
        `INSERT INTO orders (market, side, type, status, quantity_base, price, position_id, mint, origin, decided_ts, size_tier, notes)
         VALUES (@market, @side, @type, @status, @quantity_base, @price, NULL, @mint, @origin, @decided_ts, @size_tier, @notes)`
      );
      insert.run({
        market: mint,
        side: 'buy',
        type: 'unitary-entry',
        status: 'rejected',
        quantity_base: 0,
        price: null,
        mint,
        origin,
        decided_ts: nowTs,
        size_tier: 'REJECT',
        notes: JSON.stringify({ gate: verdict, snapshot })
      });
      try {
        const decision = { mint, origin, status: 'rejected' as const, score: 0, tier: 'REJECT' as const, reasons: verdict.reasons };
        bumpSummary(decision);
        await sendDecisionAlert(config, decision, snapshot);
      } catch {}
      return;
    }

    const conv = convictionFromMicro(snapshot, origin);
    const tier = conv.score >= (config.entry.apexScore || 75)
      ? 'APEX'
      : conv.score >= (config.entry.minScore || 50)
        ? 'SMALL'
        : 'REJECT';

    const status = tier === 'REJECT' ? 'rejected' : (config.dryRun ? 'dry_run' : 'pending');

    const insert = d.prepare(
      `INSERT INTO orders (market, side, type, status, quantity_base, price, position_id, mint, origin, decided_ts, size_tier, notes)
       VALUES (@market, @side, @type, @status, @quantity_base, @price, NULL, @mint, @origin, @decided_ts, @size_tier, @notes)`
    );
    insert.run({
      market: mint,
      side: 'buy',
      type: 'unitary-entry',
      status,
      quantity_base: 0,
      price: null,
      mint,
      origin,
      decided_ts: nowTs,
      size_tier: tier,
      notes: JSON.stringify({ gate: verdict, conviction: conv, snapshot })
    });

    try {
      const decision = { mint, origin, status: status as 'rejected' | 'dry_run' | 'pending', score: conv.score, tier: tier as 'APEX' | 'SMALL' | 'REJECT', reasons: conv.reasons };
      bumpSummary(decision);
      await sendDecisionAlert(config, decision, snapshot);
    } catch {}
  } catch (e) {
    logger.warn('evaluateMint error:', (e as Error)?.message ?? e);
  }
}
