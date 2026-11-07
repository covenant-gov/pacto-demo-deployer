# Trust-boundary hardening for PR-sourced checkouts

Accepted 2026-11-07.

## Inventory (verified on `main`)

- This CLI has **no** `package.json` / lockfile / npm deps of its own.
- `src/lib/git.mjs`: clones any GitHub `PACTO_APP_REMOTE`, fetches
  `pull/<n>/head` (or a branch), creates a detached worktree, then runs
  `pnpm install --frozen-lockfile` with lifecycle **scripts on** and
  `process.env` inherited via `run()` → `spawnSync`.
- `src/lib/launch.mjs` `launchEnv`: `{ ...process.env }` into each
  `pnpm tauri dev`, then allowlists `APP_OPERATOR_ENV_KEYS` and strips
  sandbox vars only.
- MCP / session talk to an already-launched app; they do not install
  packages, but they execute against whatever code that install+build
  produced.
- Open PRs on this repo at investigation: **none**. Related org work is
  CI-focused elsewhere (e.g. pacto-app / homebrew-pacto); this change is
  local-operator consent + install/env hygiene, not Actions YAML.

## Goals

1. Explicit operator consent before install/build/run of **PR-sourced**
   (or non-default-remote) checkouts.
2. Safer compatible install default: `--ignore-scripts`, with an
   explicit opt-in to re-enable lifecycle scripts.
3. Reduce unnecessary credential inheritance into `pnpm install` and
   `tauri dev` without breaking demo ports/seeds/operator keys.
4. Document real limits: `--ignore-scripts` is not a sandbox; consent is
   not a safety claim; running PR code still executes build/runtime on
   the operator machine.

## Design

### Consent (`--trust-checkout` / `PACTO_DEMO_TRUST_CHECKOUT=1`)

Required before `pnpmInstall` + spawn when:

- resolved ref `kind === 'pr'`, **or**
- normalized `PACTO_APP_REMOTE` ≠ default `covenant-gov/pacto-app` remote.

Not required for default-remote branch/`PR=0` → `main` (still not
“safe”; just outside the PR/foreign-remote consent gate).

Refusal message must state that the operator is about to install and
run third-party checkout code locally; do not imply author trust equals
safety.

Single-client reuse of an already-installed live worktree still requires
consent when the live/requested ref would have needed it (so a forgotten
flag cannot silently continue a PR session path that performs install on
the next full up). When only reusing worktree with no install, still
require consent before spawning PR/foreign-remote code.

### Install scripts (`--allow-install-scripts` / `PACTO_DEMO_ALLOW_INSTALL_SCRIPTS=1`)

- Default: `pnpm install --frozen-lockfile --ignore-scripts`.
- Opt-in restores lifecycle scripts (needed for some pacto-app toolchain
  postinstalls such as esbuild downloads).
- `.env.example` documents the opt-in; does not silently force it in
  code for PR paths.

### Child environment scrubbing

- Shared helper builds a child env from `process.env` that drops a
  denylist of high-value credential names (`GITHUB_TOKEN`, `GH_TOKEN`,
  `NPM_TOKEN`, `NODE_AUTH_TOKEN`, AWS session keys, etc.) and never
  forwards `PACTO_DEMO_SEED_*` under those names.
- Used for `pnpm install` and `launchEnv` / `tauri` spawn.
- Deployer-side `gh` / `git` keep the parent env (auth still needed to
  fetch PR metadata).
- `APP_OPERATOR_ENV_KEYS` still applied after scrub (shell wins).

### Docs / skills

- README + `.env.example` + `usageText` + `AGENTS.md` + pacto-demo skill:
  consent flags, install default, limits.
- `docs/security/OPERATOR_TRUST_BOUNDARY.md`: honest limitations; no
  org-private infra wording; no infection/clean claims.

## Non-goals

- Adding a package.json/lockfile to this CLI.
- Sandboxing / containers / OS isolation for PR code.
- Changing wipe / `io.pacto` / port / seed backup invariants.
- Merges, settings, secrets, workflow dispatch, external messages.
- Executing unknown PR code or a real deploy in tests (mocks only).

## Verification units

1. Unit tests (mocks): consent gate, install argv, env scrub,
   launchEnv still forwards operator keys / strips denylist + sandbox.
2. Existing `node --test 'test/*.test.mjs'` stays green.
3. Help text shows new flags.
