const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(
	process.cwd(),
	"packages/storage/src/event-store.ts",
);
let storeSrc = fs.readFileSync(storePath, "utf8");

storeSrc = storeSrc.replace(
	/\.run\([\s\S]*?id,[\s\S]*?kind,[\s\S]*?timestamp,[\s\S]*?JSON\.stringify\(\{ \.\.\.payload, runId \}\),[\s\S]*?\);/g,
	`.run(
					String(id),
					String(kind),
					String(timestamp),
					JSON.stringify({ ...payload, runId }),
				);`,
);

fs.writeFileSync(storePath, storeSrc);
