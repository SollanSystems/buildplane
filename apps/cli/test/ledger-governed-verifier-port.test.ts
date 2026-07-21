import {
	canonicalActionRequestedV2Digest,
	type DurableActionRequestV2,
	type GovernedDispatchLineageV3,
} from "@buildplane/kernel";
import { describe, expect, it, vi } from "vitest";
import { GOVERNED_AUTHORITY_BROKER_REQUIRED } from "../src/governed-ledger-authority.js";
import {
	__testOnlyCreateNativeGovernedVerifierPort,
	createNativeGovernedVerifierPort,
	type NativeGovernedVerifierCommandRunner,
} from "../src/ledger-governed-verifier-port.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DISPATCH_EVENT_ID = "00000000-0000-7000-8000-000000000001";
const OTHER_DISPATCH_EVENT_ID = "00000000-0000-7000-8000-000000000005";
const ACTION_REQUEST_EVENT_ID = "00000000-0000-7000-8000-000000000002";
const CLAIM_EVENT_ID = "00000000-0000-7000-8000-000000000003";
const RESULT_EVENT_ID = "00000000-0000-7000-8000-000000000004";

function dispatch(
	overrides: Partial<GovernedDispatchLineageV3> = {},
): GovernedDispatchLineageV3 {
	return {
		schemaVersion: 3,
		runId: "00000000-0000-7000-8000-0000000000ff",
		workflowId: "workflow-verifier-port",
		workflowRevision: "revision-verifier-port",
		unitId: "unit-verifier-port",
		attempt: 1,
		provenanceRef: "admission:verifier-port",
		dispatchEnvelopeRef: DISPATCH_EVENT_ID,
		envelopeDigest: DIGEST_A,
		baseCommitSha: "1".repeat(40),
		repositoryBindingDigest: DIGEST_A,
		ledgerAuthorityRealmDigest: DIGEST_B,
		governedPacketDigest: DIGEST_A,
		executionRole: "reviewer",
		commitMode: "atomic",
		trustTier: "governed",
		capabilityBundleDigest: DIGEST_A,
		acceptanceContractDigest: DIGEST_B,
		policyDigest: DIGEST_A,
		contextManifestDigest: DIGEST_B,
		workerManifestDigest: DIGEST_A,
		sandboxProfileDigest: DIGEST_B,
		budget: {},
		idempotencyKey: "dispatch:verifier-port",
		authorityActor: "kernel:test",
		actionEvidenceVersion: "sealed_v3",
		issuedAt: "2026-07-18T00:00:00.000Z",
		expiresAt: "2099-07-18T01:00:00.000Z",
		...overrides,
	};
}

function durableRequest(governedDispatch = dispatch()): DurableActionRequestV2 {
	const actionRequest = {
		schemaVersion: 2 as const,
		runId: governedDispatch.runId,
		workflowId: governedDispatch.workflowId,
		unitId: governedDispatch.unitId,
		attempt: governedDispatch.attempt,
		provenanceRef: governedDispatch.provenanceRef,
		actionId: "governed:review:verifier-port",
		idempotencyKey: "dispatch:verifier-port:review",
		actionKind: "process" as const,
		canonicalInputDigest: DIGEST_A,
		canonicalInputRef: "cas:review-input:verifier-port",
		dispatchEnvelopeDigest: governedDispatch.envelopeDigest,
		capabilityBundleDigest: governedDispatch.capabilityBundleDigest,
		policyDigest: governedDispatch.policyDigest,
		contextManifestDigest: governedDispatch.contextManifestDigest,
		workerManifestDigest: governedDispatch.workerManifestDigest,
		sandboxProfileDigest: governedDispatch.sandboxProfileDigest,
		repositoryBindingDigest: governedDispatch.repositoryBindingDigest,
		ledgerAuthorityRealmDigest: governedDispatch.ledgerAuthorityRealmDigest,
		governedPacketDigest: governedDispatch.governedPacketDigest,
		authorityActor: governedDispatch.authorityActor,
		executionRole: "reviewer" as const,
		requestedAt: "2026-07-18T00:01:00.000Z",
	};
	return {
		actionRequest,
		actionRequestRef: ACTION_REQUEST_EVENT_ID,
		actionRequestDigest: canonicalActionRequestedV2Digest(actionRequest),
	};
}

function createPort(options?: {
	readonly runner?: NativeGovernedVerifierCommandRunner;
	readonly dispatchEventId?: string;
	readonly actionRequestEventId?: string;
}) {
	const resolveDispatchEventId = vi.fn(
		async (input: { readonly dispatch: GovernedDispatchLineageV3 }) =>
			options?.dispatchEventId ?? input.dispatch.dispatchEnvelopeRef,
	);
	const resolveActionRequestEventId = vi.fn(
		async () => options?.actionRequestEventId ?? ACTION_REQUEST_EVENT_ID,
	);
	const runner =
		options?.runner ??
		vi.fn((_: string, args: readonly string[]) => {
			if (args[2] === "claim") {
				return {
					status: 0,
					stdout: JSON.stringify({
						schema_version: 1,
						status: "granted",
						claim_event_ref: CLAIM_EVENT_ID,
						claim_event_digest: DIGEST_A,
						lease_id: "lease-verifier-port",
						lease_expires_at: "2099-07-18T01:01:00Z",
					}),
					stderr: "",
				};
			}
			return {
				status: 0,
				stdout: JSON.stringify({
					schema_version: 1,
					status: "recorded",
					result_event_ref: RESULT_EVENT_ID,
					result_event_digest: DIGEST_B,
					outcome: "succeeded",
				}),
				stderr: "",
			};
		});
	const port = __testOnlyCreateNativeGovernedVerifierPort({
		projectRoot: "/tmp/verifier-project",
		references: { resolveDispatchEventId, resolveActionRequestEventId },
		binary: "/tmp/package/buildplane-native",
		runner,
	});
	return {
		port,
		runner,
		resolveDispatchEventId,
		resolveActionRequestEventId,
	};
}

describe("native governed verifier lease port", () => {
	it("does not spawn a local native verifier when the authority broker is absent", () => {
		expect(() =>
			createNativeGovernedVerifierPort({
				projectRoot: "/tmp/verifier-project",
				references: {
					async resolveDispatchEventId() {
						return DISPATCH_EVENT_ID;
					},
					async resolveActionRequestEventId() {
						return ACTION_REQUEST_EVENT_ID;
					},
				},
				trustedBinary: {
					kind: "packaged-native-v1",
					path: "not-a-broker-and-must-not-be-spawned",
					digest: DIGEST_A,
				},
			}),
		).toThrow(GOVERNED_AUTHORITY_BROKER_REQUIRED);
	});

	it("resolves signed references before invoking only the fixed native claim/result argv", async () => {
		const harness = createPort();
		const governedDispatch = dispatch();
		const request = durableRequest(governedDispatch);

		const claim = await harness.port.claim({
			dispatch: governedDispatch,
			durableRequest: request,
			leaseDurationMs: 300_000,
		});
		expect(claim).toMatchObject({
			state: "granted",
			leaseId: "lease-verifier-port",
		});
		expect(harness.resolveDispatchEventId).toHaveBeenCalledBefore(
			harness.runner,
		);
		expect(harness.resolveActionRequestEventId).toHaveBeenCalledBefore(
			harness.runner,
		);
		expect(harness.runner).toHaveBeenNthCalledWith(
			1,
			"/tmp/package/buildplane-native",
			[
				"ledger",
				"governed-verifier-v1",
				"claim",
				"--run-id",
				governedDispatch.runId,
				"--project-root",
				"/tmp/verifier-project",
				"--dispatch-event-ref",
				DISPATCH_EVENT_ID,
				"--action-request-event-ref",
				ACTION_REQUEST_EVENT_ID,
				"--lease-duration-ms",
				"300000",
			],
			{ cwd: "/tmp/verifier-project" },
		);
		if (claim.state !== "granted") throw new Error("expected granted lease");

		const result = await harness.port.recordResult({
			dispatch: governedDispatch,
			claim,
			outcome: "succeeded",
			resultDigest: DIGEST_A,
			resultRef: "cas:review-result:verifier-port",
			evidenceDigest: DIGEST_B,
			evidenceRef: "cas:review-evidence:verifier-port",
		});
		expect(result).toMatchObject({
			state: "recorded",
			resultOutcome: "succeeded",
		});
		expect(harness.runner).toHaveBeenNthCalledWith(
			2,
			"/tmp/package/buildplane-native",
			[
				"ledger",
				"governed-verifier-v1",
				"result",
				"--run-id",
				governedDispatch.runId,
				"--lease-id",
				"lease-verifier-port",
				"--outcome",
				"succeeded",
				"--result-digest",
				DIGEST_A,
				"--result-ref",
				"cas:review-result:verifier-port",
				"--evidence-digest",
				DIGEST_B,
				"--evidence-ref",
				"cas:review-evidence:verifier-port",
			],
			{ cwd: "/tmp/verifier-project" },
		);
		for (const args of harness.runner.mock.calls.map((call) => call[1])) {
			expect(args).not.toContain("--workspace");
			expect(args).not.toContain("--command");
			expect(args).not.toContain("--args");
			expect(args).not.toContain("--cwd");
			expect(args).not.toContain("--action-id");
			expect(args).not.toContain("--idempotency-key");
			expect(args).not.toContain("--signing-key-id");
		}
	});

	it("fails before reference resolution when the caller tries to use a non-reviewer action", async () => {
		const harness = createPort();
		const governedDispatch = dispatch({ executionRole: "implementer" });
		const request = durableRequest(governedDispatch);

		await expect(
			harness.port.claim({
				dispatch: governedDispatch,
				durableRequest: request,
				leaseDurationMs: 300_000,
			}),
		).rejects.toThrow(/reviewer dispatch/i);
		expect(harness.resolveDispatchEventId).not.toHaveBeenCalled();
		expect(harness.runner).not.toHaveBeenCalled();
	});

	it("fails closed on malformed native output and does not synthesize a lease", async () => {
		const runner = vi.fn(() => ({
			status: 0,
			stdout: JSON.stringify({
				schema_version: 1,
				status: "granted",
				claim_event_ref: CLAIM_EVENT_ID,
				claim_event_digest: DIGEST_A,
				lease_id: "lease-verifier-port",
				lease_expires_at: "2099-07-18T01:01:00Z",
				forged: true,
			}),
			stderr: "",
		}));
		const harness = createPort({ runner });
		await expect(
			harness.port.claim({
				dispatch: dispatch(),
				durableRequest: durableRequest(),
				leaseDurationMs: 300_000,
			}),
		).rejects.toThrow(/unsupported field forged/i);
	});

	it("does not spawn the native result endpoint for malformed outcome/result pairs", async () => {
		const harness = createPort();
		await expect(
			harness.port.recordResult({
				dispatch: dispatch(),
				claim: {
					state: "granted",
					claimEventId: CLAIM_EVENT_ID,
					claimEventDigest: DIGEST_A,
					leaseId: "lease-verifier-port",
					leaseExpiresAt: "2099-07-18T01:01:00Z",
				},
				outcome: "unknown",
				resultDigest: DIGEST_A,
				resultRef: "cas:forged-result",
				evidenceDigest: DIGEST_B,
				evidenceRef: "cas:review-evidence:verifier-port",
			}),
		).rejects.toThrow(/unknown.*must not assert a result/i);
		expect(harness.runner).not.toHaveBeenCalled();
	});

	it("requires the exact granted lease minted by this port before recording a result", async () => {
		const harness = createPort();
		await expect(
			harness.port.recordResult({
				dispatch: dispatch(),
				claim: {
					state: "granted",
					claimEventId: CLAIM_EVENT_ID,
					claimEventDigest: DIGEST_A,
					leaseId: "lease-forged-outside-this-port",
					leaseExpiresAt: "2099-07-18T01:01:00Z",
				},
				outcome: "succeeded",
				resultDigest: DIGEST_A,
				resultRef: "cas:review-result:forged",
				evidenceDigest: DIGEST_B,
				evidenceRef: "cas:review-evidence:forged",
			}),
		).rejects.toThrow(/exact granted lease minted by this port instance/i);
		expect(harness.resolveDispatchEventId).not.toHaveBeenCalled();
		expect(harness.runner).not.toHaveBeenCalled();
	});

	it("does not allow a granted lease to be relabeled as another same-run reviewer dispatch", async () => {
		const harness = createPort();
		const firstDispatch = dispatch();
		const claim = await harness.port.claim({
			dispatch: firstDispatch,
			durableRequest: durableRequest(firstDispatch),
			leaseDurationMs: 300_000,
		});
		if (claim.state !== "granted") throw new Error("expected granted lease");

		await expect(
			harness.port.recordResult({
				dispatch: dispatch({
					dispatchEnvelopeRef: OTHER_DISPATCH_EVENT_ID,
					envelopeDigest: DIGEST_B,
				}),
				claim,
				outcome: "succeeded",
				resultDigest: DIGEST_A,
				resultRef: "cas:review-result:wrong-dispatch",
				evidenceDigest: DIGEST_B,
				evidenceRef: "cas:review-evidence:wrong-dispatch",
			}),
		).rejects.toThrow(/bound to a different signed reviewer dispatch/i);
		expect(harness.runner).toHaveBeenCalledTimes(1);
		expect(harness.resolveDispatchEventId).toHaveBeenCalledTimes(2);
	});

	it("rejects injected production authority fields before native binary resolution", () => {
		expect(() =>
			__testOnlyCreateNativeGovernedVerifierPort({
				projectRoot: "/tmp/verifier-project",
				references: {
					resolveDispatchEventId: async () => DISPATCH_EVENT_ID,
					resolveActionRequestEventId: async () => ACTION_REQUEST_EVENT_ID,
				},
				binary: "/tmp/package/buildplane-native",
				runner: () => ({ status: 0, stdout: "{}", stderr: "" }),
				workspace: "/tmp/forged-workspace",
			} as unknown as Parameters<
				typeof __testOnlyCreateNativeGovernedVerifierPort
			>[0]),
		).toThrow(/unsupported field workspace/i);
	});
});
