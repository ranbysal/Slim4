// Pump.fun quote estimator using @pump-fun/pump-sdk.
// Silent best-effort: on any error, return null.

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  PumpSdk,
  GLOBAL_PDA,
  bondingCurvePda,
  getBuyTokenAmountFromSolAmount,
  createFeeConfigFromGlobalConfig,
} from '@pump-fun/pump-sdk';
import BN from 'bn.js';
import { logger } from '../utils/logger';

type GlobalCache = { ts: number; global: any } | null;
type MintBuyState = { ts: number; bondingCurve: any; decimals: number };

const TTL_MS = 60_000; // 60s per-mint/global cache

let SDK: PumpSdk | null = null;
let GLOBAL_STATE: GlobalCache = null;
const BUY_STATE = new Map<string, MintBuyState>();
const LOGGED_MINTS = new Set<string>();

// Very small global RPC QPS limiter for safety (best-effort)
const MAX_QPS = 8; // hard cap across all estimator reads
const callTimestamps: number[] = [];
async function rateLimit(): Promise<void> {
  try {
    const now = Date.now();
    // drop anything older than 1s
    while (callTimestamps.length > 0 && now - callTimestamps[0] > 1000) callTimestamps.shift();
    if (callTimestamps.length < MAX_QPS) {
      callTimestamps.push(now);
      return;
    }
    // wait until a slot frees up
    const waitMs = Math.max(5, 1000 - (now - callTimestamps[0]));
    await new Promise((r) => setTimeout(r, waitMs));
    return rateLimit();
  } catch {}
}

async function safeGetAccountInfo(conn: Connection, pk: PublicKey) {
  try {
    await rateLimit();
    return await conn.getAccountInfo(pk, { commitment: 'confirmed' });
  } catch {
    return null;
  }
}

async function safeGetParsedAccountInfo(conn: Connection, pk: PublicKey) {
  try {
    await rateLimit();
    return await conn.getParsedAccountInfo(pk, { commitment: 'confirmed' });
  } catch {
    return { value: null } as any;
  }
}

async function loadGlobal(conn: Connection, now: number): Promise<any | null> {
  try {
    if (GLOBAL_STATE && now - GLOBAL_STATE.ts <= TTL_MS) return GLOBAL_STATE.global;
    if (!SDK) SDK = new PumpSdk();
    const ai = await safeGetAccountInfo(conn, GLOBAL_PDA);
    if (!ai) return null;
    const global = SDK.decodeGlobal(ai as any);
    GLOBAL_STATE = { ts: now, global };
    return global;
  } catch {
    return null;
  }
}

async function loadBuyState(conn: Connection, mintStr: string, now: number): Promise<{ bondingCurve: any; decimals: number } | null> {
  try {
    const hit = BUY_STATE.get(mintStr);
    if (hit && now - hit.ts <= TTL_MS) return { bondingCurve: hit.bondingCurve, decimals: hit.decimals };
    if (!SDK) SDK = new PumpSdk();
    const mint = new PublicKey(mintStr);
    // Derive bonding curve PDA and fetch + decode
    const bcPda = bondingCurvePda(mint);
    const bcAi = await safeGetAccountInfo(conn, bcPda as any);
    if (!bcAi) return null;
    const bondingCurve = SDK.decodeBondingCurveNullable(bcAi as any);
    if (!bondingCurve) return null;
    // Fetch mint decimals via parsed account
    const mintInfo = await safeGetParsedAccountInfo(conn, mint);
    const decimals = (() => {
      try {
        const v: any = mintInfo.value;
        const p = v?.data?.parsed;
        const info = p?.info;
        const d = info?.decimals;
        if (typeof d === 'number' && isFinite(d)) return d;
      } catch {}
      return 0;
    })();
    BUY_STATE.set(mintStr, { ts: now, bondingCurve, decimals });
    return { bondingCurve, decimals };
  } catch {
    return null;
  }
}

export async function estimateQuote(
  conn: Connection,
  mint: string,
  sizeSol: number,
  nowTs: number
): Promise<{ estFillPriceSol: number | null; estSlippageBps: number | null; reserves?: any } | null> {
  try {
    // Log once per mint that the estimator is enabled
    if (!LOGGED_MINTS.has(mint)) {
      LOGGED_MINTS.add(mint);
      try { logger.info('estimator: pumpfun enabled'); } catch {}
    }
    const now = nowTs || Date.now();
    if (!conn) return null;
    if (!mint || !Number.isFinite(sizeSol) || sizeSol <= 0) return null;
    const global = await loadGlobal(conn, now);
    if (!global) return null;
    const bs = await loadBuyState(conn, mint, now);
    if (!bs) return null;
    const { bondingCurve, decimals } = bs;

    // Compute token out including fees: use global fee config
    const lamports = new BN(Math.floor(sizeSol * LAMPORTS_PER_SOL));
    const feeConfig = (() => {
      try { return createFeeConfigFromGlobalConfig(global); } catch { return null; }
    })();
    const tokenOutBn = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig: feeConfig as any,
      mintSupply: bondingCurve?.tokenTotalSupply ?? null,
      bondingCurve,
      amount: lamports,
    } as any);

    if (!tokenOutBn || tokenOutBn.lten(0)) return null;

    const tokenOut = tokenOutBn.toNumber() / Math.pow(10, Math.max(0, decimals));
    if (!isFinite(tokenOut) || tokenOut <= 0) return null;
    const avgPriceSolPerToken = sizeSol / tokenOut; // includes fees via feeConfig above
    if (!isFinite(avgPriceSolPerToken) || avgPriceSolPerToken <= 0) return null;

    return { estFillPriceSol: avgPriceSolPerToken, estSlippageBps: null };
  } catch {
    return null;
  }
}
