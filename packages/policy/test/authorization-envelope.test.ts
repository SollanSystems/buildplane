import type {
	AuthorizationEnvelopeV0,
	EnvelopeProposal,
} from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import {
	authorizationEnvelopeDigest,
	canonicalEnvelopeJson,
	envelopeAdmissionDecision,
	evaluateEnvelopeAdmission,
} from "../src/authorization-envelope.js";

const envelope: AuthorizationEnvelopeV0 = {
	envelope_version: "v0",
	milestone: "M5",
	allowed_side_effects: ["code-edit"],
	path_globs: ["src/**", "packages/**/src/**", "test/**"],
	max_iterations: 8,
	token_budget: 4_000_000,
	allowed_verification_cmds: ["pnpm", "cargo", "tsc"],
	expires_at: "2026-07-01T00:00:00Z",
};
const now = new Date("2026-06-22T00:00:00Z");

function proposal(over: Partial<EnvelopeProposal> = {}): EnvelopeProposal {
	return {
		milestone: "M5",
		sideEffects: ["code-edit"],
		pathGlobs: ["src/**"],
		verificationCommands: ["pnpm vitest run", "tsc --noEmit"],
		...over,
	};
}

describe("evaluateEnvelopeAdmission", () => {
	it("admits a subset proposal", () => {
		const e = evaluateEnvelopeAdmission(proposal(), envelope, now);
		expect(e.status).toBe("admitted");
		expect(envelopeAdmissionDecision(e)).toBeUndefined();
	});
	it("pauses on an out-of-envelope side effect", () => {
		const e = evaluateEnvelopeAdmission(
			proposal({ sideEffects: ["code-edit", "merge"] }),
			envelope,
			now,
		);
		expect(e.status).toBe("paused");
		expect(e.outOfEnvelopeSideEffects).toEqual(["merge"]);
		expect(envelopeAdmissionDecision(e)?.kind).toBe("authorization.envelope");
	});
	it("pauses on a path glob not covered by any envelope glob", () => {
		const e = evaluateEnvelopeAdmission(
			proposal({ pathGlobs: ["native/**"] }),
			envelope,
			now,
		);
		expect(e.status).toBe("paused");
		expect(e.outOfEnvelopePathGlobs).toEqual(["native/**"]);
	});
	it("admits a narrower path glob that is a subset of an envelope glob", () => {
		const e = evaluateEnvelopeAdmission(
			proposal({ pathGlobs: ["src/kernel/**"] }),
			envelope,
			now,
		);
		expect(e.status).toBe("admitted");
	});
	it("fails closed on a traversal/absolute proposal path glob", () => {
		const e = evaluateEnvelopeAdmission(
			proposal({ pathGlobs: ["../etc/**"] }),
			envelope,
			now,
		);
		expect(e.status).toBe("paused");
		expect(e.outOfEnvelopePathGlobs).toEqual(["../etc/**"]);
	});
	it("admits a concrete proposal under a middle-wildcard envelope glob", () => {
		const e = evaluateEnvelopeAdmission(
			proposal({ pathGlobs: ["packages/kernel/src/**"] }),
			envelope,
			now,
		);
		expect(e.status).toBe("admitted");
	});
	it("admits a literal file path under a middle-wildcard envelope glob", () => {
		const e = evaluateEnvelopeAdmission(
			proposal({ pathGlobs: ["packages/policy/src/segment-glob.ts"] }),
			envelope,
			now,
		);
		expect(e.status).toBe("admitted");
	});
	it("admits a narrower double-wildcard proposal under a middle-wildcard envelope glob", () => {
		const e = evaluateEnvelopeAdmission(
			proposal({ pathGlobs: ["packages/**/src/lib/**"] }),
			envelope,
			now,
		);
		expect(e.status).toBe("admitted");
	});
	it("pauses on a sibling subtree that escapes the middle-wildcard suffix", () => {
		const e = evaluateEnvelopeAdmission(
			proposal({ pathGlobs: ["packages/kernel/dist/**"] }),
			envelope,
			now,
		);
		expect(e.status).toBe("paused");
		expect(e.outOfEnvelopePathGlobs).toEqual(["packages/kernel/dist/**"]);
	});
	it("pauses on a proposal wildcard broader than every envelope glob", () => {
		const e = evaluateEnvelopeAdmission(
			proposal({ pathGlobs: ["packages/**"] }),
			envelope,
			now,
		);
		expect(e.status).toBe("paused");
		expect(e.outOfEnvelopePathGlobs).toEqual(["packages/**"]);
	});
	it("pauses on a verification command argv0 outside the allowlist", () => {
		const e = evaluateEnvelopeAdmission(
			proposal({ verificationCommands: ["curl http://x"] }),
			envelope,
			now,
		);
		expect(e.status).toBe("paused");
		expect(e.outOfEnvelopeVerificationCmds).toEqual(["curl"]);
	});
	it("pauses on a milestone mismatch", () => {
		const e = evaluateEnvelopeAdmission(
			proposal({ milestone: "M6" }),
			envelope,
			now,
		);
		expect(e.status).toBe("paused");
		expect(e.milestoneMatches).toBe(false);
	});
	it("pauses when the envelope has expired", () => {
		const e = evaluateEnvelopeAdmission(
			proposal(),
			envelope,
			new Date("2026-07-02T00:00:00Z"),
		);
		expect(e.status).toBe("paused");
		expect(e.expired).toBe(true);
	});
});

describe("authorizationEnvelopeDigest", () => {
	it("is stable and content-addressed", () => {
		const a = authorizationEnvelopeDigest(envelope);
		const reordered: AuthorizationEnvelopeV0 = {
			expires_at: envelope.expires_at,
			token_budget: envelope.token_budget,
			max_iterations: envelope.max_iterations,
			allowed_verification_cmds: envelope.allowed_verification_cmds,
			path_globs: envelope.path_globs,
			allowed_side_effects: envelope.allowed_side_effects,
			milestone: envelope.milestone,
			envelope_version: "v0",
		};
		expect(authorizationEnvelopeDigest(reordered)).toBe(a);
		expect(
			authorizationEnvelopeDigest({ ...envelope, milestone: "M6" }),
		).not.toBe(a);
		expect(a.startsWith("sha256:")).toBe(true);
		const json = canonicalEnvelopeJson(envelope);
		expect(json.indexOf("allowed_side_effects")).toBeLessThan(
			json.indexOf("path_globs"),
		);
	});
});
