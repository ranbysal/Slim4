import type { Origin } from '../config';

let tokensSeen24h = 0;
let tokensInserted24h = 0;
let lastReset = Date.now();

let subscribedPrograms = 0;
let lastEventTs: number | null = null;
const byOrigin: Record<Origin, number> = {
  pumpfun: 0,
  letsbonk: 0,
  moonshot: 0,
  raydium: 0,
  orca: 0
};

function maybeReset() {
  const now = Date.now();
  const elapsed = now - lastReset;
  if (elapsed > 24 * 60 * 60 * 1000) {
    tokensSeen24h = 0;
    tokensInserted24h = 0;
    lastReset = now;
  }
}

export function incSeen() {
  maybeReset();
  tokensSeen24h += 1;
}

export function incInserted() {
  maybeReset();
  tokensInserted24h += 1;
}

export function setSubscribedPrograms(n: number) {
  subscribedPrograms = Math.max(0, Math.floor(n || 0));
}

export function setLastEventTs(ts: number) {
  lastEventTs = ts;
}

export function incByOrigin(origin: Origin) {
  byOrigin[origin] = (byOrigin[origin] || 0) + 1;
}

export function getFeedCounters() {
  maybeReset();
  return { tokensSeen24h, tokensInserted24h };
}

export function getFeedStatus() {
  maybeReset();
  return {
    subscribedPrograms,
    byOrigin: { ...byOrigin },
    lastEventTs,
    tokensSeen24h,
    tokensInserted24h
  };
}
