# Operator trust boundary for PR checkouts

## Problem

The demo deployer fetches pacto-app PR heads (or an arbitrary GitHub
`PACTO_APP_REMOTE`), runs `pnpm install`, then builds/runs `tauri dev` on the
operator machine. Before hardening, install used lifecycle scripts by default
and child processes inherited the full parent environment, with no explicit
consent step for PR/foreign-remote code.

## Solution

- Require `--trust-checkout` / `PACTO_DEMO_TRUST_CHECKOUT=1` before
  clone/install/run when the target is a PR or non-default remote.
- Default to `pnpm install --frozen-lockfile --ignore-scripts`, with
  `--allow-install-scripts` as an explicit escape hatch.
- Scrub denylisted credentials and `PACTO_DEMO_SEED_*` from install/launch
  child envs; keep deployer `git`/`gh` on the parent env.
- Document honest limits in `docs/security/OPERATOR_TRUST_BOUNDARY.md`
  (no sandbox / no author-trust-as-safety claims).

## Why

Consent makes the trust decision visible. `--ignore-scripts` shrinks
install-time script execution without pretending to contain build/runtime.
Env scrubbing reduces accidental credential inheritance without adding npm
dependencies to this dependency-free CLI.
