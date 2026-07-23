import {
	createHash,
	generateKeyPairSync,
	type KeyObject,
	sign,
} from "node:crypto";
import { canonicalDispatchEnvelopeV3Digest } from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import {
	type AuthorityBrokerRequestV1,
	createAuthorityBrokerAdmitRequestV1,
	createAuthorityBrokerClient,
	createAuthorityBrokerPreauthorizedLookupRequestV1,
	type ManagedAuthorityBrokerTransportV1,
	verifyAuthorityBrokerResponseV1,
} from "../src/governed-authority-broker-client.js";

const DIGEST = (character: string) => `sha256:${character.repeat(64)}`;
const BASE_SHA = "a".repeat(40);
const UUID = "123e4567-e89b-12d3-a456-426614174000";
const RESPONSE_ID = "123e4567-e89b-12d3-a456-426614174001";
const EVENT_ID = "123e4567-e89b-12d3-a456-426614174002";
const RUN_ID = "123e4567-e89b-12d3-a456-426614174003";
const ISSUED_AT = "2099-01-01T00:00:00.000Z";
const EXPIRES_AT = "2099-01-01T01:00:00.000Z";

function admissionInput(
	overrides: Partial<
		Parameters<typeof createAuthorityBrokerAdmitRequestV1>[0]
	> = {},
) {
	return {
		requestId: UUID,
		runId: RUN_ID,
		workflowId: "workflow-trust-spine",
		workflowRevision: "v1",
		unitId: "unit-admit",
		attempt: 1,
		idempotencyKey: "workflow-trust-spine:unit-admit:1",
		repositoryTargetRef: "broker://repositories/trust-spine",
		expectedRepositoryBindingDigest: DIGEST("f"),
		governedPacketRef: "cas://packets/trust-spine/admit",
		governedPacketDigest: DIGEST("2"),
		...overrides,
	};
}

function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new TypeError("fixture number must be finite");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	throw new TypeError("fixture value is not JSON-serializable");
}

function publicKeyDigest(key: KeyObject): string {
	return `sha256:${createHash("sha256")
		.update(key.export({ format: "der", type: "spki" }))
		.digest("hex")}`;
}

function envelope() {
	const candidate = {
		schemaVersion: 3 as const,
		body: {
			workflowId: "workflow-trust-spine",
			workflowRevision: "v1",
			unitId: "unit-admit",
			attempt: 1,
			executionRole: "implementer" as const,
			commitMode: "atomic" as const,
			provenanceRef: "provenance:reviewed-source",
			baseCommitSha: BASE_SHA,
			capabilityBundleDigest: DIGEST("a"),
			acceptanceContractDigest: DIGEST("b"),
			contextManifestDigest: DIGEST("c"),
			workerManifestDigest: DIGEST("d"),
			sandboxProfileDigest: DIGEST("e"),
			budget: { maxTokens: 1000, maxComputeTimeMs: 10_000 },
			trustTier: "governed" as const,
			idempotencyKey: "workflow-trust-spine:unit-admit:1",
			issuedAt: ISSUED_AT,
			expiresAt: EXPIRES_AT,
		},
		actionEvidenceVersion: "sealed_v3" as const,
		repositoryBindingDigest: DIGEST("f"),
		ledgerAuthorityRealmDigest: DIGEST("1"),
		governedPacketDigest: DIGEST("2"),
		envelopeDigest: DIGEST("0"),
	};
	return {
		...candidate,
		envelopeDigest: canonicalDispatchEnvelopeV3Digest(candidate),
	};
}

function signedResponse(
	request: AuthorityBrokerRequestV1,
	privateKey: KeyObject,
	publicKey: KeyObject,
	mutate?: (response: Record<string, unknown>) => void,
): Record<string, unknown> {
	const dispatch = envelope();
	const response: Record<string, unknown> = {
		schema_version: 1,
		operation: request.operation,
		request_id: request.request_id,
		request_digest: request.request_digest,
		response_id: RESPONSE_ID,
		expires_at: EXPIRES_AT,
		envelope: dispatch,
		authority_realm: {
			schema_version: 1,
			realm_digest: dispatch.ledgerAuthorityRealmDigest,
			broker_id: "authority-broker-primary",
		},
		dispatch_event: {
			event_id: EVENT_ID,
			run_id: RUN_ID,
			event_kind: "dispatch_envelope_v3",
			envelope_digest: dispatch.envelopeDigest,
			realm_digest: dispatch.ledgerAuthorityRealmDigest,
			tape_id: "tape:run:123e4567-e89b-12d3-a456-426614174003",
		},
		tape: {
			schema_version: 1,
			tape_id: "tape:run:123e4567-e89b-12d3-a456-426614174003",
			run_id: RUN_ID,
			event_id: EVENT_ID,
			event_kind: "dispatch_envelope_v3",
			envelope_digest: dispatch.envelopeDigest,
			realm_digest: dispatch.ledgerAuthorityRealmDigest,
			tape_root_digest: DIGEST("3"),
		},
		response_signing_identity: {
			algorithm: "ed25519",
			key_id: "authority-broker-test-key",
			public_key_digest: publicKeyDigest(publicKey),
		},
	};
	mutate?.(response);
	return {
		...response,
		response_signature: sign(
			null,
			Buffer.from(canonicalJson(response), "utf8"),
			privateKey,
		).toString("base64"),
	};
}

function replaceSignedResponseEnvelope(
	response: Record<string, unknown>,
	mutate: (body: Record<string, unknown>) => void,
): void {
	const current = response.envelope as Record<string, unknown>;
	const body = { ...(current.body as Record<string, unknown>) };
	mutate(body);
	const candidate = {
		...current,
		body,
	};
	const next = {
		...candidate,
		envelopeDigest: canonicalDispatchEnvelopeV3Digest(candidate),
	};
	response.envelope = next;
	(response.dispatch_event as Record<string, unknown>).envelope_digest =
		next.envelopeDigest;
	(response.tape as Record<string, unknown>).envelope_digest =
		next.envelopeDigest;
}

function createFixtureVerifier() {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	return {
		privateKey,
		publicKey,
		verification: {
			responseSigningKeyId: "authority-broker-test-key",
			responseSigningPublicKey: publicKey,
			responseSigningPublicKeyDigest: publicKeyDigest(publicKey),
		},
	};
}

describe("governed authority broker client", () => {
	it("does not export a runtime managed-transport fixture", async () => {
		const productionModule = await import(
			"../src/governed-authority-broker-client.js"
		);

		expect(productionModule).not.toHaveProperty(
			"__testOnlyCreateAuthorityBrokerClient",
		);
	});

	it("exposes pure request and signed-response verification helpers", async () => {
		const productionModule = await import(
			"../src/governed-authority-broker-client.js"
		);

		expect(productionModule).toHaveProperty(
			"createAuthorityBrokerAdmitRequestV1",
		);
		expect(productionModule).toHaveProperty(
			"createAuthorityBrokerPreauthorizedLookupRequestV1",
		);
		expect(productionModule).toHaveProperty("verifyAuthorityBrokerResponseV1");
	});

	it("accepts a signed admit response bound to its exact closed request", () => {
		const { privateKey, publicKey, verification } = createFixtureVerifier();
		const observed = createAuthorityBrokerAdmitRequestV1(admissionInput());
		const admitted = verifyAuthorityBrokerResponseV1(
			signedResponse(observed, privateKey, publicKey),
			observed,
			verification,
		);

		expect(observed).toMatchObject({
			schema_version: 1,
			operation: "admit",
			request_id: UUID,
			request: {
				run_id: RUN_ID,
				workflow_id: "workflow-trust-spine",
				workflow_revision: "v1",
				unit_id: "unit-admit",
				attempt: 1,
				idempotency_key: "workflow-trust-spine:unit-admit:1",
				repository_target_ref: "broker://repositories/trust-spine",
				expected_repository_binding_digest: DIGEST("f"),
				governed_packet_ref: "cas://packets/trust-spine/admit",
				governed_packet_digest: DIGEST("2"),
			},
		});
		expect(observed?.request_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(admitted.envelope.envelopeDigest).toBe(envelope().envelopeDigest);
		expect(admitted.authorityRealm.realmDigest).toBe(DIGEST("1"));
		expect(admitted.dispatchEvent.eventId).toBe(EVENT_ID);
		expect(admitted.tape.runId).toBe(RUN_ID);
	});

	it("canonicalizes broker requests and responses from descriptor snapshots", () => {
		const { privateKey, publicKey, verification } = createFixtureVerifier();
		let reads = 0;
		const readTrap = <T extends object>(record: T): T =>
			new Proxy(record, {
				get(target, key, receiver) {
					reads += 1;
					return Reflect.get(target, key, receiver);
				},
			});
		const request = createAuthorityBrokerAdmitRequestV1(
			readTrap(admissionInput()),
		);
		const response = signedResponse(request, privateKey, publicKey);
		const hostileResponse = readTrap({
			...response,
			envelope: readTrap(response.envelope as Record<string, unknown>),
			authority_realm: readTrap(
				response.authority_realm as Record<string, unknown>,
			),
			dispatch_event: readTrap(
				response.dispatch_event as Record<string, unknown>,
			),
			tape: readTrap(response.tape as Record<string, unknown>),
			response_signing_identity: readTrap(
				response.response_signing_identity as Record<string, unknown>,
			),
		});

		expect(
			verifyAuthorityBrokerResponseV1(hostileResponse, request, verification),
		).toMatchObject({
			dispatchEvent: { eventId: EVENT_ID },
		});
		expect(reads).toBe(0);
	});

	it("uses the same signed response contract for a preauthorized lookup", () => {
		const { privateKey, publicKey, verification } = createFixtureVerifier();
		const observed = createAuthorityBrokerPreauthorizedLookupRequestV1({
			...admissionInput(),
			preauthorizationRef: "broker://preauthorizations/approved-123",
		});
		const admitted = verifyAuthorityBrokerResponseV1(
			signedResponse(observed, privateKey, publicKey),
			observed,
			verification,
		);

		expect(observed).toMatchObject({
			operation: "lookup_preauthorized",
			request: {
				preauthorization_ref: "broker://preauthorizations/approved-123",
			},
		});
		expect(admitted.dispatchEvent.envelopeDigest).toBe(
			admitted.envelope.envelopeDigest,
		);
	});

	it("rejects unpaired UTF-16 strings before it can generate a broker wire or digest", () => {
		for (const [label, workflowId] of [
			["unmatched high surrogate", "\uD800"],
			["unmatched low surrogate", "\uDC00"],
		] as const) {
			expect(
				() =>
					createAuthorityBrokerAdmitRequestV1(admissionInput({ workflowId })),
				label,
			).toThrow(/non-empty string/i);
		}

		const paired = createAuthorityBrokerAdmitRequestV1(
			admissionInput({ workflowId: "workflow-\uD83D\uDE80" }),
		);
		expect(paired.request.workflow_id).toBe("workflow-\uD83D\uDE80");
		expect(paired.request_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it("rejects caller-selected authority, filesystem, and credential fields during request canonicalization", () => {
		for (const [field, value] of [
			["role", "implementer"],
			["baseSha", BASE_SHA],
			["commitMode", "atomic"],
			["trustTier", "governed"],
			["workspace", process.cwd()],
			["path", process.cwd()],
			["binary", "buildplane-native"],
			["signer", "attacker-key"],
			["key", "attacker-key"],
			["tapeEmitter", {}],
			["credential", "raw-secret"],
		] as const) {
			const input = {
				...admissionInput(),
				[field]: value,
			};
			expect(() => createAuthorityBrokerAdmitRequestV1(input as never)).toThrow(
				new RegExp(`unsupported field ${field}`, "i"),
			);
		}
	});

	it("rejects a path-shaped payload even when it is prefixed as a CAS reference", () => {
		expect(() =>
			createAuthorityBrokerAdmitRequestV1({
				...admissionInput(),
				governedPacketRef: "cas://C:/workspace/packet.json",
			}),
		).toThrow(/opaque cas/i);
	});

	it("rejects a structural fake instead of accepting a caller-created managed transport", () => {
		const fake = {
			kind: "managed-authority-broker-transport-v1",
			invoke: async () => ({}),
		} as unknown as ManagedAuthorityBrokerTransportV1;

		expect(() => createAuthorityBrokerClient(fake)).toThrow(
			/managed authority broker transport provenance/i,
		);
	});

	it("rejects a generic callable from pure response verification options", () => {
		const { privateKey, publicKey, verification } = createFixtureVerifier();
		const request = createAuthorityBrokerAdmitRequestV1(admissionInput());

		expect(() =>
			verifyAuthorityBrokerResponseV1(
				signedResponse(request, privateKey, publicKey),
				request,
				{
					...verification,
					invoke: async () => ({}),
				} as never,
			),
		).toThrow(/unsupported field invoke/i);
	});

	it("fails closed when response request, envelope, realm, event, tape, expiry, or signature integrity diverges", () => {
		const cases: readonly [
			string,
			(response: Record<string, unknown>) => void,
		][] = [
			[
				"request digest",
				(response) => {
					response.request_digest = DIGEST("9");
				},
			],
			[
				"realm agreement",
				(response) => {
					(response.tape as Record<string, unknown>).realm_digest = DIGEST("8");
				},
			],
			[
				"event agreement",
				(response) => {
					(response.dispatch_event as Record<string, unknown>).event_id =
						RESPONSE_ID;
				},
			],
			[
				"expiry",
				(response) => {
					response.expires_at = "2020-01-01T01:00:00.000Z";
				},
			],
			[
				"signing identity",
				(response) => {
					(
						response.response_signing_identity as Record<string, unknown>
					).key_id = "different-authority-key";
				},
			],
		];

		for (const [label, mutate] of cases) {
			const { privateKey, publicKey, verification } = createFixtureVerifier();
			const request = createAuthorityBrokerAdmitRequestV1(admissionInput());
			expect(() =>
				verifyAuthorityBrokerResponseV1(
					signedResponse(request, privateKey, publicKey, mutate),
					request,
					verification,
				),
			).toThrow(new RegExp(label, "i"));
		}
	});

	it("rejects a signed response for a different run even when event and tape agree with each other", () => {
		const { privateKey, publicKey, verification } = createFixtureVerifier();
		const request = createAuthorityBrokerAdmitRequestV1(admissionInput());
		expect(() =>
			verifyAuthorityBrokerResponseV1(
				signedResponse(request, privateKey, publicKey, (response) => {
					(response.dispatch_event as Record<string, unknown>).run_id =
						RESPONSE_ID;
					(response.tape as Record<string, unknown>).run_id = RESPONSE_ID;
				}),
				request,
				verification,
			),
		).toThrow(/run/i);
	});

	it("rejects a signed response with a different idempotency identity", () => {
		const { privateKey, publicKey, verification } = createFixtureVerifier();
		const request = createAuthorityBrokerAdmitRequestV1(admissionInput());
		expect(() =>
			verifyAuthorityBrokerResponseV1(
				signedResponse(request, privateKey, publicKey, (response) => {
					replaceSignedResponseEnvelope(response, (body) => {
						body.idempotencyKey = "different-idempotency-key";
					});
				}),
				request,
				verification,
			),
		).toThrow(/idempotency/i);
	});

	it("rejects a signed response for a different registered repository target", () => {
		const { privateKey, publicKey, verification } = createFixtureVerifier();
		const request = createAuthorityBrokerAdmitRequestV1(admissionInput());
		expect(() =>
			verifyAuthorityBrokerResponseV1(
				signedResponse(request, privateKey, publicKey, (response) => {
					const current = response.envelope as Record<string, unknown>;
					const candidate = {
						...current,
						repositoryBindingDigest: DIGEST("9"),
					};
					const next = {
						...candidate,
						envelopeDigest: canonicalDispatchEnvelopeV3Digest(candidate),
					};
					response.envelope = next;
					(response.dispatch_event as Record<string, unknown>).envelope_digest =
						next.envelopeDigest;
					(response.tape as Record<string, unknown>).envelope_digest =
						next.envelopeDigest;
				}),
				request,
				verification,
			),
		).toThrow(/registered repository target/i);
	});

	it("deep-freezes the signed admission envelope before returning it", () => {
		const { privateKey, publicKey, verification } = createFixtureVerifier();
		const request = createAuthorityBrokerAdmitRequestV1(admissionInput());
		const admitted = verifyAuthorityBrokerResponseV1(
			signedResponse(request, privateKey, publicKey),
			request,
			verification,
		);

		expect(Object.isFrozen(admitted.envelope)).toBe(true);
		expect(Object.isFrozen(admitted.envelope.body)).toBe(true);
		expect(Object.isFrozen(admitted.envelope.body.budget)).toBe(true);
		expect(() => {
			(admitted.envelope.body.budget as { maxTokens?: number }).maxTokens = 0;
		}).toThrow();
		expect(admitted.envelope.body.budget.maxTokens).toBe(1000);
	});

	it("rejects a signature tampered after broker signing", () => {
		const { privateKey, publicKey, verification } = createFixtureVerifier();
		const request = createAuthorityBrokerAdmitRequestV1(admissionInput());
		const response = signedResponse(request, privateKey, publicKey);
		response.response_signature = Buffer.from("tampered").toString("base64");

		expect(() =>
			verifyAuthorityBrokerResponseV1(response, request, verification),
		).toThrow(/signature/i);
	});
});
