const cp = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

function createCommittedRepo() {
	const root = fs.mkdtempSync(
		path.join(require("node:os").tmpdir(), "buildplane-graph-cli-"),
	);
	cp.execFileSync("git", ["init"], { cwd: root });
	cp.execFileSync("git", ["config", "user.name", "test"], { cwd: root });
	cp.execFileSync("git", ["config", "user.email", "test@example.com"], {
		cwd: root,
	});
	fs.writeFileSync(path.join(root, "README.md"), "hello\n");
	cp.execFileSync("git", ["add", "."], { cwd: root });
	cp.execFileSync("git", ["commit", "-m", "init"], { cwd: root });
	return root;
}

const repo = createCommittedRepo();
const cliPath = path.join(process.cwd(), "apps/cli/src/index.ts");
const tsxPath = path.join(process.cwd(), "node_modules/tsx/dist/loader.mjs");

cp.execFileSync(process.execPath, ["--import", tsxPath, cliPath, "init"], {
	cwd: repo,
	encoding: "utf8",
});

const graph = {
	nodes: [
		{
			unit: { id: "unit-a" },
			dependencies: [],
			execution: {
				kind: "command",
				entrypoint: "echo",
				args: ["A"],
			},
			verification: { requiredOutputs: [] },
		},
	],
};
const graphPath = path.join(repo, "graph.json");
fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2));

try {
	const stdout = cp.execFileSync(
		process.execPath,
		["--import", tsxPath, cliPath, "run-graph", "--graph", graphPath],
		{ cwd: repo, encoding: "utf8", env: { ...process.env, DEBUG: "*" } },
	);
	console.log("STDOUT:", stdout);
} catch (e) {
	console.log("CRASH:", e.stderr);
}
