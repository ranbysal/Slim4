// Smart-money cohort tracking and boost logic
// Env: COHORT_WALLETS (CSV of base58), COHORT_BOOST=15, COHORT_DECAY_SEC=600

type CohortHit = { mint: string; buyer: string; ts: number };

function parseCsvBase58(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  const arr = (raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => s.length >= 32 && s.length <= 44);
  return new Set(arr);
}

const COHORT_SET: Set<string> = parseCsvBase58(process.env.COHORT_WALLETS);
const COHORT_BOOST = Number(process.env.COHORT_BOOST ?? 15) || 0;
const COHORT_DECAY_SEC = Number(process.env.COHORT_DECAY_SEC ?? 600) || 0; // seconds

// Per-mint last cohort hit timestamp
const lastHitTsByMint: Map<string, number> = new Map();
// Rolling list of recent hits (cap to 100 to bound memory)
const recentHits: CohortHit[] = [];

export function loadCohort(): Set<string> {
  return COHORT_SET;
}

export function hitCohort(mint: string, buyer: string, ts: number): void {
  if (!mint || !buyer || !Number.isFinite(ts)) return;
  if (!COHORT_SET.has(buyer)) return;
  lastHitTsByMint.set(mint, ts);
  recentHits.push({ mint, buyer, ts });
  // cap list size
  if (recentHits.length > 100) recentHits.shift();
}

export function getCohortBoost(mint: string, nowTs: number): number {
  if (!mint || !Number.isFinite(nowTs)) return 0;
  if (COHORT_BOOST <= 0 || COHORT_DECAY_SEC <= 0) return 0;
  const last = lastHitTsByMint.get(mint);
  if (!last) return 0;
  if (nowTs - last <= COHORT_DECAY_SEC * 1000) return COHORT_BOOST;
  return 0;
}

export function getCohortStatus(): { size: number; recentHits: CohortHit[] } {
  const last10 = recentHits
    .slice(-10)
    .slice() // shallow copy
    .reverse(); // newest first
  return { size: COHORT_SET.size, recentHits: last10 };
}

