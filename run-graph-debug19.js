const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(process.cwd(), "packages/storage/src/event-store.ts");
let storeSrc = fs.readFileSync(storePath, "utf8");

storeSrc = storeSrc.replace(
    /if \(\!kind\) \{[\s\S]*?\}/g,
    `if (!kind || !timestamp) {
				console.log("WAIT, kind or timestamp is undefined!!! event:", JSON.stringify(event));
			}`
);

fs.writeFileSync(storePath, storeSrc);
