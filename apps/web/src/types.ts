// The three structural types below are mirrored verbatim from
// @buildplane/kernel because apps/web typechecks standalone (`tsc --noEmit`
// with no project references); importing them from the kernel entrypoint drags
// the entire kernel source graph (node: builtins + transitive workspace
// packages) into this program and fails to resolve. Keep these in sync with the
// kernel definitions.

export type RunStatus =
	| "pending"
	| "running"
	| "passed"
	| "failed"
	| "cancelled"
	| "suspended";

export type OperatorDecisionVerdict = "approved" | "rejected";

export type OperatorDecisionSubject = "resume" | "merge";

// mirrors @buildplane/kernel PolicyDecision["kind"] — keep in sync with
// packages/kernel/src/run-loop.ts (ApprovedPolicyDecision | RejectedPolicyDecision | RetryPolicyDecision)
export type PolicyDecisionKind =
	| "advance-run"
	| "reject-run"
	| "architecture.diff_scope"
	| "acceptance.contract"
	| "retry-run";

// mirrors @buildplane/kernel PolicyDecision["outcome"] — keep in sync with
// packages/kernel/src/run-loop.ts
export type PolicyDecisionOutcome = "approved" | "rejected" | "retrying";

export interface RunListItem {
	id: string;
	unitId: string;
	status: RunStatus;
}

// mirrors @buildplane/kernel InspectorProjection — keep in sync
export interface InspectorProjection {
	kind: "run-inspector";
	runId: string;
	outcomeStrip: {
		verdict: "PASSED" | "BLOCKED" | "FAILED" | "CANCELLED" | "UNKNOWN";
		runStatus: string;
		terminalEventKind?: string;
		eventCount: number;
		evidenceCount: number;
		decisionCount: number;
		artifactCount: number;
		missingEvidenceCount: number;
		failure?: { kind?: string; message?: string };
	};
	eventTimeline: readonly {
		id: string;
		kind: string;
		occurredAt: string;
		summary: string;
		metadata?: Readonly<Record<string, string | number | boolean>>;
	}[];
	evidencePane: {
		evidence: readonly {
			id: string;
			kind: string;
			status: string;
			message?: string;
		}[];
		decisions: readonly {
			id: string;
			kind: PolicyDecisionKind;
			outcome: PolicyDecisionOutcome;
			reasons: readonly string[];
		}[];
		artifacts: readonly { id: string; type: string; location: string }[];
	};
	provenance?: {
		route: {
			worker: string;
			source: "routing-hints" | "model-block" | "command-block";
			preferredModel?: string;
			effort?: string;
			provider?: string;
			model?: string;
		};
		memory?: {
			injectedCount: number;
			matchReasons: readonly string[];
			matchClasses: readonly string[];
		};
		policy: {
			profile: string;
			decisions?: readonly {
				kind: PolicyDecisionKind;
				outcome: PolicyDecisionOutcome;
				reasons: readonly string[];
			}[];
		};
	};
	missingEvidence: readonly string[];
}

// mirrors @buildplane/kernel PendingOperatorDecision — keep in sync
export interface PendingOperatorDecision {
	runId: string;
	subject: "resume" | "merge";
	since: string;
}

// mirrors @buildplane/kernel StatusSnapshot — keep in sync
export interface StatusSnapshot {
	initialized: boolean;
	latestRun?: {
		id: string;
		unitId: string;
		status: RunStatus;
	};
	runCounts: {
		pending: number;
		running: number;
		passed: number;
		failed: number;
		cancelled: number;
		suspended: number;
	};
}
