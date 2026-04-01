const fs = require("node:fs");
const path = require("node:path");

const eventsPath = path.join(process.cwd(), "packages/kernel/src/events.ts");
let eventsSrc = fs.readFileSync(eventsPath, "utf8");
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
	/bus.emit\(\{\n\s*kind: "graph-started",\n\s*graphId,\n\s*unitCount: graph.nodes.length,\n\s*timestamp: new Date\(\).toISOString\(\),\n\s*\}\);/g,
	`bus.emit({
				kind: "graph-started",
				runId: graphId,
				graphId,
				unitCount: graph.nodes.length,
				timestamp: new Date().toISOString(),
			});`,
);
orchSrc = orchSrc.replace(
	/bus.emit\(\{\n\s*kind: "graph-completed",\n\s*graphId,\n\s*outcome: graphResult.outcome,\n\s*timestamp: new Date\(\).toISOString\(\),\n\s*\}\);/g,
	`bus.emit({
				kind: "graph-completed",
				runId: graphId,
				graphId,
				outcome: graphResult.outcome,
				timestamp: new Date().toISOString(),
			});`,
);
fs.writeFileSync(orchPath, orchSrc);
