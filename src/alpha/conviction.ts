import type { Origin } from '../config';
import type { MicroSnapshot } from '../risk/safetyGate';
import { getCohortBoost } from './cohort';
import { getGrBoost } from './deployerGr';

export type Conviction = { score: number; buckets: Record<string, number>; reasons: string[] };

export function convictionFromMicro(snapshot: MicroSnapshot, _origin: Origin, mint?: string, nowTs?: number, creator?: string): Conviction {
  let score = 0;
  const buckets: Record<string, number> = {};
  const reasons: string[] = [];

  // Buyers tiers: soft >=6 +20, hard >=8 +30
  if (snapshot.buyers >= 8) { score += 30; buckets.buyers = 30; reasons.push('buyers>=8 +30'); }
  else if (snapshot.buyers >= 6) { score += 20; buckets.buyers = 20; reasons.push('buyers>=6 +20'); }

  // Unique funders tiers: soft >=5 +15, hard >=6 +20
  if (snapshot.uniqueFunders >= 6) { score += 20; buckets.funders = 20; reasons.push('uniqueFunders>=6 +20'); }
  else if (snapshot.uniqueFunders >= 5) { score += 15; buckets.funders = 15; reasons.push('uniqueFunders>=5 +15'); }

  // Price jumps tiers: soft >=1 +10, hard >=2 +20
  if (snapshot.priceJumps >= 2) { score += 20; buckets.jumps = 20; reasons.push('priceJumps>=2 +20'); }
  else if (snapshot.priceJumps >= 1) { score += 10; buckets.jumps = 10; reasons.push('priceJumps>=1 +10'); }

  // Depth tiers: soft >=0.30 +10, hard >=0.35 +20
  if (snapshot.depthEst >= 0.35) { score += 20; buckets.depth = 20; reasons.push('depthEst>=0.35 +20'); }
  else if (snapshot.depthEst >= 0.30) { score += 10; buckets.depth = 10; reasons.push('depthEst>=0.30 +10'); }
  if (snapshot.sameFunderRatio > 0.60) { score -= 20; buckets.sameFunder = -20; reasons.push('sameFunderRatio>0.60 -20'); }

  // Cohort boost
  let cohortBoost = 0;
  if (mint && typeof nowTs === 'number') {
    try {
      cohortBoost = getCohortBoost(mint, nowTs) || 0;
      if (cohortBoost > 0) reasons.push('cohortHit');
    } catch {}
  }
  // Deployer GR boost
  let grBoost = 0;
  if (creator) {
    try {
      grBoost = getGrBoost(creator) || 0;
      if (grBoost > 0) reasons.push(`deployerGR:+${grBoost}`);
    } catch {}
  }

  let finalScore = score + cohortBoost + grBoost;
  finalScore = Math.max(0, Math.min(100, finalScore));
  return { score: finalScore, buckets, reasons };
}
