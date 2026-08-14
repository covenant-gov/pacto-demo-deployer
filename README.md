# Pacto demo deployer

Standalone launcher for N isolated Pacto desktop clients against a [covenant-gov/pacto-app](https://github.com/covenant-gov/pacto-app) branch or PR. It never touches the main `io.pacto` account.

Anyone can clone this repo, copy `.env.example` to `.env`, set `PR` / `CLIENTS` / seed phrases, and run `up`. `--pr` / `--branch` always refer to **pacto-app**, which this tool clones into `.cache/pacto-app` on first `up`. Isolation is applied at launch (`tauri dev --config` + env vars); no `demo:` commits are required on pacto-app.

## Prerequisites

- `git`
- `gh` (authenticated) — required for `--pr`
- `node` and `pnpm`
- Rust / Tauri toolchain (same as pacto-app)

## Usage

```bash
git clone <this-repo>
cd pacto-demo-deployer
cp .env.example .env    # then set PR, CLIENTS, and PACTO_DEMO_SEED_N

node pacto-demo.mjs up
node pacto-demo.mjs reload    # pull latest PR/branch commits and rebuild (storage kept)

node pacto-demo.mjs status
node pacto-demo.mjs down
node pacto-demo.mjs down --wipe

node pacto-demo.mjs wipe --client 1
node pacto-demo.mjs wipe --all
```

CLI flags override `.env` (`--pr`, `--branch`, `--clients`). Makefile equivalents:

```bash
make up
make up-full
make dm
make squad
make squad-join
make reload
make status
make down
make down-wipe
make wipe CLIENT=1
make wipe-all
```

First `up` clones [covenant-gov/pacto-app](https://github.com/covenant-gov/pacto-app) into `.cache/pacto-app`. Override the remote with `PACTO_APP_REMOTE` in `.env`.

Launch target and seed phrases live in `.env` (gitignored):

```
PR=123
CLIENTS=3
# BRANCH=feat/gov-ux-improvements

PACTO_DEMO_SEED_1="twelve words for the first account ..."
PACTO_DEMO_SEED_2="twelve words for the second account ..."
PACTO_DEMO_SEED_3="twelve words for the third account ..."
```

`PACTO_DEMO_SEED_N` logs into client N. Clients with no matching seed start on the welcome screen. Optional `PACTO_DEMO_PIN` (default `123456`). `--seed` on the CLI overrides the numbered `.env` slot for that client.

`reload` (or `up` again) fetches the current PR/branch HEAD, resets the worktree, reinstalls, and restarts clients. Storage is kept.

## Isolation

| Client | Identifier | App data (macOS) | Ports (dev / hmr / mcp) |
| --- | --- | --- | --- |
| 1 | `io.pacto.demo.1` | `~/Library/Application Support/io.pacto.demo.1` | 1430 / 1431 / 9323 |
| 2 | `io.pacto.demo.2` | `~/Library/Application Support/io.pacto.demo.2` | 1440 / 1441 / 9423 |
| n | `io.pacto.demo.n` | `~/Library/Application Support/io.pacto.demo.n` | `1420+10n` / `1421+10n` / `9223+100n` |

Index 0 (`io.pacto`, ports 1420 / 1421 / 9223) is reserved for your main client and is never used or deleted.

Storage survives `up` / `reload` / `down`. `down --wipe` (or `make down-wipe`) stops clients and deletes every `io.pacto.demo.<n>` directory. Per-client reset:

```bash
make wipe CLIENT=1
# rm -rf "$HOME/Library/Application Support/io.pacto.demo.1"
```

Seeded clients autologin with `PACTO_DEV_LOGIN_MNEMONIC` (PIN `123456` unless `PACTO_DEMO_PIN` / `--pin` / `PIN=`). Re-launching a client reopens its persisted account.

## Layout

CLI stays `pacto-demo.mjs` (Makefile target). Implementation lives under `src/`:

- `src/lib/` — config, isolation/ports, git worktree, MCP, session, launch
- `src/commands/` — `up` / `reload` / `up-full` and lifecycle (`down`, `status`, `wipe`)
- `src/scenarios/` — indexed demo paths (`broadcast`, `dm`, `squad`); add a module + registry row for a new branch test
- `AGENTS.md` — agent-agnostic instructions; `.agents/skills/` for CE loop + pacto-demo
- `docs/plans/` / `docs/solutions/` — accepted plans and compounded learnings

Runtime / gitignored:

- `.env` / `.env.example` — `PR` / `CLIENTS` / numbered seed phrases and optional `PACTO_APP_REMOTE`
- `.cache/pacto-app/` — clone of pacto-app (gitignored)
- `worktrees/<slug>/` — detached checkout of the chosen PR or branch
- `targets/<n>/` — per-client `CARGO_TARGET_DIR` (identifiers differ, so binaries cannot share `target/`)
- `logs/client-<n>.log` — `tauri dev` output
- `pids.json` — running client PIDs for `down` / `status`
