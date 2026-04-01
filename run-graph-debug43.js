const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(
	process.cwd(),
	"packages/storage/src/event-store.ts",
);
let storeSrc = fs.readFileSync(storePath, "utf8");

storeSrc = storeSrc.replace(
	/const \{ kind, timestamp, \.\.\.payload \} = event;/g,
	`const { kind, timestamp, ...payload } = event;
			if (!kind) {
				console.error("UNDEFINED KIND", JSON.stringify(event));
			}`,
);

fs.writeFileSync(storePath, storeSrc);
