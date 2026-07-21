import { createHash } from "node:crypto";
import { bundleDigest } from "@buildplane/capability-broker";
import type {
	ActionReceiptRecordedV2,
	GovernedActionEvidencePort,
	GovernedActivityClaimPort,
	GovernedDispatchLineageV3,
	RecordActionReceiptV2Input,
	ReviewVerdictV1,
	UnitPacket,
} from "@buildplane/kernel";
import {
	canonicalActionReceiptRecordedV2Digest,
	canonicalActionRequestedV2Digest,
	canonicalGovernedAcceptanceContractV1Digest,
	createEventBus,
} from "@buildplane/kernel";
import type {
	ModelActionAuthorizedV2,
	ModelActionCandidateBindingV1,
	ModelActionIntentV1,
} from "@buildplane/ledger-client";
import { describe, expect, it, vi } from "vitest";

const testModelAuthorityProvenance = vi.hoisted(() => {
	const resolvers = new WeakSet<object>();
	const gateways = new WeakMap<object, unknown>();
	return {
		registerResolver<T extends object>(resolver: T): T {
			resolvers.add(resolver);
			return resolver;
		},
		isRegisteredResolver(resolver: unknown): resolver is object {
			return (
				resolver !== null &&
				typeof resolver === "object" &&
				resolvers.has(resolver)
			);
		},
		registerGateway<T extends object>(gateway: T, callback: unknown): T {
			gateways.set(gateway, callback);
			return gateway;
		},
		isTrustedGateway(gateway: unknown): gateway is object {
			return (
				gateway !== null && typeof gateway === "object" && gateways.has(gateway)
			);
		},
		gatewayCallback(gateway: unknown): unknown {
			return gateway !== null && typeof gateway === "object"
				? gateways.get(gateway)
				: undefined;
		},
	};
});

const testActivityClaimProvenance = vi.hoisted(() => {
	const ports = new WeakSet<object>();
	return {
		register<T extends object>(port: T): T {
			if (!Object.isFrozen(port)) {
				throw new TypeError(
					"trusted governed activity-claim port must be frozen.",
				);
			}
			ports.add(port);
			return port;
		},
		isTrusted(port: unknown): port is object {
			return port !== null && typeof port === "object" && ports.has(port);
		},
	};
});

vi.mock("../src/governed-model-authority-provenance.js", () => ({
	isRegisteredNativeModelActionAuthorityResolver:
		testModelAuthorityProvenance.isRegisteredResolver,
}));
vi.mock("../src/governed-model-gateway-provenance.js", () => ({
	isTrustedGovernedModelActionGateway:
		testModelAuthorityProvenance.isTrustedGateway,
	trustedGovernedModelActionGatewayAuthorizeAndComplete:
		testModelAuthorityProvenance.gatewayCallback,
}));
vi.mock("../src/governed-activity-claim-provenance.js", () => ({
	isTrustedGovernedActivityClaimPort: testActivityClaimProvenance.isTrusted,
}));

import * as governedApiWorkerModule from "../src/governed-api-worker.js";
import {
	type CreateGovernedApiWorkerExecutionPortOptions,
	canonicalGovernedApiModelInputV1Digest,
	canonicalGovernedUnitPacketV1Digest,
	canonicalImplementerCompletionV1Digest,
	canonicalModelActionAuthorizedV2Digest,
	canonicalModelActionIntentV1Digest,
	canonicalModelInputEvidenceV1Digest,
	canonicalModelResultEvidenceV1Digest,
	canonicalReviewVerdictOutputV1Digest,
	createGovernedApiWorkerExecutionPort as createGovernedApiWorkerExecutionPortInternal,
	createGovernedModelActionAuthorityPort,
	type GovernedApiClient,
	type GovernedModelActionAuthorityGrantV2,
	type GovernedModelActionAuthorityInputV2,
	type GovernedModelActionAuthorityPort,
	type GovernedModelActionGateway,
	type GovernedModelEvidenceStore,
	type GovernedReviewCandidateDescriptorV1,
	isVerifiedModelActionAuthority,
} from "../src/governed-api-worker.js";
import * as publicModels from "../src/index.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;
const DIGEST_D = `sha256:${"d".repeat(64)}`;
const DIGEST_E = `sha256:${"e".repeat(64)}`;
const DIGEST_F = `sha256:${"f".repeat(64)}`;
const RUN_ID = "01919000-0000-7000-8000-0000000000e1";
const CAPABILITY_BUNDLE = {
	schemaVersion: "buildplane.capability_bundle.v0" as const,
	bundleId: "governed-api-worker-test",
	fsWrite: ["src/**"],
	tools: {
		write_file: { enabled: true },
		run_command: { allowlist: ["git"] },
	},
};
const CAPABILITY_BUNDLE_DIGEST = bundleDigest(CAPABILITY_BUNDLE);
const ACCEPTANCE_CONTRACT = {
	schemaVersion: 1 as const,
	contract_version: "v0" as const,
	diff_scope: { allowed_globs: ["src/**"] },
	checks: [{ command: "exit-0" }],
};
const TRUST_SCOPE = {
	schemaVersion: 1 as const,
	lane: "governed" as const,
	principal: "kernel:test",
	scope: "governed-api-worker",
};
const ACCEPTANCE_CONTRACT_DIGEST =
	canonicalGovernedAcceptanceContractV1Digest(ACCEPTANCE_CONTRACT);

function contentAddressedReference(digest: string): string {
	return `cas:sha256:${digest.slice("sha256:".length)}`;
}

function modelResultEvidence(
	input: Parameters<GovernedModelEvidenceStore["persistModelResult"]>[0],
) {
	const resultDigest =
		input.reviewOutput === undefined
			? canonicalImplementerCompletionV1Digest(input.completion)
			: canonicalReviewVerdictOutputV1Digest(input.reviewOutput);
	const resultRef = contentAddressedReference(resultDigest);
	const evidence = {
		schemaVersion: 1 as const,
		actionId: input.actionId,
		actionRequestRef: input.actionRequestRef,
		actionRequestDigest: input.actionRequestDigest,
		modelRequestDigest: input.modelRequestDigest,
		authorizationRef: input.authorizationRef,
		authorizationDigest: input.authorizationDigest,
		resultDigest,
		resultRef,
		redactions: [],
	};
	const evidenceDigest = canonicalModelResultEvidenceV1Digest(evidence);
	return {
		...evidence,
		evidenceDigest,
		evidenceRef: contentAddressedReference(evidenceDigest),
	};
}

function modelInputEvidence(
	input: Parameters<GovernedModelEvidenceStore["persistCanonicalInput"]>[0],
) {
	const evidence = {
		schemaVersion: 1 as const,
		modelInputDigest: input.modelInputDigest,
		modelRequestDigest: input.modelRequestDigest,
		redactions: [],
	};
	const canonicalInputDigest = canonicalModelInputEvidenceV1Digest(evidence);
	return {
		...evidence,
		canonicalInputDigest,
		canonicalInputRef: contentAddressedReference(canonicalInputDigest),
	};
}

function rebindModelResultEvidence(
	input: Parameters<GovernedModelEvidenceStore["persistModelResult"]>[0],
	overrides: {
		readonly resultDigest?: string;
		readonly resultRef?: string;
	},
) {
	const original = modelResultEvidence(input);
	const evidence = {
		schemaVersion: original.schemaVersion,
		actionId: original.actionId,
		actionRequestRef: original.actionRequestRef,
		actionRequestDigest: original.actionRequestDigest,
		modelRequestDigest: original.modelRequestDigest,
		authorizationRef: original.authorizationRef,
		authorizationDigest: original.authorizationDigest,
		resultDigest: overrides.resultDigest ?? original.resultDigest,
		resultRef: overrides.resultRef ?? original.resultRef,
		redactions: original.redactions,
	};
	const evidenceDigest = canonicalModelResultEvidenceV1Digest(evidence);
	return {
		...evidence,
		evidenceDigest,
		evidenceRef: contentAddressedReference(evidenceDigest),
	};
}

function packet(overrides: Partial<UnitPacket> = {}): UnitPacket {
	return {
		unit: {
			id: "governed-api-unit",
			kind: "model",
			scope: "task",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "exit-0",
			policyProfile: "governed",
		},
		execution_role: "implementer",
		model: {
			provider: "anthropic",
			model: "test-model",
			prompt: "Implement the isolated change.",
		},
		intent: {
			objective: "Implement the isolated change.",
			taskType: "implement",
			context: { files: ["src/example.ts"] },
			constraints: { scope: ["src/**"], verification: [] },
			features: {
				ambiguity: "low",
				reversibility: "easy",
				verifierStrength: "strong",
			},
		},
		verification: { requiredOutputs: [] },
		provenance_ref: "event://admission/governed-api-worker",
		capability_bundle: CAPABILITY_BUNDLE,
		capability_bundle_digest: CAPABILITY_BUNDLE_DIGEST,
		acceptance_contract: ACCEPTANCE_CONTRACT,
		trust_scope: TRUST_SCOPE,
		...overrides,
	};
}

function governedDispatch(
	overrides: Partial<GovernedDispatchLineageV3> = {},
	boundPacket: UnitPacket = packet(),
): GovernedDispatchLineageV3 {
	return {
		schemaVersion: 3,
		runId: RUN_ID,
		workflowId: "workflow-governed-api",
		workflowRevision: "revision-governed-api",
		unitId: "governed-api-unit",
		attempt: 1,
		provenanceRef: "event://admission/governed-api-worker",
		dispatchEnvelopeRef: "01919000-0000-7000-8000-0000000000e2",
		envelopeDigest: DIGEST_A,
		baseCommitSha: "a".repeat(40),
		repositoryBindingDigest: DIGEST_B,
		ledgerAuthorityRealmDigest: DIGEST_C,
		governedPacketDigest: canonicalGovernedUnitPacketV1Digest(boundPacket),
		executionRole: "implementer",
		commitMode: "atomic",
		trustTier: "governed",
		capabilityBundleDigest: CAPABILITY_BUNDLE_DIGEST,
		acceptanceContractDigest: ACCEPTANCE_CONTRACT_DIGEST,
		policyDigest: DIGEST_D,
		contextManifestDigest: DIGEST_E,
		workerManifestDigest: DIGEST_F,
		sandboxProfileDigest: DIGEST_A,
		budget: {},
		idempotencyKey: "governed-api-worker:1",
		authorityActor: "kernel:test",
		actionEvidenceVersion: "sealed_v3",
		issuedAt: "2099-07-18T00:00:00.000Z",
		expiresAt: "2099-07-18T00:15:00.000Z",
		...overrides,
	};
}

function evidenceStore(
	events: string[],
	overrides: Partial<GovernedModelEvidenceStore> = {},
): GovernedModelEvidenceStore {
	return {
		async persistCanonicalInput(input) {
			events.push("canonical-input");
			expect(input.schemaVersion).toBe(1);
			expect(input.modelInput).not.toHaveProperty("credentials");
			expect(input.modelInput).toMatchObject({
				provider: "anthropic",
				model: "test-model",
				prompt: "Implement the isolated change.",
			});
			expect(input.modelInputDigest).toBe(
				canonicalGovernedApiModelInputV1Digest(input.modelInput),
			);
			return modelInputEvidence(input);
		},
		async persistModelResult(input) {
			events.push("model-result");
			return modelResultEvidence(input);
		},
		...overrides,
	};
}

function actionEvidence(
	events: string[],
	overrides: Partial<GovernedActionEvidencePort> = {},
): GovernedActionEvidencePort {
	return {
		async recordActionRequested(input) {
			events.push("action-requested");
			expect(input.actionKind).toBe("model");
			return {
				actionRequest: input,
				actionRequestRef: "01919000-0000-7000-8000-0000000000e3",
				actionRequestDigest: canonicalActionRequestedV2Digest(input),
			};
		},
		async recordActionReceipt(input) {
			events.push(`action-receipt:${input.outcome}`);
			return durableActionReceipt(input);
		},
		async sealActionReceiptSet() {
			throw new Error("the adapter must not seal receipt sets");
		},
		async recordCandidateCreatedV2() {
			throw new Error("the adapter must not create candidates");
		},
		...overrides,
	};
}

function activityClaimPort(
	events: string[] = [],
	overrides: Partial<GovernedActivityClaimPort> = {},
): GovernedActivityClaimPort {
	return testActivityClaimProvenance.register(
		Object.freeze({
			async claim(input) {
				events.push("activity-claim");
				expect(input.activityId).toMatch(/^model:/);
				return {
					state: "granted" as const,
					activityId: input.activityId,
					idempotencyKey: input.idempotencyKey,
					claimEventId: "01919000-0000-7000-8000-0000000000e4",
					claimEventDigest: DIGEST_A,
					leaseId: "lease:governed-api-worker",
					leaseExpiresAt: "2099-07-18T00:15:00.000Z",
				};
			},
			async recordResult(input) {
				events.push(`activity-result:${input.outcome}`);
				return {
					state: "recorded" as const,
					resultEventId: "01919000-0000-7000-8000-0000000000e5",
					resultEventDigest: DIGEST_B,
					resultOutcome: input.outcome,
				};
			},
			...overrides,
		}),
	);
}

function durableActionReceipt(input: RecordActionReceiptV2Input) {
	const receipt: ActionReceiptRecordedV2 = {
		...input,
		actionReceiptRef: "event://action-receipt/model-1",
	};
	return {
		receipt,
		actionReceiptDigest: canonicalActionReceiptRecordedV2Digest(receipt),
	};
}

function client(
	events: string[],
	overrides: Partial<GovernedApiClient> = {},
): GovernedApiClient {
	return {
		async complete(input) {
			events.push("client");
			expect(input).not.toHaveProperty("credentials");
			expect(input.toolCapabilities).toEqual([]);
			return {
				completion: {
					schemaVersion: 1,
					outcome: "completed",
					summary: "Implemented the requested change.",
					outputRefs: [],
				},
			};
		},
		...overrides,
	};
}

function reviewCandidate(
	dispatch: GovernedDispatchLineageV3,
	overrides: Partial<GovernedReviewCandidateDescriptorV1> = {},
): GovernedReviewCandidateDescriptorV1 {
	const candidate = {
		schemaVersion: 1,
		candidateDigest: DIGEST_B,
		candidateCommitSha: "b".repeat(40),
		candidateRef: "refs/buildplane/candidates/review-1",
		candidateTreeDigest: DIGEST_D,
		candidateViewRef: contentAddressedReference(DIGEST_B),
		readOnlyMount: {
			mode: "read-only",
			mountPath: "/candidate",
			mountDigest: DIGEST_C,
		},
		context: {
			contextRef: "evidence://context/review-1",
			contextManifestDigest: dispatch.contextManifestDigest,
		},
	} as const;
	return {
		...candidate,
		candidateViewDigest: candidateViewDigest(candidate, dispatch),
		...overrides,
	};
}

function candidateViewDigest(
	candidate: Omit<GovernedReviewCandidateDescriptorV1, "candidateViewDigest">,
	dispatch: GovernedDispatchLineageV3,
): string {
	return `sha256:${createHash("sha256")
		.update("buildplane.candidate-view.v1\0", "utf8")
		.update(
			JSON.stringify({
				candidate_ref: candidate.candidateRef,
				candidate_digest: candidate.candidateDigest,
				candidate_commit_sha: candidate.candidateCommitSha,
				tree_digest: candidate.candidateTreeDigest,
				reviewer_context_manifest_digest:
					candidate.context.contextManifestDigest,
				reviewer_sandbox_profile_digest: dispatch.sandboxProfileDigest,
				mount_path_digest: candidate.readOnlyMount.mountDigest,
				read_only: true,
				network_disabled: true,
			}),
			"utf8",
		)
		.digest("hex")}`;
}

/**
 * The production provenance modules intentionally expose no JavaScript
 * registration path. Focused adapter tests replace their predicates with this
 * test-local registry so they can exercise the worker's downstream evidence
 * and receipt behavior without making an emitted authority-minting API.
 */
function createTestGovernedModelActionAuthorityPort(
	input: Parameters<typeof createGovernedModelActionAuthorityPort>[0],
): GovernedModelActionAuthorityPort {
	const resolver = Object.freeze({
		authorize: input.resolver.authorize.bind(input.resolver),
	});
	return createGovernedModelActionAuthorityPort({
		...input,
		resolver: testModelAuthorityProvenance.registerResolver(resolver),
	});
}

function registerTestGovernedModelActionGateway<
	T extends GovernedModelActionGateway,
>(gateway: T): T {
	if (
		gateway === null ||
		typeof gateway !== "object" ||
		!Object.isFrozen(gateway)
	) {
		throw new TypeError(
			"trusted governed model ActionGateway must be a frozen gateway.",
		);
	}
	const descriptor = Object.getOwnPropertyDescriptor(
		gateway,
		"authorizeAndComplete",
	);
	if (
		descriptor === undefined ||
		!("value" in descriptor) ||
		typeof descriptor.value !== "function"
	) {
		throw new TypeError(
			"trusted governed model ActionGateway must expose authorizeAndComplete as an own non-accessor callable data property.",
		);
	}
	return testModelAuthorityProvenance.registerGateway(
		gateway,
		descriptor.value,
	);
}

function modelActionAuthorityPort(): GovernedModelActionAuthorityPort {
	return createTestGovernedModelActionAuthorityPort({
		resolver: {
			async authorize(input) {
				return nativeAuthorityGrant(input);
			},
		},
	});
}

function candidateBinding(
	candidate: GovernedReviewCandidateDescriptorV1,
	dispatch: GovernedDispatchLineageV3,
): ModelActionCandidateBindingV1 {
	return {
		candidate_created_event_ref: "01919000-0000-7000-8000-0000000000e4",
		candidate_digest: candidate.candidateDigest,
		candidate_commit_sha: candidate.candidateCommitSha,
		candidate_view_ref: candidate.candidateViewRef,
		candidate_view_digest: candidate.candidateViewDigest,
		candidate_view: {
			candidate_ref: candidate.candidateRef,
			candidate_digest: candidate.candidateDigest,
			candidate_commit_sha: candidate.candidateCommitSha,
			tree_digest: candidate.candidateTreeDigest,
			reviewer_context_manifest_digest: candidate.context.contextManifestDigest,
			reviewer_sandbox_profile_digest: dispatch.sandboxProfileDigest,
			mount_path_digest: candidate.readOnlyMount.mountDigest,
			read_only: true,
			network_disabled: true,
		},
	};
}

/**
 * Mirrors the generated native V2 intent/authorization pair. The digests are
 * intentionally real so tests exercise the same tamper checks as production
 * before a gateway call.
 */
function nativeAuthorityGrant(
	input: GovernedModelActionAuthorityInputV2,
	overrides: {
		readonly intentEventRef?: string;
		readonly intent?: Partial<ModelActionIntentV1>;
		readonly authorization?: Partial<ModelActionAuthorizedV2>;
	} = {},
): GovernedModelActionAuthorityGrantV2 {
	const { intent_digest: intentDigestOverride, ...intentOverrides } =
		overrides.intent ?? {};
	const baseIntent: Omit<ModelActionIntentV1, "intent_digest"> = {
		run_id: input.dispatch.runId,
		workflow_id: input.dispatch.workflowId,
		unit_id: input.dispatch.unitId,
		attempt: input.dispatch.attempt,
		provenance_ref: input.dispatch.provenanceRef,
		action_id: input.actionId,
		idempotency_key: input.idempotencyKey,
		dispatch_event_ref: input.dispatch.dispatchEnvelopeRef,
		dispatch_envelope_digest: input.dispatch.envelopeDigest,
		action_request_event_ref: input.actionRequestEventRef,
		action_request_digest: input.actionRequestDigest,
		canonical_input_ref: input.canonicalInputRef,
		canonical_input_digest: input.canonicalInputDigest,
		model_request_evidence: {
			schema_version: 1,
			cas_ref: contentAddressedReference(DIGEST_D),
			digest: DIGEST_D,
		},
		trust_scope_evidence: {
			schema_version: 1,
			cas_ref: contentAddressedReference(DIGEST_E),
			digest: DIGEST_E,
		},
		...(input.reviewCandidate === undefined
			? {}
			: {
					candidate_binding: candidateBinding(
						input.reviewCandidate,
						input.dispatch,
					),
				}),
		intent_actor: input.dispatch.authorityActor,
		intended_at: input.dispatch.issuedAt,
		...intentOverrides,
	};
	const intent: ModelActionIntentV1 = {
		...baseIntent,
		intent_digest:
			intentDigestOverride ?? canonicalModelActionIntentV1Digest(baseIntent),
	};
	const intentEventRef =
		overrides.intentEventRef ?? "01919000-0000-7000-8000-0000000000e5";
	const {
		authorization_digest: authorizationDigestOverride,
		...authorizationOverrides
	} = overrides.authorization ?? {};
	const baseAuthorization: Omit<
		ModelActionAuthorizedV2,
		"authorization_digest"
	> = {
		intent_event_ref: intentEventRef,
		intent_digest: intent.intent_digest,
		model_request_evidence: intent.model_request_evidence,
		trust_scope_evidence: intent.trust_scope_evidence,
		...(intent.candidate_binding === undefined
			? {}
			: { candidate_binding: intent.candidate_binding }),
		authorization_actor: input.dispatch.authorityActor,
		expires_at: input.dispatch.expiresAt,
		authorization_ref: "authorization:fixture-v3:v2",
		...authorizationOverrides,
	};
	const authorization: ModelActionAuthorizedV2 = {
		...baseAuthorization,
		authorization_digest:
			authorizationDigestOverride ??
			canonicalModelActionAuthorizedV2Digest(baseAuthorization),
	};
	return {
		schemaVersion: 2,
		intentEventRef,
		intent,
		authorization,
	};
}

function legacyV1AuthorityGrant(input: GovernedModelActionAuthorityInputV2) {
	return {
		schemaVersion: 1,
		actionId: input.actionId,
		actionRequestRef: input.actionRequestEventRef,
		actionRequestDigest: input.actionRequestDigest,
	};
}

/**
 * Test-only convenience: production options require an explicit authority
 * port; the wrapper keeps existing behavioral fixtures focused on the API
 * effect rather than repeating the native-resolver fixture.
 */
function createGovernedApiWorkerExecutionPort(
	options: Omit<
		CreateGovernedApiWorkerExecutionPortOptions,
		"modelActionAuthorityPort" | "activityClaimPort"
	> & {
		readonly modelActionAuthorityPort?: GovernedModelActionAuthorityPort;
		readonly activityClaimPort?: GovernedActivityClaimPort;
	},
) {
	const {
		modelActionAuthorityPort: authorityPort,
		activityClaimPort: activityPort,
		...remaining
	} = options;
	return createGovernedApiWorkerExecutionPortInternal({
		...remaining,
		modelActionAuthorityPort: authorityPort ?? modelActionAuthorityPort(),
		activityClaimPort: activityPort ?? activityClaimPort(),
	});
}

function actionGateway(
	events: string[],
	apiClient: GovernedApiClient = client(events),
	overrides: Partial<GovernedModelActionGateway> = {},
): GovernedModelActionGateway {
	return registerTestGovernedModelActionGateway(
		Object.freeze({
			async authorizeAndComplete(input) {
				events.push("gateway");
				expect(Object.isFrozen(input)).toBe(true);
				expect(Object.isFrozen(input.dispatch)).toBe(true);
				expect(Object.isFrozen(input.modelRequest)).toBe(true);
				expect(input.modelRequest).not.toHaveProperty("credentials");
				expect(isVerifiedModelActionAuthority(input.modelActionAuthority)).toBe(
					true,
				);
				expect(input.modelActionAuthority.authorization.authorization_ref).toBe(
					"authorization:fixture-v3:v2",
				);
				const response = await apiClient.complete(input.modelRequest);
				return {
					authorization: {
						schemaVersion: 1,
						decision: "allow" as const,
						actionId: input.actionId,
						idempotencyKey: input.idempotencyKey,
						actionRequestDigest: input.actionRequestDigest,
						modelRequestDigest: input.modelRequestDigest,
						dispatchEnvelopeDigest: input.dispatch.envelopeDigest,
						acceptanceContractDigest:
							input.packetAuthority.acceptanceContractDigest,
						trustScopeDigest: input.packetAuthority.trustScopeDigest,
						policyDigest: input.packetAuthority.policyDigest,
						sandboxProfileDigest: input.packetAuthority.sandboxProfileDigest,
						executionRole: input.executionRole,
						...(input.reviewCandidate === undefined
							? {}
							: {
									candidateDigest: input.reviewCandidate.candidateDigest,
									candidateViewDigest:
										input.reviewCandidate.candidateViewDigest,
								}),
						authorizationRef:
							input.modelActionAuthority.authorization.authorization_ref,
					},
					response,
				};
			},
			...overrides,
		}),
	);
}

function request(
	overrides: {
		readonly inputPacket?: UnitPacket;
		readonly dispatch?: GovernedDispatchLineageV3;
		readonly evidence?: GovernedActionEvidencePort;
		readonly reviewCandidate?: GovernedReviewCandidateDescriptorV1;
	} = {},
) {
	const inputPacket = overrides.inputPacket ?? packet();
	let dispatch = overrides.dispatch;
	if (!dispatch) {
		try {
			dispatch = governedDispatch({}, inputPacket);
		} catch {
			// Deliberately malformed packets are tested below; use a valid sealed
			// authority so the worker, rather than the fixture factory, rejects
			// their missing governed fields before any effect.
			dispatch = governedDispatch();
		}
	}
	return {
		runId: RUN_ID,
		packet: inputPacket,
		projectRoot: "/tmp/governed-api-worker",
		eventBus: createEventBus(),
		signal: new AbortController().signal,
		governedDispatch: dispatch,
		actionEvidencePort: overrides.evidence,
		...(overrides.reviewCandidate === undefined
			? {}
			: { reviewCandidate: overrides.reviewCandidate }),
	};
}

describe("governed API worker execution port", () => {
	it("keeps the blocked governed API worker implementation out of the public adapter API", () => {
		for (const exportName of [
			"createGovernedApiWorkerExecutionPort",
			"createGovernedModelActionAuthorityPort",
			"canonicalModelActionAuthorizedV2Digest",
			"isVerifiedModelActionAuthority",
		]) {
			expect(publicModels).not.toHaveProperty(exportName);
		}
	});

	it("does not expose JavaScript authority-registration hooks from production modules", async () => {
		const authorityProvenance = await vi.importActual<
			typeof import("../src/governed-model-authority-provenance.js")
		>("../src/governed-model-authority-provenance.js");
		const gatewayProvenance = await vi.importActual<
			typeof import("../src/governed-model-gateway-provenance.js")
		>("../src/governed-model-gateway-provenance.js");
		const resolver = Object.freeze({ async authorize() {} });
		const gateway = Object.freeze({ async authorizeAndComplete() {} });

		expect(authorityProvenance).not.toHaveProperty(
			"registerNativeModelActionAuthorityResolver",
		);
		expect(gatewayProvenance).not.toHaveProperty(
			"registerTrustedGovernedModelActionGateway",
		);
		expect(
			authorityProvenance.isRegisteredNativeModelActionAuthorityResolver(
				resolver,
			),
		).toBe(false);
		expect(gatewayProvenance.isTrustedGovernedModelActionGateway(gateway)).toBe(
			false,
		);
		expect(
			gatewayProvenance.trustedGovernedModelActionGatewayAuthorizeAndComplete(
				gateway,
			),
		).toBeUndefined();
	});

	it("matches the native ModelActionAuthorizedV2 digest fixture", () => {
		const canonicalDigest = (
			governedApiWorkerModule as unknown as {
				readonly canonicalModelActionAuthorizedV2Digest?: (
					input: unknown,
				) => string;
			}
		).canonicalModelActionAuthorizedV2Digest;
		expect(canonicalDigest).toBeTypeOf("function");
		expect(
			canonicalDigest?.({
				intent_event_ref: "01919000-0000-7000-8000-000000000044",
				intent_digest:
					"sha256:51b8d8388272930737e7bb2d08e83180c5f963bf991868f67f22b802d05ef158",
				model_request_evidence: {
					schema_version: 1,
					cas_ref: `cas:sha256:${"d".repeat(64)}`,
					digest: `sha256:${"d".repeat(64)}`,
				},
				trust_scope_evidence: {
					schema_version: 1,
					cas_ref: `cas:sha256:${"e".repeat(64)}`,
					digest: `sha256:${"e".repeat(64)}`,
				},
				authorization_actor: "kernel",
				expires_at: "2026-07-17T00:30:00Z",
				authorization_ref: "authorization:fixture-v3:v2",
			}),
		).toBe(
			"sha256:555b24af1e5c707f0777504fe695332679e9ae6d88cbb149f9b748e944af2e5f",
		);
	});

	it("matches the native ModelActionIntentV1 digest fixture", () => {
		const canonicalDigest = (
			governedApiWorkerModule as unknown as {
				readonly canonicalModelActionIntentV1Digest?: (
					input: unknown,
				) => string;
			}
		).canonicalModelActionIntentV1Digest;
		expect(canonicalDigest).toBeTypeOf("function");
		expect(
			canonicalDigest?.({
				run_id: "01919000-0000-7000-8000-0000000000ff",
				workflow_id: "workflow-fixture-v3",
				unit_id: "unit-fixture-v3",
				attempt: 1,
				provenance_ref: "admission:fixture-v3",
				action_id: "action-fixture-v3",
				idempotency_key: "action:fixture-v3",
				dispatch_event_ref: "01919000-0000-7000-8000-000000000042",
				dispatch_envelope_digest:
					"sha256:6feb096f077a3b5c01187afae91d56d7892a2e560e61fa807892a3be02cf4841",
				action_request_event_ref: "01919000-0000-7000-8000-000000000043",
				action_request_digest:
					"sha256:a85f732d4f92503b57e50130c8fd9d3d7b0e4e64239c4e2a7d8a4042f11029d9",
				canonical_input_ref: "cas:input:fixture-v3",
				canonical_input_digest: `sha256:${"a".repeat(64)}`,
				model_request_evidence: {
					schema_version: 1,
					cas_ref: `cas:sha256:${"d".repeat(64)}`,
					digest: `sha256:${"d".repeat(64)}`,
				},
				trust_scope_evidence: {
					schema_version: 1,
					cas_ref: `cas:sha256:${"e".repeat(64)}`,
					digest: `sha256:${"e".repeat(64)}`,
				},
				intent_actor: "kernel",
				intended_at: "2026-07-17T00:00:03Z",
			}),
		).toBe(
			"sha256:51b8d8388272930737e7bb2d08e83180c5f963bf991868f67f22b802d05ef158",
		);
	});

	it("accepts a closed native V2 intent and authorization pair", async () => {
		const dispatch = governedDispatch();
		const input: GovernedModelActionAuthorityInputV2 = {
			schemaVersion: 2,
			dispatch,
			actionId: "model-action-v2-fixture",
			idempotencyKey: "model-action-v2-fixture:1",
			actionRequestEventRef: "01919000-0000-7000-8000-0000000000e3",
			actionRequestDigest: DIGEST_A,
			canonicalInputRef: contentAddressedReference(DIGEST_B),
			canonicalInputDigest: DIGEST_B,
			executionRole: "implementer",
		};
		const authorityPort = createTestGovernedModelActionAuthorityPort({
			resolver: {
				async authorize(authorityInput) {
					return nativeAuthorityGrant(authorityInput);
				},
			},
		});

		await expect(authorityPort.bind(input)).resolves.toMatchObject({
			schemaVersion: 2,
			intentEventRef: "01919000-0000-7000-8000-0000000000e5",
			authorization: {
				intent_event_ref: "01919000-0000-7000-8000-0000000000e5",
			},
		});
	});

	it("rejects a legacy ModelActionAuthorizedV1 grant before the provider boundary", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const authorityPort = createTestGovernedModelActionAuthorityPort({
			resolver: {
				async authorize(input) {
					return legacyV1AuthorityGrant(input) as never;
				},
			},
		});
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			modelActionAuthorityPort: authorityPort,
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).rejects.toThrow(/model action authority/i);
		expect(complete).not.toHaveBeenCalled();
	});

	it("requires an immutable host model ActionGateway instead of a direct client", () => {
		const events: string[] = [];
		const directClientOptions = {
			client: client(events),
			evidenceStore: evidenceStore(events),
		} as unknown as Parameters<typeof createGovernedApiWorkerExecutionPort>[0];
		expect(() =>
			createGovernedApiWorkerExecutionPort(directClientOptions),
		).toThrow(/ActionGateway/i);
	});

	it("rejects a frozen structural model ActionGateway before its callback can receive authority", () => {
		const events: string[] = [];
		const authorizeAndComplete = vi.fn(async () => {
			throw new Error("forged model ActionGateway must never run");
		});

		expect(() =>
			createGovernedApiWorkerExecutionPortInternal({
				actionGateway: Object.freeze({ authorizeAndComplete }),
				modelActionAuthorityPort: modelActionAuthorityPort(),
				evidenceStore: evidenceStore(events),
			}),
		).toThrow(/trusted immutable host model ActionGateway/i);
		expect(authorizeAndComplete).not.toHaveBeenCalled();
	});

	it("rejects inherited or accessor model ActionGateway callbacks before they can become trusted", () => {
		const authorizeAndComplete = vi.fn(async () => {
			throw new Error("forged model ActionGateway must never run");
		});
		const inheritedGateway = Object.freeze(
			Object.create({ authorizeAndComplete }),
		) as GovernedModelActionGateway;
		let accessorReads = 0;
		const accessorGateway = Object.freeze({
			get authorizeAndComplete() {
				accessorReads += 1;
				return authorizeAndComplete;
			},
		}) as GovernedModelActionGateway;

		expect(() =>
			registerTestGovernedModelActionGateway(inheritedGateway),
		).toThrow(/own non-accessor callable/i);
		expect(() =>
			registerTestGovernedModelActionGateway(accessorGateway),
		).toThrow(/own non-accessor callable/i);
		expect(accessorReads).toBe(0);
		expect(authorizeAndComplete).not.toHaveBeenCalled();
	});

	it("rejects a frozen proxy around a registered model ActionGateway before callback invocation", () => {
		const events: string[] = [];
		const authorizeAndComplete = vi.fn(async () => {
			throw new Error("proxied model ActionGateway must never run");
		});
		const registeredGateway = registerTestGovernedModelActionGateway(
			Object.freeze({ authorizeAndComplete }),
		);
		const proxiedGateway = Object.freeze(
			new Proxy(registeredGateway, {}),
		) as GovernedModelActionGateway;

		expect(() =>
			createGovernedApiWorkerExecutionPortInternal({
				actionGateway: proxiedGateway,
				modelActionAuthorityPort: modelActionAuthorityPort(),
				evidenceStore: evidenceStore(events),
			}),
		).toThrow(/trusted immutable host model ActionGateway/i);
		expect(authorizeAndComplete).not.toHaveBeenCalled();
	});

	it("requires an immutable native-backed model authority port in production options", () => {
		const events: string[] = [];
		expect(() =>
			createGovernedApiWorkerExecutionPortInternal({
				actionGateway: actionGateway(events),
				evidenceStore: evidenceStore(events),
			} as unknown as CreateGovernedApiWorkerExecutionPortOptions),
		).toThrow(/native-backed model action authority port/i);
		expect(() =>
			createGovernedApiWorkerExecutionPortInternal({
				actionGateway: actionGateway(events),
				evidenceStore: evidenceStore(events),
				modelActionAuthorityPort: {
					async bind() {
						throw new Error("unreachable");
					},
				},
			}),
		).toThrow(/immutable native-backed model action authority port/i);
	});

	it("requires a native activity-claim authority independently of model authorization", () => {
		const events: string[] = [];
		expect(() =>
			createGovernedApiWorkerExecutionPortInternal({
				actionGateway: actionGateway(events),
				modelActionAuthorityPort: modelActionAuthorityPort(),
				evidenceStore: evidenceStore(events),
			} as unknown as CreateGovernedApiWorkerExecutionPortOptions),
		).toThrow(/activity-claim authority/i);
	});

	it("rejects a frozen structural activity-claim port before it can become effect authority", () => {
		const events: string[] = [];
		const claim = vi.fn(async () => {
			throw new Error("forged activity claim port must never run");
		});
		const recordResult = vi.fn(async () => {
			throw new Error("forged activity result port must never run");
		});

		expect(() =>
			createGovernedApiWorkerExecutionPortInternal({
				actionGateway: actionGateway(events),
				modelActionAuthorityPort: modelActionAuthorityPort(),
				evidenceStore: evidenceStore(events),
				activityClaimPort: Object.freeze({ claim, recordResult }),
			}),
		).toThrow(/trusted immutable native activity-claim authority/i);
		expect(claim).not.toHaveBeenCalled();
		expect(recordResult).not.toHaveBeenCalled();
	});

	it("rejects a forged structural native resolver before it can mint authority", () => {
		const authorize = vi.fn(async () => {
			throw new Error("forged resolver must never run");
		});

		expect(() =>
			createGovernedModelActionAuthorityPort({
				resolver: { authorize },
			}),
		).toThrow(/registered by the trusted native authority bridge/i);
		expect(authorize).not.toHaveBeenCalled();
	});

	it("binds the durable action and canonical input through the native V2 intent", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		let receivedAuthorityInput: unknown;
		const authorityPort = createTestGovernedModelActionAuthorityPort({
			resolver: {
				async authorize(input) {
					receivedAuthorityInput = input;
					return nativeAuthorityGrant(input);
				},
			},
		});
		const dispatched = governedDispatch();
		const inputPacket = packet();
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events),
			modelActionAuthorityPort: authorityPort,
			evidenceStore: evidenceStore(events),
		});

		await port.executeCandidatePacketAsync(
			request({ evidence, dispatch: dispatched, inputPacket }),
		);

		expect(receivedAuthorityInput).toMatchObject({
			schemaVersion: 2,
			dispatch: dispatched,
			actionRequestEventRef: "01919000-0000-7000-8000-0000000000e3",
			canonicalInputRef: expect.stringMatching(/^cas:sha256:[a-f0-9]{64}$/),
			canonicalInputDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
			executionRole: "implementer",
		});
	});

	it("fails closed before the host gateway when V2 authorization changes model evidence", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const authorityPort = createTestGovernedModelActionAuthorityPort({
			resolver: {
				async authorize(input) {
					return nativeAuthorityGrant(input, {
						authorization: {
							model_request_evidence: {
								schema_version: 1,
								cas_ref: contentAddressedReference(DIGEST_C),
								digest: DIGEST_C,
							},
						},
					});
				},
			},
		});
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			modelActionAuthorityPort: authorityPort,
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).rejects.toThrow(/authority/i);
		expect(events).toEqual([
			"canonical-input",
			"action-requested",
			"action-receipt:failed",
		]);
		expect(complete).not.toHaveBeenCalled();
	});

	it("fails closed before the host gateway when V2 authorization names a different parent event", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const authorityPort = createTestGovernedModelActionAuthorityPort({
			resolver: {
				async authorize(input) {
					return nativeAuthorityGrant(input, {
						authorization: {
							intent_event_ref: "01919000-0000-7000-8000-0000000000e6",
						},
					});
				},
			},
		});
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			modelActionAuthorityPort: authorityPort,
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).rejects.toThrow(/authority/i);
		expect(events).toEqual([
			"canonical-input",
			"action-requested",
			"action-receipt:failed",
		]);
		expect(complete).not.toHaveBeenCalled();
	});

	it("fails closed before the host gateway when V2 authorization names a different parent digest", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const authorityPort = createTestGovernedModelActionAuthorityPort({
			resolver: {
				async authorize(input) {
					return nativeAuthorityGrant(input, {
						authorization: { intent_digest: DIGEST_F },
					});
				},
			},
		});
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			modelActionAuthorityPort: authorityPort,
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).rejects.toThrow(/authority/i);
		expect(events).toEqual([
			"canonical-input",
			"action-requested",
			"action-receipt:failed",
		]);
		expect(complete).not.toHaveBeenCalled();
	});

	it("fails closed before the host gateway when V2 authorization changes trust evidence", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const authorityPort = createTestGovernedModelActionAuthorityPort({
			resolver: {
				async authorize(input) {
					return nativeAuthorityGrant(input, {
						authorization: {
							trust_scope_evidence: {
								schema_version: 1,
								cas_ref: contentAddressedReference(DIGEST_C),
								digest: DIGEST_C,
							},
						},
					});
				},
			},
		});
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			modelActionAuthorityPort: authorityPort,
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).rejects.toThrow(/authority/i);
		expect(events).toEqual([
			"canonical-input",
			"action-requested",
			"action-receipt:failed",
		]);
		expect(complete).not.toHaveBeenCalled();
	});

	it("fails closed before the host gateway when V2 authorization drops reviewer candidate evidence", async () => {
		const events: string[] = [];
		const reviewPacket = packet({ execution_role: "reviewer" });
		const reviewDispatch = governedDispatch(
			{ executionRole: "reviewer" },
			reviewPacket,
		);
		const candidate = reviewCandidate(reviewDispatch);
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const authorityPort = createTestGovernedModelActionAuthorityPort({
			resolver: {
				async authorize(input) {
					return nativeAuthorityGrant(input, {
						authorization: { candidate_binding: undefined },
					});
				},
			},
		});
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			modelActionAuthorityPort: authorityPort,
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(
				request({
					inputPacket: reviewPacket,
					dispatch: reviewDispatch,
					evidence,
					reviewCandidate: candidate,
				}),
			),
		).rejects.toThrow(/authority/i);
		expect(events).toEqual([
			"canonical-input",
			"action-requested",
			"action-receipt:failed",
		]);
		expect(complete).not.toHaveBeenCalled();
	});

	it("fails closed before the host gateway when V2 authorization has no authorization reference", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const authorityPort = createTestGovernedModelActionAuthorityPort({
			resolver: {
				async authorize(input) {
					const grant = nativeAuthorityGrant(input);
					return {
						...grant,
						authorization: {
							...grant.authorization,
							authorization_ref: "",
						},
					};
				},
			},
		});
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			modelActionAuthorityPort: authorityPort,
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).rejects.toThrow(/authority/i);
		expect(events).toEqual([
			"canonical-input",
			"action-requested",
			"action-receipt:failed",
		]);
		expect(complete).not.toHaveBeenCalled();
	});

	it("fails closed when a native authority record has a forged canonical digest", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const authorityPort = createTestGovernedModelActionAuthorityPort({
			resolver: {
				async authorize(input) {
					return nativeAuthorityGrant(input, {
						authorization: { authorization_digest: DIGEST_F },
					});
				},
			},
		});
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			modelActionAuthorityPort: authorityPort,
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).rejects.toThrow(/native-backed model action authority/i);
		expect(events).toEqual([
			"canonical-input",
			"action-requested",
			"action-receipt:failed",
		]);
		expect(complete).not.toHaveBeenCalled();
	});

	it("requires the native authorization signer to match the dispatch authority", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const authorityPort = createTestGovernedModelActionAuthorityPort({
			resolver: {
				async authorize(input) {
					return nativeAuthorityGrant(input, {
						authorization: { authorization_actor: "kernel:other" },
					});
				},
			},
		});
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			modelActionAuthorityPort: authorityPort,
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).rejects.toThrow(/native-backed model action authority/i);
		expect(events).toEqual([
			"canonical-input",
			"action-requested",
			"action-receipt:failed",
		]);
		expect(complete).not.toHaveBeenCalled();
	});

	it("does not accept a forged TypeScript authority object before the provider boundary", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const forgedPort = Object.freeze({
			async bind(
				input: Parameters<GovernedModelActionAuthorityPort["bind"]>[0],
			) {
				return Object.freeze({
					...nativeAuthorityGrant(input),
					verifiedAt: "2099-07-18T00:00:00.000Z",
				});
			},
		}) as GovernedModelActionAuthorityPort;
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			modelActionAuthorityPort: forgedPort,
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).rejects.toThrow(/native-backed model action authority/i);
		expect(events).toEqual([
			"canonical-input",
			"action-requested",
			"action-receipt:failed",
		]);
		expect(complete).not.toHaveBeenCalled();
	});

	it("rechecks a native authority lease immediately before the provider boundary", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const now = vi
			.fn<() => string>()
			.mockReturnValueOnce("2099-07-18T00:14:00.000Z")
			.mockReturnValueOnce("2099-07-18T00:14:00.000Z")
			.mockReturnValue("2099-07-18T00:16:00.000Z");
		const authorityPort = createTestGovernedModelActionAuthorityPort({
			now: () => "2099-07-18T00:14:00.000Z",
			resolver: {
				async authorize(input) {
					events.push("authority");
					return nativeAuthorityGrant(input, {
						authorization: {
							expires_at: "2099-07-18T00:15:00.000Z",
						},
					});
				},
			},
		});
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			modelActionAuthorityPort: authorityPort,
			evidenceStore: evidenceStore(events),
			now,
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).rejects.toThrow(/authority is expired/i);
		expect(events).toEqual([
			"canonical-input",
			"action-requested",
			"authority",
			"action-receipt:denied",
		]);
		expect(complete).not.toHaveBeenCalled();
	});

	it("denies an expired native activity lease before the provider boundary", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const now = vi
			.fn<() => string>()
			.mockReturnValueOnce("2099-07-18T00:14:00.000Z")
			.mockReturnValueOnce("2099-07-18T00:14:00.000Z")
			.mockReturnValue("2099-07-18T00:16:00.000Z");
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events),
			activityClaimPort: activityClaimPort(events),
			now,
		});

		await expect(
			port.executeCandidatePacketAsync(
				request({
					evidence,
					dispatch: governedDispatch({
						expiresAt: "2099-07-18T00:17:00.000Z",
					}),
				}),
			),
		).rejects.toThrow(/activity lease expired/i);
		expect(events).toEqual([
			"canonical-input",
			"action-requested",
			"activity-claim",
			"activity-result:failed",
			"action-receipt:denied",
		]);
		expect(complete).not.toHaveBeenCalled();
	});

	it("records an unknown effect instead of a success when the gateway returns after authority expiry", async () => {
		const events: string[] = [];
		const receipt = vi.fn(async (input: RecordActionReceiptV2Input) => {
			events.push(`action-receipt:${input.outcome}`);
			return durableActionReceipt(input);
		});
		const evidence = actionEvidence(events, { recordActionReceipt: receipt });
		const complete = vi.fn(client(events).complete);
		const now = vi
			.fn<() => string>()
			.mockReturnValueOnce("2099-07-18T00:14:00.000Z")
			.mockReturnValueOnce("2099-07-18T00:14:00.000Z")
			.mockReturnValueOnce("2099-07-18T00:14:00.000Z")
			.mockReturnValue("2099-07-18T00:16:00.000Z");
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events),
			now,
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).rejects.toThrow(/unknown effect/i);
		expect(complete).toHaveBeenCalledOnce();
		expect(events).toEqual([
			"canonical-input",
			"action-requested",
			"gateway",
			"client",
			"action-receipt:unknown",
		]);
		expect(receipt).toHaveBeenCalledOnce();
		expect(receipt.mock.calls[0]?.[0]).toMatchObject({
			outcome: "unknown",
			failure: { code: "model-action-authority-expired-after-api-call" },
		});
	});

	it("captures the verified ActionGateway instead of following later options-object swaps", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const options = {
			actionGateway: actionGateway(events),
			evidenceStore: evidenceStore(events),
		};
		const port = createGovernedApiWorkerExecutionPort(options);
		options.actionGateway = Object.freeze({
			async authorizeAndComplete() {
				events.push("forged-gateway");
				throw new Error("forged ActionGateway must never run");
			},
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).resolves.toMatchObject({ executionReceipt: { exitCode: 0 } });
		expect(events).toContain("gateway");
		expect(events).not.toContain("forged-gateway");
	});

	it("rejects an expired V3 dispatch before model evidence or a client effect", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events),
			now: () => "2099-07-18T00:16:00.000Z",
		});

		await expect(
			port.executeCandidatePacketAsync(
				request({
					evidence,
					dispatch: governedDispatch({
						issuedAt: "2099-07-18T00:00:00.000Z",
						expiresAt: "2099-07-18T00:15:00.000Z",
					}),
				}),
			),
		).rejects.toThrow(/expired/i);
		expect(events).toEqual([]);
		expect(complete).not.toHaveBeenCalled();
	});

	it("rejects an impossible UTC calendar date before model evidence or a client effect", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(
				request({
					evidence,
					dispatch: governedDispatch({
						expiresAt: "2099-02-30T00:15:00Z",
					}),
				}),
			),
		).rejects.toThrow(/RFC3339 UTC timestamp/i);
		expect(events).toEqual([]);
		expect(complete).not.toHaveBeenCalled();
	});

	it("rechecks expiry after write-ahead evidence and before the API effect", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const now = vi
			.fn<() => string>()
			.mockReturnValueOnce("2099-07-18T00:14:00.000Z")
			.mockReturnValue("2099-07-18T00:16:00.000Z");
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events),
			now,
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).rejects.toThrow(/dispatch is expired/i);
		expect(events).toEqual([
			"canonical-input",
			"action-requested",
			"action-receipt:denied",
		]);
		expect(complete).not.toHaveBeenCalled();
	});

	it("derives one immutable provider deadline from the signed compute budget", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(
			async (input: Parameters<GovernedApiClient["complete"]>[0]) => {
				expect(input.budget).toEqual({
					schemaVersion: 1,
					deadlineAt: "2099-07-18T00:00:01.000Z",
				});
				expect(input.structuredOutputRequired).toBe(true);
				expect(input.responseSchema).toMatchObject({
					schemaVersion: 1,
					kind: "implementer_completion_v1",
					digest: expect.stringMatching(/^sha256:/),
				});
				return {
					completion: {
						schemaVersion: 1,
						outcome: "completed" as const,
						summary: "Implemented the requested change.",
						outputRefs: [],
					},
				};
			},
		);
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events),
			now: () => "2099-07-18T00:00:00.000Z",
		});

		await expect(
			port.executeCandidatePacketAsync(
				request({
					evidence,
					dispatch: governedDispatch({
						budget: { maxComputeTimeMs: 1_000 },
					}),
				}),
			),
		).resolves.toMatchObject({ executionReceipt: { exitCode: 0 } });
		expect(complete).toHaveBeenCalledOnce();
	});

	it("rejects an exhausted signed compute budget before model evidence or provider authority", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events),
			now: () => "2099-07-18T00:00:01.000Z",
		});

		await expect(
			port.executeCandidatePacketAsync(
				request({
					evidence,
					dispatch: governedDispatch({
						budget: { maxComputeTimeMs: 1_000 },
					}),
				}),
			),
		).rejects.toThrow(/compute budget is exhausted/i);
		expect(events).toEqual([]);
		expect(complete).not.toHaveBeenCalled();
	});

	it("binds signed maxTokens into the provider request and accepts verified total usage", async () => {
		const events: string[] = [];
		let receiptInput: RecordActionReceiptV2Input | undefined;
		const evidence = actionEvidence(events, {
			recordActionReceipt: async (input) => {
				receiptInput = input;
				events.push(`action-receipt:${input.outcome}`);
				return durableActionReceipt(input);
			},
		});
		const complete = vi.fn(
			async (input: Parameters<GovernedApiClient["complete"]>[0]) => {
				expect(input.budget).toEqual({
					schemaVersion: 1,
					deadlineAt: "2099-07-18T00:15:00.000Z",
					maxTotalTokens: 10,
				});
				return {
					completion: {
						schemaVersion: 1,
						outcome: "completed" as const,
						summary: "Implemented the requested change.",
						outputRefs: [],
					},
					resourceUsage: { inputTokens: 4, outputTokens: 6 },
				};
			},
		);
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events),
			now: () => "2099-07-18T00:00:00.000Z",
		});

		await expect(
			port.executeCandidatePacketAsync(
				request({
					evidence,
					dispatch: governedDispatch({ budget: { maxTokens: 10 } }),
				}),
			),
		).resolves.toMatchObject({ executionReceipt: { exitCode: 0 } });
		expect(complete).toHaveBeenCalledOnce();
		expect(receiptInput?.resourceUsage).toMatchObject({
			inputTokens: 4,
			outputTokens: 6,
		});
	});

	it("records a terminal failure when a budgeted provider response omits token usage", async () => {
		const events: string[] = [];
		let receiptInput: RecordActionReceiptV2Input | undefined;
		const evidence = actionEvidence(events, {
			recordActionReceipt: async (input) => {
				receiptInput = input;
				events.push(`action-receipt:${input.outcome}`);
				return durableActionReceipt(input);
			},
		});
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events),
			evidenceStore: evidenceStore(events),
			activityClaimPort: activityClaimPort(events),
			now: () => "2099-07-18T00:00:00.000Z",
		});

		await expect(
			port.executeCandidatePacketAsync(
				request({
					evidence,
					dispatch: governedDispatch({ budget: { maxTokens: 10 } }),
				}),
			),
		).rejects.toThrow(/must report inputTokens and outputTokens/i);
		expect(events).toEqual([
			"canonical-input",
			"action-requested",
			"activity-claim",
			"gateway",
			"client",
			"activity-result:failed",
			"action-receipt:failed",
		]);
		expect(receiptInput).toMatchObject({
			outcome: "failed",
			failure: { code: "model-token-usage-missing" },
		});
	});

	it("preserves a partial metered token observation on the terminal missing-usage receipt", async () => {
		const events: string[] = [];
		let receiptInput: RecordActionReceiptV2Input | undefined;
		const evidence = actionEvidence(events, {
			recordActionReceipt: async (input) => {
				receiptInput = input;
				events.push(`action-receipt:${input.outcome}`);
				return durableActionReceipt(input);
			},
		});
		const complete = vi.fn(async () => ({
			completion: {
				schemaVersion: 1,
				outcome: "completed" as const,
				summary: "Implemented the requested change.",
				outputRefs: [],
			},
			resourceUsage: { inputTokens: 4 },
		}));
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events),
			activityClaimPort: activityClaimPort(events),
			now: () => "2099-07-18T00:00:00.000Z",
		});

		await expect(
			port.executeCandidatePacketAsync(
				request({
					evidence,
					dispatch: governedDispatch({ budget: { maxTokens: 10 } }),
				}),
			),
		).rejects.toThrow(/must report inputTokens and outputTokens/i);
		expect(receiptInput).toMatchObject({
			outcome: "failed",
			failure: { code: "model-token-usage-missing" },
			resourceUsage: { inputTokens: 4 },
		});
		expect(receiptInput?.resourceUsage).not.toHaveProperty("outputTokens");
	});

	it("persists metered usage when a post-provider completion is invalid", async () => {
		const events: string[] = [];
		let receiptInput: RecordActionReceiptV2Input | undefined;
		const evidence = actionEvidence(events, {
			recordActionReceipt: async (input) => {
				receiptInput = input;
				events.push(`action-receipt:${input.outcome}`);
				return durableActionReceipt(input);
			},
		});
		const complete = vi.fn(async () => ({
			completion: {},
			resourceUsage: { inputTokens: 4, outputTokens: 3 },
		}));
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events),
			activityClaimPort: activityClaimPort(events),
			now: () => "2099-07-18T00:00:00.000Z",
		});

		await expect(
			port.executeCandidatePacketAsync(
				request({
					evidence,
					dispatch: governedDispatch({ budget: { maxTokens: 10 } }),
				}),
			),
		).rejects.toThrow();
		expect(receiptInput).toMatchObject({
			outcome: "failed",
			failure: { code: "invalid-model-completion" },
			resourceUsage: { inputTokens: 4, outputTokens: 3 },
		});
	});

	it("records a terminal failure when verified provider usage exceeds maxTokens", async () => {
		const events: string[] = [];
		let receiptInput: RecordActionReceiptV2Input | undefined;
		const evidence = actionEvidence(events, {
			recordActionReceipt: async (input) => {
				receiptInput = input;
				events.push(`action-receipt:${input.outcome}`);
				return durableActionReceipt(input);
			},
		});
		const complete = vi.fn(async () => ({
			completion: {
				schemaVersion: 1,
				outcome: "completed" as const,
				summary: "Implemented the requested change.",
				outputRefs: [],
			},
			resourceUsage: { inputTokens: 8, outputTokens: 3 },
		}));
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events),
			now: () => "2099-07-18T00:00:00.000Z",
		});

		await expect(
			port.executeCandidatePacketAsync(
				request({
					evidence,
					dispatch: governedDispatch({ budget: { maxTokens: 10 } }),
				}),
			),
		).rejects.toThrow(/used 11 tokens/i);
		expect(receiptInput).toMatchObject({
			outcome: "failed",
			failure: { code: "model-token-budget-exceeded" },
		});
	});

	it("binds the governed packet acceptance contract to the V3 dispatch before model evidence", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(
				request({
					evidence,
					dispatch: governedDispatch({ acceptanceContractDigest: DIGEST_C }),
				}),
			),
		).rejects.toThrow(/acceptance contract digest/i);
		expect(events).toEqual([]);
		expect(complete).not.toHaveBeenCalled();
	});

	it.each([
		["acceptance-contract", packet({ acceptance_contract: undefined })],
		["trust-scope", packet({ trust_scope: undefined })],
	])("requires governed packet %s authority before model evidence", async (authorityName, inputPacket) => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence, inputPacket })),
		).rejects.toThrow(new RegExp(authorityName, "i"));
		expect(events).toEqual([]);
		expect(complete).not.toHaveBeenCalled();
	});

	it("writes a model action request before the host ActionGateway and returns its durable receipt", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events),
			evidenceStore: evidenceStore(events),
			activityClaimPort: activityClaimPort(events),
			now: () => "2026-07-18T00:00:00.000Z",
		});

		const result = await port.executeCandidatePacketAsync(
			request({ evidence }),
		);

		expect(events).toEqual([
			"canonical-input",
			"action-requested",
			"activity-claim",
			"gateway",
			"client",
			"model-result",
			"activity-result:succeeded",
			"action-receipt:succeeded",
		]);
		expect(result).toMatchObject({
			executionReceipt: {
				command: "governed-api-model",
				exitCode: 0,
			},
			actionReceipts: [
				{
					actionId: expect.any(String),
					actionReceiptRef: "event://action-receipt/model-1",
					actionReceiptDigest: expect.stringMatching(/^sha256:/),
				},
			],
		});
	});

	it("persists the exact ActionGateway authorization reference with a successful model receipt", async () => {
		const events: string[] = [];
		let receiptInput: RecordActionReceiptV2Input | undefined;
		const evidence = actionEvidence(events, {
			recordActionReceipt: async (input) => {
				receiptInput = input;
				events.push(`action-receipt:${input.outcome}`);
				return durableActionReceipt(input);
			},
		});
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events),
			evidenceStore: evidenceStore(events),
		});

		await port.executeCandidatePacketAsync(request({ evidence }));
		expect(receiptInput).toMatchObject({
			outcome: "succeeded",
			authorizationRef: "authorization:fixture-v3:v2",
		});
	});

	it("never invokes the provider when native activity recovery reports an existing terminal action", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events),
			activityClaimPort: activityClaimPort(events, {
				async claim() {
					events.push("activity-claim-recorded");
					return {
						state: "recorded" as const,
						claimEventId: "01919000-0000-7000-8000-0000000000e4",
						resultEventId: "01919000-0000-7000-8000-0000000000e5",
						resultEventDigest: DIGEST_A,
						resultOutcome: "unknown" as const,
					};
				},
			}),
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).rejects.toThrow(/activity .* recorded/i);
		expect(events).toEqual([
			"canonical-input",
			"action-requested",
			"activity-claim-recorded",
		]);
		expect(complete).not.toHaveBeenCalled();
	});

	it("does not reissue a provider call across 100 deterministic post-intent crash schedules", async () => {
		for (let seed = 0; seed < 100; seed += 1) {
			// Deterministic pseudo-random schedules cover a provider failure after
			// authorization, ambiguous model-result persistence, and a lost
			// action-receipt write after a recorded terminal activity result.
			const schedule = (seed * 1_103_515_245 + 12_345) >>> 0;
			const crashBoundary = schedule % 3;
			const events: string[] = [];
			let claimAttempts = 0;
			const complete = vi.fn<GovernedApiClient["complete"]>(async () => {
				events.push("client");
				if (crashBoundary === 0) {
					throw new Error("simulated provider crash");
				}
				return {
					completion: {
						schemaVersion: 1,
						outcome: "completed",
						summary: "Implemented the requested change.",
						outputRefs: [],
					},
				};
			});
			const receipt = vi.fn(async (input: RecordActionReceiptV2Input) => {
				if (crashBoundary === 2) {
					events.push("action-receipt-lost");
					throw new Error("simulated action-receipt crash");
				}
				events.push(`action-receipt:${input.outcome}`);
				return durableActionReceipt(input);
			});
			const evidence = actionEvidence(events, { recordActionReceipt: receipt });
			const claims = activityClaimPort(events, {
				claim: vi.fn(async (input) => {
					claimAttempts += 1;
					if (claimAttempts > 1) return { state: "recorded" as const };
					return {
						state: "granted" as const,
						activityId: input.activityId,
						idempotencyKey: input.idempotencyKey,
						claimEventId: "01919000-0000-7000-8000-0000000000e4",
						claimEventDigest: DIGEST_A,
						leaseId: "lease:governed-api-worker",
						leaseExpiresAt: "2099-07-18T00:15:00.000Z",
					};
				}),
			});
			const port = createGovernedApiWorkerExecutionPort({
				actionGateway: actionGateway(events, client(events, { complete })),
				evidenceStore: evidenceStore(events, {
					persistModelResult: async (input) => {
						events.push("model-result");
						if (crashBoundary === 1) {
							return rebindModelResultEvidence(input, {
								resultDigest: DIGEST_B,
								resultRef: contentAddressedReference(DIGEST_B),
							});
						}
						return modelResultEvidence(input);
					},
				}),
				activityClaimPort: claims,
			});

			await expect(
				port.executeCandidatePacketAsync(request({ evidence })),
			).rejects.toThrow(/unknown effect/i);
			await expect(
				port.executeCandidatePacketAsync(request({ evidence })),
			).rejects.toThrow(/activity .* recorded/i);

			expect(complete, `seed ${seed}`).toHaveBeenCalledOnce();
			expect(claims.claim, `seed ${seed}`).toHaveBeenCalledTimes(2);
		}
	});

	it("does not seal a syntactically valid but substituted implementer result record", async () => {
		const events: string[] = [];
		const receipt = vi.fn(async (input: RecordActionReceiptV2Input) => {
			events.push(`action-receipt:${input.outcome}`);
			return durableActionReceipt(input);
		});
		const evidence = actionEvidence(events, { recordActionReceipt: receipt });
		const complete = vi.fn(client(events).complete);
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events, {
				persistModelResult: async (input) => {
					events.push("model-result-substituted");
					return rebindModelResultEvidence(input, {
						resultDigest: DIGEST_B,
						resultRef: contentAddressedReference(DIGEST_B),
					});
				},
			}),
			activityClaimPort: activityClaimPort(events),
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).rejects.toThrow(/unknown effect/i);
		expect(complete).toHaveBeenCalledOnce();
		expect(events).toEqual([
			"canonical-input",
			"action-requested",
			"activity-claim",
			"gateway",
			"client",
			"model-result-substituted",
			"activity-result:unknown",
			"action-receipt:unknown",
		]);
		expect(receipt.mock.calls).toHaveLength(1);
		expect(receipt.mock.calls[0]?.[0]).toMatchObject({
			outcome: "unknown",
			failure: { code: "model-result-evidence-ambiguous" },
		});
	});

	it("records an explicit ActionGateway denial without invoking the provider client", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const gateway = actionGateway(events, client(events, { complete }), {
			async authorizeAndComplete(input) {
				events.push("gateway-denied");
				return {
					authorization: {
						schemaVersion: 1,
						decision: "deny",
						actionId: input.actionId,
						idempotencyKey: input.idempotencyKey,
						actionRequestDigest: input.actionRequestDigest,
						modelRequestDigest: input.modelRequestDigest,
						dispatchEnvelopeDigest: input.dispatch.envelopeDigest,
						acceptanceContractDigest:
							input.packetAuthority.acceptanceContractDigest,
						trustScopeDigest: input.packetAuthority.trustScopeDigest,
						policyDigest: input.packetAuthority.policyDigest,
						sandboxProfileDigest: input.packetAuthority.sandboxProfileDigest,
						executionRole: input.executionRole,
						authorizationRef:
							input.modelActionAuthority.authorization.authorization_ref,
						denialCode: "policy-denied",
					},
				};
			},
		});
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: gateway,
			evidenceStore: evidenceStore(events),
			activityClaimPort: activityClaimPort(events),
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).rejects.toThrow(/denied by the host ActionGateway/i);
		expect(events).toEqual([
			"canonical-input",
			"action-requested",
			"activity-claim",
			"gateway-denied",
			"activity-result:failed",
			"action-receipt:denied",
		]);
		expect(complete).not.toHaveBeenCalled();
	});

	it("blocks before the API call when canonical input evidence cannot be persisted", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events, {
				persistCanonicalInput: async () => {
					events.push("canonical-input-failed");
					throw new Error("input evidence offline");
				},
			}),
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).rejects.toThrow(/canonical model input evidence/i);
		expect(complete).not.toHaveBeenCalled();
		expect(events).toEqual(["canonical-input-failed"]);
	});

	it("blocks before ActionRequested and the gateway when input evidence is syntactically valid but substituted", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events, {
				persistCanonicalInput: async (input) => {
					events.push("canonical-input-substituted");
					const original = modelInputEvidence(input);
					const substituted = {
						schemaVersion: original.schemaVersion,
						modelInputDigest: DIGEST_B,
						modelRequestDigest: original.modelRequestDigest,
						redactions: original.redactions,
					};
					const canonicalInputDigest =
						canonicalModelInputEvidenceV1Digest(substituted);
					return {
						...substituted,
						canonicalInputDigest,
						canonicalInputRef: contentAddressedReference(canonicalInputDigest),
					};
				},
			}),
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).rejects.toThrow(/canonical model input evidence/i);
		expect(events).toEqual(["canonical-input-substituted"]);
		expect(complete).not.toHaveBeenCalled();
	});

	it("blocks before ActionRequested and the gateway when input evidence binds a different request contract", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events, {
				persistCanonicalInput: async (input) => {
					events.push("canonical-input-request-substituted");
					const original = modelInputEvidence(input);
					const substituted = {
						schemaVersion: original.schemaVersion,
						modelInputDigest: original.modelInputDigest,
						modelRequestDigest: DIGEST_B,
						redactions: original.redactions,
					};
					const canonicalInputDigest =
						canonicalModelInputEvidenceV1Digest(substituted);
					return {
						...substituted,
						canonicalInputDigest,
						canonicalInputRef: contentAddressedReference(canonicalInputDigest),
					};
				},
			}),
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).rejects.toThrow(/canonical model input evidence/i);
		expect(events).toEqual(["canonical-input-request-substituted"]);
		expect(complete).not.toHaveBeenCalled();
	});

	it("does not rewrite a recorded terminal activity when durable receipt persistence fails after an API call", async () => {
		const events: string[] = [];
		const receipt = vi.fn(async (input: RecordActionReceiptV2Input) => {
			if (receipt.mock.calls.length === 1) {
				events.push("action-receipt-failed");
				throw new Error("ledger unavailable");
			}
			events.push(`action-receipt:${input.outcome}`);
			return durableActionReceipt(input);
		});
		const evidence = actionEvidence(events, { recordActionReceipt: receipt });
		const complete = vi.fn(client(events).complete);
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).rejects.toThrow(/unknown effect/i);
		expect(complete).toHaveBeenCalledOnce();
		expect(receipt).toHaveBeenCalledOnce();
	});

	it.each([
		{
			name: "an unsupported provider",
			inputPacket: packet({
				model: { provider: "claude-code", model: "test", prompt: "nope" },
			}),
			dispatch: governedDispatch(),
		},
		{
			name: "a dispatch role that does not match the packet",
			inputPacket: packet({ execution_role: "reviewer" }),
			dispatch: governedDispatch({ executionRole: "implementer" }),
		},
	])("rejects $name before calling the host ActionGateway", async ({
		inputPacket,
		dispatch,
	}) => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(
				request({ inputPacket, dispatch, evidence }),
			),
		).rejects.toThrow(/governed API worker/i);
		expect(complete).not.toHaveBeenCalled();
	});

	it("requires strict review verdicts bound to the immutable candidate and reviewer manifest", async () => {
		const events: string[] = [];
		const reviewPacket = packet({ execution_role: "reviewer" });
		const reviewDispatch = governedDispatch(
			{ executionRole: "reviewer" },
			reviewPacket,
		);
		const evidence = actionEvidence(events);
		const candidate = reviewCandidate(reviewDispatch);
		const verdict: ReviewVerdictV1 = {
			schemaVersion: 1,
			candidateDigest: DIGEST_B,
			decision: "approve",
			findings: [],
			confidence: 0.9,
			reviewerManifestDigest: reviewDispatch.workerManifestDigest,
		};
		const abstainingVerdict: ReviewVerdictV1 = {
			...verdict,
			decision: "abstain",
		};
		const complete = vi
			.fn<GovernedApiClient["complete"]>()
			.mockResolvedValueOnce({ completion: verdict })
			.mockResolvedValueOnce({
				completion: abstainingVerdict,
			})
			.mockResolvedValueOnce({
				completion: { ...verdict, candidateDigest: DIGEST_C },
			})
			.mockResolvedValueOnce({
				completion: { ...verdict, unknown: true },
			});
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(
				request({
					inputPacket: reviewPacket,
					dispatch: reviewDispatch,
					evidence,
					reviewCandidate: candidate,
				}),
			),
		).resolves.toMatchObject({
			executionReceipt: { exitCode: 0 },
			reviewVerdict: verdict,
		});
		await expect(
			port.executeCandidatePacketAsync(
				request({
					inputPacket: reviewPacket,
					dispatch: reviewDispatch,
					evidence,
					reviewCandidate: candidate,
				}),
			),
		).resolves.toMatchObject({
			executionReceipt: { exitCode: 0 },
			reviewVerdict: abstainingVerdict,
		});
		await expect(
			port.executeCandidatePacketAsync(
				request({
					inputPacket: reviewPacket,
					dispatch: reviewDispatch,
					evidence,
					reviewCandidate: candidate,
				}),
			),
		).rejects.toThrow(/candidate digest/i);
		await expect(
			port.executeCandidatePacketAsync(
				request({
					inputPacket: reviewPacket,
					dispatch: reviewDispatch,
					evidence,
					reviewCandidate: candidate,
				}),
			),
		).rejects.toThrow(/unknown field/i);
		expect(complete).toHaveBeenCalledTimes(4);
	});

	it("blocks a review role without an immutable candidate descriptor before the host ActionGateway", async () => {
		const events: string[] = [];
		const reviewPacket = packet({ execution_role: "reviewer" });
		const reviewDispatch = governedDispatch(
			{ executionRole: "reviewer" },
			reviewPacket,
		);
		const evidence = actionEvidence(events);
		const complete = vi.fn<GovernedApiClient["complete"]>().mockResolvedValue({
			completion: {
				schemaVersion: 1,
				candidateDigest: DIGEST_B,
				decision: "approve",
				findings: [],
				confidence: 0.9,
				reviewerManifestDigest: reviewDispatch.workerManifestDigest,
			},
		});
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(
				request({
					inputPacket: reviewPacket,
					dispatch: reviewDispatch,
					evidence,
				}),
			),
		).rejects.toThrow(/immutable candidate descriptor/i);
		expect(complete).not.toHaveBeenCalled();
	});

	it("rejects a candidate descriptor whose ref no longer matches its candidate-view digest", async () => {
		const events: string[] = [];
		const reviewPacket = packet({ execution_role: "reviewer" });
		const reviewDispatch = governedDispatch(
			{ executionRole: "reviewer" },
			reviewPacket,
		);
		const candidate = reviewCandidate(reviewDispatch);
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events),
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(
				request({
					inputPacket: reviewPacket,
					dispatch: reviewDispatch,
					evidence: actionEvidence(events),
					reviewCandidate: {
						...candidate,
						candidateRef: "refs/buildplane/candidates/substituted",
					},
				}),
			),
		).rejects.toThrow(/candidateViewDigest/i);
		expect(events).toEqual([]);
	});

	it("binds review-only authority and a frozen read-only candidate into the host ActionGateway", async () => {
		const events: string[] = [];
		const reviewPacket = packet({ execution_role: "reviewer" });
		const reviewDispatch = governedDispatch(
			{ executionRole: "reviewer" },
			reviewPacket,
		);
		const candidate = reviewCandidate(reviewDispatch);
		const evidence = actionEvidence(events);
		const verdict: ReviewVerdictV1 = {
			schemaVersion: 1,
			candidateDigest: candidate.candidateDigest,
			decision: "request_changes",
			findings: [],
			confidence: 0.8,
			reviewerManifestDigest: reviewDispatch.workerManifestDigest,
		};
		let received:
			| Parameters<GovernedModelActionGateway["authorizeAndComplete"]>[0]
			| undefined;
		const gateway = actionGateway(events, client(events), {
			async authorizeAndComplete(input) {
				received = input;
				return {
					authorization: {
						schemaVersion: 1,
						decision: "allow",
						actionId: input.actionId,
						idempotencyKey: input.idempotencyKey,
						actionRequestDigest: input.actionRequestDigest,
						modelRequestDigest: input.modelRequestDigest,
						dispatchEnvelopeDigest: input.dispatch.envelopeDigest,
						acceptanceContractDigest:
							input.packetAuthority.acceptanceContractDigest,
						trustScopeDigest: input.packetAuthority.trustScopeDigest,
						policyDigest: input.packetAuthority.policyDigest,
						sandboxProfileDigest: input.packetAuthority.sandboxProfileDigest,
						executionRole: input.executionRole,
						candidateDigest: input.reviewCandidate?.candidateDigest,
						candidateViewDigest: input.reviewCandidate?.candidateViewDigest,
						authorizationRef:
							input.modelActionAuthority.authorization.authorization_ref,
					},
					response: { completion: verdict },
				};
			},
		});
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: gateway,
			evidenceStore: evidenceStore(events),
		});

		const result = await port.executeCandidatePacketAsync(
			request({
				inputPacket: reviewPacket,
				dispatch: reviewDispatch,
				evidence,
				reviewCandidate: candidate,
			}),
		);

		expect(received).toMatchObject({
			executionRole: "reviewer",
			dispatch: {
				envelopeDigest: reviewDispatch.envelopeDigest,
				policyDigest: reviewDispatch.policyDigest,
				sandboxProfileDigest: reviewDispatch.sandboxProfileDigest,
			},
			packetAuthority: {
				acceptanceContractDigest: ACCEPTANCE_CONTRACT_DIGEST,
				policyDigest: reviewDispatch.policyDigest,
				sandboxProfileDigest: reviewDispatch.sandboxProfileDigest,
			},
			constraints: {
				structuredOutputRequired: true,
				responseSchema: {
					schemaVersion: 1,
					kind: "review_verdict_v1",
					digest: expect.stringMatching(/^sha256:/),
				},
				reviewOnly: true,
				filesystemAccess: "candidate-read-only",
				processAccess: "none",
				toolCapabilities: [],
				workerSecretAccess: "none",
				workerNetworkAccess: "none",
				brokeredModelNetwork: "provider-only",
			},
			reviewCandidate: candidate,
			modelActionAuthority: {
				schemaVersion: 2,
				intentEventRef: expect.any(String),
				intent: {
					candidate_binding: {
						candidate_digest: candidate.candidateDigest,
						candidate_view_ref: candidate.candidateViewRef,
						candidate_view_digest: candidate.candidateViewDigest,
						candidate_view: {
							candidate_ref: candidate.candidateRef,
							read_only: true,
							network_disabled: true,
						},
					},
				},
				authorization: {
					intent_event_ref: expect.any(String),
					intent_digest: expect.any(String),
					candidate_binding: {
						candidate_digest: candidate.candidateDigest,
						candidate_view_digest: candidate.candidateViewDigest,
					},
				},
			},
			modelRequest: {
				expectedCandidateDigest: candidate.candidateDigest,
				reviewCandidate: candidate,
				toolCapabilities: [],
				structuredOutputRequired: true,
				responseSchema: {
					schemaVersion: 1,
					kind: "review_verdict_v1",
					digest: expect.stringMatching(/^sha256:/),
				},
			},
		});
		expect(Object.isFrozen(received)).toBe(true);
		expect(Object.isFrozen(received?.reviewCandidate)).toBe(true);
		expect(Object.isFrozen(received?.reviewCandidate?.readOnlyMount)).toBe(
			true,
		);
		expect(result).toMatchObject({ reviewVerdict: verdict });
		expect(JSON.parse(result.executionReceipt.stdout)).toEqual(verdict);
	});

	it("persists a canonical review output bound to the kernel candidate commit and view", async () => {
		const events: string[] = [];
		const reviewPacket = packet({ execution_role: "reviewer" });
		const reviewDispatch = governedDispatch(
			{ executionRole: "reviewer" },
			reviewPacket,
		);
		const candidate = reviewCandidate(reviewDispatch);
		const verdict: ReviewVerdictV1 = {
			schemaVersion: 1,
			candidateDigest: candidate.candidateDigest,
			decision: "approve",
			findings: [],
			confidence: 0.9,
			reviewerManifestDigest: reviewDispatch.workerManifestDigest,
		};
		let persistedOutput:
			| Parameters<
					GovernedModelEvidenceStore["persistModelResult"]
			  >[0]["reviewOutput"]
			| undefined;
		let receipt: RecordActionReceiptV2Input | undefined;
		const evidence = actionEvidence(events, {
			recordActionReceipt: async (input) => {
				receipt = input;
				events.push(`action-receipt:${input.outcome}`);
				return durableActionReceipt(input);
			},
		});
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(
				events,
				client(events, { complete: async () => ({ completion: verdict }) }),
			),
			evidenceStore: evidenceStore(events, {
				persistModelResult: async (input) => {
					persistedOutput = input.reviewOutput;
					events.push("model-result");
					if (input.reviewOutput === undefined) {
						throw new Error("review output missing");
					}
					return modelResultEvidence(input);
				},
			}),
		});

		await port.executeCandidatePacketAsync(
			request({
				inputPacket: reviewPacket,
				dispatch: reviewDispatch,
				evidence,
				reviewCandidate: candidate,
			}),
		);
		expect(persistedOutput).toMatchObject({
			candidateDigest: candidate.candidateDigest,
			candidateCommitSha: candidate.candidateCommitSha,
			candidateViewDigest: candidate.candidateViewDigest,
			decision: "approve",
		});
		expect(receipt?.resultDigest).toBe(
			canonicalReviewVerdictOutputV1Digest(persistedOutput!),
		);
	});

	it("does not seal a review verdict when its otherwise valid CAS result ref is substituted", async () => {
		const events: string[] = [];
		const reviewPacket = packet({ execution_role: "reviewer" });
		const reviewDispatch = governedDispatch(
			{ executionRole: "reviewer" },
			reviewPacket,
		);
		const candidate = reviewCandidate(reviewDispatch);
		const verdict: ReviewVerdictV1 = {
			schemaVersion: 1,
			candidateDigest: candidate.candidateDigest,
			decision: "approve",
			findings: [],
			confidence: 0.9,
			reviewerManifestDigest: reviewDispatch.workerManifestDigest,
		};
		const receipt = vi.fn(async (input: RecordActionReceiptV2Input) => {
			events.push(`action-receipt:${input.outcome}`);
			return durableActionReceipt(input);
		});
		const evidence = actionEvidence(events, { recordActionReceipt: receipt });
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(
				events,
				client(events, { complete: async () => ({ completion: verdict }) }),
			),
			evidenceStore: evidenceStore(events, {
				persistModelResult: async (input) => {
					events.push("review-result-substituted");
					return rebindModelResultEvidence(input, {
						resultRef: contentAddressedReference(DIGEST_A),
					});
				},
			}),
		});

		await expect(
			port.executeCandidatePacketAsync(
				request({
					inputPacket: reviewPacket,
					dispatch: reviewDispatch,
					evidence,
					reviewCandidate: candidate,
				}),
			),
		).rejects.toThrow(/unknown effect/i);
		expect(events).toEqual([
			"canonical-input",
			"action-requested",
			"gateway",
			"review-result-substituted",
			"action-receipt:unknown",
		]);
		expect(receipt.mock.calls).toHaveLength(1);
		expect(receipt.mock.calls[0]?.[0]).toMatchObject({
			outcome: "unknown",
			failure: { code: "model-result-evidence-ambiguous" },
		});
	});

	it("blocks before the API call when the recorded request does not bind the exact expected V3 action", async () => {
		const events: string[] = [];
		const recordActionRequested = vi.fn(async (input) => {
			const altered = { ...input, actionId: "model:substituted" };
			return {
				actionRequest: altered,
				actionRequestRef: "event://action-request/substituted",
				actionRequestDigest: canonicalActionRequestedV2Digest(altered),
			};
		});
		const evidence = actionEvidence(events, { recordActionRequested });
		const complete = vi.fn(client(events).complete);
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).rejects.toThrow(/does not bind the expected V3 action request/i);
		expect(recordActionRequested).toHaveBeenCalledOnce();
		expect(complete).not.toHaveBeenCalled();
	});

	it("blocks as an unknown effect when a returned durable receipt does not bind the expected V3 action", async () => {
		const events: string[] = [];
		const recordActionReceipt = vi.fn(
			async (input: RecordActionReceiptV2Input) => {
				if (recordActionReceipt.mock.calls.length === 1) {
					const substituted: ActionReceiptRecordedV2 = {
						...input,
						actionId: "model:substituted",
						actionReceiptRef: "event://action-receipt/substituted",
					};
					return {
						receipt: substituted,
						actionReceiptDigest:
							canonicalActionReceiptRecordedV2Digest(substituted),
					};
				}
				return durableActionReceipt(input);
			},
		);
		const evidence = actionEvidence(events, { recordActionReceipt });
		const complete = vi.fn(client(events).complete);
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).rejects.toThrow(/unknown effect/i);
		expect(complete).toHaveBeenCalledOnce();
		expect(recordActionReceipt).toHaveBeenCalledOnce();
	});

	it("requires an admitted capability bundle and its V3 digest before the API call", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(
				request({
					evidence,
					inputPacket: packet({
						capability_bundle: undefined,
						capability_bundle_digest: undefined,
					}),
				}),
			),
		).rejects.toThrow(/capability bundle/i);
		expect(complete).not.toHaveBeenCalled();
	});

	it("rejects factory-injected tool capabilities until typed actions are signed and implemented", () => {
		const events: string[] = [];
		expect(() =>
			createGovernedApiWorkerExecutionPort({
				actionGateway: actionGateway(events),
				evidenceStore: evidenceStore(events),
				toolCapabilities: [
					{
						schemaVersion: 1,
						capabilityId: "unsigned-tool",
						kind: "mcp",
						inputSchemaDigest: DIGEST_A,
						outputSchemaDigest: DIGEST_B,
					},
				],
			}),
		).toThrow(/does not accept configured tool capabilities/i);
	});

	it("never executes ambient tools and blocks an undeclared shell call after recording the model effect", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(
				events,
				client(events, {
					complete: async () => ({
						completion: {
							schemaVersion: 1,
							outcome: "completed",
							summary: "would have run a command",
							outputRefs: [],
						},
						toolCalls: [{ schemaVersion: 1, capabilityId: "shell", input: {} }],
					}),
				}),
			),
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).rejects.toThrow(/undeclared tool capability/i);
		expect(events).toContain("action-receipt:failed");
		expect(events).not.toContain("model-result");
	});

	it("rejects accessor-backed provider tool calls without reading the accessor", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		let accessorReads = 0;
		const toolCalls = [{ schemaVersion: 1, capabilityId: "shell", input: {} }];
		Object.defineProperty(toolCalls, "0", {
			get: () => {
				accessorReads += 1;
				throw new Error("provider tool-call accessor must not run");
			},
			enumerable: true,
		});
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(
				events,
				client(events, {
					complete: async () => ({
						completion: {
							schemaVersion: 1,
							outcome: "completed",
							summary: "would have run a command",
							outputRefs: [],
						},
						toolCalls,
					}),
				}),
			),
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(request({ evidence })),
		).rejects.toThrow(/unknown effect/i);
		expect(accessorReads).toBe(0);
		expect(events).not.toContain("model-result");
	});

	it("rejects ambient packet tool definitions before the injected client is called", async () => {
		const events: string[] = [];
		const evidence = actionEvidence(events);
		const complete = vi.fn(client(events).complete);
		const port = createGovernedApiWorkerExecutionPort({
			actionGateway: actionGateway(events, client(events, { complete })),
			evidenceStore: evidenceStore(events),
		});

		await expect(
			port.executeCandidatePacketAsync(
				request({
					evidence,
					inputPacket: packet({
						model: {
							provider: "anthropic",
							model: "test-model",
							prompt: "Implement the isolated change.",
							tools: [
								{
									name: "run_command",
									description: "ambient command tool",
									parameters: {},
								},
							],
						},
					}),
				}),
			),
		).rejects.toThrow(/typed tool capability contract/i);
		expect(complete).not.toHaveBeenCalled();
	});
});
