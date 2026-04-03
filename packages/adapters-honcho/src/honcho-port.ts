import type { EventListener } from "@buildplane/kernel";

/**
 * Result of a Honcho context pre-fetch.
 * The `memories` array contains natural-language strings
 * suitable for injection into TaskIntent.context.memories.
 */
export interface HonchoContextResult {
  readonly memories: readonly string[];
}

/**
 * Port contract for Honcho memory integration.
 *
 * - createSubscriber: returns an EventListener that stores
 *   prompts and model responses to a Honcho session.
 * - fetchContext: queries Honcho for user representations
 *   and returns them as memory strings for the prompt.
 */
export interface HonchoPort {
  /**
   * Create an EventBus subscriber scoped to a strategy execution.
   * The subscriber listens for model-response-complete events
   * and stores the prompt/response exchange in Honcho.
   */
  createSubscriber(sessionId: string, userId: string): EventListener;

  /**
   * Pre-fetch user context from Honcho for prompt injection.
   * @param userId - The operator's identifier
   * @param queries - Natural language questions to ask Honcho about the user
   * @returns Memories array for TaskIntent.context.memories
   */
  fetchContext(
    userId: string,
    queries?: readonly string[],
  ): Promise<HonchoContextResult>;
}
