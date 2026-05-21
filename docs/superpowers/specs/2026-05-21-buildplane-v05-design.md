# Buildplane v0.5 — evidence-first local execution harness

| | |
|---|---|
| **Status** | Draft / Implementation contract |
| **Date** | 2026-05-21 |
| **Author** | Sollan Systems |
| **Target horizon** | ~6 months focused work |
| **Companion** | [v∞ World-class final form](./2026-05-21-buildplane-vinf-world-class-design.md) — North Star vision, not contractual |
| **Lineage** | Rewrite of v∞ scope after the 2026-05-21 Codex adversarial review caught material gaps between v∞ spec language and shipped state. v0.5 is the truth-bearing artifact; v∞ is the inspirational ceiling. |
| **Cross-refs** | `docs/architecture/buildplane-package-architecture.md`, `docs/architecture/planforge.md` (feature-branch only), `docs/architecture/run-admission-receipts.md`, `docs/architecture/rust-native-host-runtime.md`, `docs/ledger.md` |

---

## 1. Honest status at 2026-05-21

Status is the first section, not an appendix. The v∞ spec relegated honesty to back-matter; v0.5 leads with it.

### Shipped at HEAD of `main`

- Rust ledger: `bp-ledger` (append-only event tape with SQLite + CAS, content-addressed storage, backpressure stabilized via shared drainPromise)
- Rust replay: `bp-replay` (event-folder semantics — reconstructs state by replaying recorded events; this is NOT a FoundationDB-style deterministic simulator, despite v∞ aspirational language)
- Rust fork: `bp-fork` (creates new run from a unit boundary using pre-unit git checkpoint + supplied packet)
- TypeScript kernel: `packages/kernel` — orchestrator, run loop, packet model, memory retrieval hooks
- TypeScript policy: `packages/policy` — TS predicates for budgets, trust gates, retry, approval profiles
- TypeScript storage: `packages/storage` — SQLite-backed durable state, event store, learning store, memory schema, repo facts, procedures, searchable documents
- TypeScript ledger client: `packages/ledger-client` — wire protocol, envelope, backpressure, payload typing, fixture generation
- Worktree isolation: `packages/adapters-git` — git worktree adapter
- Model adapters: `packages/adapters-models` — Claude Code + Codex executors, per-provider renderers
- Tool sandbox: `packages/adapters-tools` — path normalization, symlink rejection (NOT capability-secure)
- Native pack model: `bp-pack-manifest`, `bp-pack-loader`, `bp-pack-inspection`
- Memory: `bp-memory` (Rust) + `memory-retrieval.ts` (TS) — 5-layer model scaffold (Working/Episodic/Semantic/Procedural/Outcome)
- Operator CLI: `apps/cli`
- Terminal UI: `packages/ui-tui` (Ink/React)

### In flight on feature branches, NOT on main

- PlanForge dry-run CLI + schema + docs: `feat/planforge-schema-extraction-v2`, `feat/planforge-pf1-spec-*`, `feat/planforge-pf2-cli-*`, `docs/planforge-doc-contract-reconcile`
- Run admission receipt persistence: `bp5b-admission-receipt-persistence-*`
- Admission secret hygiene: `bp5bf-admission-secret-hygiene-*`
- Run inspector / Mission Control read-only slice: `buildplane-inspector-mvp` (remote)
- Run loop admission wiring: `bp6b-run-loop-admission-wiring`, `bp6a-run-loop-admission-checkpoint-*`

### Does not exist anywhere yet

- Per-event signatures
- Capability tokens (sealed or otherwise) — current "policy" is TS-predicate function calls
- Deterministic simulator
- Sandbox tiers beyond worktree (no gVisor, Firecracker, or WASM)
- Cedar / Rego / TLA+ formal policy
- Cross-operator federation primitive
- Multi-provider routing
- Mobile / IDE / FaceID surfaces
- Skill library auto-extraction beyond current `procedures` schema
- Public transparency log integration

### Known contradiction to fix immediately

`packages/adapters-models/src/claude-code-executor.ts:96` spawns Claude Code with `--dangerously-skip-permissions`. This grants ambient authority and directly contradicts the safety-first language in both v0.5 and v∞ specs. This is **Milestone 0**.

## 2. Thesis

**v0.5 thesis: an evidence-first local execution harness for coding agents.**

That's it. No SLSA L3 brand-claim. No FoundationDB-grade simulator promise. No sealed cryptographic capability tokens. No federation. Single-operator, single-machine, single-provider (Claude), worktree-tier isolation. What the v∞ spec inspires is preserved verbatim in its own document; what v0.5 promises is a strict subset that the code can credibly support in six months.

The narrower thesis is not a retreat. It is what the project already has a path to and what an external observer (hiring manager, collaborator, evaluator) can verify by reading the v0.5 milestones and the code together.

## 3. Non-goals — explicit deferrals to v∞

The following are listed in v∞ but explicitly **out of v0.5 scope**:

| Item | Where it lives | Reason for deferral |
|---|---|---|
| FoundationDB-style deterministic simulator | v∞ §9 | Multi-year research project; replaces TS event loop + Rust kernel + LLM API + git + CI with a deterministic substitute. Not credible in 6 months. |
| Sealed cryptographic capability tokens | v∞ §3 / §6 L2 | v0.5 uses policy broker + worktree sandbox + tool-allowlist combo. Sealed tokens are a v1.5+ topic once the broker exists. |
| SLSA L3 attestation | v∞ §6 L6 / §7 | SLSA L3 requires independently hardened builder; self-certifying kernel can't claim it. v0.5 emits signed provenance, not L3. |
| gVisor / Firecracker / WASM sandbox tiers | v∞ §6 L4 | Cross-platform parity issues + integration cost. v0.5 is worktree-tier only. |
| Cedar / Rego / TLA+ formal policy | v∞ §6 L7 | Premature without a real invariant having hurt yet. v0.5 keeps TS predicates. |
| Cross-operator federation | v∞ §6 L0 / §7 | No clear buyer; deferred until a compliance or marketplace use case appears. |
| Multi-provider routing optimization | v∞ §6 L3 | Claude-only in v0.5. Adding routing requires renderer-version-in-tape + trust scoring, both deferred. |
| Mobile / IDE / FaceID | v∞ §6 L9 / §10 | Mobile companion is v2. IDE extensions are v2.5. v0.5 demo uses web UI approval click. |
| Skill library auto-extraction | v∞ §6 L5 | Procedural memory exists as schema; extraction loop is research. v0.5 uses manual playbook authoring. |
| Public transparency log | v∞ §6 L0 / §6 L9 | Sigstore Rekor integration deferred. v0.5 tape is local-signed only. |

Each entry remains a real future direction. None of them are v0.5 promises.

## 4. The constitution — six invariants, honestly framed

1. **No claim without evidence.** Every state transition is justified by a ledger event with a content-addressed evidence hash. Enforced by: existing `bp-ledger` + tape append being mandatory in `command-executor`, `model-executor` paths. **Gap to close in v0.5:** post-activity event must precede any state advance; currently `command-exit` + `output-check` events exist but are not gating state.

2. **No execution without admission.** A goal cannot become work until a PlanForge plan exists and is approved. Enforced by: PlanForge (after consolidation to main + completion of admit → execute wiring). **Gap to close in v0.5:** the admit → dispatch path itself.

3. **All authority is policy-mediated.** Workers act under permissions granted by the policy broker for the current Compact. The kernel never grants ambient authority by default. Enforced by: policy package decisions gating each tool call + worktree boundary. **Gap to close immediately (M0):** remove `--dangerously-skip-permissions` from Claude Code executor. Without this, invariant 3 is rhetorical, not real.

4. **No mystery state.** Anything mutable is in the ledger. Enforced by: existing append-only ledger + storage layer events. **Gap to close in v0.5:** ensure every kernel transition emits an event before mutating local state (currently some paths advance and emit asynchronously).

5. **No retroactive PASS.** Outcomes are immutable once recorded. Corrections happen as new events. Enforced by: append-only constraint already exists in `bp-ledger`. No gap.

6. **No silent ambient effect.** Every side-effect class — fs write, network egress, command exec, git push, merge — is enumerated, policy-gated, and ledger-recorded. Enforced by: tool sandbox (path normalization, symlink rejection) + command executor receipts + worktree boundary. **Honest limitation:** v0.5 enforcement is worktree-tier. A worker that bypasses the sandbox (e.g. a child process not routed through `run-command`) escapes. Stronger isolation is v1.5+.

These six invariants are checked by integration tests in `test/event-stream/` and `test/ledger-integration/`. Formal verification (TLA+, Cedar) is deferred.

## 5. Architecture — seven layers

Narrower than v∞'s ten. Each layer maps to existing or in-flight code.

```
L7   Operator surface (CLI / TUI / read-only web Mission Control)
L6   PlanForge — admission gates
L5   Memory — 5-layer model with manual playbooks
L4   Sandbox — worktree only in v0.5
L3   Pack / Host / Provider — Claude provider only in v0.5
L2   Packet — typed unit of work (keep name; rename to Compact deferred to v1)
L1   Kernel — durable execution, run loop, replay
L0   Tape — signed append-only event ledger + CAS evidence store
```

The v∞ Layers L8 (full Mission Control), L9 (mobile/IDE/federation) are out of v0.5.

## 6. Subsystems — what exists, what's needed in v0.5

### L0 — Tape

Existing: `bp-ledger` (Rust), `packages/ledger-client` (TS), append-only, content-addressed, backpressure-stabilized.

**v0.5 additions:**
- Per-event detached signatures (Ed25519). Events signed by the actor that emitted them.
- Signature verification on read.
- Tape-root checkpoint events emitted periodically (every N events). Not a Merkle log; a simple monotonic checkpoint.

**Explicitly NOT in v0.5:** Merkle transparency log, OCI distribution evidence store, cross-operator federation, public Rekor publication.

### L1 — Kernel

Existing: `packages/kernel/src/{orchestrator,run-loop,packet,events,policy,run-scoped-bus,strategy-executor}.ts`.

**v0.5 additions:**
- Formalize workflow/activity split. Workflows are pure functions over the tape. Activities are the only things that perform I/O; each activity is bracketed by `activity-started` and `activity-completed` events.
- Activity results recorded as events. On replay, the kernel reads the result from the tape — never re-invokes the model or tool.
- Recovery via tape replay: kernel crash → restart → replay from last checkpoint → resume at next pending activity.

**Explicitly NOT in v0.5:** deterministic simulator, formal determinism guarantees, replay against renderer versions other than current.

### L2 — Packet (rename to Compact deferred)

Existing: `packages/kernel/src/packet.ts`. Currently a delivery envelope.

**v0.5 additions:** Packet gains four fields:
- `capability_bundle` — TS object: `{ fs_read: string[], fs_write: string[], net_egress: string[], tools: string[], wall_clock_budget_ms, token_budget, dollar_budget }`. Validated by policy broker on every tool call. NOT a sealed cryptographic token; a plain object referenced by digest in the tape.
- `acceptance_contract` — required for the kernel to accept the result: diff-scope check (no files modified outside `fs_write` paths), CI status (must be green), lint clean.
- `provenance_ref` — pointer to the PlanForge plan that authorized this packet.
- `trust_scope` — which memory namespaces this packet may query.

Rename to "Compact" deferred to v1.0 to avoid mid-flight churn.

### L3 — Pack / Host / Provider

Existing: pack model in Rust (`bp-pack-*`), host stubs (`bp-host-claude`, `bp-host-codex`), provider stubs (`bp-provider-anthropic`, `bp-provider-openai`). TypeScript executors in `packages/adapters-models`.

**v0.5 additions:**
- Provider in v0.5 = Claude (Anthropic) only. OpenAI provider stays a stub.
- Renderer version recorded in tape on every model activity.
- Pack manifests stay TOML; pack signing (OCI) deferred to v1.

### L4 — Sandbox

Existing: worktree isolation (`packages/adapters-git`), tool sandbox (`packages/adapters-tools/src/sandbox.ts` — path normalization + symlink rejection).

**v0.5 additions:**
- Capability bundle is checked before every `run-command` invocation. Commands not in the tools allowlist are rejected.
- `fs_write` boundary enforced by sandbox.ts (currently checks symlinks; v0.5 adds scope check against bundle).
- `net_egress` enforced via `--restricted-network-access` flag on Claude Code (after dangerous flag removed) + spawn-time env scrubbing.

**Explicitly NOT in v0.5:** container (gVisor), microVM (Firecracker), WASM tiers.

### L5 — Memory

Existing: 5-layer model in `bp-memory` (Rust) + `memory-retrieval.ts` (TS). Working / Episodic / Semantic / Procedural / Outcome.

**v0.5 additions:**
- Retrieval is graph-walk + keyword (no vector embeddings in v0.5).
- Capability-gated query: a packet's `trust_scope` field controls which memory entries it can read.
- Procedural playbooks authored manually (no auto-extraction).

**Explicitly NOT in v0.5:** vector embeddings, temporal knowledge graph, Voyager-style skill library auto-extraction, decay/confidence functions.

### L6 — PlanForge

Existing: scattered across feature branches. Dry-run CLI, schema (`apps/cli/src/planforge-schema.ts`), docs (`docs/architecture/planforge.md`), test fixtures.

**v0.5 work (the bulk of v0.5):**
- Consolidate PlanForge feature branches to main.
- Complete the `compile → validate → preview → admit → execute → receipt` cycle end-to-end.
- Receipt is a signed event in the tape (not yet SLSA L3, not yet in-toto layout).
- Admission requires single operator approval (multi-sig deferred).
- Receipt verification by replaying tape.

This is the single largest v0.5 work item.

### L7 — Policy

Existing: `packages/policy/src/{budgets,decision,trust-gates,profiles}.ts`. TypeScript predicates.

**v0.5 additions:**
- Capability bundle validation as a policy decision.
- Acceptance contract check as a policy decision.
- Trust scoring against historical outcomes (basic: per-pack success rate).

**Explicitly NOT in v0.5:** Cedar, Rego, TLA+, formal verification.

### L8 — Mission Control

Existing: TUI (`packages/ui-tui`); inspector slice on `buildplane-inspector-mvp` branch.

**v0.5 additions:**
- Web UI v1 (lightweight, React or similar) — read-only timeline of tape events + approval inbox.
- Time-scrubber over recent events (manual range selection, not Pernosco-grade).
- Approval inbox: typed pending admissions, approve/reject from web.
- Local-only; no auth beyond loopback restriction.

**Explicitly NOT in v0.5:** mobile, IDE extensions, multi-operator CRDT, federation.

### L9 — distribution (collapsed into L7 for v0.5)

CLI + TUI + web. That's it.

## 7. Vertical slice — the v0.5 killer demo

This is the test that proves v0.5 is real. Goal: demo this end-to-end at month 6.

**Demo task:** Add rate limiting to `/api/login` endpoint on a small toy Express repo: max 5/min per IP, return 429 with `Retry-After`.

**Flow:**

1. Operator runs `bp goal "Add rate limiting to /api/login: max 5/min per IP, return 429 with Retry-After."`
2. Kernel compiles a PlanForge plan. Plan digest computed. Trusted base identified. Missing evidence enumerated. Risk class assigned.
3. Plan rendered in web Mission Control. Operator reviews the plan: tasks, capability bundle proposed, budget estimate.
4. Operator adjusts budget slider if desired, clicks "Admit" (no FaceID; no mobile push).
5. Kernel records the admission as a signed event in the tape. Capability bundle finalized.
6. Worker spawns in a fresh git worktree with the worktree mounted: read-only baseline + writable `src/` and `test/` per the bundle. Tools allowed: `Read`, `Write`, `Edit`, `Bash` (limited to `npm test`, `npm run lint`, `git`). Net egress allowlist: NPM registry only.
7. Worker calls `Edit` → tape event. Worker calls `Bash npm test` → tape event with result. Worker calls `Bash npm run lint` → tape event. Each call is policy-checked against the bundle.
8. Worker emits a completion record. Kernel validates against Acceptance Contract: diff stays in scope, CI is green, lint clean.
9. Kernel emits a `result-ready` event. Operator sees it in Mission Control approval inbox.
10. Operator clicks "Merge". Signed approval event written to tape. Merge happens. Final `outcome` event recorded.

**Properties demonstrated:**
- Replay: kill the kernel between steps 7 and 8. Restart. Kernel replays the tape, sees activity completed, resumes at step 8. Final state identical.
- Policy enforcement: if the worker tries to write outside its `fs_write` paths, the tool sandbox rejects the call; quarantine event emitted.
- Signed receipts: every event in the tape is signed by its actor. External verifier (a 50-line script reading the tape + public key) can verify every claim without trusting the kernel.

**Properties NOT demonstrated in v0.5 demo (these are v∞):**
- Deterministic simulator running the same flow under failure injection.
- Multi-tier sandbox escape detection.
- Cross-operator verification.
- Mobile / FaceID.

## 8. Roadmap — six 4-week milestones

| Milestone | Window | Scope |
|---|---|---|
| **M0** | Week 0–1 | Fix `--dangerously-skip-permissions`. Verify and consolidate PlanForge feature branches to `main`. Baseline integration tests pass on a clean `main`. |
| **M1** | Week 1–5 | Per-event signing in `bp-ledger` (Ed25519 detached signatures). Signature verification on read. Tape-root checkpoint events. Updated `ledger-client` wire protocol. |
| **M2** | Week 5–11 | PlanForge end-to-end on `main`: compile → validate → preview → admit → dispatch → execute → receipt. Receipt is a signed event. Replay survives mid-cycle crash. |
| **M3** | Week 11–14 | Capability bundle as TS sealed object referenced by digest. Policy broker integration. Bundle validated on every tool call. Removes ambient authority. |
| **M4** | Week 14–20 | Acceptance Contract validator (diff scope + CI + lint). Receipt verification by tape replay. Quarantine path for failed contracts. |
| **M5** | Week 20–25 | Mission Control web UI v1: read-only timeline scrubber, approval inbox, signed approval events. |
| **M6** | Week 25–26 | Vertical slice integration. Demo video. First public release v0.5.0. |

Six months total, ~26 weeks. Each milestone produces a tape-recordable artifact and a publicly-pushed commit on `main`. M0 is the only one that's a code-cleanup milestone; M1–M6 are real engineering.

**This is aggressive but credible.** It assumes:
- ~25 hours/week sustained focus on Buildplane (passion-project intensity, not full-time)
- Buildplane gets prioritized over Hermes Nexus, claude-code-orchestration, etc., for the duration
- The PlanForge consolidation in M0 + M2 doesn't surface major architectural issues that derail M3

## 9. Distinction from adjacent systems (modest)

| System | Buildplane v0.5 differentiation |
|---|---|
| **Anthropic Managed Agents** | Local-first, on-prem, evidence externally verifiable via signed events |
| **OpenAI Agents SDK + sandbox** | Multi-host-agnostic in design (v0.5 ships Claude), ledger-grounded, replayable runs |
| **Microsoft Agent Governance Toolkit** | Complementary, not competitive — AGT is policy enforcement; Buildplane is the execution kernel. AGT could plug in. |
| **Agent Orchestrator (Composio)** | Buildplane has ledger + replay + admission gates that AO lacks |
| **OpenHands / Cursor / Devin** | Buildplane's admission/policy/receipt model is the distinguishing wedge |
| **Temporal** | Coding-specific semantics; worktree isolation; Pack/Host/Provider separation — Temporal is generic |

This is more modest than v∞'s claims. It's also more defensible at v0.5 ship date.

## 10. Open questions

1. PlanForge consolidation: how much of the existing feature-branch work is mergeable to `main` as-is, vs needs rebasing/integration work? Estimate before M0.
2. Per-event signing key management: where do keys live? Per-machine (in `~/.buildplane/keys/`) or per-operator? Affects multi-machine UX.
3. Acceptance Contract scope check: how strict? `git diff --stat` is easy; semantic "no out-of-scope changes" is harder. Probably v0.5 = file-path-based, v1 = semantic.
4. Mission Control web UI tech: React + Vite seems default; needs to render the tape at reasonable interactive performance. Probably needs server-side aggregation (a thin Express layer reading the tape).
5. Web UI auth: even for local-only, do we need a token check to prevent random localhost listeners? Probably yes — a simple shared-secret in `~/.buildplane/web-token`.
6. Replay determinism for LLM activities: explicitly document that LLM responses are recorded as events; replay reads them, never re-invokes. This is Temporal's pattern. Make it explicit in M1 so it doesn't drift later.
7. Mode of dangerous-flag fix: just remove it? Provide a different sandbox path? Document an opt-in escape for development? Probably: remove from default, add an `--unsafe-mode` flag for dev that emits a `unsafe-mode-used` tape event so it's not silent.
8. What does "public release v0.5.0" mean concretely — npm publish? Cargo publish? GitHub release with installer script? Probably all three but needs scoping in M5.

## 11. Glossary

| Term | Definition |
|---|---|
| **Tape** | Signed append-only event ledger + content-addressed evidence store. `bp-ledger`. |
| **Kernel** | Durable execution engine. `packages/kernel`. |
| **Packet** | Typed unit of work + capability bundle + acceptance contract. (Renamed to "Compact" in v1.) |
| **PlanForge** | Admission layer. Goal → plan → preview → admit → execute. |
| **Capability bundle** | TS object enumerating worker permissions for one Packet. Referenced by digest in tape; not cryptographically sealed in v0.5. |
| **Acceptance contract** | Diff-scope check + CI status + lint cleanliness. Validated before kernel accepts a worker result. |
| **Operator** | Human user. Approves admissions and merges. |
| **Mission Control** | Read-only web UI for inspecting runs and processing approvals. |
| **Pack / Host / Provider** | Pack = workflow personality. Host = local session surface (Claude Code, Codex CLI). Provider = API transport (Anthropic, OpenAI). |

## 12. References

- [Buildplane v∞ World-class final form](./2026-05-21-buildplane-vinf-world-class-design.md) — companion North Star vision
- [Buildplane Direction 2026-05-21](./2026-05-21-buildplane-direction.md) — packaging overview
- Existing buildplane architecture docs: `docs/architecture/buildplane-package-architecture.md`, `docs/ledger.md`
- Temporal durable execution — replay semantics. Specifically: activity results are recorded; replays read from history, never re-execute. https://docs.temporal.io/workflow-execution
- 2026-05-21 Codex adversarial review (artifact lineage; not committed)
