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
	return [`run-id: ${result.run.id}`, `status: ${result.run.status}`];
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
	events: ExecutionEventLike[],
): string[] {
	const lines: string[] = [];

	// Header
	lines.push(`Run: ${snapshot.run.id}`);
	lines.push(`Unit: ${snapshot.unit.id} (${snapshot.unit.kind})`);
	lines.push(`Status: ${snapshot.run.status}`);
	lines.push("");

	// Model response
	const modelComplete = events.find(
		(e) => e.kind === "model-response-complete",
	);
	if (modelComplete && typeof modelComplete.text === "string") {
		lines.push("── Model Response ──");
		lines.push(modelComplete.text);
		if (modelComplete.finishReason) {
			lines.push(`  finish: ${modelComplete.finishReason}`);
		}
		if (
			modelComplete.usage &&
			typeof modelComplete.usage === "object" &&
			modelComplete.usage !== null
		) {
			const u = modelComplete.usage as {
				promptTokens?: number;
				completionTokens?: number;
			};
			if (u.promptTokens !== undefined) {
				lines.push(
					`  tokens: ${u.promptTokens} prompt + ${u.completionTokens} completion`,
				);
			}
		}
		lines.push("");
	}

	// Tool calls
	const toolStarts = events.filter((e) => e.kind === "tool-call-started");
	const toolCompletes = events.filter((e) => e.kind === "tool-call-completed");
	if (toolStarts.length > 0) {
		lines.push("── Tool Calls ──");
		for (const tc of toolStarts) {
			const name = tc.toolName as string;
			const id = tc.toolCallId as string;
			const args = tc.args ? JSON.stringify(tc.args) : "{}";
			const completed = toolCompletes.find((c) => c.toolCallId === id);
			const result = completed?.result;
			lines.push(`  ${name} (${id})`);
			lines.push(`    args: ${args}`);
			if (result !== undefined) {
				const resultStr =
					typeof result === "string" ? result : JSON.stringify(result);
				lines.push(`    result: ${resultStr}`);
			}
		}
		lines.push("");
	}

	// Evidence
	if (snapshot.evidence.length > 0) {
		lines.push("── Evidence ──");
		for (const ev of snapshot.evidence) {
			lines.push(`  ${ev.kind}: ${ev.status}`);
		}
		lines.push("");
	}

	// Decisions
	if (snapshot.decisions.length > 0) {
		lines.push("── Policy ──");
		for (const d of snapshot.decisions) {
			lines.push(`  ${d.kind}: ${d.outcome}`);
			for (const reason of d.reasons) {
				lines.push(`    - ${reason}`);
			}
		}
		lines.push("");
	}

	// Artifacts
	if (snapshot.artifacts.length > 0) {
		lines.push("── Artifacts ──");
		for (const a of snapshot.artifacts) {
			lines.push(`  ${a.type}: ${a.location}`);
		}
		lines.push("");
	}

	return lines;
}
