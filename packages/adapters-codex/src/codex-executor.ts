import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
	EventBus,
	ExecutionReceipt,
	TaskRenderer,
	UnitPacket,
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
				const rendered = renderer.render(packet.intent, "implementer");
				prompt = rendered.system
					? `${rendered.system}\n\n---\n\n${rendered.prompt}`
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

			const args = ["-q", "--model", model, "--full-auto", prompt];

			eventBus.emit({
				kind: "execution-started",
				runId: "",
				timestamp: startedAt,
				executionType: "command",
			});

			return new Promise<ExecutionReceipt>((resolvePromise) => {
				const child = spawnFn(cliBinary, args, { cwd: projectRoot });

				let stdoutBuf = "";
				let stderrBuf = "";
				let timedOut = false;
				let exitCode = 0;

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

					const completedAt = new Date().toISOString();
					const outputChecks = packet.verification.requiredOutputs.map(
						(path) => ({
							path,
							exists: existsSync(resolve(projectRoot, path)),
						}),
					);

					eventBus.emit({
						kind: "command-execution-complete",
						runId: "",
						timestamp: completedAt,
						exitCode,
						outputChecks,
					});

					resolvePromise({
						command: cliBinary,
						args,
						cwd: projectRoot,
						startedAt,
						completedAt,
						exitCode,
						stdout: stdoutBuf,
						stderr: stderrBuf,
						outputChecks,
					});
				});

				child.on("close", (code: number | null) => {
					clearTimeout(timer);

					if (!timedOut) {
						exitCode = code ?? 0;
					}

					const completedAt = new Date().toISOString();

					const outputChecks = packet.verification.requiredOutputs.map(
						(path) => ({
							path,
							exists: existsSync(resolve(projectRoot, path)),
						}),
					);

					eventBus.emit({
						kind: "command-execution-complete",
						runId: "",
						timestamp: completedAt,
						exitCode,
						outputChecks,
					});

					resolvePromise({
						command: cliBinary,
						args,
						cwd: projectRoot,
						startedAt,
						completedAt,
						exitCode,
						stdout: stdoutBuf,
						stderr: stderrBuf,
						outputChecks,
					});
				});
			});
		},
	};
}
