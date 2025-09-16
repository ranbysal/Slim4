import { Connection, PublicKey } from '@solana/web3.js';
import { Origin, config } from '../config';
import { isRealSplMint } from './mintVerifier';
import { incTxCacheHit, incTxFetchErr } from './state';

type IntrospectResult = { mint?: string; buyer?: string; why?: string };

// Per-signature cache (30 min TTL)
type SigCacheRec = { res: IntrospectResult; ts: number };
const SIG_CACHE = new Map<string, SigCacheRec>();
const SIG_TTL_MS = 30 * 60 * 1000;

// Token-account -> owner cache (60 min TTL)
type OwnerCacheRec = { owner: string | null; ts: number };
const TA_OWNER_CACHE = new Map<string, OwnerCacheRec>();
const TA_OWNER_TTL_MS = 60 * 60 * 1000;

// Simple rate limiter with queue
type Task = {
  signature: string;
  conn: Connection;
  origin: Origin;
  nowTs: number;
  resolve: (r: IntrospectResult) => void;
  reject: (e: unknown) => void;
};
const QUEUE: Task[] = [];
let timer: NodeJS.Timeout | null = null;
let windowStart = Date.now();
let executedInWindow = 0;

// Prevent duplicate in-flight work per signature
const INFLIGHT = new Map<string, Promise<IntrospectResult>>();

function pruneCaches(now: number) {
  for (const [k, v] of SIG_CACHE.entries()) {
    if (now - v.ts > SIG_TTL_MS) SIG_CACHE.delete(k);
  }
  for (const [k, v] of TA_OWNER_CACHE.entries()) {
    if (now - v.ts > TA_OWNER_TTL_MS) TA_OWNER_CACHE.delete(k);
  }
}

function startTimerIfNeeded() {
  if (timer || config.txLookup.qps <= 0) return;
  const periodMs = Math.max(50, Math.floor(1000 / Math.max(1, config.txLookup.qps)));
  timer = setInterval(async () => {
    const now = Date.now();
    if (now - windowStart >= 60_000) {
      windowStart = now;
      executedInWindow = 0;
    }
    const task = QUEUE.shift();
    if (!task) {
      // no work; stop timer to reduce churn
      if (timer) { clearInterval(timer); timer = null; }
      return;
    }
    if (executedInWindow >= config.txLookup.maxPerMin) {
      // over minute cap — skip
      task.resolve({ why: 'rate-cap' });
      return;
    }
    executedInWindow += 1;
    try {
      const res = await doIntrospect(task.conn, task.signature, task.origin, task.nowTs);
      task.resolve(res);
    } catch (e) {
      task.reject(e);
    }
  }, periodMs);
}

function decodeOwnerFromTokenAccountData(data: Buffer): string | null {
  try {
    if (!data || data.length < 64) return null;
    const ownerBytes = data.subarray(32, 64);
    return new PublicKey(ownerBytes).toBase58();
  } catch {
    return null;
  }
}

async function getTokenAccountOwner(conn: Connection, tokenAccount: string): Promise<string | null> {
  const now = Date.now();
  const cached = TA_OWNER_CACHE.get(tokenAccount);
  if (cached && now - cached.ts <= TA_OWNER_TTL_MS) return cached.owner;
  try {
    const info = await conn.getAccountInfo(new PublicKey(tokenAccount), { commitment: 'confirmed' });
    const owner = info?.data ? decodeOwnerFromTokenAccountData(info.data as Buffer) : null;
    TA_OWNER_CACHE.set(tokenAccount, { owner, ts: now });
    return owner;
  } catch {
    TA_OWNER_CACHE.set(tokenAccount, { owner: null, ts: now });
    return null;
  }
}

function getAccountKeysArray(tx: any): string[] {
  try {
    const ak = tx?.transaction?.message?.accountKeys;
    if (Array.isArray(ak)) {
      if (ak.length > 0 && typeof ak[0] === 'string') return ak as string[];
      return (ak as any[]).map((e) => (typeof e === 'string' ? e : e?.pubkey || e?.toString?.() || ''));
    }
  } catch {}
  return [];
}

async function doIntrospect(conn: Connection, signature: string, origin: Origin, nowTs: number): Promise<IntrospectResult> {
  // Only handle pumpfun for now (moonshot future-proof)
  if (config.txLookup.mode === 'off') return {};
  if (config.txLookup.mode === 'pumpfun_only' && origin !== 'pumpfun') return {};

  const now = Date.now();
  pruneCaches(now);

  // Cache per signature
  const hit = SIG_CACHE.get(signature);
  if (hit && now - hit.ts <= SIG_TTL_MS) {
    incTxCacheHit();
    return hit.res;
  }

  // Fetch transaction
  let tx: any;
  try {
    tx = await conn.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    } as any);
  } catch (e) {
    incTxFetchErr();
    return { why: 'tx-fetch-error' };
  }
  if (!tx) {
    return { why: 'no-tx' };
  }

  const meta = tx.meta;
  if (!meta) {
    return { why: 'no-meta' };
  }

  // Gather candidate mints from pre/post token balances
  const pre = (meta.preTokenBalances || []) as any[];
  const post = (meta.postTokenBalances || []) as any[];
  const candidateSet = new Set<string>();
  for (const b of pre) { if (b?.mint) candidateSet.add(b.mint); }
  for (const b of post) { if (b?.mint) candidateSet.add(b.mint); }
  const candidateMints = Array.from(candidateSet);
  if (candidateMints.length === 0) {
    const res: IntrospectResult = { why: 'no-mint-candidates' };
    SIG_CACHE.set(signature, { res, ts: now });
    return res;
  }

  // Compute delta where pre ~ 0 -> post > 0, aggregated per mint
  // Map by key `${mint}:${accountIndex}` to pre/post uiAmount
  const EPS = 1e-9;
  const preMap = new Map<string, number>();
  for (const pb of pre) {
    const key = `${pb.mint}:${pb.accountIndex}`;
    const val = Number(pb?.uiTokenAmount?.uiAmount || 0);
    preMap.set(key, val);
  }
  const deltaByMint = new Map<string, number>();
  for (const pb of post) {
    const key = `${pb.mint}:${pb.accountIndex}`;
    const preVal = preMap.get(key) ?? 0;
    const postVal = Number(pb?.uiTokenAmount?.uiAmount || 0);
    const delta = postVal - preVal;
    if ((preVal <= EPS) && (postVal > EPS) && delta > EPS) {
      deltaByMint.set(pb.mint, (deltaByMint.get(pb.mint) || 0) + delta);
    }
  }

  // Verify SPL mints and sort by delta desc
  const realCandidates: { mint: string; delta: number }[] = [];
  for (const m of candidateMints) {
    try {
      const ok = await isRealSplMint(conn, m);
      if (ok) realCandidates.push({ mint: m, delta: deltaByMint.get(m) || 0 });
    } catch {}
  }
  realCandidates.sort((a, b) => b.delta - a.delta);

  const chosen = realCandidates.length > 0
    ? (realCandidates[0].delta > 0 ? realCandidates[0].mint : realCandidates[0].mint)
    : undefined;
  if (!chosen) {
    const res: IntrospectResult = { why: 'no-real-mint' };
    SIG_CACHE.set(signature, { res, ts: now });
    return res;
  }

  // Derive buyer: find token account whose pre was ~0 and post > 0 for chosen mint
  let buyer: string | undefined;
  try {
    const acctKeys = getAccountKeysArray(tx);
    const postForMint = post.filter((b) => b.mint === chosen);
    let tokenAccountPk: string | null = null;
    for (const pb of postForMint) {
      const key = `${pb.mint}:${pb.accountIndex}`;
      const preVal = preMap.get(key) ?? 0;
      const postVal = Number(pb?.uiTokenAmount?.uiAmount || 0);
      if ((preVal <= EPS) && (postVal > EPS)) {
        const idx: number = pb.accountIndex;
        tokenAccountPk = acctKeys[idx] || null;
        if (tokenAccountPk) break;
      }
    }
    if (tokenAccountPk) {
      const owner = await getTokenAccountOwner(conn, tokenAccountPk);
      if (owner) buyer = owner;
    }
  } catch {}

  const res: IntrospectResult = { mint: chosen, buyer, why: 'mint-selected' };
  SIG_CACHE.set(signature, { res, ts: now });
  return res;
}

export async function extractMintAndBuyerFromSignature(
  conn: Connection,
  signature: string,
  origin: Origin,
  nowTs: number
): Promise<IntrospectResult> {
  // fast-path by config/origin
  if (config.txLookup.mode === 'off') return {};
  if (config.txLookup.mode === 'pumpfun_only' && origin !== 'pumpfun') return {};

  const now = Date.now();
  pruneCaches(now);

  // Return cached if available
  const hit = SIG_CACHE.get(signature);
  if (hit && now - hit.ts <= SIG_TTL_MS) {
    incTxCacheHit();
    return hit.res;
  }

  // Coalesce duplicate in-flight requests
  const inflight = INFLIGHT.get(signature);
  if (inflight) return inflight;

  const p = new Promise<IntrospectResult>((resolve, reject) => {
    QUEUE.push({ signature, conn, origin, nowTs, resolve, reject });
    startTimerIfNeeded();
  });
  INFLIGHT.set(signature, p);
  try {
    const res = await p;
    return res;
  } finally {
    INFLIGHT.delete(signature);
  }
}

