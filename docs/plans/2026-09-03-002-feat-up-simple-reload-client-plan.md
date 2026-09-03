# up-simple and reload-client

Accepted 2026-09-03.

## Defaults

- **simple** = spawn `tauri dev`, wait until ready, write/merge `pids.json`. Still
  pass `PACTO_DEMO_SEED_N` / PIN / operator env. Skip deployer MCP:
  no `setupDemoName`, no broadcast / dm / squad.
- **`make reload`** stays full-session (`1..CLIENTS`), session setup, no broadcast.
- **`make reload-client`** = single-index path (`CLIENT` / `--client`), same
  sibling/worktree/cargo safety as `up-client`, session setup like `reload`
  (no Commons broadcast).

## Mode matrix

| Command | `onlyClient` | Session | Broadcast |
| --- | --- | --- | --- |
| `up` / `reload` | no | yes | no |
| `up-light` / `up-full` | no | yes | yes (+ dm/squad if full) |
| `up-client` | yes | yes | yes |
| `up-simple` | no | no | no |
| `up-simple-client` | yes | no | no |
| `reload-client` | yes | yes | no |

`resolveUpMode` in `src/commands/up.mjs` encodes this table.

## Non-goals

- Changing `make reload` / `make up-client` full-session or light behavior.
- Skipping `waitUntilReady`.
- Touching `io.pacto` or wiping storage.
