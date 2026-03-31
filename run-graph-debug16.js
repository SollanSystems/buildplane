const fs = require("node:fs");
const path = require("node:path");

const eventsPath = path.join(process.cwd(), "packages/kernel/src/events.ts");
let eventsSrc = fs.readFileSync(eventsPath, "utf8");

// Export GraphStartedEvent and GraphCompletedEvent as BaseEvent
eventsSrc = eventsSrc.replace(
    /export interface GraphStartedEvent \{/g,
    "export interface GraphStartedEvent extends BaseEvent {"
);
eventsSrc = eventsSrc.replace(
    /export interface GraphCompletedEvent \{/g,
    "export interface GraphCompletedEvent extends BaseEvent {"
);
fs.writeFileSync(eventsPath, eventsSrc);

const orchPath = path.join(process.cwd(), "packages/kernel/src/orchestrator.ts");
let orchSrc = fs.readFileSync(orchPath, "utf8");

// Wait, the emit method inside kernel takes an `ExecutionEvent`.
// If we emit an object that matches the type but the storage engine doesn't serialize it right?
// Wait, `JSON.stringify({ ...payload, runId })` DOES include `runId` explicitly.
// `JSON.stringify` does NOT include `kind` because `kind` was destructured!
// `const { kind, timestamp, ...payload } = event;`
// AND NO KIND is put in the `payload` json.
// The SQL binds `kind` as a column `VALUES (?, ?, ?, ?)`, 2nd arg is `kind`.

orchSrc = orchSrc.replace(
    /kind: "graph-started",\n\s*graphId,/g,
    `kind: "graph-started",
				runId: graphId,
				graphId,`
);
orchSrc = orchSrc.replace(
    /kind: "graph-completed",\n\s*graphId,/g,
    `kind: "graph-completed",
				runId: graphId,
				graphId,`
);
fs.writeFileSync(orchPath, orchSrc);

console.log("WAIT... `randomUUID()` is used for `id`. But `randomUUID` is NOT imported from `crypto`?!");
