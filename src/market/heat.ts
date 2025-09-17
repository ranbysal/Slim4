import { config } from '../config';

// Distinct-mint accepts, tracked via per-minute sliding window sets.
// Accepts/hr = distinct mints over last windowMin minutes scaled to 60/windowMin.

type HeatBand = 'COLD' | 'NEUTRAL' | 'HOT';

const MIN_RING_MINUTES = 60; // always keep 60m to compute last-hour distinct
let ring: Array<Set<string>> = new Array(Math.max(MIN_RING_MINUTES, config.heat.windowMin))
  .fill(null as any)
  .map(() => new Set<string>());
let lastAbsMinute = Math.floor(Date.now() / 60000);

function ensureRingSize() {
  const want = Math.max(MIN_RING_MINUTES, config.heat.windowMin);
  if (ring.length === want) return;
  // resize while preserving sets aligned by absolute minute
  const old = ring;
  ring = new Array(want).fill(null as any).map(() => new Set<string>());
  const nowMin = Math.floor(Date.now() / 60000);
  const minSpan = Math.min(old.length, want);
  for (let i = 0; i < minSpan; i++) {
    const m = nowMin - i;
    const oldIdx = ((m % old.length) + old.length) % old.length;
    const newIdx = ((m % want) + want) % want;
    // merge old set into new slot
    for (const mint of old[oldIdx]) ring[newIdx].add(mint);
  }
  lastAbsMinute = nowMin;
}

function advanceTo(minute: number) {
  // zero buckets between lastAbsMinute+1 .. minute inclusive
  if (minute <= lastAbsMinute) return;
  const len = ring.length;
  for (let m = lastAbsMinute + 1; m <= minute; m++) {
    const idx = ((m % len) + len) % len;
    ring[idx] = new Set<string>();
  }
  lastAbsMinute = minute;
}

export function recordAccept(mint: string, ts: number): void {
  if (!config.heat.enabled) return;
  ensureRingSize();
  const m = Math.floor(ts / 60000);
  advanceTo(m);
  const idx = m % ring.length;
  ring[idx].add(mint);
}

export function getAcceptsPerHour(nowTs: number): number {
  if (!config.heat.enabled) return 0;
  ensureRingSize();
  const m = Math.floor(nowTs / 60000);
  advanceTo(m);
  // Distinct over last windowMin minutes
  const window = Math.max(1, config.heat.windowMin);
  const seen = new Set<string>();
  for (let i = 0; i < Math.min(window, ring.length); i++) {
    const minute = m - i;
    const idx = ((minute % ring.length) + ring.length) % ring.length;
    for (const mint of ring[idx]) seen.add(mint);
  }
  const count = seen.size;
  const scale = 60 / Math.max(1, window);
  return count * scale;
}

export function getHeat(nowTs: number): {
  band: HeatBand;
  acceptsPerHr: number;
  deltas: { scoreDelta: number; buyersDelta: number };
} {
  if (!config.heat.enabled) {
    return { band: 'NEUTRAL', acceptsPerHr: 0, deltas: { scoreDelta: 0, buyersDelta: 0 } };
  }
  const aPerHr = getAcceptsPerHour(nowTs);
  let band: HeatBand = 'NEUTRAL';
  if (aPerHr < config.heat.minAcceptsPerHr) band = 'COLD';
  else if (aPerHr > config.heat.maxAcceptsPerHr) band = 'HOT';

  let scoreDelta = 0;
  let buyersDelta = 0;
  if (band === 'COLD') {
    scoreDelta = -Math.abs(config.heat.loosenDelta.score);
    buyersDelta = -Math.abs(config.heat.loosenDelta.buyers);
  } else if (band === 'HOT') {
    scoreDelta = Math.abs(config.heat.tightenDelta.score);
    buyersDelta = Math.abs(config.heat.tightenDelta.buyers);
  }
  return { band, acceptsPerHr: aPerHr, deltas: { scoreDelta, buyersDelta } };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function getEffectiveThresholds(nowTs: number): {
  minScore: number;
  apexScore: number;
  minBuyers: number;
  minUnique: number;
  heat: ReturnType<typeof getHeat>;
} {
  const heat = getHeat(nowTs);
  const baseMinScore = config.entry.minScore;
  const baseApexScore = config.entry.apexScore;
  const baseMinBuyers = config.entry.minObsBuyers;
  const baseMinUnique = config.entry.minObsUnique;

  const floorScore = config.heat.floor.score;
  const ceilScore = config.heat.ceil.score;
  const floorBuyers = config.heat.floor.buyers;
  const ceilBuyers = config.heat.ceil.buyers;

  // Cold-tape effective floors (do not change apex floor)
  // When band === COLD, apply floors: minScore:40, minBuyers:5, minUnique:4
  const coldFloorScore = Math.max(floorScore, 40);
  const coldFloorBuyers = Math.max(floorBuyers, 5);
  const coldFloorUnique = Math.max(4, Math.max(0, floorBuyers - 1));

  const effFloorScoreForMin = heat.band === 'COLD' ? coldFloorScore : floorScore;
  const effFloorBuyersForMin = heat.band === 'COLD' ? coldFloorBuyers : floorBuyers;
  const effFloorUniqueForMin = heat.band === 'COLD' ? coldFloorUnique : Math.max(0, floorBuyers - 1);

  const minScore = clamp(baseMinScore + heat.deltas.scoreDelta, effFloorScoreForMin, ceilScore);
  // Keep apexScore unchanged by heat deltas (only clamp to config bounds)
  const apexScore = clamp(baseApexScore, floorScore, ceilScore);
  const minBuyers = clamp(baseMinBuyers + heat.deltas.buyersDelta, effFloorBuyersForMin, ceilBuyers);
  const minUnique = clamp(
    baseMinUnique + heat.deltas.buyersDelta,
    effFloorUniqueForMin,
    Math.max(0, ceilBuyers - 2)
  );

  return { minScore, apexScore, minBuyers, minUnique, heat };
}

export function getHeatStatus(nowTs: number) {
  const eff = getEffectiveThresholds(nowTs);
  // Distinct accepted mints in the last hour (60 minutes)
  let acceptedDistinctInLastHour = 0;
  try {
    const m = Math.floor(nowTs / 60000);
    const seen = new Set<string>();
    for (let i = 0; i < Math.min(60, ring.length); i++) {
      const minute = m - i;
      const idx = ((minute % ring.length) + ring.length) % ring.length;
      for (const mint of ring[idx]) seen.add(mint);
    }
    acceptedDistinctInLastHour = seen.size;
  } catch {}
  return {
    acceptsPerHr: Number(eff.heat.acceptsPerHr.toFixed(2)),
    band: eff.heat.band,
    deltas: eff.heat.deltas,
    acceptedDistinctInLastHour,
    effective: {
      minScore: eff.minScore,
      apexScore: eff.apexScore,
      minBuyers: eff.minBuyers,
      minUnique: eff.minUnique
    }
  };
}
