/**
 * Typed execution events emitted during a run.
 *
 * These form the architectural spine of live visibility.
 * Every event carries a discriminated `kind` field, a `runId`,
 * and a `timestamp`. Consumers (TUI, storage, CLI) subscribe
 * to the EventBus and receive these — never untyped JSON.
 */

// ── Base ────────────────────────────────────────────────────

interface BaseEvent {
	readonly runId: string;
	readonly timestamp: string;
}

// ── Run lifecycle ───────────────────────────────────────────

export interface RunCreatedEvent extends BaseEvent {
	readonly kind: "run-created";
	readonly unitId: string;
	readonly status: "pending";
}

export interface RunStartedEvent extends BaseEvent {
	readonly kind: "run-started";
	readonly unitId: string;
	readonly status: "running";
}

export interface RunCompletedEvent extends BaseEvent {
	readonly kind: "run-completed";
	readonly unitId: string;
	readonly status: "passed" | "failed" | "cancelled";
}

// ── Execution ───────────────────────────────────────────────

export interface ExecutionStartedEvent extends BaseEvent {
	readonly kind: "execution-started";
	readonly executionType: "command" | "model";
}

export interface CommandExecutionCompleteEvent extends BaseEvent {
	readonly kind: "command-execution-complete";
	readonly exitCode: number;
	readonly outputChecks: readonly { path: string; exists: boolean }[];
}

// ── Model streaming ─────────────────────────────────────────

export interface ModelTokenDeltaEvent extends BaseEvent {
	readonly kind: "model-token-delta";
	readonly delta: string;
}

export interface ModelResponseCompleteEvent extends BaseEvent {
	readonly kind: "model-response-complete";
	readonly text: string;
	readonly finishReason: string;
	readonly usage?: {
		readonly promptTokens: number;
		readonly completionTokens: number;
	};
}

// ── Tool calls ──────────────────────────────────────────────

export interface ToolCallStartedEvent extends BaseEvent {
	readonly kind: "tool-call-started";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args: Record<string, unknown>;
}

export interface ToolCallCompletedEvent extends BaseEvent {
	readonly kind: "tool-call-completed";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly result: unknown;
}

// ── Evidence & policy ───────────────────────────────────────

export interface EvidenceRecordedEvent extends BaseEvent {
	readonly kind: "evidence-recorded";
	readonly evidenceKind: string;
	readonly status: string;
}

export interface PolicyDecisionEvent extends BaseEvent {
	readonly kind: "policy-decision";
	readonly decisionKind: "advance-run" | "reject-run" | "retry-run";
	readonly outcome: "approved" | "rejected" | "retrying";
	readonly reasons: readonly string[];
}

// ── Errors ──────────────────────────────────────────────────

export interface ExecutionErrorEvent extends BaseEvent {
	readonly kind: "execution-error";
	readonly message: string;
	readonly phase: string;
}

// ── Budget ──────────────────────────────────────────────────

export interface PolicyBudgetBreachedEvent extends BaseEvent {
	readonly kind: "policy-budget-breached";
	readonly budgetType: "tokens" | "time";
	readonly limit: number;
	readonly actual: number;
}

// ── Operator suspension ─────────────────────────────────────

export interface RunSuspendedEvent extends BaseEvent {
	readonly kind: "run-suspended";
	readonly unitId: string;
	readonly profileName: string;
	readonly reason: string;
}

export interface RunResumedEvent extends BaseEvent {
	readonly kind: "run-resumed";
	readonly unitId: string;
	readonly approvedBy?: string;
}

// ── Union ───────────────────────────────────────────────────

export type ExecutionEvent =
	| RunCreatedEvent
	| RunStartedEvent
	| RunCompletedEvent
	| RunSuspendedEvent
	| RunResumedEvent
	| ExecutionStartedEvent
	| CommandExecutionCompleteEvent
	| ModelTokenDeltaEvent
	| ModelResponseCompleteEvent
	| ToolCallStartedEvent
	| ToolCallCompletedEvent
	| EvidenceRecordedEvent
	| PolicyDecisionEvent
	| ExecutionErrorEvent
	| PolicyBudgetBreachedEvent;

/** All possible event kind values. */
export type ExecutionEventKind = ExecutionEvent["kind"];

// ── EventBus ────────────────────────────────────────────────

export type EventListener = (event: ExecutionEvent) => void;

export interface EventBus {
	/** Subscribe to all events. Returns an unsubscribe function. */
	subscribe(listener: EventListener): () => void;

	/** Emit an event to all current subscribers. */
	emit(event: ExecutionEvent): void;
}

/** Create a simple synchronous event bus. */
export function createEventBus(): EventBus {
	const listeners = new Set<EventListener>();

	return {
		subscribe(listener: EventListener): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		emit(event: ExecutionEvent): void {
			for (const listener of listeners) {
				listener(event);
			}
		},
	};
}
