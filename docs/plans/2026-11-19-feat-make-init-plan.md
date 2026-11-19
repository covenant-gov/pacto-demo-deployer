# make init

Accepted 2026-11-19.

## Defaults

- Same clone / worktree / install / spawn / `waitUntilReady` path as `up-simple`.
- Never set `PACTO_DEV_LOGIN_MNEMONIC` or `PACTO_DEV_LOGIN_PIN` in the child env (even when `.env` has seeds / `PIN=`).
- Still forward `APP_OPERATOR_ENV_KEYS`. Skip deployer MCP (no `setupDemoName`, broadcast, dm, squad).
- `pids.json` rows use `seeded: false` and `name: null` for init launches.
- App-data is kept; UI may be welcome or PIN from prior runs; deployer does not auto-enter PIN.

## Mode matrix (addition)

| Command | `onlyClient` | Session | Broadcast | `bareAuth` |
| --- | --- | --- | --- | --- |
| `init` | no | no | no | yes |

`resolveUpMode` in `src/commands/up.mjs` encodes this row (`init` implies `simple`).

## Non-goals

- `init-client`, `reload-init`, automatic storage wipe.
- Changing `up-simple` / `reload-simple`.