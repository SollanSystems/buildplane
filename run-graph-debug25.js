const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(
	process.cwd(),
	"packages/storage/src/event-store.ts",
);
let storeSrc = fs.readFileSync(storePath, "utf8");

storeSrc = storeSrc.replace(
	/console\.log\("PERSIST EVENT:"[\s\S]*?\}/g,
	`console.log("PERSIST EVENT BINDINGS:");
			console.log("1:", randomUUID());
			console.log("2:", kind);
			console.log("3:", timestamp);
			console.log("4:", JSON.stringify({ ...payload, runId }));`,
);

fs.writeFileSync(storePath, storeSrc);
