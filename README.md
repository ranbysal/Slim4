Slim4 — Slim v4 + Jito (skeleton) — Day 1

Quick start

- npm install
- cp .env.example .env
- Fill RPC URLs and PORT in .env
- npm run db:init
- npm run dev

Visit http://localhost:3000/health and /status.

Feeds configuration

- Set program IDs in `.env` as comma-separated lists. Example:
  - `PUMPFUN_PROGRAM_IDS=PumpFunProgramIdHere1,AnotherIdHere2`
  - `LETSBONK_PROGRAM_IDS=`
  - `MOONSHOT_PROGRAM_IDS=`
  - `RAYDIUM_PROGRAM_IDS=RaydiumProgramIdHere`
  - `ORCA_PROGRAM_IDS=OrcaProgramIdHere`
  - `FEEDS_ENABLED=true`

On startup the watcher subscribes to the unique set of all provided program IDs. `/status` includes a `feeds` section with subscription count, per-origin event counters, and the timestamp of the last event.
