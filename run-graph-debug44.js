const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(
	process.cwd(),
	"packages/storage/src/event-store.ts",
);
let storeSrc = fs.readFileSync(storePath, "utf8");

storeSrc = storeSrc.replace(
	/\.run\([\s\S]*?randomUUID\(\),[\s\S]*?kind,[\s\S]*?timestamp,[\s\S]*?JSON\.stringify\(\{ \.\.\.payload, runId \}\),[\s\S]*?\);/g,
	`.run(
					randomUUID(),
					kind,
					timestamp,
					JSON.stringify({ ...payload, runId }),
				);`,
);

fs.writeFileSync(storePath, storeSrc);

const orchPath = path.join(
	process.cwd(),
	"packages/kernel/src/orchestrator.ts",
);
let orchSrc = fs.readFileSync(orchPath, "utf8");

orchSrc = orchSrc.replace(
	/kind: "graph-started",\n\s*runId: graphId,\n\s*graphId,/g,
	`kind: "graph-started",
				runId: graphId,
				graphId,`,
);
fs.writeFileSync(orchPath, orchSrc);
