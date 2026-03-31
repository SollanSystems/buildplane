const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(process.cwd(), "packages/storage/src/event-store.ts");
let storeSrc = fs.readFileSync(storePath, "utf8");

// Log the SQLite error specifically
storeSrc = storeSrc.replace(
    /\.run\(\{\n\s*id: randomUUID\(\),\n\s*kind: event\.kind,\n\s*occurred_at: event\.timestamp,\n\s*payload: JSON\.stringify\(\{ \.\.\.payload, runId \}\)\n\s*\}\);/g,
    `try {
					.run({
						id: randomUUID(),
						kind: event.kind,
						occurred_at: event.timestamp,
						payload: JSON.stringify({ ...payload, runId })
					});
				} catch (err) {
					console.error("SQLITE EXECUTION ERROR", err, event);
					throw err;
				}`
);

fs.writeFileSync(storePath, storeSrc);
