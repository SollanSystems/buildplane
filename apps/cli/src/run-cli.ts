import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	formatHumanError,
	formatInitializationResult,
	formatInspectDetail,
	formatJson,
	formatJsonError,
	formatLearningDetail,
	formatLearningsList,
	formatRunHistory,
	formatRunResult,
	formatStrategyRunResult,
} from "./formatters.js";
import {
	enrichGraphWithMemories,
	enrichPacketWithMemories,
	enrichStrategyWithMemories,
} from "./packet-enrichment.js";

export interface RunCliDependencies {
	createOrchestrator?: () => BuildplaneCliOrchestrator;
	parsePacket?: (packetPath: string) => unknown;
	runNativeCommand?: (
		argv: string[],
		options: {
			cwd: string;
			commandPath: string[];
			stdout: (line: string) => void;
			stderr: (line: string) => void;
		},
	) => Promise<number> | number;
}

export interface RunCliOptions {
	readonly cwd?: string;
	readonly stdout?: (line: string) => void;
	readonly stderr?: (line: string) => void;
	readonly dependencies?: RunCliDependencies;
}

const BUILDPLANE_BANNER = "Buildplane by SollanSystems";

async function cliImport(specifier: string): Promise<unknown> {
	switch (specifier) {
		case "@buildplane/kernel":
			return import("@buildplane/kernel");
		case "@buildplane/runtime":
			return import("@buildplane/runtime");
		case "@buildplane/policy":
			return import("@buildplane/policy");
		case "@buildplane/storage":
			return import("@buildplane/storage");
		case "@buildplane/adapters-git":
			return import("@buildplane/adapters-git");
		case "@buildplane/adapters-models":
			return import("@buildplane/adapters-models");
		case "@buildplane/adapters-codex":
			return import("@buildplane/adapters-codex");
		case "@buildplane/adapters-honcho":
			return import("@buildplane/adapters-honcho");
		case "@buildplane/ui-tui":
			return import("@buildplane/ui-tui");
		default:
			throw new Error(`Unsupported workspace import '${specifier}'`);
	}
}

function formatTopLevelHelp(): string[] {
	return [
		BUILDPLANE_BANNER,
		"",
		"  Execute:",
		"    run --packet <path>    Run with implement-then-review (default)",
		"    demo [--model]         Prove the flywheel in 30 seconds",
		"",
		"  Observe:",
		"    status [--json]        Project health snapshot",
		"    history [--json]       List all runs",
		"    inspect <id> [--json]  Deep-dive into a run",
		"    replay <id> [--json]   Re-run with different settings",
		"",
		"  Advanced:",
		"    run-graph --graph <p>  Execute a DAG of tasks",
		"    run-strategy --strat   Run a custom multi-role strategy",
		"",
		"  Project:",
		"    init                   Initialize .buildplane in this repo",
		"    memory list            Show stored learnings",
		"    memory inspect <id>    Detail for one learning",
		"    memory <action>        Advanced memory operations (native)",
		"    pack show <id>         Inspect a pack",
		"",
		"  buildplane run --help    Show run options (--raw, --tui)",
	];
}

function formatRunHelp(): string[] {
	return [
		"buildplane run --packet <path> [options]",
		"",
		"  By default, runs implement-then-review: an implementer executes the task,",
		"  then a reviewer verifies the output. This is what makes Buildplane runs",
		"  self-correcting.",
		"",
		"  Options:",
		"    --raw            Single-shot execution (no review loop)",
		"    --tui            Interactive terminal UI",
		"    --json           Machine-readable output",
	];
}

interface BuildplaneCliOrchestrator {
	initializeProject(): {
		created: boolean;
		projectRoot: string;
		stateDbPath: string;
	};
	runPacket(packet: unknown): {
		run: { id: string; status: string };
		receipt: unknown;
		decision: unknown;
	};
	runPacketAsync(
		packet: unknown,
		eventBus?: unknown,
	): Promise<{
		run: { id: string; status: string };
		receipt: unknown;
		decision: unknown;
	}>;
	runGraphAsync(
		graph: unknown,
		eventBus?: unknown,
	): Promise<{
		outcome: "passed" | "failed";
		nodes: Array<{ unitId: string; status: string; runId?: string }>;
	}>;
	runStrategy(
		strategy: unknown,
		eventBus?: unknown,
	): Promise<{
		strategyId: string;
		mode: string;
		outcome: "passed" | "failed" | "mixed";
		childResults: Map<string, { run: { id: string; status: string } }>;
		rounds?: ReadonlyArray<
			Map<string, { run: { id: string; status: string } }>
		>;
		mergeDecision: { policy: string; outcome: string; reasons: string[] };
		winnerRunId?: string;
	}>;
	getStatus(): { initialized: boolean } & Record<string, unknown>;
	inspect(
		id: string,
	): { kind: string; run: { id: string } } & Record<string, unknown>;
}

interface HonchoPortLike {
	createSubscriber(sessionId: string, userId: string): (event: unknown) => void;
	fetchContext(userId: string): Promise<{ memories: string[] }>;
}

interface MemoryPortLike {
	fetchLearnings(options?: {
		scope?: string;
		kind?: string;
		limit?: number;
	}): ReadonlyArray<{
		id: string;
		runId: string;
		scope: string;
		kind: string;
		title: string;
		body: string;
		status: string;
		createdAt: string;
		seenCount: number;
	}>;
	fetchLearningById(id: string):
		| {
				id: string;
				runId: string;
				scope: string;
				kind: string;
				title: string;
				body: string;
				status: string;
				createdAt: string;
				seenCount: number;
		  }
		| undefined;
	fetchLearningsByRunId(runId: string): ReadonlyArray<{
		id: string;
		runId: string;
		scope: string;
		kind: string;
		title: string;
		body: string;
		status: string;
		createdAt: string;
		seenCount: number;
	}>;
}

interface CliOrchestratorBundle {
	orchestrator: BuildplaneCliOrchestrator;
	memoryPort?: MemoryPortLike;
	honchoAdapter?: HonchoPortLike;
	userId?: string;
}

async function loadCliOrchestrator(
	projectRoot: string,
): Promise<CliOrchestratorBundle> {
	const kernel = (await cliImport("@buildplane/kernel")) as unknown as {
		createBuildplaneOrchestrator: (options: {
			projectRoot: string;
			storage: unknown;
			runtime: {
				executePacket: (packet: unknown, root: string) => unknown;
				executePacketAsync?: (
					packet: unknown,
					root: string,
					eventBus: unknown,
				) => Promise<unknown>;
			};
			policy: { evaluateRun: (packet: unknown, receipt: unknown) => unknown };
			workspace?: unknown;
			eventBus?: unknown;
			memoryPort?: unknown;
		}) => BuildplaneCliOrchestrator;
		createEventBus: () => {
			subscribe: (listener: (event: unknown) => void) => () => void;
			emit: (event: unknown) => void;
		};
		parseUnitPacket: (input: string) => unknown;
	};
	const runtime = (await cliImport("@buildplane/runtime")) as unknown as {
		executePacket: (packet: unknown, root: string) => unknown;
	};
	const policy = (await cliImport("@buildplane/policy")) as unknown as {
		evaluateRun: (packet: unknown, receipt: unknown) => unknown;
	};
	const storage = (await cliImport("@buildplane/storage")) as unknown as {
		createBuildplaneStorage: (root: string) => unknown;
		createEventStore: (root: string) => {
			persistEvent: (runId: string, event: unknown) => void;
		};
	};

	// Create event bus with storage persistence subscriber
	const eventBus = kernel.createEventBus();
	const eventStore = storage.createEventStore(projectRoot);

	// Wire up event persistence — every event emitted by the orchestrator
	// gets persisted to storage for later inspection and replay
	eventBus.subscribe((event: unknown) => {
		const e = event as { runId?: string };
		if (e.runId) {
			try {
				eventStore.persistEvent(e.runId, event as never);
			} catch {
				// Don't let storage failures break the run
			}
		}
	});

	// ── Optional Honcho memory integration ─────────────────────
	// Activated when HONCHO_API_KEY is set in the environment.
	// The adapter owns the SDK import — the CLI never touches @honcho-ai/sdk directly.

	let honchoAdapterRef: HonchoPortLike | undefined;
	let userIdRef: string | undefined;

	if (process.env.HONCHO_API_KEY) {
		try {
			const honchoModule = (await cliImport(
				"@buildplane/adapters-honcho",
			)) as unknown as {
				createHonchoAdapter: (options: {
					client: unknown;
					userId: string;
				}) => HonchoPortLike;
				createHonchoClient: (options: {
					workspaceId?: string;
					apiKey: string;
				}) => Promise<unknown>;
			};
			const { createHonchoAdapter, createHonchoClient } = honchoModule;

			const honchoClient = await createHonchoClient({
				workspaceId: process.env.HONCHO_WORKSPACE_ID,
				apiKey: process.env.HONCHO_API_KEY,
			});

			const userId = process.env.BUILDPLANE_USER_ID ?? "operator";
			const adapter = createHonchoAdapter({
				client: honchoClient as never,
				userId,
			});

			// Subscribe to the event bus for message storage
			const honchoSubscriber = adapter.createSubscriber("default", userId);
			eventBus.subscribe(honchoSubscriber as never);

			honchoAdapterRef = adapter as unknown as HonchoPortLike;
			userIdRef = userId;
		} catch (err) {
			// Warn when explicitly configured but broken — silence when SDK simply absent
			console.warn(
				`[buildplane] Honcho memory disabled: ${err instanceof Error ? err.message : "unknown error"}`,
			);
		}
	}

	// ── Optional local memory port ──────────────────────────────
	// Reads from the project's run_learnings table (state.db) if initialized.
	// Only opened if state.db exists — never creates the file.
	// Two separate connections: read-only for CLI enrichment (pre-run fetch),
	// read-write for orchestrator post-run writes.

	let memoryPortRef: MemoryPortLike | undefined;
	let orchestratorMemoryPortRef: MemoryPortLike | undefined;
	try {
		const { resolveProjectLayout, createLearningStore } = (await import(
			"@buildplane/storage"
		)) as unknown as {
			resolveProjectLayout: (root: string) => { stateDbPath: string };
			createLearningStore: (db: unknown) => MemoryPortLike;
		};
		const { DatabaseSync } = await import("node:sqlite");
		const layout = resolveProjectLayout(projectRoot);
		if (existsSync(layout.stateDbPath)) {
			// Read-only connection for CLI enrichment (pre-run fetch)
			const readDb = new DatabaseSync(layout.stateDbPath, { readOnly: true });
			memoryPortRef = createLearningStore(readDb);
			// Read-write connection for orchestrator post-run writes
			const writeDb = new DatabaseSync(layout.stateDbPath);
			orchestratorMemoryPortRef = createLearningStore(writeDb);
		}
	} catch {
		// Memory ports unavailable — run without them
	}

	// Runtime router: selects executor based on packet type and routing hints
	const adaptersModels = (await cliImport("@buildplane/adapters-models")) as unknown as {
		createModelExecutor: () => {
			executePacket: (packet: unknown, root: string) => unknown;
			executePacketAsync: (
				packet: unknown,
				root: string,
				eventBus: unknown,
			) => Promise<unknown>;
		};
		createClaudeCodeExecutor: () => {
			executePacket: (packet: unknown, root: string) => unknown;
			executePacketAsync: (
				packet: unknown,
				root: string,
				eventBus: unknown,
			) => Promise<unknown>;
		};
	};

	const adaptersGit = (await cliImport("@buildplane/adapters-git")) as unknown as {
		createGitWorktreeAdapter: () => unknown;
	};

	const adaptersCodex = (await cliImport("@buildplane/adapters-codex")) as unknown as {
		createCodexExecutor: () => {
			executePacket: (packet: unknown, root: string) => unknown;
			executePacketAsync: (
				packet: unknown,
				root: string,
				eventBus: unknown,
			) => Promise<unknown>;
		};
	};

	const commandExecutor = { executePacket: runtime.executePacket };
	const sdkExecutor = adaptersModels.createModelExecutor();
	const claudeExecutor = adaptersModels.createClaudeCodeExecutor();
	const codexExecutor = adaptersCodex.createCodexExecutor();

	const runtimeRouter = {
		executePacket(packet: unknown, root: string) {
			const p = packet as { execution?: unknown };
			if (p.execution) return commandExecutor.executePacket(packet, root);
			throw new Error("Model packets require async execution path");
		},
		async executePacketAsync(packet: unknown, root: string, bus: unknown) {
			const p = packet as {
				execution?: unknown;
				routingHints?: { preferredWorker?: string };
			};
			if (p.execution) return commandExecutor.executePacket(packet, root);
			if (p.routingHints?.preferredWorker === "claude-code") {
				return claudeExecutor.executePacketAsync(packet, root, bus);
			}
			if (p.routingHints?.preferredWorker === "codex") {
				return codexExecutor.executePacketAsync(packet, root, bus);
			}
			return sdkExecutor.executePacketAsync(packet, root, bus);
		},
	};

	const orchestrator = kernel.createBuildplaneOrchestrator({
		projectRoot,
		storage: storage.createBuildplaneStorage(projectRoot),
		runtime: runtimeRouter,
		policy: { evaluateRun: policy.evaluateRun },
		workspace: adaptersGit.createGitWorktreeAdapter(),
		eventBus,
		memoryPort: orchestratorMemoryPortRef, // READ-WRITE port for post-run writes
	});

	return {
		orchestrator,
		memoryPort: memoryPortRef,
		honchoAdapter: honchoAdapterRef,
		userId: userIdRef,
	};
}

async function loadEventStore(projectRoot: string): Promise<{
	getEventsByRunId: (runId: string) => unknown[];
}> {
	const storage = (await cliImport("@buildplane/storage")) as unknown as {
		createEventStore: (root: string) => {
			getEventsByRunId: (runId: string) => unknown[];
		};
	};
	return storage.createEventStore(projectRoot);
}

async function loadRunHistory(projectRoot: string): Promise<unknown[]> {
	const storage = (await cliImport("@buildplane/storage")) as unknown as {
		createBuildplaneStorage: (root: string) => {
			getRunHistory: () => unknown[];
		};
	};
	return storage.createBuildplaneStorage(projectRoot).getRunHistory();
}

async function loadReadOnlyMemoryPort(
	projectRoot: string,
): Promise<MemoryPortLike | undefined> {
	try {
		const { resolveProjectLayout, createLearningStore } = (await import(
			"@buildplane/storage"
		)) as unknown as {
			resolveProjectLayout: (root: string) => { stateDbPath: string };
			createLearningStore: (db: unknown) => MemoryPortLike;
		};
		const { DatabaseSync } = await import("node:sqlite");
		const layout = resolveProjectLayout(projectRoot);
		if (existsSync(layout.stateDbPath)) {
			const readDb = new DatabaseSync(layout.stateDbPath, { readOnly: true });
			return createLearningStore(readDb);
		}
	} catch {
		// Memory port unavailable
	}
	return undefined;
}

async function loadPacket(packetPath: string): Promise<unknown> {
	const kernel = (await cliImport("@buildplane/kernel")) as unknown as {
		parseUnitPacket: (input: string) => unknown;
	};

	return kernel.parseUnitPacket(readFileSync(packetPath, "utf8"));
}

const NATIVE_COMMAND_DISPATCH_ERROR_CODE = "NATIVE_COMMAND_DISPATCH_FAILED";
const NATIVE_COMMAND_DISPATCH_HINT =
	"Hint: build the native binary with `cargo build --manifest-path native/Cargo.toml -p bp-cli`, or set BUILDPLANE_NATIVE_BIN, or ensure `buildplane-native` is on PATH.";

class NativeCommandDispatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NativeCommandDispatchError";
	}
}

function formatNativeCommandPath(commandPath: string[]): string {
	return commandPath.join(" ");
}

function createNativeDispatchError(
	commandPath: string[],
	error: unknown,
): NativeCommandDispatchError {
	const detail =
		error instanceof Error && error.message.length > 0
			? error.message
			: undefined;
	const message = [
		`Failed to dispatch to the native ${formatNativeCommandPath(commandPath)} command runner.`,
		detail,
		NATIVE_COMMAND_DISPATCH_HINT,
	]
		.filter((value): value is string => Boolean(value))
		.join(" ");
	return new NativeCommandDispatchError(message);
}

function splitOutputLines(output: string): string[] {
	return output
		.split(/\r?\n/u)
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
}

function resolveNativeBinary(cwd: string): string {
	const explicit = process.env.BUILDPLANE_NATIVE_BIN;
	if (explicit) {
		return explicit;
	}

	const candidates = [
		resolve(cwd, "native", "target", "debug", "buildplane-native"),
		resolve(cwd, "native", "target", "release", "buildplane-native"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return "buildplane-native";
}

async function runNativeCommand(
	argv: string[],
	options: {
		cwd: string;
		commandPath: string[];
		stdout: (line: string) => void;
		stderr: (line: string) => void;
	},
): Promise<number> {
	const binary = resolveNativeBinary(options.cwd);
	const result = spawnSync(binary, [...options.commandPath, ...argv], {
		cwd: options.cwd,
		encoding: "utf8",
		env: process.env,
	});

	for (const line of splitOutputLines(result.stdout ?? "")) {
		options.stdout(line);
	}
	for (const line of splitOutputLines(result.stderr ?? "")) {
		options.stderr(line);
	}

	if (result.error) {
		const detail =
			result.error instanceof Error
				? result.error.message
				: String(result.error);
		throw new Error(
			`Resolved native binary '${binary}' for '${formatNativeCommandPath(options.commandPath)}' but could not start it. ${detail}`,
		);
	}
	return result.status ?? 1;
}

export async function runCli(
	argv: string[],
	options: RunCliOptions = {},
): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const stdout = options.stdout ?? ((line: string) => console.log(line));
	const stderr = options.stderr ?? ((line: string) => console.error(line));
	const deps = options.dependencies;
	const [command, ...rest] = argv;

	if (
		!command ||
		command === "help" ||
		command === "--help" ||
		command === "-h"
	) {
		for (const line of formatTopLevelHelp()) {
			stdout(line);
		}
		return 0;
	}

	try {
		if (command === "memory") {
			const subcommand = rest[0];
			if (subcommand === "list") {
				const subRest = rest.slice(1);
				const json = subRest.includes("--json");
				const scopeIdx = subRest.indexOf("--scope");
				const scope =
					scopeIdx >= 0 && scopeIdx + 1 < subRest.length
						? subRest[scopeIdx + 1]
						: undefined;
				const kindIdx = subRest.indexOf("--kind");
				const kind =
					kindIdx >= 0 && kindIdx + 1 < subRest.length
						? subRest[kindIdx + 1]
						: undefined;
				let learnings: ReturnType<MemoryPortLike["fetchLearnings"]> = [];
				try {
					const memoryPort = await loadReadOnlyMemoryPort(cwd);
					if (memoryPort) {
						learnings = memoryPort.fetchLearnings({
							scope: scope as string | undefined,
							kind: kind as string | undefined,
						});
					}
				} catch {
					// Database may lack run_learnings table (pre-cold-path project)
				}
				if (json) {
					stdout(formatJson(learnings));
				} else {
					for (const line of formatLearningsList(learnings)) {
						stdout(line);
					}
				}
				return 0;
			}
			if (subcommand === "inspect") {
				const subRest = rest.slice(1);
				const json = subRest.includes("--json");
				const id = subRest.find((v) => v !== "--json");
				if (!id) {
					const msg = "Missing required learning ID for memory inspect.";
					if (json) {
						stdout(formatJson(formatJsonError("MISSING_ARGUMENT", msg)));
					} else {
						stderr(msg);
					}
					return 1;
				}
				let learning:
					| ReturnType<MemoryPortLike["fetchLearningById"]>
					| undefined;
				try {
					const memoryPort = await loadReadOnlyMemoryPort(cwd);
					if (memoryPort) {
						learning = memoryPort.fetchLearningById(id);
					}
				} catch {
					// Database may lack run_learnings table (pre-cold-path project)
				}
				if (!learning) {
					const msg = `Learning not found: ${id}`;
					if (json) {
						stdout(formatJson(formatJsonError("NOT_FOUND", msg)));
					} else {
						stderr(msg);
					}
					return 1;
				}
				if (json) {
					stdout(formatJson(learning));
				} else {
					for (const line of formatLearningDetail(learning)) {
						stdout(line);
					}
				}
				return 0;
			}
			// Fall through to native for all other memory subcommands
			try {
				return await (deps?.runNativeCommand ?? runNativeCommand)(rest, {
					cwd,
					commandPath: ["memory"],
					stdout,
					stderr,
				});
			} catch (error) {
				throw createNativeDispatchError(["memory"], error);
			}
		}

		if (command === "pack" && rest[0] === "show") {
			try {
				return await (deps?.runNativeCommand ?? runNativeCommand)(
					rest.slice(1),
					{
						cwd,
						commandPath: ["pack", "show"],
						stdout,
						stderr,
					},
				);
			} catch (error) {
				throw createNativeDispatchError(["pack", "show"], error);
			}
		}

		if (command === "install") {
			try {
				return await (deps?.runNativeCommand ?? runNativeCommand)(rest, {
					cwd,
					commandPath: ["install"],
					stdout,
					stderr,
				});
			} catch (error) {
				throw createNativeDispatchError(["install"], error);
			}
		}

		if (command === "uninstall") {
			try {
				return await (deps?.runNativeCommand ?? runNativeCommand)(rest, {
					cwd,
					commandPath: ["uninstall"],
					stdout,
					stderr,
				});
			} catch (error) {
				throw createNativeDispatchError(["uninstall"], error);
			}
		}

		if (command === "demo") {
			const modelFlag = rest.includes("--model");
			const { runDemo } = await import("./demo.js");
			await runDemo({ model: modelFlag });
			return 0;
		}

		const bundle: CliOrchestratorBundle = deps?.createOrchestrator
			? { orchestrator: deps.createOrchestrator() }
			: await loadCliOrchestrator(cwd);
		const { orchestrator, memoryPort, honchoAdapter, userId } = bundle;

		switch (command) {
			case "init": {
				const result = orchestrator.initializeProject();
				for (const line of formatInitializationResult(result)) {
					stdout(line);
				}
				return 0;
			}
			case "run": {
				// --help BEFORE --packet validation (so `buildplane run --help` works without --packet)
				if (rest.includes("--help")) {
					for (const line of formatRunHelp()) {
						stdout(line);
					}
					return 0;
				}

				// Pre-flight: ensure project is initialized before packet loading
				orchestrator.getStatus();

				const packetIndex = rest.indexOf("--packet");
				if (packetIndex === -1 || !rest[packetIndex + 1]) {
					throw new Error("Missing required --packet <path> argument.");
				}

				const packetPath = resolve(cwd, rest[packetIndex + 1]);
				const packet = deps?.parsePacket
					? deps.parsePacket(packetPath)
					: await loadPacket(packetPath);
				const enrichedPacket = await enrichPacketWithMemories(
					packet,
					memoryPort,
					honchoAdapter,
					userId,
				);

				const useRaw = rest.includes("--raw");
				const useJson = rest.includes("--json");

				// ── Strategy path (default) ──────────────────────────────
				if (!useRaw) {
					const { wrapAsStrategy } = await import("./strategy-wrapper.js");
					const strategy = wrapAsStrategy(
						enrichedPacket as Parameters<typeof wrapAsStrategy>[0],
					);

					const kernel = (await cliImport("@buildplane/kernel")) as unknown as {
						createEventBus: () => {
							subscribe: (listener: (event: unknown) => void) => () => void;
							emit: (event: unknown) => void;
						};
					};
					const strategyBus = kernel.createEventBus();

					const useTui = rest.includes("--tui");
					if (useTui) {
						const tui = (await cliImport("@buildplane/ui-tui")) as unknown as {
							renderTui: (eventBus: unknown) => {
								waitUntilExit(): Promise<void>;
								unmount(): void;
								clear(): void;
							};
						};
						tui.renderTui(strategyBus);
					}

					const strategyResult = await orchestrator.runStrategy(
						strategy,
						strategyBus,
					);

					if (useJson) {
						stdout(
							formatJson(strategyResult as unknown as Record<string, unknown>),
						);
					} else {
						for (const line of formatStrategyRunResult(
							strategyResult as Parameters<typeof formatStrategyRunResult>[0],
						)) {
							stdout(line);
						}
					}

					return strategyResult.outcome === "passed" ? 0 : 1;
				}

				// ── Raw path (single-shot, backward compat) ─────────────
				// Everything below is the EXISTING code, unchanged
				const useTui = rest.includes("--tui");
				const isModelPacket = !!(enrichedPacket as { model?: unknown }).model;
				const useAsync = useTui || isModelPacket;

				if (useAsync && !useTui) {
					// Model packets auto-switch to async (no TUI)
					const result = await orchestrator.runPacketAsync(enrichedPacket);

					for (const line of formatRunResult(
						result as { run: { id: string; status: string } },
					)) {
						stdout(line);
					}

					return (result as { run: { status: string } }).run.status === "passed"
						? 0
						: 1;
				}

				if (useTui) {
					// Lazy-load TUI — only imported when --tui is requested
					const kernel = (await cliImport("@buildplane/kernel")) as unknown as {
						createEventBus: () => {
							subscribe: (listener: (event: unknown) => void) => () => void;
							emit: (event: unknown) => void;
						};
					};
					const tui = (await cliImport("@buildplane/ui-tui")) as unknown as {
						renderTui: (eventBus: unknown) => {
							waitUntilExit(): Promise<void>;
							unmount(): void;
							clear(): void;
						};
					};
					const storage = (await cliImport("@buildplane/storage")) as unknown as {
						createEventStore: (root: string) => {
							persistEvent: (runId: string, event: unknown) => void;
						};
					};

					const tuiBus = kernel.createEventBus();

					// Wire storage persistence to the TUI bus too
					const eventStore = storage.createEventStore(cwd);
					tuiBus.subscribe((event: unknown) => {
						const e = event as { runId?: string };
						if (e.runId) {
							try {
								eventStore.persistEvent(e.runId, event as never);
							} catch {
								// Don't let storage failures break the run
							}
						}
					});

					const tuiInstance = tui.renderTui(tuiBus);

					const result = await orchestrator.runPacketAsync(
						enrichedPacket,
						tuiBus,
					);
					await tuiInstance.waitUntilExit();

					return result.run.status === "passed" ? 0 : 1;
				}

				const result = useAsync
					? await orchestrator.runPacketAsync(enrichedPacket, undefined)
					: orchestrator.runPacket(enrichedPacket);

				const resultRecord = result as unknown as Record<string, unknown>;
				const hasFailed =
					resultRecord.failure && typeof resultRecord.failure === "object";
				for (const line of formatRunResult(result)) {
					stdout(line);
				}
				if (hasFailed) {
					const f = resultRecord.failure as { message?: string };
					if (f.message) stderr(f.message);
				}
				return hasFailed || result.run.status !== "passed" ? 1 : 0;
			}
			case "status": {
				const json = rest.includes("--json");
				const result = orchestrator.getStatus() as unknown as Record<
					string,
					unknown
				>;

				if (json) {
					stdout(formatJson(result));
				} else {
					stdout(`initialized: ${result.initialized}`);
					const latestRun = result.latestRun as
						| { id: string; unitId: string; status: string }
						| undefined;
					if (latestRun) {
						stdout(
							`latest-run: ${latestRun.id} ${latestRun.status} (${latestRun.unitId})`,
						);
					}
					const runCounts = result.runCounts as
						| {
								pending: number;
								running: number;
								passed: number;
								failed: number;
								cancelled: number;
						  }
						| undefined;
					if (runCounts) {
						stdout(
							`run-counts: pending=${runCounts.pending} running=${runCounts.running} passed=${runCounts.passed} failed=${runCounts.failed} cancelled=${runCounts.cancelled}`,
						);
					}
					const latestWorkspace = result.latestWorkspace as
						| { path: string; status: string }
						| undefined;
					if (latestWorkspace?.path) {
						stdout(
							`workspace: ${latestWorkspace.path} (${latestWorkspace.status})`,
						);
					}
					const actionableWorkspaces = result.actionableWorkspaces as
						| unknown[]
						| undefined;
					if (actionableWorkspaces && actionableWorkspaces.length > 0) {
						stdout(`actionable-workspaces: ${actionableWorkspaces.length}`);
					}
				}
				return 0;
			}
			case "inspect": {
				const json = rest.includes("--json");
				const id = rest.find((value) => value !== "--json");
				if (!id) {
					throw new Error("Missing required run or unit id for inspect.");
				}

				const result = orchestrator.inspect(id);

				if (json) {
					stdout(formatJson(result));
				} else {
					let events: Array<{
						kind: string;
						runId: string;
						timestamp: string;
						[key: string]: unknown;
					}> = [];
					try {
						const eventStore = await loadEventStore(cwd);
						events = eventStore.getEventsByRunId(
							result.run.id,
						) as typeof events;
					} catch {
						// Event store unavailable (e.g., uninitialized in tests)
					}
					// Query learnings produced by this run
					let runLearnings: Array<{
						id: string;
						runId: string;
						scope: string;
						kind: string;
						title: string;
						body: string;
						status: string;
						createdAt: string;
						seenCount: number;
					}> = [];
					try {
						const memoryPort = await loadReadOnlyMemoryPort(cwd);
						if (memoryPort) {
							runLearnings = [
								...memoryPort.fetchLearningsByRunId(result.run.id),
							];
						}
					} catch {
						// Memory port unavailable
					}
					for (const line of formatInspectDetail(
						result as unknown as Parameters<typeof formatInspectDetail>[0],
						events,
						runLearnings,
					)) {
						stdout(line);
					}
				}
				return 0;
			}
			case "history": {
				const json = rest.includes("--json");
				const entries = await loadRunHistory(cwd);

				if (json) {
					stdout(formatJson(entries));
				} else {
					for (const line of formatRunHistory(
						entries as Array<{
							id: string;
							unitId: string;
							status: string;
							createdAt: string;
							completedAt?: string;
						}>,
					)) {
						stdout(line);
					}
				}
				return 0;
			}
			case "replay": {
				const runId = rest.find((v) => !v.startsWith("--"));
				if (!runId) {
					throw new Error("Missing required run id for replay.");
				}

				const json = rest.includes("--json");

				// Load packet snapshot from storage
				const storage = (await cliImport("@buildplane/storage")) as unknown as {
					createBuildplaneStorage: (root: string) => {
						getPacketSnapshot: (id: string) => unknown | null;
					};
				};
				const storageInst = storage.createBuildplaneStorage(cwd);
				const packet = storageInst.getPacketSnapshot(runId);

				if (!packet) {
					throw new Error(
						`Cannot replay run '${runId}': no packet snapshot found. Only runs created with the current version can be replayed.`,
					);
				}

				// Apply overrides
				const replayPacket = applyReplayOverrides(
					packet as Record<string, unknown>,
					rest,
				);

				// Create event bus with storage persistence
				const kernel = (await cliImport("@buildplane/kernel")) as unknown as {
					createEventBus: () => {
						subscribe: (listener: (event: unknown) => void) => () => void;
						emit: (event: unknown) => void;
					};
				};
				const storageForEvents = (await import(
					"@buildplane/storage"
				)) as unknown as {
					createEventStore: (root: string) => {
						persistEvent: (runId: string, event: unknown) => void;
					};
				};

				const replayBus = kernel.createEventBus();
				const eventStore = storageForEvents.createEventStore(cwd);
				replayBus.subscribe((event: unknown) => {
					const e = event as { runId?: string };
					if (e.runId) {
						try {
							eventStore.persistEvent(e.runId, event as never);
						} catch {
							// Silent
						}
					}
				});

				const result = await orchestrator.runPacketAsync(
					replayPacket,
					replayBus,
				);

				if (json) {
					stdout(
						formatJson({
							originalRunId: runId,
							replay: {
								runId: result.run.id,
								status: result.run.status,
							},
						}),
					);
				} else {
					stdout(`replay of: ${runId}`);
					for (const line of formatRunResult(
						result as { run: { id: string; status: string } },
					)) {
						stdout(line);
					}
				}

				return result.run.status === "passed" ? 0 : 1;
			}
			case "run-graph": {
				const graphIndex = rest.indexOf("--graph");
				if (graphIndex === -1 || !rest[graphIndex + 1]) {
					throw new Error("Missing required --graph <path> argument.");
				}
				const graphPath = resolve(cwd, rest[graphIndex + 1]);
				const rawGraph = JSON.parse(readFileSync(graphPath, "utf8")) as Record<
					string,
					unknown
				>;
				const graph = normalizeGraph(rawGraph);
				const enrichedGraph = await enrichGraphWithMemories(
					graph as Record<string, unknown>,
					memoryPort,
					honchoAdapter,
					userId,
				);

				const kernel = (await cliImport("@buildplane/kernel")) as unknown as {
					createEventBus: () => {
						subscribe: (listener: (event: unknown) => void) => () => void;
						emit: (event: unknown) => void;
					};
				};
				const graphBus = kernel.createEventBus();

				const graphResult = await orchestrator.runGraphAsync(
					enrichedGraph,
					graphBus,
				);

				stdout(`Graph Outcome: ${graphResult.outcome}`);
				for (const node of graphResult.nodes) {
					stdout(` - ${node.unitId}: ${node.status}`);
				}
				return graphResult.outcome === "passed" ? 0 : 1;
			}
			case "run-strategy": {
				const strategyIndex = rest.indexOf("--strategy");
				if (strategyIndex === -1 || !rest[strategyIndex + 1]) {
					throw new Error("Missing required --strategy <path> argument.");
				}
				const strategyPath = resolve(cwd, rest[strategyIndex + 1]);

				const kernel = (await cliImport("@buildplane/kernel")) as unknown as {
					parseStrategyPacket: (raw: unknown) => unknown;
					createEventBus: () => {
						subscribe: (listener: (event: unknown) => void) => () => void;
						emit: (event: unknown) => void;
					};
				};

				const rawStrategy = JSON.parse(readFileSync(strategyPath, "utf8"));
				const strategy = kernel.parseStrategyPacket(rawStrategy);
				const enrichedStrategy = await enrichStrategyWithMemories(
					strategy as Record<string, unknown>,
					memoryPort,
					honchoAdapter,
					userId,
				);
				const strategyBus = kernel.createEventBus();

				const strategyResult = await orchestrator.runStrategy(
					enrichedStrategy,
					strategyBus,
				);

				const json = rest.includes("--json");
				if (json) {
					stdout(
						formatJson(strategyResult as unknown as Record<string, unknown>),
					);
				} else {
					stdout(`Strategy: ${strategyResult.strategyId}`);
					stdout(`Mode: ${strategyResult.mode}`);
					stdout(`Outcome: ${strategyResult.outcome}`);
					stdout(
						`Merge: ${strategyResult.mergeDecision.policy} → ${strategyResult.mergeDecision.outcome}`,
					);
					if (strategyResult.winnerRunId) {
						stdout(`Winner Run: ${strategyResult.winnerRunId}`);
					}
					for (const reason of strategyResult.mergeDecision.reasons) {
						stdout(`  reason: ${reason}`);
					}
				}

				return strategyResult.outcome === "passed" ? 0 : 1;
			}
			default:
				throw new Error(`Unknown command: ${command}`);
		}
	} catch (error) {
		const { code, message } = classifyCliError(error);
		const jsonMode = rest.includes("--json");
		const formatted = jsonMode
			? formatJson(formatJsonError(code, message))
			: formatHumanError(message).join("\n");

		if (jsonMode) {
			stdout(formatted);
		} else {
			stderr(formatted);
		}

		return 1;
	}
}

function normalizeGraph(raw: Record<string, unknown>): unknown {
	const nodes = (raw.nodes as Record<string, unknown>[]) ?? [];
	return {
		...raw,
		nodes: nodes.map(normalizeGraphNode),
	};
}

function normalizeGraphNode(node: Record<string, unknown>): unknown {
	const unit = (node.unit as Record<string, unknown>) ?? {};

	// Normalize execution block: handle "entrypoint" alias for "command"
	const rawExecution = node.execution as Record<string, unknown> | undefined;
	let normalizedExecution: Record<string, unknown> | undefined;
	if (rawExecution) {
		const {
			kind: _kind,
			entrypoint,
			command,
			...restExec
		} = rawExecution as {
			kind?: unknown;
			entrypoint?: string;
			command?: string;
			[key: string]: unknown;
		};
		normalizedExecution = { command: command ?? entrypoint, ...restExec };
	}

	// Handle "dependencies" as alias for "dependsOn"
	const dependsOn = node.dependsOn ?? node.dependencies ?? [];

	return {
		...node,
		unit: {
			kind: "command",
			scope: "task",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "exit-0",
			policyProfile: "default",
			...unit,
		},
		dependsOn,
		execution: normalizedExecution,
		verification: node.verification ?? { requiredOutputs: [] },
	};
}

function applyReplayOverrides(
	packet: Record<string, unknown>,
	args: string[],
): unknown {
	const result = { ...packet };

	for (const arg of args) {
		if (arg.startsWith("--model=")) {
			const modelValue = arg.slice("--model=".length);
			const slashIndex = modelValue.indexOf("/");

			if (slashIndex > 0) {
				// --model=provider/model-name
				const provider = modelValue.slice(0, slashIndex);
				const model = modelValue.slice(slashIndex + 1);
				const existing = (result.model as Record<string, unknown>) ?? {};
				result.model = { ...existing, provider, model };
				// If switching to model execution, remove command execution
				delete result.execution;
			} else {
				// --model=model-name (keep existing provider)
				const existing = (result.model as Record<string, unknown>) ?? {};
				result.model = { ...existing, model: modelValue };
				delete result.execution;
			}
		} else if (arg.startsWith("--policy=")) {
			const policyProfile = arg.slice("--policy=".length);
			const unit = (result.unit as Record<string, unknown>) ?? {};
			result.unit = { ...unit, policyProfile };
		}
	}

	return result;
}

function classifyCliError(error: unknown): { code: string; message: string } {
	const message = error instanceof Error ? error.message : String(error);

	if (error instanceof NativeCommandDispatchError) {
		return { code: NATIVE_COMMAND_DISPATCH_ERROR_CODE, message };
	}

	if (/not initialized/i.test(message)) {
		return { code: "NOT_INITIALIZED", message };
	}

	if (/No run or unit found/i.test(message)) {
		return { code: "NOT_FOUND", message };
	}

	if (
		error instanceof SyntaxError ||
		/packet\./i.test(message) ||
		/Missing required --packet/i.test(message) ||
		/ENOENT/i.test(message)
	) {
		return { code: "INVALID_PACKET", message };
	}

	return { code: "CLI_ERROR", message };
}
