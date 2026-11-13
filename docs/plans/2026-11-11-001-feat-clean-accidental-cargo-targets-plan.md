# Clean accidental in-tree cargo targets

Date: 2026-11-11

## Problem

Deployer-managed `targets/<n>/` is already bounded, but IDE/`cargo` runs
against `worktrees/` or `.cache/pacto-app` still write default
`src-tauri/target` trees that `wipe` / `clean-targets` previously ignored.
Meanwhile sibling pacto-app clones outside this repo accumulate tens of GB
each; that reclaim belongs upstream (pacto-app issue), not in this wipe path.

## Approach

- List and wipe only `worktrees/<slug>/src-tauri/target` and
  `.cache/pacto-app/src-tauri/target` (path-escape checked).
- `status` reports accidental dirs; `clean-targets` and `up`/`reload` wipe
  them after the managed `targets/<n>` budget.
- Document that foreign clones use pacto-app `make clean-cargo` /
  `sweep-cargo`.
- File a pacto-app GitHub issue for proactive size gates on `make dev`.

## Files

- `src/lib/targets.mjs` — list / assert / wipe helpers
- `src/commands/lifecycle.mjs` — status + clean-targets
- `src/commands/up.mjs` — wipe after cargo budget
- docs / help / tests
