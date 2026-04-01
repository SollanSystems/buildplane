const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(
	process.cwd(),
	"packages/storage/src/event-store.ts",
);
let storeSrc = fs.readFileSync(storePath, "utf8");

// Try hardcoding a fixed string for kind to see if the error goes away.
// Wait, the error is `Provided value cannot be bound to SQLite parameter 2.`
// Parameter 2 is `kind`.
// In our logs:
// SQLITE VALUES: [
//   'f2367a68-bfcf-4b20-b9bc-21c3eaa1a0fd',
//   'graph-started',
//   '2026-03-23T20:05:40.617Z',
//   '{"runId":"cee21f03-1659-4714-910b-4c26bc68f479","graphId":"cee21f03-1659-4714-910b-4c26bc68f479","unitCount":1}'
// ]
// We cast them all to Strings! `String(kind)`
// How can a string not be bound to SQLite parameter 2?!

storeSrc = storeSrc.replace(
	/\.run\([\s\S]*?String\(id\),[\s\S]*?String\(kind\),[\s\S]*?String\(timestamp\),[\s\S]*?String\(JSON\.stringify\(\{ \.\.\.payload, runId \}\)\),[\s\S]*?\);/g,
	`.run(
					id as string,
					kind as string,
					timestamp as string,
					JSON.stringify({ ...payload, runId }) as string,
				);`,
);

fs.writeFileSync(storePath, storeSrc);
