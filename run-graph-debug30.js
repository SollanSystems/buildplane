const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(
	process.cwd(),
	"packages/storage/src/event-store.ts",
);
let storeSrc = fs.readFileSync(storePath, "utf8");

storeSrc = storeSrc.replace(
	/JSON\.stringify\(\{ \.\.\.payload, runId \}\)/g,
	`String(JSON.stringify({ ...payload, runId }))`,
);

fs.writeFileSync(storePath, storeSrc);
