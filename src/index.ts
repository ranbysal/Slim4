import express from 'express';
import Database from 'better-sqlite3';
import { config } from './config';
import { logger } from './utils/logger';
import { createStatusRouter } from './status/statusRouter';

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

const server = app.listen(config.port, () => {
  logger.info(`Slim4 server listening on :${config.port}`);
});

process.on('SIGINT', () => {
  logger.info('Shutting down...');
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
});
