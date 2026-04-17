import type {
	EventBus,
	EventContext,
	ExecutionEvent,
} from "@buildplane/kernel";
import { useCallback, useEffect, useState } from "react";

export interface ToolCallState {
	readonly id: string;
	readonly name: string;
	readonly status: "running" | "completed";
	readonly args?: Record<string, unknown>;
	readonly result?: unknown;
}

export interface BudgetAlertState {
	readonly budgetType: "tokens" | "time";
	readonly limit: number;
	readonly actual: number;
}

export interface RunViewState {
	readonly phase:
		| "idle"
		| "pending"
		| "running"
		| "executing"
		| "evidence"
		| "policy"
		| "suspended"
		| "completed"
		| "failed"
		| "error";
	readonly modelText: string;
	readonly toolCalls: readonly ToolCallState[];
	readonly evidenceCount: number;
	readonly policyOutcome: string | null;
	readonly policyReasons: readonly string[];
	readonly error: string | null;
	readonly runId: string | null;
	readonly unitId: string | null;
	readonly graphId: string | null;
	readonly graphUnitCount: number | null;
	readonly graphOutcome: "passed" | "failed" | null;
	readonly graphActive: boolean;
	readonly suspensionProfile: string | null;
	readonly suspensionReason: string | null;
	readonly budgetAlert: BudgetAlertState | null;
	readonly strategyId: string | null;
	readonly parentRunId: string | null;
	readonly role: string | null;
	readonly provider: string | null;
	readonly model: string | null;
	readonly estimatedUsd: number | null;
	readonly done: boolean;
}

export const initialRunViewState: RunViewState = {
	phase: "idle",
	modelText: "",
	toolCalls: [],
	evidenceCount: 0,
	policyOutcome: null,
	policyReasons: [],
	error: null,
	runId: null,
	unitId: null,
	graphId: null,
	graphUnitCount: null,
	graphOutcome: null,
	graphActive: false,
	suspensionProfile: null,
	suspensionReason: null,
	budgetAlert: null,
	strategyId: null,
	parentRunId: null,
	role: null,
	provider: null,
	model: null,
	estimatedUsd: null,
	done: false,
};

function withEventContext(
	state: RunViewState,
	context: EventContext | undefined,
): RunViewState {
	if (!context) {
		return state;
	}

	return {
		...state,
		strategyId: context.strategyId ?? state.strategyId,
		parentRunId: context.parentRunId ?? state.parentRunId,
		role: context.role ?? state.role,
		provider: context.provider ?? state.provider,
		model: context.model ?? state.model,
		estimatedUsd: context.cost?.estimatedUsd ?? state.estimatedUsd,
	};
}

export function reduceRunState(
	state: RunViewState,
	event: ExecutionEvent,
): RunViewState {
	const nextState: RunViewState = (() => {
		switch (event.kind) {
			case "run-created":
				return {
					...state,
					phase: "pending",
					runId: event.runId,
					unitId: event.unitId,
				};
			case "run-started":
				return { ...state, phase: "running", unitId: event.unitId };
			case "execution-started":
				return {
					...state,
					phase: "executing",
				};
			case "model-token-delta":
				return {
					...state,
					modelText: state.modelText + event.delta,
				};
			case "model-response-complete":
				return state;
			case "tool-call-started":
				return {
					...state,
					toolCalls: [
						...state.toolCalls,
						{
							id: event.toolCallId,
							name: event.toolName,
							status: "running",
							args: event.args,
						},
					],
				};
			case "tool-call-completed":
				return {
					...state,
					toolCalls: state.toolCalls.map((tc) =>
						tc.id === event.toolCallId
							? { ...tc, status: "completed" as const, result: event.result }
							: tc,
					),
				};
			case "command-execution-complete":
				return state;
			case "evidence-recorded":
				return {
					...state,
					phase: "evidence",
					evidenceCount: state.evidenceCount + 1,
				};
			case "policy-decision":
				return {
					...state,
					phase: "policy",
					policyOutcome: event.outcome,
					policyReasons: [...event.reasons],
				};
			case "execution-error":
				return {
					...state,
					phase: "error",
					error: event.message,
				};
			case "policy-budget-breached":
				return {
					...state,
					budgetAlert: {
						budgetType: event.budgetType,
						limit: event.limit,
						actual: event.actual,
					},
				};
			case "run-suspended":
				return {
					...state,
					phase: "suspended",
					unitId: event.unitId,
					suspensionProfile: event.profileName,
					suspensionReason: event.reason,
					done: !state.graphActive,
				};
			case "run-resumed":
				return {
					...state,
					phase: "running",
					unitId: event.unitId,
					suspensionProfile: null,
					suspensionReason: null,
					done: false,
				};
			case "graph-started":
				return {
					...state,
					graphActive: true,
					graphId: event.graphId,
					graphUnitCount: event.unitCount,
					graphOutcome: null,
					done: false,
				};
			case "graph-completed":
				return {
					...state,
					graphActive: false,
					graphId: event.graphId,
					graphOutcome: event.outcome,
					phase: event.outcome === "passed" ? "completed" : "failed",
					done: true,
				};
			case "run-completed":
				if (state.graphActive) {
					return {
						...state,
						unitId: event.unitId,
						phase:
							event.status === "failed" || state.phase === "failed"
								? "failed"
								: "running",
						done: false,
					};
				}
				return {
					...state,
					unitId: event.unitId,
					phase: event.status === "passed" ? "completed" : "failed",
					done: true,
				};
			default:
				return state;
		}
	})();

	const stabilizedState =
		state.graphActive &&
		nextState.graphActive &&
		state.phase === "failed" &&
		nextState.phase !== "failed" &&
		nextState.phase !== "completed" &&
		nextState.phase !== "error"
			? { ...nextState, phase: "failed" as const }
			: state.graphActive &&
					nextState.graphActive &&
					state.phase === "suspended" &&
					event.kind !== "run-resumed" &&
					nextState.phase !== "completed" &&
					nextState.phase !== "error"
				? { ...nextState, phase: "suspended" as const }
				: nextState;

	return withEventContext(stabilizedState, event.context);
}

export function useRunState(eventBus: EventBus): RunViewState {
	const [state, setState] = useState<RunViewState>(initialRunViewState);

	const handleEvent = useCallback((event: ExecutionEvent) => {
		setState((prev) => reduceRunState(prev, event));
	}, []);

	useEffect(() => {
		const unsub = eventBus.subscribe(handleEvent);
		return unsub;
	}, [eventBus, handleEvent]);

	return state;
}
