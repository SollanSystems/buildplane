import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
	EventBus,
	ExecutionReceipt,
	UnitPacket,
} from "@buildplane/kernel";
import { executePacket as executeCommandPacket } from "@buildplane/runtime";

export interface ModelExecutorPort {
	executePacket(packet: UnitPacket, projectRoot: string): ExecutionReceipt;
	executePacketAsync(
		packet: UnitPacket,
		projectRoot: string,
		eventBus: EventBus,
		signal?: AbortSignal,
	): Promise<ExecutionReceipt>;
}

/** Stream chunk types that the executor knows how to handle. */
export type StreamChunk =
	| { type: "text-delta"; textDelta: string }
	| {
			type: "tool-call";
			toolCallId: string;
			toolName: string;
			input: unknown;
	  }
	| {
			type: "tool-result";
			toolCallId: string;
			toolName: string;
			output: unknown;
	  }
	| {
			type: "finish-step";
			finishReason?: string;
			usage?: { promptTokens: number; completionTokens: number };
	  };

/** Abstraction over the AI SDK's streamText return value. */
export interface StreamResult {
	fullStream: AsyncIterable<StreamChunk>;
}

/** A function that produces a stream from model config. Defaults to AI SDK streamText. */
export type StreamFunction = (options: {
	model: unknown;
	system?: string;
	prompt: string;
	tools?: Record<string, unknown>;
	abortSignal?: AbortSignal;
}) => StreamResult;

/** A function that resolves a provider+model string to an AI SDK model instance. */
export type ModelResolver = (provider: string, modelId: string) => unknown;

/** A function that builds AI SDK-compatible tools for a given worktree root. */
export type ToolBuilder = (
	worktreeRoot: string,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

/** A function that checks whether a tool call is allowed. Returns an error message if blocked, null if allowed. */
export type ToolGate = (toolName: string) => string | null;

export interface CreateModelExecutorOptions {
	/** Override the stream function (for testing). Defaults to AI SDK streamText. */
	streamFn?: StreamFunction;
	/** Override the model resolver (for testing). Defaults to AI SDK provider lookup. */
	modelResolver?: ModelResolver;
	/** Override the tool builder (for testing). Defaults to adapters-tools with AI SDK tool(). */
	toolBuilder?: ToolBuilder;
	/** Optional gate that checks each tool call before execution. */
	toolGate?: ToolGate;
}

export function createModelExecutor(
	options: CreateModelExecutorOptions = {},
): ModelExecutorPort {
	const streamFn = options.streamFn;
	const modelResolver = options.modelResolver;
	const toolBuilder = options.toolBuilder;

	async function getStreamFn(): Promise<StreamFunction> {
		if (streamFn) return streamFn;
		const { streamText } = await import("ai");
		return streamText as unknown as StreamFunction;
	}

	async function getModelResolver(): Promise<ModelResolver> {
		if (modelResolver) return modelResolver;
		const { anthropic } = await import("@ai-sdk/anthropic");
		return (provider: string, modelId: string) => {
			switch (provider) {
				case "anthropic":
					return anthropic(modelId as Parameters<typeof anthropic>[0]);
				default:
					throw new Error(
						`Unsupported model provider: ${provider}. Supported: anthropic`,
					);
			}
		};
	}

	async function getToolBuilder(): Promise<ToolBuilder> {
		if (toolBuilder) return toolBuilder;
		const ai = await import("ai");
		const { createToolRegistry } = await import("@buildplane/adapters-tools");
		return (worktreeRoot: string) => {
			const registry = createToolRegistry(worktreeRoot);

			// Use jsonSchema() with explicit JSON Schema objects.
			// IMPORTANT: AI SDK v6 reads tool.inputSchema (not tool.parameters)
			// in prepareToolsAndToolChoice. Using inputSchema directly.
			return {
				write_file: {
					description:
						"Write content to a file. Creates parent directories as needed. Path must be relative to the worktree root.",
					inputSchema: ai.jsonSchema({
						type: "object" as const,
						properties: {
							path: {
								type: "string" as const,
								description: "Relative file path within the worktree",
							},
							content: {
								type: "string" as const,
								description: "File content to write",
							},
						},
						required: ["path", "content"] as const,
						additionalProperties: false,
					}),
					execute: async (input: { path: string; content: string }) =>
						registry.write_file(input),
				},
				run_command: {
					description:
						"Run a shell command. The command runs inside the worktree directory. Use cwd for a subdirectory.",
					inputSchema: ai.jsonSchema({
						type: "object" as const,
						properties: {
							command: {
								type: "string" as const,
								description: "Command to execute",
							},
							args: {
								type: "array" as const,
								items: { type: "string" as const },
								description: "Command arguments",
							},
							cwd: {
								type: "string" as const,
								description: "Working directory relative to the worktree root",
							},
						},
						required: ["command"] as const,
						additionalProperties: false,
					}),
					execute: async (input: {
						command: string;
						args?: string[];
						cwd?: string;
					}) => registry.run_command(input),
				},
			};
		};
	}

	return {
		executePacket(packet: UnitPacket, projectRoot: string): ExecutionReceipt {
			if (!packet.execution) {
				throw new Error(
					"Sync executePacket only supports command packets. Use executePacketAsync for model packets.",
				);
			}
			return executeCommandPacket(packet, projectRoot);
		},

		async executePacketAsync(
			packet: UnitPacket,
			projectRoot: string,
			eventBus: EventBus,
			signal?: AbortSignal,
		): Promise<ExecutionReceipt> {
			// Command packets delegate to the sync executor
			if (packet.execution) {
				return executeCommandPacket(packet, projectRoot);
			}

			if (!packet.model) {
				throw new Error("Packet must have either an execution or model block.");
			}

			const startedAt = new Date().toISOString();

			try {
				const stream = await getStreamFn();
				const resolver = await getModelResolver();
				const buildTools = await getToolBuilder();
				const receipt = await executeModelStream(
					packet,
					projectRoot,
					eventBus,
					stream,
					resolver,
					buildTools,
					signal,
					options.toolGate,
				);
				return receipt;
			} catch (error) {
				const completedAt = new Date().toISOString();
				const message = error instanceof Error ? error.message : String(error);

				eventBus.emit({
					kind: "execution-error",
					runId: "",
					timestamp: completedAt,
					message,
					phase: "model-execution",
				});

				return {
					command: "model",
					args: [packet.model.provider, packet.model.model],
					cwd: projectRoot,
					startedAt,
					completedAt,
					exitCode: 1,
					stdout: "",
					stderr: message,
					outputChecks: packet.verification.requiredOutputs.map((path) => ({
						path,
						exists: false,
					})),
				};
			}
		},
	};
}

async function executeModelStream(
	packet: UnitPacket,
	projectRoot: string,
	eventBus: EventBus,
	streamFn: StreamFunction,
	modelResolver: ModelResolver,
	toolBuilder: ToolBuilder,
	signal?: AbortSignal,
	toolGateCheck?: ToolGate,
): Promise<ExecutionReceipt> {
	const model = packet.model;
	if (!model) {
		throw new Error("Packet must have a model block for model execution.");
	}
	const startedAt = new Date().toISOString();

	const modelInstance = modelResolver(model.provider, model.model);
	const rawTools = await toolBuilder(projectRoot);

	// Wrap tool execute functions with gate checks if a gate is provided
	const tools = toolGateCheck
		? wrapToolsWithGate(rawTools, toolGateCheck)
		: rawTools;

	const result = streamFn({
		model: modelInstance,
		system: model.systemPrompt,
		prompt: "Execute the assigned task.",
		tools: Object.keys(tools).length > 0 ? tools : undefined,
		abortSignal: signal,
	});

	let fullText = "";
	let finishReason = "unknown";
	let usage: { promptTokens: number; completionTokens: number } | undefined;
	let aborted = false;

	try {
		for await (const chunk of result.fullStream) {
			// Check abort between chunks
			if (signal?.aborted) {
				aborted = true;
				break;
			}

			switch (chunk.type) {
				case "text-delta": {
					fullText += chunk.textDelta;
					eventBus.emit({
						kind: "model-token-delta",
						runId: "",
						timestamp: new Date().toISOString(),
						delta: chunk.textDelta,
					});
					break;
				}
				case "tool-call": {
					eventBus.emit({
						kind: "tool-call-started",
						runId: "",
						timestamp: new Date().toISOString(),
						toolCallId: chunk.toolCallId,
						toolName: chunk.toolName,
						args: chunk.input as Record<string, unknown>,
					});
					break;
				}
				case "tool-result": {
					eventBus.emit({
						kind: "tool-call-completed",
						runId: "",
						timestamp: new Date().toISOString(),
						toolCallId: chunk.toolCallId,
						toolName: chunk.toolName,
						result: chunk.output,
					});
					break;
				}
				case "finish-step": {
					finishReason = chunk.finishReason ?? "unknown";
					usage = chunk.usage ?? undefined;
					break;
				}
			}
		}
	} catch (error) {
		// AbortError is thrown when the signal fires during an async iteration
		const isAbort =
			signal?.aborted ||
			(error instanceof Error && error.name === "AbortError");
		if (isAbort) {
			aborted = true;
		} else {
			throw error;
		}
	}

	const completedAt = new Date().toISOString();

	if (aborted) {
		finishReason = "aborted";
	}

	eventBus.emit({
		kind: "model-response-complete",
		runId: "",
		timestamp: completedAt,
		text: fullText,
		finishReason,
		usage,
	});

	return {
		command: "model",
		args: [model.provider, model.model],
		cwd: projectRoot,
		startedAt,
		completedAt,
		exitCode: aborted ? 1 : 0,
		stdout: fullText,
		stderr: aborted ? "model execution aborted" : "",
		outputChecks: packet.verification.requiredOutputs.map((path) => ({
			path,
			exists: existsSync(resolve(projectRoot, path)),
		})),
	};
}

function wrapToolsWithGate(
	tools: Record<string, unknown>,
	gate: ToolGate,
): Record<string, unknown> {
	const wrapped: Record<string, unknown> = {};
	for (const [name, tool] of Object.entries(tools)) {
		const t = tool as {
			description?: string;
			inputSchema?: unknown;
			parameters?: unknown;
			execute?: (...args: unknown[]) => unknown;
		};
		if (t.execute) {
			const originalExecute = t.execute;
			wrapped[name] = {
				...t,
				execute: async (...args: unknown[]) => {
					const rejection = gate(name);
					if (rejection) {
						return { success: false, error: rejection };
					}
					return originalExecute(...args);
				},
			};
		} else {
			wrapped[name] = tool;
		}
	}
	return wrapped;
}
