---
"buildplane": minor
---

add the `bp goal "<text>"` subcommand (M6 demo step 1) — turn a raw operator goal into a compiled-and-previewed PlanForge plan JSON. It auto-detects the trusted base from git `HEAD` and the remote from `origin` (overridable with `--trusted-base <sha>`), synthesizes the PlanForge input markdown (`## Goal` / `## Repository context` incl. a `Trusted base:` line / `## Safety constraints` / `## Tasks`), runs the `compile → validate → preview` pipeline, and emits JSON surfacing `planDigest`, `trustedBase`, `remote`, `riskClass`, `status`, `missingEvidence`, and the full plan. A dirty worktree warns (and pins to HEAD) unless `--trusted-base` is given. A bare goal validates to `INSUFFICIENT_EVIDENCE` (empty `## Tasks`) — `bp goal` is display-only and exits 0 regardless of validation status; it never admits, executes, or causes side effects.
