import { execSync } from "child_process";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const projectRoot = mkdtempSync(join(tmpdir(), "bp-debug-"));
console.log("Root:", projectRoot);
const cliPath = resolve("apps/cli/dist/index.js");
execSync("git init", { cwd: projectRoot });
execSync(`node ${cliPath} init`, { cwd: projectRoot, stdio: "inherit" });
try {
	execSync(`node ${cliPath} run-graph --graph foo.json`, {
		cwd: projectRoot,
		stdio: "inherit",
	});
} catch (e) {
	console.log("Failed:", e.message);
}
