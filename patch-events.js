const fs = require("node:fs");
const path = require("node:path");

const eventsPath = path.join(process.cwd(), "packages/kernel/src/events.ts");
let eventsSrc = fs.readFileSync(eventsPath, "utf8");

// Is ExecutionEvent Union including GraphStartedEvent and GraphCompletedEvent?
console.log(eventsSrc.match(/export type ExecutionEvent =[\s\S]*?;/)[0]);
