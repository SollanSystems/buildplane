const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(
	process.cwd(),
	"packages/storage/src/event-store.ts",
);
let storeSrc = fs.readFileSync(storePath, "utf8");

// Print out if it's the specific bug by not passing the object properties to the sql
storeSrc = storeSrc.replace(
	/\.run\([\s\S]*?randomUUID\(\),[\s\S]*?event\.kind,[\s\S]*?event\.timestamp,[\s\S]*?JSON\.stringify\(\{ \.\.\.event, runId \}\),[\s\S]*?\);/g,
	`.run(
					randomUUID(),
					String(event.kind),
					String(event.timestamp),
					JSON.stringify({ ...event, runId })
				);`,
);

fs.writeFileSync(storePath, storeSrc);
