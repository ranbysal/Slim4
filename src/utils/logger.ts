type Level = "debug" | "info" | "warn" | "error";

const levelOrder: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const envLevel = (process.env.LOG_LEVEL as Level) || "info";
let currentLevel: Level = ["debug", "info", "warn", "error"].includes(envLevel)
  ? envLevel
  : "info";

function ts() {
  return new Date().toISOString();
}

function shouldLog(l: Level) {
  return levelOrder[l] >= levelOrder[currentLevel];
}

export const logger = {
  setLevel(l: Level) {
    if (levelOrder[l] !== undefined) currentLevel = l;
  },
  debug(...args: unknown[]) {
    if (shouldLog("debug")) console.debug(`[${ts()}] [DEBUG]`, ...args);
  },
  info(...args: unknown[]) {
    if (shouldLog("info")) console.log(`[${ts()}] [INFO ]`, ...args);
  },
  warn(...args: unknown[]) {
    if (shouldLog("warn")) console.warn(`[${ts()}] [WARN ]`, ...args);
  },
  error(...args: unknown[]) {
    if (shouldLog("error")) console.error(`[${ts()}] [ERROR]`, ...args);
  }
};

