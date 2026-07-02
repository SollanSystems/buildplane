import {
	type BuildplaneOrchestrator,
	type BuildplaneStoragePort,
	createInspectorProjection,
	type OperatorDecisionPort,
	type RecordOperatorDecisionInput,
	type Run,
	type RunPage,
	type RunStatus,
} from "@buildplane/kernel";
import { type BearerTokenSource, isAuthorizedWrite } from "./auth.js";

export type MissionControlOrchestrator = Pick<
	BuildplaneOrchestrator,
	"inspect" | "recordOperatorDecision" | "recoverPendingDecisions"
>;

export type MissionControlStore = Pick<
	BuildplaneStoragePort,
	"listRunsByStatus" | "listPendingOperatorDecisions" | "getStatusSnapshot"
>;

export interface MissionControlRouterDeps {
	readonly orchestrator: MissionControlOrchestrator;
	readonly store: MissionControlStore;
	readonly tokenSource: BearerTokenSource;
	/**
	 * The signed-emit seam (M5-S4). The decision route applies it through
	 * `orchestrator.recordOperatorDecision` (which owns the write-ahead emit); the
	 * port is held as the interface this package depends on — never via apps/cli.
	 */
	readonly operatorDecisionPort?: OperatorDecisionPort;
	/** Operator identity stamped onto recorded decisions. */
	readonly decidedBy?: string;
	/**
	 * Hostnames permitted in the `Host`/`Origin` headers (DNS-rebinding guard).
	 * When set, every request whose Host — or, if present, Origin — falls outside
	 * this set is rejected with 403. `undefined` disables the check (the server
	 * omits it when bound to an external interface, where the operator opted in).
	 */
	readonly allowedHosts?: ReadonlySet<string>;
}

export interface RouterRequest {
	readonly method: string;
	readonly pathname: string;
	readonly query: URLSearchParams;
	readonly authorizationHeader?: string;
	/** The request `Host` header, used by the DNS-rebinding allowlist. */
	readonly host?: string;
	/** The request `Origin` header, used by the DNS-rebinding allowlist. */
	readonly origin?: string;
	readonly body?: unknown;
}

export interface RouterResponse {
	readonly status: number;
	readonly body?: unknown;
}

const RUN_STATUSES: ReadonlySet<string> = new Set<RunStatus>([
	"pending",
	"running",
	"passed",
	"failed",
	"cancelled",
	"suspended",
]);

const DEFAULT_DECIDED_BY = "web-operator";

const RUN_SUBPATH_PATTERN = /^\/api\/runs\/([^/]+)\/(.+)$/;

function matchRunSubpath(pathname: string, leaf: string): string | undefined {
	const match = pathname.match(RUN_SUBPATH_PATTERN);
	if (!match || match[2] !== leaf) {
		return undefined;
	}
	return decodeURIComponent(match[1]);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isInvalidCursorError(error: unknown): boolean {
	return error instanceof Error && /invalid run cursor/i.test(error.message);
}

function isValidationError(error: unknown): boolean {
	return (
		error instanceof Error && error.name === "OperatorDecisionValidationError"
	);
}

function parseLimit(raw: string | null): number | undefined | "invalid" {
	if (raw === null) {
		return undefined;
	}
	if (!/^\d+$/.test(raw)) {
		return "invalid";
	}
	const value = Number(raw);
	return Number.isInteger(value) && value > 0 ? value : "invalid";
}

function listRuns(
	deps: MissionControlRouterDeps,
	request: RouterRequest,
): RouterResponse {
	const status = request.query.get("status") ?? undefined;
	if (!status || !RUN_STATUSES.has(status)) {
		return { status: 400, body: { error: "invalid_status" } };
	}

	const limit = parseLimit(request.query.get("limit"));
	if (limit === "invalid") {
		return { status: 400, body: { error: "invalid_limit" } };
	}

	const cursor = request.query.get("cursor") ?? undefined;
	const options: { limit?: number; cursor?: string } = {};
	if (limit !== undefined) {
		options.limit = limit;
	}
	if (cursor !== undefined) {
		options.cursor = cursor;
	}

	try {
		const page: RunPage = deps.store.listRunsByStatus(
			status as RunStatus,
			options,
		);
		const body: { runs: Run[]; cursor?: string } = { runs: [...page] };
		if (page.cursor) {
			body.cursor = page.cursor;
		}
		return { status: 200, body };
	} catch (error) {
		if (isInvalidCursorError(error)) {
			return { status: 400, body: { error: "invalid_cursor" } };
		}
		throw error;
	}
}

function runInspector(
	deps: MissionControlRouterDeps,
	runId: string,
): RouterResponse {
	try {
		const snapshot = deps.orchestrator.inspect(runId);
		return { status: 200, body: createInspectorProjection(snapshot) };
	} catch (error) {
		return {
			status: 404,
			body: { error: "run_not_found", message: messageOf(error) },
		};
	}
}

interface DecisionBody {
	readonly decision: string;
	readonly subject: string;
}

function isDecisionBody(body: unknown): body is DecisionBody {
	if (typeof body !== "object" || body === null) {
		return false;
	}
	const record = body as Record<string, unknown>;
	return (
		typeof record.decision === "string" && typeof record.subject === "string"
	);
}

async function recordDecision(
	deps: MissionControlRouterDeps,
	runId: string,
	request: RouterRequest,
): Promise<RouterResponse> {
	if (!isAuthorizedWrite(request.authorizationHeader, deps.tokenSource)) {
		return { status: 401, body: { error: "unauthorized" } };
	}

	if (!isDecisionBody(request.body)) {
		return { status: 400, body: { error: "invalid_decision_body" } };
	}

	const input: RecordOperatorDecisionInput = {
		runId,
		decision: request.body.decision as RecordOperatorDecisionInput["decision"],
		subject: request.body.subject as RecordOperatorDecisionInput["subject"],
		decidedBy: deps.decidedBy ?? DEFAULT_DECIDED_BY,
		decidedAt: new Date().toISOString(),
	};

	try {
		await deps.orchestrator.recordOperatorDecision(input);
		return { status: 200, body: { ok: true, runId } };
	} catch (error) {
		if (isValidationError(error)) {
			return {
				status: 400,
				body: { error: "invalid_decision", message: messageOf(error) },
			};
		}
		throw error;
	}
}

function normalizeHostname(raw: string): string {
	const lower = raw.trim().toLowerCase();
	return lower.startsWith("[") && lower.endsWith("]")
		? lower.slice(1, -1)
		: lower;
}

function hostnameFromHostHeader(hostHeader: string): string | undefined {
	const trimmed = hostHeader.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	if (trimmed.startsWith("[")) {
		const end = trimmed.indexOf("]");
		return end > 0 ? normalizeHostname(trimmed.slice(0, end + 1)) : undefined;
	}
	const colon = trimmed.indexOf(":");
	return normalizeHostname(colon === -1 ? trimmed : trimmed.slice(0, colon));
}

function hostnameFromOrigin(origin: string): string | undefined {
	try {
		return normalizeHostname(new URL(origin).hostname);
	} catch {
		return undefined;
	}
}

/**
 * DNS-rebinding guard. The `Host` header must be present and in `allowedHosts`;
 * if an `Origin` header is present its host must be allowed too. A browser page
 * on a rebound attacker domain carries that domain in Host/Origin, so pinning
 * the allowlist to the loopback names plus the configured bind host blocks the
 * cross-origin read while genuine same-origin reads pass.
 */
export function isHostAllowed(
	hostHeader: string | undefined,
	originHeader: string | undefined,
	allowedHosts: ReadonlySet<string>,
): boolean {
	if (hostHeader === undefined) {
		return false;
	}
	const host = hostnameFromHostHeader(hostHeader);
	if (host === undefined || !allowedHosts.has(host)) {
		return false;
	}
	if (originHeader !== undefined) {
		const originHost = hostnameFromOrigin(originHeader);
		if (originHost === undefined || !allowedHosts.has(originHost)) {
			return false;
		}
	}
	return true;
}

/**
 * Dispatch one parsed `/api/*` request to its handler. Every route is first run
 * through the DNS-rebinding allowlist (when configured). Reads are otherwise
 * open; the decision write is bearer-token gated. Unmatched paths return 404 so
 * the HTTP layer can fall through to static serving.
 */
export function handleApiRequest(
	deps: MissionControlRouterDeps,
	request: RouterRequest,
): Promise<RouterResponse> {
	const { method, pathname } = request;

	if (
		deps.allowedHosts !== undefined &&
		!isHostAllowed(request.host, request.origin, deps.allowedHosts)
	) {
		return Promise.resolve({ status: 403, body: { error: "forbidden_host" } });
	}

	if (method === "GET" && pathname === "/api/runs") {
		return Promise.resolve(listRuns(deps, request));
	}

	const inspectorTarget = matchRunSubpath(pathname, "inspector");
	if (method === "GET" && inspectorTarget !== undefined) {
		return Promise.resolve(runInspector(deps, inspectorTarget));
	}

	if (method === "GET" && pathname === "/api/status") {
		return Promise.resolve({
			status: 200,
			body: deps.store.getStatusSnapshot(),
		});
	}

	if (method === "GET" && pathname === "/api/inbox") {
		return Promise.resolve({
			status: 200,
			body: deps.store.listPendingOperatorDecisions(),
		});
	}

	const decisionTarget = matchRunSubpath(pathname, "decision");
	if (method === "POST" && decisionTarget !== undefined) {
		return recordDecision(deps, decisionTarget, request);
	}

	return Promise.resolve({ status: 404, body: { error: "not_found" } });
}
