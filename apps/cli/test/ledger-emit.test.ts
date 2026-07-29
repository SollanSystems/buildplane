import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildLedgerServeArgs,
	spawnLedgerSubprocess,
	spawnTrustedGovernedLedgerSubprocess,
	verifyGovernedNativeBinaryIntegrity,
} from "../src/ledger-emit.js";

describe("buildLedgerServeArgs", () => {
	it("keeps unsigned legacy ingest free of activity-claim authority", () => {
		expect(buildLedgerServeArgs("run-1", "C:/workspace")).toEqual([
			"ledger",
			"serve",
			"--run-id",
			"run-1",
			"--workspace",
			"C:/workspace",
			"--schema-version",
			"1",
		]);
	});

	it("enables claims only with an explicit signed authority configuration", () => {
		expect(
			buildLedgerServeArgs("run-1", "C:/workspace", {
				sign: true,
				signingActorId: "kernel",
				signingKeyId: "kernel-main",
				activityClaimAuthority: {
					dispatchActorId: "kernel",
					dispatchKeyId: "kernel-main",
					actionRequestActorId: "kernel",
					actionRequestKeyId: "kernel-main",
				},
			}),
		).toEqual(
			expect.arrayContaining([
				"--sign",
				"--signing-actor-id",
				"kernel",
				"--signing-key-id",
				"kernel-main",
				"--enable-activity-claims",
				"--activity-claim-dispatch-actor-id",
				"--activity-claim-dispatch-key-id",
				"--activity-claim-action-request-actor-id",
				"--activity-claim-action-request-key-id",
			]),
		);
	});

	it("fails closed for unsigned or incomplete activity authority", () => {
		const authority = {
			dispatchActorId: "kernel",
			dispatchKeyId: "kernel-main",
			actionRequestActorId: "kernel",
			actionRequestKeyId: "kernel-main",
		};
		expect(() =>
			buildLedgerServeArgs("run-1", "C:/workspace", {
				activityClaimAuthority: authority,
			}),
		).toThrow(/requires a signed ledger subprocess/i);
		expect(() =>
			buildLedgerServeArgs("run-1", "C:/workspace", {
				sign: true,
				activityClaimAuthority: { ...authority, dispatchKeyId: " " },
			}),
		).toThrow(/dispatchKeyId/i);
	});

	it("requires a package-pinned integrity match before a native artifact can be used as governed authority", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-native-"));
		try {
			const binary = join(root, "buildplane-native");
			const integrity = join(root, "buildplane-native.sha256");
			writeFileSync(binary, "trusted native fixture", { mode: 0o755 });
			const digest = `sha256:${createHash("sha256")
				.update("trusted native fixture")
				.digest("hex")}`;
			writeFileSync(integrity, `${digest}\n`);
			expect(
				verifyGovernedNativeBinaryIntegrity(binary, integrity),
			).toMatchObject({
				kind: "packaged-native-v1",
				path: binary,
				digest,
			});

			writeFileSync(binary, "tampered native fixture", { mode: 0o755 });
			expect(() =>
				verifyGovernedNativeBinaryIntegrity(binary, integrity),
			).toThrow(/digest does not match/i);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not let the generic ledger launcher enable native activity claims", () => {
		expect(() =>
			spawnLedgerSubprocess("buildplane-native", "run-1", "C:/workspace", {
				sign: true,
				activityClaimAuthority: {
					dispatchActorId: "kernel",
					dispatchKeyId: "kernel-main",
					actionRequestActorId: "kernel",
					actionRequestKeyId: "kernel-main",
				},
			}),
		).toThrow(/generic ledger subprocess never admits governed claims/i);
	});

	it("blocks the retired governed generic-ingest launcher before spawning a child", () => {
		expect(() =>
			spawnTrustedGovernedLedgerSubprocess({} as never, "run-governed-blocked"),
		).toThrow(/GOVERNED_AUTHORITY_ENDPOINT_UNAVAILABLE/i);
	});
});
