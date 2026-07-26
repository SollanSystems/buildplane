import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({
	spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawnSync: childProcess.spawnSync,
}));

const { requestGovernedV5Admission } = await import(
	"../src/governed-v5-admission-client.js"
);

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const requestId = "01919000-0000-7000-8000-000000000081";
const runId = "01919000-0000-7000-8000-000000000082";
const envelopeDigest =
	"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		configurable: true,
		value: platform,
	});
}

function evidence() {
	return {
		run_id: runId,
		source_dispatch_event_id: "01919000-0000-7000-8000-000000000083",
		source_dispatch_event_digest:
			"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		admission_event_id: "01919000-0000-7000-8000-000000000084",
		admission_event_digest:
			"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		v5_envelope_digest: envelopeDigest,
		witness_evidence_digest:
			"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
		semantic_identity_digest:
			"sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
		idempotency_key: "admit-v5:test",
		checkpoint_event_id: "01919000-0000-7000-8000-000000000085",
		checkpoint_event_digest:
			"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
	};
}

function response(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schema_version: 1,
		protocol: "buildplane-v5-dispatch-admission",
		domain: "protected-authority-response",
		request_id: requestId,
		run_id: runId,
		v5_envelope_digest: envelopeDigest,
		status: "sealed",
		evidence: evidence(),
		signature: "ab".repeat(64),
		...overrides,
	};
}

function nativeResult(overrides: Record<string, unknown> = {}) {
	return {
		error: undefined,
		signal: null,
		status: 0,
		stderr: "",
		stdout: `${JSON.stringify(response())}\n`,
		...overrides,
	};
}

beforeEach(() => {
	childProcess.spawnSync.mockReset();
	setPlatform("linux");
});

afterAll(() => {
	if (originalPlatform) {
		Object.defineProperty(process, "platform", originalPlatform);
	}
});

describe("governed V5 admission native client", () => {
	it("uses only the installed no-argument client with exact closed stdin and no ambient environment", async () => {
		childProcess.spawnSync.mockReturnValue(nativeResult());

		await expect(
			requestGovernedV5Admission({
				requestId,
				runId,
				v5EnvelopeDigest: envelopeDigest,
			}),
		).resolves.toMatchObject({ status: "sealed", evidence: evidence() });

		expect(childProcess.spawnSync).toHaveBeenCalledWith(
			"/usr/libexec/buildplane/buildplane-v5-dispatch-admission-client",
			[],
			{
				input: JSON.stringify({
					request_id: requestId,
					run_id: runId,
					v5_envelope_digest: envelopeDigest,
				}),
				encoding: "utf8",
				env: {},
				shell: false,
				timeout: 10_000,
				maxBuffer: 16 * 1024,
				windowsHide: true,
			},
		);
	});

	it("accepts reconciliation only with null evidence", async () => {
		childProcess.spawnSync.mockReturnValue(
			nativeResult({
				stdout: `${JSON.stringify(
					response({
						status: "reconciliation_required",
						evidence: null,
					}),
				)}\n`,
			}),
		);

		await expect(
			requestGovernedV5Admission({
				requestId,
				runId,
				v5EnvelopeDigest: envelopeDigest,
			}),
		).resolves.toMatchObject({
			status: "reconciliation_required",
			evidence: null,
		});
	});

	it.each([
		{
			label: "unknown response field",
			mutate: () => response({ extra: true }),
		},
		{
			label: "unknown evidence field",
			mutate: () =>
				response({ evidence: { ...evidence(), authority: "attacker" } }),
		},
		{
			label: "sealed without evidence",
			mutate: () => response({ evidence: null }),
		},
		{
			label: "reconciliation with evidence",
			mutate: () => response({ status: "reconciliation_required" }),
		},
		{
			label: "request substitution",
			mutate: () =>
				response({ request_id: "01919000-0000-7000-8000-000000000099" }),
		},
		{
			label: "run substitution",
			mutate: () =>
				response({ run_id: "01919000-0000-7000-8000-000000000099" }),
		},
		{
			label: "digest substitution",
			mutate: () =>
				response({
					v5_envelope_digest:
						"sha256:9999999999999999999999999999999999999999999999999999999999999999",
				}),
		},
		{
			label: "noncanonical signature",
			mutate: () => response({ signature: "AB".repeat(64) }),
		},
		{
			label: "noncanonical evidence UUID",
			mutate: () =>
				response({
					evidence: {
						...evidence(),
						admission_event_id: "01919000-0000-7000-8000-00000000008A",
					},
				}),
		},
		{
			label: "invalid idempotency",
			mutate: () =>
				response({
					evidence: { ...evidence(), idempotency_key: "bad\nkey" },
				}),
		},
	] as const)("blocks $label", async ({ mutate }) => {
		childProcess.spawnSync.mockReturnValue(
			nativeResult({ stdout: `${JSON.stringify(mutate())}\n` }),
		);
		await expect(
			requestGovernedV5Admission({
				requestId,
				runId,
				v5EnvelopeDigest: envelopeDigest,
			}),
		).resolves.toBeUndefined();
	});

	it.each([
		{ stderr: "client_blocked\n" },
		{ status: 1 },
		{ signal: "SIGTERM" },
		{ error: new Error("spawn failed") },
		{ stdout: "not-json\n" },
	])("blocks a failed or malformed client result %#", async (override) => {
		childProcess.spawnSync.mockReturnValue(nativeResult(override));
		await expect(
			requestGovernedV5Admission({
				requestId,
				runId,
				v5EnvelopeDigest: envelopeDigest,
			}),
		).resolves.toBeUndefined();
	});

	it.each([
		["win32", requestId, runId, envelopeDigest],
		["linux", "01919000-0000-7000-8000-00000000008A", runId, envelopeDigest],
		["linux", requestId, "not-a-run", envelopeDigest],
		["linux", requestId, runId, "sha256:BAD"],
	] as const)("does not spawn for unsupported or noncanonical input", async (platform, request, run, digest) => {
		childProcess.spawnSync.mockClear();
		setPlatform(platform);
		await expect(
			requestGovernedV5Admission({
				requestId: request,
				runId: run,
				v5EnvelopeDigest: digest,
			}),
		).resolves.toBeUndefined();
		expect(childProcess.spawnSync).not.toHaveBeenCalled();
	});
});
