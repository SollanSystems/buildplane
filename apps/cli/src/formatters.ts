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
	readonly strategy?: {
		readonly strategyId: string;
	};
	readonly evidence: readonly {
		readonly kind: string;
		readonly status: string;
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

export function formatInspectDetail(
	snapshot: InspectSnapshotLike,
	_events: ExecutionEventLike[],
	learnings?: readonly StoredLearningLike[],
): string[] {
	const lines: string[] = [];

	lines.push(`kind: ${snapshot.kind}`);
	lines.push(`run-id: ${snapshot.run.id}`);
	lines.push(`unit-id: ${snapshot.run.unitId}`);
	lines.push(`status: ${snapshot.run.status}`);
	if (snapshot.strategy?.strategyId) {
		lines.push(
			`strategy: ${sanitizeTerminalText(snapshot.strategy.strategyId)}`,
		);
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
			lines.push(`workspace-status: ${ws.status}`);
		}
		if (ws.path) {
			lines.push(`workspace: ${ws.path}`);
		}
		if (ws.headSha) {
			lines.push(`workspace-head: ${ws.headSha}`);
		}
		if (ws.finalizedAt) {
			lines.push(`workspace-finalized-at: ${ws.finalizedAt}`);
		}
		if (ws.cleanupError) {
			lines.push(`workspace-cleanup-error: ${ws.cleanupError}`);
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
			lines.push(`failure-kind: ${f.kind}`);
		}
		if (f.message) {
			lines.push(`failure: ${f.message}`);
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
			lines.push(`  [${l.scope}/${l.kind}] ${l.title} (seen: ${l.seenCount})`);
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
