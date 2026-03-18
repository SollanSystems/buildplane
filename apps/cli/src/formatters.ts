interface ProjectInitializationResult {
	readonly created: boolean;
	readonly projectRoot: string;
	readonly stateDbPath: string;
}

interface RunWorkspaceLike {
	readonly path: string;
	readonly status: "active" | "deleted" | "retained" | "cleanup-failed";
	readonly headSha: string;
	readonly finalizedAt?: string;
	readonly cleanupError?: string;
	readonly existsOnDisk?: boolean;
}

interface RunResultLike {
	readonly run: {
		readonly id: string;
		readonly status: string;
	};
	readonly failure?: {
		readonly kind: string;
		readonly message: string;
	};
	readonly workspace?: RunWorkspaceLike;
}

interface StatusWorkspaceLike {
	readonly path?: string;
	readonly status: "active" | "deleted" | "retained" | "cleanup-failed";
}

interface StatusResultLike {
	readonly initialized: boolean;
	readonly latestRun?: {
		readonly id: string;
		readonly unitId: string;
		readonly status: string;
	};
	readonly latestWorkspace?: StatusWorkspaceLike;
	readonly actionableWorkspaces: readonly unknown[];
	readonly runCounts: {
		readonly pending: number;
		readonly running: number;
		readonly passed: number;
		readonly failed: number;
		readonly cancelled: number;
	};
}

interface InspectResultLike {
	readonly kind: string;
	readonly unit: {
		readonly id: string;
	};
	readonly run: {
		readonly id: string;
		readonly status: string;
	};
	readonly workspace?: RunWorkspaceLike;
	readonly runHistory: readonly {
		readonly id: string;
		readonly status: string;
	}[];
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
	const displayedStatus = result.failure ? "failed" : result.run.status;
	const lines = [`run-id: ${result.run.id}`, `status: ${displayedStatus}`];

	if (shouldSurfaceRunWorkspace(result)) {
		lines.push(`workspace: ${result.workspace.path}`);
	}

	return lines;
}

export function formatRunFailure(result: RunResultLike): string[] {
	return result.failure ? [result.failure.message] : [];
}

export function formatStatusResult(result: StatusResultLike): string[] {
	const lines = [`initialized: ${result.initialized}`];

	if (result.latestRun) {
		lines.push(
			`latest-run: ${result.latestRun.id} ${result.latestRun.status} (${result.latestRun.unitId})`,
		);
	} else {
		lines.push("latest-run: none");
	}

	lines.push(
		`run-counts: pending=${result.runCounts.pending} running=${result.runCounts.running} passed=${result.runCounts.passed} failed=${result.runCounts.failed} cancelled=${result.runCounts.cancelled}`,
	);

	if (shouldSurfaceStatusWorkspace(result.latestWorkspace)) {
		lines.push(
			`workspace: ${result.latestWorkspace.path} (${result.latestWorkspace.status})`,
		);
	}

	if (result.actionableWorkspaces.length > 0) {
		lines.push(`actionable-workspaces: ${result.actionableWorkspaces.length}`);
	}

	return lines;
}

export function formatInspectResult(result: InspectResultLike): string[] {
	const lines = [
		`kind: ${result.kind}`,
		`run-id: ${result.run.id}`,
		`unit-id: ${result.unit.id}`,
		`status: ${result.run.status}`,
	];

	if (result.workspace) {
		lines.push(`workspace-status: ${result.workspace.status}`);
		lines.push(`workspace: ${result.workspace.path}`);
		lines.push(`workspace-head: ${result.workspace.headSha}`);

		if (result.workspace.finalizedAt) {
			lines.push(`workspace-finalized-at: ${result.workspace.finalizedAt}`);
		}

		if (result.workspace.cleanupError) {
			lines.push(`workspace-cleanup-error: ${result.workspace.cleanupError}`);
		}

		if (result.workspace.existsOnDisk !== undefined) {
			lines.push(`workspace-exists-on-disk: ${result.workspace.existsOnDisk}`);
		}

		if (
			result.run.status === "passed" &&
			result.workspace.status === "active"
		) {
			lines.push(
				"workspace-note: passed run still reports an active workspace; cleanup may have been interrupted in this thin slice.",
			);
		}

		if (
			result.workspace.status === "active" &&
			result.workspace.existsOnDisk === false
		) {
			lines.push(
				"workspace-note: last-known workspace path may already be gone on disk despite the persisted active status.",
			);
		}
	}

	if (result.runHistory.length > 0) {
		lines.push("run-history:");
		for (const entry of result.runHistory) {
			lines.push(`- ${entry.id} ${entry.status}`);
		}
	}

	if (result.evidence.length > 0) {
		lines.push("evidence:");
		for (const evidence of result.evidence) {
			lines.push(
				evidence.message
					? `- ${evidence.kind} [${evidence.status}] ${evidence.message}`
					: `- ${evidence.kind} [${evidence.status}]`,
			);
		}
	}

	if (result.decisions.length > 0) {
		lines.push("decisions:");
		for (const decision of result.decisions) {
			lines.push(
				`- ${decision.kind} [${decision.outcome}] ${decision.reasons.join("; ")}`,
			);
		}
	}

	if (result.artifacts.length > 0) {
		lines.push("artifacts:");
		for (const artifact of result.artifacts) {
			lines.push(`- ${artifact.type} ${artifact.location}`);
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

function shouldSurfaceRunWorkspace(
	result: RunResultLike,
): result is RunResultLike & { workspace: RunWorkspaceLike } {
	return Boolean(
		result.workspace?.path &&
			(result.workspace.status === "retained" ||
				result.workspace.status === "cleanup-failed"),
	);
}

function shouldSurfaceStatusWorkspace(
	workspace: StatusWorkspaceLike | undefined,
): workspace is StatusWorkspaceLike & { path: string } {
	return Boolean(
		workspace?.path &&
			(workspace.status === "active" ||
				workspace.status === "retained" ||
				workspace.status === "cleanup-failed"),
	);
}
