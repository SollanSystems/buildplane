import { describe, expect, it } from "vitest";
import {
	createMemoryClaimLinkV1,
	createMemoryClaimV1,
	createMemoryEvidenceV1,
	evaluateMemoryRoutingEligibility,
	type MemoryClaimV1,
	parseMemoryClaimV1,
	parseMemoryEvidenceV1,
} from "../src/provenance-memory.js";

const DIGEST =
	"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function observation(id: string, sourceRef = `cas:${id}`) {
	return createMemoryEvidenceV1({
		id,
		kind: "observation",
		trust: "governed",
		sourceRef,
		contentDigest: DIGEST,
		capturedAt: "2026-07-19T00:00:00.000Z",
	});
}

function verification(id: string, sourceRef = `verification:${id}`) {
	return createMemoryEvidenceV1({
		id,
		kind: "verification",
		trust: "governed",
		sourceRef,
		contentDigest: DIGEST,
		capturedAt: "2026-07-19T00:01:00.000Z",
	});
}

function eligibleClaim(
	o: ReturnType<typeof observation>,
	v: ReturnType<typeof verification>,
): MemoryClaimV1 {
	return createMemoryClaimV1({
		id: "claim-1",
		kind: "fact",
		status: "verified",
		statement: "The candidate passed its deterministic acceptance contract.",
		evidenceRefs: [o.digest],
		verificationRefs: [v.digest],
		promotedOutcomeRef: "promotion:result-1",
	});
}

describe("provenance-grounded memory", () => {
	it("keeps self-consistent caller-supplied governed evidence shadow-only", () => {
		const observed = observation("observation-1");
		const verified = verification("verification-1");
		const claim = eligibleClaim(observed, verified);
		const forgedCallerSuppliedInputs = JSON.parse(
			JSON.stringify({
				claim,
				evidence: [observed, verified],
				links: [],
			}),
		) as {
			claim: MemoryClaimV1;
			evidence: ReturnType<typeof observation>[];
			links: [];
		};

		expect(
			evaluateMemoryRoutingEligibility(forgedCallerSuppliedInputs),
		).toEqual({
			eligible: false,
			reason: "verified-tape-projection-required",
		});
	});

	it("does not route a worker claim that has no independent verifier", () => {
		const observed = observation("observation-1");
		const claim = createMemoryClaimV1({
			id: "claim-1",
			kind: "fact",
			status: "verified",
			statement: "The worker says it succeeded.",
			evidenceRefs: [observed.digest],
			verificationRefs: [],
			promotedOutcomeRef: "promotion:result-1",
		});

		expect(
			evaluateMemoryRoutingEligibility({
				claim,
				evidence: [observed],
				links: [],
			}),
		).toEqual({
			eligible: false,
			reason: "missing-independent-verification",
		});
	});

	it("keeps tainted external content quarantined even when it is cited", () => {
		const external = createMemoryEvidenceV1({
			id: "external-1",
			kind: "external-content",
			trust: "external-tainted",
			sourceRef: "mcp:untrusted-tool-result",
			contentDigest: DIGEST,
			capturedAt: "2026-07-19T00:00:00.000Z",
		});
		const verified = verification("verification-1");
		const claim = eligibleClaim(external, verified);

		expect(
			evaluateMemoryRoutingEligibility({
				claim,
				evidence: [external, verified],
				links: [],
			}),
		).toEqual({
			eligible: false,
			reason: "tainted-evidence",
		});
	});

	it("blocks routing for contradicted, superseded, or revoked claims", () => {
		const observed = observation("observation-1");
		const verified = verification("verification-1");
		const claim = eligibleClaim(observed, verified);

		expect(
			evaluateMemoryRoutingEligibility({
				claim,
				evidence: [observed, verified],
				links: [
					createMemoryClaimLinkV1({
						fromClaimDigest: DIGEST,
						toClaimDigest: claim.digest,
						relation: "supersedes",
						createdAt: "2026-07-19T00:02:00.000Z",
					}),
				],
			}),
		).toEqual({ eligible: false, reason: "superseded" });

		const revoked = createMemoryClaimV1({
			id: claim.id,
			kind: claim.kind,
			status: "revoked",
			statement: claim.statement,
			evidenceRefs: claim.evidenceRefs,
			verificationRefs: claim.verificationRefs,
			promotedOutcomeRef: claim.promotedOutcomeRef,
		});
		expect(
			evaluateMemoryRoutingEligibility({
				claim: revoked,
				evidence: [observed, verified],
				links: [],
			}),
		).toEqual({ eligible: false, reason: "claim-not-verified" });
	});

	it("uses closed, digest-checked records and rejects unknown fields", () => {
		const evidence = observation("observation-1");
		const parsed = parseMemoryEvidenceV1(JSON.parse(JSON.stringify(evidence)));
		expect(parsed).toEqual(evidence);

		expect(() =>
			parseMemoryEvidenceV1({ ...evidence, ambientAuthority: true }),
		).toThrow(/closed V1 schema/i);
		expect(() =>
			parseMemoryClaimV1({
				id: "claim-1",
				schemaVersion: 1,
				kind: "fact",
				status: "verified",
				statement: "forged",
				evidenceRefs: [],
				verificationRefs: [],
				promotedOutcomeRef: "promotion:result-1",
				digest: DIGEST,
			}),
		).toThrow(/digest mismatch/i);

		const claim = eligibleClaim(
			observation("observation-2"),
			verification("verification-2"),
		);
		const {
			schemaVersion: _schemaVersion,
			digest: _digest,
			...claimInput
		} = claim;
		const accessorEvidenceRefs = [claim.evidenceRefs[0]];
		Object.defineProperty(accessorEvidenceRefs, "0", {
			get: () => claim.evidenceRefs[0],
			enumerable: true,
		});
		expect(() =>
			createMemoryClaimV1({
				...claimInput,
				evidenceRefs: accessorEvidenceRefs,
			}),
		).toThrow(/dense array/i);

		const outOfRangeEvidenceRefs = [claim.evidenceRefs[0]];
		Object.defineProperty(outOfRangeEvidenceRefs, "4294967295", {
			value: claim.evidenceRefs[0],
			enumerable: true,
		});
		expect(() =>
			createMemoryClaimV1({
				...claimInput,
				evidenceRefs: outOfRangeEvidenceRefs,
			}),
		).toThrow(/dense array/i);
	});
});
