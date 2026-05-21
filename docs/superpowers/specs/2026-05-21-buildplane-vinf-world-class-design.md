# Buildplane v∞ — World-Class Final Form (North Star vision)

| | |
|---|---|
| **Status** | Aspirational North Star — NOT an implementation contract |
| **Implementation contract** | See [v0.5 design](./2026-05-21-buildplane-v05-design.md) for the actual 6-month plan. Read that first if you want to know what's actually being built. |
| **Direction overview** | [Buildplane Direction 2026-05-21](./2026-05-21-buildplane-direction.md) |
| **Date** | 2026-05-21 |
| **Author** | Sollan Systems (with Claude as head-dev advisor) |
| **Owning project** | `buildplane` |
| **Source brainstorm** | `claude-code-orchestration` session, 2026-05-21 |
| **Cross-refs** | `buildplane/docs/architecture/planforge.md` (feature-branch only), `buildplane/docs/architecture/buildplane-package-architecture.md`, `buildplane/docs/architecture/run-admission-receipts.md`, `buildplane/docs/architecture/rust-native-host-runtime.md`, `buildplane/docs/ledger.md`, `buildplane/docs/jtbd-competitive-analysis.md` |
| **Target horizon (aspirational)** | 36+ months of focused work — see v0.5 for the realistic near-term roadmap |

> **Read this document as inspiration, not as a contract.**
>
> The 2026-05-21 Codex adversarial review (which ran 30+ verification commands against the actual codebase) caught material gaps between this document's language and what's shipped on `main`. The project's response was to preserve this v∞ document as a faithful record of the North Star vision (combining Temporal-style durable execution, SLSA-style attestation, capability security, FoundationDB-style simulation, agent-coding semantics), and write a separate [v0.5 design](./2026-05-21-buildplane-v05-design.md) as the truth-bearing implementation contract for the next 6 months.
>
> Both documents are part of the same direction. v0.5 is what gets built; v∞ is the ceiling v0.5 is climbing toward. Specific claims in this v∞ document that are deferred or qualified by v0.5 include: deterministic simulator (deferred), sealed cryptographic capability tokens (deferred — v0.5 uses policy broker + sandbox combo), SLSA L3 attestation (deferred — v0.5 emits signed provenance, not L3), sandbox tiers beyond worktree (deferred), Cedar/Rego/TLA+ formal policy (deferred), cross-operator federation (deferred), multi-provider routing (deferred), mobile/IDE/FaceID surfaces (deferred), skill library auto-extraction (deferred).
>
> **If you are evaluating Buildplane for any decision — hiring, contributing, funding, adopting — read v0.5 first.** This v∞ document tells you where the project wants to go; v0.5 tells you what is credibly being built.

---

## 1. Thesis

The strongest version of Buildplane is the **first capability-secure, deterministically-replayable, cryptographically-attested durable-execution kernel purpose-built for autonomous software work.**

Each phrase is load-bearing and maps to a battle-tested precedent from outside the AI agent space:

| Phrase | Precedent |
|---|---|
| Durable execution kernel | Temporal — workflow state reconstructed by replay of an append-only event history |
| Deterministically replayable | FoundationDB — single-threaded simulator with injected failures, ~1T CPU-hours of sim |
| Cryptographically attested | SLSA + Sigstore + in-toto — signed provenance binding artifacts to their builds |
| Capability-secure | seL4 / object-capability model — sealed, non-elevatable capability tokens |
| Purpose-built for autonomous software work | unit of work is a coding task with worktree + diff + CI signal + merge gate |

The contribution is not any single ingredient. Each ingredient is mature in its own domain. The contribution is **combining all of them in one kernel, with the agent-coding domain as the focal point.** Nobody has done this. Temporal is generic. SLSA is for compiled artifacts. seL4 is for embedded. Microsoft Agent Governance Toolkit (April 2026) is policy-only. Agent Orchestrator / OpenHands / Cursor have no replay, no attestation, no capability kernel.

That gap is the shape of Buildplane.

## 2. Non-goals

To stay honest about scope:

- **Not** a hosted SaaS in v1. Local-first, single-operator, single-machine.
- **Not** a generic agent framework. Specifically for software work with git/CI/merge semantics.
- **Not** a replacement for Claude Code, Codex CLI, or any agent CLI. Buildplane orchestrates *bounded workers*; those CLIs can be the host that executes a Compact.
- **Not** a wrapper around model providers. Providers are pluggable below the kernel; the kernel never depends on a specific provider.
- **Not** another natural-language-to-code shell. PlanForge gates execution behind explicit admission; impulsive prompting is intentionally blocked.
- **Not** built to compete on raw speed. Built to be **provably correct, replayable, and auditable.** Speed is a secondary optimization target.

## 3. The constitution — six invariants

These are enforced by the kernel, not aspired to. Each maps to a subsystem (named in §6).

1. **No claim without evidence.** Every state transition is justified by a ledger event with a content-addressed evidence hash. Worker self-reports are *records*, not *proof*. Enforced by: The Tape (L0) + Acceptance Contract (L2).
2. **No execution without admission.** A goal cannot become work until a signed admission receipt exists, produced by quorum approval per the goal's policy class. Enforced by: PlanForge (L6).
3. **No authority without a capability.** Workers receive sealed capability tokens; they cannot elevate. Tokens delegate downward only. Enforced by: Capability Bundle (L2) + Policy (L7).
4. **No mystery state.** Anything mutable is in the ledger. Anything in the ledger is replayable. Anything replayable is deterministic given the same evidence digests. Enforced by: Kernel (L1) + Simulator (cross-cutting).
5. **No retroactive PASS.** Outcomes are immutable once recorded. Corrections happen as new events superseding old; original stays. Enforced by: append-only Tape (L0).
6. **No silent ambient effect.** Every side-effect class (fs write, net egress, command exec, git push, merge) is enumerated, capability-gated, and ledger-recorded with byte-level digests. Enforced by: Capability Bundle (L2) + Sandbox (L4).

These invariants are **formally specified** (TLA+ for the safety properties, Cedar for capability/policy decisions) and checked in CI alongside unit tests.

## 4. Non-functional requirements

| Requirement | Target |
|---|---|
| Kernel crash → resume to identical state via replay | ≤ 5 seconds for a 24-hour run history |
| Determinism of replay (same tape → same state) | 100% (verified by simulator) |
| Capability check evaluation | sub-millisecond per check (Cedar baseline) |
| Tape event throughput | ≥ 10k events/sec sustained, single-machine |
| Evidence store retrieval (by digest) | ≤ 50ms p99 |
| Simulator-vs-real divergence | 0 — same code paths, different I/O substrate |
| External verifier check of admission receipt | possible without trusting the producer |

## 5. Architectural overview

Ten layers. Each layer has a stable interface to the layer above. Layers communicate exclusively through typed event types defined in `bp-ledger` and re-exported to TypeScript via `typeshare`.

```
L9   Distribution surfaces (CLI, TUI, Web, Mobile, IDE)
L8   Mission Control (operator cockpit)
L7   Policy + Verification (Cedar, OPA, TLA+)
L6   PlanForge (admission, receipts, signed plans)
L5   Memory (working / episodic / semantic / procedural / outcome)
L4   Sandbox (worktree / container / microVM / WASM tiers)
L3   Pack / Host / Provider (workflow / surface / transport)
L2   Compact (typed unit of work + capability bundle + acceptance contract)
L1   Kernel (durable execution, run loop, replay, fork)
L0   The Tape (signed append-only event ledger + CAS evidence store)
```

Above L9 is the **operator** (human). Below L0 is the **substrate** (filesystem, network, model APIs).

## 6. Subsystems

### L0 — The Tape

**Purpose:** the canonical record. Every event, every artifact, every decision.

**Status today:** `bp-ledger` (Rust) exists with SQLite + CAS + content-addressed payloads. TS client (`packages/ledger-client`) handles wire protocol + backpressure (drainPromise stabilized).

**New in this spec:**
- **Per-event detached signatures.** Each event signed by the actor that produced it (kernel, worker, operator). Verifiable without re-fetching the actor's keys.
- **Merkle transparency log.** Tape root is the head of a Merkle tree; any prefix is verifiable via inclusion proof. Modeled on Sigstore Rekor.
- **Optional public publication.** Operators may publish their tape root to a public transparency log for third-party verifiability. Off by default; on for compliance-critical use.
- **OCI-distribution-spec evidence store.** CAS speaks OCI so evidence is portable to any container registry, de-duplicable across operators, attestable.
- **Cross-operator federation primitive.** Two operators can exchange tape segments + evidence and verify each other's claims via Merkle proofs + signatures. No mutual trust required.

**Interface:** `append(event) → event_id, signature`; `read(range) → events`; `verify(event_id, proof) → bool`; `prove(event_id) → inclusion_proof`.

**Cross-refs:** existing `docs/ledger.md`.

### L1 — The Kernel

**Purpose:** durable execution. Run loop, scheduler, orchestrator. State recovery via replay.

**Status today:** `packages/kernel` has orchestrator, run loop, packet model, memory retrieval hooks, policy integration. Run admission receipts in progress.

**New in this spec:**
- **Workflow / Activity split** (Temporal pattern). Workflow code is pure orchestration — deterministic, no I/O, no clocks, no randomness. Activities are the only things that touch the outside world; each activity is bracketed by a `pre-activity` and `post-activity` tape event.
- **Recovery is replay.** Crash → restart → replay tape from last checkpoint → resume at next pending activity. No state lives outside the tape.
- **Fork as a first-class tape operation.** `bp-fork` formalized as "create run R' with history = prefix(R.history, N), branching at event N." This is the foundation of counterfactual replay, recovery, and "what would have happened if we approved this instead?"
- **Deterministic substitution for I/O primitives.** Wall clock → tape timestamps; randomness → tape-seeded; environment → recorded at run start.

**Interface:** `dispatchCompact(compact, capability_bundle) → run_id`; `replay(run_id) → final_state`; `fork(run_id, at_event) → new_run_id`.

### L2 — Compact (rename from `packet`)

**Purpose:** the typed unit of work. A contract between operator and worker.

**Status today:** `packet` exists in `packages/kernel/src/packet.ts`. Carries delivery shape but not yet a full contract.

**New in this spec:** A Compact contains:

| Field | Meaning |
|---|---|
| `task_intent` | Declarative goal — pre/post conditions, expected evidence shapes, failure semantics |
| `capability_bundle` | Sealed token — fs paths, net hosts, tools, budgets (wall-clock, tokens, dollars), side-effect classes, sandbox tier |
| `acceptance_contract` | Evidence required for accept: diff digest, CI run status, lint clean, no out-of-scope files |
| `provenance` | Goal hash → plan digest → admission receipt that authorized this Compact |
| `trust_scope` | Memory namespaces this Compact can read; events it can emit |
| `replay_seed` | Deterministic seed for any required randomness |

Compact is **immutable** once admitted. A worker that violates its capability bundle is killed. A worker whose output doesn't match the acceptance contract has its work quarantined, never auto-accepted.

**Why rename `packet` to `compact`:** "packet" implies delivery; "compact" implies an agreement. The latter is what the object actually is.

**Cross-refs:** existing `TaskIntent` work in `packages/kernel`; existing renderer split in `packages/adapters-models`.

### L3 — Pack / Host / Provider

**Purpose:** preserve the existing architectural separation. A pack is a workflow personality; a host is a session surface; a provider is an API transport.

**Status today:** designed; partly implemented across `bp-pack-manifest`, `bp-pack-loader`, `bp-pack-inspection`, `bp-host-*`, `bp-provider-*`.

**New in this spec:**
- **Provider routing as policy.** Operator declares "for tasks of class X, prefer provider P with model M; fall back to Q/N if P unavailable or over budget." Kernel routes per-Compact based on policy + observed trust scores.
- **Renderer version recorded in the tape.** Every Compact execution stores which provider renderer version translated `task_intent` → wire prompt. Replays use the renderer-at-that-version, never the current one.
- **Pack signing.** Packs are signed OCI-style artifacts. Operator can pin `pack@digest`. Admission refuses to admit work that requires an unsigned or unpinned pack.

### L4 — The Sandbox

**Purpose:** isolation tiers matched to trust requirements.

**Status today:** `packages/adapters-git` provides worktree isolation. Tool sandbox in `packages/adapters-tools`.

**New in this spec — sandbox tiers:**

| Tier | Tech | When |
|---|---|---|
| **T0** Worktree | git worktree | Trusted, deterministic packs |
| **T1** Container | gVisor-backed container | Default for tool execution — syscall-level isolation, fast spin-up |
| **T2** microVM | Firecracker | Untrusted model output that runs arbitrary commands; strong fs + net boundary |
| **T3** WASM | Wasmtime | Deterministic packs that don't need a real filesystem — also replayable inside the simulator |

The Capability Bundle declares the **minimum** tier required. Cross-tier escape is a hard kernel violation that triggers immediate worker termination + a critical tape event.

**Net egress allowlists** per capability. **Filesystem boundary** per capability. **Tool availability** per capability.

### L5 — Memory

**Purpose:** scope-aware retrieval of relevant context, learned facts, and reusable playbooks.

**Status today:** 5-layer model (Working / Episodic / Semantic / Procedural / Outcome) sketched; `bp-memory` Rust crate exists with scope-aware retrieval; `memory-retrieval.ts` in kernel.

**New in this spec:**
- **Memory as a temporal knowledge graph.** Every event is a node with timestamp, actor, run, provenance. Every learned fact (semantic) carries a derivation: "this came from events X, Y, Z." Retrieval is graph-walk + vector search, not vector-only.
- **Procedural memory as a Voyager-style skill library.** Successful Compacts are distilled into reusable playbooks. Kernel proposes "I've done something like this before — replay the proven playbook?" Operator approves. Skill library is itself signed, versioned, evaluable.
- **Confidence + decay.** Every learned fact has a confidence score and a decay function. Stale facts get re-validated or expire.
- **Capability-gated queries.** A Compact only sees memory entries that share its trust scope. No cross-tenant leakage.

**Cross-refs:** existing `docs/architecture/buildplane-memory-schema.md`, `buildplane-memory-cli.md`.

### L6 — PlanForge

**Purpose:** the admission layer between operator intent and worker execution.

**Status today:** dry-run CLI exists. Schema/types extracted (`apps/cli/src/planforge-schema.ts`). Docs reconciled (`docs/architecture/planforge.md`). PF-SCHEMA1 merged via PR #111.

**New in this spec:**

- **Plans are layouts (in-toto sense).** A PlanForge plan is an attestable artifact: signed Statement, typed Predicate, Subject = the goal hash. External verifiers can validate a plan without running PlanForge.
- **Admission is a quorum operation.** Policy class declares "admission requires N of M approvers." Multi-sig as first-class primitive — operator herself, optionally co-operators or external approvers.
- **Receipts are SLSA-style provenance.** A PlanForge admission receipt is a signed provenance attestation pointing to: plan digest, goal hash, approver set, policy version, trusted-base digest. Equivalent to SLSA Build L3 if the kernel itself runs in hardened isolation.
- **Dry-run isomorphic to real-run.** Same code paths. Difference is which capability bundles get sealed at admission. This is what makes a dry-run trustworthy — not a separate code path that could drift.
- **Stages remain:** `compile → validate → preview → admit → materialize → execute`. Each stage has a tape event class and a ledger-recorded receipt.

**Cross-refs:** existing `docs/architecture/planforge.md`, `docs/architecture/run-admission-receipts.md`.

### L7 — Policy + Verification

**Purpose:** answer "is this allowed?" "what budget applies?" "what evidence is required?" "what's the consequence of failure?"

**Status today:** `packages/policy` with budgets, trust gates, retry policy, decision evaluation, approval profiles.

**New in this spec:**
- **Policy language: OPA Rego + Cedar.** Rego for complex multi-step rules; Cedar for fine-grained per-resource decisions. Sub-millisecond evaluation per check (Microsoft Agent Governance Toolkit pattern, April 2026).
- **TLA+ specs for critical safety invariants.** Specifically: no admission without quorum; no execution without admission; no capability escalation; no merge without green CI evidence; tape append is total-ordering. Specs run in CI.
- **Cedar policies are verifiable by design.** AWS Cedar has a verification mode that proves policy properties (e.g., "no policy permits X").
- **Trust scoring.** Per-worker / pack / provider. Outcome history feeds back into trust score. A worker that produces invalid receipts loses trust monotonically. A provider whose renderers regress on eval loses routing weight.

### L8 — Mission Control

**Purpose:** the operator's cockpit. Read-only by construction.

**Status today:** Run Inspector slice exists; evidence-driven demo mode; event timeline; outcome strips.

**New in this spec:**
- **Read-only by construction.** Cannot mutate kernel state directly. All operator actions are *proposals* — they become tape events that policy evaluates.
- **Time-scrubber over the tape.** Drag a slider; UI renders world-at-timestamp. Pernosco-for-agents.
- **Attribution everywhere.** Every node, edge, decision shows: who proposed, what evidence, what policy fired, alternatives considered.
- **Approval inbox is typed.** Approvals are themselves signed attestations. Land in inbox + slack + mobile + email; same underlying signed event.
- **Multi-operator collaboration.** Annotations, hand-offs, shared cockpits work via CRDT-merged operator state on top of the tape (Automerge / Ink & Switch local-first pattern).

### L9 — Distribution surfaces

**Purpose:** how an operator interacts with Buildplane.

**Status today:** `apps/cli` operator CLI; `packages/ui-tui` terminal UI.

**New in this spec:**
- **Operator CLI** (you have).
- **TUI** (you have).
- **Mission Control web** (in progress).
- **Mobile companion** for approvals on the go. Push notification → FaceID-signed approval → tape event. The tape doesn't care which device signed.
- **VS Code / Zed / JetBrains extensions** that overlay run status on the actual code being edited. "This file is currently being modified by Compact 0x4f... in run 9821, expected accept by 14:32."
- **Public transparency log endpoint** (optional). For operators who want their tape root co-signed by a public Rekor.

## 7. Cross-cutting: cryptographic attestation chain

Every Buildplane artifact participates in a verifiable chain:

```
Goal hash
  → PlanForge plan (signed in-toto Statement)
    → Admission receipt (signed by quorum, SLSA L3 provenance)
      → Compact (sealed capability bundle, signed by kernel)
        → Worker activities (each signed by worker key)
          → Evidence artifacts (CAS digests in tape)
            → Acceptance receipt (signed by kernel after contract verification)
              → Merge (signed by operator FaceID/key)
                → Final outcome event (signed by kernel, tape root advances)
```

Any link in the chain is independently verifiable. A third-party auditor with only the tape root + public keys can verify every claim without trusting Buildplane itself.

This is what makes Buildplane categorically different from AO, OpenHands, Cursor, Managed Agents: those systems require trust in the runner. Buildplane provides verification *external to* the runner.

## 8. Cross-cutting: failure model

Failures are classified and ledger-recorded. No silent failures.

| Failure class | Detection | Response |
|---|---|---|
| Kernel crash | OS exit | Restart, replay tape, resume |
| Worker hang | Wall-clock budget exceeded | Kill worker, mark Compact `TIMEOUT`, tape event |
| Worker capability violation | Sandbox-level deny | Kill worker, mark `CAPABILITY_VIOLATION`, tape event, trust score penalty |
| Acceptance contract mismatch | Receipt validation fails | Quarantine output, mark `CONTRACT_FAILED`, no auto-merge |
| CI failure | External signal | Tape event, re-dispatch with updated context (subject to retry policy) |
| Provider unavailable | Activity timeout | Fall back per routing policy; if no fallback, mark `PROVIDER_UNAVAILABLE` |
| Tape append failure | Storage error | Halt kernel — never proceed without durable record |
| Capability token forgery | Signature check fails | Critical event, halt run, alert operator |
| Replay divergence | Sim vs real differ | Critical bug — block deploys until diagnosed |

Insufficient evidence is not success — it's `INSUFFICIENT_EVIDENCE`. Unsafe work is not best-effort — it's `UNSAFE_TO_RUN`. These are Hermes Nexus's invariants too; Buildplane adopts them.

## 9. Cross-cutting: deterministic simulation testing

**This is the single highest-leverage addition to current Buildplane and the one most likely to be deferred for the wrong reasons.**

Pattern (FoundationDB-derived):
- Single-threaded simulator that fast-forwards entire kernel runs.
- Time is logical, advanced by the simulator scheduler.
- All I/O primitives have deterministic substitutes (clock, randomness, network, filesystem, model API).
- Failure injection: process kills, partial writes, network drops, swizzle-clogging (random connection stop/restart), provider 5xx, capability token corruption.
- Each simulated run is reproducible from seed.

**What this proves:**
- Kernel reaches the same final state on replay as on original run.
- Capability invariants hold under all failure injection patterns.
- Quorum gates can't be bypassed under timing races.
- Tape append remains total-ordering under concurrent producers.
- Recovery from any tape prefix produces a valid resumable state.

**Why this is non-negotiable:** Buildplane's promise is "evidence-first, no retroactive PASS, replayable." That promise is hollow if the kernel itself isn't proven correct. FoundationDB engineers state plainly that they "would not have been able to build FoundationDB without this technology." Same applies here.

**Investment:** the simulator is a Stage 1 investment, not a Stage 9 polish. It is the second subsystem built (after the Tape), and it grows in lockstep with every kernel feature.

## 10. The v1.0 vertical slice

**Goal:** prove the spine connects, end-to-end, on one trivial real task.

**Concrete demo flow (must work clone-to-clone reproducibly):**

1. Operator: `bp goal "Add rate limiting to /api/login: max 5/min per IP, return 429 with Retry-After."`
2. Kernel: compiles plan, computes digests, identifies missing evidence, estimates budget.
3. Operator reviews plan in Mission Control. Adjusts budget slider. Selects sandbox tier T1 (container). Approves.
4. Kernel admits. Capability bundle sealed. Worker spawns in gVisor container. Worktree mounted with read-only baseline + writable `apps/api/src/` and `apps/api/test/`. Tools allowed: `Read`, `Write`, `Edit`, `Bash(npm test|npm run lint|git)`. Net egress: NPM registry only.
5. Worker writes diff, runs tests, runs lint. Each tool call emits pre/post tape events.
6. CI fires against diff → green. CI result is an evidence artifact in CAS, referenced by tape event.
7. Worker emits acceptance receipt. Kernel validates against acceptance contract. Match.
8. Push notification to operator's phone with diff + CI evidence link. Operator FaceID-approves.
9. Merge happens. Final outcome event. Tape root advances.

**Operator attention:** ~30 seconds of real time during the ~12 minutes total flow.

**Properties demonstrated:**
- Replay: kill the kernel mid-run, restart, run completes identically.
- Capability: worker that tries to `Read` outside its bundle is killed.
- Attestation: third-party verifies the admission receipt without trusting Buildplane.
- Simulator: same flow runs in simulator with injected failures and reaches identical final state.

**What v1.0 is not:**
- Not multi-operator. Not multi-provider routing. Not skill-library auto-extraction. Not federation. Not WASM tier. Not mobile.
- Single operator, Claude provider only, gVisor sandbox only, single-machine, web Mission Control only.

This is the minimum that proves the architecture, not the maximum that demonstrates the vision.

## 11. Roadmap

### v1.0 — The Kernel
Single operator, single machine. Tape + replay + Compact + capability bundle + worktree+container isolation + PlanForge admission + signed receipts. Provider: Claude only. Mission Control: read-only web UI with timeline scrubber. Simulator harness operational.
**Target: 18–24 months focused.**

### v1.5 — The Eval Harness
Deterministic simulator at full coverage. Eval suites per pack. Trust scoring feeding routing weights. SWE-bench-style harness integrated.
**+3 months.**

### v2.0 — The Operator's Cockpit
Mission Control full version. Approval inbox typed. Mobile companion. Multi-operator CRDT annotations. Sandbox tiers T1+T2 (gVisor + Firecracker) production-ready.
**+4 months.**

### v2.5 — The Ecosystem
Multi-provider routing + renderer versioning. Pack registry with signed artifacts. Skill library auto-extraction. WASM sandbox tier T3.
**+4 months.**

### v3.0 — The Federation
Cross-operator signed-event exchange. Public transparency log option. SLSA L3 admission receipts verified by external auditors. TLA+-verified safety properties published. IDE extensions.
**+6+ months.**

**Total: ~36 months** of focused world-class work to v3.0.

## 12. Distinction from adjacent systems

| System | What it has | What it lacks vs Buildplane |
|---|---|---|
| **Temporal** | Durable execution, replay, event sourcing | Coding-specific semantics, sandbox/capability, attestation, agent-specific governance |
| **Anthropic Managed Agents** | Hosted sandbox + event log per session | On-prem, multi-provider, replay determinism, external verifiability |
| **OpenAI Agents SDK + sandbox** | Sandbox for code execution | Replay, attestation, capability kernel, multi-provider |
| **Microsoft Agent Governance Toolkit** (Apr 2026) | Policy enforcement, MCP gateway, OWASP coverage | Execution kernel, replay, ledger, attestation chain |
| **Agent Orchestrator (Composio)** | Spawn + dashboard + reactions | Ledger, replay, capability security, attestation, formal verification |
| **OpenHands / Cursor / Devin** | Autonomous SWE agent loop | Governance kernel, replay, attestation, capability bundles, formal admission |
| **LangGraph + LangSmith** | Orchestration + observability | Coding-specific, replay determinism, capability security, attestation |
| **Sigstore** | Transparency log + signing | Execution, agent semantics |
| **seL4** | Formally verified capability kernel | Agent/coding semantics, ledger, distribution surfaces |

**Buildplane's unique position:** the only system in the list that combines durable execution + cryptographic attestation + capability security + agent-coding semantics + deterministic replay testing.

## 13. Open questions

1. **`packet` → `compact` rename**: how much existing code does this touch? Worth a separate refactor slice or a v1.0 rename window?
2. **Native binary distribution**: Rust binary + TS layer. How do operators install? `cargo install`? `brew`? Static binaries via GitHub Releases? Affects v1.0 install story.
3. **Where does multi-operator state live?** CRDT-merged tape annotations are conceptually clean, but the physical storage (shared S3? per-operator local + sync?) is unresolved.
4. **MCP integration for tool execution**: do tools used by workers come through MCP servers (consistent with Claude Code's model) or are they kernel-native? Probably MCP for portability; needs design.
5. **TLA+ vs. property tests**: which subset of safety properties earn formal TLA+ specs vs. exhaustive property tests in the simulator? TLA+ has a learning curve; property tests scale to more invariants. Likely both, prioritized.
6. **Cedar policy authoring UX**: operators won't write Cedar by hand. Need a policy-by-example or visual editor in Mission Control.
7. **Cross-platform sandbox parity**: gVisor is Linux-only. Firecracker is Linux-only. macOS path needs a different stack (Apple Virtualization Framework?). Windows is worse. Affects v1.0 platform target.
8. **Pack registry**: build into Buildplane? Use OCI directly? Federate via Sigstore? Affects pack signing design.
9. **What happens to the existing `main` snapshot?** Real architecture lives in worktrees; `main` is described as "minimal prototype snapshot." v1.0 requires consolidating `main` to the actual architecture. Migration plan needed.
10. **PR autopilot (headdev) from `Command` repo**: where does this slot in this architecture? Probably as a policy + runtime-trigger (admitted Compacts can include "post-PR-merge autopilot rules"), not as a top-level subsystem.

## 14. Out of scope (deferred / never)

- Hosted SaaS version (post-v3 if ever).
- Auto-generation of plans from natural language without operator review (intentionally never).
- "Smart" auto-merge without policy quorum (intentionally never).
- Replacement of underlying agent CLIs (Claude Code, Codex, etc.) — they remain hosts.
- Mobile-as-primary-surface (mobile is approval companion, not control plane).

## 15. Glossary

| Term | Definition |
|---|---|
| **The Tape** | Append-only signed event ledger + content-addressed evidence store. L0. |
| **Kernel** | Durable execution engine. L1. |
| **Compact** | Typed unit of work + capability bundle + acceptance contract. L2. Renames `packet`. |
| **Pack** | Workflow personality (SuperClaude, SuperCodex, PlanForge-style planner). |
| **Host** | Local session surface (Claude Code, Codex, terminal). |
| **Provider** | API transport (Anthropic, OpenAI). |
| **PlanForge** | Admission layer. Goal → plan → preview → admit → execute. |
| **Capability Bundle** | Sealed token enumerating what a worker may do. |
| **Acceptance Contract** | Evidence required for accept. |
| **Operator** | Human user who commands a fleet of bounded workers. |
| **Mission Control** | Operator cockpit UI. |
| **Sandbox tier** | Isolation level (T0 worktree, T1 container, T2 microVM, T3 WASM). |
| **Skill Library** | Procedural memory of distilled-from-success playbooks. |
| **Quorum admission** | Multi-sig admission requiring N-of-M approvers. |
| **Transparency log** | Public Merkle log to which tape roots can be published for third-party verifiability. |

## 16. References

- Temporal — *durable execution via event history and replay.* [docs.temporal.io](https://docs.temporal.io/workflow-execution)
- FoundationDB — *deterministic simulation testing.* [apple.github.io/foundationdb/testing.html](https://apple.github.io/foundationdb/testing.html)
- SLSA v1.0 — *Supply-chain Levels for Software Artifacts.* [slsa.dev/spec/v1.0/levels](https://slsa.dev/spec/v1.0/levels)
- in-toto — *attestation framework for software supply chains.* [in-toto.io](https://in-toto.io)
- Sigstore Rekor — *transparency log for software signing.* [docs.sigstore.dev/rekor/overview](https://docs.sigstore.dev/rekor/overview)
- Microsoft Agent Governance Toolkit (April 2026) — *runtime security for AI agents.* [opensource.microsoft.com](https://opensource.microsoft.com/blog/2026/04/02/introducing-the-agent-governance-toolkit-open-source-runtime-security-for-ai-agents/)
- seL4 — *formally verified capability microkernel.* [sel4.systems](https://sel4.systems)
- Cedar — *AWS verifiable policy language.* [cedarpolicy.com](https://www.cedarpolicy.com)
- OPA Rego — *Open Policy Agent.* [openpolicyagent.org](https://www.openpolicyagent.org)
- Automerge — *CRDT for local-first applications.* [automerge.org](https://automerge.org)
- gVisor — *user-space kernel for container isolation.* [gvisor.dev](https://gvisor.dev)
- Firecracker — *microVMs for serverless workloads.* [firecracker-microvm.github.io](https://firecracker-microvm.github.io)
- Wasmtime — *standalone WebAssembly runtime.* [wasmtime.dev](https://wasmtime.dev)
- Claude Agent SDK overview — [docs.claude.com/en/agent-sdk/overview](https://docs.claude.com/en/agent-sdk/overview)
- Voyager (Wang et al., 2023) — *open-ended embodied agent with skill library.* arXiv:2305.16291

---

## Appendix A — Honest realism

This spec describes the **final form**, not the current state. The gap between current Buildplane and v1.0 of this spec includes:

- Vertical slices (compile → admit → execute → ledger → merge) that prove the spine connects on one task, end-to-end. Today, no such slice exists.
- Capability bundles as sealed tokens with cryptographic enforcement. Today, the policy package exists but capabilities are not sealed tokens.
- Deterministic simulator. Today, none.
- Per-event signatures + transparency log. Today, tape exists but events are not individually signed.
- Sandbox tiers beyond worktree. Today, only worktree.
- `main` consolidated to reflect actual architecture. Today, `main` is a minimal prototype snapshot while real work lives in worktrees.

The roadmap in §11 assumes these gaps close in this order:
1. Vertical slice (proves spine — month 1–3).
2. Simulator + per-event signatures (proves correctness — month 3–9).
3. Capability tokens + sandbox tiers (proves safety — month 9–15).
4. Mission Control + attestation chain (proves operator value — month 15–24).

Until the vertical slice exists, every other piece of work is scaffolding without a roof. The vertical slice is the first thing.

## Appendix B — Distinguishing this spec from current Buildplane work

For each subsystem, what's already in Buildplane vs new in this spec:

| Subsystem | Current Buildplane | New in this spec |
|---|---|---|
| L0 Tape | `bp-ledger` + CAS + backpressure | Per-event signatures, Merkle transparency log, OCI evidence store, federation |
| L1 Kernel | orchestrator, run loop, packet | Temporal-style workflow/activity split, deterministic I/O substitutes, fork as tape op |
| L2 Compact | `packet.ts` (delivery shape) | Rename, formal capability bundle, acceptance contract, trust scope, replay seed |
| L3 Pack/Host/Provider | Designed, partly implemented | Routing-as-policy, renderer version in tape, pack signing |
| L4 Sandbox | Worktree only | Container (gVisor), microVM (Firecracker), WASM tiers |
| L5 Memory | 5-layer model, scope-aware retrieval | Temporal knowledge graph, skill library, confidence + decay, capability-gated queries |
| L6 PlanForge | Dry-run CLI, schema, docs reconciled | In-toto layouts, quorum admission, SLSA L3 receipts, dry-run-isomorphic-to-real |
| L7 Policy | Budgets, trust gates, retry, approval profiles | Cedar + Rego, TLA+ specs in CI, trust scoring feedback loop |
| L8 Mission Control | Run Inspector slice | Time-scrubber, multi-operator CRDT, typed approvals everywhere, attribution |
| L9 Distribution | CLI + TUI | Mobile + IDE extensions + public transparency log endpoint |
| Cross-cutting: simulator | None | FoundationDB-style deterministic simulation testing |
| Cross-cutting: attestation chain | Implicit in ledger | Explicit signed chain, externally verifiable |

The new work is substantial. The existing work is real foundation. The path forward is consolidation, then vertical slice, then layer-by-layer extension.
