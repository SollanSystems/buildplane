const fs = require("fs");
let code = fs.readFileSync("packages/kernel/src/index.ts", "utf8");

// Ensure graph functions are exported properly so apps/cli/test/kernel-import.test.ts passes
code = code.replace(
	'export { createBuildplaneOrchestrator } from "./orchestrator.js";',
	'export { createBuildplaneOrchestrator } from "./orchestrator.js";\nexport { createGraphScheduler } from "./graph.js";',
);

// We already export createGraphScheduler at the bottom, so this test failure
// means we need to update the snapshot in the test itself.
