// Pump.fun quote estimator using @pump-fun/pump-sdk.
// Silent best-effort: on any error, return null.

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { PumpSdk, OnlinePumpSdk, getBuyTokenAmountFromSolAmount, GLOBAL_PDA } from '@pump-fun/pump-sdk';
import BN from 'bn.js';
import { config } from '../config';

type GlobalCache = { ts: number; global: any } | null;
type MintBuyState = { ts: number; bondingCurve: any; decimals: number };

const TTL_MS = 60_000; // 60s

let CONN: Connection | null = null;
let SDK: PumpSdk | null = null;
let GLOBAL_STATE: GlobalCache = null;
const BUY_STATE = new Map<string, MintBuyState>();

function getConn(): Connection | null {
  try {
    if (CONN) return CONN;
    const rpc = (config.rpc.httpPrimary && config.rpc.httpPrimary.trim())
      ? config.rpc.httpPrimary.trim()
      : (config.rpc.httpBackup || '').trim();
    if (!rpc) return null;
    CONN = new Connection(rpc, { commitment: 'confirmed' });
    return CONN;
  } catch {
    return null;
  }
}

async function loadGlobal(now: number): Promise<any | null> {
  try {
    if (GLOBAL_STATE && now - GLOBAL_STATE.ts <= TTL_MS) return GLOBAL_STATE.global;
    const conn = getConn();
    if (!conn) return null;
    if (!SDK) SDK = new PumpSdk();
    const ai = await conn.getAccountInfo(GLOBAL_PDA, { commitment: 'confirmed' });
    if (!ai) return null;
    const global = SDK.decodeGlobal(ai as any);
    GLOBAL_STATE = { ts: now, global };
    return global;
  } catch {
    return null;
  }
}

async function loadBuyState(mintStr: string, now: number): Promise<{ bondingCurve: any; decimals: number } | null> {
  try {
    const hit = BUY_STATE.get(mintStr);
    if (hit && now - hit.ts <= TTL_MS) return { bondingCurve: hit.bondingCurve, decimals: hit.decimals };
    const conn = getConn();
    if (!conn) return null;
    if (!SDK) SDK = new PumpSdk();
    const mint = new PublicKey(mintStr);
    // Fetch bonding curve via OnlinePumpSdk.fetchBuyState; use dummy user
    const online = new OnlinePumpSdk(conn);
    const dummyUser = PublicKey.unique();
    const { bondingCurve } = await online.fetchBuyState(mint, dummyUser);
    // Fetch mint decimals via parsed account
    const mintInfo = await conn.getParsedAccountInfo(mint, { commitment: 'confirmed' });
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
  mint: string,
  sizeSol: number,
  nowTs: number
): Promise<{ estFillPriceSol: number | null; estSlippageBps: number | null; reserves?: any } | null> {
  try {
    const now = nowTs || Date.now();
    if (!mint || !Number.isFinite(sizeSol) || sizeSol <= 0) return null;
    const conn = getConn();
    if (!conn) return null;
    const global = await loadGlobal(now);
    if (!global) return null;
    const bs = await loadBuyState(mint, now);
    if (!bs) return null;
    const { bondingCurve, decimals } = bs;

    // Compute out token amount
    const lamports = new BN(Math.floor(sizeSol * LAMPORTS_PER_SOL));
    const tokenOutBn = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig: null,
      mintSupply: bondingCurve?.tokenTotalSupply ?? null,
      bondingCurve,
      amount: lamports,
    } as any);

    if (!tokenOutBn || tokenOutBn.lten(0)) return null;

    const tokenOut = tokenOutBn.toNumber() / Math.pow(10, Math.max(0, decimals));
    if (!isFinite(tokenOut) || tokenOut <= 0) return null;
    const avgPriceSolPerToken = sizeSol / tokenOut;
    if (!isFinite(avgPriceSolPerToken) || avgPriceSolPerToken <= 0) return null;

    return { estFillPriceSol: avgPriceSolPerToken, estSlippageBps: null };
  } catch {
    return null;
  }
}
