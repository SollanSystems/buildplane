const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(
	process.cwd(),
	"packages/storage/src/event-store.ts",
);
let storeSrc = fs.readFileSync(storePath, "utf8");

// Since GraphStartedEvent already HAS `runId: string`, it DOES NOT go into `...payload` because it's part of the event type, wait, NO!
// `const { kind, timestamp, ...payload } = event;`
// If `event` has `runId`, it WILL go into `...payload`!
// And we ALSO pass `{ ...payload, runId }`. This overrides the `runId` inside `payload` with the `runId` from the FIRST ARGUMENT!
// BUT what is `runId` from the first argument?
// In `run-cli.ts`, it is `eventStore.persistEvent(e.runId, event)`.
// So `runId` IS defined.
// WHAT is the error exactly?! "Provided value cannot be bound to SQLite parameter 2."
// Which value? Is `kind` undefined AT RUNTIME? Let's find out!

storeSrc = storeSrc.replace(
	/const database = openDb\(\);/g,
	`const database = openDb();
			if (!kind) {
				console.error("UNDEFINED KIND", JSON.stringify(event));
			}`,
);

fs.writeFileSync(storePath, storeSrc);
