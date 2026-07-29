import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import {
	carriesGovernanceFields,
	type EventBus,
	type ExecutionReceipt,
	type TaskRenderer,
	type UnitPacket,
} from "@buildplane/kernel";

export interface CodexExecutorOptions {
	/** default: "codex" */
	cliBinary?: string;
	/** default: 300_000 (5 min) */
	timeoutMs?: number;
	/** Override spawn for testing. */
	spawnFn?: typeof spawn;
	/**
	 * Renderer used to convert packet.intent into a prompt.
	 * When present and packet.intent exists, the rendered prompt takes
	 * precedence over packet.model.prompt.
	 */
	renderer?: TaskRenderer;
}

export interface CodexExecutorPort {
	executePacket(packet: UnitPacket, projectRoot: string): ExecutionReceipt;
	executePacketAsync(
		packet: UnitPacket,
		projectRoot: string,
		eventBus: EventBus,
	): Promise<ExecutionReceipt>;
}

function resolveCommandOnPath(command: string): string | undefined {
	const explicitPath = resolve(command);
	if (command.includes("/") || command.includes("\\")) {
		return existsSync(explicitPath) ? explicitPath : undefined;
	}

	const pathEnv = process.env.PATH ?? "";
	const pathDelimiter = process.platform === "win32" ? ";" : delimiter;
	const extensions =
		process.platform === "win32" ? ["", ".exe", ".cmd", ".bat", ".com"] : [""];

	for (const entry of pathEnv.split(pathDelimiter)) {
		if (!entry) continue;
		for (const extension of extensions) {
			const candidate = join(entry, `${command}${extension}`);
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}

	return undefined;
}

function resolveCodexSpawnTarget(cliBinary: string): {
	command: string;
	argsPrefix: string[];
} {
	const resolvedBinary = resolveCommandOnPath(cliBinary);
	if (!resolvedBinary) {
		return { command: cliBinary, argsPrefix: [] };
	}

	if (process.platform !== "win32") {
		return { command: resolvedBinary, argsPrefix: [] };
	}

	if (!/\.(cmd|bat)$/i.test(resolvedBinary)) {
		return { command: resolvedBinary, argsPrefix: [] };
	}

	const siblingJs = resolvedBinary.replace(/\.(cmd|bat)$/i, ".js");
	if (existsSync(siblingJs)) {
		return { command: process.execPath, argsPrefix: [siblingJs] };
	}

	const localNodeModulesJs = join(
		dirname(dirname(resolvedBinary)),
		"@openai",
		"codex",
		"bin",
		"codex.js",
	);
	if (existsSync(localNodeModulesJs)) {
		return { command: process.execPath, argsPrefix: [localNodeModulesJs] };
	}

	const npmShimJs = join(
		dirname(resolvedBinary),
		"node_modules",
		"@openai",
		"codex",
		"bin",
		"codex.js",
	);
	if (existsSync(npmShimJs)) {
		return { command: process.execPath, argsPrefix: [npmShimJs] };
	}

	return { command: resolvedBinary, argsPrefix: [] };
}

export function createCodexExecutor(
	options?: CodexExecutorOptions,
): CodexExecutorPort {
	const cliBinary = options?.cliBinary ?? "codex";
	const timeoutMs = options?.timeoutMs ?? 300_000;
	const spawnFn = options?.spawnFn ?? spawn;
	const renderer = options?.renderer;

	return {
		executePacket(_packet: UnitPacket, _projectRoot: string): ExecutionReceipt {
			throw new Error("Codex executor requires async execution path");
		},

		async executePacketAsync(
			packet: UnitPacket,
			projectRoot: string,
			eventBus: EventBus,
		): Promise<ExecutionReceipt> {
			assertAmbientHostWorkerIsRawOnly(packet, "Codex");
			const startedAt = new Date().toISOString();

			if (packet.execution) {
				throw new Error(
					"CodexExecutor does not support command packets. Pass a model packet with a prompt.",
				);
			}

			if (!packet.model) {
				throw new Error("Packet must have a model block.");
			}

			const model = packet.model.model;

			// Resolve prompt: intent + renderer takes precedence over model.prompt
			let prompt: string;
			if (packet.intent && renderer) {
				const rendered = renderer.render(packet.intent, packet.execution_role);
				const systemParts = [packet.model.systemPrompt, rendered.system].filter(
					(part): part is string => typeof part === "string" && part.length > 0,
				);
				prompt =
					systemParts.length > 0
						? `${systemParts.join("\n\n---\n\n")}\n\n---\n\n${rendered.prompt}`
						: rendered.prompt;
			} else if (packet.model.prompt) {
				prompt = packet.model.systemPrompt
					? `${packet.model.systemPrompt}\n\n---\n\n${packet.model.prompt}`
					: packet.model.prompt;
			} else {
				throw new Error(
					"Packet must have either a model.prompt or an intent with a renderer.",
				);
			}

			const spawnTarget = resolveCodexSpawnTarget(cliBinary);
			const args = [
				...spawnTarget.argsPrefix,
				"-q",
				"--model",
				model,
				"--full-auto",
				prompt,
			];

			eventBus.emit({
				kind: "execution-started",
				runId: "",
				timestamp: startedAt,
				executionType: "command",
			});

			return new Promise<ExecutionReceipt>((resolvePromise) => {
				const child = spawnFn(spawnTarget.command, args, { cwd: projectRoot });

				let stdoutBuf = "";
				let stderrBuf = "";
				let timedOut = false;
				let exitCode = 0;
				let resolved = false;

				const resolveOnce = (receipt: ExecutionReceipt) => {
					if (resolved) return;
					resolved = true;

					const outputChecks = packet.verification.requiredOutputs.map(
						(path) => ({
							path,
							exists: existsSync(resolve(projectRoot, path)),
						}),
					);

					eventBus.emit({
						kind: "command-execution-complete",
						runId: "",
						timestamp: receipt.completedAt,
						exitCode: receipt.exitCode,
						outputChecks,
					});

					resolvePromise({ ...receipt, outputChecks });
				};

				const timer = setTimeout(() => {
					timedOut = true;
					child.kill();
					stderrBuf = `Timeout after ${timeoutMs}ms`;
					exitCode = -1;
				}, timeoutMs);

				child.stdout?.on("data", (chunk: Buffer | string) => {
					stdoutBuf += chunk.toString();
				});

				child.stderr?.on("data", (chunk: Buffer | string) => {
					stderrBuf += chunk.toString();
				});

				child.on("error", (err: Error) => {
					clearTimeout(timer);
					stderrBuf = err.message.includes("ENOENT")
						? `Codex binary not found: '${cliBinary}'. Install codex CLI and ensure it is on PATH.`
						: err.message;
					exitCode = 1;

					resolveOnce({
						command: cliBinary,
						args,
						cwd: projectRoot,
						startedAt,
						completedAt: new Date().toISOString(),
						exitCode,
						stdout: stdoutBuf,
						stderr: stderrBuf,
						outputChecks: [],
					});
				});

				child.on("close", (code: number | null) => {
					clearTimeout(timer);

					if (!timedOut) {
						exitCode = code ?? 0;
					}

					resolveOnce({
						command: cliBinary,
						args,
						cwd: projectRoot,
						startedAt,
						completedAt: new Date().toISOString(),
						exitCode,
						stdout: stdoutBuf,
						stderr: stderrBuf,
						outputChecks: [],
					});
				});
			});
		},
	};
}

function assertAmbientHostWorkerIsRawOnly(
	packet: UnitPacket,
	workerName: string,
): void {
	if (carriesGovernanceFields(packet)) {
		throw new Error(
			`AMBIENT_HOST_WORKER_FORBIDDEN: ${workerName} CLI is raw-only and cannot execute a packet carrying governed authority fields.`,
		);
	}
}
