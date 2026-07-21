import {
	bundleDigest,
	CAPABILITY_BUNDLE_SCHEMA_VERSION,
} from "@buildplane/capability-broker";
import { describe, expect, it } from "vitest";
import {
	carriesGovernanceFields,
	parseGovernedUnitPacket,
	parseUnitPacket,
} from "../src/packet.ts";

const basePacket = {
	unit: {
		id: "u1",
		kind: "test",
		scope: "local",
		inputRefs: [],
		expectedOutputs: [],
		verificationContract: "true",
		policyProfile: "default",
	},
	execution: { command: "true" },
	verification: { requiredOutputs: [] },
};

describe("parseUnitPacket capability_bundle", () => {
	it("parses packets without capability_bundle (backward compatible)", () => {
		const parsed = parseUnitPacket(JSON.stringify(basePacket));
		expect(parsed.capability_bundle).toBeUndefined();
	});

	it("parses validated bundle with matching digest", () => {
		const capability_bundle = {
			schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
			bundleId: "test",
			fsWrite: ["src/**"],
			tools: { run_command: { allowlist: ["npm"] } },
		};
		const packet = {
			...basePacket,
			capability_bundle,
			capability_bundle_digest: bundleDigest(capability_bundle),
		};
		const parsed = parseUnitPacket(JSON.stringify(packet));
		expect(parsed.capability_bundle?.bundleId).toBe("test");
		expect(parsed.capability_bundle_digest).toBe(
			bundleDigest(capability_bundle),
		);
	});

	it("rejects digest mismatch", () => {
		const capability_bundle = {
			schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
			bundleId: "test",
		};
		const packet = {
			...basePacket,
			capability_bundle,
			capability_bundle_digest:
				"sha256:0000000000000000000000000000000000000000000000000000000000000000",
		};
		expect(() => parseUnitPacket(JSON.stringify(packet))).toThrow(
			/does not match/,
		);
	});
});

describe("parseUnitPacket execution_role", () => {
	it("defaults legacy packets without a role to implementer", () => {
		const parsed = parseUnitPacket(JSON.stringify(basePacket));

		expect(parsed.execution_role).toBe("implementer");
	});

	it("round-trips an explicitly empty legacy provenance reference", () => {
		const parsed = parseUnitPacket(
			JSON.stringify({ ...basePacket, provenance_ref: "" }),
		);

		expect(parsed.provenance_ref).toBe("");
		expect(() => parseUnitPacket(JSON.stringify(parsed))).not.toThrow();
	});

	it("preserves a valid explicit execution role", () => {
		const parsed = parseUnitPacket(
			JSON.stringify({ ...basePacket, execution_role: "reviewer" }),
		);

		expect(parsed.execution_role).toBe("reviewer");
	});

	it("rejects an unknown execution role", () => {
		expect(() =>
			parseUnitPacket(
				JSON.stringify({ ...basePacket, execution_role: "not-a-role" }),
			),
		).toThrow(/packet\.execution_role must be one of/);
	});
});

describe("parseGovernedUnitPacket", () => {
	const governedPacket = {
		...basePacket,
		execution_role: "implementer",
		provenance_ref: "admission:packet-test",
		capability_bundle: {
			schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
			bundleId: "governed-packet-test",
			fsWrite: ["src/**"],
			tools: { run_command: { allowlist: ["node"] } },
		},
		acceptance_contract: {
			schemaVersion: 1,
			contract_version: "v0",
			diff_scope: { allowed_globs: ["src/**"] },
			checks: [{ command: "node --version" }],
		},
		trust_scope: {
			schemaVersion: 1,
			lane: "governed",
			principal: "test",
			scope: "local",
		},
	};

	function serializedGovernedPacket(
		overrides: Record<string, unknown> = {},
	): string {
		const packet = { ...governedPacket, ...overrides };
		return JSON.stringify({
			...packet,
			capability_bundle_digest: bundleDigest(packet.capability_bundle),
		});
	}

	it("requires an explicit role instead of inferring implementer", () => {
		const { execution_role: _role, ...legacyPacket } = governedPacket;

		expect(() =>
			parseGovernedUnitPacket(
				JSON.stringify({
					...legacyPacket,
					capability_bundle_digest: bundleDigest(
						legacyPacket.capability_bundle,
					),
				}),
			),
		).toThrow(/execution_role is required/);
	});

	it.each([
		["provenance_ref", ""],
		["acceptance_contract", {}],
		["trust_scope", {}],
	])("rejects missing or empty governed %s", (field, value) => {
		expect(() =>
			parseGovernedUnitPacket(serializedGovernedPacket({ [field]: value })),
		).toThrow(/governed admission/);
	});

	it("requires the capability bundle and its matching digest", () => {
		const { capability_bundle: _bundle, ...missingBundle } = governedPacket;
		expect(() =>
			parseGovernedUnitPacket(JSON.stringify(missingBundle)),
		).toThrow(/capability_bundle.*required/);

		expect(() =>
			parseGovernedUnitPacket(
				JSON.stringify({
					...governedPacket,
					capability_bundle_digest: "sha256:wrong",
				}),
			),
		).toThrow(/does not match/);
	});

	it("preserves an explicit governed role and validated fields", () => {
		const parsed = parseGovernedUnitPacket(
			serializedGovernedPacket({ execution_role: "reviewer" }),
		);

		expect(parsed.execution_role).toBe("reviewer");
		expect(parsed.provenance_ref).toBe("admission:packet-test");
		expect(parsed.acceptance_contract).toEqual(
			governedPacket.acceptance_contract,
		);
	});

	it.each([
		[
			"top-level packet field",
			{ injected: true },
			/packet contains unknown field/i,
		],
		[
			"acceptance schema version",
			{
				acceptance_contract: {
					contract_version: "v0",
					diff_scope: { allowed_globs: ["src/**"] },
					checks: [{ command: "node --version" }],
				},
			},
			/schemaVersion/i,
		],
		[
			"acceptance unknown field",
			{
				acceptance_contract: {
					...governedPacket.acceptance_contract,
					injected: true,
				},
			},
			/unknown field/i,
		],
		[
			"acceptance malformed check",
			{
				acceptance_contract: {
					...governedPacket.acceptance_contract,
					checks: [{ command: "node --version", injected: true }],
				},
			},
			/unknown field/i,
		],
		[
			"trust scope schema version",
			{
				trust_scope: {
					lane: "governed",
					principal: "test",
					scope: "local",
				},
			},
			/schemaVersion/i,
		],
		[
			"trust scope unknown field",
			{
				trust_scope: {
					...governedPacket.trust_scope,
					injected: true,
				},
			},
			/unknown field/i,
		],
		[
			"raw trust lane",
			{
				trust_scope: {
					...governedPacket.trust_scope,
					lane: "raw",
				},
			},
			/lane.*governed/i,
		],
	] as const)("rejects malformed governed %s", (_label, overrides, error) => {
		expect(() =>
			parseGovernedUnitPacket(serializedGovernedPacket(overrides)),
		).toThrow(error);
	});
});

describe("carriesGovernanceFields", () => {
	it("recognizes each governance field independently", () => {
		const rawPacket = parseUnitPacket(JSON.stringify(basePacket));
		const governedPacket = parseGovernedUnitPacket(
			JSON.stringify({
				...basePacket,
				execution_role: "implementer",
				provenance_ref: "admission:packet-test",
				capability_bundle: {
					schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
					bundleId: "governance-field-test",
				},
				capability_bundle_digest: bundleDigest({
					schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
					bundleId: "governance-field-test",
				}),
				acceptance_contract: {
					schemaVersion: 1,
					contract_version: "v0",
					diff_scope: { allowed_globs: ["src/**"] },
					checks: [{ command: "true" }],
				},
				trust_scope: {
					schemaVersion: 1,
					lane: "governed",
					principal: "test",
					scope: "local",
				},
			}),
		);

		expect(carriesGovernanceFields(rawPacket)).toBe(false);
		expect(
			carriesGovernanceFields({
				...rawPacket,
				capability_bundle: governedPacket.capability_bundle,
			}),
		).toBe(true);
		expect(
			carriesGovernanceFields({
				...rawPacket,
				capability_bundle_digest: governedPacket.capability_bundle_digest,
			}),
		).toBe(true);
		expect(
			carriesGovernanceFields({
				...rawPacket,
				acceptance_contract: governedPacket.acceptance_contract,
			}),
		).toBe(true);
		expect(
			carriesGovernanceFields({
				...rawPacket,
				trust_scope: governedPacket.trust_scope,
			}),
		).toBe(true);
		expect(
			carriesGovernanceFields({
				...rawPacket,
				provenance_ref: governedPacket.provenance_ref,
			}),
		).toBe(true);
	});
});
