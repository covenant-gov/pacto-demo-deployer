# Pacto demo deployer

Standalone launcher for N isolated Pacto desktop clients against a [covenant-gov/pacto-app](https://github.com/covenant-gov/pacto-app) branch or PR. It never touches the main `io.pacto` account.

Anyone can clone this repo, copy `.env.example` to `.env`, set `PR` / `CLIENTS` / seed phrases / pacto-app operator keys, and run `up`. `--pr` / `--branch` always refer to **pacto-app**, which this tool clones into `.cache/pacto-app` on first `up`. Isolation is applied at launch (`tauri dev --config` + env vars); no `demo:` commits are required on pacto-app.

## Prerequisites

- `git`
- `gh` (authenticated) — required for `--pr` / `PR=` when the value is a real pull request (`PR=0` uses `main` and does not need `gh`)
- `node` and `pnpm`
- Rust / Tauri toolchain (same as pacto-app)

## Usage

```bash
git clone <this-repo>
cd pacto-demo-deployer
cp .env.example .env    # then set PR, CLIENTS, PACTO_DEMO_SEED_N, and ALCHEMY_RPC_KEY
```

Launch (CLI flags override `.env`):

```bash
make up                 # login, backup seed, profile, Commons user broadcast
make up-full            # up, then DMs + squad
make reload             # fetch latest PR/branch commits and rebuild (storage kept)
make up PR=123 CLIENTS=3
make up PR=0                # pacto-app main
make up BRANCH=feat/gov-ux-improvements CLIENTS=2
```

Scenarios on a live session (`pids.json` required):

```bash
make dm
make squad
make squad NAME=my-squad
make squad-all
make squad-join         # accept a pending invite without creating another squad
```

Lifecycle:

```bash
make status
make down
make down-wipe
make wipe CLIENT=1
make wipe-all
```

Node equivalent: `node pacto-demo.mjs <command>` with the same flags (`--pr`, `--branch`, `--clients`, `--full`, `--all`, `--join`, `--name`, `--wipe`). `make help` prints the full list.

First `up` clones [covenant-gov/pacto-app](https://github.com/covenant-gov/pacto-app) into `.cache/pacto-app`. Override the remote with `PACTO_APP_REMOTE` in `.env`.

Launch target and seed phrases live in `.env` (gitignored):

```
PR=0
CLIENTS=3
# BRANCH=feat/gov-ux-improvements

PACTO_DEMO_SEED_1="twelve words for the first account ..."
PACTO_DEMO_SEED_2="twelve words for the second account ..."
PACTO_DEMO_SEED_3="twelve words for the third account ..."
```

`PR=0` checks out pacto-app `main`. `PR=123` is a GitHub pull request. `BRANCH=` is a remote branch name. `PR=` (>= 1) and `BRANCH=` are mutually exclusive; `PR=0` with `BRANCH=` uses the branch.

`PACTO_DEMO_SEED_N` logs into client N. Clients with no matching seed start on the welcome screen. Optional `PACTO_DEMO_PIN` (default `123456`). `--seed` on the CLI overrides the numbered `.env` slot for that client.

pacto-app debug secrets (`ALCHEMY_RPC_KEY`, `POCKET_RPC_KEY`, `PIMLICO_API_KEY`, and the other names in pacto-app's [`.env.example`](https://github.com/covenant-gov/pacto-app/blob/main/.env.example)) also live in this repo's `.env`. `up` / `reload` forward the allowlisted keys into each `tauri dev` process. A variable already set in the shell wins. Values are never logged.

`reload` (or `up` again) fetches the current PR/branch HEAD, resets the worktree, reinstalls, and restarts clients. Storage is kept.

## Commands

| Command | What it does |
| --- | --- |
| `up` | Launch clients, login/create, write `backups/client-<n>.txt`, set demo names (`alpha-test`, `bravo-test`, …), Commons user broadcast |
| `up-full` | `up`, then `dm`, then `squad` |
| `reload` | Same launch path as `up` after updating the pacto-app worktree |
| `dm` | Client 1 DMs the others; they reply. Requires a live session |
| `squad` | Client 1 creates MLS `announcements`, invites client 2 (or `--all`), invitee Accept. Default name `alpha-squad-test-<n>` |
| `squad-join` | Accept a pending invite for the latest creator squad (or `NAME=`). Does not create another squad |
| `status` / `down` / `wipe` | Inspect, stop (after retracting Commons user and squad broadcasts), or delete `io.pacto.demo.<n>` storage |

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

Seeded clients autologin with `PACTO_DEV_LOGIN_MNEMONIC` (PIN `123456` unless `PACTO_DEMO_PIN` / `--pin` / `PIN=`). Re-launching a client reopens its persisted account. After session, the deployer writes the recovery phrase to gitignored `backups/client-<n>.txt` (mode 0600) and does not log it.

## Layout

CLI stays `pacto-demo.mjs` (Makefile target). Implementation lives under `src/`:

- `src/lib/` — config, isolation/ports, dev-port claims, git worktree, MCP, session, launch
- `src/commands/` — `up` / `reload` / `up-full` and lifecycle (`down`, `status`, `wipe`)
- `src/scenarios/` — indexed demo paths (`broadcast`, `dm`, `squad`); add a module and one row in [`src/scenarios/index.mjs`](src/scenarios/index.mjs) for a new branch test
- Planned scenario ids: [`docs/plans/2026-08-13-001-feat-demo-scenario-paths-plan.md`](docs/plans/2026-08-13-001-feat-demo-scenario-paths-plan.md)
- `AGENTS.md` — agent-agnostic instructions; `.agents/skills/` for CE loop + pacto-demo
- `docs/plans/` / `docs/solutions/` — accepted plans and compounded learnings

Runtime / gitignored:

- `.env` / `.env.example` — `PR` (`0` = pacto-app `main`) / `CLIENTS` / numbered seed phrases, optional `PACTO_APP_REMOTE`, and pacto-app operator keys (`ALCHEMY_RPC_KEY`, …)
- `.cache/pacto-app/` — clone of pacto-app (gitignored)
- `worktrees/<slug>/` — detached checkout of the chosen PR or branch
- `targets/<n>/` — per-client `CARGO_TARGET_DIR` (identifiers differ, so binaries cannot share `target/`)
- `logs/client-<n>.log` — `tauri dev` output
- `pids.json` — running client PIDs for `down` / `status` / scenarios
- `backups/client-<n>.txt` — seed phrases after session (mode 0600; never commit)

## Tests

Plain `node --test`, no dependencies or build step:

```bash
node --test 'test/*.test.mjs'
```

`test/cross-repo-claims.test.mjs` skips cleanly unless a pacto-app checkout is
present at `PACTO_APP_DEV_PORTS` (default `/Users/opselite/src/covenant-gov/pacto-app/scripts/dev-ports.mjs`).
`test/unsafe-ports-drift.test.mjs` skips cleanly unless `.cache/pacto-app` has
been populated by a prior `up`.
