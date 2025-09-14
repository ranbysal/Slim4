import fs from 'fs';
import path from 'path';

type GrStatus = { rowsLoaded: number; top: Array<{ creator: string; gr: number }> };

const CSV_PATH = process.env.DEPLOYER_GR_CSV || './data/deployer_gr.csv';
const SAMPLE_PATH = './data/deployer_gr.sample.csv';

let grMap: Map<string, number> | null = null;
let status: GrStatus = { rowsLoaded: 0, top: [] };

function parseCsvToMap(filePath: string): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('#')) continue;
      if (/^creator\s*,/i.test(trimmed)) continue; // header
      const [creatorRaw, grRaw] = trimmed.split(',');
      const creator = (creatorRaw || '').trim();
      const grNum = Number((grRaw || '').trim());
      if (!creator || !Number.isFinite(grNum)) continue;
      const gr = Math.max(0, Math.min(1, grNum));
      out.set(creator, gr);
    }
  } catch {
    // ignore
  }
  return out;
}

function ensureLoaded(): void {
  if (grMap) return;
  const primary = path.resolve(CSV_PATH);
  const sample = path.resolve(SAMPLE_PATH);
  let loaded: Map<string, number> = new Map();
  if (fs.existsSync(primary)) {
    loaded = parseCsvToMap(primary);
  } else if (fs.existsSync(sample)) {
    loaded = parseCsvToMap(sample);
  } else {
    loaded = new Map();
  }
  grMap = loaded;
  // compute status
  const entries = Array.from(loaded.entries());
  entries.sort((a, b) => b[1] - a[1]);
  status = {
    rowsLoaded: loaded.size,
    top: entries.slice(0, 5).map(([creator, gr]) => ({ creator, gr }))
  };
}

export function loadGr(): Map<string, number> {
  ensureLoaded();
  return grMap as Map<string, number>;
}

export function getGrBoost(creator: string | undefined | null): number {
  if (!creator) return 0;
  ensureLoaded();
  const gr = (grMap as Map<string, number>).get(creator);
  if (gr === undefined) return 0;
  if (gr >= 0.8) return 15;
  if (gr >= 0.6) return 10;
  if (gr >= 0.4) return 5;
  return 0;
}

export function getDeployerGrStatus(): GrStatus {
  ensureLoaded();
  return status;
}

