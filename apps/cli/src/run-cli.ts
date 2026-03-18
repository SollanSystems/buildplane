import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	formatHumanError,
	formatInitializationResult,
	formatJson,
	formatJsonError,
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
			runtime: { executePacket: (packet: unknown, root: string) => unknown };
			policy: { evaluateRun: (packet: unknown, receipt: unknown) => unknown };
		}) => BuildplaneCliOrchestrator;
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
	};

	return kernel.createBuildplaneOrchestrator({
		projectRoot,
		storage: storage.createBuildplaneStorage(projectRoot),
		runtime: { executePacket: runtime.executePacket },
		policy: { evaluateRun: policy.evaluateRun },
	});
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
				stdout(
					json
						? formatJson(result)
						: `inspect: ${result.kind} ${result.run.id}`,
				);
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
