-- Meta table for schema/versioning and settings
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');

-- Positions represent open/closed exposure per market
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('long','short')),
  size_base REAL NOT NULL DEFAULT 0,
  avg_entry_price REAL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_market ON positions(market);

-- Orders placed to enter/exit positions
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_order_id TEXT,
  market TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  type TEXT,
  status TEXT NOT NULL,
  quantity_base REAL NOT NULL,
  price REAL,
  position_id INTEGER REFERENCES positions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_position ON orders(position_id);

-- Ensure single unitary-entry row per market
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_unique_unitary_entry
  ON orders(market, type)
  WHERE type = 'unitary-entry';

-- Trades executed, linked to positions and optionally orders
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  price REAL NOT NULL,
  size_base REAL NOT NULL,
  fee_sol REAL NOT NULL DEFAULT 0,
  jito_tip_sol REAL NOT NULL DEFAULT 0,
  realized_pnl_sol REAL NOT NULL DEFAULT 0,
  liquidity TEXT CHECK (liquidity IN ('taker','maker')),
  signature TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trades_position ON trades(position_id);
CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);

-- Halts represent trading halts or risk blocks
CREATE TABLE IF NOT EXISTS halts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market TEXT NOT NULL,
  reason TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cleared_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_halts_active ON halts(active);

-- Jito tip accounting
CREATE TABLE IF NOT EXISTS jito_tips_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id INTEGER REFERENCES trades(id) ON DELETE SET NULL,
  amount_sol REAL NOT NULL DEFAULT 0,
  budget_day TEXT NOT NULL, -- YYYY-MM-DD UTC
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jito_tips_day ON jito_tips_ledger(budget_day);
