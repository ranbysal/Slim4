import { Router } from 'express';
import Database from 'better-sqlite3';
import { AppConfig } from '../config';
import { getFeedCounters, getFeedStatus } from '../feeds/state';

export function createStatusRouter(db: Database.Database, config: AppConfig) {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true, version: 1 });
  });

  router.get('/status', (_req, res) => {
    // schemaVersion
    let schemaVersion = 0;
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: string } | undefined;
      if (row?.value) schemaVersion = Number(row.value) || 0;
    } catch {
      // ignore
    }

    // open positions count
    let openPositions = 0;
    try {
      const row = db.prepare("SELECT COUNT(1) as c FROM positions WHERE status='open'").get() as { c: number };
      openPositions = row?.c ?? 0;
    } catch {
      // ignore
    }

    // today realized pnl in SOL
    let todayRealizedPnlSol = 0;
    try {
      const row = db
        .prepare("SELECT COALESCE(SUM(realized_pnl_sol), 0) as s FROM trades WHERE DATE(created_at) = DATE('now')")
        .get() as { s: number };
      todayRealizedPnlSol = row?.s ?? 0;
    } catch {
      // ignore
    }

    // active halts count
    let activeHalts = 0;
    try {
      const row = db.prepare('SELECT COUNT(1) as c FROM halts WHERE active = 1').get() as { c: number };
      activeHalts = row?.c ?? 0;
    } catch {
      // ignore
    }

    const feeds = getFeedCounters();
    const feedStatus = getFeedStatus();

    res.json({
      schemaVersion,
      openPositions,
      todayRealizedPnlSol,
      activeHalts,
      jito: config.jito,
      riskCaps: { openRiskMaxPct: 18, dailyDrawdownMaxPct: 15, impactMaxPct: 3 },
      tokensSeen24h: feeds.tokensSeen24h,
      tokensInserted24h: feeds.tokensInserted24h,
      feeds: {
        subscribedPrograms: feedStatus.subscribedPrograms,
        byOrigin: feedStatus.byOrigin,
        lastEventTs: feedStatus.lastEventTs
      }
    });
  });

  return router;
}
