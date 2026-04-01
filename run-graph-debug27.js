const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(
	process.cwd(),
	"packages/storage/src/event-store.ts",
);
let storeSrc = fs.readFileSync(storePath, "utf8");

storeSrc = storeSrc.replace(
	/if \(typeof kind !== "string"\) \{[\s\S]*?\}/g,
	`if (typeof kind !== "string") {
				console.error("WAIT, kind is NOT A STRING!!! kind:", kind, "event:", JSON.stringify(event));
			}
			console.log("SQLITE VALUES:", [id, kind, timestamp, JSON.stringify({ ...payload, runId })]);`,
);

fs.writeFileSync(storePath, storeSrc);
