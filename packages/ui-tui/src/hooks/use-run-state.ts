import type { EventBus, ExecutionEvent } from "@buildplane/kernel";
import { useCallback, useEffect, useState } from "react";

export interface ToolCallState {
	readonly id: string;
	readonly name: string;
	readonly status: "running" | "completed";
	readonly args?: Record<string, unknown>;
	readonly result?: unknown;
}

export interface RunViewState {
	readonly phase:
		| "idle"
		| "pending"
		| "running"
		| "executing"
		| "evidence"
		| "policy"
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
	readonly done: boolean;
}

const initialState: RunViewState = {
	phase: "idle",
	modelText: "",
	toolCalls: [],
	evidenceCount: 0,
	policyOutcome: null,
	policyReasons: [],
	error: null,
	runId: null,
	unitId: null,
	done: false,
};

function reduceEvent(state: RunViewState, event: ExecutionEvent): RunViewState {
	switch (event.kind) {
		case "run-created":
			return {
				...state,
				phase: "pending",
				runId: event.runId,
				unitId: event.unitId,
			};
		case "run-started":
			return { ...state, phase: "running" };
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
				policyReasons: event.reasons,
			};
		case "execution-error":
			return {
				...state,
				phase: "error",
				error: event.message,
			};
		case "run-completed":
			return {
				...state,
				phase: event.status === "passed" ? "completed" : "failed",
				done: true,
			};
		default:
			return state;
	}
}

export function useRunState(eventBus: EventBus): RunViewState {
	const [state, setState] = useState<RunViewState>(initialState);

	const handleEvent = useCallback((event: ExecutionEvent) => {
		setState((prev) => reduceEvent(prev, event));
	}, []);

	useEffect(() => {
		const unsub = eventBus.subscribe(handleEvent);
		return unsub;
	}, [eventBus, handleEvent]);

	return state;
}
