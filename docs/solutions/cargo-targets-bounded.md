# Cargo `targets/` must stay bounded

## Problem

`CARGO_TARGET_DIR` is set to `targets/<n>/` per demo client. Cargo leaves old
hashed `.a` / `.rlib` fingerprints in `debug/deps` when the pacto-app SHA (or
crate graph) changes. Without cleanup, `targets/` grew without bound (tens of
GB) while `wipe` / `down --wipe` only deleted app-data under
`io.pacto.demo.<n>`.

## Solution

Before spawn, `ensureCargoTargetsBudget` wipes all client target dirs when the
pacto-app SHA changes, and wipes any single client dir over 12 GiB.
`pruneOrphanTargetDirs` removes indexes outside `1..CLIENTS`. Operators can
run `make clean-targets` anytime. `status` prints cargo target disk use.
`down` does not delete `targets/` so same-SHA relaunch stays cached.

## Invariant

App-data wipe (`wipe` / `down --wipe`) and cargo-target wipe (`clean-targets` /
SHA-change / budget) are separate. Never confuse either with `io.pacto`.

Worktrees under `worktrees/` keep only `main` and the active PR/branch slug;
`pruneStaleWorktrees` runs after each `ensureWorktree` so switching PRs does
not leave prior checkouts on disk.
