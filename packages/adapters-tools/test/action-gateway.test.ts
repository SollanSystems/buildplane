import { bundleDigest } from "@buildplane/capability-broker";
import {
	canonicalActionRequestedV2Digest,
	deriveGovernedCommandInputCommitmentV1,
} from "@buildplane/kernel";
import { describe, expect, it, vi } from "vitest";
import {
	type ActionGatewayReceipt,
	type ActionGatewayRole,
	createActionGateway,
	type GatewayAction,
	type GatewayTools,
	type GovernedActionExecutor,
} from "../src/action-gateway.js";
import { mintGovernedActionPermit } from "../src/governed-action-permit.js";
import * as publicAdapterTools from "../src/index.js";
import { createTrustedTestGovernedActionExecutor } from "./helpers/trusted-governed-executor.js";

function governedBundle() {
	return {
		schemaVersion: "buildplane.capability_bundle.v0" as const,
		bundleId: "gateway-test",
		fsRead: ["**"],
		fsWrite: ["**"],
		tools: {
			write_file: { enabled: true },
			run_command: { allowlist: ["git"] },
		},
	};
}

function governedBundleDigest(bundle = governedBundle()): string {
	return bundleDigest(bundle);
}

function tools(overrides: Partial<GatewayTools> = {}): GatewayTools {
	return {
		runCommand: () => ({
			success: true,
			exitCode: 0,
			stdout: "ok",
			stderr: "",
		}),
		writeFile: () => ({ success: true, path: "output.txt" }),
		...overrides,
	};
}

function governedExecutor(
	overrides: Partial<GovernedActionExecutor> = {},
): GovernedActionExecutor {
	return createTrustedTestGovernedActionExecutor(overrides);
}

type ExecutableGatewayAction = Extract<
	GatewayAction,
	{ readonly kind: "process.run" }
>;

function governedActionPermit(input: {
	readonly runId: string;
	readonly worktreeRoot: string;
	readonly role: ActionGatewayRole;
	readonly action: ExecutableGatewayAction;
	readonly capabilityBundleDigest: string;
	readonly sandboxProfileDigest: string;
	readonly governedDeadlineAtMs?: number;
	readonly nowMs?: number;
	readonly leaseExpiresAt?: string;
}) {
	const governedDeadlineAtMs = input.governedDeadlineAtMs ?? 4_102_444_800_000;
	const nowMs = input.nowMs ?? Date.now();
	const digestA = `sha256:${"a".repeat(64)}`;
	const digestB = `sha256:${"b".repeat(64)}`;
	const digestC = `sha256:${"c".repeat(64)}`;
	const digestD = `sha256:${"d".repeat(64)}`;
	const commandInputCommitment = deriveGovernedCommandInputCommitmentV1({
		runId: input.runId,
		actionId: input.action.actionId,
		command: input.action.command,
		args: input.action.args,
		...(input.action.cwd === undefined ? {} : { cwd: input.action.cwd }),
	});
	const dispatch = {
		schemaVersion: 3 as const,
		runId: input.runId,
		workflowId: "workflow-governed-permit",
		workflowRevision: "revision-governed-permit",
		unitId: "unit-governed-permit",
		attempt: 1,
		provenanceRef: "event://admission/governed-permit",
		dispatchEnvelopeRef: "event://dispatch/governed-permit",
		envelopeDigest: digestA,
		baseCommitSha: "1".repeat(40),
		repositoryBindingDigest: digestB,
		ledgerAuthorityRealmDigest: digestC,
		governedPacketDigest: digestD,
		executionRole: input.role,
		commitMode: "atomic" as const,
		trustTier: "governed" as const,
		capabilityBundleDigest: input.capabilityBundleDigest,
		acceptanceContractDigest: digestB,
		policyDigest: digestC,
		contextManifestDigest: digestD,
		workerManifestDigest: digestA,
		sandboxProfileDigest: input.sandboxProfileDigest,
		budget: {},
		idempotencyKey: `dispatch:${input.runId}:1`,
		authorityActor: "kernel:test",
		actionEvidenceVersion: "sealed_v3" as const,
		issuedAt: "2026-01-01T00:00:00.000Z",
		expiresAt: "2101-01-01T00:00:00.000Z",
	};
	const actionRequest = {
		schemaVersion: 2 as const,
		runId: input.runId,
		workflowId: dispatch.workflowId,
		unitId: dispatch.unitId,
		attempt: dispatch.attempt,
		provenanceRef: dispatch.provenanceRef,
		actionId: input.action.actionId,
		idempotencyKey: `${dispatch.idempotencyKey}:action`,
		actionKind:
			input.action.kind === "process.run"
				? ("process" as const)
				: ("filesystem" as const),
		canonicalInputDigest: commandInputCommitment.digest,
		canonicalInputRef: commandInputCommitment.ref,
		dispatchEnvelopeDigest: dispatch.envelopeDigest,
		repositoryBindingDigest: dispatch.repositoryBindingDigest,
		ledgerAuthorityRealmDigest: dispatch.ledgerAuthorityRealmDigest,
		governedPacketDigest: dispatch.governedPacketDigest,
		capabilityBundleDigest: input.capabilityBundleDigest,
		policyDigest: dispatch.policyDigest,
		contextManifestDigest: dispatch.contextManifestDigest,
		workerManifestDigest: dispatch.workerManifestDigest,
		sandboxProfileDigest: input.sandboxProfileDigest,
		authorityActor: dispatch.authorityActor,
		executionRole: input.role,
		requestedAt: "2026-01-01T00:00:00.000Z",
	};
	const durableRequest = {
		actionRequest,
		actionRequestRef: "event://action-request/governed-permit",
		actionRequestDigest: canonicalActionRequestedV2Digest(actionRequest),
	};
	const permit = mintGovernedActionPermit({
		runId: input.runId,
		worktreeRoot: input.worktreeRoot,
		role: input.role,
		action: input.action,
		dispatch,
		durableRequest,
		claim: {
			state: "granted",
			activityId: input.action.actionId,
			idempotencyKey: actionRequest.idempotencyKey,
			claimEventId: "event://activity-claim/governed-permit",
			claimEventDigest: digestA,
			leaseId: "lease://activity-claim/governed-permit",
			leaseExpiresAt: input.leaseExpiresAt ?? "2101-01-01T00:00:00.000Z",
		},
		capabilityBundleDigest: input.capabilityBundleDigest,
		sandboxProfileDigest: input.sandboxProfileDigest,
		governedDeadlineAtMs,
		nowMs,
	});
	return Object.freeze({
		permit,
		evidence: Object.freeze({
			dispatchEnvelopeDigest: dispatch.envelopeDigest,
			durableActionRequestDigest: durableRequest.actionRequestDigest,
			canonicalInputDigest: actionRequest.canonicalInputDigest,
			idempotencyKey: actionRequest.idempotencyKey,
			leaseId: "lease://activity-claim/governed-permit",
		}),
	});
}

const RESERVED_ACTION_FAMILIES = [
	"git",
	"model",
	"network",
	"secret",
	"mcp",
	"a2a",
	"external_service",
] as const;
const ACTION_GATEWAY_TEST_MODES = ["raw", "governed"] as const;

function reservedActionGateway(
	mode: (typeof ACTION_GATEWAY_TEST_MODES)[number],
) {
	const rawRunCommand = vi.fn(tools().runCommand);
	const rawWriteFile = vi.fn(tools().writeFile);
	const ociRunCommand = vi.fn(governedExecutor().runCommand);
	const ociWriteFile = vi.fn(governedExecutor().writeFile);
	const onReceipt = vi.fn();
	const common = {
		runId: `run-reserved-${mode}`,
		worktreeRoot: "/worktree",
		role: "implementer" as const,
		trustTier: mode,
		tools: tools({ runCommand: rawRunCommand, writeFile: rawWriteFile }),
		onReceipt,
	};
	const gateway =
		mode === "governed"
			? createActionGateway({
					...common,
					capabilityBundle: governedBundle(),
					capabilityBundleDigest: governedBundleDigest(),
					governedExecutor: governedExecutor({
						runCommand: ociRunCommand,
						writeFile: ociWriteFile,
					}),
					governedDeadlineAtMs: 4_102_444_800_000,
				})
			: createActionGateway(common);

	return {
		gateway,
		rawRunCommand,
		rawWriteFile,
		ociRunCommand,
		ociWriteFile,
		onReceipt,
	};
}

describe("ActionGateway", () => {
	it("fails governed authorization closed before a tool can run without a capability bundle", () => {
		const runCommand = vi.fn(tools().runCommand);
		const gateway = createActionGateway({
			runId: "run-1",
			worktreeRoot: "/worktree",
			role: "implementer",
			trustTier: "governed",
			tools: tools({ runCommand }),
		});

		const receipt = gateway.execute({
			actionId: "action-1",
			kind: "process.run",
			command: "git",
			args: ["status"],
		});

		expect(receipt).toMatchObject({
			outcome: "denied",
			reason: "governed actions require a capability bundle",
		});
		expect(runCommand).not.toHaveBeenCalled();
	});

	it("requires a durable claim-bound permit before governed OCI can observe an action", () => {
		const sandboxRunCommand = vi.fn(governedExecutor().runCommand);
		const bundle = governedBundle();
		const gateway = createActionGateway({
			runId: "run-governed-missing-permit",
			worktreeRoot: "/worktree",
			role: "implementer",
			trustTier: "governed",
			capabilityBundle: bundle,
			capabilityBundleDigest: governedBundleDigest(bundle),
			governedExecutor: governedExecutor({ runCommand: sandboxRunCommand }),
			governedDeadlineAtMs: 4_102_444_800_000,
		});

		const receipt = gateway.execute({
			actionId: "action-governed-missing-permit",
			kind: "process.run",
			command: "git",
			args: ["status"],
		});

		expect(receipt).toMatchObject({
			outcome: "denied",
			reason: expect.stringMatching(/claim-bound permit/i),
		});
		expect(sandboxRunCommand).not.toHaveBeenCalled();
	});

	it.each(["plain", "serialized"] as const)(
		"denies a %s forged permit before OCI observes a governed action",
		(kind) => {
			const sandboxRunCommand = vi.fn(governedExecutor().runCommand);
			const bundle = governedBundle();
			const ociExecutor = governedExecutor({ runCommand: sandboxRunCommand });
			const action = Object.freeze({
				actionId: "action-forged-governed-permit",
				kind: "process.run" as const,
				command: "git",
				args: Object.freeze(["status"]),
			});
			const capabilityBundleDigest = governedBundleDigest(bundle);
			const permitBinding = governedActionPermit({
				runId: "run-forged-governed-permit",
				worktreeRoot: "/worktree",
				role: "implementer",
				action,
				capabilityBundleDigest,
				sandboxProfileDigest: ociExecutor.sandbox.profileDigest,
				governedDeadlineAtMs: 4_102_444_800_000,
			});
			const forgedPermit =
				kind === "plain"
					? Object.freeze({})
					: JSON.parse(JSON.stringify(permitBinding.permit));
			const gateway = createActionGateway({
				runId: "run-forged-governed-permit",
				worktreeRoot: "/worktree",
				role: "implementer",
				trustTier: "governed",
				capabilityBundle: bundle,
				capabilityBundleDigest,
				governedExecutor: ociExecutor,
				governedDeadlineAtMs: 4_102_444_800_000,
				governedActionPermit: forgedPermit,
				governedActionEvidence: permitBinding.evidence,
			});

			expect(gateway.execute(action)).toMatchObject({
				outcome: "denied",
				reason: expect.stringMatching(/claim-bound permit/i),
			});
			expect(sandboxRunCommand).not.toHaveBeenCalled();
		},
	);

	it("consumes a governed permit once, including across separate gateways", () => {
		const sandboxRunCommand = vi.fn(governedExecutor().runCommand);
		const bundle = governedBundle();
		const ociExecutor = governedExecutor({ runCommand: sandboxRunCommand });
		const action = Object.freeze({
			actionId: "action-one-use-governed-permit",
			kind: "process.run" as const,
			command: "git",
			args: Object.freeze(["status"]),
		});
		const capabilityBundleDigest = governedBundleDigest(bundle);
		const permitBinding = governedActionPermit({
			runId: "run-one-use-governed-permit",
			worktreeRoot: "/worktree",
			role: "implementer",
			action,
			capabilityBundleDigest,
			sandboxProfileDigest: ociExecutor.sandbox.profileDigest,
			governedDeadlineAtMs: 4_102_444_800_000,
		});
		const options = {
			runId: "run-one-use-governed-permit",
			worktreeRoot: "/worktree",
			role: "implementer" as const,
			trustTier: "governed" as const,
			capabilityBundle: bundle,
			capabilityBundleDigest,
			governedExecutor: ociExecutor,
			governedDeadlineAtMs: 4_102_444_800_000,
			governedActionPermit: permitBinding.permit,
			governedActionEvidence: permitBinding.evidence,
		};

		expect(createActionGateway(options).execute(action)).toMatchObject({
			outcome: "succeeded",
		});
		expect(createActionGateway(options).execute(action)).toMatchObject({
			outcome: "denied",
			reason: expect.stringMatching(/already consumed/i),
		});
		expect(sandboxRunCommand).toHaveBeenCalledOnce();
	});

	it("denies a permit after its activity lease expires before OCI dispatch", () => {
		const sandboxRunCommand = vi.fn(governedExecutor().runCommand);
		const bundle = governedBundle();
		const ociExecutor = governedExecutor({ runCommand: sandboxRunCommand });
		const action = Object.freeze({
			actionId: "action-expired-lease-permit",
			kind: "process.run" as const,
			command: "git",
			args: Object.freeze(["status"]),
		});
		const mintedAtMs = 1_800_000_000_000;
		const leaseExpiresAt = new Date(mintedAtMs + 100).toISOString();
		const capabilityBundleDigest = governedBundleDigest(bundle);
		const permitBinding = governedActionPermit({
			runId: "run-expired-lease-permit",
			worktreeRoot: "/worktree",
			role: "implementer",
			action,
			capabilityBundleDigest,
			sandboxProfileDigest: ociExecutor.sandbox.profileDigest,
			governedDeadlineAtMs: 4_102_444_800_000,
			nowMs: mintedAtMs,
			leaseExpiresAt,
		});
		const gateway = createActionGateway({
			runId: "run-expired-lease-permit",
			worktreeRoot: "/worktree",
			role: "implementer",
			trustTier: "governed",
			capabilityBundle: bundle,
			capabilityBundleDigest,
			governedExecutor: ociExecutor,
			governedDeadlineAtMs: 4_102_444_800_000,
			governedNowMs: () => mintedAtMs + 101,
			governedActionPermit: permitBinding.permit,
			governedActionEvidence: permitBinding.evidence,
		});

		expect(gateway.execute(action)).toMatchObject({
			outcome: "denied",
			reason: expect.stringMatching(/lease is expired/i),
		});
		expect(sandboxRunCommand).not.toHaveBeenCalled();
	});

	it("denies a governed filesystem action even when a process permit is present", () => {
		const sandboxWriteFile = vi.fn(governedExecutor().writeFile);
		const bundle = governedBundle();
		const ociExecutor = governedExecutor({ writeFile: sandboxWriteFile });
		const processAction = Object.freeze({
			actionId: "action-process-permit-for-filesystem-denial",
			kind: "process.run" as const,
			command: "git",
			args: Object.freeze(["status"]),
		});
		const capabilityBundleDigest = governedBundleDigest(bundle);
		const permitBinding = governedActionPermit({
			runId: "run-filesystem-permit-denial",
			worktreeRoot: "/worktree",
			role: "implementer",
			action: processAction,
			capabilityBundleDigest,
			sandboxProfileDigest: ociExecutor.sandbox.profileDigest,
			governedDeadlineAtMs: 4_102_444_800_000,
		});
		const gateway = createActionGateway({
			runId: "run-filesystem-permit-denial",
			worktreeRoot: "/worktree",
			role: "implementer",
			trustTier: "governed",
			capabilityBundle: bundle,
			capabilityBundleDigest,
			governedExecutor: ociExecutor,
			governedDeadlineAtMs: 4_102_444_800_000,
			governedActionPermit: permitBinding.permit,
			governedActionEvidence: permitBinding.evidence,
		});

		expect(
			gateway.execute({
				actionId: "action-filesystem-permit-denial",
				kind: "filesystem.write",
				path: "output.txt",
				content: "must not run",
			}),
		).toMatchObject({
			outcome: "denied",
			reason: expect.stringMatching(/no durable command input commitment/i),
		});
		expect(sandboxWriteFile).not.toHaveBeenCalled();
	});

	it("fails closed before minting a filesystem permit", () => {
		expect(() =>
			mintGovernedActionPermit({
				runId: "run-filesystem-mint-denial",
				worktreeRoot: "/worktree",
				role: "implementer",
				action: {
					actionId: "action-filesystem-mint-denial",
					kind: "filesystem.write",
					path: "output.txt",
					content: "must not mint",
				},
				dispatch: undefined as never,
				durableRequest: undefined as never,
				claim: undefined as never,
				capabilityBundleDigest: `sha256:${"a".repeat(64)}`,
				sandboxProfileDigest: `sha256:${"b".repeat(64)}`,
				governedDeadlineAtMs: 4_102_444_800_000,
				nowMs: 1_800_000_000_000,
			}),
		).toThrow(/durable command input commitment/i);
	});

	it("ignores malformed governed permit sidecars in the explicitly unsafe raw lane", () => {
		const rawRunCommand = vi.fn(tools().runCommand);
		const gateway = createActionGateway({
			runId: "run-raw-malformed-governed-sidecars",
			worktreeRoot: "/worktree",
			role: "implementer",
			trustTier: "raw",
			tools: tools({ runCommand: rawRunCommand }),
			governedActionPermit: Object.freeze({ forged: true }),
			governedActionEvidence: ["not", "governed", "evidence"],
		});

		expect(
			gateway.execute({
				actionId: "action-raw-malformed-governed-sidecars",
				kind: "process.run",
				command: "git",
				args: ["status"],
			}),
		).toMatchObject({ outcome: "succeeded" });
		expect(rawRunCommand).toHaveBeenCalledOnce();
	});

	it("does not expose permit minting or consumption through the public package surface", () => {
		expect(Object.hasOwn(publicAdapterTools, "mintGovernedActionPermit")).toBe(
			false,
		);
		expect(
			Object.hasOwn(publicAdapterTools, "consumeGovernedActionPermit"),
		).toBe(false);
	});

	it("requires an exact governed capability bundle digest before OCI can observe an action", () => {
		const sandboxRunCommand = vi.fn(governedExecutor().runCommand);
		const bundle = governedBundle();
		const ociExecutor = governedExecutor({ runCommand: sandboxRunCommand });
		const common = {
			runId: "run-governed-digest",
			worktreeRoot: "/worktree",
			role: "implementer" as const,
			trustTier: "governed" as const,
			capabilityBundle: bundle,
			governedExecutor: ociExecutor,
			governedDeadlineAtMs: 4_102_444_800_000,
		};

		expect(() => createActionGateway(common)).toThrow(
			/governed capabilityBundleDigest/i,
		);
		expect(() =>
			createActionGateway({
				...common,
				capabilityBundleDigest: `sha256:${"f".repeat(64)}`,
			}),
		).toThrow(/does not match the governed capability bundle/i);
		expect(sandboxRunCommand).not.toHaveBeenCalled();

		const action = Object.freeze({
			actionId: "action-governed-digest",
			kind: "process.run" as const,
			command: "git",
			args: Object.freeze(["status"]),
		});
		const capabilityBundleDigest = governedBundleDigest(bundle);
		const permitBinding = governedActionPermit({
			runId: common.runId,
			worktreeRoot: common.worktreeRoot,
			role: common.role,
			action,
			capabilityBundleDigest,
			sandboxProfileDigest: ociExecutor.sandbox.profileDigest,
			governedDeadlineAtMs: common.governedDeadlineAtMs,
		});
		const gateway = createActionGateway({
			...common,
			capabilityBundleDigest,
			governedActionPermit: permitBinding.permit,
			governedActionEvidence: permitBinding.evidence,
		});
		const receipt = gateway.execute(action);

		expect(receipt.outcome).toBe("succeeded");
		expect(sandboxRunCommand).toHaveBeenCalledOnce();
	});

	it("keeps raw execution compatible when no capability bundle digest is supplied", () => {
		const runCommand = vi.fn(tools().runCommand);
		const gateway = createActionGateway({
			runId: "run-raw-unsigned-bundle",
			worktreeRoot: "/worktree",
			role: "implementer",
			trustTier: "raw",
			capabilityBundle: governedBundle(),
			tools: tools({ runCommand }),
		});

		expect(
			gateway.execute({
				actionId: "action-raw-unsigned-bundle",
				kind: "process.run",
				command: "git",
				args: ["status"],
			}),
		).toMatchObject({ outcome: "succeeded" });
		expect(runCommand).toHaveBeenCalledOnce();
	});

	it("never falls through to injected host tools when a governed sandbox executor is absent", () => {
		const hostRunCommand = vi.fn(tools().runCommand);
		const hostWriteFile = vi.fn(tools().writeFile);
		const gateway = createActionGateway({
			runId: "run-no-sandbox",
			worktreeRoot: "/worktree",
			role: "implementer",
			trustTier: "governed",
			capabilityBundle: governedBundle(),
			capabilityBundleDigest: governedBundleDigest(),
			// `tools` intentionally models the legacy host implementation. It must
			// not be selected merely because the governed caller supplied it.
			tools: tools({
				runCommand: hostRunCommand,
				writeFile: hostWriteFile,
			}),
		});

		const processReceipt = gateway.execute({
			actionId: "action-no-sandbox-process",
			kind: "process.run",
			command: "git",
			args: ["status"],
		});
		const writeReceipt = gateway.execute({
			actionId: "action-no-sandbox-write",
			kind: "filesystem.write",
			path: "output.txt",
			content: "must not touch the host",
		});

		expect(processReceipt).toMatchObject({
			outcome: "denied",
			reason: expect.stringContaining("host tool fallback is disabled"),
		});
		expect(writeReceipt).toMatchObject({ outcome: "denied" });
		expect(hostRunCommand).not.toHaveBeenCalled();
		expect(hostWriteFile).not.toHaveBeenCalled();
	});

	it("routes governed actions only through an explicitly attested sandbox executor", () => {
		const hostRunCommand = vi.fn(tools().runCommand);
		const sandboxRunCommand = vi.fn(governedExecutor().runCommand);
		const bundle = governedBundle();
		const ociExecutor = governedExecutor({ runCommand: sandboxRunCommand });
		const action = Object.freeze({
			actionId: "action-sandboxed",
			kind: "process.run" as const,
			command: "git",
			args: Object.freeze(["status"]),
		});
		const capabilityBundleDigest = governedBundleDigest(bundle);
		const permitBinding = governedActionPermit({
			runId: "run-sandboxed",
			worktreeRoot: "/worktree",
			role: "implementer",
			action,
			capabilityBundleDigest,
			sandboxProfileDigest: ociExecutor.sandbox.profileDigest,
			governedDeadlineAtMs: 4_102_444_800_000,
		});
		const gateway = createActionGateway({
			runId: "run-sandboxed",
			worktreeRoot: "/worktree",
			role: "implementer",
			trustTier: "governed",
			capabilityBundle: bundle,
			capabilityBundleDigest,
			tools: tools({ runCommand: hostRunCommand }),
			governedExecutor: ociExecutor,
			governedDeadlineAtMs: 4_102_444_800_000,
			governedActionPermit: permitBinding.permit,
			governedActionEvidence: permitBinding.evidence,
		});

		const receipt = gateway.execute(action);

		expect(receipt.outcome).toBe("succeeded");
		expect(sandboxRunCommand).toHaveBeenCalledOnce();
		expect(sandboxRunCommand).toHaveBeenCalledWith(
			{ command: "git", args: ["status"] },
			expect.objectContaining({
				runId: "run-sandboxed",
				worktreeRoot: "/worktree",
				role: "implementer",
				capabilityBundle: expect.objectContaining({ bundleId: "gateway-test" }),
				capabilityBundleDigest,
			}),
		);
		expect(hostRunCommand).not.toHaveBeenCalled();
	});

	it("denies an exhausted governed compute deadline before a sandbox executor observes the action", () => {
		const sandboxRunCommand = vi.fn(governedExecutor().runCommand);
		const exhaustedAtMs = 1_800_000_000_000;
		const gateway = createActionGateway({
			runId: "run-exhausted-compute-budget",
			worktreeRoot: "/worktree",
			role: "implementer",
			trustTier: "governed",
			capabilityBundle: governedBundle(),
			capabilityBundleDigest: governedBundleDigest(),
			governedExecutor: governedExecutor({ runCommand: sandboxRunCommand }),
			governedDeadlineAtMs: exhaustedAtMs,
			governedNowMs: () => exhaustedAtMs,
		});

		const receipt = gateway.execute({
			actionId: "action-exhausted-compute-budget",
			kind: "process.run",
			command: "git",
			args: ["status"],
		});

		expect(receipt).toMatchObject({
			outcome: "denied",
			reason: expect.stringContaining("compute deadline is exhausted"),
		});
		expect(sandboxRunCommand).not.toHaveBeenCalled();
	});

	it("rejects an overflowing governed deadline before a sandbox executor can be retained", () => {
		const sandboxRunCommand = vi.fn(governedExecutor().runCommand);

		expect(() =>
			createActionGateway({
				runId: "run-overflowing-compute-budget",
				worktreeRoot: "/worktree",
				role: "implementer",
				trustTier: "governed",
				capabilityBundle: governedBundle(),
				capabilityBundleDigest: governedBundleDigest(),
				governedExecutor: governedExecutor({ runCommand: sandboxRunCommand }),
				governedDeadlineAtMs: Number.MAX_SAFE_INTEGER,
			}),
		).toThrow(/safe epoch-millisecond timestamp/i);
		expect(sandboxRunCommand).not.toHaveBeenCalled();
	});

	it("rejects a structurally forged host executor before its callbacks can run", () => {
		const hostRunCommand = vi.fn(tools().runCommand);
		const hostWriteFile = vi.fn(tools().writeFile);
		const forgedExecutor: GovernedActionExecutor = {
			sandbox: {
				schemaVersion: 1,
				runtime: "rootless-oci",
				rootless: true,
				readOnlyBase: true,
				writableOverlay: true,
				network: "none",
				hostFallback: false,
				profileDigest: `sha256:${"b".repeat(64)}`,
			},
			runCommand: hostRunCommand,
			writeFile: hostWriteFile,
		};

		expect(() =>
			createActionGateway({
				runId: "run-forged-executor",
				worktreeRoot: "/worktree",
				role: "implementer",
				trustTier: "governed",
				capabilityBundle: governedBundle(),
				capabilityBundleDigest: governedBundleDigest(),
				governedExecutor: forgedExecutor,
			}),
		).toThrow(/trusted rootless OCI executor factory/i);
		expect(hostRunCommand).not.toHaveBeenCalled();
		expect(hostWriteFile).not.toHaveBeenCalled();
	});

	it("evaluates governed command capabilities at the gateway before the sandbox executor", () => {
		const sandboxRunCommand = vi.fn(governedExecutor().runCommand);
		const gateway = createActionGateway({
			runId: "run-governed-command-broker",
			worktreeRoot: "/worktree",
			role: "implementer",
			trustTier: "governed",
			capabilityBundle: governedBundle(),
			capabilityBundleDigest: governedBundleDigest(),
			governedExecutor: governedExecutor({ runCommand: sandboxRunCommand }),
		});

		const receipt = gateway.execute({
			actionId: "action-governed-command-broker",
			kind: "process.run",
			command: "curl",
			args: ["https://example.invalid"],
		});

		expect(receipt).toMatchObject({
			outcome: "denied",
			reason: "capability broker: command is not in run_command allowlist",
		});
		expect(sandboxRunCommand).not.toHaveBeenCalled();
	});

	it("evaluates governed filesystem capabilities at the gateway before the sandbox executor", () => {
		const sandboxWriteFile = vi.fn(governedExecutor().writeFile);
		const narrowBundle = {
			schemaVersion: "buildplane.capability_bundle.v0" as const,
			bundleId: "narrow-gateway-test",
			fsWrite: ["src/**"],
			tools: { write_file: { enabled: true } },
		};
		const gateway = createActionGateway({
			runId: "run-governed-write-broker",
			worktreeRoot: "/worktree",
			role: "implementer",
			trustTier: "governed",
			capabilityBundle: narrowBundle,
			capabilityBundleDigest: bundleDigest(narrowBundle),
			governedExecutor: governedExecutor({ writeFile: sandboxWriteFile }),
		});

		const receipt = gateway.execute({
			actionId: "action-governed-write-broker",
			kind: "filesystem.write",
			path: "secrets.txt",
			content: "must not be written",
		});

		expect(receipt).toMatchObject({
			outcome: "denied",
			reason: expect.stringContaining("outside fsWrite allowlist"),
		});
		expect(sandboxWriteFile).not.toHaveBeenCalled();
	});

	it("rejects a governed executor that declares a host fallback", () => {
		expect(() =>
			createActionGateway({
				runId: "run-invalid-sandbox",
				worktreeRoot: "/worktree",
				role: "implementer",
				trustTier: "governed",
				capabilityBundle: governedBundle(),
				capabilityBundleDigest: governedBundleDigest(),
				governedExecutor: governedExecutor({
					sandbox: {
						...governedExecutor().sandbox,
						hostFallback: true,
					} as never,
				}),
			}),
		).toThrow(/rootless OCI isolation contract/i);
	});

	it.each(["reviewer", "adversary", "judge"] as const)(
		"allows %s to dispatch governed process.run through the attested executor",
		(role) => {
			const sandboxRunCommand = vi.fn(governedExecutor().runCommand);
			const bundle = governedBundle();
			const ociExecutor = governedExecutor({ runCommand: sandboxRunCommand });
			const action = Object.freeze({
				actionId: `action-${role}-read-only-command`,
				kind: "process.run" as const,
				command: "git",
				args: Object.freeze(["status"]),
			});
			const capabilityBundleDigest = governedBundleDigest(bundle);
			const permitBinding = governedActionPermit({
				runId: `run-${role}-read-only-command`,
				worktreeRoot: "/worktree",
				role,
				action,
				capabilityBundleDigest,
				sandboxProfileDigest: ociExecutor.sandbox.profileDigest,
				governedDeadlineAtMs: 4_102_444_800_000,
			});
			const gateway = createActionGateway({
				runId: `run-${role}-read-only-command`,
				worktreeRoot: "/worktree",
				role,
				trustTier: "governed",
				capabilityBundle: bundle,
				capabilityBundleDigest,
				governedExecutor: ociExecutor,
				governedDeadlineAtMs: 4_102_444_800_000,
				governedActionPermit: permitBinding.permit,
				governedActionEvidence: permitBinding.evidence,
			});

			const receipt = gateway.execute(action);

			expect(receipt.outcome).toBe("succeeded");
			expect(sandboxRunCommand).toHaveBeenCalledOnce();
			expect(sandboxRunCommand).toHaveBeenCalledWith(
				{ command: "git", args: ["status"] },
				expect.objectContaining({ role }),
			);
		},
	);

	it.each(["reviewer", "adversary", "judge"] as const)(
		"denies %s filesystem.write before the governed executor is reached",
		(role) => {
			const sandboxWriteFile = vi.fn(governedExecutor().writeFile);
			const gateway = createActionGateway({
				runId: `run-${role}-write-denial`,
				worktreeRoot: "/worktree",
				role,
				trustTier: "governed",
				capabilityBundle: governedBundle(),
				capabilityBundleDigest: governedBundleDigest(),
				governedExecutor: governedExecutor({ writeFile: sandboxWriteFile }),
				governedDeadlineAtMs: 4_102_444_800_000,
			});

			const receipt = gateway.execute({
				actionId: `action-${role}-write-denial`,
				kind: "filesystem.write",
				path: "review.txt",
				content: "nope",
			});

			expect(receipt).toMatchObject({
				outcome: "denied",
				reason: `${role} is not permitted to perform filesystem.write`,
			});
			expect(sandboxWriteFile).not.toHaveBeenCalled();
		},
	);

	it("rejects an unknown role before it can become governed authority", () => {
		expect(() =>
			createActionGateway({
				runId: "run-unknown-role",
				worktreeRoot: "/worktree",
				role: "operator" as never,
				trustTier: "governed",
				capabilityBundle: governedBundle(),
			}),
		).toThrow(
			/role must be one of implementer, reviewer, adversary, judge, candidate/i,
		);
	});

	it("rejects an unknown trust tier before it can select an executor", () => {
		const sandboxRunCommand = vi.fn(governedExecutor().runCommand);

		expect(() =>
			createActionGateway({
				runId: "run-unknown-trust-tier",
				worktreeRoot: "/worktree",
				role: "implementer",
				trustTier: "audit" as never,
				capabilityBundle: governedBundle(),
				governedExecutor: governedExecutor({ runCommand: sandboxRunCommand }),
				governedDeadlineAtMs: 4_102_444_800_000,
			}),
		).toThrow(/trustTier must be one of raw, governed/i);
		expect(sandboxRunCommand).not.toHaveBeenCalled();
	});

	it("rejects a malformed capability bundle before creating a governed gateway", () => {
		expect(() =>
			createActionGateway({
				runId: "run-invalid-bundle",
				worktreeRoot: "/worktree",
				role: "implementer",
				trustTier: "governed",
				capabilityBundle: {} as never,
			}),
		).toThrow(/capability bundle is invalid/i);
	});

	it("keeps authority independent from receipt telemetry failures", () => {
		const onReceipt = vi.fn(() => {
			throw new Error("telemetry offline");
		});
		const gateway = createActionGateway({
			runId: "run-3",
			worktreeRoot: "/worktree",
			role: "implementer",
			trustTier: "raw",
			onReceipt,
			tools: tools(),
		});

		const receipt = gateway.execute({
			actionId: "action-3",
			kind: "process.run",
			command: "true",
		});

		expect(receipt.outcome).toBe("succeeded");
		expect(onReceipt).toHaveBeenCalledOnce();
	});

	it("does not let failed governed receipt telemetry expand denied authority", () => {
		const sandboxRunCommand = vi.fn(governedExecutor().runCommand);
		const onReceipt = vi.fn(() => {
			throw new Error("telemetry offline");
		});
		const gateway = createActionGateway({
			runId: "run-governed-telemetry-denial",
			worktreeRoot: "/worktree",
			role: "implementer",
			trustTier: "governed",
			capabilityBundle: governedBundle(),
			capabilityBundleDigest: governedBundleDigest(),
			governedExecutor: governedExecutor({ runCommand: sandboxRunCommand }),
			onReceipt,
		});

		const receipt = gateway.execute({
			actionId: "action-governed-telemetry-denial",
			kind: "process.run",
			command: "curl",
			args: ["https://example.invalid"],
		});

		expect(receipt).toMatchObject({
			outcome: "denied",
			reason: "capability broker: command is not in run_command allowlist",
		});
		expect(onReceipt).toHaveBeenCalledOnce();
		expect(sandboxRunCommand).not.toHaveBeenCalled();
	});

	it.each([
		["absent", undefined],
		[
			"failing",
			vi.fn(() => {
				throw new Error("telemetry offline");
			}),
		],
	] as const)(
		"does not let %s governed receipt telemetry mint or retain a permit or invoke host tools",
		(_telemetryState, onReceipt) => {
			const hostRunCommand = vi.fn(tools().runCommand);
			const sandboxRunCommand = vi.fn(governedExecutor().runCommand);
			const bundle = governedBundle();
			const ociExecutor = governedExecutor({ runCommand: sandboxRunCommand });
			const action = Object.freeze({
				actionId: "action-governed-telemetry-permit",
				kind: "process.run" as const,
				command: "git",
				args: Object.freeze(["status"]),
			});
			const capabilityBundleDigest = governedBundleDigest(bundle);
			const permitBinding = governedActionPermit({
				runId: "run-governed-telemetry-permit",
				worktreeRoot: "/worktree",
				role: "implementer",
				action,
				capabilityBundleDigest,
				sandboxProfileDigest: ociExecutor.sandbox.profileDigest,
				governedDeadlineAtMs: 4_102_444_800_000,
			});
			const commonOptions = {
				runId: "run-governed-telemetry-permit",
				worktreeRoot: "/worktree",
				role: "implementer" as const,
				trustTier: "governed" as const,
				capabilityBundle: bundle,
				capabilityBundleDigest,
				governedExecutor: ociExecutor,
				governedDeadlineAtMs: 4_102_444_800_000,
				tools: tools({ runCommand: hostRunCommand }),
				...(onReceipt === undefined ? {} : { onReceipt }),
			};
			expect(createActionGateway(commonOptions).execute(action)).toMatchObject({
				outcome: "denied",
				reason: expect.stringMatching(/claim-bound permit/i),
			});
			expect(sandboxRunCommand).not.toHaveBeenCalled();
			expect(hostRunCommand).not.toHaveBeenCalled();

			const options = {
				...commonOptions,
				governedActionPermit: permitBinding.permit,
				governedActionEvidence: permitBinding.evidence,
			};

			expect(createActionGateway(options).execute(action)).toMatchObject({
				outcome: "succeeded",
			});
			expect(sandboxRunCommand).toHaveBeenCalledOnce();
			expect(hostRunCommand).not.toHaveBeenCalled();

			expect(createActionGateway(options).execute(action)).toMatchObject({
				outcome: "denied",
				reason: expect.stringMatching(/already consumed/i),
			});
			expect(sandboxRunCommand).toHaveBeenCalledOnce();
			expect(hostRunCommand).not.toHaveBeenCalled();
			if (onReceipt !== undefined) {
				expect(onReceipt).toHaveBeenCalledTimes(3);
			}
		},
	);

	it("returns an immutable receipt even when an observer attempts to rewrite it", () => {
		let observed: ActionGatewayReceipt | undefined;
		const gateway = createActionGateway({
			runId: "run-malicious-observer",
			worktreeRoot: "/worktree",
			role: "implementer",
			trustTier: "raw",
			tools: tools({
				runCommand: () => ({
					success: false,
					exitCode: 1,
					stdout: "",
					stderr: "failed",
					error: "expected failure",
				}),
			}),
			onReceipt(receipt) {
				observed = receipt;
				try {
					(receipt as { outcome: "succeeded" }).outcome = "succeeded";
				} catch {
					// The observer must not be able to alter the returned decision.
				}
			},
		});

		const receipt = gateway.execute({
			actionId: "action-malicious-observer",
			kind: "process.run",
			command: "git",
		});

		expect(receipt).toMatchObject({
			outcome: "failed",
			reason: "expected failure",
		});
		expect(observed).toBe(receipt);
		expect(Object.isFrozen(receipt)).toBe(true);
	});

	it("turns capability-broker denials into denied action receipts", () => {
		const gateway = createActionGateway({
			runId: "run-4",
			worktreeRoot: "/worktree",
			role: "implementer",
			trustTier: "raw",
			tools: tools({
				runCommand: () => ({
					success: false,
					exitCode: 1,
					stdout: "",
					stderr: "",
					error: "capability broker: command is not allowed",
				}),
			}),
		});

		expect(
			gateway.execute({
				actionId: "action-4",
				kind: "process.run",
				command: "curl",
			}),
		).toMatchObject({ outcome: "denied" });
	});

	it("denies malformed action records before a tool sees them", () => {
		const runCommand = vi.fn(tools().runCommand);
		const gateway = createActionGateway({
			runId: "run-5",
			worktreeRoot: "/worktree",
			role: "implementer",
			trustTier: "raw",
			tools: tools({ runCommand }),
		});

		const receipt = gateway.execute({
			actionId: "action-5",
			kind: "process.run",
			command: "git",
			unexpectedAuthority: true,
		} as never);

		expect(receipt).toMatchObject({
			outcome: "denied",
			reason: "action contains an unknown field",
		});
		expect(runCommand).not.toHaveBeenCalled();
	});

	it("does not invoke action accessors while authorizing untrusted input", () => {
		const runCommand = vi.fn(tools().runCommand);
		const action = {
			actionId: "action-6",
			kind: "process.run",
			get command() {
				throw new Error("must not execute an accessor");
			},
		};
		const gateway = createActionGateway({
			runId: "run-6",
			worktreeRoot: "/worktree",
			role: "implementer",
			trustTier: "raw",
			tools: tools({ runCommand }),
		});

		const receipt = gateway.execute(action as never);

		expect(receipt.outcome).toBe("denied");
		expect(receipt.reason).toContain("accessor");
		expect(runCommand).not.toHaveBeenCalled();
	});

	it("denies malformed command argument arrays before either execution lane observes them", () => {
		const runCommand = vi.fn(tools().runCommand);
		const gateway = createActionGateway({
			runId: "run-args-array",
			worktreeRoot: "/worktree",
			role: "implementer",
			trustTier: "raw",
			tools: tools({ runCommand }),
		});
		const accessorArgs = ["status"];
		Object.defineProperty(accessorArgs, "0", {
			get: () => "status",
			enumerable: true,
		});
		expect(
			gateway.execute({
				actionId: "action-accessor-args",
				kind: "process.run",
				command: "git",
				args: accessorArgs,
			}),
		).toMatchObject({
			outcome: "denied",
			reason: "args must be a dense array of strings",
		});

		const outOfRangeArgs = ["status"];
		Object.defineProperty(outOfRangeArgs, "4294967295", {
			value: "unexpected",
			enumerable: true,
		});
		expect(
			gateway.execute({
				actionId: "action-out-of-range-args",
				kind: "process.run",
				command: "git",
				args: outOfRangeArgs,
			}),
		).toMatchObject({
			outcome: "denied",
			reason: "args must be a dense array of strings",
		});
		expect(runCommand).not.toHaveBeenCalled();
	});

	it.each(
		RESERVED_ACTION_FAMILIES.flatMap((kind) =>
			ACTION_GATEWAY_TEST_MODES.map((mode) => [kind, mode] as const),
		),
	)(
		"denies the unavailable %s action family in %s mode before execution dependencies or receipt telemetry",
		(kind, mode) => {
			const {
				gateway,
				rawRunCommand,
				rawWriteFile,
				ociRunCommand,
				ociWriteFile,
				onReceipt,
			} = reservedActionGateway(mode);

			const receipt = gateway.execute({
				actionId: `reserved-${kind}-${mode}`,
				kind,
			});

			expect(receipt).toMatchObject({
				actionId: `reserved-${kind}-${mode}`,
				kind,
				outcome: "denied",
				reason: expect.stringContaining("ACTION_FAMILY_UNAVAILABLE"),
			});
			expect(Object.isFrozen(receipt)).toBe(true);
			expect(rawRunCommand).not.toHaveBeenCalled();
			expect(rawWriteFile).not.toHaveBeenCalled();
			expect(ociRunCommand).not.toHaveBeenCalled();
			expect(ociWriteFile).not.toHaveBeenCalled();
			expect(onReceipt).not.toHaveBeenCalled();
		},
	);

	it.each(
		RESERVED_ACTION_FAMILIES.flatMap((kind) =>
			ACTION_GATEWAY_TEST_MODES.map((mode) => [kind, mode] as const),
		),
	)(
		"rejects extra fields on the reserved %s action family in %s mode",
		(kind, mode) => {
			const {
				gateway,
				rawRunCommand,
				rawWriteFile,
				ociRunCommand,
				ociWriteFile,
			} = reservedActionGateway(mode);

			const receipt = gateway.execute({
				actionId: `reserved-extra-${kind}-${mode}`,
				kind,
				command: "git",
				path: "output.txt",
				payload: { value: "must not become authority" },
				endpoint: "https://example.invalid",
				metadata: { value: "must not become authority" },
			} as never);

			expect(receipt).toMatchObject({
				actionId: `reserved-extra-${kind}-${mode}`,
				kind,
				outcome: "denied",
				reason: "action contains an unknown field",
			});
			expect(rawRunCommand).not.toHaveBeenCalled();
			expect(rawWriteFile).not.toHaveBeenCalled();
			expect(ociRunCommand).not.toHaveBeenCalled();
			expect(ociWriteFile).not.toHaveBeenCalled();
		},
	);

	it.each(
		RESERVED_ACTION_FAMILIES.flatMap((kind) =>
			ACTION_GATEWAY_TEST_MODES.map((mode) => [kind, mode] as const),
		),
	)(
		"rejects accessors on the reserved %s action family in %s mode without invoking them",
		(kind, mode) => {
			const {
				gateway,
				rawRunCommand,
				rawWriteFile,
				ociRunCommand,
				ociWriteFile,
			} = reservedActionGateway(mode);
			const action = {
				actionId: `reserved-accessor-${kind}-${mode}`,
				kind,
				get metadata() {
					throw new Error("reserved action accessor must not execute");
				},
			};

			const receipt = gateway.execute(action as never);

			expect(receipt).toMatchObject({
				actionId: `reserved-accessor-${kind}-${mode}`,
				kind,
				outcome: "denied",
				reason: "action cannot contain accessor fields",
			});
			expect(rawRunCommand).not.toHaveBeenCalled();
			expect(rawWriteFile).not.toHaveBeenCalled();
			expect(ociRunCommand).not.toHaveBeenCalled();
			expect(ociWriteFile).not.toHaveBeenCalled();
		},
	);

	it.each(
		RESERVED_ACTION_FAMILIES.flatMap((kind) =>
			ACTION_GATEWAY_TEST_MODES.map((mode) => [kind, mode] as const),
		),
	)("rejects inherited %s action fields in %s mode", (kind, mode) => {
		const {
			gateway,
			rawRunCommand,
			rawWriteFile,
			ociRunCommand,
			ociWriteFile,
		} = reservedActionGateway(mode);
		const action = Object.create({
			actionId: `reserved-prototype-${kind}-${mode}`,
			kind,
		});

		const receipt = gateway.execute(action as never);

		expect(receipt).toMatchObject({
			outcome: "denied",
			reason: "action must be a plain data object",
		});
		expect(rawRunCommand).not.toHaveBeenCalled();
		expect(rawWriteFile).not.toHaveBeenCalled();
		expect(ociRunCommand).not.toHaveBeenCalled();
		expect(ociWriteFile).not.toHaveBeenCalled();
	});
});
