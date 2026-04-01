const fs = require("node:fs");
const path = require("node:path");

const eventsPath = path.join(process.cwd(), "packages/kernel/src/events.ts");
const eventsSrc = fs.readFileSync(eventsPath, "utf8");

// Put runId back on GraphStartedEvent but make it OPTIONAL for BaseEvent! No, wait, BaseEvent requires it.
// If the type requires runId, we have to provide it.
// We should make GraphStartedEvent extend BaseEvent, and in orchestrator pass graphId as runId.
// Oh wait... earlier we tried that and it FAILED with "Provided value cannot be bound to SQLite parameter 2."
// Oh... look at the SQL query:
// INSERT INTO events (id, kind, occurred_at, payload) VALUES (?, ?, ?, ?)
// 1 = randomUUID()
// 2 = kind
// 3 = timestamp
// 4 = JSON.stringify({ ...payload, runId })
// Parameter 2 is `kind`. Wait... `kind` is undefined?
// Let's check `const { kind, timestamp, ...payload } = event;`
// If `event` does not have `kind`, then `kind` is undefined!
// Why wouldn't it have `kind`?
// Let's console log the event being passed to persistEvent!
