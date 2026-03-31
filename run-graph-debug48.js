const fs = require("node:fs");
const path = require("node:path");

const storePath = path.join(process.cwd(), "packages/storage/src/event-store.ts");
let storeSrc = fs.readFileSync(storePath, "utf8");

storeSrc = storeSrc.replace(
    /if \(\!kind\) \{\n\s*console\.error\("UNDEFINED KIND", JSON\.stringify\(event\)\);\n\s*\}/g,
    ``
);

fs.writeFileSync(storePath, storeSrc);
