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

const CLAUDE_UNSAFE_PERMISSION_FLAG = [
	"--dangerously",
	"skip",
	"permissions",
].join("-");

/**
 * Per-tool-call event parsed out of the Claude Code `stream-json` worker
 * output. The executor stays transport-agnostic: it emits the parsed shape to
 * the `onToolEvent` callback and never constructs ledger payloads itself.
 *
 * - `request` mirrors an `assistant` message `tool_use` content block.
 * - `result` mirrors the matching `user` message `tool_result` content block,
 *   correlated by `toolUseId` (== claude's `tool_use_id`).
 */
export type ClaudeToolEvent =
	| {
			readonly phase: "request";
			readonly toolUseId: string;
			readonly toolName: string;
			readonly input: Record<string, unknown>;
	  }
	| {
			readonly phase: "result";
			readonly toolUseId: string;
			readonly content: string;
			readonly isError: boolean;
	  };

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
	 * Opt into Claude Code's ambient-permission bypass for local development.
	 * Defaults to false. When enabled, the executor emits an evidence event
	 * before spawning the worker so unsafe authority is never silent.
	 */
	unsafeMode?: boolean;
	/**
	 * Claude Code tool-permission grant, passed as `--allowedTools <tool...>`. In
	 * headless `-p` mode Claude denies Edit/Write/Bash unless the tool is granted,
	 * so a dogfood worker with no grant makes zero edits (every Write is denied).
	 * Absent or empty → the flag is omitted and Claude's default-deny stands. This
	 * grants a worker the authority to act; scope stays bounded post-hoc by the M4
	 * diff-scope + acceptance contract, NOT by withholding the grant. This is the
	 * safe alternative to `unsafeMode`/`--dangerously-skip-permissions` (denied by
	 * the GAP-10 guard) — it names the exact allowed tools instead of bypassing all
	 * permission checks.
	 */
	allowedTools?: readonly string[];
	/**
	 * Renderer used to convert packet.intent into a prompt.
	 * When present and packet.intent exists, the rendered prompt takes
	 * precedence over packet.model.prompt.
	 */
	renderer?: TaskRenderer;
	/**
	 * Per-tool-call sink, invoked once per parsed `tool_use` / `tool_result`
	 * stream-json block. Mirrors the `onCapabilityDenied` callback shape: the
	 * executor parses + forwards, the caller maps it onto the ledger. Absent →
	 * tool blocks are parsed only for the existing token-delta path.
	 */
	onToolEvent?: (event: ClaudeToolEvent) => void;
}

/** One content block inside a stream-json `assistant`/`user` message. */
interface ClaudeContentBlock {
	type?: string;
	text?: string;
	id?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
	content?: unknown;
	is_error?: boolean;
}

/**
 * Normalize a `tool_result` block's `content` to a flat string. Claude emits it
 * either as a bare string or as an array of `{ type: "text", text }` blocks.
 */
function normalizeToolResultContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) =>
				block &&
				typeof block === "object" &&
				typeof (block as { text?: unknown }).text === "string"
					? (block as { text: string }).text
					: "",
			)
			.join("");
	}
	return "";
}

export interface ClaudeCodeExecutorPort {
	executePacket(packet: UnitPacket, projectRoot: string): ExecutionReceipt;
	executePacketAsync(
		packet: UnitPacket,
		projectRoot: string,
		eventBus: EventBus,
		signal?: AbortSignal,
	): Promise<ExecutionReceipt>;
}

/**
 * Receipt for a run aborted before the child was ever spawned. exitCode -1 so the
 * policy evaluator rejects it; carries no output checks because nothing executed.
 */
function abortedReceipt(
	cliBinary: string,
	args: readonly string[],
): ExecutionReceipt {
	const now = new Date().toISOString();
	return {
		command: cliBinary,
		args: [...args],
		cwd: "",
		startedAt: now,
		completedAt: now,
		exitCode: -1,
		stdout: "",
		stderr: "aborted before spawn",
		outputChecks: [],
	};
}

export function createClaudeCodeExecutor(
	options?: ClaudeCodeExecutorOptions,
): ClaudeCodeExecutorPort {
	const cliBinary = options?.cliBinary ?? "claude";
	const timeoutMs = options?.timeoutMs ?? 300_000;
	const maxTurns = options?.maxTurns ?? 50;
	const spawnFn = options?.spawnFn ?? spawn;
	const unsafeMode = options?.unsafeMode ?? false;
	const allowedTools = options?.allowedTools;
	const renderer = options?.renderer;
	const onToolEvent = options?.onToolEvent;

	return {
		executePacket(_packet: UnitPacket, _projectRoot: string): ExecutionReceipt {
			throw new Error("Claude Code executor requires async execution path");
		},

		async executePacketAsync(
			packet: UnitPacket,
			projectRoot: string,
			eventBus: EventBus,
			signal?: AbortSignal,
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

			// Build CLI args. Claude Code permissions are preserved by default;
			// unsafeMode is an explicit development escape hatch and is recorded
			// before spawn so ambient authority is never silent.
			const args = [
				"-p",
				foldedPrompt,
				"--output-format",
				"stream-json",
				"--verbose",
				"--model",
				packet.model.model,
				"--max-turns",
				String(maxTurns),
			];

			// Tool-permission grant (R7 FIX 1). Naming the allowed tools lets a
			// headless worker Edit/Write/Read/Glob/Grep/Bash without bypassing all
			// permission checks. Omitted when unset/empty so default-deny stands.
			if (allowedTools && allowedTools.length > 0) {
				args.push("--allowedTools", ...allowedTools);
			}

			if (unsafeMode) {
				args.push(CLAUDE_UNSAFE_PERMISSION_FLAG);
				eventBus.emit({
					kind: "evidence-recorded",
					runId: "",
					timestamp: new Date().toISOString(),
					evidenceKind: "claude-code-unsafe-mode-used",
					status: "unsafe-mode-used",
				});
			}

			return new Promise<ExecutionReceipt>((resolvePromise) => {
				// Already aborted before spawn: never start the child.
				if (signal?.aborted) {
					resolvePromise(abortedReceipt(cliBinary, args));
					return;
				}

				const child = spawnFn(cliBinary, args, { cwd: projectRoot });

				let stdoutBuf = "";
				let lineBuf = "";
				let stderrBuf = "";
				let timedOut = false;
				let aborted = false;
				let exitCode = 0;
				let resultText: string | undefined;
				// Real total token usage (input + output) from the terminal `result`
				// line's `usage` object — the accurate figure the supervisor loop's
				// cumulative token budget consumes (vs. the per-text-block delta proxy).
				let tokenUsage: number | undefined;

				const onAbort = () => {
					aborted = true;
					child.kill();
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				const timer = setTimeout(() => {
					timedOut = true;
					child.kill();
					stderrBuf = `Timeout after ${timeoutMs}ms`;
					exitCode = -1;
				}, timeoutMs);

				// NDJSON (`--output-format stream-json`): one JSON object per line.
				// `assistant` lines carry incremental text blocks → emit a
				// `model-token-delta` per TEXT block so the orchestrator's budget
				// AbortController can abort a runaway worker.
				//
				// NOTE: one delta == one assistant text block, NOT one token. A worker
				// emitting mostly tool_use blocks under-counts, so the orchestrator's
				// per-iteration `--max-tokens` cap is an APPROXIMATE response-volume
				// proxy. The precise per-iteration bound is `--wall-clock-ms`
				// (maxComputeTimeMs). The accurate cumulative figure is the terminal
				// `result.usage` parsed below (used by the supervisor's token-budget cap).
				const consumeLine = (raw: string): void => {
					const line = raw.trim();
					if (!line) return;
					let obj: Record<string, unknown>;
					try {
						obj = JSON.parse(line) as Record<string, unknown>;
					} catch {
						return;
					}
					if (obj.type === "assistant") {
						const msg = obj.message as
							| { content?: ClaudeContentBlock[] }
							| undefined;
						for (const block of msg?.content ?? []) {
							if (block.type === "text" && typeof block.text === "string") {
								eventBus.emit({
									kind: "model-token-delta",
									runId: "",
									timestamp: new Date().toISOString(),
									delta: block.text,
								});
							} else if (
								onToolEvent &&
								block.type === "tool_use" &&
								typeof block.id === "string" &&
								typeof block.name === "string"
							) {
								onToolEvent({
									phase: "request",
									toolUseId: block.id,
									toolName: block.name,
									input:
										block.input && typeof block.input === "object"
											? (block.input as Record<string, unknown>)
											: {},
								});
							}
						}
					} else if (obj.type === "user") {
						// `tool_result` content arrives on a `user` message in the
						// stream-json schema; correlated to its `tool_use` by tool_use_id.
						if (onToolEvent) {
							const msg = obj.message as
								| { content?: ClaudeContentBlock[] }
								| undefined;
							for (const block of msg?.content ?? []) {
								if (
									block.type === "tool_result" &&
									typeof block.tool_use_id === "string"
								) {
									onToolEvent({
										phase: "result",
										toolUseId: block.tool_use_id,
										content: normalizeToolResultContent(block.content),
										isError: block.is_error === true,
									});
								}
							}
						}
					} else if (obj.type === "result") {
						if (typeof obj.result === "string") {
							resultText = obj.result;
						}
						// The stream-json terminal `result` line carries a `usage` object
						// ({ input_tokens, output_tokens, cache_*_input_tokens }). Sum the
						// real input + output token cost for the supervisor's cumulative cap.
						const usage = obj.usage as
							| { input_tokens?: number; output_tokens?: number }
							| undefined;
						if (usage) {
							tokenUsage =
								(usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
						}
					}
				};

				child.stdout?.on("data", (chunk: Buffer | string) => {
					const s = chunk.toString();
					stdoutBuf += s;
					lineBuf += s;
					let nl: number;
					// biome-ignore lint/suspicious/noAssignInExpressions: stream line-buffer drain
					while ((nl = lineBuf.indexOf("\n")) !== -1) {
						consumeLine(lineBuf.slice(0, nl));
						lineBuf = lineBuf.slice(nl + 1);
					}
				});

				child.stderr?.on("data", (chunk: Buffer | string) => {
					stderrBuf += chunk.toString();
				});

				child.on("close", (code: number | null) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);

					// Drain any trailing partial line (no terminating newline).
					if (lineBuf.trim()) {
						consumeLine(lineBuf);
						lineBuf = "";
					}

					if (!timedOut && !aborted) {
						exitCode = code ?? 0;
					}
					if (aborted) {
						exitCode = -1;
					}

					// Fallback: a single buffered JSON object (legacy
					// `--output-format json`, or a stub that prints one object). Keeps
					// the existing buffered-JSON tests + smoke test green.
					if (resultText === undefined && stdoutBuf.trim()) {
						try {
							const parsed = JSON.parse(stdoutBuf) as Record<string, unknown>;
							if (typeof parsed.result === "string") {
								resultText = parsed.result;
							} else if (typeof parsed.text === "string") {
								resultText = parsed.text;
							} else if (typeof parsed.content === "string") {
								resultText = parsed.content;
							}
							if (tokenUsage === undefined) {
								const usage = parsed.usage as
									| { input_tokens?: number; output_tokens?: number }
									| undefined;
								if (usage) {
									tokenUsage =
										(usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
								}
							}
						} catch {
							// Malformed JSON — skip event, don't fabricate.
						}
					}

					if (resultText !== undefined) {
						eventBus.emit({
							kind: "model-response-complete",
							runId: "",
							timestamp: new Date().toISOString(),
							text: resultText,
							finishReason: aborted ? "abort" : "stop",
							usage: undefined,
						});
					}

					const completedAt = new Date().toISOString();

					const outputChecks = packet.verification.requiredOutputs.map(
						(path) => ({
							path,
							exists: existsSync(resolve(projectRoot, path)),
						}),
					);

					// Normalize exit code for Claude Code CLI:
					// Claude Code returns exit 1 for max-turns, plugin warnings,
					// and hook errors — none of which mean the task failed.
					// If all required outputs exist, treat the run as successful.
					// An aborted or timed-out run is never normalized to success.
					let normalizedExitCode = exitCode;
					if (
						exitCode !== 0 &&
						!timedOut &&
						!aborted &&
						outputChecks.length > 0 &&
						outputChecks.every((c) => c.exists)
					) {
						normalizedExitCode = 0;
					}

					resolvePromise({
						command: cliBinary,
						args,
						cwd: projectRoot,
						startedAt,
						completedAt,
						exitCode: normalizedExitCode,
						stdout: stdoutBuf,
						stderr: stderrBuf,
						outputChecks,
						...(tokenUsage !== undefined ? { tokenUsage } : {}),
					});
				});
			});
		},
	};
}
