const fs = require("node:fs");
const path = require("node:path");

const eventsPath = path.join(process.cwd(), "packages/kernel/src/events.ts");
const eventsSrc = fs.readFileSync(eventsPath, "utf8");

// BaseEvent has `runId`. GraphStartedEvent and GraphCompletedEvent don't naturally have a single runId!
// In `eventStore.persistEvent(runId, event)`, runId comes from the FIRST ARGUMENT.
// BUT in `apps/cli/src/run-cli.ts`, it says:
// `const e = event as { runId?: string }; if (e.runId) { eventStore.persistEvent(e.runId, event as never); }`
// The graph events DO NOT HAVE a runId! And we added `runId: graphId` as a hack in orchestrator!
// Let's check `eventStore.persistEvent`.
// `const { kind, timestamp, ...payload } = event;`
// `JSON.stringify({ ...payload, runId })`

console.log(
	"WAIT, IS `kind` THE SECOND PARAMETER TO `INSERT INTO events (id, kind, occurred_at, payload) VALUES (?, ?, ?, ?)`?",
);
