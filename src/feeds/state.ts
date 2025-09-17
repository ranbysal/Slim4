import type { Origin } from '../config';

let tokensSeen24h = 0;
let tokensInserted24h = 0;
let eventsWritten24h = 0;
let quotesWritten24h = 0;
const dropCounters = {
  invalidMint: 0,
  duplicateInBatch: 0,
  notMint: 0,
  // tx introspection metrics
  txNoMint: 0,
  txCacheHit: 0,
  txFetchErr: 0
};
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

// Precision parser hit/miss counters
const parserCounters = {
  pumpfunHits: 0,
  pumpfunMiss: 0,
  moonshotHits: 0,
  moonshotMiss: 0
};

// Quote write/error counters (lifetime in-process)
let quotesWritten = 0;
let quotesErrors = 0;

function maybeReset() {
  const now = Date.now();
  const elapsed = now - lastReset;
  if (elapsed > 24 * 60 * 60 * 1000) {
    tokensSeen24h = 0;
    tokensInserted24h = 0;
    eventsWritten24h = 0;
    quotesWritten24h = 0;
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
    tokensInserted24h,
    dropCounters: { ...dropCounters },
    parserCounters: { ...parserCounters },
    quotes: { written: quotesWritten, errors: quotesErrors }
  };
}

export function incDropInvalidMint() {
  dropCounters.invalidMint += 1;
}

export function incDropDuplicateInBatch() {
  dropCounters.duplicateInBatch += 1;
}

export function incDropNotMint() {
  dropCounters.notMint += 1;
}

// New counters for tx introspection
export function incDropTxNoMint() {
  dropCounters.txNoMint += 1;
}

export function incTxCacheHit() {
  dropCounters.txCacheHit += 1;
}

export function incTxFetchErr() {
  dropCounters.txFetchErr += 1;
}

// Parser counters helpers
export function incPumpfunParserHit() {
  parserCounters.pumpfunHits += 1;
}
export function incPumpfunParserMiss() {
  parserCounters.pumpfunMiss += 1;
}
export function incMoonshotParserHit() {
  parserCounters.moonshotHits += 1;
}
export function incMoonshotParserMiss() {
  parserCounters.moonshotMiss += 1;
}

// Recorder counters
export function incEventsWritten24h(n: number) {
  maybeReset();
  eventsWritten24h += Math.max(0, n || 0);
}
export function incQuotesWritten24h(n: number) {
  maybeReset();
  quotesWritten24h += Math.max(0, n || 0);
}
export function incQuotesWritten(n: number) {
  quotesWritten += Math.max(0, n || 0);
}
export function incQuotesErrors(n: number) {
  quotesErrors += Math.max(0, n || 0);
}

export function getRecorder24h() {
  maybeReset();
  return { eventsWritten24h, quotesWritten24h };
}
