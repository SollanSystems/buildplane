import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	bundleDigest,
	evaluateToolInvocation,
	validateCapabilityBundle,
} from "@buildplane/capability-broker";
import { describe, expect, it } from "vitest";
import { deriveAcceptanceContract } from "../src/acceptance-contract.ts";
import {
	buildDefaultCapabilityBundleForPlan,
	buildDefaultCapabilityBundleForTask,
	capabilityBundleDigest,
	netEgressFromSideEffects,
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

	it("attaches a declarative netEgress allowlist derived from the task's side-effects (M6-S9)", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const task = plan.tasks[0];
		const bundle = buildDefaultCapabilityBundleForTask(plan, task);
		// Every current side-effect maps to zero egress → explicit default-deny.
		expect(bundle.netEgress).toEqual([]);
		// netEgress is digest-covered: planforge + broker digests still agree.
		expect(capabilityBundleDigest(bundle)).toBe(bundleDigest(bundle));
		// The bundle round-trips through the broker with netEgress preserved.
		const validated = validateCapabilityBundle(bundle);
		if (!validated.ok) {
			throw new Error(validated.errors.join("; "));
		}
		expect(validated.bundle.netEgress).toEqual([]);
	});
});

describe("netEgressFromSideEffects", () => {
	it("is the deterministic sorted, de-duped union of per-side-effect egress hosts", () => {
		// Mechanism check: the mapping is a pure union over side-effects. The
		// current vocabulary all maps to zero egress (default-deny); the union of
		// an unknown effect is also empty, never throws.
		expect(netEgressFromSideEffects(["code-edit"])).toEqual([]);
		expect(
			netEgressFromSideEffects(["local-doc", "local-fixture", "code-edit"]),
		).toEqual([]);
		expect(netEgressFromSideEffects([])).toEqual([]);
		expect(netEgressFromSideEffects(["unknown-effect"])).toEqual([]);
	});
});

describe("buildDefaultCapabilityBundleForPlan", () => {
	it("attaches the plan-wide netEgress union (default-deny for the local-only fixture) (M6-S9)", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const bundle = buildDefaultCapabilityBundleForPlan(plan);
		expect(bundle.netEgress).toEqual([]);
		expect(capabilityBundleDigest(bundle)).toBe(bundleDigest(bundle));
	});

	it("derives the run-wide envelope as the sorted union of every task's capabilities", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const bundle = buildDefaultCapabilityBundleForPlan(plan);

		expect(bundle.schemaVersion).toBe("buildplane.capability_bundle.v0");
		expect(bundle.bundleId).toBe(plan.id);
		// task[0]: {local-doc, local-fixture}, task[1]: {local-doc, local-fixture, local-receipt}
		expect(bundle.fsWrite).toEqual([
			"apps/cli/test/fixtures/**",
			"docs/**",
			"docs/operations/**",
			"packages/**/test/fixtures/**",
		]);
		expect(bundle.tools?.write_file?.enabled).toBe(true);
		// `claude` is seeded into every task's allowlist (GAP-4 worker binary), so
		// the plan-wide sorted union carries it alongside the verification argv0s.
		expect(bundle.tools?.run_command?.allowlist).toEqual([
			"claude",
			"git",
			"pnpm",
		]);
	});

	it("covers every task's declared surface and nothing beyond it (no task dropped, no extras)", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const envelope = buildDefaultCapabilityBundleForPlan(plan);

		// Expected surface derived INDEPENDENTLY from the raw task fields via the
		// spec's side-effect→glob contract, NOT by re-calling the builder under
		// test — so a dropped/duplicated task or a wrong glob mapping fails here.
		const sideEffectGlobs: Record<string, string[]> = {
			"local-doc": ["docs/**"],
			"local-fixture": [
				"apps/cli/test/fixtures/**",
				"packages/**/test/fixtures/**",
			],
			"local-receipt": ["docs/operations/**"],
		};
		const expectedWrite = new Set<string>();
		// `claude` is seeded into every task's run_command allowlist (GAP-4 worker
		// binary), independent of the verification-command argv0s derived below.
		const expectedAllow = new Set<string>(["claude"]);
		for (const task of plan.tasks) {
			for (const effect of task.allowedSideEffects) {
				for (const g of sideEffectGlobs[effect] ?? []) {
					expectedWrite.add(g);
				}
			}
			for (const command of task.verificationCommands) {
				const argv0 = command.trim().split(/\s+/)[0];
				if (argv0) {
					expectedAllow.add(argv0);
				}
			}
		}
		expect(new Set(envelope.fsWrite)).toEqual(expectedWrite);
		expect(new Set(envelope.tools?.run_command?.allowlist)).toEqual(
			expectedAllow,
		);
		// task[1] alone declares `local-receipt`; its presence proves task[1] was not dropped.
		expect(envelope.fsWrite).toContain("docs/operations/**");
	});

	it("yields a deny-all envelope for an admitted plan with no tasks", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const envelope = buildDefaultCapabilityBundleForPlan({
			...plan,
			id: "empty-plan",
			tasks: [],
		});
		expect(envelope.bundleId).toBe("empty-plan");
		expect(envelope.fsWrite).toBeUndefined();
		expect(envelope.tools?.write_file?.enabled).toBe(false);
		expect(envelope.tools?.run_command).toBeUndefined();

		const validated = validateCapabilityBundle(envelope);
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
		).toBe("deny");
		expect(
			evaluateToolInvocation(
				validated.bundle,
				{ tool: "run_command", command: "git status" },
				ctx,
			).decision,
		).toBe("deny");
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

describe("buildDefaultCapabilityBundleForTask — worker binary", () => {
	it("always allows the `claude` worker binary in the run_command allowlist", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const task = {
			...plan.tasks[0],
			allowedSideEffects: ["local-doc"] as const,
			forbiddenSideEffects: [],
			verificationCommands: ["pnpm vitest run"],
		};
		const bundle = buildDefaultCapabilityBundleForTask(plan, task);
		expect(bundle.tools?.run_command?.allowlist).toContain("claude");
		// Verification-derived entries are still present.
		expect(bundle.tools?.run_command?.allowlist).toContain("pnpm");
	});

	it("includes `claude` even when the task declares zero verification commands", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const task = {
			...plan.tasks[0],
			allowedSideEffects: ["local-doc"] as const,
			forbiddenSideEffects: [],
			verificationCommands: [],
		};
		const bundle = buildDefaultCapabilityBundleForTask(plan, task);
		// run_command is now always present (never empty) because of the seed.
		expect(bundle.tools?.run_command?.allowlist).toEqual(["claude"]);
	});
});

describe("buildDefaultCapabilityBundleForTask — code-edit", () => {
	it("maps a code-edit task to the source/test globs and enables write_file", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const task = {
			...plan.tasks[0],
			id: plan.tasks[0].id,
			allowedSideEffects: ["code-edit"] as const,
			verificationCommands: ["cargo test", "pnpm vitest"],
		};
		const bundle = buildDefaultCapabilityBundleForTask(plan, task);
		expect(new Set(bundle.fsWrite)).toEqual(
			new Set([
				"src/**",
				"test/**",
				"packages/**/src/**",
				"packages/**/test/**",
				"packages/**/fixtures/**",
				"native/crates/**/src/**",
				"native/crates/**/tests/**",
			]),
		);
		expect(bundle.tools?.write_file?.enabled).toBe(true);
		expect(bundle.tools?.run_command?.allowlist).toEqual(
			expect.arrayContaining(["cargo", "pnpm"]),
		);
		expect(capabilityBundleDigest(bundle)).toBe(bundleDigest(bundle));
	});

	it("covers regenerated ledger fixtures so a code-edit worker's committed fixtures stay in diff-scope", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const task = {
			...plan.tasks[0],
			allowedSideEffects: ["code-edit"] as const,
			verificationCommands: ["pnpm ledger:gen-fixtures"],
		};
		const bundle = buildDefaultCapabilityBundleForTask(plan, task);
		// The `result_ready` derivation regenerates+commits
		// packages/ledger-client/fixtures/payload-variants.json — that path MUST be
		// inside the bundle's fsWrite (symmetric with packages/**/src/**).
		expect(bundle.fsWrite).toContain("packages/**/fixtures/**");

		const validated = validateCapabilityBundle(bundle);
		if (!validated.ok) {
			throw new Error(validated.errors.join("; "));
		}
		const ctx = { worktreeRoot: "/tmp/wt" };
		expect(
			evaluateToolInvocation(
				validated.bundle,
				{
					tool: "write_file",
					path: "packages/ledger-client/fixtures/payload-variants.json",
				},
				ctx,
			).decision,
		).toBe("allow");

		// The M4 acceptance diff-scope is derived from the same fsWrite, so a
		// committed fixtures diff is no longer rejected as out-of-scope.
		const contract = deriveAcceptanceContract(plan, task);
		expect(contract.diff_scope.allowed_globs).toContain(
			"packages/**/fixtures/**",
		);
	});
});

describe("code-edit bundle is broker-enforceable", () => {
	it("confines a code-edit worker to source/test and denies everything else", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const task = {
			...plan.tasks[0],
			allowedSideEffects: ["code-edit"] as const,
			verificationCommands: ["cargo test", "pnpm vitest"],
		};
		const validated = validateCapabilityBundle(
			buildDefaultCapabilityBundleForTask(plan, task),
		);
		if (!validated.ok) {
			throw new Error(validated.errors.join("; "));
		}
		const ctx = { worktreeRoot: "/tmp/wt" };
		expect(
			evaluateToolInvocation(
				validated.bundle,
				{ tool: "write_file", path: "src/kernel/x.ts" },
				ctx,
			).decision,
		).toBe("allow");
		expect(
			evaluateToolInvocation(
				validated.bundle,
				{ tool: "write_file", path: "packages/kernel/src/orchestrator.ts" },
				ctx,
			).decision,
		).toBe("allow");
		expect(
			evaluateToolInvocation(
				validated.bundle,
				{ tool: "write_file", path: "docs/note.md" },
				ctx,
			).decision,
		).toBe("deny");
		expect(
			evaluateToolInvocation(
				validated.bundle,
				{ tool: "write_file", path: "../escape.ts" },
				ctx,
			).decision,
		).toBe("deny");
	});
});
