import { execSync } from "child_process";

try {
	execSync("pnpm exec vitest test/integration/graph-e2e.test.ts", {
		stdio: "inherit",
	});
} catch (e) {
	console.log("FAILED");
}
