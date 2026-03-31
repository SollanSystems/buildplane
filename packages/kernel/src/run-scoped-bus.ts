import type { EventBus, EventListener, ExecutionEvent } from "./events.js";

export function createRunScopedBus(
	runId: string,
	innerBus: EventBus,
): EventBus {
	return {
		emit(event: ExecutionEvent) {
			innerBus.emit({ ...event, runId });
		},
		subscribe(listener: EventListener) {
			return innerBus.subscribe(listener);
		},
	};
}
