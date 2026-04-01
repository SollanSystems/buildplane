const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(
	process.cwd(),
	"packages/storage/src/event-store.ts",
);
let storeSrc = fs.readFileSync(storePath, "utf8");

// Try to use a completely fresh statement without destructuring or fancy things.
storeSrc = storeSrc.replace(
	/\.run\([\s\S]*?String\(id\),[\s\S]*?String\(kind\),[\s\S]*?String\(timestamp\),[\s\S]*?String\(JSON\.stringify\(\{ \.\.\.payload, runId \}\)\),[\s\S]*?\);/g,
	`.run(
					String(id),
					event.kind,
					event.timestamp,
					JSON.stringify({ ...event, runId }),
				);`,
);

fs.writeFileSync(storePath, storeSrc);
