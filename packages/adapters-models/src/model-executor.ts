import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
	EventBus,
	ExecutionReceipt,
	ExecutionRole,
	TaskRenderer,
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
	| { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
	| {
			type: "tool-result";
			toolCallId: string;
			toolName: string;
			output: unknown;
	  }
	| {
			type: "step-finish";
			finishReason?: string;
			usage?: { promptTokens: number; completionTokens: number };
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
}) => StreamResult;

/** A function that resolves a provider+model string to an AI SDK model instance. */
export type ModelResolver = (provider: string, modelId: string) => unknown;

/** A function that builds tool definitions for the model from the workspace root. */
export type ToolBuilder = (root: string) => Record<string, unknown>;

export interface CreateModelExecutorOptions {
	/** Override the stream function (for testing). Defaults to AI SDK streamText. */
	streamFn?: StreamFunction;
	/** Override the model resolver (for testing). Defaults to AI SDK provider lookup. */
	modelResolver?: ModelResolver;
	/** Build tools to pass to the model. */
	toolBuilder?: ToolBuilder;
	/**
	 * Renderer used to convert packet.intent into system + prompt strings.
	 * When present and packet.intent exists, the rendered output takes
	 * precedence over packet.model.prompt / packet.model.systemPrompt.
	 */
	renderer?: TaskRenderer;
}

export function createModelExecutor(
	options: CreateModelExecutorOptions = {},
): ModelExecutorPort {
	const streamFn = options.streamFn;
	const modelResolver = options.modelResolver;
	const toolBuilder = options.toolBuilder;
	const renderer = options.renderer;

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
				const receipt = await executeModelStream(
					packet,
					projectRoot,
					eventBus,
					stream,
					resolver,
					toolBuilder,
					renderer,
					signal,
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
	toolBuilder?: ToolBuilder,
	renderer?: TaskRenderer,
	signal?: AbortSignal,
): Promise<ExecutionReceipt> {
	const model = packet.model;
	if (!model) {
		throw new Error("Packet must have a model block for model execution.");
	}
	const startedAt = new Date().toISOString();

	const modelInstance = modelResolver(model.provider, model.model);

	// Build tools if a toolBuilder is provided
	const builtTools = toolBuilder ? toolBuilder(projectRoot) : undefined;
	const hasTools = builtTools && Object.keys(builtTools).length > 0;

	// Resolve prompt: intent + renderer takes precedence over model.prompt
	let resolvedSystem: string | undefined;
	let resolvedPrompt: string;
	if (packet.intent && renderer) {
		const role: ExecutionRole = "implementer";
		const rendered = renderer.render(packet.intent, role);
		resolvedSystem = rendered.system;
		resolvedPrompt = rendered.prompt;
	} else {
		resolvedSystem = model.systemPrompt;
		resolvedPrompt = model.prompt ?? "Execute the assigned task.";
	}

	const result = streamFn({
		model: modelInstance,
		system: resolvedSystem,
		prompt: resolvedPrompt,
		tools: hasTools ? builtTools : undefined,
	});

	let fullText = "";
	let finishReason = "unknown";
	let usage: { promptTokens: number; completionTokens: number } | undefined;

	for await (const chunk of result.fullStream) {
		if (signal?.aborted) break;
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
			case "step-finish":
			case "finish-step": {
				finishReason = chunk.finishReason ?? "unknown";
				usage = chunk.usage ?? undefined;
				break;
			}
		}
	}

	const completedAt = new Date().toISOString();
	const aborted = signal?.aborted ?? false;
	const actualFinishReason = aborted ? "aborted" : finishReason;

	eventBus.emit({
		kind: "model-response-complete",
		runId: "",
		timestamp: completedAt,
		text: fullText,
		finishReason: actualFinishReason,
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
		stderr: aborted ? "execution aborted: budget limit exceeded" : "",
		outputChecks: packet.verification.requiredOutputs.map((path) => ({
			path,
			exists: existsSync(resolve(projectRoot, path)),
		})),
	};
}
