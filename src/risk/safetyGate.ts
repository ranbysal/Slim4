import type { Origin } from '../config';

export type GateVerdict = { pass: boolean; reasons: string[] };

export type MicroSnapshot = {
  buyers: number;
  uniqueFunders: number;
  sameFunderRatio: number;
  priceJumps: number;
  depthEst: number;
  lastTs: number;
};

export function safetyGate(snapshot: MicroSnapshot, _origin: Origin): GateVerdict {
  const reasons: string[] = [];
  let pass = true;

  if (snapshot.buyers < 4) { pass = false; reasons.push('buyers<4'); }
  if (snapshot.sameFunderRatio > 0.70) { pass = false; reasons.push('sameFunderRatio>0.70'); }
  if (snapshot.depthEst < 0.15) { pass = false; reasons.push('depthEst<0.15'); }

  if (pass) {
    reasons.push('buyers>=4', 'sameFunderRatio<=0.70', 'depthEst>=0.15');
  }

  return { pass, reasons };
}

