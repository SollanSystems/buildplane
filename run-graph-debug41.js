const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(
	process.cwd(),
	"packages/storage/src/event-store.ts",
);
let storeSrc = fs.readFileSync(storePath, "utf8");

storeSrc = storeSrc.replace(
	/\.run\([\s\S]*?String\(randomUUID\(\)\),[\s\S]*?String\(kind\),[\s\S]*?String\(timestamp\),[\s\S]*?String\(JSON\.stringify\(\{ \.\.\.payload, runId \}\)\),[\s\S]*?\);/g,
	`.run(
					randomUUID(),
					kind,
					timestamp,
					JSON.stringify({ ...payload, runId }),
				);`,
);

fs.writeFileSync(storePath, storeSrc);
