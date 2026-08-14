---
name: pacto-demo
description: Isolation, seeds, MCP, PIN unlock, and scenario layout for the Pacto demo deployer. Use when launching clients, adding a make target, or registering a src/scenarios module.
license: MIT
---

# Pacto demo deployer

## Isolation

- Clients are `io.pacto.demo.<n>` (`n >= 1`). Never `io.pacto`.
- Ports: `1420+10n` / `1421+10n` / `9223+100n`. Dual-stack `127.0.0.1` and `::1`.
- Do not set `PACTO_TEST_SANDBOX_ROOT` or `PACTO_DEV_WORLD`.
- Wipe only `io.pacto.demo.<n>` directories under the OS app-data root.

## Secrets

- `.env`, `backups/`, `pids.json` are gitignored. Never commit or log phrases.
- `PACTO_DEMO_SEED_N` → `PACTO_DEV_LOGIN_MNEMONIC`. PIN via `PACTO_DEMO_PIN` (default `123456`).
- After session: `get_seed` → `backups/client-<n>.txt` (0600), then `backup_verified=true`.

## MCP

- `ws://127.0.0.1:<mcpBridge>` → `execute_js` → `window.__TAURI__.core.invoke`.
- Unseeded clients after reload: fill **Enter your PIN** only, not Create/Confirm.

## Names and commands

- Client 1 `alpha-test`, client 2 `bravo-test` (`demoNameForIndex`).
- `make up` = launch + session + Commons user broadcast.
- `make dm` / `make squad` require live `pids.json`.
- Squad: MLS `announcements`, catalog upsert, invite DM, invitee Accept.
- `squad --join` accepts an existing invite; it does not create another squad.

## Adding a scenario

1. Add `src/scenarios/<id>.mjs` exporting `run(ctx, opts)`.
2. Register it in `src/scenarios/index.mjs`.
3. Wire a CLI/`make` target only if operators should run it alone.
4. Do not implement a path until its row in `docs/plans/` is agreed.
