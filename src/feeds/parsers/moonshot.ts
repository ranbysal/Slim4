// Zero-RPC parser for Moonshot logs
// Extracts mint, buyer, creator when present in program logs.

export type ParseResult = { mint?: string; buyer?: string; creator?: string; why?: string };

const BASE58_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

const DENYLIST_IDS = new Set<string>([
  'ComputeBudget111111111111111111111111111111',
  '11111111111111111111111111111111',
  'Stake11111111111111111111111111111111111111',
  'Vote111111111111111111111111111111111111111',
  'Sysvar1111111111111111111111111111111111111',
  'Config1111111111111111111111111111111111111'
]);

function isBase58Len32to44(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

function isValidMint(addr: string | undefined | null): boolean {
  if (!addr) return false;
  if (!isBase58Len32to44(addr)) return false;
  if (DENYLIST_IDS.has(addr)) return false;
  return true;
}

function lower(s: string) { return (s || '').toLowerCase(); }

type KV = Record<string, string>;
function collectKeyValues(lines: string[]): KV {
  const out: KV = {};
  for (const line of lines) {
    const rx = /(\b[a-zA-Z][a-zA-Z0-9_]{2,32})\s*[:=]\s*([1-9A-HJ-NP-Za-km-z]{32,44})/g;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(line)) !== null) {
      const k = lower(m[1]);
      const v = m[2];
      if (!out[k]) out[k] = v;
    }
  }
  return out;
}

function pickMintFromKeys(kv: KV): string | undefined {
  const priority = [
    // Common Moonshot field names encountered in logs
    'mint', 'mint_address', 'mintaddress', 'token_mint', 'tokenmint', 'targetmint', 'token'
  ];
  for (const k of priority) {
    const v = kv[k];
    if (isValidMint(v)) return v;
  }
  return undefined;
}

function pickCreatorFromKeys(kv: KV): string | undefined {
  const priority = ['creator', 'deployer', 'owner', 'authority', 'payer'];
  for (const k of priority) {
    const v = kv[k];
    if (isValidMint(v)) return v;
  }
  return undefined;
}

function pickBuyerFromKeys(kv: KV): string | undefined {
  const priority = ['buyer', 'user', 'owner', 'trader', 'authority', 'wallet'];
  for (const k of priority) {
    const v = kv[k];
    if (isValidMint(v)) return v;
  }
  return undefined;
}

export function parseMoonshot(logs: string[], signature: string): ParseResult {
  try {
    if (!Array.isArray(logs) || logs.length === 0) return { why: 'no-logs' };
    const lines = logs;
    const text = lines.join('\n');
    const lc = lower(text);
    const kv = collectKeyValues(lines);

    const isCreate = lc.includes('createtoken') || lc.includes('create_token') || lc.includes('initializemint');
    const isBuy = lc.includes('buy');

    if (isCreate) {
      const mint = pickMintFromKeys(kv);
      const creator = pickCreatorFromKeys(kv);
      if (isValidMint(mint)) return { mint, creator };
      return { why: 'create-no-mint' };
    }
    if (isBuy) {
      const buyer = pickBuyerFromKeys(kv);
      if (isValidMint(buyer)) return { buyer };
      return { why: 'buy-no-buyer' };
    }

    // Generic mint field if present
    const mint = pickMintFromKeys(kv);
    if (isValidMint(mint)) return { mint };
    return { why: 'no-match' };
  } catch {
    return { why: 'parser-error' };
  }
}

