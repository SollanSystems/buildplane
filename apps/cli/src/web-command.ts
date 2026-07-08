import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	MissionControlOrchestrator,
	MissionControlRouterDeps,
	MissionControlServer,
	MissionControlServerDeps,
	MissionControlStore,
	RouterRequest,
	RouterResponse,
} from "@buildplane/mission-control-server";

/** Default listen port — the Vite preview port, distinct from `vite dev` (5173). */
export const DEFAULT_WEB_PORT = 4173;

const WEB_DIST_SUBPATH = "apps/web/dist";

/**
 * The static web root `bp web` serves. Anchored to the buildplane checkout
 * this CLI module runs from — `apps/cli/{src,dist}/web-command.*` is three
 * levels below the repo root — so the UI serves when the operator runs
 * `bp web` from ANY target repo (the M6 demo runs it from the staged toy
 * repo). Falls back to the cwd-relative dist for layouts where the CLI tree
 * carries no built web app.
 */
export function resolveWebRoot(
	cwd: string,
	moduleDir = dirname(fileURLToPath(import.meta.url)),
): string {
	const installRoot = join(moduleDir, "..", "..", "..", WEB_DIST_SUBPATH);
	if (existsSync(installRoot)) {
		return installRoot;
	}
	return join(cwd, WEB_DIST_SUBPATH);
}

export interface WebCommandOptions {
	readonly cwd: string;
	readonly port: number;
	readonly check: boolean;
	readonly allowExternal: boolean;
	readonly stdout: (line: string) => void;
	readonly stderr: (line: string) => void;
	/**
	 * When provided, the served process resolves (closing the server) on abort —
	 * the CLI wires this to SIGINT/SIGTERM for graceful shutdown. Omitted ⇒ the
	 * server runs until the host process is terminated.
	 */
	readonly signal?: AbortSignal;
}

interface WebServerModule {
	createMissionControlServer(
		deps: MissionControlServerDeps,
	): MissionControlServer;
	handleApiRequest(
		deps: MissionControlRouterDeps,
		request: RouterRequest,
	): Promise<RouterResponse>;
}

/** Lazy seam over the heavyweight orchestrator + server-module construction. */
export interface WebCommandRuntime {
	loadServerModule(): Promise<WebServerModule>;
	loadDeps(cwd: string): Promise<{
		orchestrator: MissionControlOrchestrator;
		store: MissionControlStore;
	}>;
}

/**
 * Serve the Mission Control web UI (or, under `--check`, prove the dependency
 * graph wires up without binding a port).
 *
 * The signed `operator_decision_recorded` emit is owned by the orchestrator's
 * own constructor-injected `OperatorDecisionPort`; the decision route applies it
 * through `orchestrator.recordOperatorDecision`. We deliberately do NOT pass a
 * second `operatorDecisionPort` into the server/router deps — the router never
 * reads it, so it would be dead wiring and a latent double-emit footgun.
 */
export async function executeWebCommand(
	options: WebCommandOptions,
	runtime: WebCommandRuntime,
): Promise<number> {
	let mod: WebServerModule;
	try {
		mod = await runtime.loadServerModule();
	} catch (error) {
		if (!isServerModuleNotFound(error)) {
			throw error;
		}
		options.stderr(
			"bp web is not available in this installation: the optional @buildplane/mission-control-server package is not bundled with the published npm artifact.",
		);
		options.stderr(
			"Run bp web from a Buildplane source checkout (pnpm install && pnpm build).",
		);
		return 1;
	}
	const { orchestrator, store } = await runtime.loadDeps(options.cwd);

	if (options.check) {
		const response = await mod.handleApiRequest(
			{ orchestrator, store, tokenSource: { read: () => undefined } },
			{
				method: "GET",
				pathname: "/api/status",
				query: new URLSearchParams(),
			},
		);
		if (response.status !== 200) {
			options.stderr(
				`web --check failed: GET /api/status returned ${response.status}`,
			);
			return 1;
		}
		options.stdout("ok");
		return 0;
	}

	const server = mod.createMissionControlServer({
		orchestrator,
		store,
		webRoot: resolveWebRoot(options.cwd),
		allowExternal: options.allowExternal,
		logger: options.stderr,
	});
	const address = await server.listen(options.port);
	options.stderr(
		`mission-control: listening on http://${address.host}:${address.port}`,
	);
	options.stdout(`http://${address.host}:${address.port}`);

	await waitForShutdown(options.signal);
	await server.close();
	return 0;
}

/**
 * True only when the failure is the mission-control-server package itself
 * being absent (the published-install layout). A missing TRANSITIVE dep also
 * raises ERR_MODULE_NOT_FOUND but names the transitive specifier, so it falls
 * through to the generic CLI error path instead of this contract message.
 */
function isServerModuleNotFound(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND" &&
		error.message.includes("'@buildplane/mission-control-server'")
	);
}

function waitForShutdown(signal: AbortSignal | undefined): Promise<void> {
	if (!signal) {
		// No shutdown signal — serve until the host process is terminated.
		return new Promise<void>(() => {});
	}
	if (signal.aborted) {
		return Promise.resolve();
	}
	return new Promise<void>((resolve) => {
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}
