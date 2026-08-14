---
name: ce-compound
description: Captures a verified repository-specific solution for future contributors. Use after resolving a non-obvious recurring problem or establishing an important invariant.
license: MIT
---

# Compound a learning

Preserve knowledge that would otherwise need to be rediscovered. Do not create a
solution note for routine edits or unverified theories.

## Workflow

1. Confirm the solution is implemented or otherwise supported by repository evidence.
2. Search `docs/solutions/` to avoid duplicating an existing note.
3. Write a concise note containing:
   - problem and observable symptoms;
   - root cause and misleading approaches;
   - solution and invariants that must remain true;
   - relevant source paths;
   - verification steps and remaining limitations.
4. Remove secrets, seed phrases, personal data, transient logs, and machine-specific details.
5. Link the note from `AGENTS.md` only when it represents a broad rule.

Store notes under `docs/solutions/` with a descriptive kebab-case filename.
Prefer durable reasoning over session history, timestamps, or tool-specific
transcripts.
