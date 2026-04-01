const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(
	process.cwd(),
	"packages/storage/src/event-store.ts",
);
let storeSrc = fs.readFileSync(storePath, "utf8");

// Print database schema
storeSrc = storeSrc.replace(
	/const database = openDb\(\);/g,
	`const database = openDb();
			console.log("SCHEMA:", database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='events'").get());`,
);

fs.writeFileSync(storePath, storeSrc);
