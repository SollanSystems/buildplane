import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createToolRegistry } from "@buildplane/adapters-tools";
import { validateCapabilityBundle } from "@buildplane/capability-broker";
import {
	buildDefaultCapabilityBundleForPlan,
	createPlanForgeDryRunPlan,
} from "@buildplane/planforge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const inputFixture = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../apps/cli/test/fixtures/planforge/goal-input.md",
);

/**
 * M3 GATE — proves the capability broker is enforceable, not documentary: the
 * default bundle derived from an admitted plan confines BOTH tool surfaces
 * (`write_file` + `run_command`) of the real `createToolRegistry`, fail-closed,
 * and quarantines every denial. The toy plan declares doc/fixture/receipt writes
 * (`docs/**`, fixtures, `docs/operations/**`) and `git`/`pnpm` commands.
 */
describe("capability broker M3 gate", () => {
	let root: string;
	const denials: Array<{ tool: string; target: string }> = [];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bp-m3-gate-"));
		denials.length = 0;
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function registryForAdmittedPlan() {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const validated = validateCapabilityBundle(
			buildDefaultCapabilityBundleForPlan(plan),
		);
		if (!validated.ok) {
			throw new Error(validated.errors.join("; "));
		}
		return createToolRegistry(root, {
			capabilityBundle: validated.bundle,
			onCapabilityDenied: (detail) => {
				denials.push({ tool: detail.tool, target: detail.target });
			},
		});
	}

	it("allows an in-scope write declared by the admitted plan", () => {
		const result = registryForAdmittedPlan().write_file({
			path: "docs/generated-note.md",
			content: "hello",
		});
		expect(result.success).toBe(true);
		expect(existsSync(join(root, "docs/generated-note.md"))).toBe(true);
		expect(denials).toHaveLength(0);
	});

	it("denies an out-of-scope write, leaves no file, and quarantines it", () => {
		const result = registryForAdmittedPlan().write_file({
			path: "src/secret.ts",
			content: "exfil",
		});
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/capability broker/i);
		expect(existsSync(join(root, "src/secret.ts"))).toBe(false);
		expect(denials).toEqual([{ tool: "write_file", target: "src/secret.ts" }]);
	});

	it("allows a command in the admitted plan's allowlist (git)", () => {
		const result = registryForAdmittedPlan().run_command({
			command: "git",
			args: ["--version"],
		});
		expect(result.success).toBe(true);
		expect(denials).toHaveLength(0);
	});

	it("denies a command outside the allowlist, without spawning, and quarantines it", () => {
		const result = registryForAdmittedPlan().run_command({
			command: "curl",
			args: ["http://evil.example"],
		});
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/capability broker/i);
		expect(denials).toEqual([
			{ tool: "run_command", target: "curl http://evil.example" },
		]);
	});
});
