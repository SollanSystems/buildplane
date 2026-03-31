const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(process.cwd(), "packages/storage/src/event-store.ts");
let storeSrc = fs.readFileSync(storePath, "utf8");

storeSrc = storeSrc.replace(
    /const database = openDb\(\);/g,
    `const database = openDb();
			if (typeof kind !== "string" || typeof timestamp !== "string") {
				console.error("WAIT, kind or timestamp is NOT A STRING!!! event:", JSON.stringify(event));
			}`
);

fs.writeFileSync(storePath, storeSrc);
