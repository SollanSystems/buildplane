const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(process.cwd(), "packages/storage/src/event-store.ts");
let storeSrc = fs.readFileSync(storePath, "utf8");

storeSrc = storeSrc.replace(
    /\.run\(\{\n\s*id: String\(id\),\n\s*kind: String\(event\.kind\),\n\s*occurred_at: String\(event\.timestamp\),\n\s*payload: String\(JSON\.stringify\(\{ \.\.\.payload, runId \}\)\)\n\s*\}\);/g,
    `.run({
					id: randomUUID(),
					kind: event.kind,
					occurred_at: event.timestamp,
					payload: JSON.stringify({ ...payload, runId })
				});`
);

fs.writeFileSync(storePath, storeSrc);
