# Repository agent guide

This is the canonical instruction file for coding agents in this repository.
Host-specific files may import it, but must not duplicate or override it.

## Project posture

This repository launches **isolated** Pacto desktop demo clients
(`io.pacto.demo.<n>`). It clones [covenant-gov/pacto-app](https://github.com/covenant-gov/pacto-app),
checks out a PR or branch, and drives N `tauri dev` windows over MCP.

- Never use, write, or delete **`io.pacto`** (the operator’s main client).
- Never log seed phrases, mnemonics, backup file contents, or pacto-app
  operator secrets (`ALCHEMY_RPC_KEY`, `PIMLICO_API_KEY`, and the rest of
  `APP_OPERATOR_ENV_KEYS`).
- Default PIN is `123456` (`PACTO_DEMO_PIN` / `--pin`).
- Isolation is identifier + ports + app-data directory only. Do not set
  `PACTO_TEST_SANDBOX_ROOT` or `PACTO_DEV_WORLD`.
- pacto-app RPC / bundler keys live in this repo's `.env` and are forwarded
  into each `tauri dev` process (`APP_OPERATOR_ENV_KEYS`). Shell env wins
  over the file. Do not write `.env` into pacto-app worktrees.

Use a plan-first workflow for isolation, wipe, MCP invoke, seed backup, or
scenario changes. Do not commit, push, or wipe storage unless the user
explicitly asks.

## Repository map

- `pacto-demo.mjs` — CLI entry (`parseArgs`, command switch). Makefile target.
- `src/lib/` — config, process/isolation, git/worktree, MCP, session, launch.
- `src/commands/` — `up` / `reload` / `up-light` / `up-full` and lifecycle (`down`, `status`, `wipe`).
- `src/scenarios/` — indexed demo paths (`broadcast`, `dm`, `squad`). Add a
  module and one registry row for a new branch test.
- `.agents/skills/` — CE loop plus `pacto-demo`.
- `docs/plans/` — accepted implementation plans.
- `docs/solutions/` — compounded learnings after non-obvious fixes.
- `.env` / `backups/` / `pids.json` — gitignored. Do not commit them.

## Commands

```bash
make up              # launch, login/create, backup seed, profile
make up-light        # up + Commons user broadcast
make up-full         # up-light + DMs + squad (client 1 invites client 2; invitee accepts)
make up-client       # up-light for CLIENT / --client only (other clients untouched)
make logs            # follow logs/client-<n>.log (LOG_CLIENT / --client)
make dm
make squad
make squad NAME=my-squad
make squad-all
make squad-join      # accept pending invite (latest creator squad, or NAME=)
make reload
make down
make down-wipe
make wipe CLIENT=1
make status
make clean-targets   # delete targets/<n> cargo artifacts (not app-data)
```

CLI flags override `.env` (`--pr`, `--branch`, `--clients`, `--client`, `--pin`, `--name`).
`--pr` / `--branch` always refer to pacto-app. `PR=0` / `--pr 0` checks out
pacto-app `main`.

## Invariants

- Identifiers are `io.pacto.demo.<n>` with `n >= 1`. Ports: `1420+10n` /
  `1421+10n` / `9223+100n`. Index 0 ports `1420/1421/9223` are reserved.
- Dual-stack probes on `127.0.0.1` and `::1` before bind and for ready checks.
- Dev-port claims: before binding, and again once bound, each client
  participates in pacto-app's on-disk claim protocol
  (`<os.tmpdir()>/pacto-dev-ports-claims/index-<n>.claim.json`, see
  `src/lib/claims.mjs`) so this repo and pacto-app sandboxes never silently
  race for the same localhost ports. A live foreign claim is a loud refusal,
  never a silent port change — this repo's ports are pinned to the client
  number.
- Cargo `targets/<n>/` is bounded: wipe on pacto-app SHA change, when a client
  dir exceeds 12 GiB, when pruning unused client indexes, or via
  `clean-targets`. This is separate from app-data `wipe` / `down --wipe`.
  Never confuse either with `io.pacto`.
- Worktrees under `worktrees/` keep only `main` and the active PR/branch slug;
  switching PR/branch removes prior checkouts.
- MCP: `ws://127.0.0.1:<mcpBridge>` → `execute_js` → `window.__TAURI__.core.invoke`.
- Unseeded clients land on **Enter your PIN** after webview reload; paste the
  demo PIN onto unlock digits only (not Create/Confirm).
- After session, persist `get_seed` under `backups/client-<n>.txt` (mode 0600)
  and set `backup_verified=true` before PIN UI unlock.
- Squad create uses MLS group name `announcements`, then `upsert_squad`, Sepolia
  network override, invite DM `type: 'squad_invite'`, Commons squad broadcast,
  then invitee Accept (`accept_mls_welcome` / Accept click). Client 1 is
  `alpha-test`, client 2 `bravo-test`. Do not rotate invitee keypackages
  immediately before `create_group_chat`; wait until the creator can
  `refresh_keypackages_for_contact`, and re-invite with a fresh package if no
  pending welcome appears.
- Commons demo broadcast copy appends a local date-time stamp
  (`formatDemoStamp`) to user and squad messages.
- `down` retracts every demo Commons broadcast still live on a client: user
  (`subject: 'user'`, `subjectId: npub`) and each catalog squad
  (`subject: 'squad'`, `subjectId: groupId`). Invitees without bot keys cannot
  retract a squad card; that miss is expected.
- Profile `update_profile` is best-effort. Skip Kind-0 when `get_profile` name
  already matches `demoNameForIndex`.

## Knowledge workflow

Read `AGENTS.md` and matching `docs/solutions/` notes before isolation or
scenario work. Put accepted plans in `docs/plans/`. After a reusable
repository-specific fix, capture the invariant in `docs/solutions/`.

Skills live in `.agents/skills/` (`ce-plan`, `ce-work`, `ce-code-review`,
`ce-compound`, `pacto-demo`).
