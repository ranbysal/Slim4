import { config } from '../config';

// Simple per-minute ring buffer for accepted decisions
// Accepts/hr = sum(counts in window) * (60 / windowMin)

type HeatBand = 'COLD' | 'NEUTRAL' | 'HOT';

let ring: number[] = new Array(Math.max(1, config.heat.windowMin)).fill(0);
let lastAbsMinute = Math.floor(Date.now() / 60000);

function ensureRingSize() {
  const want = Math.max(1, config.heat.windowMin);
  if (ring.length === want) return;
  // resize while preserving last minutes if possible
  const old = ring;
  ring = new Array(want).fill(0);
  const nowMin = Math.floor(Date.now() / 60000);
  const span = Math.min(old.length, want);
  for (let i = 0; i < span; i++) {
    const m = nowMin - i;
    const oldIdx = ((m % old.length) + old.length) % old.length;
    const newIdx = ((m % want) + want) % want;
    ring[newIdx] = old[oldIdx];
  }
  lastAbsMinute = nowMin;
}

function advanceTo(minute: number) {
  // zero buckets between lastAbsMinute+1 .. minute inclusive
  if (minute <= lastAbsMinute) return;
  const len = ring.length;
  for (let m = lastAbsMinute + 1; m <= minute; m++) {
    const idx = ((m % len) + len) % len;
    ring[idx] = 0;
  }
  lastAbsMinute = minute;
}

export function recordAccept(ts: number): void {
  if (!config.heat.enabled) return;
  ensureRingSize();
  const m = Math.floor(ts / 60000);
  advanceTo(m);
  const idx = m % ring.length;
  ring[idx] += 1;
}

export function getAcceptsPerHour(nowTs: number): number {
  if (!config.heat.enabled) return 0;
  ensureRingSize();
  const m = Math.floor(nowTs / 60000);
  advanceTo(m);
  const sum = ring.reduce((a, b) => a + b, 0);
  const scale = 60 / Math.max(1, config.heat.windowMin);
  return sum * scale;
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

  const minScore = clamp(baseMinScore + heat.deltas.scoreDelta, floorScore, ceilScore);
  const apexScore = clamp(baseApexScore + heat.deltas.scoreDelta, floorScore, ceilScore);
  const minBuyers = clamp(baseMinBuyers + heat.deltas.buyersDelta, floorBuyers, ceilBuyers);
  const minUnique = clamp(baseMinUnique + heat.deltas.buyersDelta, Math.max(0, floorBuyers - 1), Math.max(0, ceilBuyers - 2));

  return { minScore, apexScore, minBuyers, minUnique, heat };
}

export function getHeatStatus(nowTs: number) {
  const eff = getEffectiveThresholds(nowTs);
  return {
    acceptsPerHr: Number(eff.heat.acceptsPerHr.toFixed(2)),
    band: eff.heat.band,
    deltas: eff.heat.deltas,
    effective: {
      minScore: eff.minScore,
      apexScore: eff.apexScore,
      minBuyers: eff.minBuyers,
      minUnique: eff.minUnique
    }
  };
}

