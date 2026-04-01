const fs = require("fs");
const code = fs.readFileSync("packages/kernel/src/ports.ts", "utf8");

const target = `	deleteWorkspace(workspace: { path: string }): {
		deleted: boolean;
		cleanupError?: string;
	};`;

const replacement = `	commitAndMergeWorkspace?(workspace: { path: string; runId: string }): void;
	deleteWorkspace(workspace: { path: string }): {
		deleted: boolean;
		cleanupError?: string;
	};`;

fs.writeFileSync(
	"packages/kernel/src/ports.ts",
	code.replace(target, replacement),
);
