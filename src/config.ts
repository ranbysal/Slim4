import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DB_PATH: z.string().min(1).default("./data/bot.sqlite"),

  RPC_WS_URL_PRIMARY: z.string().default(""),
  RPC_HTTP_URL_PRIMARY: z.string().default(""),
  RPC_WS_URL_BACKUP: z.string().default(""),
  RPC_HTTP_URL_BACKUP: z.string().default(""),

  JITO_BLOCK_ENGINE_URL: z.string().default("https://mainnet.block-engine.jito.wtf"),
  JITO_TIP_BUDGET_DAILY_SOL: z.coerce.number().default(0.2),
  JITO_TIP_MAX_PER_TRADE_SOL: z.coerce.number().default(0.05),

  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_CHAT_ID: z.string().default(""),

  // Feeds
  FEEDS_ENABLED: z.coerce.boolean().default(true),
  PUMPFUN_PROGRAM_IDS: z.string().default(""),
  LETSBONK_PROGRAM_IDS: z.string().default(""),
  MOONSHOT_PROGRAM_IDS: z.string().default(""),
  RAYDIUM_PROGRAM_IDS: z.string().default(""),
  ORCA_PROGRAM_IDS: z.string().default("")
  ,
  // Unitary Entry Engine / Dry run
  DRY_RUN: z.coerce.boolean().default(true),
  SIZE_SMALL_USD: z.coerce.number().default(30),
  SIZE_APEX_USD: z.coerce.number().default(120),
  ENTRY_MIN_SCORE: z.coerce.number().default(60),
  ENTRY_APEX_SCORE: z.coerce.number().default(80),
  DECISION_COOLDOWN_SEC: z.coerce.number().default(120),
  // New adaptive/deferred entry controls
  MIN_OBS_BUYERS: z.coerce.number().default(4),
  MIN_OBS_UNIQUE: z.coerce.number().default(3),
  REEVAL_COOLDOWN_SEC: z.coerce.number().default(15),
  ACCEPT_COOLDOWN_SEC: z.coerce.number().default(120),

  // Alerts / Telegram noise control
  ALERTS_ACCEPTED_ONLY: z.coerce.boolean().default(false),
  ALERTS_MIN_SCORE: z.coerce.number().default(0),
  ALERTS_RATE_LIMIT_SEC: z.coerce.number().default(1),
  ALERTS_SUMMARY_EVERY_SEC: z.coerce.number().default(0)
  ,
  // Market Heat auto-tuner
  HEAT_ENABLED: z.coerce.boolean().default(true),
  HEAT_WINDOW_MIN: z.coerce.number().int().min(1).max(120).default(10),
  HEAT_MIN_ACCEPTS_PER_HR: z.coerce.number().min(0).default(2),
  HEAT_MAX_ACCEPTS_PER_HR: z.coerce.number().min(0).default(12),
  HEAT_LOOSEN_DELTA_SCORE: z.coerce.number().min(0).default(10),
  HEAT_LOOSEN_DELTA_BUYERS: z.coerce.number().min(0).default(2),
  HEAT_TIGHTEN_DELTA_SCORE: z.coerce.number().min(0).default(10),
  HEAT_TIGHTEN_DELTA_BUYERS: z.coerce.number().min(0).default(2),
  HEAT_FLOOR_SCORE: z.coerce.number().min(0).max(100).default(40),
  HEAT_FLOOR_BUYERS: z.coerce.number().int().min(0).default(2),
  HEAT_CEIL_SCORE: z.coerce.number().min(0).max(100).default(95),
  HEAT_CEIL_BUYERS: z.coerce.number().int().min(0).default(16)
  ,
  // Pending TTL controls
  HOLD_TTL_SEC: z.coerce.number().int().min(0).default(300),
  HOLD_MAX_REEVALS: z.coerce.number().int().min(0).default(20)
});

const parsed = EnvSchema.parse(process.env);

export type Origin = 'pumpfun' | 'letsbonk' | 'moonshot' | 'raydium' | 'orca';

export type AppConfig = Readonly<{
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  dbPath: string;
  rpc: {
    wsPrimary: string;
    httpPrimary: string;
    wsBackup: string;
    httpBackup: string;
  };
  jito: {
    blockEngineUrl: string;
    dailyTipBudgetSol: number;
    maxTipPerTradeSol: number;
  };
  telegram: {
    botToken: string;
    chatId: string;
  };
  alerts: Readonly<{
    acceptedOnly: boolean;
    minScore: number;
    rateLimitSec: number;
    summaryEverySec: number; // 0 disables
  }>;
  feedsEnabled: boolean;
  programs: Readonly<{
    pumpfun: string[];
    letsbonk: string[];
    moonshot: string[];
    raydium: string[];
    orca: string[];
  }>;
  dryRun: boolean;
  sizes: Readonly<{ smallUsd: number; apexUsd: number }>;
  entry: Readonly<{
    minScore: number;
    apexScore: number;
    cooldownSec: number;
    reevalCooldownSec: number;
    acceptCooldownSec: number;
    minObsBuyers: number;
    minObsUnique: number;
    holdTtlSec: number;
    holdMaxReevals: number;
  }>;
  heat: Readonly<{
    enabled: boolean;
    windowMin: number;
    minAcceptsPerHr: number;
    maxAcceptsPerHr: number;
    loosenDelta: { score: number; buyers: number };
    tightenDelta: { score: number; buyers: number };
    floor: { score: number; buyers: number };
    ceil: { score: number; buyers: number };
  }>;
}>;

function parseCsvPrograms(raw: string): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        // base58-ish filter by length as requested (32–44)
        .filter(s => s.length >= 32 && s.length <= 44)
    )
  );
}

export const config: AppConfig = Object.freeze({
  port: parsed.PORT,
  logLevel: parsed.LOG_LEVEL,
  dbPath: parsed.DB_PATH,
  rpc: {
    wsPrimary: parsed.RPC_WS_URL_PRIMARY,
    httpPrimary: parsed.RPC_HTTP_URL_PRIMARY,
    wsBackup: parsed.RPC_WS_URL_BACKUP,
    httpBackup: parsed.RPC_HTTP_URL_BACKUP
  },
  jito: {
    blockEngineUrl: parsed.JITO_BLOCK_ENGINE_URL,
    dailyTipBudgetSol: parsed.JITO_TIP_BUDGET_DAILY_SOL,
    maxTipPerTradeSol: parsed.JITO_TIP_MAX_PER_TRADE_SOL
  },
  telegram: {
    botToken: parsed.TELEGRAM_BOT_TOKEN,
    chatId: parsed.TELEGRAM_CHAT_ID
  },
  alerts: {
    acceptedOnly: parsed.ALERTS_ACCEPTED_ONLY,
    minScore: parsed.ALERTS_MIN_SCORE,
    rateLimitSec: parsed.ALERTS_RATE_LIMIT_SEC,
    summaryEverySec: parsed.ALERTS_SUMMARY_EVERY_SEC
  },
  feedsEnabled: parsed.FEEDS_ENABLED,
  programs: {
    pumpfun: parseCsvPrograms(parsed.PUMPFUN_PROGRAM_IDS),
    letsbonk: parseCsvPrograms(parsed.LETSBONK_PROGRAM_IDS),
    moonshot: parseCsvPrograms(parsed.MOONSHOT_PROGRAM_IDS),
    raydium: parseCsvPrograms(parsed.RAYDIUM_PROGRAM_IDS),
    orca: parseCsvPrograms(parsed.ORCA_PROGRAM_IDS)
  },
  dryRun: parsed.DRY_RUN,
  sizes: { smallUsd: parsed.SIZE_SMALL_USD, apexUsd: parsed.SIZE_APEX_USD },
  entry: {
    minScore: parsed.ENTRY_MIN_SCORE,
    apexScore: parsed.ENTRY_APEX_SCORE,
    cooldownSec: parsed.DECISION_COOLDOWN_SEC,
    reevalCooldownSec: parsed.REEVAL_COOLDOWN_SEC,
    acceptCooldownSec: parsed.ACCEPT_COOLDOWN_SEC,
    minObsBuyers: parsed.MIN_OBS_BUYERS,
    minObsUnique: parsed.MIN_OBS_UNIQUE,
    holdTtlSec: parsed.HOLD_TTL_SEC,
    holdMaxReevals: parsed.HOLD_MAX_REEVALS
  },
  heat: {
    enabled: parsed.HEAT_ENABLED,
    windowMin: parsed.HEAT_WINDOW_MIN,
    minAcceptsPerHr: parsed.HEAT_MIN_ACCEPTS_PER_HR,
    maxAcceptsPerHr: parsed.HEAT_MAX_ACCEPTS_PER_HR,
    loosenDelta: { score: parsed.HEAT_LOOSEN_DELTA_SCORE, buyers: parsed.HEAT_LOOSEN_DELTA_BUYERS },
    tightenDelta: { score: parsed.HEAT_TIGHTEN_DELTA_SCORE, buyers: parsed.HEAT_TIGHTEN_DELTA_BUYERS },
    floor: { score: parsed.HEAT_FLOOR_SCORE, buyers: parsed.HEAT_FLOOR_BUYERS },
    ceil: { score: parsed.HEAT_CEIL_SCORE, buyers: parsed.HEAT_CEIL_BUYERS }
  }
});
