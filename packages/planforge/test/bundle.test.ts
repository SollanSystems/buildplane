import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleDigest } from "@buildplane/capability-broker";
import { describe, expect, it } from "vitest";
import {
	buildDefaultCapabilityBundleForTask,
	capabilityBundleDigest,
} from "../src/bundle.ts";
import { createPlanForgeDryRunPlan } from "../src/index.ts";

const inputFixture = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../apps/cli/test/fixtures/planforge/goal-input.md",
);

describe("buildDefaultCapabilityBundleForTask", () => {
	it("maps allowedSideEffects to fsWrite globs and verificationCommands to allowlist", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const task = plan.tasks[0];
		const bundle = buildDefaultCapabilityBundleForTask(plan, task);
		expect(bundle.bundleId).toBe(`${plan.id}:${task.id}`);
		expect(bundle.fsWrite).toContain("docs/**");
		expect(bundle.tools?.run_command?.allowlist).toEqual(
			expect.arrayContaining(["git", "pnpm"]),
		);
		expect(capabilityBundleDigest(bundle)).toBe(bundleDigest(bundle));
	});
});
