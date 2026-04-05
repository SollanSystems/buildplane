/**
 * Regression tests for nested project paths:
 * when the project root is a subdirectory of the git repo root, .buildplane
 * state under the project root must be correctly excluded from cleanliness checks.
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitWorktreeAdapter } from "../src";

const tempRoots: string[] = [];

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

describe("nested project path support", () => {
	it("ignores .buildplane state under a nested project root during cleanliness check", () => {
		// Create a repo with a services/api/ subdirectory as the project root
		const repoRoot = createCommittedRepo("services/api");
		const projectRoot = join(repoRoot, "services", "api");
		const adapter = createGitWorktreeAdapter();

		// Simulate buildplane state files that accumulate under the nested project root
		mkdirSync(join(projectRoot, ".buildplane", "logs"), { recursive: true });
		writeFileSync(
			join(projectRoot, ".buildplane", "state.db"),
			"sqlite-state\n",
		);
		writeFileSync(
			join(projectRoot, ".buildplane", "project.json"),
			'{"schemaVersion":1}\n',
		);
		writeFileSync(
			join(projectRoot, ".buildplane", "logs", "run-1.stdout.log"),
			"log output\n",
		);
		mkdirSync(join(projectRoot, ".buildplane", "workspaces", "run-retained"), {
			recursive: true,
		});
		writeFileSync(
			join(
				projectRoot,
				".buildplane",
				"workspaces",
				"run-retained",
				"note.txt",
			),
			"retained workspace\n",
		);

		// assertRunnableRepository must succeed — .buildplane state is excluded
		expect(() => adapter.assertRunnableRepository(projectRoot)).not.toThrow();
		expect(adapter.assertRunnableRepository(projectRoot)).toMatchObject({
			headSha: expect.stringMatching(/^[0-9a-f]{40}$/),
		});
	});

	it("still rejects actual dirty files in the project when nested", () => {
		const repoRoot = createCommittedRepo("services/api");
		const projectRoot = join(repoRoot, "services", "api");
		const adapter = createGitWorktreeAdapter();

		// Dirty file outside .buildplane — should still be detected
		writeFileSync(join(projectRoot, "dirty.ts"), "export const x = 1;\n");

		expect(() => adapter.assertRunnableRepository(projectRoot)).toThrow(
			/working tree is not clean/i,
		);
	});

	it("workspace is created under the nested project root, not the repo root", () => {
		const repoRoot = createCommittedRepo("services/api");
		const projectRoot = join(repoRoot, "services", "api");
		const adapter = createGitWorktreeAdapter();

		const { headSha } = adapter.assertRunnableRepository(projectRoot);
		const workspace = adapter.prepareWorkspace(
			projectRoot,
			"run-nested-1",
			headSha,
		);

		try {
			// Workspace path must be under projectRoot/.buildplane, not repoRoot/.buildplane
			expect(workspace.path).toContain(
				join(projectRoot, ".buildplane", "workspaces"),
			);
			expect(workspace.path).not.toContain(join(repoRoot, ".buildplane"));
			expect(existsSync(workspace.path)).toBe(true);
		} finally {
			adapter.deleteWorkspace(workspace);
		}
	});

	it("second assertRunnableRepository passes after first run leaves .buildplane state (regression)", () => {
		// This is the direct regression: ensure a second packet can run after the first
		// produces .buildplane artifacts under a nested project root.
		const repoRoot = createCommittedRepo("services/api");
		const projectRoot = join(repoRoot, "services", "api");
		const adapter = createGitWorktreeAdapter();

		// First run: assertRunnableRepository + prepare + delete
		const { headSha } = adapter.assertRunnableRepository(projectRoot);
		const workspace = adapter.prepareWorkspace(projectRoot, "run-1", headSha);
		adapter.deleteWorkspace(workspace);

		// Simulate state files left by the first run (state.db, evidence, etc.)
		mkdirSync(join(projectRoot, ".buildplane", "evidence"), {
			recursive: true,
		});
		writeFileSync(
			join(projectRoot, ".buildplane", "state.db"),
			"post-run-state\n",
		);
		writeFileSync(
			join(projectRoot, ".buildplane", "evidence", "run-1.json"),
			'{"runId":"run-1"}\n',
		);

		// Second packet: assertRunnableRepository must NOT fail because of .buildplane state
		expect(() => adapter.assertRunnableRepository(projectRoot)).not.toThrow();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Creates a git repo with an initial commit and a nested subdirectory that
 * also has an initial file committed. The subdirectory can be used as a nested
 * project root (e.g. "services/api").
 */
function createCommittedRepo(nestedPath: string): string {
	const root = mkdtempSync(join(tmpdir(), "buildplane-nested-"));
	tempRoots.push(root);

	runGitOrThrow(root, ["init"]);
	runGitOrThrow(root, ["config", "user.name", "Buildplane Test"]);
	runGitOrThrow(root, ["config", "user.email", "test@example.com"]);

	// Create and commit a file at the repo root
	writeFileSync(join(root, "root.txt"), "root\n");
	runGitOrThrow(root, ["add", "root.txt"]);
	runGitOrThrow(root, ["commit", "-m", "initial"]);

	// Create and commit a file in the nested subdirectory
	const nested = join(root, ...nestedPath.split("/"));
	mkdirSync(nested, { recursive: true });
	writeFileSync(join(nested, "service.ts"), "export {};\n");
	runGitOrThrow(root, ["add", nestedPath]);
	runGitOrThrow(root, ["commit", "-m", `add ${nestedPath}`]);

	return root;
}

function runGitOrThrow(cwd: string, args: string[]): void {
	const result = spawnSync("git", args, {
		cwd,
		env: isolatedGitEnv(),
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim());
	}
}

function isolatedGitEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) {
			delete env[key];
		}
	}
	return env;
}
