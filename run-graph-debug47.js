const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(
	process.cwd(),
	"packages/storage/src/event-store.ts",
);
let storeSrc = fs.readFileSync(storePath, "utf8");

// Try to write it directly without any spread
storeSrc = storeSrc.replace(
	/const \{ kind, timestamp, \.\.\.payload \} = event;/g,
	`// removed`,
);

storeSrc = storeSrc.replace(
	/\.run\([\s\S]*?randomUUID\(\),[\s\S]*?kind,[\s\S]*?timestamp,[\s\S]*?JSON\.stringify\(\{ \.\.\.payload, runId \}\),[\s\S]*?\);/g,
	`.run(
					randomUUID(),
					event.kind,
					event.timestamp,
					JSON.stringify({ ...event, runId }),
				);`,
);

fs.writeFileSync(storePath, storeSrc);
