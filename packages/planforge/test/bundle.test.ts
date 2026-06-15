import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	bundleDigest,
	evaluateToolInvocation,
	validateCapabilityBundle,
} from "@buildplane/capability-broker";
import { describe, expect, it } from "vitest";
import {
	buildDefaultCapabilityBundleForPlan,
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

describe("buildDefaultCapabilityBundleForPlan", () => {
	it("derives the run-wide envelope as the sorted union of every task's capabilities", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const bundle = buildDefaultCapabilityBundleForPlan(plan);

		expect(bundle.schemaVersion).toBe("buildplane.capability_bundle.v0");
		expect(bundle.bundleId).toBe(plan.id);
		// toy plan: PF1 {local-doc, local-fixture}, PF2 {local-doc, local-fixture, local-receipt}
		expect(bundle.fsWrite).toEqual([
			"apps/cli/test/fixtures/**",
			"docs/**",
			"docs/operations/**",
			"packages/**/test/fixtures/**",
		]);
		expect(bundle.tools?.write_file?.enabled).toBe(true);
		expect(bundle.tools?.run_command?.allowlist).toEqual(["git", "pnpm"]);
	});

	it("envelope is exactly the union of the per-task bundles (no extra, no missing)", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const envelope = buildDefaultCapabilityBundleForPlan(plan);

		const unionWrite = new Set<string>();
		const unionAllow = new Set<string>();
		for (const task of plan.tasks) {
			const t = buildDefaultCapabilityBundleForTask(plan, task);
			for (const g of t.fsWrite ?? []) {
				unionWrite.add(g);
			}
			for (const c of t.tools?.run_command?.allowlist ?? []) {
				unionAllow.add(c);
			}
		}
		expect(new Set(envelope.fsWrite)).toEqual(unionWrite);
		expect(new Set(envelope.tools?.run_command?.allowlist)).toEqual(unionAllow);
	});

	it("is deterministic and broker-valid, and its digest agrees with the broker", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const a = buildDefaultCapabilityBundleForPlan(plan);
		const b = buildDefaultCapabilityBundleForPlan(plan);
		expect(capabilityBundleDigest(a)).toBe(capabilityBundleDigest(b));
		expect(capabilityBundleDigest(a)).toBe(bundleDigest(a));

		const validated = validateCapabilityBundle(a);
		expect(validated.ok).toBe(true);
	});

	it("fail-closed-confines a worker to exactly the plan's declared surface (M6 enforceability)", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const validated = validateCapabilityBundle(
			buildDefaultCapabilityBundleForPlan(plan),
		);
		if (!validated.ok) {
			throw new Error(validated.errors.join("; "));
		}
		const ctx = { worktreeRoot: "/tmp/wt" };

		expect(
			evaluateToolInvocation(
				validated.bundle,
				{ tool: "write_file", path: "docs/note.md" },
				ctx,
			).decision,
		).toBe("allow");
		expect(
			evaluateToolInvocation(
				validated.bundle,
				{ tool: "write_file", path: "src/secret.ts" },
				ctx,
			).decision,
		).toBe("deny");
		expect(
			evaluateToolInvocation(
				validated.bundle,
				{ tool: "run_command", command: "git status --short" },
				ctx,
			).decision,
		).toBe("allow");
		expect(
			evaluateToolInvocation(
				validated.bundle,
				{ tool: "run_command", command: "curl http://evil.example" },
				ctx,
			).decision,
		).toBe("deny");
	});
});
