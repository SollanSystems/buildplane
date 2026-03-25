import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolContext, ToolRouter } from "@buildplane/adapters-tools";
import type {
	BudgetEnforcer,
	EventBus,
	ExecutionReceipt,
	UnitPacket,
} from "@buildplane/kernel";
import { executePacket as executeCommandPacket } from "@buildplane/runtime/command-executor";

export interface ModelExecutorPort {
	executePacket(packet: UnitPacket, projectRoot: string): ExecutionReceipt;
	executePacketAsync(
		packet: UnitPacket,
		projectRoot: string,
		eventBus: EventBus,
		runId?: string,
		budgetEnforcer?: BudgetEnforcer,
	): Promise<ExecutionReceipt>;
}

/** Stream chunk types that the executor knows how to handle. */
export type StreamChunk =
	| { type: "text-delta"; textDelta: string }
	| { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
	| {
			type: "tool-result";
			toolCallId: string;
			toolName: string;
			result: unknown;
	  }
	| {
			type: "step-finish";
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
	maxSteps?: number;
}) => StreamResult;

/** A function that resolves a provider+model string to an AI SDK model instance. */
export type ModelResolver = (provider: string, modelId: string) => unknown;

export interface CreateModelExecutorOptions {
	/** Override the stream function (for testing). Defaults to AI SDK streamText. */
	streamFn?: StreamFunction;
	/** Override the model resolver (for testing). Defaults to AI SDK provider lookup. */
	modelResolver?: ModelResolver;
	/** Tool router providing executable tool definitions for model calls. */
	toolRouter?: ToolRouter;
}

export function createModelExecutor(
	options: CreateModelExecutorOptions = {},
): ModelExecutorPort {
	const streamFn = options.streamFn;
	const modelResolver = options.modelResolver;
	const toolRouter = options.toolRouter;

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
			runId?: string,
			budgetEnforcer?: BudgetEnforcer,
		): Promise<ExecutionReceipt> {
			const effectiveRunId = runId ?? "";

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
				const receipt = await executeModelStream(
					packet,
					projectRoot,
					eventBus,
					stream,
					resolver,
					effectiveRunId,
					toolRouter,
					budgetEnforcer,
				);
				return receipt;
			} catch (error) {
				const completedAt = new Date().toISOString();
				const message = error instanceof Error ? error.message : String(error);

				eventBus.emit({
					kind: "execution-error",
					runId: effectiveRunId,
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
					outputChecks: packet.verification.requiredOutputs.map(
						(path: string) => ({
							path,
							exists: false,
						}),
					),
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
	runId: string,
	toolRouter?: ToolRouter,
	budgetEnforcer?: BudgetEnforcer,
): Promise<ExecutionReceipt> {
	const model = packet.model;
	if (!model) {
		throw new Error("Packet must have a model block for model execution.");
	}
	const startedAt = new Date().toISOString();

	const modelInstance = modelResolver(model.provider, model.model);

	// Build AI SDK-compatible tools if a router and tool definitions are present
	let tools: Record<string, unknown> | undefined;
	let maxSteps: number | undefined;
	if (toolRouter && model.tools && model.tools.length > 0) {
		const context: ToolContext = {
			workspaceRoot: projectRoot,
			budgetEnforcer,
			eventBus,
			runId,
		};
		const allTools = toolRouter.toAiSdkTools(context);
		// Filter to only the tools declared in the packet (least-privilege)
		const allowedNames = new Set(
			model.tools.map((t: { name: string }) => t.name),
		);
		tools = {};
		for (const name of allowedNames) {
			if (name in allTools) {
				tools[name] = (allTools as Record<string, unknown>)[name];
			}
		}
		maxSteps = packet.budget?.maxSteps ?? 10;
	}

	const result = streamFn({
		model: modelInstance,
		system: model.systemPrompt,
		prompt: "Execute the assigned task.",
		tools,
		maxSteps,
	});

	let fullText = "";
	let finishReason = "unknown";
	let usage: { promptTokens: number; completionTokens: number } | undefined;

	for await (const chunk of result.fullStream) {
		switch (chunk.type) {
			case "text-delta": {
				fullText += chunk.textDelta;
				eventBus.emit({
					kind: "model-token-delta",
					runId,
					timestamp: new Date().toISOString(),
					delta: chunk.textDelta,
				});
				break;
			}
			case "tool-call": {
				eventBus.emit({
					kind: "tool-call-started",
					runId,
					timestamp: new Date().toISOString(),
					toolCallId: chunk.toolCallId,
					toolName: chunk.toolName,
					args: chunk.args as Record<string, unknown>,
				});
				break;
			}
			case "tool-result": {
				eventBus.emit({
					kind: "tool-call-completed",
					runId,
					timestamp: new Date().toISOString(),
					toolCallId: chunk.toolCallId,
					toolName: chunk.toolName,
					result: chunk.result,
				});
				break;
			}
			case "step-finish": {
				finishReason = chunk.finishReason ?? "unknown";
				if (chunk.usage) {
					const stepTokens =
						chunk.usage.promptTokens + chunk.usage.completionTokens;
					budgetEnforcer?.recordTokens(stepTokens);
					usage = usage
						? {
								promptTokens: usage.promptTokens + chunk.usage.promptTokens,
								completionTokens:
									usage.completionTokens + chunk.usage.completionTokens,
							}
						: chunk.usage;
				}
				break;
			}
		}
	}

	const completedAt = new Date().toISOString();

	eventBus.emit({
		kind: "model-response-complete",
		runId,
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
		exitCode: 0,
		stdout: fullText,
		stderr: "",
		outputChecks: packet.verification.requiredOutputs.map((path: string) => ({
			path,
			exists: existsSync(resolve(projectRoot, path)),
		})),
	};
}
