const fs = require("node:fs");
const path = require("node:path");

const eventsPath = path.join(process.cwd(), "packages/kernel/src/events.ts");
let eventsSrc = fs.readFileSync(eventsPath, "utf8");

// REVERT GraphStartedEvent and GraphCompletedEvent back to NOT extending BaseEvent
eventsSrc = eventsSrc.replace(
    /export interface GraphStartedEvent extends BaseEvent \{/g,
    "export interface GraphStartedEvent {"
);
eventsSrc = eventsSrc.replace(
    /export interface GraphCompletedEvent extends BaseEvent \{/g,
    "export interface GraphCompletedEvent {"
);
fs.writeFileSync(eventsPath, eventsSrc);

const orchPath = path.join(process.cwd(), "packages/kernel/src/orchestrator.ts");
let orchSrc = fs.readFileSync(orchPath, "utf8");

// Revert the runId: graphId hack
orchSrc = orchSrc.replace(
    /kind: "graph-started",\n\s*runId: graphId,/g,
    `kind: "graph-started",`
);
orchSrc = orchSrc.replace(
    /kind: "graph-completed",\n\s*runId: graphId,/g,
    `kind: "graph-completed",`
);
fs.writeFileSync(orchPath, orchSrc);
