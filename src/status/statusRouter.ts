import { Router } from 'express';
import Database from 'better-sqlite3';
import { AppConfig } from '../config';
import { getFeedCounters, getFeedStatus } from '../feeds/state';
import { getSummary as getMicroSummary, resetExpired as resetMicroExpired } from '../microstructure/firstNBlocks';
import { logger } from '../utils/logger';
import { getLastAlertTs } from '../utils/telegram';
import { getDecisionStats } from '../trader/entryEngine';

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

    // Cleanup and summarize microstructure state
    try { resetMicroExpired(120_000); } catch {}
    const micro = getMicroSummary();

    // Decision stats (dry-run entry engine)
    let dryRunAccepted24h = 0;
    let rejected24h = 0;
    let softRejected24h = 0;
    let pending24h = 0;
    let last10: Array<{ mint: string | null; origin: string | null; status: string; size_tier: string | null; decided_ts: number | null }> = [];
    let last10Accepted: Array<{ mint: string | null; origin: string | null; tier: string | null; decided_ts: number | null }> = [];
    try {
      const now = Date.now();
      const since = now - 24 * 60 * 60 * 1000;
      try {
        const rowA = db.prepare("SELECT COUNT(1) as c FROM orders WHERE status='dry_run' AND decided_ts >= ?").get(since) as { c: number };
        dryRunAccepted24h = rowA?.c ?? 0;
      } catch (e) { logger.debug('dryRunAccepted24h query failed'); }
      try {
        const rowR = db.prepare("SELECT COUNT(1) as c FROM orders WHERE status='rejected' AND decided_ts >= ?").get(since) as { c: number };
        rejected24h = rowR?.c ?? 0;
      } catch (e) { logger.debug('rejected24h query failed'); }
      try {
        last10 = db.prepare(
          "SELECT mint, origin, status, size_tier, decided_ts FROM orders WHERE status IN ('dry_run','rejected') ORDER BY decided_ts DESC LIMIT 10"
        ).all() as any[];
      } catch (e) { logger.debug('last10Decisions query failed'); }
      try {
        last10Accepted = db.prepare(
          "SELECT mint, origin, size_tier as tier, decided_ts FROM orders WHERE status='dry_run' ORDER BY decided_ts DESC LIMIT 10"
        ).all() as any[];
      } catch (e) { logger.debug('last10Accepted query failed'); }
      try {
        const ds = getDecisionStats();
        pending24h = ds.pending24h;
        softRejected24h = ds.softRejected24h;
      } catch {}
    } catch {}

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
      },
      decisions: {
        dryRun: config.dryRun,
        dryRunAccepted24h,
        rejected24h,
        pending24h,
        softRejected24h,
        last10,
        last10Accepted
      },
      microstructure: {
        trackedMints: micro.trackedMints,
        recentSnapshots: micro.recentSnapshots
      },
      alerts: {
        acceptedOnly: config.alerts.acceptedOnly,
        minScore: config.alerts.minScore,
        rateLimitSec: config.alerts.rateLimitSec,
        summaryEverySec: config.alerts.summaryEverySec,
        lastAlertTs: getLastAlertTs()
      }
    });
  });

  return router;
}
