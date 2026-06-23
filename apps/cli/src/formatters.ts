import type { InspectorProjection } from "@buildplane/kernel";

interface ProjectInitializationResult {
	readonly created: boolean;
	readonly projectRoot: string;
	readonly stateDbPath: string;
}

interface RunResultLike {
	readonly run: {
		readonly id: string;
		readonly status: string;
	};
	readonly workspace?: {
		readonly path?: string;
		readonly status?: string;
	};
	readonly injectedMemories?: readonly InjectedMemoryLike[];
}

interface InjectedMemoryLike {
	readonly displayText: string;
	readonly matchReason: string;
	readonly scopePreferenceIndex?: number;
}

interface PromotedStructuredMemoryLike {
	readonly memoryKind: string;
	readonly memoryId: string;
	readonly title: string;
	readonly taskType?: string;
	readonly bodySummary?: string;
	readonly status: string;
	readonly promotionRule?: string;
	readonly sourceRunId?: string;
	readonly sourceTaskId?: string;
	readonly createdAt: string;
}

function sanitizeTerminalText(text: string): string {
	let result = "";
	for (const character of text) {
		const code = character.charCodeAt(0);
		const isControl =
			(code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
		if (!isControl) {
			result += character;
			continue;
		}
		switch (character) {
			case "\n":
				result += "\\n";
				break;
			case "\r":
				result += "\\r";
				break;
			case "\t":
				result += "\\t";
				break;
			default:
				result += `\\u${code.toString(16).padStart(4, "0")}`;
		}
	}
	return result;
}

function formatInjectedMemoryReason(memory: InjectedMemoryLike): string {
	return memory.scopePreferenceIndex === undefined
		? memory.matchReason
		: `${memory.matchReason}, scope-index=${memory.scopePreferenceIndex}`;
}

function summarizeInjectedMemoryForRun(memory: InjectedMemoryLike): string {
	const sanitizedDisplayText = sanitizeTerminalText(memory.displayText);
	const match = sanitizedDisplayText.match(/^(\[[^\]]+\])\s*(.+)$/);
	if (!match) {
		return sanitizedDisplayText;
	}
	const [, prefix, remainder] = match;
	const colonIndex = remainder.indexOf(":");
	const label =
		colonIndex === -1
			? remainder.trim()
			: remainder.slice(0, colonIndex).trim();
	return `${prefix} ${label}`;
}

function formatPromotedStructuredMemory(
	memory: PromotedStructuredMemoryLike,
): string {
	const prefix = `[${sanitizeTerminalText(memory.memoryKind)}]`;
	const title = sanitizeTerminalText(memory.title);
	const bodySummary = memory.bodySummary
		? `: ${sanitizeTerminalText(memory.bodySummary)}`
		: "";
	const details = [`status=${sanitizeTerminalText(memory.status)}`];
	if (memory.promotionRule) {
		details.push(`rule=${sanitizeTerminalText(memory.promotionRule)}`);
	}
	if (memory.sourceTaskId) {
		details.push(`source-task=${sanitizeTerminalText(memory.sourceTaskId)}`);
	}
	return `${prefix} ${title}${bodySummary} (${details.join(", ")})`;
}

export interface CliErrorPayload {
	readonly error: {
		readonly code: string;
		readonly message: string;
	};
}

export function formatInitializationResult(
	result: ProjectInitializationResult,
): string[] {
	return result.created
		? [`initialized: ${result.projectRoot}`]
		: [`already initialized: ${result.projectRoot}`];
}

export function formatRunResult(result: RunResultLike): string[] {
	const r = result as unknown as Record<string, unknown>;
	const hasFailure = r.failure && typeof r.failure === "object";
	const displayStatus = hasFailure ? "failed" : result.run.status;
	const lines = [`run-id: ${result.run.id}`, `status: ${displayStatus}`];
	if (result.workspace?.path) {
		const suffix = result.workspace.status
			? ` (${result.workspace.status})`
			: "";
		lines.push(`workspace: ${result.workspace.path}${suffix}`);
	}
	if (result.injectedMemories && result.injectedMemories.length > 0) {
		lines.push(`injected-memories: ${result.injectedMemories.length}`);
		for (const memory of result.injectedMemories) {
			lines.push(
				`  - ${summarizeInjectedMemoryForRun(memory)} (${formatInjectedMemoryReason(memory)})`,
			);
		}
	}
	return lines;
}

export interface StrategyResultLike {
	readonly strategyId: string;
	readonly mode: string;
	readonly outcome: "passed" | "failed" | "mixed";
	readonly childResults: Map<string, RunResultLike>;
	readonly rounds?: ReadonlyArray<Map<string, RunResultLike>>;
	readonly winnerRunId?: string;
	readonly injectedMemories?: readonly InjectedMemoryLike[];
	readonly mergeDecision: {
		readonly policy: string;
		readonly outcome: string;
		readonly reasons: readonly string[];
	};
}

export function formatStrategyRunResult(result: StrategyResultLike): string[] {
	const lines: string[] = [];
	lines.push(`strategy: ${result.strategyId}`);
	lines.push(`mode: ${result.mode}`);
	lines.push(`outcome: ${result.outcome}`);

	for (const [unitId, childResult] of Array.from(
		result.childResults.entries(),
	)) {
		const role = unitId.endsWith("-reviewer") ? "reviewer" : "implementer";
		lines.push(`  ${role} (${unitId}): ${childResult.run.status}`);
	}

	const roundCount = result.rounds?.length ?? 1;
	if (roundCount > 1) {
		lines.push(`rounds: ${roundCount} — reviewer feedback incorporated`);
	}

	if (result.mergeDecision.reasons.length > 0) {
		lines.push(
			`decision: ${result.mergeDecision.outcome} (${result.mergeDecision.reasons.join("; ")})`,
		);
	}
	if (result.injectedMemories && result.injectedMemories.length > 0) {
		lines.push(`injected-memories: ${result.injectedMemories.length}`);
		for (const memory of result.injectedMemories) {
			lines.push(
				`  - ${summarizeInjectedMemoryForRun(memory)} (${formatInjectedMemoryReason(memory)})`,
			);
		}
	}

	return lines;
}

export function formatJson(value: unknown): string {
	return JSON.stringify(value);
}

export function formatHumanError(message: string): string[] {
	return [message];
}

export function formatJsonError(
	code: string,
	message: string,
): CliErrorPayload {
	return {
		error: {
			code,
			message,
		},
	};
}

interface RunHistoryEntryLike {
	readonly id: string;
	readonly unitId: string;
	readonly status: string;
	readonly strategyId?: string;
	readonly injectedMemoryCount?: number;
	readonly promotedStructuredMemoryCount?: number;
	readonly createdAt: string;
	readonly completedAt?: string;
}

export function formatRunHistory(entries: RunHistoryEntryLike[]): string[] {
	if (entries.length === 0) {
		return ["No runs found."];
	}

	const lines: string[] = [];
	lines.push(
		`${"RUN ID".padEnd(38)} ${"UNIT".padEnd(24)} ${"STATUS".padEnd(10)} ${"STRATEGY".padEnd(24)} ${"MEM".padEnd(8)} CREATED`,
	);
	lines.push("─".repeat(130));

	for (const entry of entries) {
		const created = entry.createdAt.replace("T", " ").slice(0, 19);
		const strategy = (entry.strategyId ?? "-").padEnd(24);
		const memorySummary =
			`mem=${entry.injectedMemoryCount ?? 0}/${entry.promotedStructuredMemoryCount ?? 0}`.padEnd(
				8,
			);
		lines.push(
			`${entry.id.padEnd(38)} ${entry.unitId.padEnd(24)} ${entry.status.padEnd(10)} ${strategy} ${memorySummary} ${created}`,
		);
	}

	return lines;
}

interface WorkspaceSummaryLike {
	readonly runId: string;
	readonly status: string;
	readonly path: string;
	readonly headSha?: string;
	readonly cleanupError?: string;
}

interface WorkflowScanFindingLike {
	readonly path: string;
	readonly source: string;
	readonly kind: string;
}

interface BootstrapDoctorCheckLike {
	readonly id: string;
	readonly ok: boolean;
	readonly message: string;
}

interface BootstrapDoctorReportLike {
	readonly ok: boolean;
	readonly checks: readonly BootstrapDoctorCheckLike[];
	readonly notes: readonly string[];
}

interface CapabilityCheckLike {
	readonly id: string;
	readonly ok: boolean;
	readonly required: boolean;
	readonly available: boolean;
	readonly message: string;
}

interface CapabilityReportLike {
	readonly ok: boolean;
	readonly capabilities: readonly CapabilityCheckLike[];
	readonly notes: readonly string[];
}

export function formatBootstrapDoctorReport(
	report: BootstrapDoctorReportLike,
): string[] {
	const lines = [`bootstrap-doctor: ${report.ok ? "pass" : "fail"}`];
	for (const check of report.checks) {
		lines.push(
			`  - [${check.ok ? "pass" : "fail"}] ${sanitizeTerminalText(check.id)}: ${sanitizeTerminalText(check.message)}`,
		);
	}
	if (report.notes.length > 0) {
		lines.push("notes:");
		for (const note of report.notes) {
			lines.push(`  - ${sanitizeTerminalText(note)}`);
		}
	}
	return lines;
}

export function formatCapabilityReport(report: CapabilityReportLike): string[] {
	const lines = [`capabilities: ${report.ok ? "pass" : "fail"}`];
	for (const capability of report.capabilities) {
		const status = capability.ok ? "pass" : "fail";
		const required = capability.required ? "required" : "optional";
		const availability = capability.available ? "available" : "unavailable";
		lines.push(
			`  - [${status}] ${sanitizeTerminalText(capability.id)} (${required}, ${availability}): ${sanitizeTerminalText(capability.message)}`,
		);
	}
	if (report.notes.length > 0) {
		lines.push("notes:");
		for (const note of report.notes) {
			lines.push(`  - ${sanitizeTerminalText(note)}`);
		}
	}
	return lines;
}

export function formatWorkflowScanPreview(preview: {
	readonly findings: readonly WorkflowScanFindingLike[];
}): string[] {
	const lines = [`workflow-findings: ${preview.findings.length}`];
	for (const finding of preview.findings) {
		lines.push(
			`  - [${sanitizeTerminalText(finding.source)}/${sanitizeTerminalText(finding.kind)}] ${sanitizeTerminalText(finding.path)}`,
		);
	}
	lines.push("preview-only: no workflow data was imported");
	return lines;
}

export function formatWorkspaceList(entries: WorkspaceSummaryLike[]): string[] {
	if (entries.length === 0) {
		return ["No actionable workspaces."];
	}

	const lines: string[] = [];
	lines.push(
		`${"RUN ID".padEnd(38)} ${"STATUS".padEnd(16)} ${"HEAD".padEnd(12)} PATH`,
	);
	lines.push("─".repeat(110));
	for (const entry of entries) {
		lines.push(
			`${entry.runId.padEnd(38)} ${entry.status.padEnd(16)} ${(entry.headSha ?? "-").padEnd(12)} ${entry.path}`,
		);
		if (entry.cleanupError) {
			lines.push(`  cleanup-error: ${entry.cleanupError}`);
		}
	}
	return lines;
}

export function formatWorkspaceCleanupResult(result: {
	readonly runId: string;
	readonly path: string;
	readonly status: string;
	readonly previousStatus: string;
}): string[] {
	return [
		`workspace-cleanup: ${result.status}`,
		`run-id: ${result.runId}`,
		`workspace: ${result.path}`,
		`previous-status: ${result.previousStatus}`,
	];
}

interface ExecutionEventLike {
	readonly kind: string;
	readonly runId: string;
	readonly timestamp: string;
	readonly [key: string]: unknown;
}

interface InspectSnapshotLike {
	readonly kind: string;
	readonly unit: { readonly id: string; readonly kind: string };
	readonly run: {
		readonly id: string;
		readonly unitId: string;
		readonly status: string;
	};
	readonly provenance?: {
		readonly route?: {
			readonly worker?: string;
			readonly source?: string;
			readonly preferredModel?: string;
			readonly effort?: string;
			readonly provider?: string;
			readonly model?: string;
		};
		readonly memory?: {
			readonly injectedCount?: number;
			readonly matchReasons?: readonly string[];
			readonly matchClasses?: readonly string[];
		};
		readonly policy?: {
			readonly profile?: string;
			readonly decisions?: readonly {
				readonly kind?: string;
				readonly outcome?: string;
				readonly reasons?: readonly string[];
			}[];
		};
	};
	readonly strategy?: {
		readonly strategyId: string;
	};
	readonly eventTape?: {
		readonly runId: string;
		readonly eventCount: number;
		readonly firstKind?: string;
		readonly lastKind?: string;
		readonly firstOccurredAt?: string;
		readonly lastOccurredAt?: string;
		readonly terminalStatus?: string;
		readonly kindCounts?: readonly {
			readonly kind: string;
			readonly count: number;
		}[];
		readonly events: readonly {
			readonly id: string;
			readonly kind: string;
			readonly occurredAt: string;
			readonly summary: string;
			readonly metadata?: Readonly<Record<string, string | number | boolean>>;
		}[];
	};
	readonly evidence: readonly {
		readonly kind: string;
		readonly status: string;
		readonly message?: string;
	}[];
	readonly decisions: readonly {
		readonly kind: string;
		readonly outcome: string;
		readonly reasons: readonly string[];
	}[];
	readonly artifacts: readonly {
		readonly type: string;
		readonly location: string;
	}[];
	readonly injectedMemories?: readonly InjectedMemoryLike[];
	readonly promotedStructuredMemories?: readonly PromotedStructuredMemoryLike[];
}

export type { InspectorProjection } from "@buildplane/kernel";
export { createInspectorProjection } from "@buildplane/kernel";

function formatInspectArtifactLine(artifact: {
	readonly type: string;
	readonly location: string;
}): string {
	return `${sanitizeTerminalText(artifact.type)}: ${sanitizeTerminalText(artifact.location)}`;
}

function formatInspectDecisionLine(decision: {
	readonly kind: string;
	readonly outcome: string;
	readonly reasons: readonly string[];
}): string {
	const reasons = decision.reasons.length
		? `: ${sanitizeTerminalText(decision.reasons.join("; "))}`
		: "";
	return `${sanitizeTerminalText(decision.kind)} ${sanitizeTerminalText(decision.outcome)}${reasons}`;
}

function formatInspectEvidenceLine(evidence: {
	readonly kind: string;
	readonly status: string;
	readonly message?: string;
}): string {
	const message = evidence.message
		? `: ${sanitizeTerminalText(evidence.message)}`
		: "";
	return `${sanitizeTerminalText(evidence.kind)} ${sanitizeTerminalText(evidence.status)}${message}`;
}

function clipInspectMetadataText(value: string, maxLength = 80): string {
	return value.length <= maxLength
		? value
		: `${value.slice(0, Math.max(maxLength - 1, 0))}…`;
}

function formatEventTapeMetadata(
	metadata: Readonly<Record<string, string | number | boolean>>,
	maxPairs = 4,
): string {
	const pairs = Object.entries(metadata)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => {
			const normalized =
				typeof value === "string"
					? clipInspectMetadataText(value)
					: String(value);
			return `${sanitizeTerminalText(key)}=${sanitizeTerminalText(normalized)}`;
		});

	if (pairs.length === 0) {
		return "";
	}

	const shown = pairs.slice(0, maxPairs);
	if (pairs.length > maxPairs) {
		shown.push(`+${pairs.length - maxPairs} more`);
	}
	return `[${shown.join(", ")}]`;
}

function formatEventTapeKindCounts(
	kindCounts: readonly { readonly kind: string; readonly count: number }[],
): string {
	return kindCounts
		.map(
			(entry) =>
				`${sanitizeTerminalText(entry.kind)}=${sanitizeTerminalText(String(entry.count))}`,
		)
		.join(", ");
}

export function formatInspectorProjection(
	projection: InspectorProjection,
): string[] {
	const lines: string[] = [];
	lines.push("Run Inspector");
	lines.push(`run-id: ${sanitizeTerminalText(projection.runId)}`);
	lines.push("");
	lines.push("Outcome Strip");
	lines.push(`  verdict: ${projection.outcomeStrip.verdict}`);
	lines.push(
		`  run-status: ${sanitizeTerminalText(projection.outcomeStrip.runStatus)}`,
	);
	lines.push(`  events: ${projection.outcomeStrip.eventCount}`);
	lines.push(`  evidence: ${projection.outcomeStrip.evidenceCount}`);
	lines.push(`  decisions: ${projection.outcomeStrip.decisionCount}`);
	lines.push(`  artifacts: ${projection.outcomeStrip.artifactCount}`);
	lines.push(
		`  missing-evidence: ${projection.outcomeStrip.missingEvidenceCount}`,
	);
	if (projection.outcomeStrip.terminalEventKind) {
		lines.push(
			`  terminal-event: ${sanitizeTerminalText(projection.outcomeStrip.terminalEventKind)}`,
		);
	}
	if (projection.outcomeStrip.failure?.kind) {
		lines.push(
			`  failure-kind: ${sanitizeTerminalText(projection.outcomeStrip.failure.kind)}`,
		);
	}
	if (projection.outcomeStrip.failure?.message) {
		lines.push(
			`  failure: ${sanitizeTerminalText(projection.outcomeStrip.failure.message)}`,
		);
	}
	lines.push("");
	lines.push("Event Timeline");
	if (projection.eventTimeline.length === 0) {
		lines.push("  - missing: no event tape records available");
	} else {
		for (const event of projection.eventTimeline.slice(0, 12)) {
			const formattedMetadata = event.metadata
				? formatEventTapeMetadata(event.metadata)
				: "";
			const metadata = formattedMetadata ? ` ${formattedMetadata}` : "";
			lines.push(
				`  - ${sanitizeTerminalText(event.occurredAt)} ${sanitizeTerminalText(event.kind)} ${sanitizeTerminalText(event.id)}: ${sanitizeTerminalText(event.summary)}${metadata}`,
			);
		}
		const omittedCount = projection.eventTimeline.length - 12;
		if (omittedCount > 0) {
			lines.push(`  - ... ${omittedCount} more events`);
		}
	}
	lines.push("");
	lines.push("Evidence Pane");
	if (
		projection.evidencePane.evidence.length === 0 &&
		projection.evidencePane.decisions.length === 0 &&
		projection.evidencePane.artifacts.length === 0
	) {
		lines.push("  - missing: no evidence, decisions, or artifacts recorded");
	}
	for (const evidence of projection.evidencePane.evidence) {
		lines.push(`  - evidence: ${formatInspectEvidenceLine(evidence)}`);
	}
	for (const decision of projection.evidencePane.decisions) {
		lines.push(`  - decision: ${formatInspectDecisionLine(decision)}`);
	}
	for (const artifact of projection.evidencePane.artifacts) {
		lines.push(`  - artifact: ${formatInspectArtifactLine(artifact)}`);
	}
	if (projection.missingEvidence.length > 0) {
		lines.push("");
		lines.push("Missing Evidence");
		for (const missing of projection.missingEvidence) {
			lines.push(`  - ${sanitizeTerminalText(missing)}`);
		}
	}
	return lines;
}

export function formatInspectDetail(
	snapshot: InspectSnapshotLike,
	_events: ExecutionEventLike[],
	learnings?: readonly StoredLearningLike[],
): string[] {
	const lines: string[] = [];

	lines.push(`kind: ${sanitizeTerminalText(snapshot.kind)}`);
	lines.push(`run-id: ${sanitizeTerminalText(snapshot.run.id)}`);
	lines.push(`unit-id: ${sanitizeTerminalText(snapshot.run.unitId)}`);
	lines.push(`status: ${sanitizeTerminalText(snapshot.run.status)}`);
	if (snapshot.strategy?.strategyId) {
		lines.push(
			`strategy: ${sanitizeTerminalText(snapshot.strategy.strategyId)}`,
		);
	}
	if (snapshot.provenance) {
		const route = snapshot.provenance.route;
		const memory = snapshot.provenance.memory;
		const policy = snapshot.provenance.policy;
		lines.push("");
		lines.push("provenance:");
		if (route?.worker) {
			lines.push(`  route-worker: ${sanitizeTerminalText(route.worker)}`);
		}
		if (route?.source) {
			lines.push(`  route-source: ${sanitizeTerminalText(route.source)}`);
		}
		if (route?.provider) {
			lines.push(`  provider: ${sanitizeTerminalText(route.provider)}`);
		}
		if (route?.model) {
			lines.push(`  model: ${sanitizeTerminalText(route.model)}`);
		}
		if (route?.preferredModel) {
			lines.push(
				`  preferred-model: ${sanitizeTerminalText(route.preferredModel)}`,
			);
		}
		if (route?.effort) {
			lines.push(`  effort: ${sanitizeTerminalText(route.effort)}`);
		}
		if (memory?.injectedCount !== undefined) {
			lines.push(`  memory-injected: ${memory.injectedCount}`);
		}
		if (memory?.matchReasons && memory.matchReasons.length > 0) {
			lines.push(
				`  memory-reasons: ${sanitizeTerminalText(memory.matchReasons.join(", "))}`,
			);
		}
		if (memory?.matchClasses && memory.matchClasses.length > 0) {
			lines.push(
				`  memory-match-classes: ${sanitizeTerminalText(memory.matchClasses.join(", "))}`,
			);
		}
		if (policy?.profile) {
			lines.push(`  policy-profile: ${sanitizeTerminalText(policy.profile)}`);
		}
		if (policy?.decisions && policy.decisions.length > 0) {
			const decisionSummary = policy.decisions
				.map(
					(decision) =>
						`${decision.kind ?? "unknown"}:${decision.outcome ?? "unknown"}`,
				)
				.join(", ");
			lines.push(
				`  policy-decisions: ${sanitizeTerminalText(decisionSummary)}`,
			);
			const policyReasons = [
				...new Set(
					policy.decisions.flatMap((decision) => decision.reasons ?? []),
				),
			];
			if (policyReasons.length > 0) {
				lines.push(
					`  policy-reasons: ${sanitizeTerminalText(policyReasons.join(", "))}`,
				);
			}
		}
	}

	if (snapshot.eventTape) {
		lines.push("");
		lines.push("event-tape:");
		lines.push(`  events: ${snapshot.eventTape.eventCount}`);
		if (snapshot.eventTape.firstKind) {
			lines.push(
				`  first: ${sanitizeTerminalText(snapshot.eventTape.firstKind)}`,
			);
		}
		if (snapshot.eventTape.lastKind) {
			lines.push(
				`  last: ${sanitizeTerminalText(snapshot.eventTape.lastKind)}`,
			);
		}
		if (
			snapshot.eventTape.firstOccurredAt &&
			snapshot.eventTape.lastOccurredAt
		) {
			lines.push(
				`  window: ${sanitizeTerminalText(snapshot.eventTape.firstOccurredAt)} -> ${sanitizeTerminalText(snapshot.eventTape.lastOccurredAt)}`,
			);
		}
		if (
			snapshot.eventTape.kindCounts &&
			snapshot.eventTape.kindCounts.length > 0
		) {
			lines.push(
				`  kinds: ${formatEventTapeKindCounts(snapshot.eventTape.kindCounts)}`,
			);
		}
		if (snapshot.eventTape.terminalStatus) {
			lines.push(
				`  terminal-status: ${sanitizeTerminalText(snapshot.eventTape.terminalStatus)}`,
			);
		}
		const renderedEvents = snapshot.eventTape.events.slice(0, 8);
		for (const event of renderedEvents) {
			const formattedMetadata = event.metadata
				? formatEventTapeMetadata(event.metadata)
				: "";
			const metadata = formattedMetadata ? ` ${formattedMetadata}` : "";
			lines.push(
				`  - ${sanitizeTerminalText(event.kind)} ${sanitizeTerminalText(event.id)}: ${sanitizeTerminalText(event.summary)}${metadata}`,
			);
		}
		const omittedEventCount =
			snapshot.eventTape.eventCount - renderedEvents.length;
		if (omittedEventCount > 0) {
			lines.push(`  - ... ${omittedEventCount} more events`);
		}
	}

	const s = snapshot as unknown as Record<string, unknown>;
	if (s.workspace && typeof s.workspace === "object") {
		const ws = s.workspace as {
			status?: string;
			path?: string;
			headSha?: string;
			existsOnDisk?: boolean;
			finalizedAt?: string;
			cleanupError?: string;
		};
		if (ws.status) {
			lines.push(`workspace-status: ${sanitizeTerminalText(ws.status)}`);
		}
		if (ws.path) {
			lines.push(`workspace: ${sanitizeTerminalText(ws.path)}`);
		}
		if (ws.headSha) {
			lines.push(`workspace-head: ${sanitizeTerminalText(ws.headSha)}`);
		}
		if (ws.finalizedAt) {
			lines.push(
				`workspace-finalized-at: ${sanitizeTerminalText(ws.finalizedAt)}`,
			);
		}
		if (ws.cleanupError) {
			lines.push(
				`workspace-cleanup-error: ${sanitizeTerminalText(ws.cleanupError)}`,
			);
		}
		if (ws.existsOnDisk !== undefined) {
			lines.push(`workspace-exists-on-disk: ${ws.existsOnDisk}`);
		}
		// Diagnostic notes for unusual workspace states
		if (
			ws.status === "active" &&
			s.run &&
			typeof s.run === "object" &&
			(s.run as { status?: string }).status === "passed"
		) {
			lines.push(
				"workspace-note: passed run still reports an active workspace; cleanup may have been interrupted in this thin slice.",
			);
		}
		if (ws.existsOnDisk === false && ws.status === "active") {
			lines.push(
				"workspace-note: last-known workspace path may already be gone on disk despite the persisted active status.",
			);
		}
	}

	if (s.failure && typeof s.failure === "object") {
		const f = s.failure as { kind?: string; message?: string };
		if (f.kind) {
			lines.push(`failure-kind: ${sanitizeTerminalText(f.kind)}`);
		}
		if (f.message) {
			lines.push(`failure: ${sanitizeTerminalText(f.message)}`);
		}
	}

	const hasCausalStory =
		snapshot.evidence.length > 0 ||
		snapshot.decisions.length > 0 ||
		snapshot.artifacts.length > 0 ||
		Boolean(s.failure);
	if (hasCausalStory) {
		lines.push("");
		lines.push("outcome:");
		lines.push(`  status: ${sanitizeTerminalText(snapshot.run.status)}`);
		if (snapshot.evidence.length > 0) {
			lines.push("evidence:");
			for (const evidence of snapshot.evidence) {
				lines.push(`  - ${formatInspectEvidenceLine(evidence)}`);
			}
		}
		if (snapshot.decisions.length > 0) {
			lines.push("decisions:");
			for (const decision of snapshot.decisions) {
				lines.push(`  - ${formatInspectDecisionLine(decision)}`);
			}
		}
		if (snapshot.artifacts.length > 0) {
			lines.push("artifacts:");
			for (const artifact of snapshot.artifacts) {
				lines.push(`  - ${formatInspectArtifactLine(artifact)}`);
			}
		}
	}
	if (snapshot.injectedMemories && snapshot.injectedMemories.length > 0) {
		lines.push("");
		lines.push("injected-memories:");
		for (const memory of snapshot.injectedMemories) {
			lines.push(
				`  ${sanitizeTerminalText(memory.displayText)} (${formatInjectedMemoryReason(memory)})`,
			);
		}
	}
	if (
		snapshot.promotedStructuredMemories &&
		snapshot.promotedStructuredMemories.length > 0
	) {
		lines.push("");
		lines.push("promoted-memories:");
		for (const memory of snapshot.promotedStructuredMemories) {
			lines.push(`  ${formatPromotedStructuredMemory(memory)}`);
		}
	}

	if (learnings && learnings.length > 0) {
		lines.push("");
		lines.push("learnings:");
		for (const l of learnings) {
			lines.push(
				`  [${sanitizeTerminalText(l.scope)}/${sanitizeTerminalText(l.kind)}] ${sanitizeTerminalText(l.title)} (seen: ${l.seenCount})`,
			);
		}
	}

	return lines;
}

interface StoredLearningLike {
	readonly id: string;
	readonly runId: string;
	readonly scope: string;
	readonly kind: string;
	readonly title: string;
	readonly body: string;
	readonly status: string;
	readonly createdAt: string;
	readonly seenCount: number;
}

export function formatLearningsList(
	learnings: readonly StoredLearningLike[],
): string[] {
	if (learnings.length === 0) {
		return ["No learnings found."];
	}

	const lines: string[] = [];
	lines.push(
		`${"ID".padEnd(12)} ${"Scope".padEnd(12)} ${"Kind".padEnd(22)} ${"Seen".padEnd(6)} Title`,
	);
	lines.push("─".repeat(80));

	for (const l of learnings) {
		const shortId = l.id.slice(0, 8);
		lines.push(
			`${shortId.padEnd(12)} ${l.scope.padEnd(12)} ${l.kind.padEnd(22)} ${String(l.seenCount).padEnd(6)} ${l.title}`,
		);
	}

	return lines;
}

export function formatLearningDetail(learning: StoredLearningLike): string[] {
	const lines: string[] = [];
	lines.push(`ID:         ${learning.id}`);
	lines.push(`Title:      ${learning.title}`);
	lines.push(`Scope:      ${learning.scope}`);
	lines.push(`Kind:       ${learning.kind}`);
	lines.push(`Status:     ${learning.status}`);
	lines.push(`Seen:       ${learning.seenCount}`);
	lines.push(`Run:        ${learning.runId}`);
	lines.push(`Created:    ${learning.createdAt}`);
	lines.push("");
	lines.push("Body:");
	lines.push(learning.body);
	return lines;
}

interface RepoFactLike {
	readonly factKey: string;
	readonly scopeType: string;
	readonly valueType: string;
	readonly factValue: unknown;
}

export function formatRepoFactsList(facts: readonly RepoFactLike[]): string[] {
	if (facts.length === 0) {
		return ["No repo facts found."];
	}
	const lines: string[] = [];
	lines.push(
		`${"Key".padEnd(28)} ${"Scope".padEnd(10)} ${"Type".padEnd(8)} Value`,
	);
	lines.push("─".repeat(80));
	for (const f of facts) {
		lines.push(
			`${f.factKey.padEnd(28)} ${f.scopeType.padEnd(10)} ${f.valueType.padEnd(8)} ${String(f.factValue)}`,
		);
	}
	return lines;
}

interface EventListItemLike {
	readonly kind: string;
	readonly runId: string;
	readonly timestamp: string;
}

export function formatEventsList(
	events: readonly EventListItemLike[],
): string[] {
	if (events.length === 0) {
		return ["No events found."];
	}
	const lines: string[] = [];
	lines.push(`${"Timestamp".padEnd(26)} ${"Kind".padEnd(28)} Run`);
	lines.push("─".repeat(80));
	for (const event of events) {
		lines.push(
			`${event.timestamp.padEnd(26)} ${event.kind.padEnd(28)} ${event.runId}`,
		);
	}
	return lines;
}

interface ProcedureLike {
	readonly id: string;
	readonly taskType?: string;
	readonly name: string;
}

export function formatProceduresList(
	procedures: readonly ProcedureLike[],
): string[] {
	if (procedures.length === 0) {
		return ["No procedures found."];
	}
	const lines: string[] = [];
	lines.push(`${"ID".padEnd(12)} ${"Task Type".padEnd(16)} Name`);
	lines.push("─".repeat(80));
	for (const p of procedures) {
		lines.push(
			`${p.id.slice(0, 8).padEnd(12)} ${(p.taskType ?? "-").padEnd(16)} ${p.name}`,
		);
	}
	return lines;
}
