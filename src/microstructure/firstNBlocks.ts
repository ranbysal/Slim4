import type { Origin } from '../config';

// In-memory microstructure tracker for the first N blocks/minutes after a mint appears.
// Lightweight, best-effort parsing from raw logs. This is a stub for future sophistication.

type Event = {
  ts: number;
  raw: string;
  funder?: string;
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
};

const states: Map<string, MintState> = new Map();

function extractFunder(raw: string, mint: string): string | undefined {
  // Very loose base58-ish match; pick a candidate that isn't the mint.
  const b58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
  const cands = Array.from(raw.matchAll(b58)).map(m => m[0]);
  const cand = cands.find(c => c !== mint);
  return cand;
}

function extractPrice(raw: string): number | undefined {
  // Look for price-like tokens: price=0.123 or p:0.01
  const m = raw.match(/(?:price|p)[=:]\s*([0-9]*\.?[0-9]+)/i);
  if (!m) return undefined;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : undefined;
}

export function trackFirstN(mint: string, origin: Origin, logTs: number, rawLog: string): void {
  if (!mint) return;
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

  st.events.push({ ts: now, raw: rawLog, funder, price });
  // Cap memory per mint to a small window (e.g. last 100 events)
  if (st.events.length > 100) st.events.shift();
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
