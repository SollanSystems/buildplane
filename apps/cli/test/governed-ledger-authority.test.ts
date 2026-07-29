import { describe, expect, it } from "vitest";
import {
	__testOnlyResolveGovernedLedgerAuthorityRealm,
	createTrustedGovernedLedgerAuthorityRealmPort,
	GOVERNED_AUTHORITY_BROKER_REQUIRED,
	resolveTrustedGovernedLedgerAuthorityRealm,
} from "../src/governed-ledger-authority.js";

const DIGEST = (character: string) => `sha256:${character.repeat(64)}`;

function authorityProjection(): Record<string, unknown> {
	return {
		schema_version: 1,
		realm_digest: DIGEST("a"),
		ledger_workspace: process.cwd(),
		kernel_signer: {
			actor_id: "kernel",
			key_id: "kernel-main",
			public_key_hash: DIGEST("b"),
		},
	};
}

describe("governed ledger authority", () => {
	it("limits fake authority output to the explicitly named test-only seam", () => {
		let observedBinary: string | undefined;
		let observedArgs: readonly string[] | undefined;
		const realm = __testOnlyResolveGovernedLedgerAuthorityRealm({
			binary: "buildplane-native-fixture",
			runner(binary, args) {
				observedBinary = binary;
				observedArgs = args;
				return {
					status: 0,
					stdout: JSON.stringify(authorityProjection()),
					stderr: "",
				};
			},
		});

		expect(observedBinary).toBe("buildplane-native-fixture");
		expect(observedArgs).toEqual(["ledger", "governed-authority-v1"]);
		expect(realm).toMatchObject({
			kind: "host-governed-ledger-authority-v1",
			realmDigest: DIGEST("a"),
			ledgerWorkspace: process.cwd(),
			kernelActorId: "kernel",
			kernelKeyId: "kernel-main",
			kernelPublicKeyHash: DIGEST("b"),
		});
	});

	it("rejects fake binary, runner, and realm fields before production authority resolution", () => {
		for (const [field, value] of [
			["binary", "attacker-controlled-native"],
			["runner", () => ({ status: 0, stdout: "{}", stderr: "" })],
			[
				"realm",
				{
					kind: "host-governed-ledger-authority-v1",
					realmDigest: DIGEST("c"),
				},
			],
		] as const) {
			const options = {
				[field]: value,
			} as unknown as Parameters<
				typeof resolveTrustedGovernedLedgerAuthorityRealm
			>[0];
			expect(() => resolveTrustedGovernedLedgerAuthorityRealm(options)).toThrow(
				new RegExp(`unsupported field ${field}`, "i"),
			);
		}

		const fabricatedRealmPortOptions = {
			realm: {
				kind: "host-governed-ledger-authority-v1",
				realmDigest: DIGEST("c"),
			},
		} as unknown as Parameters<
			typeof createTrustedGovernedLedgerAuthorityRealmPort
		>[0];
		expect(() =>
			createTrustedGovernedLedgerAuthorityRealmPort(fabricatedRealmPortOptions),
		).toThrow(/unsupported field realm/i);
	});

	it("does not allow the test-only seam to accept production binary authority", () => {
		const options = {
			binary: "buildplane-native-fixture",
			runner: () => ({ status: 0, stdout: "{}", stderr: "" }),
			trustedBinary: {
				kind: "packaged-native-v1",
				path: "attacker-controlled-native",
				digest: DIGEST("d"),
			},
		} as unknown as Parameters<
			typeof __testOnlyResolveGovernedLedgerAuthorityRealm
		>[0];

		expect(() =>
			__testOnlyResolveGovernedLedgerAuthorityRealm(options),
		).toThrow(/unsupported field trustedBinary/i);
	});

	it("never falls back to a caller-UID native authority subprocess", () => {
		const suppliedBinary = {
			kind: "packaged-native-v1" as const,
			path: "not-a-broker-and-must-not-be-spawned",
			digest: DIGEST("e"),
		};

		expect(() =>
			resolveTrustedGovernedLedgerAuthorityRealm({
				trustedBinary: suppliedBinary,
			}),
		).toThrow(GOVERNED_AUTHORITY_BROKER_REQUIRED);
	});
});
