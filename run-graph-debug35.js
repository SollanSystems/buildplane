const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(process.cwd(), "packages/storage/src/event-store.ts");
let storeSrc = fs.readFileSync(storePath, "utf8");

storeSrc = storeSrc.replace(
    /\.run\([\s\S]*?id as string,[\s\S]*?kind as string,[\s\S]*?timestamp as string,[\s\S]*?JSON\.stringify\(\{ \.\.\.payload, runId \}\) as string,[\s\S]*?\);/g,
    `.run(
					String(id),
					String(event.kind),
					String(event.timestamp),
					String(JSON.stringify({ ...payload, runId })),
				);`
);

fs.writeFileSync(storePath, storeSrc);
