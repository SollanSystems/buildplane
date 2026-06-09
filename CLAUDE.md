# Buildplane — Operating Manual

> **What this file is.** The living operating manual + handoff doc for Buildplane. Read **this** to orient and start work. Do **not** bulk-read the planning corpus under `docs/superpowers/{specs,plans}` (577 files / ~2MB) — it is archive, not read-path. When you need M2 detail, open the **one** spec linked in §"Where things live"; pin the v0.5 / v∞ design docs as single links rather than reading them wholesale. This file supersedes the stale May-3 WARP-oriented `AGENTS.md` for everything except verbatim command/mechanics blocks (which are carried forward here and remain authoritative).

---

## What Buildplane is

Buildplane is an **operator-first control plane for autonomous software execution**. It treats language models and agent shells as *bounded workers* inside a kernel that owns scheduling, state, policy, verification, and recovery. It dispatches typed units of work in isolated contexts, captures evidence for every action, and advances only when reality matches the contract.

The build is **trust-first sequenced**: the signed, append-only event tape (L0) is the foundation that cannot be retrofitted later, so it shipped before any higher-level feature. Everything above it — admission, dispatch, acceptance, the web surface — is layered on top of a tape whose authenticity and replayability are already proven. If you are tempted to "add the signing later," stop: that inversion is exactly what the milestone order exists to prevent.

---

## Current state & roadmap

Milestone map (status as of 2026-06-08):

| Milestone | Scope | Status |
|---|---|---|
| **M0** | Foundations | ✅ complete |
| **M1** | Signed Ed25519 per-event tape (S1–S7) + external verifier + GATE receipt | ✅ complete (`main` tip `8a98ea6`) |
| **M2** | PlanForge admission cycle: `compile → validate → preview → admit → dispatch → execute → receipt` + Temporal-style crash recovery | 🔶 in progress — S1 through S7a merged; **S7b is next** |
| **M3** | Capability broker (sealed capability bundles, per-tool-call capability validation) | planned |
| **M4** | Acceptance contract (diff-scope + CI + lint gating on finalization) | planned |
| **M5** | Web Mission Control (approval inbox, run inspector) | planned |
| **M6** | End-to-end demo (incl. crash-and-resume) + cut **v0.5.0** | planned |

**M2 slice status & critical path:** `S1 ∥ S2 → S3 → S4 → S5 → S6 → S7-HARNESS → S7a → S7b → S8`.

- **S1 ✅ merged** (PR #161): `packages/planforge` extraction + runtime contract + canonical digest (with a one-time, documented golden-fixture digest update from the canonicalization change).
- **S2 ✅ merged** (PR #163): four signed event kinds (`plan_admitted`, `plan_receipt`, `activity_started`, `activity_completed`). The Codex GH-agent commit also fixed a `bp-replay` exhaustive-match break (added no-op arms; real replay deferred to S7a).
- **S3 ✅ merged** (PR #166): operator-approved `plan_admitted` via `buildplane planforge admit <plan> --approve`.
- **S4 ✅ merged** (PR #168): admitted plans dispatch into signed-gated kernel runs.
- **S5 ✅ merged** (PR #171): signed `activity_started` / `activity_completed` bracketing for PlanForge dispatch.
- **S6 ✅ merged** (PR #173): signed `plan_receipt` plus live `ledger export-signed-tape`; post-merge receipt correction is in `docs/operations/2026-06-04-m2-s6-receipt-live-tape-export-slice-receipt.md`.
- **S7-HARNESS ✅ merged** (PR #174): deterministic crash-injection harness and read-only durable tape probe; receipt in `docs/operations/2026-06-07-m2-s7-harness-crash-injection-receipt.md`. This is test infrastructure only — production kernel startup/resume remains S7b.
- **S7a ✅ merged** (PR #177): Rust `bp-replay` PlanForge cycle transitions and recorded activity state; receipt in `docs/operations/2026-06-08-m2-s7a-replay-transitions-receipt.md`.
- **S7b 🔶 in progress** (branch `feat/m2-s7b-explicit-resume`): **phase 1** explicit-input `planforge resume` (CLI + ledger-integration tests). **Phase 2** still required: kernel orchestrator startup scan / automatic resume / S7-HARNESS kill-point replay per spec lines 273–291.
- **S8 planned**: M2-GATE vertical slice + gate receipt.

**Parallel memory program (frozen):** Phase 1 (`buildplane@0.3.0`) + Phase 2 outcome memory (Track 1 gap-fixes + Track 2 `run_outcomes`) shipped to `main`. It is **hard-frozen at Phase 2 S5 until M2-GATE** — outcome routing is opt-in / default-OFF with no consumer. See §"Memory program status".

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

**Frozen contract:** outcome routing ships **opt-in / default-OFF** (`enabled:false`, `epsilon:0`) — **nothing consumes `run_outcomes` yet.** Main behavior is byte-for-byte unchanged until an operator throws the flag. The decision is to **hold at Phase 2 S5 until M2-GATE** (make the freeze a line in the GATE receipt), then wire exactly one `--outcome-routing-enabled` config key whose single rent-paying integration is **feeding `run_outcomes` into M4 acceptance/trust scoring**. Do not build Phase-3 automation or further memory features before then.

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
- **Changesets release CI:** release PRs authored by `GITHUB_TOKEN` never re-trigger CI (GitHub anti-recursion). Feed a `RELEASE_TOKEN` PAT to both `actions/checkout` and the changesets step env, with a `|| secrets.GITHUB_TOKEN` fallback.

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

- **Why v0.5 / what does success unlock?** This gates the license call below. If the answer is "raise first," sequencing changes.
- **Dogfooding reframe (decided in principle, needs a slice):** Buildplane is currently **not** built using Buildplane — which falsifies its own thesis. Build at least one real M3/M4 slice **through the actual `planforge admit` path** so the M6 demo can credibly show *"the last features of this tool were built and verified by this tool."* Open question: which feature is the dogfood slice.
- **License inconsistency:** the competitive doc says "open source / free," but there is **no `LICENSE` file** and changesets is `access:restricted`. Resolve it — ship **MIT now** *unless* the answer to "what does v0.5 success unlock" is "raise first."
- **Run Inspector web UI:** thin read-only pull into the M3 window, or defer post-M6? (undecided)
- **Adversarial Codex productization bar:** the adversarial Codex reviewer currently scores **43.75% on the reviewer-rescue benchmark** (a local stub over 4 fixtures) — what's the bar before it can be the README front door?
