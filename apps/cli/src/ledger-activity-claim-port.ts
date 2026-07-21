import type {
	GovernedActivityClaimDispositionV1,
	GovernedActivityClaimPort,
	GovernedActivityResultDispositionV1,
	GovernedActivityResultOutcomeV1,
} from "@buildplane/adapters-tools";
import {
	canonicalActionRequestedV2Digest,
	canonicalSha256Digest,
	type DurableActionRequestV2,
	type GovernedDispatchLineageV3,
} from "@buildplane/kernel";
import type {
	ActivityClaimResultLine,
	ActivityResultResultLine,
	TapeEmitter,
} from "@buildplane/ledger-client";

const EVENT_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The CLI owns translation from opaque kernel references into native EventIds.
 * Both methods must independently resolve and verify the signed tape record;
 * returning a parsed caller string is not sufficient authority.
 */
export interface GovernedActivityClaimReferenceResolver {
	resolveDispatchEventId(input: {
		readonly dispatch: GovernedDispatchLineageV3;
	}): Promise<string>;
	resolveActionRequestEventId(input: {
		readonly dispatch: GovernedDispatchLineageV3;
		readonly durableRequest: DurableActionRequestV2;
	}): Promise<string>;
}

/**
 * A narrow adapter from the kernel-owned command activity seam to the native
 * signed-tape claim controls. It does not expose raw event-id authority to a
 * worker; a caller can only present immutable dispatch/request lineage.
 */
export function createGovernedActivityClaimPort(input: {
	readonly emitter: TapeEmitter;
	readonly references: GovernedActivityClaimReferenceResolver;
}): GovernedActivityClaimPort {
	if (!input || typeof input !== "object") {
		throw new TypeError(
			"createGovernedActivityClaimPort requires an emitter and a signed-reference resolver.",
		);
	}
	const emitter = captureEmitter(input.emitter);
	const references = captureReferences(input.references);

	return Object.freeze({
		async claim(claimInput: Parameters<GovernedActivityClaimPort["claim"]>[0]) {
			assertClaimInput(claimInput);
			const dispatchEventId = requireEventId(
				await references.resolveDispatchEventId({
					dispatch: claimInput.dispatch,
				}),
				"resolved signed dispatch event",
			);
			const actionRequestEventId = requireEventId(
				await references.resolveActionRequestEventId({
					dispatch: claimInput.dispatch,
					durableRequest: claimInput.durableRequest,
				}),
				"resolved signed action-request event",
			);
			return toClaimDisposition(
				await emitter.claimActivity({
					runId: claimInput.dispatch.runId,
					activityId: claimInput.activityId,
					idempotencyKey: claimInput.idempotencyKey,
					dispatchEventId,
					actionRequestEventId,
					leaseDurationMs: claimInput.leaseDurationMs,
				}),
				{
					activityId: claimInput.activityId,
					idempotencyKey: claimInput.idempotencyKey,
				},
			);
		},

		async recordResult(
			resultInput: Parameters<GovernedActivityClaimPort["recordResult"]>[0],
		) {
			assertResultInput(resultInput);
			return toResultDisposition(
				await emitter.recordActivityResult({
					runId: resultInput.dispatch.runId,
					activityId: resultInput.claim.activityId,
					idempotencyKey: resultInput.claim.idempotencyKey,
					leaseId: resultInput.claim.leaseId,
					outcome: resultInput.outcome,
					resultDigest: resultInput.resultDigest,
					resultRef: resultInput.resultRef,
					evidenceDigest: resultInput.evidenceDigest,
					evidenceRef: resultInput.evidenceRef,
				}),
			);
		},
	});
}

function captureEmitter(
	input: TapeEmitter,
): Pick<TapeEmitter, "claimActivity" | "recordActivityResult"> {
	if (
		!input ||
		typeof input.claimActivity !== "function" ||
		typeof input.recordActivityResult !== "function"
	) {
		throw new TypeError(
			"createGovernedActivityClaimPort requires a native tape emitter with activity-claim controls.",
		);
	}
	return Object.freeze({
		claimActivity: input.claimActivity.bind(input),
		recordActivityResult: input.recordActivityResult.bind(input),
	});
}

function captureReferences(
	input: GovernedActivityClaimReferenceResolver,
): GovernedActivityClaimReferenceResolver {
	if (
		!input ||
		typeof input.resolveDispatchEventId !== "function" ||
		typeof input.resolveActionRequestEventId !== "function"
	) {
		throw new TypeError(
			"createGovernedActivityClaimPort requires signed dispatch and action-request reference resolvers.",
		);
	}
	return Object.freeze({
		resolveDispatchEventId: input.resolveDispatchEventId.bind(input),
		resolveActionRequestEventId: input.resolveActionRequestEventId.bind(input),
	});
}

function assertClaimInput(
	input: Parameters<GovernedActivityClaimPort["claim"]>[0],
): void {
	assertSealedV3Dispatch(input.dispatch);
	assertDurableActionRequest(input.dispatch, input.durableRequest);
	if (
		input.activityId !== input.durableRequest.actionRequest.actionId ||
		input.idempotencyKey !== input.durableRequest.actionRequest.idempotencyKey
	) {
		throw new TypeError(
			"native activity claim must use the exact durable action id and idempotency key.",
		);
	}
	if (
		!Number.isSafeInteger(input.leaseDurationMs) ||
		input.leaseDurationMs < 1_000 ||
		input.leaseDurationMs > 900_000
	) {
		throw new RangeError(
			"native activity claim leaseDurationMs must be an integer from 1000 through 900000.",
		);
	}
}

function assertResultInput(
	input: Parameters<GovernedActivityClaimPort["recordResult"]>[0],
): void {
	assertSealedV3Dispatch(input.dispatch);
	assertDurableActionRequest(input.dispatch, input.durableRequest);
	if (
		input.claim.activityId !== input.durableRequest.actionRequest.actionId ||
		input.claim.idempotencyKey !==
			input.durableRequest.actionRequest.idempotencyKey
	) {
		throw new TypeError(
			"native activity result must bind the exact durable action id and idempotency key.",
		);
	}
	requireEventId(input.claim.claimEventId, "native activity claim event");
	canonicalSha256Digest(input.claim.claimEventDigest);
	requireNonEmpty(input.claim.leaseId, "native activity lease");
	canonicalSha256Digest(input.evidenceDigest);
	requireNonEmpty(input.evidenceRef, "native activity evidence reference");
	assertResultPair(input.outcome, input.resultDigest, input.resultRef);
}

function assertSealedV3Dispatch(dispatch: GovernedDispatchLineageV3): void {
	if (
		dispatch.schemaVersion !== 3 ||
		dispatch.trustTier !== "governed" ||
		dispatch.commitMode !== "atomic" ||
		dispatch.actionEvidenceVersion !== "sealed_v3"
	) {
		throw new TypeError(
			"native activity claims require a governed atomic sealed_v3 dispatch.",
		);
	}
}

function assertDurableActionRequest(
	dispatch: GovernedDispatchLineageV3,
	durableRequest: DurableActionRequestV2,
): void {
	const request = durableRequest.actionRequest;
	if (
		canonicalActionRequestedV2Digest(request) !==
			durableRequest.actionRequestDigest ||
		request.runId !== dispatch.runId ||
		request.workflowId !== dispatch.workflowId ||
		request.unitId !== dispatch.unitId ||
		request.attempt !== dispatch.attempt ||
		request.provenanceRef !== dispatch.provenanceRef ||
		request.dispatchEnvelopeDigest !== dispatch.envelopeDigest ||
		request.capabilityBundleDigest !== dispatch.capabilityBundleDigest ||
		request.contextManifestDigest !== dispatch.contextManifestDigest ||
		request.workerManifestDigest !== dispatch.workerManifestDigest ||
		request.sandboxProfileDigest !== dispatch.sandboxProfileDigest ||
		request.repositoryBindingDigest !== dispatch.repositoryBindingDigest ||
		request.ledgerAuthorityRealmDigest !==
			dispatch.ledgerAuthorityRealmDigest ||
		request.governedPacketDigest !== dispatch.governedPacketDigest ||
		request.executionRole !== dispatch.executionRole ||
		request.authorityActor !== dispatch.authorityActor
	) {
		throw new TypeError(
			"durable action request must exactly bind the sealed V3 dispatch before a native activity claim.",
		);
	}
	requireNonEmpty(
		durableRequest.actionRequestRef,
		"durable action request reference",
	);
}

function assertResultPair(
	outcome: GovernedActivityResultOutcomeV1,
	resultDigest: string | null,
	resultRef: string | null,
): void {
	if ((resultDigest === null) !== (resultRef === null)) {
		throw new TypeError(
			"native activity result digest and reference must be present together or both null.",
		);
	}
	if (resultDigest !== null) {
		canonicalSha256Digest(resultDigest);
		requireNonEmpty(resultRef, "native activity result reference");
	}
	if (outcome === "succeeded" && resultDigest === null) {
		throw new TypeError(
			"successful native activity result requires a result digest and reference.",
		);
	}
	if (outcome === "unknown" && resultDigest !== null) {
		throw new TypeError(
			"unknown native activity result must not assert a result digest or reference.",
		);
	}
}

function toClaimDisposition(
	line: ActivityClaimResultLine,
	identity: { readonly activityId: string; readonly idempotencyKey: string },
): GovernedActivityClaimDispositionV1 {
	switch (line.outcome) {
		case "granted":
			return {
				state: "granted",
				activityId: identity.activityId,
				idempotencyKey: identity.idempotencyKey,
				claimEventId: requireEventId(line.claim_event_id, "native claim event"),
				claimEventDigest: canonicalSha256Digest(line.claim_event_digest),
				leaseId: requireNonEmpty(line.lease_id, "native claim lease"),
				leaseExpiresAt: requireTimestamp(
					line.lease_expires_at,
					"native claim lease expiry",
				),
			};
		case "pending":
			return {
				state: "pending",
				claimEventId: requireEventId(line.claim_event_id, "native claim event"),
				leaseExpiresAt: requireTimestamp(
					line.lease_expires_at,
					"native claim lease expiry",
				),
			};
		case "recorded":
			return {
				state: "recorded",
				claimEventId: requireEventId(line.claim_event_id, "native claim event"),
				resultEventId: requireEventId(
					line.result_event_id,
					"native activity result event",
				),
				resultEventDigest: canonicalSha256Digest(line.result_event_digest),
				resultOutcome: requireActivityOutcome(line.result_outcome),
			};
		case "lease_expired":
			return {
				state: "lease_expired",
				claimEventId: requireEventId(line.claim_event_id, "native claim event"),
				leaseExpiresAt: requireTimestamp(
					line.lease_expires_at,
					"native claim lease expiry",
				),
			};
		case "rejected":
			return {
				state: "rejected",
				code: requireNonEmpty(line.code, "native claim rejection code"),
				message: requireNonEmpty(
					line.message,
					"native claim rejection message",
				),
			};
	}
}

function toResultDisposition(
	line: ActivityResultResultLine,
): GovernedActivityResultDispositionV1 {
	switch (line.outcome) {
		case "recorded":
			return {
				state: "recorded",
				resultEventId: requireEventId(
					line.result_event_id,
					"native activity result event",
				),
				resultEventDigest: canonicalSha256Digest(line.result_event_digest),
				resultOutcome: requireActivityOutcome(line.result_outcome),
			};
		case "lease_expired":
			return {
				state: "lease_expired",
				claimEventId: requireEventId(line.claim_event_id, "native claim event"),
				leaseExpiresAt: requireTimestamp(
					line.lease_expires_at,
					"native claim lease expiry",
				),
			};
		case "rejected":
			return {
				state: "rejected",
				code: requireNonEmpty(line.code, "native result rejection code"),
				message: requireNonEmpty(
					line.message,
					"native result rejection message",
				),
			};
	}
}

function requireActivityOutcome(
	value: string,
): GovernedActivityResultOutcomeV1 {
	if (value === "succeeded" || value === "failed" || value === "unknown") {
		return value;
	}
	throw new TypeError("native activity result outcome is invalid.");
}

function requireEventId(value: unknown, label: string): string {
	if (typeof value !== "string" || !EVENT_ID.test(value)) {
		throw new TypeError(`${label} must be a canonical native event UUID.`);
	}
	return value.toLowerCase();
}

function requireNonEmpty(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${label} must be a non-empty string.`);
	}
	return value;
}

function requireTimestamp(value: unknown, label: string): string {
	const timestamp = requireNonEmpty(value, label);
	if (!Number.isFinite(Date.parse(timestamp))) {
		throw new TypeError(`${label} must be a parseable RFC3339 timestamp.`);
	}
	return timestamp;
}
