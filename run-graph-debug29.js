const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(process.cwd(), "packages/storage/src/store.ts");
const storeSrc = fs.readFileSync(storePath, "utf8");
console.log(storeSrc.match(/CREATE TABLE IF NOT EXISTS events[\s\S]*?\)/)[0]);
