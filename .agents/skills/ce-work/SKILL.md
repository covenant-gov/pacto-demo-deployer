---
name: ce-work
description: Implements an approved plan in small verified units. Use when requirements and approach are settled and the user has authorized repository changes.
license: MIT
---

# Work

Implement the approved scope without expanding it.

## Workflow

1. Read `AGENTS.md` and confirm the current working tree before editing.
2. Select the next incomplete plan unit and inspect its current source.
3. Make the smallest coherent change that satisfies that unit.
4. Run focused checks immediately (`node pacto-demo.mjs help`, syntax); fix regressions before moving on.
5. Review the diff for secrets, seed phrases, unrelated cleanup, and isolation invariants.
6. Report completed behavior, changed files, and verification honestly.
7. Continue only according to the plan's review gates and user instructions.

Do not commit, push, wipe storage, or touch `io.pacto` unless the user
explicitly authorizes that operation.

## Blockers

Stop for a user decision when proceeding would require destructive action,
change agreed demo behavior, weaken an isolation invariant, or choose among
materially different architectures. Retry or use a safe alternative for
ordinary tooling friction.
