import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { UnitPacket } from "@buildplane/kernel";
import {
	formatHumanError,
	formatInitializationResult,
	formatInspectResult,
	formatJson,
	formatJsonError,
	formatRunFailure,
	formatRunResult,
	formatStatusResult,
} from "./formatters.js";

export interface RunCliDependencies {
	readonly createOrchestrator?: (
		projectRoot: string,
	) => Promise<BuildplaneCliOrchestrator> | BuildplaneCliOrchestrator;
	readonly parsePacket?: (
		packetPath: string,
	) => Promise<UnitPacket> | UnitPacket;
}

export interface RunCliOptions {
	readonly cwd?: string;
	readonly stdout?: (line: string) => void;
	readonly stderr?: (line: string) => void;
	readonly dependencies?: RunCliDependencies;
}

interface BuildplaneCliOrchestrator {
	initializeProject(): {
		created: boolean;
		projectRoot: string;
		stateDbPath: string;
	};
	runPacket(packet: UnitPacket): {
		run: { id: string; status: string };
		receipt?: unknown;
		decision?: unknown;
		failure?: { kind: string; message: string };
		workspace?: {
			path: string;
			headSha: string;
			status: "active" | "deleted" | "retained" | "cleanup-failed";
			finalizedAt?: string;
			cleanupError?: string;
			existsOnDisk?: boolean;
		};
	};
	getStatus(): {
		initialized: boolean;
		latestRun?: { id: string; unitId: string; status: string };
		latestRunUsedWorkspace: boolean;
		latestWorkspace?: {
			runId: string;
			path?: string;
			headSha: string;
			status: "active" | "deleted" | "retained" | "cleanup-failed";
			finalizedAt?: string;
			cleanupError?: string;
		};
		actionableWorkspaces: readonly unknown[];
		runCounts: {
			pending: number;
			running: number;
			passed: number;
			failed: number;
			cancelled: number;
		};
	};
	inspect(id: string): {
		kind: string;
		unit: { id: string };
		run: { id: string; unitId?: string; status: string };
		workspace?: {
			runId: string;
			path: string;
			headSha: string;
			status: "active" | "deleted" | "retained" | "cleanup-failed";
			finalizedAt?: string;
			cleanupError?: string;
			existsOnDisk?: boolean;
		};
		runHistory: readonly { id: string; status: string }[];
		evidence: readonly {
			kind: string;
			status: string;
			message?: string;
		}[];
		decisions: readonly {
			kind: string;
			outcome: string;
			reasons: readonly string[];
		}[];
		artifacts: readonly { type: string; location: string }[];
	};
}

async function loadCliOrchestrator(
	projectRoot: string,
): Promise<BuildplaneCliOrchestrator> {
	const kernel = (await import("@buildplane/kernel")) as unknown as {
		createBuildplaneOrchestrator: (options: {
			projectRoot: string;
			storage: unknown;
			runtime: { executePacket: (packet: UnitPacket, root: string) => unknown };
			policy: {
				evaluateRun: (packet: UnitPacket, receipt: unknown) => unknown;
			};
			workspace: unknown;
		}) => BuildplaneCliOrchestrator;
	};
	const runtime = (await import("@buildplane/runtime")) as unknown as {
		executePacket: (packet: unknown, root: string) => unknown;
	};
	const policy = (await import("@buildplane/policy")) as unknown as {
		evaluateRun: (packet: unknown, receipt: unknown) => unknown;
	};
	const storage = (await import("@buildplane/storage")) as unknown as {
		createBuildplaneStorage: (root: string) => unknown;
	};
	const workspace = (await import("@buildplane/adapters-git")) as unknown as {
		createGitWorkspaceAdapter: () => unknown;
	};

	return kernel.createBuildplaneOrchestrator({
		projectRoot,
		storage: storage.createBuildplaneStorage(projectRoot),
		runtime: { executePacket: runtime.executePacket },
		policy: { evaluateRun: policy.evaluateRun },
		workspace: workspace.createGitWorkspaceAdapter(),
	});
}

async function loadPacket(packetPath: string): Promise<UnitPacket> {
	const kernel = (await import("@buildplane/kernel")) as unknown as {
		parseUnitPacket: (input: string) => UnitPacket;
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
	const createOrchestrator =
		options.dependencies?.createOrchestrator ?? loadCliOrchestrator;
	const parsePacket = options.dependencies?.parsePacket ?? loadPacket;
	const [command, ...rest] = argv;

	if (!command) {
		stdout("Buildplane by SollanSystems");
		return 0;
	}

	try {
		const orchestrator = await createOrchestrator(cwd);

		switch (command) {
			case "init": {
				const result = orchestrator.initializeProject();
				emitLines(stdout, formatInitializationResult(result));
				return 0;
			}
			case "run": {
				orchestrator.getStatus();

				const packetIndex = rest.indexOf("--packet");
				if (packetIndex === -1 || !rest[packetIndex + 1]) {
					throw new Error("Missing required --packet <path> argument.");
				}

				const packetPath = resolve(cwd, rest[packetIndex + 1]);
				const packet = await parsePacket(packetPath);
				const result = orchestrator.runPacket(packet);

				emitLines(stdout, formatRunResult(result));
				emitLines(stderr, formatRunFailure(result));

				return result.run.status === "passed" && !result.failure ? 0 : 1;
			}
			case "status": {
				const json = rest.includes("--json");
				const result = orchestrator.getStatus();

				if (json) {
					stdout(formatJson(result));
				} else {
					emitLines(stdout, formatStatusResult(result));
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
					emitLines(stdout, formatInspectResult(result));
				}
				return 0;
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

function emitLines(
	write: (line: string) => void,
	lines: readonly string[],
): void {
	for (const line of lines) {
		write(line);
	}
}
