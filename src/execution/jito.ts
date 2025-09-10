import { config } from '../config';
import { logger } from '../utils/logger';

export async function sendBundleOrDirect(txns: Array<unknown>): Promise<{ ok: boolean; txSigs: string[] }> {
  logger.info('Jito config:', config.jito);
  logger.info(`sendBundleOrDirect invoked with ${txns.length} txn(s).`);
  // TODO: Integrate real Jito SDK (jito-ts) when ready.
  return { ok: true, txSigs: [] };
}

