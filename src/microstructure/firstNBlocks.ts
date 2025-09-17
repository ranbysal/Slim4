import type { Origin } from '../config';
import { config } from '../config';
import { incDropInvalidMint } from '../feeds/state';

// Strict helpers for mint/buyer validation
const DENYLIST_IDS = new Set<string>([
  'ComputeBudget111111111111111111111111111111',
  '11111111111111111111111111111111',
  'Stake11111111111111111111111111111111111111',
  'Vote111111111111111111111111111111111111111',
  'Sysvar1111111111111111111111111111111111111',
  'Config1111111111111111111111111111111111111'
]);

function isBase58Len32to44(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

function isValidMint(addr: string | undefined | null): boolean {
  if (!addr) return false;
  if (!isBase58Len32to44(addr)) return false;
  if (DENYLIST_IDS.has(addr)) return false;
  if (isSubscribedProgram(addr)) return false;
  return true;
}

function isLikelyBuyer(addr: string | undefined | null): boolean {
  return isValidMint(addr || '');
}

// In-memory microstructure tracker for the first N blocks/minutes after a mint appears.
// Lightweight, best-effort parsing from raw logs. This is a stub for future sophistication.

type Event = {
  ts: number;
  raw: string;
  funder?: string;
  buyer?: string;
  price?: number;
};

type MintState = {
  origin: Origin;
  firstTs: number;
  lastTs: number;
  events: Event[];
  funderCounts: Map<string, number>;
  priceJumps: number;
  lastPrice?: number;
  lastEmitTs?: number;
  lastSnapshot?: {
    buyers: number;
    uniqueFunders: number;
    sameFunderRatio: number;
    priceJumps: number;
    depthEst: number;
    lastTs: number;
  };
};

const states: Map<string, MintState> = new Map();

function extractFunder(raw: string, mint: string): string | undefined {
  // Very loose base58-ish match; pick a candidate that isn't the mint.
  const b58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
  const cands = Array.from(raw.matchAll(b58)).map(m => m[0]);
  const cand = cands.find(c => c !== mint && isLikelyBuyer(c));
  return cand;
}

// Helper derived from union of configured program IDs; treat these as invalid mints/buyers
const SUB_PROGRAM_IDS = new Set<string>([
  ...config.programs.pumpfun,
  ...config.programs.letsbonk,
  ...config.programs.moonshot,
  ...config.programs.raydium,
  ...config.programs.orca
].map(s => (s || '').trim()).filter(Boolean));
function isSubscribedProgram(addr: string): boolean {
  try { return SUB_PROGRAM_IDS.has(addr); } catch { return false; }
}

function extractPrice(raw: string): number | undefined {
  // Look for price-like tokens: price=0.123 or p:0.01
  const m = raw.match(/(?:price|p)[=:]\s*([0-9]*\.?[0-9]+)/i);
  if (!m) return undefined;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : undefined;
}

export function trackFirstN(
  mint: string,
  origin: Origin,
  logTs: number,
  rawLog: string
): { buyer?: string; snapshot: { buyers: number; uniqueFunders: number; sameFunderRatio: number; priceJumps: number; depthEst: number; lastTs: number; changed: boolean } } | void {
  if (!mint) return;
  if (!isValidMint(mint)) {
    // Count drops for program-id-as-mint scenarios
    try { if (isSubscribedProgram(mint)) incDropInvalidMint(); } catch {}
    return;
  }
  const now = logTs || Date.now();
  let st = states.get(mint);
  if (!st) {
    st = {
      origin,
      firstTs: now,
      lastTs: now,
      events: [],
      funderCounts: new Map(),
      priceJumps: 0
    };
    states.set(mint, st);
  }
  st.lastTs = now;

  const funder = extractFunder(rawLog, mint);
  if (funder) st.funderCounts.set(funder, (st.funderCounts.get(funder) || 0) + 1);

  const price = extractPrice(rawLog);
  if (price !== undefined && st.lastPrice !== undefined) {
    const prev = st.lastPrice;
    if (prev > 0 && Math.abs(price - prev) / prev >= 0.1) {
      st.priceJumps += 1;
    }
  }
  if (price !== undefined) st.lastPrice = price;

  st.events.push({ ts: now, raw: rawLog, funder, buyer: funder, price });
  // Cap memory per mint to a small window (e.g. last 100 events)
  if (st.events.length > 100) st.events.shift();

  // Compute snapshot and detect material change
  const snap = getSnapshot(mint);
  const prev = st.lastSnapshot;
  const tNow = now;
  let changed = false;
  const emitEveryMs = 5000;
  if (!prev) {
    changed = true;
  } else {
    const buyersChanged = snap.buyers !== prev.buyers;
    const uniqueChanged = snap.uniqueFunders !== prev.uniqueFunders;
    const jumpsChanged = snap.priceJumps !== prev.priceJumps;
    const depthChanged = Math.abs(snap.depthEst - prev.depthEst) >= 0.02;
    const sameChanged = Math.abs(snap.sameFunderRatio - prev.sameFunderRatio) >= 0.02;
    const timeElapsed = (st.lastEmitTs ? (tNow - st.lastEmitTs) : emitEveryMs + 1) >= emitEveryMs;
    changed = buyersChanged || uniqueChanged || depthChanged || sameChanged || jumpsChanged || timeElapsed;
  }
  if (changed) {
    st.lastEmitTs = tNow;
    st.lastSnapshot = { ...snap };
  }

  // Expose buyer/pubkey if present, and snapshot+changed flag
  if (funder) return { buyer: funder, snapshot: { ...snap, changed } };
  return { snapshot: { ...snap, changed } };
}

export function getSnapshot(mint: string): {
  buyers: number;
  uniqueFunders: number;
  sameFunderRatio: number;
  priceJumps: number;
  depthEst: number;
  lastTs: number;
} {
  const st = states.get(mint);
  if (!st) {
    return { buyers: 0, uniqueFunders: 0, sameFunderRatio: 0, priceJumps: 0, depthEst: 0, lastTs: 0 };
  }
  const buyers = st.events.length;
  const uniqueFunders = st.funderCounts.size;
  let sameFunderRatio = 0;
  if (buyers > 0 && uniqueFunders > 0) {
    let maxCount = 0;
    for (const c of st.funderCounts.values()) maxCount = Math.max(maxCount, c);
    sameFunderRatio = maxCount / buyers;
  }
  // Naive depth estimate: scale by event count into 0..1
  const depthEst = Math.max(0, Math.min(1, buyers / 20));
  return {
    buyers,
    uniqueFunders,
    sameFunderRatio,
    priceJumps: st.priceJumps,
    depthEst,
    lastTs: st.lastTs
  };
}

export function score(mint: string): { microScore: number; reasons: string[] } {
  const s = getSnapshot(mint);
  let score = 0;
  const reasons: string[] = [];

  if (s.buyers >= 5) { score += 10; reasons.push('buyers>=5'); }
  if (s.buyers >= 10) { score += 10; reasons.push('buyers>=10'); }
  if (s.uniqueFunders >= 3) { score += 10; reasons.push('uniqueFunders>=3'); }
  if (s.sameFunderRatio <= 0.6 && s.buyers >= 5) { score += 10; reasons.push('diverseFunders'); }
  if (s.priceJumps <= 3 && s.buyers >= 5) { score += 5; reasons.push('stablePrice'); }
  if (s.priceJumps > 6) { score -= 10; reasons.push('volatilePrice'); }

  // Normalize to 0..100 bounds
  score = Math.max(0, Math.min(100, score));
  return { microScore: score, reasons };
}

export function resetExpired(ttlMs = 120_000): void {
  const now = Date.now();
  for (const [mint, st] of states.entries()) {
    if (now - st.lastTs > ttlMs) states.delete(mint);
  }
}

// Lightweight summary helpers for the status page
export function getSummary(): { trackedMints: number; recentSnapshots: number } {
  const now = Date.now();
  let recent = 0;
  for (const st of states.values()) {
    if (now - st.lastTs <= 30_000) recent += 1;
  }
  return { trackedMints: states.size, recentSnapshots: recent };
}
