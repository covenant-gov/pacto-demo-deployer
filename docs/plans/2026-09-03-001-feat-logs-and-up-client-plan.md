# Single-client logs and up-client

Accepted 2026-09-03.

## Why this is needed

`src/commands/up.mjs` always:

1. Stops **every** live row in `pids.json` (`cmdDown`).
2. Spawns indexes `1..CLIENTS` (so `CLIENTS=2` always touches client 1).
3. Calls `pruneOrphanTargetDirs(clients)` and `ensureCargoTargetsBudget({ clients })`, which would wipe `targets/2` if you naively passed `clients=1` while launching index 2.
4. Force-updates the shared worktree via `ensureWorktree` (hard reset + clean), which would disrupt a still-running sibling.

Storage for `io.pacto.demo.<n>` is already per-index. Isolation is preserved as long as we **never spawn or wipe other indexes**. Logs already land at `logs/client-<n>.log`; there was no follow command.

## 1. `make logs`

- CLI command `logs` → `cmdLogs` in `src/commands/lifecycle.mjs`.
- Index: `--client` / `make logs LOG_CLIENT=2` → else `LOG_CLIENT` from `.env` → else error.
- Follow `logs/client-<n>.log` with `tail -F`. Missing file is a loud error (do not create an empty file).

## 2. `make up-client` (single-index up-light)

- Always light: login + Commons user broadcast for **that client only**.
- Index: `--client` / `CLIENT` in `.env`. Seed: only `PACTO_DEMO_SEED_<n>`.
- Do **not** call full `cmdDown`. Stop only that index if it is live. Merge `pids.json`.
- When siblings are alive: reuse worktree; refuse SHA switch; cargo size-check only `targets/<n>`; no orphan prune; no wipe-all.
- When no siblings: normal checkout, still spawn only index `n`.

`reload` / `make up` / `make up-light` stay full-session (`1..CLIENTS`).

## Non-goals

- Changing `make up-light` to honor `CLIENT`.
- Multi-client log mux, log rotation, or Windows `tail`.
- `up-client --full` / squad/DM.
- Wiping or writing `io.pacto`.
