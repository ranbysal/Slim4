import Database from 'better-sqlite3';
import { config, Origin } from '../config';
import { getSnapshot } from '../microstructure/firstNBlocks';
import { safetyGate } from '../risk/safetyGate';
import { convictionFromMicro } from '../alpha/conviction';
import { bumpSummary, sendDecisionAlert } from '../utils/telegram';
import { logger } from '../utils/logger';
import { getEffectiveThresholds, recordAccept as recordHeatAccept } from '../market/heat';

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
    // Ensure unique constraint for single unitary-entry row per market
    try {
      d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_unique_unitary_entry ON orders(market, type) WHERE type='unitary-entry'");
    } catch {}
  } catch (e) {
    logger.warn('ensureOrdersDecisionColumns error:', (e as Error)?.message ?? e);
  }
}

type LastDecision = 'hold' | 'rejected_soft' | 'rejected_fatal' | 'accepted_small' | 'accepted_apex';

type MintDecisionState = {
  firstSeenTs: number;
  lastEvalTs: number;
  bestScore: number;
  lastDecision: LastDecision;
  lastAcceptedTs?: number;
  stickyFatal?: boolean;
  reevalCount: number;
  ttlExpired?: boolean;
};

const states: Map<string, MintDecisionState> = new Map();
const softRejectEvents: number[] = [];
const fatalRejectEvents: number[] = [];

function mintShort(m: string): string {
  if (!m) return '';
  if (m.length <= 10) return m;
  return `${m.slice(0, 4)}…${m.slice(-4)}`;
}

export async function evaluateMint(mint: string, origin: Origin, nowTs: number, creator?: string): Promise<void> {
  try {
    let st = states.get(mint);
    if (!st) {
      st = { firstSeenTs: nowTs, lastEvalTs: 0, bestScore: 0, lastDecision: 'hold', reevalCount: 0 };
      states.set(mint, st);
    }
    // sticky fatal: never re-evaluate
    if (st.stickyFatal) return;
    // Re-eval cooldown (except first eval)
    const reevalMs = (config.entry.reevalCooldownSec || 15) * 1000;
    if (st.lastEvalTs > 0 && nowTs - st.lastEvalTs < reevalMs) return;
    st.lastEvalTs = nowTs;
    st.reevalCount = (st.reevalCount || 0) + 1;

    // TTL drop from pending state
    const ttlMs = Math.max(0, (config.entry.holdTtlSec || 0) * 1000);
    const maxReevals = Math.max(0, config.entry.holdMaxReevals || 0);
    if (!st.ttlExpired && st.lastDecision === 'hold' && (
      (ttlMs > 0 && nowTs - st.firstSeenTs > ttlMs) ||
      (maxReevals > 0 && st.reevalCount >= maxReevals)
    )) {
      st.lastDecision = 'rejected_soft';
      st.ttlExpired = true;
      softRejectEvents.push(nowTs);
      try { bumpSummary({ mint, origin, status: 'rejected_soft', score: 0, tier: 'REJECT', reasons: ['hold_ttl'] }); } catch {}
      return;
    }

    const snapshot = getSnapshot(mint);
    // Heat-adjusted effective thresholds
    const eff = getEffectiveThresholds(nowTs);
    const verdict = safetyGate(snapshot, origin);

    const d = getDb();
    ensureOrdersDecisionColumns(d);
    // Deferred observation gate
    if (snapshot.buyers < (eff.minBuyers || 0) || snapshot.uniqueFunders < (eff.minUnique || 0)) {
      st.lastDecision = 'hold';
      try { bumpSummary({ mint, origin, status: 'hold', score: 0, tier: 'REJECT' }); } catch {}
      return;
    }

    // Safety gate with fatal sticky condition
    if (snapshot.sameFunderRatio > 0.75) {
      // Fatal reject: sticky, alert once, persist a rejected order row
      st.lastDecision = 'rejected_fatal';
      st.stickyFatal = true;
      fatalRejectEvents.push(nowTs);
      try {
        const insert = d.prepare(
          `INSERT OR IGNORE INTO orders (market, side, type, status, quantity_base, price, position_id, mint, origin, decided_ts, size_tier, notes)
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
      } catch {}
      try {
        const decision = { mint, origin, status: 'rejected_fatal' as const, score: 0, tier: 'REJECT' as const, reasons: verdict.reasons };
        bumpSummary(decision);
        await sendDecisionAlert(config, decision, snapshot);
      } catch {}
      return;
    }
    if (!verdict.pass) {
      // soft reject: do not persist sticky, allow reevaluation
      st.lastDecision = 'rejected_soft';
      softRejectEvents.push(nowTs);
      try {
        const decision = { mint, origin, status: 'rejected_soft' as const, score: 0, tier: 'REJECT' as const, reasons: verdict.reasons };
        bumpSummary(decision);
        // no alert for soft rejects
      } catch {}
      return;
    }

    // Gate passed — compute conviction
    const conv = convictionFromMicro(snapshot, origin, mint, nowTs, creator);
    st.bestScore = Math.max(st.bestScore, conv.score);
    let tier: 'APEX' | 'SMALL' | 'REJECT' = 'REJECT';
    if (conv.score >= (eff.apexScore || 75)) tier = 'APEX';
    else if (conv.score >= (eff.minScore || 50)) tier = 'SMALL';

    if (tier === 'REJECT') {
      // remain on hold when score isn't there yet
      st.lastDecision = 'hold';
      try { bumpSummary({ mint, origin, status: 'hold', score: conv.score, tier: 'REJECT', reasons: conv.reasons }); } catch {}
      return;
    }

    // Enforce accept upgrade cooldown
    const acceptCdMs = (config.entry.acceptCooldownSec || 120) * 1000;
    if (tier === 'APEX' && st.lastDecision === 'accepted_small' && st.lastAcceptedTs && (nowTs - st.lastAcceptedTs) < acceptCdMs) {
      // don't upgrade yet
      return;
    }

    const decidedTier = tier;
    const status: 'dry_run' | 'pending' = config.dryRun ? 'dry_run' : 'pending';
    const sizeTier = decidedTier;

    // Single-accept guard: if already accepted for this mint, avoid duplicate rows unless upgrading SMALL→APEX
    if (st.lastDecision === 'accepted_small' || st.lastDecision === 'accepted_apex') {
      const prevTier = st.lastDecision === 'accepted_apex' ? 'APEX' : 'SMALL';
      const isUpgrade = prevTier === 'SMALL' && decidedTier === 'APEX';
      if (!isUpgrade) {
        // already accepted at this or higher tier; keep in-memory updates only
        try { bumpSummary({ mint, origin, status: 'hold', score: st.bestScore, tier: prevTier as any }); } catch {}
        return;
      }
    }

    // UPSERT on (market,type) to upgrade prior rejected row to accepted dry_run
    try {
      const upsert = d.prepare(
        `INSERT INTO orders (market, side, type, status, quantity_base, price, position_id, mint, origin, decided_ts, size_tier, notes)
         VALUES (@market, @side, @type, @status, @quantity_base, @price, NULL, @mint, @origin, @decided_ts, @size_tier, @notes)
         ON CONFLICT(market, type)
         DO UPDATE SET
           status=excluded.status,
           size_tier=excluded.size_tier,
           decided_ts=excluded.decided_ts,
           notes=excluded.notes
         WHERE orders.type='unitary-entry' AND orders.status!='dry_run'`
      );
      upsert.run({
        market: mint,
        side: 'buy',
        type: 'unitary-entry',
        status,
        quantity_base: 0,
        price: null,
        mint,
        origin,
        decided_ts: nowTs,
        size_tier: decidedTier,
        notes: JSON.stringify({ gate: verdict, conviction: conv, snapshot })
      });
    } catch {}

    // Update state and alert for accepts only
    const wasAccepted = st.lastDecision === 'accepted_small' || st.lastDecision === 'accepted_apex';
    st.lastAcceptedTs = nowTs;
    st.lastDecision = decidedTier === 'APEX' ? 'accepted_apex' : 'accepted_small';
    try {
      const decision = { mint, origin, status, score: conv.score, tier: decidedTier, reasons: conv.reasons } as const;
      bumpSummary(decision as any);
      await sendDecisionAlert(config, decision as any, snapshot);
    } catch {}
    try {
      // single-accept: only record first transition non-accepted -> accepted
      if (status === 'dry_run' && !wasAccepted) recordHeatAccept(mint, nowTs);
    } catch {}
  } catch (e) {
    logger.warn('evaluateMint error:', (e as Error)?.message ?? e);
  }
}

export function getDecisionStats(): { pending24h: number; softRejected24h: number } {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  // pending: mints currently in 'hold' with recent evaluation within 24h
  let pending = 0;
  for (const st of states.values()) {
    const ttlMs = Math.max(0, (config.entry.holdTtlSec || 0) * 1000);
    const maxReevals = Math.max(0, config.entry.holdMaxReevals || 0);
    if (
      st.lastDecision === 'hold' &&
      now - (st.lastEvalTs || st.firstSeenTs) <= dayMs &&
      (ttlMs === 0 || now - st.firstSeenTs <= ttlMs) &&
      (maxReevals === 0 || (st.reevalCount || 0) < maxReevals)
    ) pending += 1;
  }
  // soft rejects in last 24h
  const soft = softRejectEvents.filter(ts => now - ts <= dayMs).length;
  // cleanup old timestamps to avoid unbounded growth
  while (softRejectEvents.length && now - softRejectEvents[0] > dayMs) softRejectEvents.shift();
  while (fatalRejectEvents.length && now - fatalRejectEvents[0] > dayMs) fatalRejectEvents.shift();
  return { pending24h: pending, softRejected24h: soft };
}
