import type { EventBus } from "@buildplane/kernel";
import { render } from "ink";
import React from "react";
import { TuiApp } from "./app.js";

export { TuiApp } from "./app.js";
export type {
	BudgetAlertState,
	RunViewState,
	ToolCallState,
} from "./hooks/use-run-state.js";
export {
	initialRunViewState,
	reduceRunState,
	useRunState,
} from "./hooks/use-run-state.js";

export interface TuiInstance {
	waitUntilExit(): Promise<void>;
	unmount(): void;
	clear(): void;
}

export function renderTui(eventBus: EventBus): TuiInstance {
	const instance = render(React.createElement(TuiApp, { eventBus }));

	return {
		waitUntilExit: () => instance.waitUntilExit() as Promise<void>,
		unmount: () => instance.unmount(),
		clear: () => instance.clear(),
	};
}
