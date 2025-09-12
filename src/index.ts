import express from 'express';
import Database from 'better-sqlite3';
import { config } from './config';
import { logger } from './utils/logger';
import { createStatusRouter } from './status/statusRouter';
import { SolanaLaunchWatcher } from './feeds/solanaLaunchWatcher';
import { sendTelegram } from './utils/telegram';

function applyPragmas(db: Database.Database) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 3000');
}

const db = new Database(config.dbPath);
applyPragmas(db);

const app = express();
app.use(express.json());

// Status routes
app.use('/', createStatusRouter(db, config));

const server = app.listen(config.port, async () => {
  logger.info(`Slim4 server listening on :${config.port}`);
  try {
    await sendTelegram(config, 'Slim4 online');
  } catch {}
});

// Start feeds watcher (if enabled)
let watcher: SolanaLaunchWatcher | null = null;
if (config.feedsEnabled) {
  watcher = new SolanaLaunchWatcher(db, config);
  watcher.start().catch((e) => logger.warn('Watcher start error:', e));
} else {
  logger.info('Feeds are disabled by config.');
}

process.on('SIGINT', () => {
  logger.info('Shutting down...');
  server.close(() => {
    try { db.close(); } catch {}
    try { watcher?.stop(); } catch {}
    process.exit(0);
  });
});
