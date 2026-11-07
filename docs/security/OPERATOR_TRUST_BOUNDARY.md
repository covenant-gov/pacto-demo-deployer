# Operator trust boundary (demo deployer)

This document describes how the pacto-demo-deployer treats **untrusted
checkout code** on an operator machine. It is not a security certification,
sandbox claim, or infection/cleanliness statement.

## What this tool does

On `up` / `reload` (and related variants) the deployer:

1. Clones or updates a GitHub remote (`PACTO_APP_REMOTE`, default
   [covenant-gov/pacto-app](https://github.com/covenant-gov/pacto-app)).
2. Fetches a branch or `pull/<n>/head` into a detached worktree.
3. Runs `pnpm install` in that worktree.
4. Spawns `pnpm tauri dev` (Rust/Vite build + desktop app) with demo
   isolation identifiers and ports.
5. Optionally drives the running app over a local MCP bridge.

The deployer CLI itself has **no** `package.json` dependencies. Risk is
dominated by the **checked-out pacto-app tree** and its install/build/run
lifecycle on the operator host.

## Explicit consent (`--trust-checkout`)

Before clone/fetch/install/spawn of:

- a real pacto-app **pull request** (`--pr` / `PR=` ≥ 1), or
- a **non-default** `PACTO_APP_REMOTE`,

the operator must pass `--trust-checkout` or set
`PACTO_DEMO_TRUST_CHECKOUT=1`.

Consent means: “I accept that this machine will install and run that
checkout.” It does **not** mean the PR author is verified, that the tree
is safe, or that the deployer can contain malicious code.

Default-remote branch launches and `PR=0` (pacto-app `main`) do not require
this flag. That is a friction choice for the common demo path, not a trust
endorsement of `main`.

## Dependency install default

Default:

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

Opt in to lifecycle scripts with `--allow-install-scripts` or
`PACTO_DEMO_ALLOW_INSTALL_SCRIPTS=1` when a checkout needs postinstall
tooling (for example some Vite/esbuild setups).

### Limits of `--ignore-scripts`

- Skips package `preinstall` / `install` / `postinstall` / `prepare` during
  that `pnpm install` invocation.
- Does **not** sandbox the later `tauri` / Cargo / Vite build.
- Does **not** sandbox the running desktop app or MCP-driven invokes.
- Does **not** inspect transitive dependency honesty or lockfile integrity
  beyond what `pnpm` already enforces with the frozen lockfile.

Treat `--ignore-scripts` as a **smaller install attack surface**, not as
isolation.

## Environment exposure

`pnpm install` and each `tauri dev` child start from a scrubbed copy of the
operator environment:

- Drop a denylist of common high-value credential variables
  (`GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN`, AWS session keys, and similar).
- Drop `PACTO_DEMO_SEED_*` names (seeds are passed only as
  `PACTO_DEV_LOGIN_MNEMONIC` when launching a seeded client).
- Still forward allowlisted pacto-app operator keys
  (`ALCHEMY_RPC_KEY`, …) from this repo’s `.env` / shell.

The deployer process itself may still use `gh` / `git` with the parent
environment to resolve PR metadata. Scrubbing reduces accidental inheritance
into install/build children; it is not a complete secret vault.

## What this does not provide

- No OS-level sandbox, VM, or disposable host for PR code.
- No promise that reviewing a PR author alone is sufficient.
- No claim that a host is “clean” or “infected.”
- No change to GitHub org settings, Actions, or release publishing.

## Operator checklist

1. Prefer `PR=0` / known branches when you only need a demo.
2. For PR demos: read the diff, then pass `--trust-checkout` deliberately.
3. Prefer default `--ignore-scripts`; enable install scripts only when the
   checkout cannot build without them.
4. Keep real seed phrases and RPC keys in gitignored `.env`; never commit them.
5. Stop clients with `down` / `wipe` when finished; do not point this tool at
   `io.pacto`.
