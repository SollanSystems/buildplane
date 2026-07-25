import type {
	AttemptContextDeclaredV1,
	ContextManifestDeclaredV1,
	DispatchEnvelopeBodyV2,
	DispatchEnvelopeV4,
	DispatchEnvelopeV5,
	SandboxProfileDeclaredV1,
	WorkerManifestDeclaredV1,
} from "@buildplane/kernel";
import {
	assertDispatchEnvelopeV5ManifestDeclarationsV1,
	canonicalDispatchEnvelopeV3Digest,
	canonicalDispatchEnvelopeV4Digest,
	canonicalDispatchEnvelopeV5Digest,
	createAttemptContextDeclaredV1,
	createContextManifestDeclaredV1,
	createSandboxProfileDeclaredV1,
	createWorkerManifestDeclaredV1,
	parseAttemptContextDeclaredV1,
	parseContextManifestDeclaredV1,
	parseDispatchEnvelopeV5,
} from "@buildplane/kernel";
import { describe, expect, it } from "vitest";

const CONTEXT_EVENT_REF = "01919000-0000-7000-8000-0000000000c1";
const WORKER_EVENT_REF = "01919000-0000-7000-8000-0000000000c2";
const SANDBOX_EVENT_REF = "01919000-0000-7000-8000-0000000000c3";
const ATTEMPT_EVENT_REF = "01919000-0000-7000-8000-0000000000c4";
const GRAPH_EVENT_REF = "01919000-0000-7000-8000-0000000000c5";
const BASE_SHA = "a".repeat(40);

function digest(seed: string): string {
	return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

function sandboxDeclaration(
	overrides: Record<string, unknown> = {},
	attempt = 1,
): SandboxProfileDeclaredV1 {
	return createSandboxProfileDeclaredV1({
		runId: "run-42",
		workflowId: "workflow-42",
		workflowRevision: "workflow-revision-7",
		unitId: "unit-7",
		attempt,
		provenanceRef: "ledger://run/42",
		sandboxProfile: {
			runtime: "rootless_oci",
			rootless: true,
			imageDigest: digest("a"),
			readOnlyRootfs: true,
			writableOverlayDigest: digest("b"),
			mountManifestDigest: digest("c"),
			environmentManifestDigest: digest("d"),
			networkPolicyDigest: digest("e"),
			resourcePolicyDigest: digest("f"),
			secretHandleManifestDigest: digest("0"),
		},
		idempotencyKey: `sandbox:workflow-42:unit-7:${attempt}`,
		declaredAt: "2026-07-25T12:00:00Z",
		...overrides,
	});
}

function workerDeclaration(
	overrides: Record<string, unknown> = {},
	attempt = 1,
): WorkerManifestDeclaredV1 {
	return createWorkerManifestDeclaredV1({
		runId: "run-42",
		workflowId: "workflow-42",
		workflowRevision: "workflow-revision-7",
		unitId: "unit-7",
		attempt,
		provenanceRef: "ledger://run/42",
		workerManifest: {
			provider: "open_ai",
			model: "gpt-5",
			harness: "open_ai_api_sdk",
			imageDigest: digest("a"),
			toolManifestDigest: digest("1"),
			skillManifestDigest: digest("2"),
			capabilityBundleDigest: digest("3"),
			executionRole: "implementer",
		},
		idempotencyKey: `worker:workflow-42:unit-7:${attempt}`,
		declaredAt: "2026-07-25T12:00:00Z",
		...overrides,
	});
}

function contextDeclaration(
	overrides: Record<string, unknown> = {},
	attempt = 1,
): ContextManifestDeclaredV1 {
	return createContextManifestDeclaredV1({
		runId: "run-42",
		workflowId: "workflow-42",
		workflowRevision: "workflow-revision-7",
		unitId: "unit-7",
		attempt,
		provenanceRef: "ledger://run/42",
		contextManifest: {
			entries: [
				{
					kind: "plan",
					reference: "cas://plans/42",
					digest: digest("4"),
					provenanceRef: "ledger://plan/42",
					trust: "verified",
					taint: "clean",
				},
			],
		},
		idempotencyKey: `context:workflow-42:unit-7:${attempt}`,
		declaredAt: "2026-07-25T12:00:00Z",
		...overrides,
	});
}

function attemptDeclaration(
	overrides: Record<string, unknown> = {},
): AttemptContextDeclaredV1 {
	return createAttemptContextDeclaredV1({
		runId: "run-42",
		workflowId: "workflow-42",
		workflowRevision: "workflow-revision-7",
		unitId: "unit-7",
		attempt: 2,
		provenanceRef: "ledger://run/42",
		attemptContext: {
			attempt: 2,
			retryFeedback: [
				{
					feedbackRef: "cas://retry-feedback/42",
					feedbackDigest: digest("5"),
				},
			],
			priorCandidates: [
				{
					candidateRef: "refs/buildplane/candidates/workflow-42/unit-7/1",
					candidateDigest: digest("6"),
				},
			],
		},
		idempotencyKey: "attempt-context:workflow-42:unit-7:2",
		declaredAt: "2026-07-25T12:01:00Z",
		...overrides,
	});
}

function dispatchV4(
	context: ContextManifestDeclaredV1,
	worker: WorkerManifestDeclaredV1,
	sandbox: SandboxProfileDeclaredV1,
	attempt = 1,
): DispatchEnvelopeV4 {
	const body: DispatchEnvelopeBodyV2 = {
		workflowId: "workflow-42",
		workflowRevision: "workflow-revision-7",
		unitId: "unit-7",
		attempt,
		executionRole: "implementer",
		commitMode: "atomic",
		provenanceRef: "ledger://run/42",
		baseCommitSha: BASE_SHA,
		capabilityBundleDigest: worker.workerManifest.capabilityBundleDigest,
		acceptanceContractDigest: digest("7"),
		contextManifestDigest: context.contextManifestDigest,
		workerManifestDigest: worker.workerManifestDigest,
		sandboxProfileDigest: sandbox.sandboxProfileDigest,
		budget: { maxTokens: 100_000, maxComputeTimeMs: 60_000 },
		trustTier: "governed",
		idempotencyKey: `dispatch:workflow-42:unit-7:${attempt}`,
		issuedAt: "2026-07-25T12:00:00Z",
		expiresAt: "2026-07-25T12:15:00Z",
	};
	const dispatchV3Draft = {
		schemaVersion: 3 as const,
		body,
		actionEvidenceVersion: "sealed_v3" as const,
		repositoryBindingDigest: digest("8"),
		ledgerAuthorityRealmDigest: digest("9"),
		governedPacketDigest: digest("a"),
	};
	const dispatchV3 = {
		...dispatchV3Draft,
		envelopeDigest: canonicalDispatchEnvelopeV3Digest(dispatchV3Draft),
	};
	const draft = {
		schemaVersion: 4 as const,
		dispatchV3,
		workflowGraphDigest: digest("b"),
		workflowGraphDeclarationEventRef: GRAPH_EVENT_REF,
	};
	return {
		...draft,
		envelopeDigest: canonicalDispatchEnvelopeV4Digest(draft),
	};
}

function dispatchV5(
	context: ContextManifestDeclaredV1,
	worker: WorkerManifestDeclaredV1,
	sandbox: SandboxProfileDeclaredV1,
	attemptContext?: AttemptContextDeclaredV1,
): DispatchEnvelopeV5 {
	const draft = {
		dispatchV4: dispatchV4(context, worker, sandbox, attemptContext ? 2 : 1),
		contextManifestDeclarationEventRef: CONTEXT_EVENT_REF,
		contextManifestDigest: context.contextManifestDigest,
		workerManifestDeclarationEventRef: WORKER_EVENT_REF,
		workerManifestDigest: worker.workerManifestDigest,
		sandboxProfileDeclarationEventRef: SANDBOX_EVENT_REF,
		sandboxProfileDigest: sandbox.sandboxProfileDigest,
		...(attemptContext === undefined
			? {}
			: {
					attemptContextDeclarationEventRef: ATTEMPT_EVENT_REF,
					attemptContextDigest: attemptContext.attemptContextDigest,
				}),
	};
	return {
		...draft,
		envelopeDigest: canonicalDispatchEnvelopeV5Digest(draft),
	};
}

describe("trust-spine V5 manifest-bound dispatch", () => {
	it("creates canonical kernel declarations and binds their exact native digests into V5", () => {
		const sandbox = sandboxDeclaration();
		const worker = workerDeclaration();
		const context = contextDeclaration();
		const dispatch = parseDispatchEnvelopeV5(
			dispatchV5(context, worker, sandbox),
		);

		expect(dispatch.envelopeDigest).toBe(
			canonicalDispatchEnvelopeV5Digest(dispatch),
		);
		expect(dispatch.dispatchV4.dispatchV3.body.contextManifestDigest).toBe(
			context.contextManifestDigest,
		);
		expect(() =>
			assertDispatchEnvelopeV5ManifestDeclarationsV1(dispatch, {
				context,
				worker,
				sandbox,
			}),
		).not.toThrow();
	});

	it("rejects unknown declaration fields and content tampering after declaration", () => {
		const context = contextDeclaration();
		expect(() =>
			parseContextManifestDeclaredV1({ ...context, unexpected: true }),
		).toThrow('contextManifestDeclaredV1 has unknown field "unexpected"');
		expect(() =>
			parseContextManifestDeclaredV1({
				...context,
				contextManifest: {
					entries: [
						{
							...context.contextManifest.entries[0],
							reference: "cas://plans/changed",
						},
					],
				},
			}),
		).toThrow(/contextManifestDigest must equal the canonical/i);
	});

	it("rejects V5 values whose nested V4 authority does not bind the declared manifest digest", () => {
		const sandbox = sandboxDeclaration();
		const worker = workerDeclaration();
		const context = contextDeclaration();
		const valid = dispatchV5(context, worker, sandbox);

		expect(() =>
			parseDispatchEnvelopeV5({
				...valid,
				contextManifestDigest: digest("e"),
			}),
		).toThrow(/contextManifestDigest must equal dispatchV4/i);
		expect(() =>
			parseDispatchEnvelopeV5({
				...valid,
				workerManifestDeclarationEventRef: CONTEXT_EVENT_REF,
			}),
		).toThrow(/pairwise distinct/i);

		const reviewer = workerDeclaration({
			workerManifest: { ...worker.workerManifest, executionRole: "reviewer" },
		});
		const roleMismatched = parseDispatchEnvelopeV5(
			dispatchV5(context, reviewer, sandbox),
		);
		expect(() =>
			assertDispatchEnvelopeV5ManifestDeclarationsV1(roleMismatched, {
				context,
				worker: reviewer,
				sandbox,
			}),
		).toThrow(/executionRole/i);
	});

	it("requires retry context exactly for retry attempts and binds its exact retry content", () => {
		const sandbox = sandboxDeclaration({}, 2);
		const worker = workerDeclaration({}, 2);
		const context = contextDeclaration({}, 2);
		const retry = attemptDeclaration();
		const first = dispatchV5(
			contextDeclaration(),
			workerDeclaration(),
			sandboxDeclaration(),
		);

		expect(() =>
			parseDispatchEnvelopeV5({
				...first,
				attemptContextDeclarationEventRef: ATTEMPT_EVENT_REF,
				attemptContextDigest: retry.attemptContextDigest,
			}),
		).toThrow(/attempt 1 must not include attempt context/i);

		const second = dispatchV5(context, worker, sandbox, retry);
		const { attemptContextDigest: _digest, ...missingRetryDigest } = second;
		expect(() => parseDispatchEnvelopeV5(missingRetryDigest)).toThrow(
			/must be provided together/i,
		);
		expect(() =>
			assertDispatchEnvelopeV5ManifestDeclarationsV1(second, {
				context,
				worker,
				sandbox,
				attemptContext: retry,
			}),
		).not.toThrow();

		const retryWithoutCandidate = attemptDeclaration({
			attemptContext: { ...retry.attemptContext, priorCandidates: [] },
		});
		expect(() =>
			assertDispatchEnvelopeV5ManifestDeclarationsV1(
				dispatchV5(context, worker, sandbox, retryWithoutCandidate),
				{
					context,
					worker,
					sandbox,
					attemptContext: retryWithoutCandidate,
				},
			),
		).not.toThrow();

		const invalidRetry = {
			...retry,
			attemptContext: { ...retry.attemptContext, attempt: 1 },
		};
		expect(() =>
			parseAttemptContextDeclaredV1({
				...invalidRetry,
				attemptContextDigest: digest("d"),
			}),
		).toThrow(/attempt must be greater than 1/i);
	});
});
