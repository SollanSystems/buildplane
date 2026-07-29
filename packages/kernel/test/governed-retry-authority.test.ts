import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	canonicalGovernedV3RetryRequestV1Digest,
	canonicalUntrustedAttemptContextRecordedV1Digest,
	type GovernedV3RetryRequestV1,
	inspectUntrustedGovernedV3RetryContextResolution,
	type UntrustedAttemptContextRecordedV1,
} from "../src/governed-retry-authority.js";
import { canonicalUntrustedAttemptContextRecordedV1Digest as publicAttemptContextDigest } from "../src/index.ts";

const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;
const SHA_C = `sha256:${"c".repeat(64)}`;
const SHA_D = `sha256:${"d".repeat(64)}`;
const SHA_E = `sha256:${"e".repeat(64)}`;
const SHA_F = `sha256:${"f".repeat(64)}`;

function retryRequest(
	overrides: Partial<GovernedV3RetryRequestV1> = {},
): GovernedV3RetryRequestV1 {
	return {
		schemaVersion: 1,
		runId: "01919000-0000-7000-8000-0000000000ce",
		workflowId: "workflow-v3",
		workflowRevision: "revision-v3",
		unitId: "candidate-unit",
		priorAttempt: 1,
		nextAttempt: 2,
		priorDispatchEnvelopeDigest: SHA_A,
		priorDispatchIdempotencyKey: "dispatch-v3:1",
		governedPacketDigest: SHA_B,
		predecessorActions: [
			{
				actionId: "prior-worker-action",
				actionReceiptRef: "event://action/prior-worker",
				actionReceiptDigest: SHA_C,
			},
		],
		feedbackContext: ["fix the failed validation"],
		...overrides,
	};
}

function attemptContext(
	overrides: Partial<UntrustedAttemptContextRecordedV1> = {},
): UntrustedAttemptContextRecordedV1 {
	const base = {
		runId: "01919000-0000-7000-8000-0000000000ce",
		workflowId: "workflow-v3",
		workflowRevision: "revision-v3",
		unitId: "candidate-unit",
		priorAttempt: 1,
		nextAttempt: 2,
		priorDispatchEnvelopeDigest: SHA_A,
		priorTerminalEventRef: "event://workflow-terminal/1",
		priorTerminalEventDigest: SHA_D,
		priorActionReceiptRef: "event://action/prior-worker",
		priorActionReceiptDigest: SHA_C,
		feedbackRef: "cas://retry-feedback/1",
		feedbackDigest: SHA_E,
		nextDispatchEnvelopeDigest: SHA_F,
		nextDispatchIdempotencyKey: "dispatch-v3:2",
		retryActionNamespace: "retry-action:workflow-v3:candidate-unit:2",
		idempotencyKey: "retry-context:workflow-v3:candidate-unit:1:2",
		recordedAt: "2026-07-20T20:00:00.000Z",
		...overrides,
	};
	return {
		...base,
		attemptContextDigest:
			canonicalUntrustedAttemptContextRecordedV1Digest(base),
	};
}

function untrustedResolution(
	request: GovernedV3RetryRequestV1,
	context = attemptContext(),
) {
	return {
		schemaVersion: 1,
		retryRequestDigest: canonicalGovernedV3RetryRequestV1Digest(request),
		predecessorAction: request.predecessorActions[0],
		untrustedAttemptContext: context,
	};
}

describe("governed V3 retry structural context", () => {
	it("exports retry-context canonicalization through the kernel public surface", () => {
		const context = attemptContext();
		expect(publicAttemptContextDigest(context)).toBe(
			context.attemptContextDigest,
		);
	});

	it("reports a canonically bound context as structurally consistent but untrusted", () => {
		const request = retryRequest();
		const result = inspectUntrustedGovernedV3RetryContextResolution(
			request,
			untrustedResolution(request),
		);

		expect(result).toMatchObject({
			status: "structurally-consistent-untrusted",
			nativeAttestation: "required",
			untrustedAttemptContext: {
				nextAttempt: 2,
				retryActionNamespace: "retry-action:workflow-v3:candidate-unit:2",
			},
		});
	});

	it("parses only descriptor snapshots and never invokes untrusted proxy get traps", () => {
		const request = retryRequest();
		const resolution = untrustedResolution(request);
		let reads = 0;
		const readTrap = <T extends object>(value: T): T =>
			new Proxy(value, {
				get(target, key, receiver) {
					reads += 1;
					return Reflect.get(target, key, receiver);
				},
			});
		const hostileResolution = readTrap({
			...resolution,
			predecessorAction: readTrap(resolution.predecessorAction),
			untrustedAttemptContext: readTrap(resolution.untrustedAttemptContext),
		});

		expect(
			inspectUntrustedGovernedV3RetryContextResolution(
				request,
				hostileResolution,
			),
		).toMatchObject({
			status: "structurally-consistent-untrusted",
			nativeAttestation: "required",
		});
		expect(reads).toBe(0);
	});

	it("preserves microsecond timestamp bytes in the native-shaped digest", () => {
		const context = attemptContext({
			recordedAt: "2026-07-20T20:00:00.123456Z",
		});
		const expectedMaterial = {
			run_id: context.runId,
			workflow_id: context.workflowId,
			workflow_revision: context.workflowRevision,
			unit_id: context.unitId,
			prior_attempt: context.priorAttempt,
			next_attempt: context.nextAttempt,
			prior_dispatch_envelope_digest: context.priorDispatchEnvelopeDigest,
			prior_terminal_event_ref: context.priorTerminalEventRef,
			prior_terminal_event_digest: context.priorTerminalEventDigest,
			prior_action_receipt_ref: context.priorActionReceiptRef,
			prior_action_receipt_digest: context.priorActionReceiptDigest,
			feedback_ref: context.feedbackRef,
			feedback_digest: context.feedbackDigest,
			next_dispatch_envelope_digest: context.nextDispatchEnvelopeDigest,
			next_dispatch_idempotency_key: context.nextDispatchIdempotencyKey,
			retry_action_namespace: context.retryActionNamespace,
			idempotency_key: context.idempotencyKey,
			recorded_at: "2026-07-20T20:00:00.123456Z",
		};
		const expectedDigest = `sha256:${createHash("sha256")
			.update("buildplane.attempt-context-recorded.v1\0", "utf8")
			.update(JSON.stringify(expectedMaterial), "utf8")
			.digest("hex")}`;

		expect(context.attemptContextDigest).toBe(expectedDigest);
		const request = retryRequest();
		const result = inspectUntrustedGovernedV3RetryContextResolution(
			request,
			untrustedResolution(request, context),
		);
		expect(result).toMatchObject({
			status: "structurally-consistent-untrusted",
			untrustedAttemptContext: {
				recordedAt: "2026-07-20T20:00:00.123456Z",
			},
		});
	});

	it("accepts Chrono-valid leap-second timestamps without normalizing digest bytes", () => {
		const recordedAt = "2016-12-31T23:59:60.123456Z";
		const context = attemptContext({ recordedAt });
		const request = retryRequest();

		expect(
			inspectUntrustedGovernedV3RetryContextResolution(
				request,
				untrustedResolution(request, context),
			),
		).toMatchObject({
			status: "structurally-consistent-untrusted",
			untrustedAttemptContext: { recordedAt },
		});
	});

	it("matches Chrono acceptance for lowercase t and year zero", () => {
		const recordedAt = "0000-02-29t12:34:56Z";
		const context = attemptContext({ recordedAt });
		const request = retryRequest();

		expect(
			inspectUntrustedGovernedV3RetryContextResolution(
				request,
				untrustedResolution(request, context),
			),
		).toMatchObject({
			status: "structurally-consistent-untrusted",
			untrustedAttemptContext: { recordedAt },
		});
	});

	it("accepts the highest native-valid u32 retry sequence", () => {
		const request = retryRequest({
			priorAttempt: 4_294_967_294,
			nextAttempt: 4_294_967_295,
		});
		const context = attemptContext({
			priorAttempt: request.priorAttempt,
			nextAttempt: request.nextAttempt,
		});

		expect(
			inspectUntrustedGovernedV3RetryContextResolution(
				request,
				untrustedResolution(request, context),
			),
		).toMatchObject({ status: "structurally-consistent-untrusted" });
	});

	it("rejects an attempt outside native u32 bounds", () => {
		const request = retryRequest({
			priorAttempt: 4_294_967_295,
			nextAttempt: 4_294_967_296,
		});
		const context = attemptContext({
			priorAttempt: request.priorAttempt,
			nextAttempt: request.nextAttempt,
		});

		expect(
			inspectUntrustedGovernedV3RetryContextResolution(
				request,
				untrustedResolution(request, context),
			),
		).toMatchObject({ status: "malformed" });
	});

	it("rejects a canonically valid context that rebinds the predecessor action", () => {
		const request = retryRequest();
		const result = inspectUntrustedGovernedV3RetryContextResolution(
			request,
			untrustedResolution(
				request,
				attemptContext({
					priorActionReceiptRef: "event://action/substituted",
				}),
			),
		);

		expect(result).toMatchObject({ status: "mismatch" });
	});

	it("rejects a context whose canonical digest was mutated after resolution", () => {
		const request = retryRequest();
		const context = attemptContext();
		const result = inspectUntrustedGovernedV3RetryContextResolution(
			request,
			untrustedResolution(request, {
				...context,
				attemptContextDigest: SHA_A,
			}),
		);

		expect(result).toMatchObject({ status: "malformed" });
	});

	it("requires the structural response to identify the exact predecessor action", () => {
		const request = retryRequest();
		const { predecessorAction: _predecessorAction, ...incompleteResolution } =
			untrustedResolution(request);
		const result = inspectUntrustedGovernedV3RetryContextResolution(
			request,
			incompleteResolution,
		);

		expect(result).toMatchObject({ status: "malformed" });
	});
});
