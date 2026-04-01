const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(
	process.cwd(),
	"packages/storage/src/event-store.ts",
);
let storeSrc = fs.readFileSync(storePath, "utf8");

// Print randomUUID to see if it's there
storeSrc = storeSrc.replace(
	/const database = openDb\(\);/g,
	`const database = openDb();
			if (!randomUUID) {
				console.error("WAIT, randomUUID is undefined!!!");
			}`,
);

fs.writeFileSync(storePath, storeSrc);
