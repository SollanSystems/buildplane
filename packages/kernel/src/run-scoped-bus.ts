import type {
	EventBus,
	EventContext,
	EventListener,
	ExecutionEvent,
} from "./events.js";

export function createRunScopedBus(
	context: EventContext,
	innerBus: EventBus,
): EventBus {
	return {
		emit(event: ExecutionEvent) {
			innerBus.emit({ ...event, runId: context.runId, context });
		},
		subscribe(listener: EventListener) {
			return innerBus.subscribe(listener);
		},
	};
}
