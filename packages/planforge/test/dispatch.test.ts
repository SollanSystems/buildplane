import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleDigest } from "@buildplane/capability-broker";
import { describe, expect, it } from "vitest";
import { dispatchAdmittedPlan } from "../src/dispatch.ts";
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
});
