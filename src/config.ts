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
  feedsEnabled: boolean;
  programs: Readonly<{
    pumpfun: string[];
    letsbonk: string[];
    moonshot: string[];
    raydium: string[];
    orca: string[];
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
  feedsEnabled: parsed.FEEDS_ENABLED,
  programs: {
    pumpfun: parseCsvPrograms(parsed.PUMPFUN_PROGRAM_IDS),
    letsbonk: parseCsvPrograms(parsed.LETSBONK_PROGRAM_IDS),
    moonshot: parseCsvPrograms(parsed.MOONSHOT_PROGRAM_IDS),
    raydium: parseCsvPrograms(parsed.RAYDIUM_PROGRAM_IDS),
    orca: parseCsvPrograms(parsed.ORCA_PROGRAM_IDS)
  }
});
