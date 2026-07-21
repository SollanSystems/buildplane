import { existsSync, readFileSync } from "node:fs";
import { canonicalCandidateCompletionRecordedV1Digest } from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import { GOVERNED_AUTHORITY_BROKER_REQUIRED } from "../src/governed-ledger-authority.js";
import {
	__testOnlyParseNativeGovernedDispatchSnapshot,
	createNativeGovernedDispatchResolver,
	governedPolicyDigestForAcceptanceContract,
} from "../src/ledger-governed-dispatch-resolver.js";

const RUN_ID = "00000000-0000-7000-8000-000000000011";
const DISPATCH_EVENT_ID = "00000000-0000-7000-8000-000000000012";
const DIGEST = (character: string) => `sha256:${character.repeat(64)}`;
const NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_FIXTURE = new URL(
	"./fixtures/governed-dispatch-resolution-v1.json",
	import.meta.url,
);
const NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_COMPLETED_CANDIDATE_FIXTURE =
	new URL(
		"./fixtures/governed-dispatch-resolution-v1-completed-candidate.json",
		import.meta.url,
	);
const NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_CANCELLATION_FIXTURE = new URL(
	"./fixtures/governed-dispatch-resolution-v1-cancellation.json",
	import.meta.url,
);
const NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PROMOTION_APPROVAL_FIXTURE =
	new URL(
		"./fixtures/governed-dispatch-resolution-v1-promotion-approval.json",
		import.meta.url,
	);
const TEST_SNAPSHOT_CONTEXT = {
	runId: RUN_ID,
	dispatchEventRef: DISPATCH_EVENT_ID,
	kernelActorId: "kernel",
	kernelKeyId: "kernel-main",
};

function nativeGovernedDispatchResolutionV1Fixture(): Record<string, unknown> {
	return JSON.parse(
		readFileSync(NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_FIXTURE, "utf8"),
	) as Record<string, unknown>;
}

function nativeFixture(url: URL): Record<string, unknown> {
	return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

function parseNativeFixture(value: unknown) {
	return __testOnlyParseNativeGovernedDispatchSnapshot(
		JSON.stringify(value),
		TEST_SNAPSHOT_CONTEXT,
	);
}

describe("native governed dispatch resolver", () => {
	it("exposes native fixture parsing only as an untrusted status snapshot", () => {
		const snapshot = parseNativeFixture(
			nativeGovernedDispatchResolutionV1Fixture(),
		);

		expect(snapshot.dispatch.runId).toBe(RUN_ID);
		expect(snapshot).not.toHaveProperty("authorityRealm");
		expect(snapshot).not.toHaveProperty("recoveryResolver");
		expect(snapshot).not.toHaveProperty("activityClaimReferences");
	});

	it("does not export a test fixture resolver factory", async () => {
		const resolverModule = await import(
			"../src/ledger-governed-dispatch-resolver.js"
		);

		expect(resolverModule).not.toHaveProperty(
			"__testOnlyCreateNativeGovernedDispatchResolver",
		);
	});

	it("accepts the native V1 golden contract and rejects incompatible shapes", () => {
		expect(existsSync(NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_FIXTURE)).toBe(
			true,
		);
		const fixture = nativeGovernedDispatchResolutionV1Fixture();

		expect(parseNativeFixture(fixture)).toMatchObject({
			dispatch: {
				runId: RUN_ID,
				dispatchEnvelopeRef: DISPATCH_EVENT_ID,
				actionEvidenceVersion: "sealed_v3",
			},
		});

		const unknownField = structuredClone(fixture);
		unknownField.untrusted_extension = "must not become a compatibility path";
		expect(() => parseNativeFixture(unknownField)).toThrow(
			/governed dispatch resolution contains unsupported field/i,
		);

		const missingField = structuredClone(fixture);
		delete missingField.recovery;
		expect(() => parseNativeFixture(missingField)).toThrow(
			/governed dispatch resolution is missing required field.*recovery/i,
		);

		const wrongVersion = structuredClone(fixture);
		wrongVersion.schema_version = 2;
		expect(() => parseNativeFixture(wrongVersion)).toThrow(
			/schema_version must be 1/i,
		);
	});

	it("rejects runner-shaped input on the snapshot parser", () => {
		expect(() =>
			__testOnlyParseNativeGovernedDispatchSnapshot(
				JSON.stringify(nativeGovernedDispatchResolutionV1Fixture()),
				{
					...TEST_SNAPSHOT_CONTEXT,
					runner: () => undefined,
				} as typeof TEST_SNAPSHOT_CONTEXT,
			),
		).toThrow(/unsupported field runner/i);
	});

	it("rejects binary, runner, and fabricated realm injection on the production constructor", () => {
		const baseOptions = {
			workspace: process.cwd(),
			projectRoot: process.cwd(),
			runId: RUN_ID,
			dispatchEventRef: DISPATCH_EVENT_ID,
			kernelActorId: "kernel",
			kernelKeyId: "kernel-main",
		};
		for (const [field, value] of [
			["binary", "attacker-controlled-native"],
			["runner", () => undefined],
			[
				"authorityRealm",
				{
					kind: "host-governed-ledger-authority-v1",
					realmDigest: DIGEST("0"),
				},
			],
		] as const) {
			const productionOptions = {
				...baseOptions,
				[field]: value,
			} as unknown as Parameters<
				typeof createNativeGovernedDispatchResolver
			>[0];

			expect(() =>
				createNativeGovernedDispatchResolver(productionOptions),
			).toThrow(new RegExp(`unsupported field ${field}`, "i"));
		}
	});

	it("does not spawn a local native resolver when the authority broker is absent", () => {
		expect(() =>
			createNativeGovernedDispatchResolver({
				workspace: process.cwd(),
				projectRoot: process.cwd(),
				runId: RUN_ID,
				dispatchEventRef: DISPATCH_EVENT_ID,
				kernelActorId: "kernel",
				kernelKeyId: "kernel-main",
				trustedBinary: {
					kind: "packaged-native-v1",
					path: "not-a-broker-and-must-not-be-spawned",
					digest: DIGEST("7"),
				},
			}),
		).toThrow(GOVERNED_AUTHORITY_BROKER_REQUIRED);
	});

	it("constructs V3 status lineage only from the native trusted replay projection", () => {
		const resolved = parseNativeFixture(
			nativeGovernedDispatchResolutionV1Fixture(),
		);

		expect(resolved.dispatch).toMatchObject({
			schemaVersion: 3,
			runId: RUN_ID,
			dispatchEnvelopeRef: DISPATCH_EVENT_ID,
			commitMode: "atomic",
			trustTier: "governed",
			actionEvidenceVersion: "sealed_v3",
			policyDigest: governedPolicyDigestForAcceptanceContract(DIGEST("b")),
			governedPacketDigest: DIGEST("8"),
		});
		expect(resolved.recovery).toEqual({
			dispatchPolicyDigest: governedPolicyDigestForAcceptanceContract(
				DIGEST("b"),
			),
			requests: [],
			receipts: [],
			candidates: [],
		});
	});

	it("fails closed when a V3 native resolution omits the tape-integrity attestation", () => {
		const fixture = nativeGovernedDispatchResolutionV1Fixture();
		const { tape_integrity: _tapeIntegrity, ...withoutTapeIntegrity } = fixture;

		expect(() => parseNativeFixture(withoutTapeIntegrity)).toThrow(
			/missing required field.*tape_integrity/i,
		);
	});

	it("rejects malformed closed tape-integrity attestations from native replay", () => {
		const cases: readonly [string, Record<string, unknown>, RegExp][] = [
			[
				"unsupported schema version",
				{ schema_version: 2 },
				/schema_version must be 1/i,
			],
			[
				"non-UUID checkpoint reference",
				{ checkpoint_event_ref: "not-a-uuid" },
				/checkpoint_event_ref must be a UUID event id/i,
			],
			[
				"non-canonical checkpoint digest",
				{ checkpoint_event_digest: DIGEST("A") },
				/checkpoint_event_digest must be a canonical lowercase SHA-256 digest/i,
			],
			[
				"numeric signed event count",
				{ signed_non_checkpoint_event_count: 1 },
				/signed_non_checkpoint_event_count must be a canonical unsigned 64-bit decimal string/i,
			],
			[
				"unsupported root algorithm",
				{ algorithm: "sha512_tree" },
				/algorithm must be sha256_linear/i,
			],
		];

		for (const [_label, override, expected] of cases) {
			const fixture = nativeGovernedDispatchResolutionV1Fixture();
			const tapeIntegrity = fixture.tape_integrity as Record<string, unknown>;
			expect(() =>
				parseNativeFixture({
					...fixture,
					tape_integrity: { ...tapeIntegrity, ...override },
				}),
			).toThrow(expected);
		}
	});

	it("consumes the native serialized action, receipt, activity, and candidate-completion recovery fixture", () => {
		expect(
			existsSync(
				NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_COMPLETED_CANDIDATE_FIXTURE,
			),
		).toBe(true);
		const resolved = parseNativeFixture(
			nativeFixture(
				NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_COMPLETED_CANDIDATE_FIXTURE,
			),
		);

		expect(resolved.phase).toBe("candidate_created");
		expect(resolved.recovery.requests).toHaveLength(1);
		expect(resolved.recovery.receipts).toEqual([
			expect.objectContaining({
				receipt: expect.objectContaining({
					resourceUsage: {
						wallTimeMs: 1,
						inputTokens: 2,
						outputTokens: 3,
					},
				}),
			}),
		]);
		expect(resolved.recovery.activityClaims).toEqual([
			expect.objectContaining({
				activityId: "git-candidate-create:candidate-1/run-1/1",
				result: expect.objectContaining({ outcome: "succeeded" }),
			}),
		]);
		expect(resolved.recovery.candidateCompletion).toEqual(
			expect.objectContaining({
				completion: expect.objectContaining({
					candidateCreateActionId: "git-candidate-create:candidate-1/run-1/1",
				}),
			}),
		);
	});

	it("consumes the native serialized timer firing and cancellation fixture as status only", () => {
		expect(
			existsSync(NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_CANCELLATION_FIXTURE),
		).toBe(true);
		const resolved = parseNativeFixture(
			nativeFixture(
				NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_CANCELLATION_FIXTURE,
			),
		);

		expect(resolved.phase).toBe("cancellation_requested");
		expect(resolved.lifecycle).toEqual({
			timers: [
				expect.objectContaining({
					timerId: "deadline:fixture",
					fired: expect.objectContaining({
						firedAt: "2026-07-18T12:10:00Z",
					}),
				}),
			],
			cancellation: expect.objectContaining({
				cause: "timer_elapsed",
				cancellationId: "cancel:deadline:fixture",
			}),
		});
		expect(resolved).not.toHaveProperty("recoveryResolver");
	});

	it("blocks a native serialized pending promotion-approval recovery fixture", () => {
		expect(
			existsSync(
				NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PROMOTION_APPROVAL_FIXTURE,
			),
		).toBe(true);
		expect(() =>
			parseNativeFixture(
				nativeFixture(
					NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PROMOTION_APPROVAL_FIXTURE,
				),
			),
		).toThrow(/pending promotion approval.*action recovery is blocked/i);
	});

	it("fails closed on an unknown field nested inside native promotion-approval evidence", () => {
		const fixture = nativeFixture(
			NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PROMOTION_APPROVAL_FIXTURE,
		);
		const recovery = fixture.recovery as Record<string, unknown>;
		const approval = recovery.promotion_approval as Record<string, unknown>;

		expect(() =>
			parseNativeFixture({
				...fixture,
				recovery: {
					...recovery,
					promotion_approval: {
						...approval,
						forged_operator_authority: "never",
					},
				},
			}),
		).toThrow(/promotion_approval contains unsupported field/i);
	});

	it("fails closed when native promotion-approval evidence omits a required binding", () => {
		const fixture = nativeFixture(
			NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PROMOTION_APPROVAL_FIXTURE,
		);
		const recovery = fixture.recovery as Record<string, unknown>;
		const approval = structuredClone(
			recovery.promotion_approval as Record<string, unknown>,
		);
		delete approval.envelope_digest;

		expect(() =>
			parseNativeFixture({
				...fixture,
				recovery: { ...recovery, promotion_approval: approval },
			}),
		).toThrow(/promotion_approval is missing required field.*envelope_digest/i);
	});

	it("fails closed on unknown fields nested inside the native candidate-completion fixture", () => {
		const fixture = nativeFixture(
			NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_COMPLETED_CANDIDATE_FIXTURE,
		);
		const recovery = fixture.recovery as Record<string, unknown>;
		const completion = recovery.candidate_completion as Record<string, unknown>;
		const nested = completion.completion as Record<string, unknown>;

		expect(() =>
			parseNativeFixture({
				...fixture,
				recovery: {
					...recovery,
					candidate_completion: {
						...completion,
						completion: { ...nested, forged_authority: "never" },
					},
				},
			}),
		).toThrow(/candidate_completion\.completion contains unsupported field/i);
	});

	it("rejects a digest-valid candidate-completion action rebinding from the native fixture", () => {
		const fixture = nativeFixture(
			NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_COMPLETED_CANDIDATE_FIXTURE,
		);
		const recovery = fixture.recovery as Record<string, unknown>;
		const candidateCompletion = recovery.candidate_completion as Record<
			string,
			unknown
		>;
		const original = candidateCompletion.completion as Record<string, unknown>;
		const rebound = {
			...original,
			candidate_create_action_id: "git-candidate-create:other/run/1",
		};
		const digest = canonicalCandidateCompletionRecordedV1Digest({
			runId: rebound.run_id as string,
			workflowId: rebound.workflow_id as string,
			unitId: rebound.unit_id as string,
			attempt: rebound.attempt as number,
			provenanceRef: rebound.provenance_ref as string,
			candidateCreatedEventRef: rebound.candidate_created_event_ref as string,
			candidateDigest: rebound.candidate_digest as string,
			candidateCreateActionId: rebound.candidate_create_action_id as string,
			actionRequestRef: rebound.action_request_ref as string,
			actionRequestDigest: rebound.action_request_digest as string,
			activityClaimEventRef: rebound.activity_claim_event_ref as string,
			activityClaimEventDigest: rebound.activity_claim_event_digest as string,
			activityResultEventRef: rebound.activity_result_event_ref as string,
			activityResultEventDigest: rebound.activity_result_event_digest as string,
			actionReceiptRef: rebound.action_receipt_ref as string,
			actionReceiptDigest: rebound.action_receipt_digest as string,
			completedAt: rebound.completed_at as string,
		});

		expect(() =>
			parseNativeFixture({
				...fixture,
				recovery: {
					...recovery,
					candidate_completion: {
						...candidateCompletion,
						completion: { ...rebound, completion_digest: digest },
					},
				},
			}),
		).toThrow(
			/candidate completion action id is not the canonical candidate-create Git action/i,
		);
	});
});
