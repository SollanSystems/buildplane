import { describe, expect, it, vi } from "vitest";
import type { TrustSpineReleaseTrustRootV1 } from "../../eval/trust-spine-release-gate-cli.js";
import { runTrustSpineReleasePreflightCli } from "../../eval/trust-spine-release-preflight-cli.js";
import type { GovernedSandboxProbeResult } from "../../packages/runtime/src/governed-sandbox.js";

const HOST = {
	realm: "protected-release",
	keyId: "host-1",
	actorId: "release-host",
	publicKeyHash: `sha256:${"a".repeat(64)}`,
	publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
} as const;

const ROOT: TrustSpineReleaseTrustRootV1 = {
	format: "buildplane.trust-spine.release-trust-root.v1",
	schemaVersion: 1,
	maxCampaignAgeHours: 24,
	trustedHosts: [HOST],
	trustedTapeSigners: [
		{
			actorId: "event-signer",
			keyId: "event-1",
			publicKeyHash: `sha256:${"b".repeat(64)}`,
			publicKeyB64: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
		},
	],
	trustedCheckpointSigners: [
		{
			actorId: "checkpoint-signer",
			keyId: "checkpoint-1",
			publicKeyHash: `sha256:${"c".repeat(64)}`,
			publicKeyB64: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
		},
	],
	releasePolicy: {
		expectedProviders: ["anthropic", "openai"],
		expectedTrustTiers: ["standard"],
		targetRef: "refs/heads/main",
		minimumTasksPerGroup: 30,
		maxCapabilityRegression: 0.05,
		baselineByGroup: {
			"anthropic/standard": { passAt1: 0.1, passAll3: 0.1 },
			"openai/standard": { passAt1: 0.1, passAll3: 0.1 },
		},
		requiredCheckNames: ["verify"],
	},
};

const FEASIBLE_OCI: GovernedSandboxProbeResult = {
	schemaVersion: 1,
	state: "feasible",
	governedWorkerExecution: "not_implemented",
	host: {
		platform: "linux",
		environment: "linux",
		isWsl: false,
	},
	runtime: {
		binary: "podman",
		version: "5.0.0",
		rootless: true,
		userNamespace: true,
		isolationFlags: true,
	},
	checks: {
		linuxHost: true,
		ociRuntime: true,
		rootless: true,
		userNamespace: true,
		isolationFlags: true,
	},
	failures: [],
};

function hostArgs(overrides: readonly string[] = []): string[] {
	return [
		"--stage",
		"host",
		"--realm",
		HOST.realm,
		"--key-id",
		HOST.keyId,
		"--actor-id",
		HOST.actorId,
		"--public-key-hash",
		HOST.publicKeyHash,
		...overrides,
	];
}

describe("Trust Spine release preflight CLI", () => {
	it("reports a public host enrollment that is ready for campaign setup without claiming key custody", () => {
		const stdout = vi.fn();
		const exitCode = runTrustSpineReleasePreflightCli(hostArgs(), {
			stdout,
			readPinnedTrustRoot: () => ROOT,
			probeOci: () => FEASIBLE_OCI,
		});

		expect(exitCode).toBe(0);
		const result = JSON.parse(stdout.mock.calls[0]?.[0] ?? "{}") as {
			ready: boolean;
			checks: Array<{ id: string; state: string }>;
			limitations: string[];
		};
		expect(result.ready).toBe(true);
		expect(result.checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "pinned_host_enrollment",
					state: "ready",
				}),
			]),
		);
		expect(result.limitations.join(" ")).toMatch(
			/does not prove private-key custody/i,
		);
	});

	it("blocks host readiness when rootless OCI cannot be proven", () => {
		const stderr = vi.fn();
		const exitCode = runTrustSpineReleasePreflightCli(hostArgs(), {
			stderr,
			readPinnedTrustRoot: () => ROOT,
			probeOci: () => ({
				...FEASIBLE_OCI,
				state: "blocked",
				runtime: undefined,
				checks: {
					...FEASIBLE_OCI.checks,
					ociRuntime: false,
					rootless: false,
					userNamespace: false,
					isolationFlags: false,
				},
				failures: [
					{
						code: "OCI_RUNTIME_UNAVAILABLE",
						stage: "runtime",
						runtime: "podman",
						message: "Podman is unavailable.",
					},
				],
			}),
		});

		expect(exitCode).toBe(1);
		expect(JSON.parse(stderr.mock.calls[0]?.[0] ?? "{}")).toMatchObject({
			checks: expect.arrayContaining([
				expect.objectContaining({
					id: "rootless_oci_feasibility",
					state: "blocked",
					message: "Podman is unavailable.",
				}),
			]),
		});
	});

	it("reports an unprovisioned root as blocked without invoking a release gate", () => {
		const stderr = vi.fn();
		const runReleaseGate = vi.fn();
		const exitCode = runTrustSpineReleasePreflightCli(hostArgs(), {
			stderr,
			readPinnedTrustRoot: () => ({
				...ROOT,
				trustedHosts: [],
				trustedTapeSigners: [],
				trustedCheckpointSigners: [],
				releasePolicy: null,
			}),
			probeOci: () => FEASIBLE_OCI,
			runReleaseGate,
		});

		expect(exitCode).toBe(1);
		expect(runReleaseGate).not.toHaveBeenCalled();
		const result = JSON.parse(stderr.mock.calls[0]?.[0] ?? "{}") as {
			checks: Array<{ state: string }>;
		};
		expect(result.checks).toHaveLength(5);
		expect(
			result.checks
				.filter((check) => check.id !== "rootless_oci_feasibility")
				.every((check) => check.state === "blocked"),
		).toBe(true);
		expect(
			result.checks.find((check) => check.id === "rootless_oci_feasibility")
				?.state,
		).toBe("ready");
	});

	it("delegates runner validation to the existing pinned-root release gate", () => {
		const stdout = vi.fn();
		const runReleaseGate = vi.fn(() => 0);
		const commit = "a".repeat(40);
		const exitCode = runTrustSpineReleasePreflightCli(
			[
				"--stage",
				"runner",
				"--bundle",
				"/mnt/release/campaign.json",
				"--commit",
				commit,
				"--ref",
				"refs/heads/main",
			],
			{ stdout, runReleaseGate },
		);

		expect(exitCode).toBe(0);
		expect(runReleaseGate).toHaveBeenCalledWith(
			[
				"--bundle",
				"/mnt/release/campaign.json",
				"--commit",
				commit,
				"--ref",
				"refs/heads/main",
			],
			expect.objectContaining({}),
		);
		expect(JSON.parse(stdout.mock.calls[0]?.[0] ?? "{}")).toMatchObject({
			stage: "runner",
			ready: true,
		});
	});

	it("accepts pnpm's optional argument delimiter", () => {
		const stdout = vi.fn();
		const exitCode = runTrustSpineReleasePreflightCli(["--", ...hostArgs()], {
			stdout,
			readPinnedTrustRoot: () => ROOT,
			probeOci: () => FEASIBLE_OCI,
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.mock.calls[0]?.[0] ?? "{}")).toMatchObject({
			stage: "host",
			ready: true,
		});
	});

	it("fails closed when the delegated runner gate rejects the bundle", () => {
		const stderr = vi.fn();
		const runReleaseGate = vi.fn((_argv, io) => {
			io.stderr?.("trust-spine-release-gate: campaign bundle is stale");
			return 1;
		});
		const exitCode = runTrustSpineReleasePreflightCli(
			[
				"--stage",
				"runner",
				"--bundle",
				"/mnt/release/campaign.json",
				"--commit",
				"a".repeat(40),
				"--ref",
				"refs/heads/main",
			],
			{ stderr, runReleaseGate },
		);

		expect(exitCode).toBe(1);
		expect(JSON.parse(stderr.mock.calls[0]?.[0] ?? "{}")).toMatchObject({
			stage: "runner",
			ready: false,
			checks: [
				{
					id: "campaign_bundle_and_evidence",
					state: "blocked",
					message: "trust-spine-release-gate: campaign bundle is stale",
				},
			],
		});
	});

	it("rejects incomplete or mixed-stage arguments", () => {
		const stderr = vi.fn();
		expect(
			runTrustSpineReleasePreflightCli(
				["--stage", "host", "--bundle", "/tmp/campaign.json"],
				{ stderr },
			),
		).toBe(2);
		expect(stderr.mock.calls[0]?.[0]).toMatch(/usage:/i);
	});
});
