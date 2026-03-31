const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(process.cwd(), "packages/storage/src/event-store.ts");
let storeSrc = fs.readFileSync(storePath, "utf8");

storeSrc = storeSrc.replace(
    /\.run\([\s\S]*?String\(id\),[\s\S]*?String\(event\.kind\),[\s\S]*?String\(event\.timestamp\),[\s\S]*?String\(JSON\.stringify\(\{ \.\.\.payload, runId \}\)\),[\s\S]*?\);/g,
    `.run({
					id: String(id),
					kind: String(event.kind),
					occurred_at: String(event.timestamp),
					payload: String(JSON.stringify({ ...payload, runId }))
				});`
);
storeSrc = storeSrc.replace(
    /\.prepare\("INSERT INTO events \(id, kind, occurred_at, payload\) VALUES \(\?, \?, \?, \?\)"\)/g,
    `.prepare("INSERT INTO events (id, kind, occurred_at, payload) VALUES (@id, @kind, @occurred_at, @payload)")`
);

fs.writeFileSync(storePath, storeSrc);
