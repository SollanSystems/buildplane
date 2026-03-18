import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBuildplaneStorage } from "../src";

describe("project initialization", () => {
	it("creates the .buildplane layout and project metadata idempotently", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-init-"));
		const storage = createBuildplaneStorage(root);

		const first = storage.initializeProject();
		const second = storage.initializeProject();
		const projectJson = JSON.parse(
			readFileSync(join(root, ".buildplane", "project.json"), "utf8"),
		);

		expect(first.created).toBe(true);
		expect(first.projectRoot).toBe(root);
		expect(first.stateDbPath).toBe(join(root, ".buildplane", "state.db"));
		expect(second.created).toBe(false);
		expect(second.projectRoot).toBe(root);
		expect(second.stateDbPath).toBe(join(root, ".buildplane", "state.db"));
		expect(projectJson).toMatchObject({
			schemaVersion: 1,
			defaultPolicyProfile: "default",
		});
		expect(projectJson.initializedAt).toEqual(expect.any(String));
	});

	it("fails with guidance when project.json exists but state.db is missing", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-bad-init-"));
		const buildplaneDir = join(root, ".buildplane");
		mkdirSync(buildplaneDir, { recursive: true });
		writeFileSync(
			join(buildplaneDir, "project.json"),
			JSON.stringify({
				schemaVersion: 1,
				defaultPolicyProfile: "default",
				initializedAt: new Date().toISOString(),
			}),
		);

		const storage = createBuildplaneStorage(root);

		expect(() => storage.initializeProject()).toThrow(
			/state\.db is missing|incomplete/i,
		);
	});
});
