import Database from 'better-sqlite3';
import { Connection, LogsCallback, PublicKey } from '@solana/web3.js';
import { AppConfig, Origin, config } from '../config';
import { trackFirstN, getSnapshot } from '../microstructure/firstNBlocks';
import { hitCohort } from '../alpha/cohort';
import { evaluateMint } from '../trader/entryEngine';
import { logger } from '../utils/logger';
import { incInserted, incSeen, incByOrigin, setLastEventTs, setSubscribedPrograms, incDropInvalidMint, incDropDuplicateInBatch, incDropNotMint, incPumpfunParserHit, incPumpfunParserMiss, incMoonshotParserHit, incMoonshotParserMiss } from './state';
import { sendTelegram } from '../utils/telegram';
import { saveEvent, saveQuotes, setMetricsDb } from '../db/metricsWriter';
import { estimateQuote } from '../quote/pumpfunEstimator';
import { isRealSplMint } from './mintVerifier';
import { extractMintAndBuyerFromSignature } from './txIntrospect';
import { parsePumpfun } from './parsers/pumpfun';
import { parseMoonshot } from './parsers/moonshot';

type EndpointSet = 'primary' | 'backup';

type ParsedTokenEvent = {
  ts: number;
  programId: string;
  mint: string;
  candidates: string[];
  name?: string;
  symbol?: string;
  creator?: string;
  origin: Origin; // pumpfun | letsbonk | moonshot | raydium | orca
};

function redact(pk: string) {
  if (!pk) return '';
  if (pk.length <= 10) return pk;
  return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}

// Strict helpers for mint/buyer validation
const DENYLIST_IDS = new Set<string>([
  'ComputeBudget111111111111111111111111111111',
  '11111111111111111111111111111111',
  'Stake11111111111111111111111111111111111111',
  'Vote111111111111111111111111111111111111111',
  'Sysvar1111111111111111111111111111111111111',
  'Config1111111111111111111111111111111111111'
]);

function isBase58Len32to44(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

function isValidMint(addr: string | undefined | null): boolean {
  if (!addr) return false;
  if (!isBase58Len32to44(addr)) return false;
  if (DENYLIST_IDS.has(addr)) return false;
  if (isSubscribedProgram(addr)) return false;
  return true;
}

function isLikelyBuyer(addr: string | undefined | null): boolean {
  return isValidMint(addr || '');
}

export class SolanaLaunchWatcher {
  private db: Database.Database;
  private config: AppConfig;
  private conn: Connection | null = null;
  private endpointSet: EndpointSet = 'primary';
  private subs: number[] = [];
  private reconnectAttempts = 0;
  private errorTimestamps: number[] = [];
  private lastStableSince = Date.now();
  private onReconnectLoopAlerted = false;
  private stopped = false;
  private seenMintsBySignature: Map<string, { mints: Set<string>; ts: number }> = new Map();
  private lastEventWriteByMint: Map<string, number> = new Map();
  private quoteSamplers: Map<string, NodeJS.Timeout> = new Map();
  // Entry engine now self-enforces re-evaluation cooldowns

  constructor(db: Database.Database, config: AppConfig) {
    this.db = db;
    this.config = config;
    try { setMetricsDb(db); } catch {}
    this.ensureSchema();
  }

  private ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        mint TEXT PRIMARY KEY,
        first_seen_ts INTEGER,
        last_seen_ts INTEGER,
        origin TEXT,
        creator TEXT,
        name TEXT,
        symbol TEXT,
        seen_count INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_tokens_last_seen ON tokens(last_seen_ts);
      CREATE INDEX IF NOT EXISTS idx_tokens_origin ON tokens(origin);

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        signature TEXT,
        mint TEXT NOT NULL,
        origin TEXT NOT NULL,
        buyers INTEGER,
        unique_funders INTEGER,
        same_funder_ratio REAL,
        price_jumps INTEGER,
        depth_est REAL,
        creator TEXT,
        snapshot_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_mint_ts ON events(mint, ts);

      CREATE TABLE IF NOT EXISTS quotes (
        ts INTEGER NOT NULL,
        mint TEXT NOT NULL,
        origin TEXT NOT NULL,
        route TEXT NOT NULL,
        size_sol REAL NOT NULL,
        est_fill_price_sol REAL,
        est_slippage_bps REAL,
        reserves_json TEXT,
        PRIMARY KEY (mint, ts, size_sol)
      );
      CREATE INDEX IF NOT EXISTS idx_quotes_mint_ts ON quotes(mint, ts);
    `);
  }

  async start() {
    this.stopped = false;
    await this.connectAndSubscribe('primary');
  }

  async stop() {
    this.stopped = true;
    try {
      for (const id of this.subs) {
        try { await this.conn?.removeOnLogsListener(id); } catch {}
      }
      this.subs = [];
      // Close underlying WS if available
      const anyConn: any = this.conn as any;
      try { anyConn?._rpcWebSocket?.close?.(); } catch {}
    } finally {
      this.conn = null;
    }
  }

  private async connectAndSubscribe(which: EndpointSet) {
    if (this.stopped) return;
    this.endpointSet = which;
    const rpcHttp = which === 'primary' ? this.config.rpc.httpPrimary : this.config.rpc.httpBackup;
    const rpcWs = which === 'primary' ? this.config.rpc.wsPrimary : this.config.rpc.wsBackup;
    if (!rpcHttp || !rpcWs) {
      logger.warn('RPC endpoints not configured for', which, '— watcher disabled');
      return;
    }
    logger.info(`Connecting to ${which.toUpperCase()} WS:`, rpcWs);

    // New connection
    this.conn = new Connection(rpcHttp, { wsEndpoint: rpcWs, commitment: 'confirmed' });
    this.lastStableSince = Date.now();
    this.reconnectAttempts = 0;
    this.onReconnectLoopAlerted = false;

    // Build program lists from config
    const { programs } = this.config;
    const map: Map<string, Origin> = new Map();
    // establish stable priority order
    const order: Origin[] = ['pumpfun', 'letsbonk', 'moonshot', 'raydium', 'orca'];
    for (const origin of order) {
      const list = (programs as any)[origin] as string[];
      for (const id of list || []) {
        const trimmed = (id || '').trim();
        if (!trimmed) continue;
        if (!map.has(trimmed)) map.set(trimmed, origin);
      }
    }
    const uniqueIds = Array.from(map.keys());
    setSubscribedPrograms(uniqueIds.length);
    const preview = uniqueIds.slice(0, 3).map(redact);
    logger.info(`Feeds: subscribing to ${uniqueIds.length} program IDs. First 3: [${preview.join(', ')}]`);

    // Subscribe to logs per program id
    for (const id of uniqueIds) {
      await this.addLogSub(id, map.get(id)!);
    }

    // Wire up websocket events for reconnect
    const anyConn: any = this.conn as any;
    const ws = anyConn?._rpcWebSocket;
    if (ws) {
      ws.on('close', () => this.handleWsIssue('close'));
      ws.on('error', (e: unknown) => this.handleWsIssue('error', e));
    }
  }

  private async addLogSub(programIdStr: string, origin: Origin) {
    try {
      const programId = new PublicKey(programIdStr);
      const cb: LogsCallback = async (logs) => {
        try {
          // Precision parsers (zero-RPC) by origin
          const sig = (logs as any)?.signature as string | undefined;
          let preferredMint: string | undefined;
          let parserBuyer: string | undefined;
          let parserCreator: string | undefined;
          if (origin === 'pumpfun') {
            const r = parsePumpfun(logs.logs || [], sig || '');
            if (r.mint) { preferredMint = r.mint; incPumpfunParserHit(); } else { incPumpfunParserMiss(); }
            if (r.buyer) parserBuyer = r.buyer;
            if (r.creator) parserCreator = r.creator;
          } else if (origin === 'moonshot') {
            const r = parseMoonshot(logs.logs || [], sig || '');
            if (r.mint) { preferredMint = r.mint; incMoonshotParserHit(); } else { incMoonshotParserMiss(); }
            if (r.buyer) parserBuyer = r.buyer;
            if (r.creator) parserCreator = r.creator;
          }

          const evt = this.parseLogs(programIdStr, origin, logs.logs, preferredMint, parserCreator);
          if (!evt) return;
          // De-dupe the same mint within the same log batch (by signature)
          if (sig) {
            const now = Date.now();
            // prune old signatures (> 60s)
            for (const [k, v] of this.seenMintsBySignature.entries()) {
              if (now - v.ts > 60_000) this.seenMintsBySignature.delete(k);
            }
            let rec = this.seenMintsBySignature.get(sig);
            if (!rec) {
              rec = { mints: new Set<string>(), ts: now };
              this.seenMintsBySignature.set(sig, rec);
            }
            rec.ts = now;
            if (rec.mints.has(evt.mint)) {
              incDropDuplicateInBatch();
              return; // drop duplicate in this batch
            }
            rec.mints.add(evt.mint);
          }
          // Optional tx introspection for pumpfun (precision mint + buyer)
          try {
            const hadParserMint = !!preferredMint;
            if (sig && origin === 'pumpfun' && config.txLookup.mode !== 'off' && !hadParserMint) {
              const info = await extractMintAndBuyerFromSignature(this.conn!, sig, origin, evt.ts);
              if (info?.mint) {
                evt.mint = info.mint;
                if (info?.buyer) {
                  // attach found buyer for downstream use
                  // not stored in evt, but used below via trackFirstN/hitCohort
                  (evt as any)._buyer = info.buyer;
                }
              } else {
                // Augment-only fallback: don't drop on miss; keep parsed evt.mint
                // Optional: track miss reason without gating
                // (previously: incDropTxNoMint())
              }
            }
          } catch {}
          // Mint verification guardrails: eager | deferred | off
          const mv = config.mintVerify.mode;
          if (mv === 'eager') {
            try {
              const ok = await isRealSplMint(this.conn!, evt.mint);
              if (!ok) {
                incDropNotMint();
                return;
              }
            } catch {
              incDropNotMint();
              return;
            }
          } else if (mv === 'deferred') {
            // Only verify after min-obs & sameFunderRatio<=0.70
            try {
              const snap = getSnapshot(evt.mint);
              const meetsObs = (snap.buyers >= config.entry.minObsBuyers) && (snap.uniqueFunders >= config.entry.minObsUnique);
              const okSafety = (snap.sameFunderRatio <= 0.70);
              if (meetsObs && okSafety) {
                const ok = await isRealSplMint(this.conn!, evt.mint);
                if (!ok) {
                  incDropNotMint();
                  return;
                }
              }
              // else: skip verify for now (no drop)
            } catch {
              // skip verification on errors (no drop)
            }
          } else {
            // 'off': skip isRealSplMint entirely
          }
          // microstructure ingest (best-effort, non-blocking)
          try {
            const tr = trackFirstN(evt.mint, origin, evt.ts, (logs.logs || []).join('\n')) as
              | { buyer?: string; snapshot?: { buyers: number; uniqueFunders: number; sameFunderRatio: number; priceJumps: number; depthEst: number; lastTs: number; changed: boolean } }
              | void;
            const buyer = parserBuyer || (evt as any)._buyer || (tr as any)?.buyer as string | undefined;
            if (buyer && isLikelyBuyer(buyer)) {
              try { hitCohort(evt.mint, buyer, evt.ts); } catch {}
            }
            // Best-effort event recorder (throttled per mint)
            const snap = (tr as any)?.snapshot as
              | { buyers: number; uniqueFunders: number; sameFunderRatio: number; priceJumps: number; depthEst: number; lastTs: number; changed: boolean }
              | undefined;
            if (snap && snap.changed) {
              const lastW = this.lastEventWriteByMint.get(evt.mint) || 0;
              if (evt.ts - lastW >= 5000) {
                this.lastEventWriteByMint.set(evt.mint, evt.ts);
                try {
                  saveEvent({
                    ts: evt.ts,
                    signature: sig,
                    mint: evt.mint,
                    origin,
                    buyers: snap.buyers,
                    unique: snap.uniqueFunders,
                    same: snap.sameFunderRatio,
                    priceJumps: snap.priceJumps,
                    depth: snap.depthEst,
                    creator: evt.creator,
                    snapshot: snap
                  });
                } catch {}
              }
              // Start quote sampler once minObs thresholds are met
              try {
                if (this.config.quotes.enabled) {
                  const meetsObs = snap.buyers >= this.config.entry.minObsBuyers && snap.uniqueFunders >= this.config.entry.minObsUnique;
                  if (meetsObs) this.ensureQuoteSampler(evt.mint, origin, evt.creator || null, evt.ts);
                }
              } catch {}
            }
          } catch {}
          // Evaluate unitary entry decision (engine enforces its own cooldowns)
          try { evaluateMint(evt.mint, origin, evt.ts, evt.creator ?? undefined).catch(() => {}); } catch {}
          this.handleEvent(evt);
        } catch (e) {
          logger.debug('Parse log error:', e);
        }
      };
      const id = await this.conn!.onLogs(programId, cb, 'confirmed');
      this.subs.push(id);
      logger.info(`Subscribed to logs for ${origin} (${redact(programIdStr)})`);
    } catch (e) {
      logger.warn(`Failed to subscribe to ${origin} logs:`, (e as Error)?.message ?? e);
    }
  }

  private parseLogs(
    programId: string,
    origin: Origin,
    logs: string[],
    preferredMint?: string,
    preferredCreator?: string
  ): ParsedTokenEvent | null {
    // Heuristic regex-based parse to extract mint/name/symbol/creator from logs if present.
    const ts = Date.now();
    const text = logs.join('\n');
    const b58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
    const candidates = Array.from(text.matchAll(b58)).map(m => m[0]).filter((v, i, a) => a.indexOf(v) === i);
    // Try to pick a plausible mint-like key (prefer parser override if valid; else first candidate).
    const chosen = (preferredMint && isValidMint(preferredMint)) ? preferredMint : candidates[0];
    const mint = chosen;
    if (!mint) return null;
    if (!isValidMint(mint)) {
      incDropInvalidMint();
      return null;
    }
    const nameMatch = text.match(/name[:=]\s*([A-Za-z0-9_\-\.]{1,32})/i);
    const symbolMatch = text.match(/symbol[:=]\s*([A-Za-z0-9_\-]{1,16})/i);
    const creatorMatch = text.match(/creator[:=]\s*([1-9A-HJ-NP-Za-km-z]{32,44})/i);
    const evt: ParsedTokenEvent = {
      ts,
      programId,
      mint,
      candidates,
      name: nameMatch?.[1],
      symbol: symbolMatch?.[1],
      creator: preferredCreator || creatorMatch?.[1] || candidates.find(c => c !== mint),
      origin
    };
    return evt;
  }

  private handleEvent(evt: ParsedTokenEvent) {
    // Upsert into DB
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO tokens (mint, first_seen_ts, last_seen_ts, origin, creator, name, symbol, seen_count) VALUES (?,?,?,?,?,?,?,1)'
    );
    const update = this.db.prepare(
      'UPDATE tokens SET last_seen_ts=?, origin=COALESCE(origin, ?), creator=COALESCE(creator, ?), name=COALESCE(name, ?), symbol=COALESCE(symbol, ?), seen_count = seen_count + 1 WHERE mint=?'
    );

    const tx = this.db.transaction(() => {
      const ins = insert.run(
        evt.mint,
        evt.ts,
        evt.ts,
        evt.origin,
        evt.creator ?? null,
        evt.name ?? null,
        evt.symbol ?? null
      );
      if (ins.changes > 0) {
        incInserted();
      } else {
        update.run(evt.ts, evt.origin, evt.creator ?? null, evt.name ?? null, evt.symbol ?? null, evt.mint);
      }
    });
    tx();
    incSeen();
    incByOrigin(evt.origin);
    setLastEventTs(evt.ts);
  }

  private async handleWsIssue(type: 'close' | 'error', err?: unknown) {
    if (this.stopped) return;
    const now = Date.now();
    this.errorTimestamps.push(now);
    // keep only last 30s
    this.errorTimestamps = this.errorTimestamps.filter(t => now - t <= 30_000);
    logger.warn(`WS ${type} on ${this.endpointSet}; scheduling reconnect...`, (err as Error)?.message ?? '');

    // Telegram alert once per reconnect loop burst
    if (!this.onReconnectLoopAlerted) {
      this.onReconnectLoopAlerted = true;
      sendTelegram(this.config, `Slim4 alert: WS ${type} on ${this.endpointSet}. Reconnecting with backoff.`);
    }

    // Switch to backup if too many errors on primary
    if (this.endpointSet === 'primary') {
      const errorsIn30s = this.errorTimestamps.length;
      if (errorsIn30s > 3) {
        logger.warn('Primary WS unstable; falling back to BACKUP');
        await this.reconnect('backup');
        return;
      }
    } else {
      // If backup has been stable for 10 minutes, try going back to primary on next issue
      const stableForMs = now - this.lastStableSince;
      if (stableForMs > 10 * 60 * 1000) {
        logger.info('Attempting to switch back to PRIMARY after stability window');
        await this.reconnect('primary');
        return;
      }
    }

    // Otherwise, reconnect to current set with exponential backoff
    await this.reconnect(this.endpointSet);
  }

  private async reconnect(which: EndpointSet) {
    if (this.stopped) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(30_000, 1000 * Math.pow(2, Math.min(6, this.reconnectAttempts - 1)));
    await new Promise((r) => setTimeout(r, delay));
    try {
      await this.stop();
    } catch {}
    await this.connectAndSubscribe(which);
  }

  private ensureQuoteSampler(mint: string, origin: Origin, creator: string | null, nowTs: number) {
    if (!this.config.quotes.enabled) return;
    if (origin !== 'pumpfun') return; // only pumpfun quotes for now
    if (this.quoteSamplers.has(mint)) return; // already running
    const startTs = nowTs || Date.now();
    const intervalMs = Math.max(1000, this.config.quotes.intervalMs || 8000);
    const maxMs = Math.max(60_000, (this.config.quotes.maxMinutes || 15) * 60_000);
    const sizes = (this.config.quotes.sizesSol && this.config.quotes.sizesSol.length > 0)
      ? this.config.quotes.sizesSol
      : [0.05, 0.1, 0.2];
    const tick = async () => {
      const now = Date.now();
      // Stop if exceeded max duration
      if (now - startTs > maxMs) { this.stopQuoteSampler(mint); return; }
      // Stop if traffic died (>60s since last micro event)
      try {
        const s = getSnapshot(mint);
        if (!s?.lastTs || now - s.lastTs > 60_000) { this.stopQuoteSampler(mint); return; }
      } catch {}
      try {
        const samples: Array<{ ts: number; mint: string; origin: string; route: 'pumpfun'; sizeSol: number; estFillPriceSol: number | null; estSlippageBps: number | null; reserves?: any }>
          = [];
        for (const size of sizes) {
          try {
            const est = await estimateQuote(this.conn!, mint, size, now);
            samples.push({
              ts: now,
              mint,
              origin,
              route: 'pumpfun',
              sizeSol: size,
              estFillPriceSol: est?.estFillPriceSol ?? null,
              estSlippageBps: est?.estSlippageBps ?? null,
              reserves: est?.reserves
            });
          } catch {
            // push nulls to reflect attempt
            samples.push({ ts: now, mint, origin, route: 'pumpfun', sizeSol: size, estFillPriceSol: null, estSlippageBps: null });
          }
        }
        saveQuotes(samples);
      } catch {}
    };
    // schedule interval
    const t = setInterval(tick, intervalMs);
    this.quoteSamplers.set(mint, t);
    // run first tick soon-ish (stagger a bit)
    setTimeout(tick, Math.floor(intervalMs / 2));
  }

  private stopQuoteSampler(mint: string) {
    const t = this.quoteSamplers.get(mint);
    if (t) { try { clearInterval(t); } catch {} }
    this.quoteSamplers.delete(mint);
  }

}

// Module-level helper so validators above can reference it
const SUB_PROGRAM_IDS = new Set<string>([
  ...config.programs.pumpfun,
  ...config.programs.letsbonk,
  ...config.programs.moonshot,
  ...config.programs.raydium,
  ...config.programs.orca
].map(s => (s || '').trim()).filter(Boolean));
function isSubscribedProgram(addr: string): boolean {
  try { return SUB_PROGRAM_IDS.has(addr); } catch { return false; }
}
