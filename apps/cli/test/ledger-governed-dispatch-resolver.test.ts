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
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
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
const NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PENDING_ACTIVITY_RECOVERY_FIXTURE =
	new URL(
		"./fixtures/governed-dispatch-resolution-v1-pending-activity-recovery.json",
		import.meta.url,
	);
const NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PENDING_ACTIVITY_RECOVERY_HEARTBEAT_FIXTURE =
	new URL(
		"./fixtures/governed-dispatch-resolution-v1-pending-activity-recovery-heartbeat.json",
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

	it("exposes pending activity recovery only as frozen, exact read-only status", () => {
		expect(
			existsSync(
				NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PENDING_ACTIVITY_RECOVERY_FIXTURE,
			),
		).toBe(true);
		const resolved = parseNativeFixture(
			nativeFixture(
				NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PENDING_ACTIVITY_RECOVERY_FIXTURE,
			),
		);

		expect(resolved.pendingActivityRecoveryWork).toEqual([
			{
				schemaVersion: 1,
				identity: {
					runId: RUN_ID,
					workflowId: "workflow-trust-spine",
					workflowRevision: "1",
					unitId: "unit-trust-spine",
					attempt: 1,
					dispatchEventRef: DISPATCH_EVENT_ID,
					dispatchEnvelopeDigest: DIGEST("d"),
					actionId: "git-candidate-create:candidate-1/run-1/1",
					idempotencyKey: "git-candidate-create:candidate-1/run-1/1",
					actionRequestEventRef: "00000000-0000-7000-8000-000000000013",
					actionRequestDigest: expect.stringMatching(SHA256_DIGEST),
					activityClaimEventRef: "00000000-0000-7000-8000-000000000017",
					activityClaimEventDigest: DIGEST("4"),
					leaseId: "candidate-create-lease",
				},
				actionKind: "git",
				claimPurpose: "generic",
				state: "wait_for_active_lease",
				effectiveLeaseExpiresAt: "2026-07-18T12:01:45Z",
			},
		]);
		const [status] = resolved.pendingActivityRecoveryWork;
		expect(status).toBeDefined();
		expect(Object.isFrozen(resolved.pendingActivityRecoveryWork)).toBe(true);
		expect(Object.isFrozen(status)).toBe(true);
		expect(Object.isFrozen(status?.identity)).toBe(true);
		expect(status).not.toHaveProperty("execute");
		expect(status).not.toHaveProperty("retry");
		expect(status).not.toHaveProperty("issueLease");
		expect(() => {
			(status as { state: string }).state = "reconciliation_required";
		}).toThrow(TypeError);
	});

	it("consumes a native heartbeated pending activity as frozen status with its effective expiry", () => {
		expect(
			existsSync(
				NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PENDING_ACTIVITY_RECOVERY_HEARTBEAT_FIXTURE,
			),
		).toBe(true);
		const resolved = parseNativeFixture(
			nativeFixture(
				NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PENDING_ACTIVITY_RECOVERY_HEARTBEAT_FIXTURE,
			),
		);
		const [status] = resolved.pendingActivityRecoveryWork;

		expect(status).toMatchObject({
			state: "wait_for_active_lease",
			effectiveLeaseExpiresAt: "2026-07-18T12:01:55Z",
		});
		expect(resolved.recovery.activityClaims).toEqual([
			expect.objectContaining({ leaseExpiresAt: "2026-07-18T12:01:55Z" }),
		]);
		expect(Object.isFrozen(resolved.pendingActivityRecoveryWork)).toBe(true);
		expect(Object.isFrozen(status)).toBe(true);
	});

	it("accepts Chrono-compatible leap-second recovery timestamps", () => {
		const fixture = nativeFixture(
			NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PENDING_ACTIVITY_RECOVERY_HEARTBEAT_FIXTURE,
		);
		const recovery = fixture.recovery as Record<string, unknown>;
		const [claim] = recovery.activity_claims as Record<string, unknown>[];
		const [heartbeat] = claim.heartbeats as Record<string, unknown>[];
		const [status] = recovery.pending_activity_recovery_work as Record<
			string,
			unknown
		>[];
		const effectiveLeaseExpiresAt = "2026-07-18t12:01:60.223456789123Z";

		const resolved = parseNativeFixture({
			...fixture,
			recovery: {
				...recovery,
				activity_claims: [
					{
						...claim,
						claimed_at: "2026-07-18t12:01:58.123456789123Z",
						lease_expires_at: effectiveLeaseExpiresAt,
						heartbeats: [
							{
								...heartbeat,
								prior_lease_expires_at: "2026-07-18 12:01:60.123456789123Z",
								lease_expires_at: effectiveLeaseExpiresAt,
								heartbeat_at: "2026-07-18t12:01:59.999999999123Z",
							},
						],
					},
				],
				pending_activity_recovery_work: [
					{ ...status, effective_lease_expires_at: effectiveLeaseExpiresAt },
				],
			},
		});

		expect(resolved.pendingActivityRecoveryWork[0]).toMatchObject({
			effectiveLeaseExpiresAt,
		});
	});

	it("uses Chrono duration arithmetic at a midnight compute deadline", () => {
		const fixture = nativeFixture(
			NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PENDING_ACTIVITY_RECOVERY_HEARTBEAT_FIXTURE,
		);
		const dispatch = fixture.dispatch as Record<string, unknown>;
		const budget = dispatch.budget as Record<string, unknown>;
		const recovery = fixture.recovery as Record<string, unknown>;
		const [claim] = recovery.activity_claims as Record<string, unknown>[];
		const [heartbeat] = claim.heartbeats as Record<string, unknown>[];
		const [status] = recovery.pending_activity_recovery_work as Record<
			string,
			unknown
		>[];
		const effectiveLeaseExpiresAt = "2026-07-19T00:00:00.100000000Z";

		const resolved = parseNativeFixture({
			...fixture,
			dispatch: {
				...dispatch,
				budget: { ...budget, max_compute_time_ms: 600 },
				issued_at: "2026-07-18T23:59:59.500000000Z",
			},
			recovery: {
				...recovery,
				activity_claims: [
					{
						...claim,
						claimed_at: "2026-07-18T23:59:59.500000000Z",
						lease_expires_at: effectiveLeaseExpiresAt,
						heartbeats: [
							{
								...heartbeat,
								prior_lease_expires_at: "2026-07-18T23:59:59.800000000Z",
								lease_expires_at: effectiveLeaseExpiresAt,
								heartbeat_at: "2026-07-18T23:59:59.700000000Z",
							},
						],
					},
				],
				pending_activity_recovery_work: [
					{ ...status, effective_lease_expires_at: effectiveLeaseExpiresAt },
				],
			},
		});

		expect(resolved.pendingActivityRecoveryWork[0]).toMatchObject({
			effectiveLeaseExpiresAt,
		});
	});

	it("rejects timestamp forms excluded by the native Chrono boundary", () => {
		const fixture = nativeFixture(
			NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PENDING_ACTIVITY_RECOVERY_HEARTBEAT_FIXTURE,
		);
		const recovery = fixture.recovery as Record<string, unknown>;
		const [claim] = recovery.activity_claims as Record<string, unknown>[];

		for (const timestamp of [
			"2026-07-18T12:01:61Z",
			"2026-02-30T12:01:30Z",
			"2026-07-18t12:01:30.123456789123z",
		]) {
			expect(() =>
				parseNativeFixture({
					...fixture,
					recovery: {
						...recovery,
						activity_claims: [{ ...claim, claimed_at: timestamp }],
					},
				}),
			).toThrow(/activity_claim\.claimed_at must be a RFC3339 UTC timestamp/i);
		}
	});

	it("preserves native nanosecond dispatch ordering", () => {
		const fixture = nativeFixture(
			NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PENDING_ACTIVITY_RECOVERY_HEARTBEAT_FIXTURE,
		);
		const dispatch = fixture.dispatch as Record<string, unknown>;

		expect(() =>
			parseNativeFixture({
				...fixture,
				dispatch: {
					...dispatch,
					issued_at: "2099-07-18T12:00:00.000000001Z",
					expires_at: "2099-07-18T12:00:00.000000002Z",
				},
			}),
		).not.toThrow();
	});

	it("fails closed on malformed or foreign native activity heartbeats", () => {
		const fixture = nativeFixture(
			NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PENDING_ACTIVITY_RECOVERY_HEARTBEAT_FIXTURE,
		);
		const recovery = fixture.recovery as Record<string, unknown>;
		const [claim] = recovery.activity_claims as Record<string, unknown>[];
		const [heartbeat] = claim.heartbeats as Record<string, unknown>[];

		for (const [mutate, expected] of [
			[
				(value: Record<string, unknown>) => ({
					...value,
					forged_authority: "never",
				}),
				/heartbeats\[0\] contains unsupported field.*forged_authority/i,
			],
			[
				(value: Record<string, unknown>) => {
					const { heartbeat_request_digest: _requestDigest, ...withoutDigest } =
						value;
					return withoutDigest;
				},
				/heartbeat_id and heartbeat_request_digest must be present together/i,
			],
			[
				(value: Record<string, unknown>) => ({
					...value,
					run_id: "00000000-0000-7000-8000-000000000099",
				}),
				/does not bind the exact recovered activity claim lineage/i,
			],
		] as const) {
			expect(() =>
				parseNativeFixture({
					...fixture,
					recovery: {
						...recovery,
						activity_claims: [
							{ ...claim, heartbeats: [mutate({ ...heartbeat })] },
						],
					},
				}),
			).toThrow(expected);
		}
		expect(() =>
			parseNativeFixture({
				...fixture,
				recovery: {
					...recovery,
					activity_claims: [
						{ ...claim, heartbeats: [{ ...heartbeat }, { ...heartbeat }] },
					],
				},
			}),
		).toThrow(/duplicate heartbeat event identity/i);
	});

	it("rejects a heartbeat extension beyond the signed compute deadline", () => {
		const fixture = nativeFixture(
			NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PENDING_ACTIVITY_RECOVERY_HEARTBEAT_FIXTURE,
		);
		const recovery = fixture.recovery as Record<string, unknown>;
		const [claim] = recovery.activity_claims as Record<string, unknown>[];
		const [heartbeat] = claim.heartbeats as Record<string, unknown>[];
		const [status] = recovery.pending_activity_recovery_work as Record<
			string,
			unknown
		>[];
		const forgedExpiry = "2026-07-18T12:02:00.000000001Z";

		expect(() =>
			parseNativeFixture({
				...fixture,
				recovery: {
					...recovery,
					activity_claims: [
						{
							...claim,
							lease_expires_at: forgedExpiry,
							heartbeats: [{ ...heartbeat, lease_expires_at: forgedExpiry }],
						},
					],
					pending_activity_recovery_work: [
						{ ...status, effective_lease_expires_at: forgedExpiry },
					],
				},
			}),
		).toThrow(/within the signed compute deadline/i);
	});

	it("rejects a pending active-lease expiry that differs from the verified heartbeat expiry", () => {
		const fixture = nativeFixture(
			NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PENDING_ACTIVITY_RECOVERY_HEARTBEAT_FIXTURE,
		);
		const recovery = fixture.recovery as Record<string, unknown>;
		const [status] = recovery.pending_activity_recovery_work as Record<
			string,
			unknown
		>[];

		expect(() =>
			parseNativeFixture({
				...fixture,
				recovery: {
					...recovery,
					pending_activity_recovery_work: [
						{
							...status,
							effective_lease_expires_at: "2026-07-18T12:02:00Z",
						},
					],
				},
			}),
		).toThrow(/exact verified effective activity lease expiry/i);
	});

	it("requires the closed pending activity recovery shape and exact replay lineage", () => {
		const fixture = nativeFixture(
			NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PENDING_ACTIVITY_RECOVERY_FIXTURE,
		);
		const recovery = fixture.recovery as Record<string, unknown>;
		const [status] = recovery.pending_activity_recovery_work as Record<
			string,
			unknown
		>[];
		const identity = status.identity as Record<string, unknown>;

		for (const [_label, mutate, expected] of [
			[
				"an unsupported field",
				(value: Record<string, unknown>) => ({
					...value,
					forged_authority: "never",
				}),
				/contains unsupported field.*forged_authority/i,
			],
			[
				"a foreign dispatch envelope digest",
				(value: Record<string, unknown>) => ({
					...value,
					identity: {
						...(value.identity as Record<string, unknown>),
						dispatch_envelope_digest: DIGEST("f"),
					},
				}),
				/exact verified dispatch lineage/i,
			],
			[
				"a generic model claim",
				(value: Record<string, unknown>) => ({
					...value,
					action_kind: "model",
					claim_purpose: "generic",
				}),
				/governed_model_action_v1/i,
			],
			[
				"a native-supported action kind mismatched to its recovered request",
				(value: Record<string, unknown>) => ({
					...value,
					action_kind: "network",
				}),
				/exact recovered action request/i,
			],
			[
				"a native-compatible fixed purpose mismatched to its recovered claim",
				(value: Record<string, unknown>) => ({
					...value,
					claim_purpose: "governed_model_action_v1",
				}),
				/exact recovered non-terminal activity claim/i,
			],
			[
				"a native-compatible verifier purpose mismatched to its recovered claim",
				(value: Record<string, unknown>) => ({
					...value,
					claim_purpose: "governed_verifier_v1",
				}),
				/exact recovered non-terminal activity claim/i,
			],
			[
				"an active-lease status with a reconciliation reason",
				(value: Record<string, unknown>) => ({
					...value,
					reason: "lease_expired",
				}),
				/active lease status must not include a reconciliation reason/i,
			],
			[
				"a reconciliation status without a reason",
				(value: Record<string, unknown>) => {
					const { effective_lease_expires_at: _expiresAt, ...withoutExpiry } =
						value;
					return {
						...withoutExpiry,
						state: "reconciliation_required",
					};
				},
				/reconciliation status requires a closed reason/i,
			],
		] as const) {
			const mutatedStatus = mutate({ ...status, identity: { ...identity } });
			expect(() =>
				parseNativeFixture({
					...fixture,
					recovery: {
						...recovery,
						pending_activity_recovery_work: [mutatedStatus],
					},
				}),
			).toThrow(expected);
		}
	});

	it("consumes fixed-purpose non-model native recovery status without authority", () => {
		const fixture = nativeFixture(
			NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PENDING_ACTIVITY_RECOVERY_FIXTURE,
		);
		const recovery = fixture.recovery as Record<string, unknown>;
		const [claim] = recovery.activity_claims as Record<string, unknown>[];
		const [status] = recovery.pending_activity_recovery_work as Record<
			string,
			unknown
		>[];

		for (const claimPurpose of [
			"governed_model_action_v1",
			"governed_verifier_v1",
		] as const) {
			const resolved = parseNativeFixture({
				...fixture,
				recovery: {
					...recovery,
					activity_claims: [{ ...claim, purpose: claimPurpose }],
					pending_activity_recovery_work: [
						{ ...status, claim_purpose: claimPurpose },
					],
				},
			});
			expect(resolved.pendingActivityRecoveryWork[0]).toMatchObject({
				claimPurpose,
			});
		}
	});

	it("requires every native resolver fixture to carry an explicit pending activity status array", () => {
		for (const url of [
			NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_FIXTURE,
			NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_COMPLETED_CANDIDATE_FIXTURE,
			NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_CANCELLATION_FIXTURE,
			NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PROMOTION_APPROVAL_FIXTURE,
			NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PENDING_ACTIVITY_RECOVERY_FIXTURE,
		]) {
			const fixture = nativeFixture(url);
			const recovery = fixture.recovery as Record<string, unknown>;
			expect(recovery.pending_activity_recovery_work).toBeInstanceOf(Array);
			expect(
				parseNativeFixture(fixture).pendingActivityRecoveryWork,
			).toBeDefined();
		}
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

	it("projects a native serialized pending promotion approval as a read-only operator handoff", () => {
		expect(
			existsSync(
				NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PROMOTION_APPROVAL_FIXTURE,
			),
		).toBe(true);
		const resolved = parseNativeFixture(
			nativeFixture(
				NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PROMOTION_APPROVAL_FIXTURE,
			),
		);

		expect(resolved).toMatchObject({
			phase: "promotion_approval_pending",
			promotionApproval: {
				state: "operator_decision_required",
				authority: "none",
				eventRef: "00000000-0000-7000-8000-0000000000aa",
				candidateDigest: DIGEST("3"),
				baseCommitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				envelopeDigest: DIGEST("d"),
				acceptanceRef: "acceptance:fixture",
				reviewRefs: ["review:fixture"],
				requestedBy: "kernel",
				requestedAt: "2026-07-18T12:02:30Z",
				idempotencyKey: "promotion:fixture",
			},
		});
		const handoff = resolved.promotionApproval;
		expect(handoff).toBeDefined();
		expect(Object.isFrozen(handoff)).toBe(true);
		expect(handoff).not.toHaveProperty("execute");
		expect(handoff).not.toHaveProperty("retry");
		expect(handoff).not.toHaveProperty("decision");
		expect(resolved).not.toHaveProperty("promotionResolver");
	});

	it("requires a native full lineage for a pending promotion-approval handoff", () => {
		const fixture = nativeFixture(
			NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PROMOTION_APPROVAL_FIXTURE,
		);
		const recovery = fixture.recovery as Record<string, unknown>;
		const candidates = recovery.candidates as readonly Record<
			string,
			unknown
		>[];
		const acceptance = recovery.acceptance as Record<string, unknown> | null;
		const reviews = recovery.reviews as readonly Record<string, unknown>[];
		const resolved = parseNativeFixture(fixture);
		const handoff = resolved.promotionApproval;

		expect(resolved.phase).toBe("promotion_approval_pending");
		expect(candidates).toHaveLength(1);
		expect(recovery.candidate_completion).toBeDefined();
		expect(acceptance).toMatchObject({
			outcome: "passed",
			candidate_digest: candidates[0]?.candidate_digest,
		});
		expect(reviews).toEqual([
			expect.objectContaining({
				decision: "approve",
				candidate_digest: candidates[0]?.candidate_digest,
				candidate_envelope_digest: fixture.dispatch
					? (fixture.dispatch as Record<string, unknown>).envelope_digest
					: undefined,
			}),
		]);
		expect(handoff).toMatchObject({
			candidateDigest: candidates[0]?.candidate_digest,
			acceptanceRef: acceptance?.acceptance_ref,
			reviewRefs: reviews.map((review) => review.review_ref),
		});
		expect(
			resolved.recovery.candidateCompletion?.completion.candidateDigest,
		).toBe(handoff?.candidateDigest);
		expect(resolved).not.toHaveProperty("promotionResolver");
	});

	it.each([
		[
			"a foreign approval candidate digest",
			(fixture: Record<string, unknown>) => {
				const recovery = fixture.recovery as Record<string, unknown>;
				const approval = recovery.promotion_approval as Record<string, unknown>;
				recovery.promotion_approval = {
					...approval,
					candidate_digest: DIGEST("f"),
				};
			},
			/promotion approval does not bind one exact recovered candidate/i,
		],
		[
			"an approval acceptance-reference rebinding",
			(fixture: Record<string, unknown>) => {
				const recovery = fixture.recovery as Record<string, unknown>;
				const approval = recovery.promotion_approval as Record<string, unknown>;
				recovery.promotion_approval = {
					...approval,
					acceptance_ref: "acceptance:foreign",
				};
			},
			/promotion approval does not bind the passed recovered acceptance/i,
		],
		[
			"a missing approving review reference",
			(fixture: Record<string, unknown>) => {
				const recovery = fixture.recovery as Record<string, unknown>;
				const approval = recovery.promotion_approval as Record<string, unknown>;
				recovery.promotion_approval = {
					...approval,
					review_refs: ["review:foreign"],
				};
			},
			/promotion approval review reference is not an approving recovered review/i,
		],
		[
			"a review rebound to a foreign candidate envelope",
			(fixture: Record<string, unknown>) => {
				const recovery = fixture.recovery as Record<string, unknown>;
				const reviews = recovery.reviews as readonly Record<string, unknown>[];
				recovery.reviews = [
					{
						...reviews[0],
						candidate_envelope_digest: DIGEST("f"),
					},
				];
			},
			/recovered approval review does not bind the verified dispatch envelope/i,
		],
	] as const)("fails closed on %s", (_label, rebind, expected) => {
		const fixture = structuredClone(
			nativeFixture(
				NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PROMOTION_APPROVAL_FIXTURE,
			),
		);
		rebind(fixture);

		expect(() => parseNativeFixture(fixture)).toThrow(expected);
	});

	it.each([
		[
			"omits approval evidence while phase is pending",
			(fixture: Record<string, unknown>) => {
				delete (fixture.recovery as Record<string, unknown>).promotion_approval;
			},
			/promotion_approval_pending without its approval evidence/i,
		],
		[
			"retains approval evidence outside the pending phase",
			(fixture: Record<string, unknown>) => {
				(fixture.recovery as Record<string, unknown>).phase = "review_approved";
			},
			/promotion approval evidence outside promotion_approval_pending/i,
		],
	] as const)("fails closed when %s", (_label, mutate, expected) => {
		const fixture = structuredClone(
			nativeFixture(
				NATIVE_GOVERNED_DISPATCH_RESOLUTION_V1_PROMOTION_APPROVAL_FIXTURE,
			),
		);
		mutate(fixture);

		expect(() => parseNativeFixture(fixture)).toThrow(expected);
	});

	it("fails closed when a pending promotion approval does not bind the dispatch base SHA", () => {
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
						base_commit_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
					},
				},
			}),
		).toThrow(/promotion approval does not bind the verified dispatch base/i);
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
