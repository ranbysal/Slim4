import TelegramBot from 'node-telegram-bot-api';
import { AppConfig, Origin } from '../config';
import { logger } from './logger';

let bot: TelegramBot | null = null;
let cachedToken = '';
let lastSentTs = 0;
let lastAlertTs = 0;

// Summary state
let summaryTimerStarted = false;
let summaryIntervalMs = 0;
let summaryAccepted = 0;
let summaryRejected = 0;
const reasonCounts: Map<string, number> = new Map();
const originCounts: Map<Origin, number> = new Map();

type Decision = {
  mint: string;
  origin: Origin;
  status: 'rejected' | 'dry_run' | 'pending';
  score: number;
  tier: 'APEX' | 'SMALL' | 'REJECT';
  reasons?: string[];
};

type Snapshot = {
  buyers: number;
  uniqueFunders: number;
  sameFunderRatio: number;
  priceJumps: number;
};

function getBot(config: AppConfig): TelegramBot | null {
  const token = config.telegram.botToken;
  if (!token || !config.telegram.chatId) return null;
  if (bot && cachedToken === token) return bot;
  try {
    bot = new TelegramBot(token, { polling: false });
    cachedToken = token;
    return bot;
  } catch (e) {
    logger.warn('Failed to initialize Telegram bot:', e);
    return null;
  }
}

function ensureSummaryTimer(config: AppConfig) {
  if (summaryTimerStarted) return;
  const everySec = config.alerts.summaryEverySec || 0;
  if (everySec <= 0) return;
  summaryTimerStarted = true;
  summaryIntervalMs = everySec * 1000;
  const cfgRef = config; // capture for timer
  setInterval(() => {
    try {
      // Compose summary
      const topReasons = Array.from(reasonCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([r]) => r);
      const byOrigin: Record<string, number> = {};
      for (const [k, v] of originCounts.entries()) byOrigin[k] = v;
      const msg = `SUMMARY last 5m — accepts:${summaryAccepted} rejects:${summaryRejected} topReasons:[${topReasons.join(',')}] byOrigin:{pumpfun:${byOrigin.pumpfun||0},raydium:${byOrigin.raydium||0},moonshot:${byOrigin.moonshot||0}}`;
      // best-effort send respecting rate-limit
      sendTelegram(cfgRef, msg).catch(() => {});
    } catch {}
    // reset counters after each summary
    summaryAccepted = 0;
    summaryRejected = 0;
    reasonCounts.clear();
    originCounts.clear();
  }, summaryIntervalMs);
}

export async function sendTelegram(config: AppConfig, text: string) {
  try {
    const b = getBot(config);
    if (!b) return;
    // Rate limit across all messages
    const rlMs = Math.max(0, (config.alerts?.rateLimitSec ?? 0) * 1000);
    const now = Date.now();
    if (rlMs > 0 && now - lastSentTs < rlMs) {
      return; // drop if too soon
    }
    await b.sendMessage(config.telegram.chatId, text, { disable_web_page_preview: true });
    lastSentTs = now;
    lastAlertTs = now;
  } catch (e) {
    logger.warn('Failed to send Telegram message:', (e as Error)?.message ?? e);
  }
}

export function getLastAlertTs(): number { return lastAlertTs; }

export function bumpSummary(decision: Decision) {
  try {
    originCounts.set(decision.origin, (originCounts.get(decision.origin) || 0) + 1);
    if (decision.status === 'rejected') summaryRejected += 1; else summaryAccepted += 1;
    const reasons = decision.reasons || [];
    for (const r of reasons) reasonCounts.set(r, (reasonCounts.get(r) || 0) + 1);
  } catch {}
}

function mintShort(m: string): string {
  if (!m) return '';
  if (m.length <= 10) return m;
  return `${m.slice(0, 4)}…${m.slice(-4)}`;
}

export async function sendDecisionAlert(config: AppConfig, decision: Decision, snapshot: Snapshot) {
  try {
    ensureSummaryTimer(config);
    // gating
    if (config.alerts.acceptedOnly && decision.status !== 'dry_run') return;
    if (decision.score < (config.alerts.minScore || 0)) return;

    const mark = decision.status === 'rejected' ? '❌' : '✅';
    const line = `DECISION ${mark} ${mintShort(decision.mint)} ${decision.origin} score ${decision.score} tier ${decision.tier} | buyers ${snapshot.buyers} funders ${snapshot.uniqueFunders} same ${snapshot.sameFunderRatio.toFixed(2)} jumps ${snapshot.priceJumps}`;
    await sendTelegram(config, line);
  } catch (e) {
    logger.warn('sendDecisionAlert error:', (e as Error)?.message ?? e);
  }
}
