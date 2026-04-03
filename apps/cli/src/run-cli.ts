import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	formatHumanError,
	formatInitializationResult,
	formatInspectDetail,
	formatJson,
	formatJsonError,
	formatRunHistory,
	formatRunResult,
} from "./formatters.js";

export interface RunCliOptions {
	readonly cwd?: string;
	readonly stdout?: (line: string) => void;
	readonly stderr?: (line: string) => void;
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
	getStatus(): { initialized: boolean } & Record<string, unknown>;
	inspect(
		id: string,
	): { kind: string; run: { id: string } } & Record<string, unknown>;
}

async function loadCliOrchestrator(
	projectRoot: string,
): Promise<BuildplaneCliOrchestrator> {
	const kernel = (await import("@buildplane/kernel")) as unknown as {
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
			eventBus?: unknown;
		}) => BuildplaneCliOrchestrator;
		createEventBus: () => {
			subscribe: (listener: (event: unknown) => void) => () => void;
			emit: (event: unknown) => void;
		};
		parseUnitPacket: (input: string) => unknown;
	};
	const runtime = (await import("@buildplane/runtime")) as unknown as {
		executePacket: (packet: unknown, root: string) => unknown;
	};
	const policy = (await import("@buildplane/policy")) as unknown as {
		evaluateRun: (packet: unknown, receipt: unknown) => unknown;
	};
	const storage = (await import("@buildplane/storage")) as unknown as {
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

	// Runtime router: selects executor based on packet type and routing hints
	const adaptersModels = (await import(
		"@buildplane/adapters-models"
	)) as unknown as {
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

	const sdkExecutor = adaptersModels.createModelExecutor();
	const claudeExecutor = adaptersModels.createClaudeCodeExecutor();

	const runtimeRouter = {
		executePacket(packet: unknown, root: string) {
			const p = packet as { execution?: unknown; model?: unknown };
			if (p.execution) return runtime.executePacket(packet, root);
			throw new Error("Model packets require async execution path");
		},
		async executePacketAsync(packet: unknown, root: string, bus: unknown) {
			const p = packet as {
				execution?: unknown;
				model?: unknown;
				routingHints?: { preferredWorker?: string };
			};
			if (p.execution) return runtime.executePacket(packet, root);
			if (p.routingHints?.preferredWorker === "claude-code") {
				return claudeExecutor.executePacketAsync(packet, root, bus);
			}
			return sdkExecutor.executePacketAsync(packet, root, bus);
		},
	};

	return kernel.createBuildplaneOrchestrator({
		projectRoot,
		storage: storage.createBuildplaneStorage(projectRoot),
		runtime: runtimeRouter,
		policy: { evaluateRun: policy.evaluateRun },
		eventBus,
	});
}

async function loadEventStore(projectRoot: string): Promise<{
	getEventsByRunId: (runId: string) => unknown[];
}> {
	const storage = (await import("@buildplane/storage")) as unknown as {
		createEventStore: (root: string) => {
			getEventsByRunId: (runId: string) => unknown[];
		};
	};
	return storage.createEventStore(projectRoot);
}

async function loadRunHistory(projectRoot: string): Promise<unknown[]> {
	const storage = (await import("@buildplane/storage")) as unknown as {
		createBuildplaneStorage: (root: string) => {
			getRunHistory: () => unknown[];
		};
	};
	return storage.createBuildplaneStorage(projectRoot).getRunHistory();
}

async function loadPacket(packetPath: string): Promise<unknown> {
	const kernel = (await import("@buildplane/kernel")) as unknown as {
		parseUnitPacket: (input: string) => unknown;
	};

	return kernel.parseUnitPacket(readFileSync(packetPath, "utf8"));
}

export async function runCli(
	argv: string[],
	options: RunCliOptions = {},
): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const stdout = options.stdout ?? ((line: string) => console.log(line));
	const stderr = options.stderr ?? ((line: string) => console.error(line));
	const orchestrator = await loadCliOrchestrator(cwd);
	const [command, ...rest] = argv;

	if (!command) {
		stdout("Buildplane by SollanSystems");
		return 0;
	}

	try {
		switch (command) {
			case "init": {
				const result = orchestrator.initializeProject();
				for (const line of formatInitializationResult(result)) {
					stdout(line);
				}
				return 0;
			}
			case "run": {
				const packetIndex = rest.indexOf("--packet");
				if (packetIndex === -1 || !rest[packetIndex + 1]) {
					throw new Error("Missing required --packet <path> argument.");
				}

				const packetPath = resolve(cwd, rest[packetIndex + 1]);
				const packet = await loadPacket(packetPath);
				const useTui = rest.includes("--tui");
				const isModelPacket = !!(packet as { model?: unknown }).model;
				const useAsync = useTui || isModelPacket;

				if (useAsync && !useTui) {
					// Model packets auto-switch to async (no TUI)
					const result = await orchestrator.runPacketAsync(packet);

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
					const kernel = (await import("@buildplane/kernel")) as unknown as {
						createEventBus: () => {
							subscribe: (listener: (event: unknown) => void) => () => void;
							emit: (event: unknown) => void;
						};
					};
					const tui = (await import("@buildplane/ui-tui")) as unknown as {
						renderTui: (eventBus: unknown) => {
							waitUntilExit(): Promise<void>;
							unmount(): void;
							clear(): void;
						};
					};
					const storage = (await import("@buildplane/storage")) as unknown as {
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

					const result = await orchestrator.runPacketAsync(packet, tuiBus);
					await tuiInstance.waitUntilExit();

					return result.run.status === "passed" ? 0 : 1;
				}

				const result = orchestrator.runPacket(packet);

				for (const line of formatRunResult(result)) {
					stdout(line);
				}

				return result.run.status === "passed" ? 0 : 1;
			}
			case "status": {
				const json = rest.includes("--json");
				const result = orchestrator.getStatus();

				stdout(
					json ? formatJson(result) : `initialized: ${result.initialized}`,
				);
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
					const eventStore = await loadEventStore(cwd);
					const events = eventStore.getEventsByRunId(result.run.id) as Array<{
						kind: string;
						runId: string;
						timestamp: string;
						[key: string]: unknown;
					}>;
					for (const line of formatInspectDetail(
						result as unknown as Parameters<typeof formatInspectDetail>[0],
						events,
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
				const storage = (await import("@buildplane/storage")) as unknown as {
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
				const kernel = (await import("@buildplane/kernel")) as unknown as {
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
