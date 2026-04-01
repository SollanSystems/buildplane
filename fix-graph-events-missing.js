const fs = require("node:fs");
const path = require("node:path");

const eventsPath = path.join(process.cwd(), "packages/kernel/src/events.ts");
let eventsSrc = fs.readFileSync(eventsPath, "utf8");

// GraphStartedEvent missing runId? No, BaseEvent requires runId.
// The event is trying to insert runId, but what is it?
// Ah wait, it's NOT a run! It's a graph. So it SHOULD NOT extend BaseEvent!
eventsSrc = eventsSrc.replace(
	/export interface GraphStartedEvent extends BaseEvent \{/g,
	"export interface GraphStartedEvent {",
);
eventsSrc = eventsSrc.replace(
	/export interface GraphCompletedEvent extends BaseEvent \{/g,
	"export interface GraphCompletedEvent {",
);
fs.writeFileSync(eventsPath, eventsSrc);

const orchPath = path.join(
	process.cwd(),
	"packages/kernel/src/orchestrator.ts",
);
let orchSrc = fs.readFileSync(orchPath, "utf8");
orchSrc = orchSrc.replace(
	/kind: "graph-started",\n\s*runId: graphId,/g,
	`kind: "graph-started",`,
);
orchSrc = orchSrc.replace(
	/kind: "graph-completed",\n\s*runId: graphId,/g,
	`kind: "graph-completed",`,
);
fs.writeFileSync(orchPath, orchSrc);

const storePath = path.join(
	process.cwd(),
	"packages/storage/src/event-store.ts",
);
const storeSrc = fs.readFileSync(storePath, "utf8");
// Let's see what persistEvent does.
// It assumes ALL events have a runId!
// "JSON.stringify({ ...payload, runId })" BUT we pass runId as an argument to persistEvent.
// Where is runId coming from when the CLI calls persistEvent?
// Let's look at apps/cli/src/run-cli.ts
