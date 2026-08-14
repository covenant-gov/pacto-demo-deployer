---
name: ce-code-review
description: Reviews a change for correctness, regressions, isolation safety, and missing verification. Use before merging or when the user asks for a code or pull-request review.
license: MIT
---

# Code review

Review the actual diff and repository behavior. Findings are more important than
a general summary.

## Workflow

1. Read `AGENTS.md`, the diff, affected modules, and any matching `docs/solutions/` notes.
2. Trace success, failure, retry, and race paths (ports, MCP, PIN unlock, MLS welcome).
3. Apply heightened scrutiny to identifiers, wipe paths, seed backups, and MCP invoke.
4. Confirm the change cannot target `io.pacto` or log mnemonics.
5. Report only actionable findings supported by concrete evidence.

Order findings by severity. For each finding, cite the path/line, explain the
failure scenario and impact, and suggest the smallest safe correction. Distinguish
must-fix defects from optional improvements.

Explicitly say when no findings remain, but note any checks that could not be
run.
