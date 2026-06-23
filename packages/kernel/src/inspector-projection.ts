import type { InspectSnapshot } from "./run-loop.js";

export interface InspectorProjection {
	readonly kind: "run-inspector";
	readonly runId: string;
	readonly outcomeStrip: {
		readonly verdict: "PASSED" | "BLOCKED" | "FAILED" | "CANCELLED" | "UNKNOWN";
		readonly runStatus: string;
		readonly terminalEventKind?: string;
		readonly eventCount: number;
		readonly evidenceCount: number;
		readonly decisionCount: number;
		readonly artifactCount: number;
		readonly missingEvidenceCount: number;
		readonly failure?: {
			readonly kind?: string;
			readonly message?: string;
		};
	};
	readonly eventTimeline: readonly {
		readonly id: string;
		readonly kind: string;
		readonly occurredAt: string;
		readonly summary: string;
		readonly metadata?: Readonly<Record<string, string | number | boolean>>;
	}[];
	readonly evidencePane: {
		readonly evidence: InspectSnapshot["evidence"];
		readonly decisions: InspectSnapshot["decisions"];
		readonly artifacts: InspectSnapshot["artifacts"];
	};
	readonly provenance: InspectSnapshot["provenance"];
	readonly missingEvidence: readonly string[];
}

function inspectFailure(snapshot: InspectSnapshot):
	| {
			readonly kind?: string;
			readonly message?: string;
	  }
	| undefined {
	const failure = (snapshot as unknown as { failure?: unknown }).failure;
	if (!failure || typeof failure !== "object") {
		return undefined;
	}
	const record = failure as { kind?: string; message?: string };
	return {
		kind: record.kind,
		message: record.message,
	};
}

function evidenceIsPassing(status: string): boolean {
	return ["pass", "passed", "approved", "ok", "success"].includes(
		status.toLowerCase(),
	);
}

function createMissingEvidence(snapshot: InspectSnapshot): readonly string[] {
	const missing: string[] = [];
	const failure = inspectFailure(snapshot);
	for (const evidence of snapshot.evidence) {
		if (!evidenceIsPassing(evidence.status)) {
			missing.push(
				evidence.message
					? `${evidence.kind}: ${evidence.message}`
					: `${evidence.kind}: ${evidence.status}`,
			);
		}
	}
	for (const decision of snapshot.decisions) {
		if (["rejected", "blocked", "deferred"].includes(decision.outcome)) {
			missing.push(
				decision.reasons.length > 0
					? `${decision.kind}: ${decision.reasons.join("; ")}`
					: `${decision.kind}: ${decision.outcome}`,
			);
		}
	}
	if (!snapshot.eventTape) {
		missing.push("event-tape: missing");
	}
	if (failure?.message) {
		missing.push(`failure: ${failure.message}`);
	}
	return [...new Set(missing)];
}

function createInspectorVerdict(
	snapshot: InspectSnapshot,
	missingEvidence: readonly string[],
): InspectorProjection["outcomeStrip"]["verdict"] {
	const status = snapshot.run.status.toLowerCase();
	if (status === "failed") return "FAILED";
	if (status === "cancelled") return "CANCELLED";
	if (status === "suspended") return "BLOCKED";
	if (missingEvidence.length > 0) return "BLOCKED";
	if (status === "passed") {
		const hasSupport =
			snapshot.evidence.some((evidence) =>
				evidenceIsPassing(evidence.status),
			) ||
			snapshot.decisions.some((decision) => decision.outcome === "approved") ||
			snapshot.eventTape?.terminalStatus === "passed" ||
			snapshot.artifacts.length > 0;
		return hasSupport ? "PASSED" : "UNKNOWN";
	}
	return "UNKNOWN";
}

export function createInspectorProjection(
	snapshot: InspectSnapshot,
): InspectorProjection {
	const missingEvidence = createMissingEvidence(snapshot);
	return {
		kind: "run-inspector",
		runId: snapshot.run.id,
		outcomeStrip: {
			verdict: createInspectorVerdict(snapshot, missingEvidence),
			runStatus: snapshot.run.status,
			terminalEventKind: snapshot.eventTape?.lastKind,
			eventCount: snapshot.eventTape?.eventCount ?? 0,
			evidenceCount: snapshot.evidence.length,
			decisionCount: snapshot.decisions.length,
			artifactCount: snapshot.artifacts.length,
			missingEvidenceCount: missingEvidence.length,
			failure: inspectFailure(snapshot),
		},
		eventTimeline: snapshot.eventTape?.events ?? [],
		evidencePane: {
			evidence: snapshot.evidence,
			decisions: snapshot.decisions,
			artifacts: snapshot.artifacts,
		},
		provenance: snapshot.provenance,
		missingEvidence,
	};
}
