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
	return lines;
}

export interface StrategyResultLike {
	readonly strategyId: string;
	readonly mode: string;
	readonly outcome: "passed" | "failed" | "mixed";
	readonly childResults: Map<string, RunResultLike>;
	readonly rounds?: ReadonlyArray<Map<string, RunResultLike>>;
	readonly winnerRunId?: string;
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

	for (const [unitId, childResult] of result.childResults) {
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
	readonly createdAt: string;
	readonly completedAt?: string;
}

export function formatRunHistory(entries: RunHistoryEntryLike[]): string[] {
	if (entries.length === 0) {
		return ["No runs found."];
	}

	const lines: string[] = [];
	lines.push(
		`${"RUN ID".padEnd(38)} ${"UNIT".padEnd(24)} ${"STATUS".padEnd(10)} CREATED`,
	);
	lines.push("─".repeat(90));

	for (const entry of entries) {
		const created = entry.createdAt.replace("T", " ").slice(0, 19);
		lines.push(
			`${entry.id.padEnd(38)} ${entry.unitId.padEnd(24)} ${entry.status.padEnd(10)} ${created}`,
		);
	}

	return lines;
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
}

export function formatInspectDetail(
	snapshot: InspectSnapshotLike,
	_events: ExecutionEventLike[],
): string[] {
	const lines: string[] = [];

	lines.push(`kind: ${snapshot.kind}`);
	lines.push(`run-id: ${snapshot.run.id}`);
	lines.push(`unit-id: ${snapshot.run.unitId}`);
	lines.push(`status: ${snapshot.run.status}`);

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

	return lines;
}
