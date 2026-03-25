import type { BudgetEnforcer, EventBus } from "@buildplane/kernel";

/** Context passed to every tool execution. */
export interface ToolContext {
	readonly workspaceRoot: string;
	readonly budgetEnforcer?: BudgetEnforcer;
	readonly eventBus: EventBus;
	readonly runId: string;
}

/** A single tool implementation that can be registered with the router. */
export interface ToolImplementation {
	readonly name: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
	execute(
		args: Record<string, unknown>,
		context: ToolContext,
	): Promise<unknown>;
}

/**
 * Registry of tool implementations.
 *
 * Produces AI SDK-compatible tool definitions with bound `execute` functions
 * so that `streamText({ tools })` can invoke them directly.
 */
export interface ToolRouter {
	readonly tools: ReadonlyMap<string, ToolImplementation>;

	/**
	 * Returns an object compatible with the Vercel AI SDK `tools` parameter.
	 * Each key is a tool name; each value has `{ description, parameters, execute }`.
	 */
	toAiSdkTools(context: ToolContext): Record<string, unknown>;
}

export function createToolRouter(
	implementations: readonly ToolImplementation[],
): ToolRouter {
	const tools = new Map<string, ToolImplementation>();
	for (const impl of implementations) {
		tools.set(impl.name, impl);
	}

	return {
		tools,

		toAiSdkTools(context: ToolContext): Record<string, unknown> {
			const result: Record<string, unknown> = {};
			for (const [name, impl] of tools) {
				result[name] = {
					description: impl.description,
					parameters: impl.parameters,
					execute: async (args: Record<string, unknown>) =>
						impl.execute(args, context),
				};
			}
			return result;
		},
	};
}
