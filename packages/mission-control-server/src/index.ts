import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { OperatorDecisionPort } from "@buildplane/kernel";
import {
	type BearerTokenSource,
	defaultWebTokenPath,
	fileBearerTokenSource,
} from "./auth.js";
import {
	handleApiRequest,
	isHostAllowed,
	type MissionControlOrchestrator,
	type MissionControlStore,
} from "./router.js";
import { resolveStaticAsset } from "./static.js";

export {
	type BearerTokenSource,
	defaultWebTokenPath,
	fileBearerTokenSource,
	isAuthorizedWrite,
} from "./auth.js";
export {
	handleApiRequest,
	isHostAllowed,
	type MissionControlOrchestrator,
	type MissionControlRouterDeps,
	type MissionControlStore,
	type RouterRequest,
	type RouterResponse,
} from "./router.js";
export { resolveStaticAsset, type StaticAsset } from "./static.js";

const LOOPBACK_HOST = "127.0.0.1";
const EXTERNAL_HOST = "0.0.0.0";
const MAX_BODY_BYTES = 1_048_576;
const LOOPBACK_HOST_NAMES: readonly string[] = [
	"localhost",
	"127.0.0.1",
	"::1",
];

/**
 * The `Host`/`Origin` allowlist for the DNS-rebinding guard. Enforced only for a
 * loopback bind (the default); an external bind is an explicit operator opt-in
 * whose legitimate hostnames cannot be enumerated, so the guard is disabled.
 */
function resolveAllowedHosts(host: string): ReadonlySet<string> | undefined {
	if (host === EXTERNAL_HOST) {
		return undefined;
	}
	return new Set([...LOOPBACK_HOST_NAMES, host]);
}

function firstHeaderValue(
	value: string | string[] | undefined,
): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

interface DispatchContext {
	readonly deps: MissionControlServerDeps;
	readonly tokenSource: BearerTokenSource;
	readonly allowedHosts: ReadonlySet<string> | undefined;
	readonly logger: (message: string) => void;
}

export interface MissionControlServerDeps {
	readonly orchestrator: MissionControlOrchestrator;
	readonly store: MissionControlStore;
	/**
	 * The injected signed-emit seam (M5-S4). Held as the kernel interface this
	 * package depends on; the decision route applies it via
	 * `orchestrator.recordOperatorDecision`. Never imported from apps/cli.
	 */
	readonly operatorDecisionPort?: OperatorDecisionPort;
	readonly tokenSource?: BearerTokenSource;
	/** Directory of the `apps/web` build output to static-serve (optional). */
	readonly webRoot?: string;
	/** Operator identity stamped onto recorded decisions. */
	readonly decidedBy?: string;
	/** Force external binding regardless of env (defaults to env opt-in). */
	readonly allowExternal?: boolean;
	readonly logger?: (message: string) => void;
}

export interface ListeningAddress {
	readonly host: string;
	readonly port: number;
}

export interface MissionControlServer {
	readonly server: Server;
	listen(port: number): Promise<ListeningAddress>;
	close(): Promise<void>;
}

/**
 * Loopback by default; only `BUILDPLANE_WEB_ALLOW_EXTERNAL=1` (or an explicit
 * `allowExternal`) widens the bind to all interfaces.
 */
export function resolveBindHost(
	deps: Pick<MissionControlServerDeps, "allowExternal">,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const allowExternal =
		deps.allowExternal ?? env.BUILDPLANE_WEB_ALLOW_EXTERNAL === "1";
	return allowExternal ? EXTERNAL_HOST : LOOPBACK_HOST;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = body === undefined ? "" : JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(payload);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const method = req.method ?? "GET";
	if (method === "GET" || method === "HEAD" || method === "DELETE") {
		return Promise.resolve(undefined);
	}

	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (chunks.length === 0) {
				resolve(undefined);
				return;
			}
			const raw = Buffer.concat(chunks).toString("utf8").trim();
			if (raw.length === 0) {
				resolve(undefined);
				return;
			}
			try {
				resolve(JSON.parse(raw));
			} catch {
				resolve(undefined);
			}
		});
		req.on("error", reject);
	});
}

async function dispatch(
	ctx: DispatchContext,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const { deps, tokenSource, allowedHosts, logger } = ctx;
	try {
		const url = new URL(req.url ?? "/", "http://localhost");
		const { pathname } = url;

		const hostHeader = firstHeaderValue(req.headers.host);
		const originHeader = firstHeaderValue(req.headers.origin);

		if (
			allowedHosts !== undefined &&
			!isHostAllowed(hostHeader, originHeader, allowedHosts)
		) {
			writeJson(res, 403, { error: "forbidden_host" });
			return;
		}

		if (pathname.startsWith("/api/")) {
			const body = await readJsonBody(req);
			const response = await handleApiRequest(
				{
					orchestrator: deps.orchestrator,
					store: deps.store,
					tokenSource,
					operatorDecisionPort: deps.operatorDecisionPort,
					decidedBy: deps.decidedBy,
					allowedHosts,
				},
				{
					method: req.method ?? "GET",
					pathname,
					query: url.searchParams,
					authorizationHeader: req.headers.authorization,
					host: hostHeader,
					origin: originHeader,
					body,
				},
			);
			writeJson(res, response.status, response.body);
			return;
		}

		if (req.method === "GET" || req.method === "HEAD") {
			const asset = resolveStaticAsset(deps.webRoot, pathname);
			if (asset) {
				res.writeHead(
					asset.status,
					asset.contentType ? { "content-type": asset.contentType } : {},
				);
				res.end(req.method === "HEAD" ? undefined : asset.body);
				return;
			}
		}

		writeJson(res, 404, { error: "not_found" });
	} catch (error) {
		logger(
			`mission-control-server request failed: ${
				error instanceof Error ? (error.stack ?? error.message) : String(error)
			}`,
		);
		writeJson(res, 500, { error: "internal_error" });
	}
}

export function createMissionControlServer(
	deps: MissionControlServerDeps,
): MissionControlServer {
	const tokenSource =
		deps.tokenSource ?? fileBearerTokenSource(defaultWebTokenPath());
	const logger = deps.logger ?? (() => {});
	const host = resolveBindHost(deps);
	const allowedHosts = resolveAllowedHosts(host);
	const ctx: DispatchContext = { deps, tokenSource, allowedHosts, logger };

	const server = createServer((req, res) => {
		void dispatch(ctx, req, res);
	});

	return {
		server,
		async listen(port: number): Promise<ListeningAddress> {
			// Crash reconciler (M5-S4 D2 / R2) — re-drive any decided-but-unexecuted
			// operator decision EXACTLY ONCE before this server starts serving.
			// Per-item isolation means the call never throws: a record that fails to
			// re-drive is reported under `failed` and boot proceeds.
			const recovery = await deps.orchestrator.recoverPendingDecisions();
			logger(
				`mission-control: recovered ${recovery.recovered} pending operator decision(s) on boot.`,
			);
			for (const failure of recovery.failed) {
				logger(
					`mission-control: failed to recover operator decision for run ${failure.runId}: ${failure.error}`,
				);
			}

			if (host === EXTERNAL_HOST) {
				logger(
					`mission-control-server binding on ${host}:${port} — external access enabled (BUILDPLANE_WEB_ALLOW_EXTERNAL=1).`,
				);
			}
			return new Promise((resolve, reject) => {
				const onError = (error: Error) => reject(error);
				server.once("error", onError);
				server.listen(port, host, () => {
					server.removeListener("error", onError);
					const address = server.address();
					if (address === null || typeof address === "string") {
						reject(
							new Error("mission-control-server failed to bind a TCP port"),
						);
						return;
					}
					resolve({ host: address.address, port: address.port });
				});
			});
		},
		close(): Promise<void> {
			return new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
	};
}
