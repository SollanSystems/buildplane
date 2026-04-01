const fs = require("fs");
let code = fs.readFileSync("test/integration/graph-cli.test.ts", "utf8");

// runCli doesn't return a result in the source file, it's an async function that just runs.
// We need to use `runCli` from cli-test-helper, but we imported `runCli` directly from `src`.
// Oh, the `cli-test-helper` exists in `apps/cli/test/cli-test-helper.ts`.
// But we can't import from there without using the TS path because the test is in the root.
// Wait, `apps/cli/test` has `runCli` exported? Yes.

code = code.replace(
	'import { runCli } from "../../apps/cli/src/run-cli.js";',
	'import { runCli } from "../../apps/cli/test/cli-test-helper";',
);
// wait, `apps/cli/test/cli-test-helper` might need `.js` or something. Or we just execute the CLI directly!

code = `
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";

function createTempRoot(prefix: string) {
    return mkdtempSync(join(tmpdir(), prefix));
}

function createCommittedRepo(): string {
	const root = createTempRoot("buildplane-graph-cli-");
	execFileSync("git", ["init"], { cwd: root });
	execFileSync("git", ["config", "user.name", "test"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
	writeFileSync(join(root, "README.md"), "hello\\n");
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-m", "init"], { cwd: root });
	return root;
}

describe("graph CLI commands", () => {
    it("can run a graph successfully via node", () => {
        const repo = createCommittedRepo();
        const cliPath = join(__dirname, "../../apps/cli/dist/cli.js");

        execFileSync(process.execPath, [cliPath, "init"], { cwd: repo });
        
        const graph = {
            nodes: [
                {
                    id: "A",
                    dependencies: [],
                    packet: {
                        unitId: "unit-a",
                        kind: "command",
                        entrypoint: "echo",
                        args: ["A"]
                    }
                }
            ]
        };
        const graphPath = join(repo, "graph.json");
        writeFileSync(graphPath, JSON.stringify(graph, null, 2));

        const output = execFileSync(process.execPath, [cliPath, "run-graph", "--graph", graphPath], { cwd: repo, encoding: "utf8" });
        expect(output).toContain("Run complete for A");
    });
});
`;
fs.writeFileSync("test/integration/graph-cli.test.ts", code);
