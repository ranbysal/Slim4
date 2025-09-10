import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { config } from '../config';
import { logger } from '../utils/logger';

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function applyPragmas(db: Database.Database) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 3000');
}

function applySchema(db: Database.Database) {
  const schemaPath = path.resolve(__dirname, './schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(sql);
  // Ensure schema_version=1
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version', '1')").run();
}

function logCounts(db: Database.Database) {
  const tables = ['positions', 'orders', 'trades', 'halts', 'jito_tips_ledger'];
  for (const t of tables) {
    try {
      const row = db.prepare(`SELECT COUNT(1) as c FROM ${t}`).get() as { c: number };
      logger.info(`Table ${t} count:`, row.c);
    } catch (e) {
      logger.warn(`Table ${t} not found or error counting.`);
    }
  }
  const v = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: string } | undefined;
  logger.info('Schema version:', v?.value ?? 'unknown');
}

(() => {
  ensureDir(path.dirname(config.dbPath));
  logger.info('Opening DB at', config.dbPath);
  const db = new Database(config.dbPath);
  try {
    applyPragmas(db);
    applySchema(db);
    logCounts(db);
    logger.info('DB init complete.');
  } finally {
    db.close();
  }
})();

