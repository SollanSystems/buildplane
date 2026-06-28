import type {
	InspectorProjection,
	OperatorDecisionSubject,
	OperatorDecisionVerdict,
	PendingOperatorDecision,
	RunListItem,
	RunStatus,
	StatusSnapshot,
} from "./types";

/** Thrown when a write call is rejected for a missing/invalid bearer token. */
export class UnauthorizedError extends Error {
	constructor(message = "unauthorized") {
		super(message);
		this.name = "UnauthorizedError";
	}
}

/**
 * Thrown when the server rejects a decision on a state/optimistic-concurrency
 * mismatch (HTTP 400 `{ error: "invalid_decision", message }`). Carries the
 * server's human-readable `message`.
 */
export class DecisionConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DecisionConflictError";
	}
}

let authToken: string | null = null;

/** Set the bearer token used to authorize write calls (e.g. `postDecision`). */
export function setAuthToken(token: string | null): void {
	authToken = token;
}

/** Read the bearer token currently used to authorize write calls. */
export function getAuthToken(): string | null {
	return authToken;
}

async function getJson<T>(path: string): Promise<T> {
	const response = await fetch(path, {
		headers: { Accept: "application/json" },
	});
	if (!response.ok) {
		throw new Error(`request failed (${response.status}): ${path}`);
	}
	return (await response.json()) as T;
}

export function fetchRuns(
	status: RunStatus,
	opts?: { limit?: number; cursor?: string },
): Promise<{ runs: RunListItem[]; cursor?: string }> {
	const params = new URLSearchParams({ status });
	if (opts?.limit !== undefined) {
		params.set("limit", String(opts.limit));
	}
	if (opts?.cursor !== undefined) {
		params.set("cursor", opts.cursor);
	}
	return getJson<{ runs: RunListItem[]; cursor?: string }>(
		`/api/runs?${params.toString()}`,
	);
}

export function fetchInspector(runId: string): Promise<InspectorProjection> {
	return getJson<InspectorProjection>(
		`/api/runs/${encodeURIComponent(runId)}/inspector`,
	);
}

export function fetchStatus(): Promise<StatusSnapshot> {
	return getJson<StatusSnapshot>("/api/status");
}

export function fetchInbox(): Promise<PendingOperatorDecision[]> {
	return getJson<PendingOperatorDecision[]>("/api/inbox");
}

export async function postDecision(
	runId: string,
	body: {
		decision: OperatorDecisionVerdict;
		subject: OperatorDecisionSubject;
	},
): Promise<{ ok: true; runId: string }> {
	const response = await fetch(
		`/api/runs/${encodeURIComponent(runId)}/decision`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${getAuthToken() ?? ""}`,
			},
			body: JSON.stringify(body),
		},
	);

	if (response.status === 401) {
		throw new UnauthorizedError();
	}

	if (response.status === 400) {
		const parsed = (await response.json().catch(() => null)) as {
			error?: string;
			message?: string;
		} | null;
		if (parsed?.error === "invalid_decision") {
			throw new DecisionConflictError(parsed.message ?? "invalid decision");
		}
		throw new Error(parsed?.error ?? "invalid decision request");
	}

	if (!response.ok) {
		throw new Error(`decision failed (${response.status})`);
	}

	return (await response.json()) as { ok: true; runId: string };
}
