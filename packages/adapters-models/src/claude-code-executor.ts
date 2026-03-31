import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
	EventBus,
	ExecutionReceipt,
	ModelResponseCompleteEvent,
	UnitPacket,
} from "@buildplane/kernel";

export interface ClaudeCodeExecutorOptions {
	/** Path to the claude CLI binary. Default: "claude" */
	cliBinary?: string;
	/** Timeout in ms for the subprocess. Default: 300_000 */
	timeoutMs?: number;
	/** Max agentic turns. Default: 20 */
	maxTurns?: number;
	/** Spawn function override for testing. */
	spawnFn?: typeof spawn;
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
	options: ClaudeCodeExecutorOptions = {},
): ClaudeCodeExecutorPort {
	const cliBinary = options.cliBinary ?? "claude";
	const timeoutMs = options.timeoutMs ?? 300_000;
	const maxTurns = options.maxTurns ?? 20;
	const spawnFn = options.spawnFn ?? spawn;

	function validatePacket(packet: UnitPacket): void {
		if (!packet.model) {
			throw new Error(
				"Claude Code executor requires a model packet, not a command packet.",
			);
		}
		if (!packet.model.prompt) {
			throw new Error("Claude Code executor requires model.prompt to be set.");
		}
		if (packet.model.tools) {
			throw new Error(
				"Claude Code executor does not support model.tools — Claude Code manages its own tools.",
			);
		}
	}

	function buildEnvelope(packet: UnitPacket): string {
		const model = packet.model!;
		if (model.systemPrompt) {
			return `${model.systemPrompt}\n\n---\n\n${model.prompt}`;
		}
		return model.prompt!;
	}

	function buildArgs(
		envelope: string,
		modelId: string,
		workspacePath: string,
	): string[] {
		return [
			"-p",
			envelope,
			"--output-format",
			"json",
			"--model",
			modelId,
			"--max-turns",
			String(maxTurns),
			"--cwd",
			workspacePath,
		];
	}

	return {
		executePacket(_packet: UnitPacket, _projectRoot: string): ExecutionReceipt {
			throw new Error(
				"Claude Code executor does not support sync execution. Use executePacketAsync.",
			);
		},

		async executePacketAsync(
			packet: UnitPacket,
			projectRoot: string,
			eventBus: EventBus,
		): Promise<ExecutionReceipt> {
			validatePacket(packet);

			const envelope = buildEnvelope(packet);
			const args = buildArgs(envelope, packet.model!.model, projectRoot);
			const startedAt = new Date().toISOString();

			return new Promise<ExecutionReceipt>((resolvePromise, rejectPromise) => {
				let stdout = "";
				let stderr = "";
				let timedOut = false;

				const child: ChildProcess = spawnFn(cliBinary, args, {
					cwd: projectRoot,
					stdio: ["ignore", "pipe", "pipe"],
				});

				const timer = setTimeout(() => {
					timedOut = true;
					child.kill("SIGTERM");
				}, timeoutMs);

				child.stdout?.on("data", (chunk: Buffer) => {
					stdout += chunk.toString();
					// Never emit model-token-delta from subprocess stdout
				});

				child.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});

				child.on("error", (err: Error) => {
					clearTimeout(timer);
					rejectPromise(err);
				});

				child.on("close", (exitCode: number | null) => {
					clearTimeout(timer);
					const completedAt = new Date().toISOString();
					const code = timedOut ? 124 : (exitCode ?? 1);

					// Try to parse stdout as JSON and emit model-response-complete
					try {
						const parsed = JSON.parse(stdout);
						if (parsed && typeof parsed.result === "string") {
							eventBus.emit({
								kind: "model-response-complete",
								runId: "",
								timestamp: completedAt,
								text: parsed.result,
								finishReason: "end_turn",
							} satisfies ModelResponseCompleteEvent);
						}
					} catch {
						// Malformed JSON — no event emitted
					}

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
						exitCode: code,
						stdout,
						stderr,
						outputChecks,
					});
				});
			});
		},
	};
}
