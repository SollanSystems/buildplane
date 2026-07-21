import type { GovernedActivityClaimPort } from "@buildplane/adapters-tools";
import {
	canonicalActionRequestedV2Digest,
	type DurableActionRequestV2,
	type GovernedDispatchLineageV3,
} from "@buildplane/kernel";
import type { TapeEmitter } from "@buildplane/ledger-client";
import { describe, expect, it, vi } from "vitest";
import { createGovernedActivityClaimPort } from "../src/ledger-activity-claim-port.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DISPATCH_EVENT_ID = "00000000-0000-7000-8000-000000000001";
const ACTION_REQUEST_EVENT_ID = "00000000-0000-7000-8000-000000000002";
const CLAIM_EVENT_ID = "00000000-0000-7000-8000-000000000003";
const RESULT_EVENT_ID = "00000000-0000-7000-8000-000000000004";

function dispatch(
	overrides: Partial<GovernedDispatchLineageV3> = {},
): GovernedDispatchLineageV3 {
	return {
		schemaVersion: 3,
		runId: "run-activity-port",
		workflowId: "workflow-activity-port",
		workflowRevision: "revision-activity-port",
		unitId: "unit-activity-port",
		attempt: 1,
		provenanceRef: "admission:activity-port",
		dispatchEnvelopeRef: "opaque:dispatch",
		envelopeDigest: DIGEST_A,
		baseCommitSha: "1".repeat(40),
		repositoryBindingDigest: DIGEST_A,
		ledgerAuthorityRealmDigest: DIGEST_B,
		governedPacketDigest: DIGEST_A,
		executionRole: "implementer",
		commitMode: "atomic",
		trustTier: "governed",
		capabilityBundleDigest: DIGEST_A,
		acceptanceContractDigest: DIGEST_B,
		policyDigest: DIGEST_A,
		contextManifestDigest: DIGEST_B,
		workerManifestDigest: DIGEST_A,
		sandboxProfileDigest: DIGEST_B,
		budget: {},
		idempotencyKey: "dispatch:activity-port",
		authorityActor: "kernel:test",
		actionEvidenceVersion: "sealed_v3",
		issuedAt: "2026-07-18T00:00:00.000Z",
		expiresAt: "2026-07-18T01:00:00.000Z",
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
		actionId: "governed:command:activity-port",
		idempotencyKey: "dispatch:activity-port:command",
		actionKind: "process" as const,
		canonicalInputDigest: DIGEST_A,
		canonicalInputRef: "cas:input:activity-port",
		dispatchEnvelopeDigest: governedDispatch.envelopeDigest,
		repositoryBindingDigest: governedDispatch.repositoryBindingDigest,
		ledgerAuthorityRealmDigest: governedDispatch.ledgerAuthorityRealmDigest,
		governedPacketDigest: governedDispatch.governedPacketDigest,
		capabilityBundleDigest: governedDispatch.capabilityBundleDigest,
		policyDigest: governedDispatch.policyDigest,
		contextManifestDigest: governedDispatch.contextManifestDigest,
		workerManifestDigest: governedDispatch.workerManifestDigest,
		sandboxProfileDigest: governedDispatch.sandboxProfileDigest,
		authorityActor: governedDispatch.authorityActor,
		executionRole: governedDispatch.executionRole,
		requestedAt: "2026-07-18T00:01:00.000Z",
	};
	return {
		actionRequest,
		actionRequestRef: "opaque:action-request",
		actionRequestDigest: canonicalActionRequestedV2Digest(actionRequest),
	};
}

function createFakeEmitter() {
	const claimActivity = vi.fn(async () => ({
		control: "claim_activity_v1_result" as const,
		request_id: "request-claim",
		outcome: "granted" as const,
		claim_event_id: CLAIM_EVENT_ID,
		claim_event_digest: DIGEST_A,
		lease_id: "lease-activity-port",
		lease_expires_at: "2026-07-18T00:11:00.000Z",
	}));
	const recordActivityResult = vi.fn(async () => ({
		control: "record_activity_result_v1_result" as const,
		request_id: "request-result",
		outcome: "recorded" as const,
		result_event_id: RESULT_EVENT_ID,
		result_event_digest: DIGEST_B,
		result_outcome: "succeeded" as const,
	}));
	return {
		emitter: { claimActivity, recordActivityResult } as unknown as TapeEmitter,
		claimActivity,
		recordActivityResult,
	};
}

describe("governed activity claim tape port", () => {
	it("resolves opaque lineage in the host and records a claimed action result", async () => {
		const fake = createFakeEmitter();
		const resolveDispatchEventId = vi.fn(async () => DISPATCH_EVENT_ID);
		const resolveActionRequestEventId = vi.fn(
			async () => ACTION_REQUEST_EVENT_ID,
		);
		const port = createGovernedActivityClaimPort({
			emitter: fake.emitter,
			references: { resolveDispatchEventId, resolveActionRequestEventId },
		});
		const governedDispatch = dispatch();
		const request = durableRequest(governedDispatch);

		const claim = await port.claim({
			dispatch: governedDispatch,
			durableRequest: request,
			activityId: request.actionRequest.actionId,
			idempotencyKey: request.actionRequest.idempotencyKey,
			leaseDurationMs: 300_000,
		});
		expect(claim).toMatchObject({
			state: "granted",
			leaseId: "lease-activity-port",
		});
		expect(fake.claimActivity).toHaveBeenCalledWith({
			runId: governedDispatch.runId,
			activityId: request.actionRequest.actionId,
			idempotencyKey: request.actionRequest.idempotencyKey,
			dispatchEventId: DISPATCH_EVENT_ID,
			actionRequestEventId: ACTION_REQUEST_EVENT_ID,
			leaseDurationMs: 300_000,
		});
		if (claim.state !== "granted") throw new Error("expected granted claim");

		const result = await port.recordResult({
			dispatch: governedDispatch,
			durableRequest: request,
			claim,
			outcome: "succeeded",
			resultDigest: DIGEST_B,
			resultRef: "cas:result:activity-port",
			evidenceDigest: DIGEST_A,
			evidenceRef: "cas:evidence:activity-port",
		});
		expect(result).toMatchObject({
			state: "recorded",
			resultOutcome: "succeeded",
		});
		expect(fake.recordActivityResult).toHaveBeenCalledWith({
			runId: governedDispatch.runId,
			activityId: request.actionRequest.actionId,
			idempotencyKey: request.actionRequest.idempotencyKey,
			leaseId: "lease-activity-port",
			outcome: "succeeded",
			resultDigest: DIGEST_B,
			resultRef: "cas:result:activity-port",
			evidenceDigest: DIGEST_A,
			evidenceRef: "cas:evidence:activity-port",
		});
	});

	it("does not resolve opaque references or call native controls for legacy sealed-v2 dispatches", async () => {
		const fake = createFakeEmitter();
		const resolveDispatchEventId = vi.fn(async () => DISPATCH_EVENT_ID);
		const resolveActionRequestEventId = vi.fn(
			async () => ACTION_REQUEST_EVENT_ID,
		);
		const port = createGovernedActivityClaimPort({
			emitter: fake.emitter,
			references: { resolveDispatchEventId, resolveActionRequestEventId },
		});
		const governedDispatch = dispatch({ actionEvidenceVersion: "sealed-v2" });
		const request = durableRequest(governedDispatch);

		await expect(
			port.claim({
				dispatch: governedDispatch,
				durableRequest: request,
				activityId: request.actionRequest.actionId,
				idempotencyKey: request.actionRequest.idempotencyKey,
				leaseDurationMs: 300_000,
			}),
		).rejects.toThrow(/sealed_v3/i);
		expect(resolveDispatchEventId).not.toHaveBeenCalled();
		expect(resolveActionRequestEventId).not.toHaveBeenCalled();
		expect(fake.claimActivity).not.toHaveBeenCalled();
	});

	it("rejects a resolver that returns an opaque non-native event reference", async () => {
		const fake = createFakeEmitter();
		const port: GovernedActivityClaimPort = createGovernedActivityClaimPort({
			emitter: fake.emitter,
			references: {
				resolveDispatchEventId: async () => "event://not-a-native-id",
				resolveActionRequestEventId: async () => ACTION_REQUEST_EVENT_ID,
			},
		});
		const governedDispatch = dispatch();
		const request = durableRequest(governedDispatch);

		await expect(
			port.claim({
				dispatch: governedDispatch,
				durableRequest: request,
				activityId: request.actionRequest.actionId,
				idempotencyKey: request.actionRequest.idempotencyKey,
				leaseDurationMs: 300_000,
			}),
		).rejects.toThrow(/native event UUID/i);
		expect(fake.claimActivity).not.toHaveBeenCalled();
	});
});
