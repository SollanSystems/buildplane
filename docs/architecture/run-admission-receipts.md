# Run Admission Receipt Contract

**Date:** 2026-05-08
**Status:** Docs/fixture contract for deterministic local run admission
**Scope:** Kernel-owned admission decision before worker execution; no execution implementation in this slice

## Decision

Buildplane run admission produces a deterministic receipt before a unit is allowed to execute. The receipt binds the run/unit identifiers, repo and worktree authority, requested capabilities, allowed and denied side effects, evidence inputs, admission decision, idempotency key, replay/fork implications, and provenance into one local-first record.

The receipt is an admission record, not an execution result. `PASS` means the trusted kernel found enough local evidence to admit a bounded run under explicit capability grants. It does not mean the run succeeded, tests passed, a PR is ready, or a worker claim should be trusted.

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

These are contract fixtures, not executable tests yet. They define the intended shape for future kernel validation without adding a router, swarm, hosted service, worker execution path, GitHub integration, or production mutation.

## Acceptance criteria for this slice

This docs/fixture slice is complete when:

- the architecture README points to this contract;
- the receipt contract defines run/unit ids, repo/worktree/base commit, requested capabilities, allowed/denied side effects, evidence inputs, admission decision, idempotency, replay/fork implications, and provenance;
- the decision vocabulary includes `PASS`, `BLOCKED`, `FAILED`, `INSUFFICIENT_EVIDENCE`, and `UNSAFE_TO_RUN`;
- fixtures include fail-closed missing-evidence and unsafe-side-effect examples;
- no code path performs execution, network mutation, GitHub calls, push, deploy, PR, merge, auto-Kanban writes, or real worker dispatch.
