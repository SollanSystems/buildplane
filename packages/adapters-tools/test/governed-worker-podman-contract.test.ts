import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleDigest } from "@buildplane/capability-broker";
import {
	canonicalActionReceiptRecordedV2Digest,
	canonicalActionRequestedV2Digest,
	canonicalGovernedUnitPacketV1Digest,
	type GovernedActionEvidencePort,
	type GovernedActivityClaimPort,
	type GovernedDispatchLineageV3,
	type UnitPacket,
} from "@buildplane/kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
	createGovernedCommandWorkerExecutionPort,
	type GovernedCommandEvidenceStore,
} from "../src/governed-worker.js";
import {
	createPodmanGovernedActionExecutorForTest,
	type PodmanCommandResult,
	type PodmanCommandRunner,
	type PodmanGovernedSandboxProfileV1,
	podmanGovernedSandboxProfileDigest,
} from "../src/podman-governed-executor.js";

const RUN_ID = "run-governed-worker-podman-contract";
const IMAGE = `registry.example.test/buildplane/worker@sha256:${"a".repeat(64)}`;
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;
const DIGEST_D = `sha256:${"d".repeat(64)}`;
const DIGEST_E = `sha256:${"e".repeat(64)}`;
const DIGEST_F = `sha256:${"f".repeat(64)}`;
const ISSUED_AT = "2026-07-18T00:00:00.000Z";
const ISSUED_AT_MS = Date.parse(ISSUED_AT);
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function makeProjectRoot(): string {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "buildplane-governed-worker-podman-")),
	);
	mkdirSync(join(root, "src"));
	mkdirSync(join(root, "generated"));
	roots.push(root);
	return root;
}

function profile(): PodmanGovernedSandboxProfileV1 {
	const unsigned = {
		schemaVersion: 1 as const,
		profileId: "podman-rootless-v1" as const,
		cpuCores: 1,
		memoryBytes: 256 * 1024 * 1024,
		pidsLimit: 64,
		tmpfsBytes: 32 * 1024 * 1024,
	};
	return {
		...unsigned,
		profileDigest: podmanGovernedSandboxProfileDigest({
			image: IMAGE,
			...unsigned,
		}),
	};
}

function packet(): UnitPacket {
	const capabilityBundle = {
		schemaVersion: "buildplane.capability_bundle.v0" as const,
		bundleId: "governed-worker-podman-contract",
		fsRead: ["src/**"],
		fsWrite: ["generated/**"],
		tools: {
			run_command: { allowlist: ["git"] },
		},
	};
	return {
		unit: {
			id: "governed-worker-podman-contract",
			kind: "command",
			scope: "src",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "exit-0",
			policyProfile: "governed",
		},
		execution_role: "implementer",
		execution: { command: "git", args: ["status"], cwd: "src" },
		verification: { requiredOutputs: [] },
		provenance_ref: "event://admission/governed-worker-podman-contract",
		acceptance_contract: { schemaVersion: 1, check: "exit-0" },
		trust_scope: { schemaVersion: 1, lane: "governed" },
		capability_bundle: capabilityBundle,
		capability_bundle_digest: bundleDigest(capabilityBundle),
	};
}

function dispatch(
	inputPacket: UnitPacket,
	sandboxProfile: PodmanGovernedSandboxProfileV1,
): GovernedDispatchLineageV3 {
	return {
		schemaVersion: 3,
		runId: RUN_ID,
		workflowId: "workflow-governed-worker-podman-contract",
		workflowRevision: "1",
		unitId: inputPacket.unit.id,
		attempt: 1,
		provenanceRef: inputPacket.provenance_ref,
		dispatchEnvelopeRef: "event://dispatch/governed-worker-podman-contract",
		envelopeDigest: DIGEST_A,
		baseCommitSha: "1".repeat(40),
		repositoryBindingDigest: DIGEST_B,
		ledgerAuthorityRealmDigest: DIGEST_C,
		governedPacketDigest: canonicalGovernedUnitPacketV1Digest(inputPacket),
		executionRole: "implementer",
		commitMode: "atomic",
		trustTier: "governed",
		capabilityBundleDigest: inputPacket.capability_bundle_digest ?? "",
		acceptanceContractDigest: DIGEST_B,
		policyDigest: DIGEST_C,
		contextManifestDigest: DIGEST_D,
		workerManifestDigest: DIGEST_E,
		sandboxProfileDigest: sandboxProfile.profileDigest,
		budget: { maxComputeTimeMs: 30_000 },
		idempotencyKey: "dispatch:governed-worker-podman-contract",
		authorityActor: "kernel:test",
		actionEvidenceVersion: "sealed_v3",
		issuedAt: ISSUED_AT,
		expiresAt: "2026-07-18T00:15:00.000Z",
	};
}

function rootlessPrerequisiteResult(
	args: readonly string[],
): PodmanCommandResult | undefined {
	if (args.length === 1 && args[0] === "--version") {
		return { status: 0, stdout: "podman version 5.0.0", stderr: "" };
	}
	if (
		args.length === 3 &&
		args[0] === "info" &&
		args[1] === "--format" &&
		args[2] === "json"
	) {
		return {
			status: 0,
			stdout: JSON.stringify({ host: { security: { rootless: true } } }),
			stderr: "",
		};
	}
	if (args.length === 2 && args[0] === "unshare" && args[1] === "true") {
		return { status: 0, stdout: "", stderr: "" };
	}
	if (args.length === 2 && args[0] === "run" && args[1] === "--help") {
		return {
			status: 0,
			stdout:
				"--read-only --network --http-proxy --no-hosts --no-hostname --cap-drop --security-opt --userns --entrypoint",
			stderr: "",
		};
	}
	return undefined;
}

function expectHardenedPodmanActionArgv(
	args: readonly string[],
	projectRoot: string,
): void {
	const imageIndexes = args
		.map((argument, index) => (argument === IMAGE ? index : -1))
		.filter((index) => index >= 0);
	expect(imageIndexes).toHaveLength(1);
	const imageIndex = imageIndexes[0];
	expect(imageIndex).toBeGreaterThan(0);
	expect(args.slice(imageIndex + 1)).toEqual(["git", "status"]);

	const staticPrefix = [
		"run",
		"--rm",
		"--pull=never",
		"--read-only",
		"--network=none",
		"--http-proxy=false",
		"--no-hosts",
		"--no-hostname",
		"--cap-drop=ALL",
		"--security-opt=no-new-privileges",
		"--userns=keep-id",
		"--entrypoint=",
		"--cpus=1",
		`--memory=${256 * 1024 * 1024}b`,
		"--pids-limit=64",
		`--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=${32 * 1024 * 1024}`,
		"--env=HOME=/tmp",
		"--env=TMPDIR=/tmp",
		"--env=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"--env=LANG=C.UTF-8",
		"--env=LC_ALL=C.UTF-8",
	] as const;
	const preImage = args.slice(0, imageIndex);
	expect(preImage.slice(0, staticPrefix.length)).toEqual(staticPrefix);
	const dynamicMountsAndWorkdir = preImage.slice(staticPrefix.length);
	expect(dynamicMountsAndWorkdir).toHaveLength(3);
	expect(dynamicMountsAndWorkdir.at(-1)).toBe("--workdir=/workspace/src");
	const volumeArgs = dynamicMountsAndWorkdir.filter((argument) =>
		argument.startsWith("--volume="),
	);
	expect(volumeArgs).toHaveLength(2);
	expect(volumeArgs).toEqual(
		expect.arrayContaining([
			expect.stringMatching(/:\/workspace\/src:ro,rprivate$/),
			expect.stringMatching(/:\/workspace\/generated:rw,rprivate$/),
		]),
	);
	for (const volume of volumeArgs) {
		expect(volume).not.toContain(`${projectRoot}:`);
		expect(volume).toMatch(
			/\.buildplane-oci-(?:read-snapshot|overlay)-[^:]+:\/workspace\//,
		);
	}

	const allowedPreImage = new Set([
		...staticPrefix,
		"--workdir=/workspace/src",
		...volumeArgs,
	]);
	for (const argument of preImage) {
		expect(allowedPreImage.has(argument)).toBe(true);
	}
	for (const required of staticPrefix) {
		expect(preImage.filter((argument) => argument === required)).toHaveLength(
			1,
		);
	}
	expect(preImage.some((argument) => argument === "--privileged")).toBe(false);
	expect(preImage.some((argument) => argument === "--network=host")).toBe(
		false,
	);
}

describe("governed command worker + Podman contract", () => {
	it("writes unknown before its receipt and never retries an ambiguous OCI action", async () => {
		const order: string[] = [];
		const podmanRuns: Array<{
			readonly args: readonly string[];
			readonly timeoutMs: number | undefined;
		}> = [];
		const podmanBinaries: string[] = [];
		const runner: PodmanCommandRunner = (binary, args, options) => {
			podmanBinaries.push(binary);
			expect(binary).toBe("podman");
			const prerequisite = rootlessPrerequisiteResult(args);
			if (prerequisite !== undefined) return prerequisite;
			if (args[0] !== "run") {
				throw new Error(`unexpected Podman invocation: ${args.join(" ")}`);
			}
			podmanRuns.push({ args: [...args], timeoutMs: options.timeoutMs });
			order.push("podman-run");
			return {
				status: null,
				stdout: "",
				stderr: "lost Podman control-plane response",
				error: "lost Podman control-plane response",
			};
		};
		const sandboxProfile = profile();
		const actionExecutor = createPodmanGovernedActionExecutorForTest(
			{ image: IMAGE, profile: sandboxProfile, runner },
			{ platform: "linux" },
		);
		const inputPacket = packet();
		const signedDispatch = dispatch(inputPacket, sandboxProfile);
		const receiptOutcomes: string[] = [];
		let terminalUnknownRecorded = false;
		const actionEvidencePort: GovernedActionEvidencePort = {
			async recordActionRequested(actionRequest) {
				order.push("write-ahead-request");
				return {
					actionRequest,
					actionRequestRef:
						"event://action-request/governed-worker-podman-contract",
					actionRequestDigest: canonicalActionRequestedV2Digest(actionRequest),
				};
			},
			async recordActionReceipt(receipt) {
				receiptOutcomes.push(receipt.outcome);
				order.push(`receipt:${receipt.outcome}`);
				const durableReceipt = {
					...receipt,
					actionReceiptRef:
						"event://action-receipt/governed-worker-podman-contract",
				};
				return {
					receipt: durableReceipt,
					actionReceiptDigest:
						canonicalActionReceiptRecordedV2Digest(durableReceipt),
				};
			},
			async sealActionReceiptSet() {
				throw new Error("not reached by a command action");
			},
			async recordCandidateCreatedV2() {
				throw new Error("not reached by a command action");
			},
		};
		const evidenceStore: GovernedCommandEvidenceStore = {
			async persistCanonicalInput() {
				order.push("canonical-input");
				return {
					canonicalInputDigest: DIGEST_E,
					canonicalInputRef:
						"cas://command-input/governed-worker-podman-contract",
					redactions: [],
				};
			},
			async persistActionResult() {
				throw new Error("an ambiguous Podman outcome cannot persist a result");
			},
		};
		const activityClaimPort: GovernedActivityClaimPort = {
			async claim(input) {
				order.push("native-claim");
				if (terminalUnknownRecorded) {
					return {
						state: "recorded",
						claimEventId:
							"event://activity-claim/governed-worker-podman-contract",
						resultEventId:
							"event://activity-result/governed-worker-podman-contract",
						resultEventDigest: DIGEST_F,
						resultOutcome: "unknown",
					};
				}
				return {
					state: "granted",
					activityId: input.activityId,
					idempotencyKey: input.idempotencyKey,
					claimEventId:
						"event://activity-claim/governed-worker-podman-contract",
					claimEventDigest: DIGEST_F,
					leaseId: "lease://governed-worker-podman-contract",
					leaseExpiresAt: "2026-07-18T00:05:00.000Z",
				};
			},
			async recordResult(input) {
				expect(input.outcome).toBe("unknown");
				terminalUnknownRecorded = true;
				order.push(`native-result:${input.outcome}`);
				return {
					state: "recorded",
					resultEventId:
						"event://activity-result/governed-worker-podman-contract",
					resultEventDigest: DIGEST_F,
					resultOutcome: input.outcome,
				};
			},
		};
		const port = createGovernedCommandWorkerExecutionPort({
			actionExecutor,
			evidenceStore,
			activityClaimPort,
			now: () => ISSUED_AT,
			nowMs: () => ISSUED_AT_MS,
		});
		const input = {
			runId: RUN_ID,
			packet: inputPacket,
			projectRoot: makeProjectRoot(),
			eventBus: { emit() {} } as never,
			signal: new AbortController().signal,
			governedDispatch: signedDispatch,
			actionEvidencePort,
		};

		await expect(port.executeCandidatePacketAsync(input)).rejects.toThrow(
			/ambiguous Podman control-plane outcome/i,
		);

		expect(order).toEqual([
			"canonical-input",
			"write-ahead-request",
			"native-claim",
			"podman-run",
			"native-result:unknown",
			"receipt:unknown",
		]);
		expect(receiptOutcomes).toEqual(["unknown"]);
		expect(podmanRuns).toHaveLength(1);
		expect(actionExecutor.sandbox).toMatchObject({
			runtime: "rootless-oci",
			rootless: true,
			network: "none",
			hostFallback: false,
		});
		expect(podmanRuns[0]).toMatchObject({ timeoutMs: 30_000 });
		expectHardenedPodmanActionArgv(
			podmanRuns[0]?.args ?? [],
			input.projectRoot,
		);

		await expect(port.executeCandidatePacketAsync(input)).rejects.toThrow(
			/already has a terminal native result/i,
		);

		expect(order).toEqual([
			"canonical-input",
			"write-ahead-request",
			"native-claim",
			"podman-run",
			"native-result:unknown",
			"receipt:unknown",
			"canonical-input",
			"write-ahead-request",
			"native-claim",
		]);
		expect(podmanRuns).toHaveLength(1);
		expect(receiptOutcomes).toEqual(["unknown"]);
		expect(podmanBinaries).toEqual([
			"podman",
			"podman",
			"podman",
			"podman",
			"podman",
		]);
	});

	it("fails closed when Podman is unavailable and never substitutes a host runner", () => {
		const binaries: string[] = [];
		expect(() =>
			createPodmanGovernedActionExecutorForTest(
				{
					image: IMAGE,
					profile: profile(),
					runner: (binary) => {
						binaries.push(binary);
						return {
							status: 127,
							stdout: "",
							stderr: "podman not found",
							error: "podman not found",
						};
					},
				},
				{ platform: "linux" },
			),
		).toThrow(/Podman runtime is unavailable/i);
		expect(binaries).toEqual(["podman"]);
	});
});
