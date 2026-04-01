const fs = require("node:fs");
const path = require("node:path");

const eventsPath = path.join(process.cwd(), "packages/kernel/src/events.ts");
let eventsSrc = fs.readFileSync(eventsPath, "utf8");

// Graph events don't naturally have a single `runId`.
// So let's make them implement BaseEvent AND make sure we emit runId.
eventsSrc = eventsSrc.replace(
	/export interface GraphStartedEvent \{/g,
	"export interface GraphStartedEvent extends BaseEvent {",
);
eventsSrc = eventsSrc.replace(
	/export interface GraphCompletedEvent \{/g,
	"export interface GraphCompletedEvent extends BaseEvent {",
);
fs.writeFileSync(eventsPath, eventsSrc);

const orchPath = path.join(
	process.cwd(),
	"packages/kernel/src/orchestrator.ts",
);
let orchSrc = fs.readFileSync(orchPath, "utf8");

orchSrc = orchSrc.replace(
	/kind: "graph-started",\n\s*graphId,/g,
	`kind: "graph-started",
				runId: graphId,
				graphId,`,
);
orchSrc = orchSrc.replace(
	/kind: "graph-completed",\n\s*graphId,/g,
	`kind: "graph-completed",
				runId: graphId,
				graphId,`,
);
fs.writeFileSync(orchPath, orchSrc);
