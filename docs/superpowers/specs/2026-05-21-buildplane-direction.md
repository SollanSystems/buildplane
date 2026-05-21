# Buildplane Direction — 2026-05-21

> One clean statement of where the project is, what's being built next, and where it's headed long-term. Read this first.

## What Buildplane is

An operator-first control plane for autonomous software execution. Bounded workers execute coding tasks inside an evidence-first kernel that owns scheduling, state, policy, evidence, and recovery. Workers operate in isolated git worktrees under explicit capability bundles, with every action recorded to an append-only signed ledger. Admission to execution is gated by a deterministic planning layer (PlanForge); acceptance is gated by a verifiable contract (CI, scope, lint). Runs are replayable from the ledger.

The core idea is that LLM-driven agents should not be trusted as free-roaming actors. They should be bounded workers inside a kernel that owns the truth.

## Status at 2026-05-21 (honest)

**Shipped at HEAD of `main`:**
- Rust event ledger (`bp-ledger`), replay engine (`bp-replay`), fork primitive (`bp-fork`)
- TypeScript kernel: orchestrator, run loop, packet model, policy package, storage, memory retrieval
- Worktree isolation adapter
- Model adapters (Claude Code + Codex), per-provider renderers
- Tool sandbox (path validation, symlink rejection)
- Pack/host/provider Rust crates (manifest, loader, inspection)
- Operator CLI and terminal UI

**In flight on feature branches, NOT yet on `main`:**
- PlanForge dry-run CLI, schema, docs
- Run admission receipt persistence
- Mission Control read-only run inspector slice

**Aspirational, deferred to v∞:**
- Deterministic simulator, sealed cryptographic capability tokens, SLSA L3 attestation, sandbox tiers beyond worktree, Cedar/Rego/TLA+ policy, federation, multi-provider routing, mobile/IDE surfaces, skill library auto-extraction

**Known contradiction to fix this week:**
`packages/adapters-models/src/claude-code-executor.ts:96` spawns Claude Code with `--dangerously-skip-permissions`. This grants ambient authority and contradicts every safety claim Buildplane makes. M0 of v0.5 fixes this.

## Two documents, two horizons

| Document | Role | Horizon |
|---|---|---|
| [**v0.5 design**](./2026-05-21-buildplane-v05-design.md) | Implementation contract — the truth-bearing artifact. What is credibly being built in the next 6 months. Six named milestones (M0–M6). One end-to-end vertical slice demo. | **6 months focused** |
| [**v∞ design**](./2026-05-21-buildplane-vinf-world-class-design.md) | North Star vision — the aspirational ceiling. Combines Temporal durable execution + SLSA attestation + capability security + FoundationDB simulation + agent-coding semantics. Inspirational, not contractual. | **36+ months** |

The relationship is climbing-toward, not before-and-after. v0.5 is one slice of v∞ that's actually shippable now. The other layers of v∞ exist to keep the architectural integrity of v0.5 honest — every v0.5 decision is made with the v∞ end-state in mind, so v0.5 won't have to be torn out and rewritten.

## Lineage — how this direction was set

This direction is the result of:

1. **2026-05-21 brainstorm session.** Conducted in the `claude-code-orchestration` repo with Claude (Opus 4.7, 1M context) as head-dev advisor. The session ranked Buildplane vs. Hermes Nexus, Agent Orchestrator, claude-code-orchestration, and the headdev-extraction proposal — and concluded Buildplane has the strongest long-term architecture of the five.
2. **v∞ spec authored** as the world-class final form.
3. **Codex adversarial review** of the v∞ spec ran 30+ verification commands against the actual codebase. Returned 9 P1 / 8 P2 / 3 P3 findings. Caught material gaps between v∞ language and shipped state, most notably: PlanForge artifacts not on `main` despite v∞ claiming they were, `--dangerously-skip-permissions` contradicting all capability-security language, deterministic simulator claim treating multi-year research as a v1 deliverable, SLSA L3 self-certification being structurally circular.
4. **v0.5 design authored** as the response. Truth-bearing implementation contract. Drops the unbuildable claims; preserves the architecturally distinctive bones.

The Codex review itself is not committed; the lineage notes are.

## How to read these documents

| If you are... | Read this first |
|---|---|
| **A hiring manager or potential collaborator** | v0.5 — that's what's actually shippable. v∞ for ambition signal. |
| **A potential funder or investor** | v0.5 — the credible 6-month plan. v∞ for category framing. |
| **A future contributor or maintainer** | Both. v0.5 sets the contract; v∞ sets the architectural target so contributions don't drift. |
| **An enterprise evaluating for production use** | Wait for v0.5 to ship (target: month 6). Then revisit. |
| **The author (Sollan Systems)** | Both. v0.5 is the focus; v∞ is the ceiling you don't lose sight of. |
| **A curious reader** | v∞ for the vision; v0.5 if you want to see the discipline that turns vision into shippable software. |

## What ships in 6 months (v0.5 in one paragraph)

Single operator. Single machine. Claude provider only. Worktree-tier sandbox only. The kernel can accept a coding-task goal, compile it into a PlanForge plan, gate admission behind operator approval via a read-only web Mission Control, dispatch a worker into a fresh worktree under a typed capability bundle, validate every tool call against the bundle, record everything as signed events on the tape, validate the worker's output against an acceptance contract (CI green, lint clean, no out-of-scope files), and gate merge behind a second operator approval. Crash mid-flight and the kernel resumes from the tape. Every claim externally verifiable against the signed events. One vertical slice. One demo video. One v0.5.0 release.

That's it. That's what v0.5 is.

## What ships in 36+ months (v∞, briefly)

Multi-operator. Multi-provider. Sandbox tiers (worktree / gVisor / Firecracker / WASM). Deterministic FoundationDB-style simulator that fast-forwards entire runs under failure injection. Cryptographic capability tokens. SLSA-style provenance attestation chain. Cross-operator federation via signed tape exchange. Public transparency log integration. Mobile companion, IDE extensions, skill library auto-extraction. TLA+ verified safety invariants. Cedar + Rego policy languages.

The 36+ month version is a real research-and-product effort, probably multiple people. v0.5 is the credible self-built foundation that v∞ is built on top of when the project earns the right (via shipped v0.5, demonstrated traction, attracted collaborators) to attempt the larger work.

## What to do next

If you're the maintainer:

1. **Verify M0 readiness.** Confirm PlanForge feature-branch state and that consolidation to `main` is mergeable. Fix `--dangerously-skip-permissions`. Baseline integration tests green on a clean `main`. Estimated: 1 week.
2. **Plan M1** (per-event signing) using the `superpowers:writing-plans` skill against §6 L0 of the v0.5 spec.
3. **Publish v0.5 as a public-facing design** once committed. Write one essay summarizing it (the SLSA-for-agents narrative + the durable-execution-for-coding-agents narrative). Tag a v0.5.0-alpha tag when M0 lands.

If you're external and want to track the project: watch the `main` branch and look for the v0.5.0 release tag at month 6 (target: November 2026).

## License and ownership

Buildplane is owned by Sollan Systems. Public license decision (MIT / Apache 2.0 / dual / source-available) deferred until v0.5 ships. The v∞ vision contemplates an OSS-core + commercial-cloud business shape; v0.5 doesn't depend on that decision.

---

*This document is the canonical statement of project direction at 2026-05-21. It will be superseded by future dated direction snapshots as the project evolves; this one stays in history.*
