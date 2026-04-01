const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(
	process.cwd(),
	"packages/storage/src/event-store.ts",
);
let storeSrc = fs.readFileSync(storePath, "utf8");

// Print the database prepare exact sql
storeSrc = storeSrc.replace(
	/\.prepare\([\s\S]*?`INSERT INTO events \(id, kind, occurred_at, payload\) VALUES \(\?, \?, \?, \?\)`,\n\s*\)/g,
	`.prepare("INSERT INTO events (id, kind, occurred_at, payload) VALUES (?, ?, ?, ?)")`,
);

fs.writeFileSync(storePath, storeSrc);
