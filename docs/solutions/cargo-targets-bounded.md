# Cargo `targets/` must stay bounded

## Problem

`CARGO_TARGET_DIR` is set to `targets/<n>/` per demo client. Cargo leaves old
hashed `.a` / `.rlib` fingerprints in `debug/deps` when the pacto-app SHA (or
crate graph) changes. Without cleanup, `targets/` grew without bound (tens of
GB) while `wipe` / `down --wipe` only deleted app-data under
`io.pacto.demo.<n>`.

A second failure mode: opening a deployer worktree (or the `.cache/pacto-app`
clone) in an IDE / running `cargo` without `CARGO_TARGET_DIR` writes the
default `src-tauri/target` tree. That path is not the managed `targets/<n>`
dir, so the original budget missed it. Separately, day-to-day pacto-app
checkouts outside this repo each grow their own `src-tauri/target` (often
tens of GB); this deployer never owns those trees.

## Solution

Before spawn, `ensureCargoTargetsBudget` wipes all client target dirs when the
pacto-app SHA changes, and wipes any single client dir over 12 GiB.
`pruneOrphanTargetDirs` removes indexes outside `1..CLIENTS`.

`up` / `reload` / `clean-targets` also wipe accidental in-tree dirs under
deployer-owned paths only:

- `worktrees/<slug>/src-tauri/target`
- `.cache/pacto-app/src-tauri/target`

`status` reports managed `targets/<n>` and any accidental in-tree dirs, and
points operators at pacto-app `make clean-cargo` / `sweep-cargo` for sibling
clones. `down` does not delete cargo artifacts so same-SHA relaunch stays
cached.

## Invariant

Three separate reclaim surfaces:

1. App-data wipe (`wipe` / `down --wipe`) — only `io.pacto.demo.<n>`.
2. Managed cargo (`targets/<n>`) — SHA-change / 12 GiB / orphan prune /
   `clean-targets`.
3. Accidental in-tree cargo under `worktrees/` and `.cache/pacto-app` —
   wiped with (2) on `up` / `reload` / `clean-targets`.

Never confuse any of these with `io.pacto`. Never delete foreign pacto-app
checkouts from this repo.

Worktrees under `worktrees/` keep only `main` and the active PR/branch slug;
`pruneStaleWorktrees` runs after each `ensureWorktree` so switching PRs does
not leave prior checkouts on disk.
