const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");

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

// Open database manually and run the insert
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(path.join(repo, ".buildplane", "state.db"));

try {
	db.prepare(
		`INSERT INTO events (id, kind, occurred_at, payload) VALUES (?, ?, ?, ?)`,
	).run(
		"7f462259-5201-4c2b-9d85-694f94618d09",
		"graph-started",
		"2026-03-23T20:05:12.784Z",
		'{"runId":"2b9c66a0-9413-497d-b31e-080aca25623a","graphId":"2b9c66a0-9413-497d-b31e-080aca25623a","unitCount":1}',
	);
	console.log("INSERT WORKED");
} catch (e) {
	console.log("INSERT FAILED", e);
}
