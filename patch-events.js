const fs = require("node:fs");
const path = require("node:path");

const eventsPath = path.join(process.cwd(), "packages/kernel/src/events.ts");
const eventsSrc = fs.readFileSync(eventsPath, "utf8");

// Is ExecutionEvent Union including GraphStartedEvent and GraphCompletedEvent?
console.log(eventsSrc.match(/export type ExecutionEvent =[\s\S]*?;/)[0]);
