import { createHash } from "node:crypto";
import {
	bundleDigest,
	CAPABILITY_BUNDLE_SCHEMA_VERSION,
} from "@buildplane/capability-broker";
import {
	canonicalDispatchEnvelopeV3Digest,
	canonicalDispatchEnvelopeV4Digest,
	canonicalGovernedUnitPacketV1Digest,
	canonicalWorkflowGraphV2Digest,
	compileGovernedWorkflowGraphV2,
	type DispatchEnvelopeV3,
	type DispatchEnvelopeV4,
	type ExecutionRoleV1,
	parseDispatchEnvelopeV3,
	parseDispatchEnvelopeV4,
	parseWorkflowGraphDeclaredV2,
	type UnitGraph,
} from "@buildplane/kernel";
import { describe, expect, it } from "vitest";

const digest = (hex: string): string => `sha256:${hex.repeat(64)}`;

const eventRef = "018f1c7a-51c0-7000-8000-000000000001";

function nativeDigest(domain: string, value: unknown): string {
	return `sha256:${createHash("sha256")
		.update(domain, "utf8")
		.update(JSON.stringify(value), "utf8")
		.digest("hex")}`;
}

function packet(
	unitId: string,
	executionRole: ExecutionRoleV1 = "implementer",
): Record<string, unknown> {
	const capabilityBundle = {
		schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
		bundleId: `graph-${unitId}`,
		fsWrite: ["src/**"],
		tools: { run_command: { allowlist: ["echo"] } },
	};
	return {
		unit: {
			id: unitId,
			kind: "implementation",
			scope: "repo",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "verify",
			policyProfile: "governed",
		},
		execution_role: executionRole,
		execution: { command: "echo", args: [unitId] },
		verification: { requiredOutputs: [] },
		provenance_ref: `admission:${unitId}`,
		capability_bundle: capabilityBundle,
		capability_bundle_digest: bundleDigest(capabilityBundle),
		acceptance_contract: {
			schemaVersion: 1,
			contract_version: "v0",
			diff_scope: { allowed_globs: ["src/**"] },
			checks: [{ command: "echo verify" }],
		},
		trust_scope: {
			schemaVersion: 1,
			lane: "governed",
			principal: "kernel:test",
			scope: "graph-v4",
		},
	};
}

function dispatchV3(
	unitId: string,
	governedPacketDigest = digest("a"),
	executionRole: ExecutionRoleV1 = "implementer",
): DispatchEnvelopeV3 {
	const draft = {
		schemaVersion: 3 as const,
		body: {
			workflowId: "workflow-v4",
			workflowRevision: "r1",
			unitId,
			attempt: 1,
			executionRole,
			commitMode: "atomic" as const,
			provenanceRef: "admission:workflow-v4",
			baseCommitSha: "1".repeat(40),
			capabilityBundleDigest: digest("b"),
			acceptanceContractDigest: digest("c"),
			contextManifestDigest: digest("d"),
			workerManifestDigest: digest("e"),
			sandboxProfileDigest: digest("f"),
			budget: { maxTokens: 100, maxComputeTimeMs: 1_000 },
			trustTier: "governed" as const,
			idempotencyKey: `dispatch:workflow-v4:${unitId}:1`,
			issuedAt: "2026-07-19T00:01:00Z",
			expiresAt: "2026-07-19T01:01:00Z",
		},
		actionEvidenceVersion: "sealed_v3" as const,
		repositoryBindingDigest: digest("8"),
		ledgerAuthorityRealmDigest: digest("9"),
		governedPacketDigest,
	};
	return parseDispatchEnvelopeV3({
		...draft,
		envelopeDigest: canonicalDispatchEnvelopeV3Digest(draft),
	});
}

function graphDeclaration() {
	const draft = {
		runId: "run-v4",
		workflowId: "workflow-v4",
		workflowRevision: "r1",
		nodes: [
			{
				unitId: "unit-a",
				dependsOn: [],
				executionRole: "implementer" as const,
				governedPacketDigest: digest("a"),
			},
		],
		maxConcurrent: 1,
		idempotencyKey: "graph-v2:workflow-v4:r1",
		declaredAt: "2026-07-19T00:00:00Z",
	};
	return parseWorkflowGraphDeclaredV2({
		...draft,
		graphDigest: canonicalWorkflowGraphV2Digest(draft),
	});
}

describe("graph-bound V4 dispatch contracts", () => {
	it("parses a V4 envelope only when its complete nested V3 and graph binding digest match native snake_case bytes", () => {
		const dispatchV3Value = dispatchV3("unit-a");
		const graph = graphDeclaration();
		const draft = {
			schemaVersion: 4 as const,
			dispatchV3: dispatchV3Value,
			workflowGraphDigest: graph.graphDigest,
			workflowGraphDeclarationEventRef: eventRef,
		};
		const envelope: DispatchEnvelopeV4 = parseDispatchEnvelopeV4({
			...draft,
			envelopeDigest: canonicalDispatchEnvelopeV4Digest(draft),
		});

		expect(envelope.envelopeDigest).toBe(
			nativeDigest("buildplane.dispatch-envelope.v4\0", {
				dispatch_v3: {
					body: {
						workflow_id: "workflow-v4",
						workflow_revision: "r1",
						unit_id: "unit-a",
						attempt: 1,
						execution_role: "implementer",
						commit_mode: "atomic",
						provenance_ref: "admission:workflow-v4",
						base_commit_sha: "1".repeat(40),
						capability_bundle_digest: digest("b"),
						acceptance_contract_digest: digest("c"),
						context_manifest_digest: digest("d"),
						worker_manifest_digest: digest("e"),
						sandbox_profile_digest: digest("f"),
						budget: { max_tokens: 100, max_compute_time_ms: 1_000 },
						trust_tier: "governed",
						idempotency_key: "dispatch:workflow-v4:unit-a:1",
						issued_at: "2026-07-19T00:01:00Z",
						expires_at: "2026-07-19T01:01:00Z",
					},
					action_evidence_version: "sealed_v3",
					repository_binding_digest: digest("8"),
					ledger_authority_realm_digest: digest("9"),
					governed_packet_digest: digest("a"),
					envelope_digest: dispatchV3Value.envelopeDigest,
				},
				workflow_graph_digest: graph.graphDigest,
				workflow_graph_declaration_event_ref: eventRef,
			}),
		);
		expect(() => parseDispatchEnvelopeV3(envelope)).toThrow(
			/unknown field "dispatchV3"/i,
		);
	});

	it("rejects a V4 graph binding with a malformed event reference, an invalid nested lane, or a substituted outer digest", () => {
		const graph = graphDeclaration();
		const draft = {
			schemaVersion: 4 as const,
			dispatchV3: dispatchV3("unit-a"),
			workflowGraphDigest: graph.graphDigest,
			workflowGraphDeclarationEventRef: eventRef,
		};
		const envelope = {
			...draft,
			envelopeDigest: canonicalDispatchEnvelopeV4Digest(draft),
		};

		expect(() =>
			parseDispatchEnvelopeV4({
				...envelope,
				workflowGraphDeclarationEventRef: "not-a-uuid",
			}),
		).toThrow(/workflowGraphDeclarationEventRef/i);
		expect(() =>
			parseDispatchEnvelopeV4({
				...envelope,
				dispatchV3: {
					...envelope.dispatchV3,
					body: { ...envelope.dispatchV3.body, trustTier: "raw" },
				},
			}),
		).toThrow(/canonical V3 body digest|governed atomic sealed_v3/i);
		expect(() =>
			parseDispatchEnvelopeV4({ ...envelope, envelopeDigest: digest("0") }),
		).toThrow(/canonical V4/i);
		expect(() =>
			parseDispatchEnvelopeV4({ ...envelope, unexpected: true }),
		).toThrow(/unknown field/i);
	});

	it("accepts native-compatible nanosecond authority timestamps without collapsing their order", () => {
		expect(() => {
			const graph = graphDeclaration();
			const base = dispatchV3("unit-a");
			const dispatchV3Draft = {
				schemaVersion: 3 as const,
				body: {
					...base.body,
					issuedAt: "2026-07-19T00:01:00.123456789Z",
					expiresAt: "2026-07-19T00:01:00.123456790Z",
				},
				actionEvidenceVersion: base.actionEvidenceVersion,
				repositoryBindingDigest: base.repositoryBindingDigest,
				ledgerAuthorityRealmDigest: base.ledgerAuthorityRealmDigest,
				governedPacketDigest: base.governedPacketDigest,
			};
			const dispatchV3Value = parseDispatchEnvelopeV3({
				...dispatchV3Draft,
				envelopeDigest: canonicalDispatchEnvelopeV3Digest(dispatchV3Draft),
			});
			const envelopeDraft = {
				schemaVersion: 4 as const,
				dispatchV3: dispatchV3Value,
				workflowGraphDigest: graph.graphDigest,
				workflowGraphDeclarationEventRef: eventRef,
			};

			parseDispatchEnvelopeV4({
				...envelopeDraft,
				envelopeDigest: canonicalDispatchEnvelopeV4Digest(envelopeDraft),
			});
		}).not.toThrow();
	});

	it("rejects V4 authority timestamps more precise than native nanoseconds", () => {
		const graph = graphDeclaration();
		const base = dispatchV3("unit-a");
		const dispatchV3Draft = {
			schemaVersion: 3 as const,
			body: {
				...base.body,
				issuedAt: "2026-07-19T00:01:00.1234567890Z",
				expiresAt: "2026-07-19T00:01:00.1234567891Z",
			},
			actionEvidenceVersion: base.actionEvidenceVersion,
			repositoryBindingDigest: base.repositoryBindingDigest,
			ledgerAuthorityRealmDigest: base.ledgerAuthorityRealmDigest,
			governedPacketDigest: base.governedPacketDigest,
		};
		const dispatchV3Value = parseDispatchEnvelopeV3({
			...dispatchV3Draft,
			envelopeDigest: canonicalDispatchEnvelopeV3Digest(dispatchV3Draft),
		});
		const envelope = {
			schemaVersion: 4 as const,
			dispatchV3: dispatchV3Value,
			workflowGraphDigest: graph.graphDigest,
			workflowGraphDeclarationEventRef: eventRef,
			envelopeDigest: digest("0"),
		};

		expect(() => parseDispatchEnvelopeV4(envelope)).toThrow(
			/fractional seconds.*at most 9 digits/i,
		);
	});

	it("rejects V4 nested V3 fields that overflow native u32 limits", () => {
		const graph = graphDeclaration();
		const base = dispatchV3("unit-a");
		const overflow = 0x1_0000_0000;
		const bodies = [
			{ ...base.body, attempt: overflow },
			{
				...base.body,
				budget: { ...base.body.budget, maxTokens: overflow },
			},
			{
				...base.body,
				budget: { ...base.body.budget, maxComputeTimeMs: overflow },
			},
		];

		for (const body of bodies) {
			const envelope = {
				schemaVersion: 4 as const,
				dispatchV3: { ...base, body },
				workflowGraphDigest: graph.graphDigest,
				workflowGraphDeclarationEventRef: eventRef,
				envelopeDigest: digest("0"),
			};

			expect(() => parseDispatchEnvelopeV4(envelope)).toThrow(
				/positive u32 integer/i,
			);
		}
	});

	it("rejects graph V2 declarations with noncanonical topology, roles, packet digests, references, cycles, concurrency, or graph digest", () => {
		const graph = graphDeclaration();
		const invalid = [
			{
				...graph,
				nodes: [...graph.nodes, { ...graph.nodes[0], unitId: "unit-a" }],
			},
			{
				...graph,
				nodes: [
					{ ...graph.nodes[0], unitId: "unit-b", dependsOn: ["unit-a"] },
					{ ...graph.nodes[0], unitId: "unit-a" },
				],
			},
			{
				...graph,
				nodes: [
					{ ...graph.nodes[0], unitId: "unit-a" },
					{
						...graph.nodes[0],
						unitId: "unit-b",
						dependsOn: ["unit-a", "unit-a"],
					},
				],
			},
			{
				...graph,
				nodes: [
					{ ...graph.nodes[0], unitId: "unit-a" },
					{
						...graph.nodes[0],
						unitId: "unit-b",
						dependsOn: ["unit-c", "unit-a"],
					},
				],
			},
			{
				...graph,
				nodes: [{ ...graph.nodes[0], dependsOn: ["unit-a"] }],
			},
			{
				...graph,
				nodes: [{ ...graph.nodes[0], dependsOn: ["unit-b"] }],
			},
			{
				...graph,
				nodes: [
					{ ...graph.nodes[0], dependsOn: ["unit-b"] },
					{
						...graph.nodes[0],
						unitId: "unit-b",
						dependsOn: ["unit-a"],
					},
				],
			},
			{
				...graph,
				nodes: [{ ...graph.nodes[0], executionRole: "operator" }],
			},
			{
				...graph,
				nodes: [{ ...graph.nodes[0], governedPacketDigest: "not-a-digest" }],
			},
			{ ...graph, maxConcurrent: 0 },
			{ ...graph, maxConcurrent: 1.5 },
			{ ...graph, graphDigest: digest("0") },
			{ ...graph, unexpected: true },
		];

		for (const declaration of invalid) {
			expect(() => parseWorkflowGraphDeclaredV2(declaration)).toThrow();
		}
	});

	it("rejects non-BMP graph unit and dependency identifiers before lexical ordering can diverge from native UTF-8 ordering", () => {
		const graph = graphDeclaration();

		expect(() =>
			parseWorkflowGraphDeclaredV2({
				...graph,
				nodes: [{ ...graph.nodes[0], unitId: "unit-😀" }],
			}),
		).toThrow(/ASCII/i);
		expect(() =>
			parseWorkflowGraphDeclaredV2({
				...graph,
				nodes: [
					{ ...graph.nodes[0], unitId: "unit-a" },
					{
						...graph.nodes[0],
						unitId: "unit-b",
						dependsOn: ["unit-😀"],
					},
				],
			}),
		).toThrow(/ASCII/i);

		const nonBmpPacket = packet("unit-😀");
		expect(() =>
			compileGovernedWorkflowGraphV2({
				runId: "run-v4",
				workflowId: "workflow-v4",
				workflowRevision: "r1",
				graph: { nodes: [nonBmpPacket as never] },
				declaredAt: "2026-07-19T00:00:00Z",
			}),
		).toThrow(/ASCII/i);
	});

	it("derives graph node packet digests and execution roles from packets before canonicalizing a UnitGraph", () => {
		const packetA = packet("unit-a");
		const packetB = packet("unit-b", "reviewer");
		const graph: UnitGraph = {
			maxConcurrent: 2,
			nodes: [
				{ ...packetB, dependsOn: ["unit-a"] } as never,
				{ ...packetA } as never,
			],
		};

		const compiled = compileGovernedWorkflowGraphV2({
			runId: "run-v4",
			workflowId: "workflow-v4",
			workflowRevision: "r1",
			graph,
			declaredAt: "2026-07-19T00:00:00Z",
		});

		expect(compiled.nodes.map((node) => node.unitId)).toEqual([
			"unit-a",
			"unit-b",
		]);
		expect(compiled.nodes[1]).toMatchObject({
			executionRole: "reviewer",
			governedPacketDigest: canonicalGovernedUnitPacketV1Digest(packetB),
		});
		expect(compiled.graphDigest).toBe(
			nativeDigest("buildplane.workflow-graph.v2\0", {
				run_id: "run-v4",
				workflow_id: "workflow-v4",
				workflow_revision: "r1",
				nodes: compiled.nodes.map((node) => ({
					unit_id: node.unitId,
					depends_on: node.dependsOn,
					execution_role: node.executionRole,
					governed_packet_digest: node.governedPacketDigest,
				})),
				max_concurrent: 2,
			}),
		);
		expect(parseWorkflowGraphDeclaredV2(compiled)).toEqual(compiled);
	});

	it("commits every governance-bearing packet surface through graph persistence into the V4 dispatch binding", () => {
		const base = packet("unit-a");
		const modelPacket = { ...base };
		delete modelPacket.execution;
		const alternateBundle = {
			schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
			bundleId: "graph-unit-a-alternate",
			fsWrite: ["lib/**"],
			tools: { run_command: { allowlist: ["printf"] } },
		};
		const variants: readonly {
			readonly name: string;
			readonly value: Record<string, unknown>;
			readonly role: ExecutionRoleV1;
		}[] = [
			{
				name: "unit definition",
				value: {
					...base,
					unit: {
						...(base.unit as Record<string, unknown>),
						expectedOutputs: ["changed-output"],
					},
				},
				role: "implementer",
			},
			{
				name: "signed execution role",
				value: { ...base, execution_role: "reviewer" },
				role: "reviewer",
			},
			{
				name: "execution request",
				value: {
					...base,
					execution: { command: "echo", args: ["unit-a", "changed"] },
				},
				role: "implementer",
			},
			{
				name: "model request",
				value: {
					...modelPacket,
					model: {
						provider: "openai",
						model: "gpt-5",
						prompt: "make the governed change",
					},
				},
				role: "implementer",
			},
			{
				name: "task intent",
				value: {
					...base,
					intent: {
						objective: "make the governed change",
						taskType: "implement",
						context: { files: ["src/governed.ts"] },
						constraints: {
							scope: ["src/**"],
							verification: ["pnpm test"],
						},
						features: {
							ambiguity: "low",
							reversibility: "high",
							verifierStrength: "strong",
						},
					},
				},
				role: "implementer",
			},
			{
				name: "routing hints",
				value: {
					...base,
					routingHints: {
						preferredWorker: "codex",
						preferredModel: "gpt-5",
						effort: "high",
					},
				},
				role: "implementer",
			},
			{
				name: "verification contract",
				value: {
					...base,
					verification: { requiredOutputs: ["changed-output"] },
				},
				role: "implementer",
			},
			{
				name: "provenance reference",
				value: { ...base, provenance_ref: "admission:unit-a:changed" },
				role: "implementer",
			},
			{
				name: "capability bundle",
				value: {
					...base,
					capability_bundle: alternateBundle,
					capability_bundle_digest: bundleDigest(alternateBundle),
				},
				role: "implementer",
			},
			{
				name: "acceptance contract",
				value: {
					...base,
					acceptance_contract: {
						schemaVersion: 1,
						contract_version: "v0",
						diff_scope: { allowed_globs: ["lib/**"] },
						checks: [{ command: "printf verify" }],
					},
				},
				role: "implementer",
			},
			{
				name: "trust scope",
				value: {
					...base,
					trust_scope: {
						schemaVersion: 1,
						lane: "governed",
						principal: "kernel:changed",
						scope: "graph-v4:changed",
					},
				},
				role: "implementer",
			},
		];

		const compile = (value: Record<string, unknown>) =>
			compileGovernedWorkflowGraphV2({
				runId: "run-v4",
				workflowId: "workflow-v4",
				workflowRevision: "r1",
				graph: { nodes: [value as never] },
				declaredAt: "2026-07-19T00:00:00Z",
			});
		const baseline = compile(base);
		const baselinePacketDigest = baseline.nodes[0]?.governedPacketDigest;
		expect(baselinePacketDigest).toBe(
			canonicalGovernedUnitPacketV1Digest(base),
		);

		for (const variant of variants) {
			const compiled = compile(variant.value);
			const node = compiled.nodes[0];
			expect(node, variant.name).toMatchObject({
				unitId: "unit-a",
				executionRole: variant.role,
				governedPacketDigest: canonicalGovernedUnitPacketV1Digest(
					variant.value,
				),
			});
			expect(node?.governedPacketDigest, variant.name).not.toBe(
				baselinePacketDigest,
			);
			expect(compiled.graphDigest, variant.name).not.toBe(baseline.graphDigest);
			expect(parseWorkflowGraphDeclaredV2(compiled), variant.name).toEqual(
				compiled,
			);

			const nestedDispatch = dispatchV3(
				"unit-a",
				node?.governedPacketDigest,
				variant.role,
			);
			const v4Draft = {
				schemaVersion: 4 as const,
				dispatchV3: nestedDispatch,
				workflowGraphDigest: compiled.graphDigest,
				workflowGraphDeclarationEventRef: eventRef,
			};
			const v4 = parseDispatchEnvelopeV4({
				...v4Draft,
				envelopeDigest: canonicalDispatchEnvelopeV4Digest(v4Draft),
			});
			expect(v4.dispatchV3.governedPacketDigest, variant.name).toBe(
				node?.governedPacketDigest,
			);
			expect(v4.workflowGraphDigest, variant.name).toBe(compiled.graphDigest);
		}
	});

	it("rejects an unversioned or augmented nested governance record before graph packet digesting", () => {
		const valid = packet("unit-a");
		for (const node of [
			{
				...valid,
				acceptance_contract: {
					contract_version: "v0",
					diff_scope: { allowed_globs: ["src/**"] },
					checks: [{ command: "echo verify" }],
				},
			},
			{
				...valid,
				trust_scope: {
					...(valid.trust_scope as Record<string, unknown>),
					injected: true,
				},
			},
		]) {
			expect(() =>
				compileGovernedWorkflowGraphV2({
					runId: "run-v4",
					workflowId: "workflow-v4",
					workflowRevision: "r1",
					graph: { nodes: [node as never] },
					declaredAt: "2026-07-19T00:00:00Z",
				}),
			).toThrow(/strictly admitted governed packet/i);
		}
	});
});
