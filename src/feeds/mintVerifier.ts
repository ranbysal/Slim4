import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config';

// SPL Token program (original)
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

type CacheRec = { ok: boolean; ts: number };
const cache: Map<string, CacheRec> = new Map();
function getTtlMs(): number {
  try {
    const sec = Math.max(60, Math.floor(config.mintVerify.ttlSec || 3600));
    return sec * 1000;
  } catch { return 3600 * 1000; }
}
const MAX_CACHE = 10_000;

function getNow() { return Date.now(); }

function getCached(addr: string): boolean | undefined {
  const r = cache.get(addr);
  if (!r) return undefined;
  if (getNow() - r.ts > getTtlMs()) { cache.delete(addr); return undefined; }
  return r.ok;
}

function setCached(addr: string, ok: boolean) {
  if (cache.size > MAX_CACHE) {
    // Simple pruning: delete oldest 5%
    const toDelete = Math.max(1, Math.floor(cache.size * 0.05));
    const it = cache.keys();
    for (let i = 0; i < toDelete; i++) {
      const k = it.next();
      if (k.done) break;
      cache.delete(k.value);
    }
  }
  cache.set(addr, { ok, ts: getNow() });
}

export async function isRealSplMint(conn: Connection, addr: string): Promise<boolean> {
  try {
    if (!addr) return false;
    const hit = getCached(addr);
    if (hit !== undefined) return hit;
    const pk = new PublicKey(addr);
    const info = await conn.getAccountInfo(pk, { commitment: 'confirmed' });
    const ok = !!info && info.owner.equals(TOKEN_PROGRAM_ID) && (info.data?.length === 82);
    setCached(addr, ok);
    return ok;
  } catch {
    setCached(addr, false);
    return false;
  }
}
