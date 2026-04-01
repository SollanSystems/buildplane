const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(
	process.cwd(),
	"packages/storage/src/event-store.ts",
);
let storeSrc = fs.readFileSync(storePath, "utf8");

storeSrc = storeSrc.replace(
	/console\.log\("PERSIST EVENT BINDINGS:"\);[\s\S]*?console\.log\("4:", JSON\.stringify\(\{ \.\.\.payload, runId \}\)\);/g,
	`console.log("WAIT IS THIS THE UUID BUG?", randomUUID());
			const id = randomUUID();`,
);

storeSrc = storeSrc.replace(
	/\.run\([\s\S]*?randomUUID\(\),[\s\S]*?kind,[\s\S]*?timestamp,[\s\S]*?JSON\.stringify\(\{ \.\.\.payload, runId \}\),[\s\S]*?\);/g,
	`.run(
					id,
					kind,
					timestamp,
					JSON.stringify({ ...payload, runId }),
				);`,
);

fs.writeFileSync(storePath, storeSrc);
