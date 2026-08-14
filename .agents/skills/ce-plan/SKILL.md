---
name: ce-plan
description: Produces a reviewable implementation plan grounded in this repository. Use before multi-file, isolation, wipe, MCP, seed-backup, or scenario-registry changes.
license: MIT
---

# Plan

Convert an agreed outcome into an implementation sequence. Do not implement the
change while planning.

## Workflow

1. Read `AGENTS.md`, relevant source under `src/`, and any matching `docs/solutions/` notes.
2. Trace the current behavior through CLI → commands → scenarios → MCP/Tauri.
3. Separate implemented safeguards from documentation or aspirational controls.
4. Resolve choices that materially affect isolation, wipe safety, or demo behavior.
5. List the exact files and responsibilities that will change.
6. Break work into small, independently reviewable units.
7. Attach focused verification to each unit (help text, `make status`, a live MCP path).
8. Identify explicit non-goals and destructive operations requiring human approval.

Plans that touch identifiers, ports, wipe paths, seed backups, or `io.pacto`
must preserve the invariants in `AGENTS.md` and require human review.

## Output

Write accepted plans under `docs/plans/` when the work is substantial enough to
benefit future contributors. Keep a simple change plan in chat for small work.
