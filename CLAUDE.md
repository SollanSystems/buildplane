# Buildplane — Operating Manual

> **What this file is.** The living operating manual + handoff doc for Buildplane. Read **this** to orient and start work. Do **not** bulk-read the planning corpus under `docs/superpowers/{specs,plans}` (577 files / ~2MB) — it is archive, not read-path. When you need M2 detail, open the **one** spec linked in §"Where things live"; pin the v0.5 / v∞ design docs as single links rather than reading them wholesale. This file supersedes the stale May-3 WARP-oriented `AGENTS.md` for everything except verbatim command/mechanics blocks (which are carried forward here and remain authoritative).

---

## What Buildplane is

Buildplane is an **operator-first control plane for autonomous software execution**. It treats language models and agent shells as *bounded workers* inside a kernel that owns scheduling, state, policy, verification, and recovery. It dispatches typed units of work in isolated contexts, captures evidence for every action, and advances only when reality matches the contract.

The build is **trust-first sequenced**: the signed, append-only event tape (L0) is the foundation that cannot be retrofitted later, so it shipped before any higher-level feature. Everything above it — admission, dispatch, acceptance, the web surface — is layered on top of a tape whose authenticity and replayability are already proven. If you are tempted to "add the signing later," stop: that inversion is exactly what the milestone order exists to prevent.

---

## Current state & roadmap

Milestone map (status as of 2026-07-08):

| Milestone | Scope | Status |
|---|---|---|
| **M0** | Foundations | ✅ complete |
| **M1** | Signed Ed25519 per-event tape (S1–S7) + external verifier + GATE receipt | ✅ complete (`main` tip `8a98ea6`) |
| **M2** | PlanForge admission cycle: `compile → validate → preview → admit → dispatch → execute → receipt` + explicit-input resume (Gate C Path i) | ✅ complete (M2-GATE `fd598da` / #182–#183) |
| **M3** | Capability broker (digest-referenced bundles, per-tool-call validation — `write_file` + `run_command`) | ✅ complete (M3-GATE `docs/operations/2026-06-15-m3-gate-receipt.md`) |
| **M4** | Acceptance contract (diff-scope + CI + lint gating on finalization) | ✅ complete (M4-GATE `docs/operations/2026-06-18-m4-gate-receipt.md`) |
| **M5** | Web Mission Control (approval inbox, run inspector) | ✅ complete (M5-GATE `docs/operations/2026-06-28-m5-gate-receipt.md`) |
| **M6** | End-to-end demo (incl. crash-and-resume) + cut **v0.5.0** | ✅ complete (M6-GATE `docs/operations/2026-07-04-m6-gate-receipt.md`, closed 2026-07-08 — **v0.5.0 shipped**) |

**M2–M6: all closed at their GATEs.** **v0.5.0 is shipped (2026-07-08):** `buildplane@0.14.0` published to npm, repo flipped **PUBLIC** under **MIT**, GitHub release **v0.5.0** cut at `4b1c065` and marked latest. The M6-GATE receipt (`docs/operations/2026-07-04-m6-gate-receipt.md`) carries the watched-demo evidence (10 steps + 3 properties, executed 2026-07-03), the operator ledger (PATs, full-history secret scan, public flip, publish), and the disclosed R6 honesty items. Of the five M5 deferrals handed to M6, `result_ready` was implemented (S6/S7); Tier-2 signature read-back, web plan-admit Flow 2, SSE/live-push, and published-install web serving remain deferred. **Next allowed action: post-v0.5 planning** — carry-forward backlog: resume-path per-tool-call sink · `globIsSubset` middle-wildcard fix (dogfood unblocking — the `code-edit` side-effect vocabulary itself already shipped at M6-S4) · broker enforcement on the model-worker surface · the four still-deferred M5 items · memory-program unfreeze decision (`run_outcomes` → M4 trust scoring). Note: **M4 core is memory-neutral** — the `run_outcomes` trust-scoring consumer (the designated first rent-payer) is a *later, deferred* M4 slice, **not** M4 core (see §"Memory program status").

**M2 slice archive (complete):** S1–S8 + M2-GATE — ledger in `docs/operations/2026-06-09-m2-gate-receipt.md` (S7b phase 2b waived, Path i explicit resume).

**M3 slice archive (complete):** S1 schema/digest (#185) · S2 evaluate (#186) · S3–S6 attach/enforce-write/`capability_denied`/runtime-hook (#187) · S7 plan-level bundle envelope · **S7b run_command enforcement** (gap-closure: the allowlist was defined+evaluable since S2 but unenforced on the tool surface — now both `write_file` and `run_command` fail-closed) · S8 GATE — ledger in `docs/operations/2026-06-15-m3-gate-receipt.md`. Architecture: `docs/architecture/capability-broker.md`. **Enforcement scope:** the fail-closed `write_file`/`run_command` gate engages only on **command-executor** packets (`run-cli.ts` keys off `packet.execution`); model/claude-code worker packets carry no capability-scoped tool registry and are constrained instead by M4 post-hoc diff-scope + acceptance — this is the M6 demo's honest Property-2 scoping (broker doc §"Enforcement scope"; extending enforcement to the model-worker surface is post-v0.5 backlog). **Follow-up (SHIPPED at M6-S4 #214):** the `code-edit` side-effect vocabulary (`src/**`, `test/**`, `packages/**/{src,test,fixtures}/**`, `native/crates/**/{src,tests}/**`) lives in `packages/planforge/src/bundle.ts`; the remaining dogfood blocker is the `globIsSubset` middle-wildcard gap in `packages/policy/src/authorization-envelope.ts` (open fork).

**M4 slice archive (complete):** S1 `packages/policy` schema + pure evaluator (#192) · S2 L0 signed `acceptance_recorded` event (#194) · S3 finalization gate + check runner + emit + quarantine + CLI `--enforce-acceptance` (#196) · **S3-fix** diff-scope fail-open closed — reject when the worktree HEAD advances off the recorded base SHA (#198 `2704f4f`, CRITICAL surfaced by the S3 adversarial bypass review) · S4 GATE — ledger in `docs/operations/2026-06-18-m4-gate-receipt.md`. Architecture: `docs/architecture/acceptance-contract.md`. **Memory-neutral** (the `run_outcomes` consumer is a deferred slice). **Follow-up:** the sync `runPacket` acceptance path is unguarded (not reachable today — PlanForge routes through `runPacketAsync` only); keep it from diverging from the async guard.

**M5 slice archive (complete):** S1 signed `operator_decision_recorded` event kind (rode in on #200 `a5de446`, ratify-in-place L0 4-role) · S2 storage read surface + Tier-1 acceptance shadow (#202) · S3 extract `createInspectorProjection` to `@buildplane/kernel` (#203) · **S4** `OperatorDecisionPort` + `orchestrator.recordOperatorDecision` write-ahead emit + crash-recovery reconciler (#205 `6e6cf64`, L0 4-role, 3 repair rounds) · S5 `packages/mission-control-server` `node:http` read+write API (#207) · S6 `apps/web` run inspector UI (#208) · S7 `apps/web` approval inbox UI (#209) · **S8** `bp web` subcommand + build/CI/bootstrap wiring (#210 `20e0a7e`) · **S4b** operator-decision resume ledger-integration coverage (#212 `a394bc5`, closes the SC1(2a) Flow-1 gap the gate verification surfaced) · M5-GATE — ledger in `docs/operations/2026-06-28-m5-gate-receipt.md` (resolved forks A–G; five deferred items handed to M6). Spec: `docs/superpowers/specs/2026-06-21-m5-mission-control-design.md`. **`bp web` is source/dev-only** (the optional `mission-control-server` isn't vendored + `apps/web/dist` isn't published). On a published install it fails closed: exit 1 with source-checkout guidance (explicit catch in `web-command.ts` + staged-install assertion in `verify-positive.mjs`; before the 2026-07-08 honesty patch the exit-1 came only from the generic CLI error catch with a raw module-not-found message).

**M6 slice archive (complete):** S1 `riskClass` on validate/preview (#215 `2ce5e9d`, planDigest rotated / idempotencyKey unchanged) · S2 `bp goal "<text>"` CLI (#222 `c71628d`) · S3 toy Express demo-repo fixture (#213 `4b9671c`) · S4 `code-edit` side-effect → `native/crates/**` globs (#214 `18bccd0`, surfaced the `globIsSubset` wildcard-middle admission blocker) · S5 repoint `docs/roadmap.json` to the M6 `result_ready` slice (#225 `1c15787`) · **S8** per-tool-call tape events from the claude stream — `ToolRequestStoredV1`/`ToolResultV1` (#220 `96c866e`) · S9 declarative `netEgress` allowlist in bundle + plan mapping (#223 `7c77a39`, declarative-only, no enforcement) · S10 `capability_denied` e2e + out-of-scope quarantine fixture (#218 `f324145`, no enforcement bug) · S11 crash-injection guard (`BUILDPLANE_CRASH_AFTER_ACTIVITY`) + crash-resume ledger-integration test (#224 `02ad88d`, exactly-one `plan_receipt`) · **S6 dogfood pre-flight** fixtures diff-scope + `--model` threading (#227 `ba49394`). · **S6** `result_ready` signed L0 event kind (#235 `b197580`, unanimous 4-role; ceremony-build fallback per plan §7 after the live dogfood attempts terminated honestly on the tape) · **S7** emit `result_ready` + `run_completed` write-ahead at the terminal outcome (#237 `fb96406`, L0 4-role, one repair round; `RunCompletedV1` U64 resolved as per-field string) · **S12** 10-step demo runner + operator runbook (#236 `8657730`; runbook `docs/operations/2026-07-02-m6-demo-runbook.md`) · **S13** MIT license + v0.5.0 public cut wiring (#238 `a22712f`) · **R1–R7** improvement slices (#228–#234) · demo watched-run fixes (#242 `74dc5f1`) · **F1** fail-closed `planforge resume`/`recover` — gate finding from the watched run; consume-once signed acceptance evidence (#244 `3c0c348`, 4-role-style, one CONFIRMED-HIGH repair) · **F2** per-tool-call tape events on the dispatch path (#243 `e7b6af6`) · release-infra tag creation + already-published skip (#248 `4b1c065`) · M6-GATE — ledger in `docs/operations/2026-07-04-m6-gate-receipt.md` (watched demo 2026-07-03: 10 steps + Properties 1–3). Spec: `docs/superpowers/specs/2026-06-29-m6-v05-demo-design.md`; plan: `docs/superpowers/plans/2026-06-29-m6-v05-demo.md` (+ `2026-07-01-m6-completion-and-improvements.md`). Slice receipts: `docs/operations/2026-07-01-m6-slice-receipts.md`. **Known residuals (disclosed at the gate):** resume-path per-tool-call sink unwired (dispatch-only); recorded-prefix runs get no synthetic `result_ready` on resume (deliberate — their evidence is the signed `activity_completed` + consumed `acceptance_recorded`); broker enforcement remains command-executor-only.

**Parallel memory program (frozen):** Phase 1 (`buildplane@0.3.0`) + Phase 2 outcome memory shipped to `main`. **Hard-frozen until operator reopens post–M2-GATE** — outcome routing opt-in / default-OFF. See §"Memory program status".

---

## Architecture

### Layer model (L0 … L6)

- **L0 — Tape (`bp-ledger` + `packages/ledger-client`):** signed, append-only event tape. The un-retrofittable trust foundation. See §"L0 trust surface".
- **L1 — Kernel (`packages/kernel`):** scheduling, run loop, orchestration, recovery.
- **L6 — PlanForge (`packages/planforge`):** the admission cycle (`compile → validate → preview → admit → dispatch → execute → receipt`).

(Intermediate layers — runtime, policy, adapters, memory, UI — sit between L1 and L6; the load-bearing trust ordering is L0 first.)

### TypeScript control plane (`apps/`, `packages/`) — pnpm monorepo

| Package | Role |
|---|---|
| `apps/cli` | operator-facing CLI command surface |
| `packages/kernel` | typed units, scheduler, orchestrator, event bus, packet/run loop, memory retrieval, policy integration |
| `packages/storage` | SQLite durable state, event store, learning store, repo facts, procedures, searchable docs |
| `packages/runtime` | bounded worker execution lifecycle, command executor |
| `packages/policy` | budgets, trust gates, retry policy, decision evaluation, approval profiles |
| `packages/ledger-client` | TS client for the Rust ledger: append-only tape, backpressure, handshake, envelope/wire protocol, payload types |
| `packages/adapters-git` | git worktree isolation adapter |
| `packages/adapters-models` | Claude Code + generic executors, provider-specific renderers (Claude, Codex) |
| `packages/adapters-codex` | Codex-specific executor |
| `packages/adapters-tools` | tool execution sandbox (run-command, write-file) |
| `packages/adapters-honcho` | Honcho process manager adapter |
| `packages/ui-tui` | terminal operator UI (Ink/React) |
| `packages/compat-gsd` | import bridge from legacy `.gsd/` state |
| `packages/planforge` | PlanForge admission cycle (new in M2-S1) |

### Rust native workspace (`native/`)

| Crate | Role |
|---|---|
| `bp-ledger` | append-only event tape, SQLite + content-addressed storage; canonical run record; per-event Ed25519 signing |
| `bp-replay` | deterministic replay engine (fast-forward, state transitions, iteration) — read-only, no side effects |
| `bp-fork` | fork a run from a unit boundary with a new packet |
| `bp-memory` | scope-aware memory retrieval |
| `bp-storage-sqlite` | SQLite schema + migrations |
| `bp-cli` | native CLI (`buildplane-native`), bridged from the TS CLI for `memory`/`pack` commands |
| `bp-pack-manifest` / `bp-pack-loader` / `bp-pack-inspection` | declarative pack model |
| `bp-host-*` | host detection (Claude, Codex) |
| `bp-provider-*` | API transport adapters (Anthropic, OpenAI) |
| `bp-ledger-macros` | proc macros for secret redaction in ledger payloads |

**Native binary resolution order:** `BUILDPLANE_NATIVE_BIN` env var → `native/target/debug/buildplane-native` → `native/target/release/buildplane-native` → `buildplane-native` on PATH.

### Core concepts

- **Pack ≠ Host ≠ Provider** — keep these as separate layers. **Packs** (SuperClaude, SuperCodex) are workflow personalities; **Hosts** (Claude Code, Codex) are local session surfaces; **Providers** (Anthropic, OpenAI) are API transports.
- **Ledger** — the L0 append-only tape is the canonical source of truth for every run. Events in SQLite, large payloads in CAS. The TS `ledger-client` talks to it over a wire protocol with backpressure. **Replay is read-only with no side effects.**
- **Memory layers** — Working → Episodic (event spine) → Semantic (repo facts) → Procedural (playbooks) → Outcome scores. Exact retrieval first, semantic second. Every entry carries provenance (scope, confidence, status, source run/task).
- **TaskIntent + Renderers** — structured `TaskIntent` replaces raw prompts; provider-specific renderers translate intents into prompts at execution time. Executors check `packet.intent` first, then fall back to legacy `packet.model.prompt`.
- **Worktree isolation** — the run loop expects a clean git working tree. Units execute in isolated git worktrees; results are squash-merged back.

### Coordination & state

- The kernel `orchestrator.ts` is the central execution coordinator — it wires the run loop, event bus, storage, policy, and adapters.
- Package imports use `@buildplane/<package>` aliases; all packages use TS project references (`tsconfig.json` → `tsconfig.base.json`).
- Storage uses SQLite: `better-sqlite3` (TS) and `rusqlite` (Rust).
- `.buildplane/` is the per-repo state dir (`state.db`, artifacts, evidence, runs, logs, workspaces).

---

## Build / test / run

Requires: **Node 24.13.1, pnpm 10, Rust stable toolchain.**

```
pnpm install                    # install dependencies
pnpm build                      # tsc --build (compile TypeScript)
pnpm native:build               # cargo build -p bp-cli (required before tests)
pnpm test                       # builds native, then vitest --run (all tests)
pnpm test:watch                 # vitest in watch mode
pnpm typecheck                  # tsc --build --pretty false
pnpm lint                       # biome check .   (see Gotchas — OOMs locally in WSL)
pnpm format                     # biome format --write .
pnpm check                      # lint + typecheck + test + build (full presubmit)
```

Run a single test file:
```
pnpm vitest --run path/to/file.test.ts
```

Run tests matching a pattern:
```
pnpm vitest --run -t "pattern"
```

Native Rust tests (all crates / single crate):
```
cargo test --manifest-path native/Cargo.toml
cargo test --manifest-path native/Cargo.toml -p bp-ledger
```

Run the CLI from source (no build required):
```
pnpm buildplane <command>
```

Regenerate ledger fixtures after changing Rust payload types:
```
pnpm ledger:gen-fixtures
```

Regenerate TS bindings + fixtures after changing typeshared Rust types:
```
pnpm ledger:gen && pnpm ledger:gen-fixtures
git diff --exit-code packages/ledger-client/src/generated packages/ledger-client/fixtures
```

Run evals:
```
pnpm eval
```

**Slice verify command (canonical for per-slice work — memorize this):**
```
pnpm -C <worktree> exec vitest run <paths>
```
**NEVER** use `pnpm --filter buildplane test` — it breaks vitest aliases and silently stalls the lane (it cost every Phase-1 lane before it was documented). Run scoped vitest from the worktree root with `-C`.

### Testing layout

- Vitest 4.x, single root `vitest.config.ts`; workspace aliases resolved there (so tests import `@buildplane/kernel` directly).
- Test timeout 15s, hook timeout 60s.
- Locations: `apps/**/test/`, `packages/**/test/`, root `test/` (`event-stream/`, `graph/`, `integration/`, `ledger-integration/`, `local-run-loop/`, `strategy/`, `workflow/`, `eval/`).
- Ledger-integration tests require the native binary built first.
- `cli-graph` / `graph-e2e` are `.skip` (flaky under parallel git-worktree load). A pre-existing `ledger-integration` parallel flake (a `process.chdir` race in `test/ledger-integration/fixtures.ts`) is deferred — quarantine/serialize rather than fight it.

### CI pipeline (`.github/workflows/ci.yml`)

`pnpm install` → build native → verify ledger fixture freshness → assert no pre-existing `dist` dirs → dev bootstrap smoke test → assert clean worktree after smoke → verify published-bootstrap contract. **`pnpm check` is the local equivalent of the full CI gate**, and the CI `verify` job is the canonical environment (trust it over local runs that OOM — see §"Gotchas / traps").

---

## L0 trust surface

The L0 tape is the foundation; changes here go through the **full review ceremony** (§"Review ceremony & slice discipline") and have two load-bearing contracts.

### Canonical digest contract (load-bearing)

Anything that gets **signed** — `planDigest`, `inputDigest`, `idempotencyKey`, the admission digest, the receipt digest — MUST use the **stable canonical serialization shared by Rust and TypeScript**: the `bp-ledger` `canonicalize.rs` path (`serde_json::to_vec` of a *frozen field order*), **not** insertion-order `JSON.stringify`. The same input, at the same trusted base, with the same evidence MUST produce the same `idempotencyKey` / `inputDigest` / `planDigest`, and therefore the same signed admission identity. (M2-S1 replaced the old non-canonical `planDigest` and did a one-time documented golden-fixture update.)

### U64 → TS `number` precision hazard (act before any new signed wire shape)

TypeScript `number` cannot faithfully represent a Rust `u64`. **Map `u64 → string` in typeshare** when you touch a signed payload, and regenerate fixtures. Any S3+ slice that signs new wire fields must explicitly target **byte-identical digest output** across Rust and TS — once a tape event is signed and in production, a wrong wire shape forces a tape migration. Treat this as a pre-flight check, not a follow-up.

### Adding a new event kind to `bp-ledger` (the multi-file derivation)

Adding one event kind is a coordinated change across both languages. The full set of touch points:

1. `native/crates/bp-ledger/src/kind.rs` — add the kind variant.
2. `native/crates/bp-ledger/src/payload/<area>.rs` — add the payload struct (e.g. `PlanAdmittedV1`), annotated `#[typeshare]`.
3. `native/crates/bp-ledger/src/payload/mod.rs` — register the payload.
4. `native/crates/bp-ledger/src/canonicalize.rs` — add the `kind_to_variant` + `payload_variant_name` arms.
5. `native/crates/bp-ledger/tests/<area>.rs` — round-trip + canonicalize tests.
6. `pnpm ledger:gen` — regenerate typeshare TS into `packages/ledger-client/src/generated/`.
7. **Hand-edit** `packages/ledger-client/src/payload.ts` — extend the TS union (this is not fully auto-generated).
8. `pnpm ledger:gen-fixtures` — regenerate `fixtures/payload-variants.json` from Rust (real Ed25519 signatures, byte-stable, freshness-gated by CI).
9. `git diff --exit-code packages/ledger-client/src/generated packages/ledger-client/fixtures` — confirm byte-stable.

**Enum-variant exhaustive-match gate (mandatory):** adding a `Payload`/`EventKind` variant can silently break sibling crates' exhaustive matches (e.g. `bp-replay`). Run the **whole workspace** — `cargo test --manifest-path native/Cargo.toml` (NO `-p`), not scoped `-p <crate>`. This is the exact break that failed PR #163's CI `verify` until the `bp-replay` match was fixed. Replay transition matches must stay exhaustive (no `_` catch-all) so a new kind can never silently no-op.

The external verifier (`scripts/verify-signed-tape.mjs`) reproduces the `tape_root_hash` contract: signed **non-checkpoint** events only, ordered `id ASC`, `\n`-joined with **no trailing newline**, hashing the **stored `canonical_event_hash`** (it never re-serializes an event). Event-id formatting is `{:012}` **decimal** (not hex). Caveat: trusted keys are tape-embedded, so the verifier proves *consistency*, not third-party *authenticity*.

---

## Review ceremony & slice discipline

### Tiered review ceremony

| Tier | Surface | Reviewers |
|---|---|---|
| **L0** | tape / signing / replay / digest | **Full 4-role**: implementer TDD self-verify + independent Opus Reviewer (fresh session) + adversarial Codex + independent acceptance-criteria verifier |
| **L1 / L2** | kernel / dispatch logic | 2-role |
| **L3** | docs / fixtures / test-infra | single self-review |

For M2 concretely: L0 slices are **S2, S3, S5, S6, S7a, S7b** (Opus + adversarial Codex). **S1** takes 1 independent Reviewer; **S4** takes 1 independent Reviewer (**+ adversarial Codex if the admission-gate logic changes**); **S7-HARNESS** takes 1 independent Reviewer (test-infra only — no adversarial Codex). The Reviewer verdict must be `PASS` with the reviewed SHA equal to the PR head.

### Slice process

- **TDD: RED → GREEN → commit.** Write the failing test first.
- Verify locally with the slice verify command (`pnpm -C <worktree> exec vitest run <paths>` — §"Build / test / run").
- **Changeset only when a published surface changes** (`packages/*` / `apps/*`). Root scripts, crate-internal fixtures/tests, and docs need **no** changeset (M1-S7 shipped without one for exactly this reason).
- Conventional commits, **lowercase verb first** (commitlint rejects upper-case leads).
- Record each slice against the receipt template at **`docs/operations/slice-receipt-template.md`**; M2-GATE lands a gate receipt under `docs/operations/`.
- **L0/L1 solo PRs are not auto-merge eligible** — do not apply `buildplane:auto-merge`; they need operator admin-merge.

### Release / versioning

- Changesets drive versioning; the changesets bot opens `chore: version packages` release PRs (one is typically open — check before assuming a version is live). `buildplane@0.3.0` carried the Phase-1 memory work.
- `main` branch protection requires the CI `verify` + `Analyze` checks (no required human-review check). Mergify's approval gate governs only the auto-merge *queue* — solo PRs merge once checks pass (admin-merge for the non-auto-merge-eligible ones).

---

## Memory program status

The memory program is **shipped on `main` but frozen.**

- **Phase 0** reconciled the V1 spine (episodic events; `repo_facts`/`procedures`/`searchable_documents` + FTS5; `BuildplaneStoragePort`; `extractLearnings`; run-loop injection; invalidation) under ADR 0001's dual-injection model (`run_learnings` vs structured `repo_facts`/`procedures`, bridged only by a manual receipt-gated `promote` in `run-cli.ts`).
- **Phase 1** (`buildplane@0.3.0`): repo-fact seeding, memory CLI (facts/procedures), reviewer memory injection. Active on `main`.
- **Phase 2 Track 1** (gap-fixes): cross-layer dedup, `repo_facts` branch filtering (branch-only; commit-ancestry validity deferred), episodes read path.
- **Phase 2 Track 2** (outcome memory): raw append-only `run_outcomes` rows aggregated at read time (chosen over an accumulator because supersede-then-insert destroys the tally). The producer fills `routingHints` inside `prepareRun` **before** `createRun`, so the recorded route == the executed route. Scoped to model packets only; recorded at `finalizeRun`; terminal-only (rejected packets recorded, retrying packets skipped).

**Frozen contract:** outcome routing ships **opt-in / default-OFF** (`enabled:false`, `epsilon:0`) — **nothing consumes `run_outcomes` yet.** Main behavior is byte-for-byte unchanged until an operator throws the flag. The freeze held through every gate M2→M6; the unfreeze decision is now a **post-v0.5 planning item** (M6-GATE carry-forward). When reopened: wire exactly one `--outcome-routing-enabled` config key whose single rent-paying integration is **feeding `run_outcomes` into M4 acceptance/trust scoring**. Do not build Phase-3 automation or further memory features before then.

Phase-3 deferrals (do not start): infra-failure-path outcome recording (no `workerStarted` signal), epsilon steady-state exploration (needs a per-run seed pre-minted before `createRun`), `run_outcomes` retention/compaction, model/effort routing grain, and the `ledger-integration` flake quarantine.

---

## Gotchas / traps

Stated as imperatives — these have each burned a session:

- **Slice verify:** run `pnpm -C <worktree> exec vitest run <paths>`. **NEVER** `pnpm --filter buildplane test` — it's an alias trap that silently stalls the lane.
- **Biome OOM:** `biome check .` (whole-repo) OOMs in the WSL sandbox. The **CI `verify` job is canonical**; locally, scope lint to changed files. **Route every push/PR through a fresh subagent** so the OOM never lands in the orchestrator session (husky `pre-commit`/`pre-push` run lint/`pnpm check`).
- **Commitlint:** lead the commit subject with a **lowercase verb** (conventional commits). Upper-case-led subjects are rejected.
- **`core.bare` misconfig:** if work-tree git ops fatal with *"must be run in a work tree"*, `.git/config` has `core.bare=true`. Fix with `git config core.bare false`. Autonomous worktree slice-builders depend on clean git state — verify this before dispatching them.
- **Worktree baseline:** `EnterWorktree(baseRef=head)` cuts from the *current* tip — it needs a prior fast-forward so it cuts from current `origin/main`. The local feature branch is usually **stale after a squash-merge**; always FF (or cut fresh) from `origin/main`, never forward local to a stale branch.
- **Published-bootstrap closure:** any new `packages/*` dep imported by `apps/cli` must be added to `scripts/published-bootstrap/stage-package.mjs` `INTERNAL_PACKAGE_ENTRYPOINTS` **AND** the `test/workflow/published-bootstrap-stage.test.ts` snapshot — or CI `verify` fails the runtime-closure assertion. A scoped vitest + build will **not** catch it; only the CI `verify` job does.
- **Solo-PR merge:** solo PRs need admin-merge; L0 slices are **not** auto-merge eligible (no `buildplane:auto-merge` label). gh's default OAuth token **cannot write rulesets** (PATCH/DELETE 404 despite admin) — use the GitHub web UI or a classic/fine-grained PAT.
- **Worktree-push corruption:** the `process.chdir` race in `test/ledger-integration/fixtures.ts` can corrupt worktree branches on push under vitest parallel workers. Mitigation today: `git push --no-verify`. Root-cause fix (remove `process.chdir`, extend explicit-cwd discipline) is deferred.
- **Mergify ruleset scope:** scope any branch-deletion ruleset to `~DEFAULT_BRANCH`, **not** `~ALL` (`~ALL` blocks all branch deletion repo-wide). Enable `delete_branch_on_merge` for auto-clean of merged head branches.
- **Changesets release CI:** release PRs authored by `GITHUB_TOKEN` never re-trigger CI (GitHub anti-recursion). Feed a `RELEASE_TOKEN` PAT to both `actions/checkout` and the changesets step env, with a `|| github.token` fallback; `secrets.GITHUB_TOKEN` is not the safe fallback for this workflow.

---

## Where things live / what NOT to read

- **Active branch context:** always cut fresh from `origin/main`. Local branches go stale immediately after a squash-merge.
- **Specs:** `docs/superpowers/specs/`. The single authoritative M2 spec is **`docs/superpowers/specs/2026-05-29-planforge-m2-admit-cycle.md`** — read it for M2 implementation detail.
- **Plans:** `docs/superpowers/plans/`.
- **Architecture docs (reference; link, don't read wholesale):** `docs/architecture/planforge.md`, `docs/architecture/run-admission-receipts.md`, `docs/ledger.md`; v0.5 design `docs/superpowers/specs/2026-05-21-buildplane-v05-design.md`; M1 signing spec `docs/superpowers/specs/2026-05-22-tape-per-event-signing.md`.
- **Operations / receipts:** `docs/operations/` (slice-receipt template + per-milestone GATE receipts).
- **DO NOT bulk-read the planning corpus** (`docs/superpowers/{specs,plans}`, 577 files / ~2MB). It is archive. Open the one M2 spec above when you need it; this manual carries everything else you need to start.

### M2 integration facts worth keeping at hand

- **Run-admission coexistence:** the new signed `plan_admitted` event coexists with the already-landed `run_admission_recorded` (#133/#138, currently a `.git/buildplane/admission/events.jsonl` sidecar + in-memory `WeakSet` trust). Mirror the sidecar onto the signed tape — **do not rework** the landed admission wiring.
- **Signing authority:** all M2 events are signed by the **kernel key** (`actor_id="kernel"`, `key_id="kernel-main"`); the operator's identity is a payload field. Operator-key signing is deferred. Keys live per-machine at `~/.buildplane/keys/<actor>/<key-id>.ed25519`.
- **Dispatch path:** PlanForge dispatch routes through `runPacketAsync` **only**; the sync path is confirmed not load-bearing for PlanForge.
- **Crash-recovery contract (S7):** on startup, scan storage for `running` runs; for each, replay the tape. **The tape (`events.db`) is authoritative over the storage status field.** Resume rules: no `plan_admitted` → require re-approval; `plan_admitted` but no execution → re-dispatch without re-approval (re-establish `will_execute_worker` trust *from the tape*, not the lost `WeakSet`); `activity_completed` on tape → reuse the recorded result, never re-invoke the model/tool; executed but no `plan_receipt` → re-emit it; receipt on tape but `running` in storage → reconcile, don't re-run. Write-ahead ordering is mandatory: `activity_started` is appended and signed **before** the activity is invoked.

---

## Open strategic forks (handoff)

These are unresolved operator-level decisions. Surface them; don't silently pick.

- **Why v0.5 / what does success unlock?** Still unresolved post-ship. No longer gates the license (MIT shipped at S13); it now gates post-v0.5 sequencing — which carry-forward item goes first.
- **Dogfooding reframe (decided in principle, needs a slice):** Buildplane is currently **not** built using Buildplane — which falsifies its own thesis. Build at least one real slice **through the actual `planforge admit` path** so a future demo can credibly show *"the last features of this tool were built and verified by this tool."* Open question: which feature is the dogfood slice. **Concrete blocker (corrected 2026-07-08):** ONLY the `globIsSubset` wildcard-middle gap (`packages/policy/src/authorization-envelope.ts` — a middle-wildcard envelope glob like `packages/**/test/**` can never cover a concrete proposal like `packages/kernel/test/**`); the `code-edit` side-effect vocabulary already shipped at M6-S4 (`packages/planforge/src/bundle.ts`). Note also: the M6-S6 workaround used envelope globs byte-identical to the proposal, which made the subset check vacuous — admission-gated self-modification has not yet run on a non-rigged input. Fixing `globIsSubset` requires adversarial review of the new matcher (its failure mode is over-admission — a breach of the gate it serves).
- ~~**License inconsistency**~~ **RESOLVED at M6-S13 (#238):** MIT `LICENSE` shipped, repo public, `buildplane@0.14.0` published.
- ~~**Run Inspector web UI**~~ **RESOLVED at M5:** shipped as the read-only run inspector + approval inbox (`bp web`, source/dev-only). Remaining question is the productization bar (published-install web serving, SSE — deferred to post-v0.5).
- **Adversarial Codex productization bar:** the adversarial Codex reviewer scores **43.75% on the reviewer-rescue benchmark, measured against a deterministic local stub** (4 fixtures) — the real Codex CLI has never been benchmarked (`BUILDPLANE_EVAL_MODEL=1` never run), so the number characterizes the stub harness, not Codex. The R6 disclosure obligation was discharged at M6-GATE (surfaced honestly in the README/receipt, not presented as production-ready) — but the bar itself is still undecided; the role stays an internal review aid until it clears one.
