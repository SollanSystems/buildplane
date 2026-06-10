# PlanForge architecture contract

## Status

PlanForge M2 (admit cycle) is implemented on the Buildplane kernel/CLI path documented here. Dry-run review (`compile → validate → preview`) remains side-effect-free; operator-gated `admit`, `dispatch`, `resume`, and signed ledger events implement the durable admit→execute→receipt cycle.

Implemented now (M2):

- `planforge dry-run --input <file> --json` — deterministic compile/validate/preview artifact (`@buildplane/planforge`)
- `planforge admit --input <file> --approve --operator <id>` — signed `plan_admitted` on the ledger tape
- `planforge dispatch --input <file>` — executes admitted plan tasks, brackets activities, emits `plan_receipt`
- `planforge resume --input <file>` — **explicit-input** recovery (Gate C Path i): replays signed admission, skips durable recorded activities, executes suffix only, emits missing receipt
- `ledger export-signed-tape` + `scripts/verify-signed-tape.mjs` — external verification of exported cycles
- Rust `bp-replay` transitions for plan/activity/receipt kinds (deterministic replay state)

Explicitly not implemented (post-M2 / out of scope):

- board writes, GSD2/Kanban materialization, GitHub writes, push/PR/merge/deploy automation
- kernel orchestrator **startup-scan** auto-resume (M2-S7b phase 2b waived per Gate C Path i)
- hosted PlanForge service behavior
- memory outcome routing (frozen until post-M2-GATE)

Legacy dry-run-only notes below remain accurate for the **dry-run** command boundary; they do not describe the admitted execution path.

## Product sentence

PlanForge is Buildplane's trusted plan-admission surface: it converts an operator goal or spec into a reviewable implementation plan, task graph, and admission receipt before any worker receives write capabilities.

## Boundary model

PlanForge belongs on the trusted Buildplane/kernel side of the system. It may parse operator intent, normalize a proposed plan, validate safety constraints, and emit deterministic review artifacts. The Buildplane kernel remains the authority that validates and admits the plan.

Coding agents remain untrusted workers. They may help draft candidate prose or implementation details, but their output is untrusted input until the kernel validates it and records a receipt. A PlanForge receipt is not merge approval, deploy approval, or permission for a worker to write outside the admitted envelope.

## Non-goals for PF1

The dry-run command exists, but PF1/PF2 still must not implement non-dry-run admission or materialization. PlanForge must not implement:

- code execution
- worker spawn, worker dispatch, swarm routing, or hosted service behavior
- automatic Kanban, GSD2, GitHub, network, push, PR, deploy, or merge side effects
- board writes, `.gsd` task writes, GitHub artifact writes, or ledger/state writes
- durable receipt writes beyond the JSON receipt preview returned by dry-run output
- LLM-only approval semantics
- broad policy/capability expansion beyond the fields named here

## Dry-run contract

The implemented PlanForge command is dry-run only. A dry run may read the operator-provided input and repo metadata needed for deterministic validation. It must not create tasks, grant capabilities, start agents, push commits, call hosted APIs, open PRs, deploy, modify board state, create worktrees, create GitHub artifacts, or write ledger/project state.

Later implementation slices may write local receipt artifacts only when a separate command name and destination make that write explicit and the operator has approved that path. Even then, the receipt records admission evidence; it does not execute the admitted plan.

## Machine-parseable invocation

The canonical machine-parseable invocation is the direct source CLI command run from the repository root:

```sh
node --conditions=source --import tsx ./apps/cli/src/index.ts planforge dry-run --input apps/cli/test/fixtures/planforge/goal-input.md --json
```

Machine consumers should prefer this direct command for JSON parsing. Raw `pnpm run` output may include package-manager lifecycle headers or other wrapper text; if a wrapper is used, consumers must first verify that it suppresses lifecycle output and emits only the PlanForge JSON document.

## Supported input shape

The current parser/validator is intentionally strict and is not a natural-language-tolerant planner. It expects the documented Markdown template shape used by `apps/cli/test/fixtures/planforge/goal-input.md`:

```md
# PlanForge dry-run goal fixture

## Goal

<one operator goal paragraph>

## Repository context

- Remote: <repository remote URL>
- Trusted base: <trusted base commit SHA>
- Worktree policy: isolated-worktree-required

## Safety constraints

- Dry-run only.
- Buildplane kernel validates and admits plans.
- Coding agents are untrusted workers.
- No Kanban, GSD2, GitHub, network, push, PR, deploy, merge, or worker-spawn side effects.
```

The validator treats the goal, repository remote, trusted base, worktree policy, and safety constraints as required evidence. Missing or misplaced evidence fails closed with `INSUFFICIENT_EVIDENCE`, not approval. Unsupported side-effect requests fail closed with `UNSAFE_TO_RUN`, not approval. Broad natural-language parsing and section inference are out of scope for the current dry-run implementation.

## Status vocabulary

PlanForge uses a small shared status vocabulary for validation and receipts:

- `PASS`: deterministic checks passed for the bounded planning artifact.
- `BLOCKED`: a required human decision, credential, source artifact, or upstream review is missing.
- `FAILED`: deterministic validation found a malformed input, schema mismatch, or non-safety runtime failure.
- `INSUFFICIENT_EVIDENCE`: the plan cannot be admitted because required evidence is absent or too weak.
- `UNSAFE_TO_RUN`: the requested plan would violate safety policy, grant excessive capabilities, perform forbidden side effects, or target an untrusted/stale base.

`PASS` is the only status that can make a plan eligible for admission. All other statuses fail closed and must not grant write capabilities.

## Contracts

The TypeScript below is a documentation-level contract. PF1 does not add exported runtime types.

```ts
type PlanForgeStatus =
  | "PASS"
  | "BLOCKED"
  | "FAILED"
  | "INSUFFICIENT_EVIDENCE"
  | "UNSAFE_TO_RUN";

interface PlanForgeInput {
  readonly schemaVersion: "planforge.input.v0";
  readonly goal: string;
  readonly requester?: string;
  readonly repository: {
    readonly remote: string;
    readonly trustedBase: string;
    readonly worktreePolicy: "isolated-worktree-required";
  };
  readonly constraints: {
    readonly dryRun: true;
    readonly localFirst: true;
    readonly noNetworkSideEffects: true;
    readonly noBoardWrites: true;
    readonly noPushDeployMerge: true;
  };
  readonly evidence: readonly PlanForgeEvidenceRef[];
  readonly idempotencyKey: string;
}

interface PlanForgeEvidenceRef {
  readonly kind:
    | "operator_goal"
    | "repo_state"
    | "planning_artifact"
    | "review_note"
    | "fixture";
  readonly uri: string;
  readonly sha256?: string;
  readonly summary?: string;
}

interface PlanForgePlan {
  readonly schemaVersion: "planforge.plan.v0";
  readonly id: string;
  readonly idempotencyKey: string;
  readonly title: string;
  readonly goal: string;
  readonly trustedBase: string;
  readonly tasks: readonly PlanForgeTask[];
  readonly validation: PlanForgeValidation;
  readonly receiptPreview: PlanForgeReceipt;
}

interface PlanForgeTask {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly assigneeHint: string;
  readonly workspace: "isolated-worktree" | "scratch" | "read-only-review";
  readonly dependsOn: readonly string[];
  readonly allowedSideEffects: readonly ("local-doc" | "local-fixture" | "local-receipt")[];
  readonly forbiddenSideEffects: readonly (
    | "execute-code"
    | "board-write"
    | "network-write"
    | "push"
    | "deploy"
    | "merge"
  )[];
  readonly acceptanceCriteria: readonly string[];
  readonly verificationCommands: readonly string[];
}

interface PlanForgeValidation {
  readonly status: PlanForgeStatus;
  readonly checks: readonly PlanForgeValidationCheck[];
  readonly requiredEvidence: readonly string[];
  readonly missingEvidence: readonly string[];
  readonly unsafeReasons: readonly string[];
}

interface PlanForgeValidationCheck {
  readonly id: string;
  readonly status: PlanForgeStatus;
  readonly message: string;
  readonly evidenceRefs: readonly string[];
}

interface PlanForgeReceipt {
  readonly schemaVersion: "planforge.receipt.v0";
  readonly status: PlanForgeStatus;
  readonly planId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly planDigest: string;
  readonly trustedBase: string;
  readonly admittedBy: "buildplane-kernel";
  readonly generatedAt: string;
  readonly dryRun: true;
  readonly sideEffects: readonly [];
  readonly notes: readonly string[];
}
```

## Idempotency semantics

`inputDigest` is content-based: it is derived from the canonicalized input file content. `idempotencyKey` binds the normalized input goal plus trusted base, repository remote, dry-run constraints, and evidence references. Repeating the same input at the same trusted base with the same evidence set must produce the same key and the same stable plan identifiers.

Evidence references currently include local input-file basename anchors such as `goal-input.md#safety-constraints`. A byte-identical copied file may keep the same `inputDigest` but produce a different `idempotencyKey` if its evidence references change. This is intentional: the key identifies the reviewed evidence bundle, not only the goal text bytes.

If the same key is submitted again with byte-identical normalized input, PlanForge should return the prior equivalent plan/receipt or deterministically regenerate an equivalent dry-run artifact. If the same key is reused with conflicting normalized input, validation must fail closed with `FAILED` or `UNSAFE_TO_RUN` and must not overwrite prior evidence. If the trusted base changes, the key changes unless the operator explicitly asks to re-plan against the new base.

## PlanForge versus GSD2/Kanban boundary

PlanForge emits review artifacts. GSD2 and Kanban are materialization/admission surfaces, not side effects of `planforge dry-run`.

Task-like entries, assignee hints, workspace hints, dependencies, acceptance criteria, and verification commands in the PlanForge JSON are proposed units for review only. During dry-run they do not create `.gsd` tasks, Kanban cards, worktrees, workers, GitHub artifacts, or ledger state.

Any future materializer must be a separate command with an explicit operator approval gate and a fail-closed receipt. `planforge dry-run` must remain side-effect-free.

## Admission semantics

A `PASS` receipt means only that the plan artifact is eligible for human or kernel admission review. It does not create Kanban tasks, open write access, start workers, or certify implementation correctness. The next trusted component must still decide whether to admit the plan, materialize tasks, and grant scoped capabilities.

`BLOCKED`, `FAILED`, `INSUFFICIENT_EVIDENCE`, and `UNSAFE_TO_RUN` receipts must be visible to the operator and downstream reviewers. They must preserve enough evidence references for diagnosis while avoiding secrets and raw credential material.
