# Run Admission Receipt Contract

**Date:** 2026-05-08
**Status:** Docs/fixture contract plus BP5B ledger-event implementation plan for deterministic local run admission
**Scope:** Kernel-owned admission decision before worker execution; this slice documents the event contract and implementation plan but does not implement execution

## Decision

Buildplane run admission produces a deterministic receipt before a unit is allowed to execute. The receipt binds the run/unit identifiers, repo and worktree authority, requested capabilities, allowed and denied side effects, evidence inputs, admission decision, idempotency key, replay/fork implications, and provenance into one local-first record.

The receipt is an admission record, not an execution result. `PASS` means the trusted kernel found enough local evidence to admit a bounded run under explicit capability grants. It does not mean the run succeeded, tests passed, a PR is ready, or a worker claim should be trusted.

Admission attempts must also be durably recorded on the local event tape before worker execution. The canonical BP5B ledger event is `run_admission_recorded` with a `RunAdmissionRecordedV1` payload that points to the full receipt JSON by digest/CAS or artifact ref and repeats only the fields needed for inspection and gating.

Admission is intentionally narrow:

- the kernel validates and admits;
- coding agents remain untrusted workers;
- packs are not hosts, and hosts are not providers;
- ledger and replay surfaces remain side-effect safe;
- admission performs no GitHub calls, pushes, deploys, merges, hosted-service mutation, auto-Kanban writes, or worker execution.

## Source-of-truth boundary

A run admission receipt may only cite evidence that already exists locally or was produced by deterministic preflight commands. It may cite command output, git state, policy inputs, fixture paths, ledger refs, and artifact refs. It must not cite model confidence, chain-of-thought, unverifiable chat claims, or raw secrets.

Admission authority belongs to the Buildplane kernel/policy layer. Worker output can become an evidence input only after it is captured as a ledger/artifact record and checked by deterministic gates. Worker prose alone is not evidence.

## Admission decisions

The closed v0 decision vocabulary is:

| Decision | Meaning | Fail-closed behavior |
| --- | --- | --- |
| `PASS` | Required admission evidence is present, requested side effects fit explicit scoped grants, and the unit can be dispatched under those grants. | Dispatch may proceed only with the recorded grants. This is not a success verdict. |
| `BLOCKED` | The run is understandable but needs an operator decision, approval, credential repair, or dependency that policy cannot infer. | Do not execute. Preserve the receipt and wait for explicit authority. |
| `FAILED` | Deterministic admission validation failed for a reason that is not merely missing evidence or unsafe authority, such as malformed input or contradictory repo identity. | Do not execute. Fix the envelope/input and admit again with a new receipt/idempotency key. |
| `INSUFFICIENT_EVIDENCE` | Required local evidence is absent, stale, unreadable, or not bound to the requested repo/worktree/base commit. | Do not execute. Missing evidence is not a pass and must be named in the receipt. |
| `UNSAFE_TO_RUN` | Requested side effects exceed policy, touch forbidden scopes, require prohibited network/production/GitHub mutation, or cannot be safely sandboxed. | Revoke non-read grants, freeze/quarantine the bundle/worktree/artifacts, and require explicit release authority. |

## Receipt field contract

A v0 receipt is JSON and must include these top-level fields:

| Field | Required contents |
| --- | --- |
| `schema_version` | Contract version for the receipt shape, starting at `0.1.0`. |
| `receipt_type` | Literal `run.admission`. |
| `receipt_id` | Stable local receipt id. It must be unique per admission attempt. |
| `run` | `run_id`, `unit_id`, and optional external `task_id`. These ids identify the requested run, not the final execution result. |
| `repo` | Repo path, worktree path, expected remote, base ref, base commit, optional head commit, and whether preflight observed a clean worktree. |
| `request` | Requested capability set, requested side effects, declared path scope, network posture, and any operator approvals already present. |
| `policy` | Allowed side effects, denied side effects with reasons, capability grants, and revocation/quarantine instructions when applicable. |
| `evidence_inputs` | Ordered evidence records used for admission: kind, ref/path, digest when available, required flag, status, and failure/missing reason when applicable. |
| `admission` | Final decision, deciding authority, timestamp, reasons, missing evidence list, unsafe request list, and worker-dispatch posture. |
| `idempotency_key` | Deterministic key over normalized repo/base/scope/capability/evidence inputs. It must not include wall-clock time, random ids, or model prose. |
| `replay` | How replay reads the receipt without side effects, and how forks inherit or recompute admission. |
| `provenance` | Kernel/policy version hints, actor, local command/source, redaction policy, and explicit pack/host/provider separation. |

The field contract is intentionally explicit rather than clever. Later TypeScript/Rust types can narrow this JSON shape, but the first guarantee is that a human reviewer can open a receipt and answer: what was requested, what was allowed, what was denied, what evidence existed, why the kernel admitted or refused, and what replay/fork may safely do.

## Ledger/run-lifecycle event contract

The BP5B event tape contract is an append-only proof that the trusted kernel ran admission before any worker, tool, model, GitHub, push, deploy, or auto-Kanban side effect. The native ledger event kind should be `run_admission_recorded`; the TypeScript storage mirror, if needed for legacy inspector snapshots, should use `run-admission-recorded`.

### Event ordering

A native event tape opens with `run_started` because `run_started` is the root of the event tree. That root event is not worker execution. Admission is recorded immediately after that root and before any `unit_started`, `tool_request`, `model_request`, `workspace_write`, runtime command, or worker stdout/stderr event.

Required order:

```text
run_started
run_admission_recorded
[only when decision is PASS and the ledger append/flush succeeded]
unit_started
...
run_completed | run_failed
```

Fail-closed order for non-executing decisions:

```text
run_started
run_admission_recorded
run_completed(outcome = cancelled)  # BLOCKED, INSUFFICIENT_EVIDENCE, UNSAFE_TO_RUN
```

A deterministic validation failure that prevents a valid receipt from being built may instead append `run_failed` with a sanitized reason. If the ledger append/flush for `run_admission_recorded` fails, the kernel must not dispatch the worker; failure to record admission is failure to obtain authority.

### Native payload shape

`RunAdmissionRecordedV1` should keep the full receipt as an artifact/CAS object and duplicate a compact gating summary in the event payload:

```rust
pub struct RunAdmissionRecordedV1 {
    pub receipt_id: String,
    pub receipt_digest: String,          // sha256 of canonical full receipt JSON
    pub receipt_ref: Option<String>,     // CAS/artifact ref for the full receipt JSON
    pub idempotency_key: String,
    pub decision: RunAdmissionDecision,
    pub policy_profile_id: String,
    pub requested_side_effects: Vec<String>,
    pub allowed_side_effects: Vec<String>,
    pub denied_side_effects: Vec<RunAdmissionDeniedSideEffectV1>,
    pub missing_evidence: Vec<String>,
    pub unsafe_requests: Vec<String>,
    pub evidence_inputs: Vec<RunAdmissionEvidenceInputV1>,
    pub quarantine: bool,
    pub will_execute_worker: bool,
    pub authorized_next_step: String,
    pub decided_by: String,
    pub decided_at: String,
}
```

The payload must use the same closed decision vocabulary as the receipt: `PASS`, `BLOCKED`, `FAILED`, `INSUFFICIENT_EVIDENCE`, `UNSAFE_TO_RUN`. `will_execute_worker` may be true only for a live `PASS` admission that the kernel will use to dispatch after the event append/flush succeeds. Dry-run commands must keep it false.

`receipt_digest` is not the idempotency key. The digest binds the exact receipt bytes; the idempotency key binds normalized admission inputs so repeated admission with the same inputs can be detected even when `receipt_id` or `decided_at` differ.

### Trust and redaction rules

- Only the kernel/policy layer may construct and append `run_admission_recorded`.
- Worker agents cannot append or mutate admission authority; they can only produce later evidence through bounded runtime channels.
- Raw secrets must never be serialized into the receipt, payload, event summary, terminal errors, or test fixtures. Store `[REDACTED]`, fingerprints, digests, or shape checks instead.
- The event payload must not contain model chain-of-thought, model confidence, unverified worker prose, live credentials, environment dumps, or host/provider conflation.
- Replay may display the event, receipt digest, decision, denied side effects, and cited evidence refs. Replay must not recompute admission, re-grant capabilities, release quarantine, or execute workers.

### Gate semantics

The dispatch gate is the durable event append, not the in-memory decision object. A worker may start only after all are true:

1. required preflight evidence was captured and hashed;
2. the admission receipt was computed by kernel/policy code;
3. `run_admission_recorded` was appended and flushed to the local ledger;
4. the payload decision is `PASS`;
5. requested side effects are within the recorded capability grants;
6. no quarantine/freeze instruction is present.

Any missing condition halts before worker dispatch.

## Capability and side-effect grammar

Capabilities and side effects use scoped strings. Examples:

- `fs.read:repo`
- `fs.write:declared_scope`
- `command.execute:verification`
- `git.commit:local_worktree`
- `git.push:remote`
- `github.pr.create`
- `network.fetch:metadata`
- `deploy:production`

Admission may grant only the smallest set required for the unit. Denied side effects stay in the receipt even when the decision is `PASS`, so reviewers can see that prohibited mutation was considered and refused.

For this local-first slice, safe examples are repo reads, declared docs/fixture writes, verification commands, and local git commits. Unsafe examples are GitHub calls, push, merge, deploy, production mutation, credential mutation, auto-Kanban writes, and undeclared filesystem writes.

## Evidence input rules

Each required evidence input is evaluated before the decision is made. Required evidence includes at least:

1. git worktree status for the requested worktree;
2. base commit and expected remote/ref;
3. declared path scope;
4. requested capability set;
5. operator approval/authority when a side effect requires it;
6. policy result for allowed and denied side effects.

Missing, stale, or contradictory evidence must produce `INSUFFICIENT_EVIDENCE` or `FAILED`, not `PASS`. Unsafe requested side effects must produce `UNSAFE_TO_RUN`, even if the rest of the evidence is present.

## Idempotency

The idempotency key is derived from the admission-relevant normalized input, not from generated text. A recommended v0 key material set is:

```text
run.admission:v0
repo.expected_remote
repo.base_ref
repo.base_commit
repo.worktree_path
run.unit_id
request.requested_capabilities[]
request.requested_side_effects[]
request.declared_scope.allowed_paths[]
evidence_inputs[].digest/status for required inputs
policy.profile_id
```

If any of those inputs change, the key changes and the kernel writes a new admission attempt. Re-running admission with identical normalized inputs should produce the same decision and idempotency key, aside from unique receipt id and timestamp.

## Replay and fork implications

Replay is read-only. It may load and display the receipt, verify its digest/provenance if stored in the ledger/CAS, and explain why admission passed or failed. Replay must not re-run workers, re-grant capabilities, write to GitHub/Kanban, push, deploy, or mutate the filesystem.

Fork starts from a safe unit boundary. A fork must carry the parent `receipt_id` and `idempotency_key` as lineage, then recompute admission if the repo base, worktree, scope, requested capabilities, evidence inputs, or policy profile changed. A fork may not reuse a parent `PASS` to authorize broader side effects.

For `UNSAFE_TO_RUN`, replay/fork surfaces must preserve the quarantine/freeze instruction until an explicit operator authority releases it. The release itself needs a separate receipt; worker claims cannot release quarantine.

## Fixture suite

The initial fixture set lives under `packages/kernel/test/fixtures/admission-receipts/`:

- `pass.json` — enough local evidence exists and only scoped docs/fixture writes plus verification commands are allowed; prohibited network/GitHub/production side effects are denied.
- `insufficient-evidence.json` — the worktree status evidence is missing, so admission fails closed with `INSUFFICIENT_EVIDENCE`.
- `unsafe-to-run.json` — the request asks for push/GitHub/deploy side effects, so admission fails closed with `UNSAFE_TO_RUN` and revokes non-read grants.

These are contract fixtures, not executable dispatch tests. They define the intended shape for future kernel validation without adding a router, swarm, hosted service, worker execution path, GitHub integration, or production mutation.

## BP5B implementation plan

BP5B should implement the ledger event bridge in small, testable slices while preserving dry-run behavior and fail-closed semantics.

### Task 1: Add the native ledger event kind and payload type

**Files:**

- Modify: `native/crates/bp-ledger/src/kind.rs`
- Modify: `native/crates/bp-ledger/src/payload/run_lifecycle.rs`
- Modify: `native/crates/bp-ledger/src/payload/mod.rs`
- Modify: `native/crates/bp-ledger/src/canonicalize.rs`
- Test: existing unit tests in the same files plus `native/crates/bp-ledger/tests/append_only.rs` if an integration sample is useful

**Implementation notes:** add `EventKind::RunAdmissionRecorded`, `RunAdmissionRecordedV1`, `RunAdmissionDecision`, `RunAdmissionEvidenceInputV1`, and `RunAdmissionDeniedSideEffectV1`. Map `run_admission_recorded` to `RunAdmissionRecordedV1` in canonicalization. Add round-trip tests covering a `PASS` payload and an `UNSAFE_TO_RUN` payload with quarantine true.

**Focused verification:**

```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger run_admission
cargo test --manifest-path native/Cargo.toml -p bp-ledger kind::tests::as_wire_matches_serde_output
```

### Task 2: Regenerate and lock TypeScript ledger-client drift fixtures

**Files:**

- Generated: `packages/ledger-client/src/generated/index.ts`
- Modify: `packages/ledger-client/src/payload.ts`
- Generated: `packages/ledger-client/fixtures/payload-variants.json`
- Test: `packages/ledger-client/test/payload-drift.test.ts`

**Implementation notes:** run `pnpm ledger:gen` and `pnpm ledger:gen-fixtures`; add `{ RunAdmissionRecordedV1: RunAdmissionRecordedV1 }` to the hand-written payload union. Update the drift test fixture count from 14 to 15 and assert the new variant is recognized.

**Focused verification:**

```bash
pnpm ledger:gen
pnpm ledger:gen-fixtures
pnpm vitest --run packages/ledger-client/test/payload-drift.test.ts
```

### Task 3: Add a kernel helper that converts receipts into ledger payload summaries

**Files:**

- Modify: `packages/kernel/src/admission-receipts.ts`
- Modify: `packages/kernel/src/index.ts`
- Test: `packages/kernel/test/admission-receipts.test.ts`

**Implementation notes:** add a pure helper such as `createRunAdmissionRecordedPayload(receipt, options)` that computes the canonical receipt digest, carries `receipt_id`, `idempotency_key`, `decision`, policy profile, denied side effects, missing evidence, unsafe requests, evidence refs, quarantine, `will_execute_worker`, and `authorized_next_step`, and rejects any credential-shaped or non-redacted value. Do not append to the ledger in this helper; keep it pure and deterministic.

**Focused verification:**

```bash
pnpm vitest --run packages/kernel/test/admission-receipts.test.ts
```

### Task 4: Record admission before dispatch in the live run path

**Files:**

- Modify: `apps/cli/src/run-cli.ts` or the run command entrypoint that owns packet admission
- Modify: `packages/kernel/src/orchestrator.ts` or `packages/kernel/src/run-loop.ts` only if dispatch currently happens there without a CLI-owned gate
- Add/modify tests: `apps/cli/test/run-cli.test.ts`

**Implementation notes:** preserve the current `admission receipt --dry-run` behavior: dry-run prints the receipt and never creates `.buildplane`, ledger events, or worker execution. For live dispatch, compute the receipt, store full receipt JSON as local evidence/CAS/artifact, append and flush `run_admission_recorded`, then branch: `PASS` continues to worker dispatch under the recorded grants; all other decisions return without calling the orchestrator or PR helpers.

**Focused verification:**

```bash
pnpm vitest --run apps/cli/test/run-cli.test.ts -t "admission"
pnpm vitest --run apps/cli/test/run-cli.test.ts -t "dry-run"
```

Add or preserve assertions that `.buildplane` is not created for dry-run and invalid input, the orchestrator and PR helper mocks are not called for `UNSAFE_TO_RUN`, and credential-shaped values never appear in stdout/stderr/JSON errors.

### Task 5: Surface the event in inspector snapshots without executing it

**Files:**

- Modify: `packages/storage/src/store.ts`
- Modify: `packages/storage/src/run-bundle.ts`
- Test: `packages/storage/test/store.test.ts`
- Test: any existing run-inspector fixture tests under `test/` that assert event-tape shape

**Implementation notes:** teach the read-only inspector/event-tape summary to show `run-admission-recorded` / `run_admission_recorded` as an admission gate event with decision, policy profile, denied side effects, missing evidence, unsafe requests, quarantine, and receipt digest metadata. Inspector replay remains read-only and must not recompute admission.

**Focused verification:**

```bash
pnpm vitest --run packages/storage/test/store.test.ts -t "eventTape"
pnpm vitest --run test/ledger-integration
```

### Task 6: Run the presubmit subset, then the full gate if the subset is clean

**Focused verification:**

```bash
pnpm typecheck
pnpm vitest --run packages/kernel/test/admission-receipts.test.ts packages/ledger-client/test/payload-drift.test.ts apps/cli/test/run-cli.test.ts packages/storage/test/store.test.ts
cargo test --manifest-path native/Cargo.toml -p bp-ledger
pnpm check
```

If `pnpm check` hits the known WSL/Biome/pre-push fragility, keep the focused command outputs and failure text in the handoff instead of broadening scope.

### BP5B out of scope

- No hosted service, swarm router, broad model routing, or autonomous architecture review.
- No GitHub PR creation, push, merge, deploy, production mutation, network grant, or auto-Kanban write from admission.
- No trust in worker prose as admission evidence.
- No replay side effects or quarantine release.
- No credential persistence beyond redacted shape/fingerprint/digest evidence.

## Acceptance criteria for this slice

This docs/fixture slice is complete when:

- the architecture README points to this contract;
- the receipt contract defines run/unit ids, repo/worktree/base commit, requested capabilities, allowed/denied side effects, evidence inputs, admission decision, idempotency, replay/fork implications, and provenance;
- the ledger/run-lifecycle contract names `run_admission_recorded`, defines its pre-dispatch ordering, summarizes the v1 payload fields, and states fail-closed append semantics;
- the BP5B implementation plan lists concrete files, focused tests, and out-of-scope boundaries;
- the decision vocabulary includes `PASS`, `BLOCKED`, `FAILED`, `INSUFFICIENT_EVIDENCE`, and `UNSAFE_TO_RUN`;
- fixtures include fail-closed missing-evidence and unsafe-side-effect examples;
- no code path performs execution, network mutation, GitHub calls, push, deploy, PR, merge, auto-Kanban writes, or real worker dispatch.
