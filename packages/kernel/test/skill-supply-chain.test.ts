import { describe, expect, it } from "vitest";
import {
	createSkillManifestV1,
	evaluateSkillActivationEligibility,
	parseSkillManifestV1,
} from "../src/skill-supply-chain.js";

const DIGEST = (char: string) => `sha256:${char.repeat(64)}`;

function manifest() {
	return createSkillManifestV1({
		skillId: "secure-review",
		publisherId: "buildplane.publisher",
		contentDigest: DIGEST("a"),
		signatureDigest: DIGEST("b"),
		declaredCapabilities: ["fs.read:repository"],
		compatibility: {
			repositoryVersions: ["buildplane-1"],
			toolVersions: ["gateway-1"],
			modelVersions: ["openai-gpt-5"],
		},
		deterministicTestDigest: DIGEST("c"),
		utilityReportDigest: DIGEST("d"),
	});
}

function eligibilityInput(overrides: Record<string, unknown> = {}) {
	return {
		manifest: manifest(),
		scan: {
			scannerId: "skill-scanner-1",
			scanDigest: DIGEST("e"),
			outcome: "clean" as const,
		},
		revokedManifestDigests: [],
		repositoryVersion: "buildplane-1",
		toolVersion: "gateway-1",
		modelVersion: "openai-gpt-5",
		...overrides,
	};
}

describe("skill supply-chain quarantine", () => {
	it("records signed, compatible, tested skills as immutable quarantine metadata", () => {
		const skill = manifest();
		expect(skill).toMatchObject({
			schemaVersion: 1,
			status: "quarantined",
			publisherId: "buildplane.publisher",
			declaredCapabilities: ["fs.read:repository"],
		});
		expect(Object.isFrozen(skill)).toBe(true);
		expect(parseSkillManifestV1(JSON.parse(JSON.stringify(skill)))).toEqual(
			skill,
		);
	});

	it("does not derive authority from a clean self-declared skill manifest", () => {
		expect(evaluateSkillActivationEligibility(eligibilityInput())).toEqual({
			eligible: false,
			reason: "verified-tape-projection-required",
			authority: "none",
			activation: "shadow-only",
		});
	});

	it("blocks revocation, scans, and every compatibility mismatch before activation", () => {
		const skill = manifest();
		expect(
			evaluateSkillActivationEligibility(
				eligibilityInput({ revokedManifestDigests: [skill.digest] }),
			),
		).toMatchObject({ reason: "revoked", authority: "none" });
		expect(
			evaluateSkillActivationEligibility(
				eligibilityInput({
					scan: {
						scannerId: "skill-scanner-1",
						scanDigest: DIGEST("e"),
						outcome: "malicious",
					},
				}),
			),
		).toMatchObject({ reason: "scan-not-clean", authority: "none" });
		expect(
			evaluateSkillActivationEligibility(
				eligibilityInput({ repositoryVersion: "other-repository" }),
			),
		).toMatchObject({ reason: "repository-incompatible" });
		expect(
			evaluateSkillActivationEligibility(
				eligibilityInput({ toolVersion: "other-tool" }),
			),
		).toMatchObject({ reason: "tool-incompatible" });
		expect(
			evaluateSkillActivationEligibility(
				eligibilityInput({ modelVersion: "other-model" }),
			),
		).toMatchObject({ reason: "model-incompatible" });
	});

	it("rejects forged, drifted, duplicate, and unknown manifest fields", () => {
		const skill = manifest();
		expect(() =>
			parseSkillManifestV1({ ...skill, capabilityToken: "remote-controlled" }),
		).toThrow(/closed V1 schema/i);
		expect(() =>
			parseSkillManifestV1({ ...skill, publisherId: "substituted.publisher" }),
		).toThrow(/digest mismatch/i);
		const {
			schemaVersion: _schemaVersion,
			status: _status,
			digest: _digest,
			...input
		} = skill;
		expect(() =>
			createSkillManifestV1({
				...input,
				declaredCapabilities: ["fs.read:repository", "fs.read:repository"],
			}),
		).toThrow(/non-empty and unique/i);
		const accessorCapabilities = ["fs.read:repository"];
		Object.defineProperty(accessorCapabilities, "0", {
			get: () => "fs.read:repository",
			enumerable: true,
		});
		expect(() =>
			createSkillManifestV1({
				...input,
				declaredCapabilities: accessorCapabilities,
			}),
		).toThrow(/dense array/i);
	});
});
