import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
	EventBus,
	ExecutionReceipt,
	ExecutionRole,
	TaskRenderer,
	UnitPacket,
} from "@buildplane/kernel";

export interface ClaudeCodeExecutorOptions {
	/** default: "claude" */
	cliBinary?: string;
	/** default: 300_000 (5 min) */
	timeoutMs?: number;
	/** default: 20 */
	maxTurns?: number;
	/** Override spawn for testing. */
	spawnFn?: typeof spawn;
	/**
	 * Renderer used to convert packet.intent into a prompt.
	 * When present and packet.intent exists, the rendered prompt takes
	 * precedence over packet.model.prompt.
	 */
	renderer?: TaskRenderer;
}

export interface ClaudeCodeExecutorPort {
	executePacket(packet: UnitPacket, projectRoot: string): ExecutionReceipt;
	executePacketAsync(
		packet: UnitPacket,
		projectRoot: string,
		eventBus: EventBus,
	): Promise<ExecutionReceipt>;
}

export function createClaudeCodeExecutor(
	options?: ClaudeCodeExecutorOptions,
): ClaudeCodeExecutorPort {
	const cliBinary = options?.cliBinary ?? "claude";
	const timeoutMs = options?.timeoutMs ?? 300_000;
	const maxTurns = options?.maxTurns ?? 50;
	const spawnFn = options?.spawnFn ?? spawn;
	const renderer = options?.renderer;

	return {
		executePacket(_packet: UnitPacket, _projectRoot: string): ExecutionReceipt {
			throw new Error("Claude Code executor requires async execution path");
		},

		async executePacketAsync(
			packet: UnitPacket,
			projectRoot: string,
			eventBus: EventBus,
		): Promise<ExecutionReceipt> {
			const startedAt = new Date().toISOString();

			// Validate: must be a model packet, not a command packet
			if (packet.execution) {
				throw new Error(
					"ClaudeCodeExecutor does not support command packets. Pass a model packet instead.",
				);
			}

			if (!packet.model) {
				throw new Error("Packet must have a model block.");
			}

			// Validate tools are not present (claude code CLI doesn't accept inline tool defs)
			if (packet.model.tools && packet.model.tools.length > 0) {
				throw new Error(
					"ClaudeCodeExecutor does not support inline tool definitions. Remove model.tools from the packet.",
				);
			}

			// Resolve prompt: intent + renderer takes precedence over model.prompt
			let foldedPrompt: string;
			if (packet.intent && renderer) {
				const role: ExecutionRole = "implementer";
				const rendered = renderer.render(packet.intent, role);
				foldedPrompt = rendered.system
					? `${rendered.system}\n\n---\n\n${rendered.prompt}`
					: rendered.prompt;
			} else if (packet.model.prompt) {
				// Legacy path: plain prompt with optional system prompt
				foldedPrompt = packet.model.systemPrompt
					? `${packet.model.systemPrompt}\n\n---\n\n${packet.model.prompt}`
					: packet.model.prompt;
			} else {
				throw new Error(
					"Packet must have either a model.prompt or an intent with a renderer.",
				);
			}

			// Build CLI args
			const args = [
				"-p",
				foldedPrompt,
				"--output-format",
				"json",
				"--model",
				packet.model.model,
				"--max-turns",
				String(maxTurns),
				"--dangerously-skip-permissions",
			];

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

				child.on("close", (code: number | null) => {
					clearTimeout(timer);

					if (!timedOut) {
						exitCode = code ?? 0;
					}

					// Try to parse stdout as JSON and emit event
					if (stdoutBuf.trim()) {
						try {
							const parsed = JSON.parse(stdoutBuf) as Record<string, unknown>;
							// Look for .result or text content
							let text: string | undefined;
							if (typeof parsed.result === "string") {
								text = parsed.result;
							} else if (typeof parsed.text === "string") {
								text = parsed.text;
							} else if (typeof parsed.content === "string") {
								text = parsed.content;
							}

							if (text !== undefined) {
								const completedAt = new Date().toISOString();
								eventBus.emit({
									kind: "model-response-complete",
									runId: "",
									timestamp: completedAt,
									text,
									finishReason: "stop",
									usage: undefined,
								});
							}
						} catch {
							// Malformed JSON — skip event, don't fabricate
						}
					}

					const completedAt = new Date().toISOString();

					const outputChecks = packet.verification.requiredOutputs.map(
						(path) => ({
							path,
							exists: existsSync(resolve(projectRoot, path)),
						}),
					);

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
