# Cap cargo `targets/` disk growth

Date: 2026-09-02

## Problem

Per-client `CARGO_TARGET_DIR` under `targets/<n>/` accumulated stale Cargo
debug fingerprints across pacto-app SHA changes with no lifecycle. Operators
saw multi-gigabyte `libpacto_lib.a` copies and tens of GB of orphaned deps,
filling the laptop disk.

## Approach

- Wipe all `targets/<n>` when the launched pacto-app SHA changes.
- Wipe any client dir over 12 GiB before spawn (same-SHA safety net).
- Prune `targets/<m>` for indexes outside `1..CLIENTS`.
- `clean-targets` / `make clean-targets` for a manual full wipe (not app-data).
- `status` reports per-client and total cargo target sizes.
- Ordinary `down` does not wipe cargo targets (same-SHA relaunch stays fast).

## Files

- `src/lib/targets.mjs` — helpers
- `src/commands/up.mjs` — budget + orphan prune before spawn
- `src/commands/lifecycle.mjs` — status + `cmdCleanTargets`
- `pacto-demo.mjs` / `Makefile` / docs / `test/targets.test.mjs`
