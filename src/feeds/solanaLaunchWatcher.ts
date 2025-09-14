import Database from 'better-sqlite3';
import { Connection, LogsCallback, PublicKey } from '@solana/web3.js';
import { AppConfig, Origin } from '../config';
import { trackFirstN } from '../microstructure/firstNBlocks';
import { evaluateMint } from '../trader/entryEngine';
import { logger } from '../utils/logger';
import { incInserted, incSeen, incByOrigin, setLastEventTs, setSubscribedPrograms } from './state';
import { sendTelegram } from '../utils/telegram';

type EndpointSet = 'primary' | 'backup';

type ParsedTokenEvent = {
  ts: number;
  programId: string;
  mint: string;
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
  private lastDecisionTs: Map<string, number> = new Map();

  constructor(db: Database.Database, config: AppConfig) {
    this.db = db;
    this.config = config;
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
          const evt = this.parseLogs(programIdStr, origin, logs.logs);
          if (!evt) return;
          // microstructure ingest (best-effort, non-blocking)
          try { trackFirstN(evt.mint, origin, evt.ts, (logs.logs || []).join('\n')); } catch {}
          // Evaluate unitary entry decision with cooldown debounce
          try {
            const last = this.lastDecisionTs.get(evt.mint) || 0;
            const cooldownMs = (this.config.entry?.cooldownSec || 60) * 1000;
            if (evt.ts - last >= cooldownMs) {
              this.lastDecisionTs.set(evt.mint, evt.ts);
              evaluateMint(evt.mint, origin, evt.ts).catch(() => {});
            }
          } catch {}
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

  private parseLogs(programId: string, origin: Origin, logs: string[]): ParsedTokenEvent | null {
    // Heuristic regex-based parse to extract mint/name/symbol/creator from logs if present.
    const ts = Date.now();
    const text = logs.join('\n');
    const b58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
    const candidates = Array.from(text.matchAll(b58)).map(m => m[0]);
    // Try to pick a plausible mint-like key (first candidate).
    const mint = candidates[0];
    if (!mint) return null;
    const nameMatch = text.match(/name[:=]\s*([A-Za-z0-9_\-\.]{1,32})/i);
    const symbolMatch = text.match(/symbol[:=]\s*([A-Za-z0-9_\-]{1,16})/i);
    const creatorMatch = text.match(/creator[:=]\s*([1-9A-HJ-NP-Za-km-z]{32,44})/i);
    const evt: ParsedTokenEvent = {
      ts,
      programId,
      mint,
      name: nameMatch?.[1],
      symbol: symbolMatch?.[1],
      creator: creatorMatch?.[1] || candidates.find(c => c !== mint),
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
}
