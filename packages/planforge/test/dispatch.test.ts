import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleDigest } from "@buildplane/capability-broker";
import { describe, expect, it } from "vitest";
import {
	DISPATCH_WORKER_MODEL,
	dispatchAdmittedPlan,
} from "../src/dispatch.ts";
import { createPlanForgeDryRunPlan } from "../src/index.ts";

const inputFixture = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../apps/cli/test/fixtures/planforge/goal-input.md",
);

describe("dispatchAdmittedPlan", () => {
	it("builds one packet per task, each stamped with the admitted event id", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const packets = dispatchAdmittedPlan({
			plan,
			admittedEventId: "evt-42",
			policyProfile: "default",
		});
		expect(packets).toHaveLength(plan.tasks.length);
		for (const p of packets) {
			expect(p.provenance_ref).toBe("evt-42");
			expect(p.unit.policyProfile).toBe("default");
			expect(p.capability_bundle.bundleId).toContain(plan.id);
			expect(p.capability_bundle_digest).toBe(
				bundleDigest(p.capability_bundle),
			);
		}
		expect(packets[0].unit.id).toContain(plan.tasks[0].id);
	});

	it("emits a claude-code model packet with no execution field (real worker, not the `true` placeholder)", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const packets = dispatchAdmittedPlan({
			plan,
			admittedEventId: "evt-42",
			policyProfile: "default",
		});
		expect(packets.length).toBeGreaterThan(0);
		for (const p of packets) {
			// The router short-circuits any packet with `execution` to the command
			// executor BEFORE checking preferredWorker (run-cli.ts:1436), so it MUST be absent.
			expect((p as Record<string, unknown>).execution).toBeUndefined();
			expect(p.model.provider).toBe("anthropic");
			expect(p.model.model).toBe("claude-sonnet-5");
			expect(p.model.prompt.length).toBeGreaterThan(0);
			expect(p.routingHints.preferredWorker).toBe("claude-code");
		}
	});

	it("populates intent from the task and keeps prompt load-bearing (no renderer wired)", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const packets = dispatchAdmittedPlan({
			plan,
			admittedEventId: "evt-42",
			policyProfile: "default",
		});
		const [first] = packets;
		const task = plan.tasks[0];
		expect(first.intent.taskType).toBe("implement");
		expect(first.intent.objective).toBe(task.objective);
		expect(first.intent.constraints.scope).toContain(task.workspace);
		expect(first.intent.constraints.verification).toEqual(
			task.verificationCommands,
		);
		expect(first.intent.features.verifierStrength).toBe("strong");
		// prompt must reflect the objective — it, not intent, drives `claude -p` today.
		expect(first.model.prompt).toContain(task.objective);
	});

	it("stamps an explicit model override onto every packet when provided", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const packets = dispatchAdmittedPlan({
			plan,
			admittedEventId: "evt-42",
			policyProfile: "default",
			model: "claude-opus-4-8",
		});
		expect(packets.length).toBeGreaterThan(0);
		for (const p of packets) {
			expect(p.model.model).toBe("claude-opus-4-8");
		}
	});

	it("falls back to DISPATCH_WORKER_MODEL when no model override is given", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const packets = dispatchAdmittedPlan({
			plan,
			admittedEventId: "evt-42",
			policyProfile: "default",
		});
		expect(packets.length).toBeGreaterThan(0);
		for (const p of packets) {
			expect(p.model.model).toBe(DISPATCH_WORKER_MODEL);
		}
	});
});
