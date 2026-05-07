# PlanForge architecture contract

## Status

Proposed local-first contract for PF1. This document defines the planning artifacts and safety boundaries for later PlanForge implementation slices. It is intentionally documentation and fixture only; it does not add a CLI command, execution path, storage writer, hosted service, router, swarm, or Kanban mutation.

## Product sentence

PlanForge is Buildplane's trusted plan-admission surface: it converts an operator goal or spec into a reviewable implementation plan, task graph, and admission receipt before any worker receives write capabilities.

## Boundary model

PlanForge belongs on the trusted Buildplane/kernel side of the system. It may parse operator intent, normalize a proposed plan, validate safety constraints, and emit deterministic review artifacts. The Buildplane kernel remains the authority that validates and admits the plan.

Coding agents remain untrusted workers. They may help draft candidate prose or implementation details, but their output is untrusted input until the kernel validates it and records a receipt. A PlanForge receipt is not merge approval, deploy approval, or permission for a worker to write outside the admitted envelope.

## Non-goals for PF1

PF1 must not implement:

- code execution
- worker spawn, swarm routing, or hosted service behavior
- automatic Kanban, GSD2, GitHub, network, push, PR, deploy, or merge side effects
- mutable project state writes beyond explicit local fixture/doc artifacts in this repository
- LLM-only approval semantics
- broad policy/capability expansion beyond the fields named here

## Dry-run contract

Every PlanForge behavior described here is dry-run by default. A dry run may read the operator-provided input and repo metadata needed for deterministic validation. It must not create tasks, grant capabilities, start agents, push commits, call hosted APIs, open PRs, deploy, or modify board state.

Later implementation slices may write local receipt artifacts only when the command name and destination make that write explicit. Even then, the receipt records admission evidence; it does not execute the admitted plan.

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

`idempotencyKey` is derived from the normalized input goal, trusted base, repository remote, dry-run constraints, and evidence references. Repeating the same input at the same trusted base with the same evidence set must produce the same key and the same stable plan identifiers.

If the same key is submitted again with byte-identical normalized input, PlanForge should return the prior equivalent plan/receipt or deterministically regenerate an equivalent dry-run artifact. If the same key is reused with conflicting normalized input, validation must fail closed with `FAILED` or `UNSAFE_TO_RUN` and must not overwrite prior evidence. If the trusted base changes, the key changes unless the operator explicitly asks to re-plan against the new base.

## Admission semantics

A `PASS` receipt means only that the plan artifact is eligible for human or kernel admission review. It does not create Kanban tasks, open write access, start workers, or certify implementation correctness. The next trusted component must still decide whether to admit the plan, materialize tasks, and grant scoped capabilities.

`BLOCKED`, `FAILED`, `INSUFFICIENT_EVIDENCE`, and `UNSAFE_TO_RUN` receipts must be visible to the operator and downstream reviewers. They must preserve enough evidence references for diagnosis while avoiding secrets and raw credential material.
