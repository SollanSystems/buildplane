import { bundleDigest } from "@buildplane/capability-broker";
import { expect, test } from "vitest";
import {
	canonicalGovernedAcceptanceContractV1Digest,
	type GovernedUnitPacketV1,
	parseGovernedUnitPacket,
} from "../src/packet.ts";
import { canonicalGovernedUnitPacketV1Digest } from "../src/trust-spine.ts";

const bundle = {
	schemaVersion: "buildplane.capability_bundle.v0" as const,
	bundleId: "bundle-1",
	fsRead: ["**/*"],
	fsWrite: ["**/*"],
	netEgress: [],
	tools: { run_command: { allowlist: ["/usr/bin/git"] } },
};

const packet = {
	unit: {
		id: "unit-1",
		kind: "implementation",
		scope: "task",
		verificationContract: "tests pass",
		policyProfile: "default",
	},
	execution_role: "implementer",
	execution: {
		command: "/usr/bin/git",
		args: ["status", "--short"],
		cwd: "repo",
	},
	intent: {
		objective: "Inspect the candidate",
		taskType: "implement",
		features: {
			ambiguity: "low",
			reversibility: "easy",
			verifierStrength: "strong",
			changeSurface: 3,
		},
	},
	provenance_ref: "01900000-0000-7000-8000-000000000001",
	capability_bundle: bundle,
	capability_bundle_digest: bundleDigest(bundle),
	acceptance_contract: {
		schemaVersion: 1,
		contract_version: "v0",
		diff_scope: { allowed_globs: ["**/*"] },
		checks: [{ command: "git status --short" }],
	},
	trust_scope: {
		schemaVersion: 1,
		lane: "governed",
		principal: "operator",
		scope: "repository",
	},
} satisfies GovernedUnitPacketV1;

const parsed = parseGovernedUnitPacket(JSON.stringify(packet));

test("matches the native governed command packet fixture", () => {
	expect({
		bundleDigest: parsed.capability_bundle_digest,
		acceptanceDigest: canonicalGovernedAcceptanceContractV1Digest(
			parsed.acceptance_contract,
		),
		packetDigest: canonicalGovernedUnitPacketV1Digest(parsed),
	}).toEqual({
		acceptanceDigest:
			"sha256:b05a1e96b6f3a5e6f415d435de0c46872a8b69ca89de30b5fc9cb7f485e301b4",
		bundleDigest:
			"sha256:f9735004122fe5a668ec78fc26b3335ed0654d2dd1c16967bcd1d258b88dfeaa",
		packetDigest:
			"sha256:6d36115fece78efd5f4d17c9cffe6cabe78725a46b374c4b3bad0f9ce45d556c",
	});
});
