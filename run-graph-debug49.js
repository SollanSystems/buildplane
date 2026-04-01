const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(
	process.cwd(),
	"packages/storage/src/event-store.ts",
);
let storeSrc = fs.readFileSync(storePath, "utf8");

storeSrc = storeSrc.replace(
	/try \{[\s\S]*?\.run\(\{\n\s*id: randomUUID\(\),\n\s*kind: event\.kind,\n\s*occurred_at: event\.timestamp,\n\s*payload: JSON\.stringify\(\{ \.\.\.payload, runId \}\)\n\s*\}\);[\s\S]*?\} catch \(err\) \{/g,
	`try {
					database.prepare("INSERT INTO events (id, kind, occurred_at, payload) VALUES (@id, @kind, @occurred_at, @payload)")
						.run({
							id: randomUUID(),
							kind: event.kind,
							occurred_at: event.timestamp,
							payload: JSON.stringify({ ...event, runId })
						});
				} catch (err) {`,
);

fs.writeFileSync(storePath, storeSrc);
