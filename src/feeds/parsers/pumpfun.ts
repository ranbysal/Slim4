// Lightweight, zero-RPC parser for Pump.fun onLogs payloads
// Extracts mint, buyer, creator when present in program logs.

export type ParseResult = { mint?: string; buyer?: string; creator?: string; why?: string };

const BASE58_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

// Keep in sync with watcher validation: 32–44 b58 and not obvious system/program ids
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
    // key:value pairs where value is base58-ish
    const rx = /(\b[a-zA-Z][a-zA-Z0-9_]{2,32})\s*[:=]\s*([1-9A-HJ-NP-Za-km-z]{32,44})/g;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(line)) !== null) {
      const k = lower(m[1]);
      const v = m[2];
      // first win per key
      if (!out[k]) out[k] = v;
    }
  }
  return out;
}

function allBase58(lines: string[]): string[] {
  const set = new Set<string>();
  for (const ln of lines) {
    const matches = ln.match(BASE58_RE) || [];
    for (const m of matches) set.add(m);
  }
  return Array.from(set);
}

function pickMintFromKeys(kv: KV): string | undefined {
  const priority = [
    'mint', 'token_mint', 'tokenmint', 'mint_address', 'mintaddress', 'mintpubkey', 'mintkey', 'targetmint',
    'token', 'token_address', 'tokenaddress', 'token_pubkey', 'tokenpubkey'
  ];
  for (const k of priority) {
    const v = kv[k];
    if (isValidMint(v)) return v;
  }
  return undefined;
}

function pickCreatorFromKeys(kv: KV): string | undefined {
  const priority = [
    'creator', 'deployer', 'owner', 'authority', 'payer', 'creatorauthority'
  ];
  for (const k of priority) {
    const v = kv[k];
    if (isValidMint(v)) return v;
  }
  return undefined;
}

function pickBuyerFromKeys(kv: KV): string | undefined {
  const priority = [
    'buyer', 'user', 'owner', 'trader', 'authority', 'account_owner', 'token_owner', 'wallet'
  ];
  for (const k of priority) {
    const v = kv[k];
    if (isValidMint(v)) return v;
  }
  return undefined;
}

export function parsePumpfun(logs: string[], signature: string): ParseResult {
  try {
    if (!Array.isArray(logs) || logs.length === 0) return { why: 'no-logs' };
    const lines = logs;
    const text = lines.join('\n');
    const kv = collectKeyValues(lines);
    const lc = lower(text);

    // Event hints
    const isCreate = lc.includes('create') || lc.includes('createtoken') || lc.includes('initializemint');
    const isBuy = lc.includes('buy');
    const isAddLiq = lc.includes('addliquidity') || lc.includes('add_liquidity');

    // Prefer explicit mint fields on create
    if (isCreate) {
      const mint = pickMintFromKeys(kv);
      const creator = pickCreatorFromKeys(kv);
      if (isValidMint(mint)) {
        return { mint, creator };
      }
      // Fallback: if no explicit key, but exactly one unique base58 shows up, take it
      const b58 = allBase58(lines).filter(isValidMint);
      if (b58.length === 1) return { mint: b58[0], creator };
      return { why: 'create-no-mint' };
    }

    // For buy/addLiquidity first block, try buyer-only hint from log KV pairs
    if (isBuy || isAddLiq) {
      const buyer = pickBuyerFromKeys(kv);
      if (isValidMint(buyer)) return { buyer };
      return { why: 'buy-no-buyer' };
    }

    // Unknown event kind; scan for explicit mint key if present
    const mint = pickMintFromKeys(kv);
    if (isValidMint(mint)) return { mint };
    return { why: 'no-match' };
  } catch {
    return { why: 'parser-error' };
  }
}

