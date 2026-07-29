import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({
	spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawnSync: childProcess.spawnSync,
}));

const hostBroker = await import("../src/governed-authority-broker-host.js");

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const projectRoot = "/srv/buildplane/repositories/example";
const recoveryRef = "host-recovery/session-0001";
const sessionRef = "host-session/session-0001";

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		configurable: true,
		value: platform,
	});
}

function nativeResult(payload: unknown) {
	return {
		error: undefined,
		signal: null,
		status: 0,
		stderr: "",
		stdout: `${JSON.stringify(payload)}\n`,
	};
}

function capturedRequest(operation: string): Record<string, unknown> {
	for (const call of childProcess.spawnSync.mock.calls) {
		const request = JSON.parse(call[2].input);
		if (request.operation === operation) return request;
	}
	throw new Error(`missing captured ${operation} request`);
}

function respondToRequest(request: Record<string, unknown>) {
	const operation = request.operation;
	if (operation === "probe") {
		return nativeResult({
			schema_version: 1,
			protocol: "buildplane-governed-session",
			request_id: request.request_id,
			operation,
			status: "ready",
			recovery_ref: null,
			session_ref: null,
			result: {
				operations: [
					"open_candidate_session",
					"open_recovery_session",
					"run_candidate_session",
					"open_reviewer_session",
					"run_reviewer_session",
				],
			},
		});
	}
	if (
		operation === "open_candidate_session" ||
		operation === "open_recovery_session" ||
		operation === "open_reviewer_session"
	) {
		return nativeResult({
			schema_version: 1,
			protocol: "buildplane-governed-session",
			request_id: request.request_id,
			operation,
			status: "opened",
			recovery_ref: recoveryRef,
			session_ref: sessionRef,
			result: null,
		});
	}
	const result =
		operation === "run_candidate_session"
			? {
					kind: "host-owned-governed-candidate-run-result-v1",
					recoveryRef,
					candidateReceipt: { schemaVersion: 2, recoveryRef },
				}
			: {
					kind: "host-owned-governed-reviewer-run-result-v1",
					recoveryRef,
					reviewReceipt: { schemaVersion: 1, recoveryRef },
				};
	return nativeResult({
		schema_version: 1,
		protocol: "buildplane-governed-session",
		request_id: request.request_id,
		operation,
		status: "completed",
		recovery_ref: recoveryRef,
		session_ref: sessionRef,
		result,
	});
}

beforeEach(() => {
	childProcess.spawnSync.mockReset();
	setPlatform("linux");
	childProcess.spawnSync.mockImplementation(
		(_path: string, _args: readonly string[], options: { input: string }) => {
			return respondToRequest(JSON.parse(options.input));
		},
	);
});

afterAll(() => {
	if (originalPlatform) {
		Object.defineProperty(process, "platform", originalPlatform);
	}
});

describe("protected governed session client", () => {
	it("exposes no broker capability unless the installed client proves a ready protected host", async () => {
		childProcess.spawnSync.mockReturnValueOnce({
			error: undefined,
			signal: null,
			status: 1,
			stderr: "client_blocked\n",
			stdout: "",
		});
		await expect(
			hostBroker.resolveHostOwnedGovernedBroker(),
		).resolves.toBeUndefined();
		expect(childProcess.spawnSync).toHaveBeenCalledTimes(1);
		const probe = JSON.parse(childProcess.spawnSync.mock.calls[0]?.[2].input);
		expect(Object.keys(probe).sort()).toEqual(
			["operation", "protocol", "request_id", "schema_version"].sort(),
		);
		expect(probe.operation).toBe("probe");
	});

	it("opens and runs one candidate-only session through the fixed native client", async () => {
		const broker = await hostBroker.resolveHostOwnedGovernedBroker();
		expect(broker).toBeDefined();
		expect(hostBroker.isProtectedHostOwnedGovernedBroker(broker)).toBe(true);
		expect(
			hostBroker.isProtectedHostOwnedGovernedBroker({
				kind: "host-owned-governed-broker-v1",
			}),
		).toBe(false);

		const session = await broker?.openCandidateSession({
			kind: "new-candidate",
			packetSource: '{"schema_version":1}',
			projectRoot,
			approval: "operator-requested",
		});
		expect(session).toMatchObject({
			kind: "host-owned-governed-candidate-session-v1",
			recoveryRef,
		});

		const result = await session?.run();
		expect(result).toMatchObject({
			kind: "host-owned-governed-candidate-run-result-v1",
			recoveryRef,
		});
		expect(childProcess.spawnSync).toHaveBeenCalledTimes(3);
		for (const call of childProcess.spawnSync.mock.calls) {
			expect(call[0]).toBe(
				"/usr/libexec/buildplane/buildplane-governed-session-client",
			);
			expect(call[1]).toEqual([]);
			expect(call[2]).toMatchObject({
				encoding: "utf8",
				env: {},
				shell: false,
				timeout: 10_000,
				maxBuffer: 1024 * 1024,
				windowsHide: true,
			});
		}
		const openRequest = capturedRequest("open_candidate_session");
		expect(openRequest).toMatchObject({
			schema_version: 1,
			protocol: "buildplane-governed-session",
			operation: "open_candidate_session",
			packet_source: '{"schema_version":1}',
			project_root: projectRoot,
			approval: { kind: "operator_requested" },
		});
		expect(Object.keys(openRequest).sort()).toEqual(
			[
				"approval",
				"operation",
				"packet_source",
				"project_root",
				"protocol",
				"request_id",
				"schema_version",
			].sort(),
		);
	});

	it("opens and runs a reviewer-only session using only the recovery reference", async () => {
		const broker = await hostBroker.resolveHostOwnedGovernedBroker();
		const session = await broker?.openReviewerSession({
			kind: "governed-reviewer-session-open-v1",
			schemaVersion: 1,
			projectRoot,
			recoveryReference: recoveryRef,
		});
		await expect(session?.run()).resolves.toMatchObject({
			kind: "host-owned-governed-reviewer-run-result-v1",
			recoveryRef,
		});

		const request = capturedRequest("open_reviewer_session");
		expect(request).toMatchObject({
			schema_version: 1,
			protocol: "buildplane-governed-session",
			operation: "open_reviewer_session",
			project_root: projectRoot,
			recovery_ref: recoveryRef,
		});
		expect(request).not.toHaveProperty("run_id");
		expect(request).not.toHaveProperty("reviewer_dispatch_event_ref");
		expect(request).not.toHaveProperty("reviewer_action_request_event_ref");
	});

	it("opens recovery without accepting replacement packet or envelope authority", async () => {
		const broker = await hostBroker.resolveHostOwnedGovernedBroker();
		await broker?.openRecoverySession({
			projectRoot,
			recoveryReference: recoveryRef,
			approval: "operator-requested",
		});
		const request = capturedRequest("open_recovery_session");
		expect(Object.keys(request).sort()).toEqual(
			[
				"approval",
				"operation",
				"project_root",
				"protocol",
				"recovery_ref",
				"request_id",
				"schema_version",
			].sort(),
		);
	});

	it("fails closed on unsupported platforms, malformed native output, and identity substitution", async () => {
		setPlatform("win32");
		await expect(
			hostBroker.resolveHostOwnedGovernedBroker(),
		).resolves.toBeUndefined();
		expect(childProcess.spawnSync).not.toHaveBeenCalled();

		setPlatform("linux");
		const broker = await hostBroker.resolveHostOwnedGovernedBroker();
		childProcess.spawnSync.mockReturnValueOnce(
			nativeResult({ status: "opened" }),
		);
		await expect(
			broker?.openReviewerSession({
				kind: "governed-reviewer-session-open-v1",
				schemaVersion: 1,
				projectRoot,
				recoveryReference: recoveryRef,
			}),
		).rejects.toThrow(/protected governed session client/i);

		childProcess.spawnSync.mockImplementationOnce(
			(_path: string, _args: readonly string[], options: { input: string }) => {
				const request = JSON.parse(options.input);
				return nativeResult({
					schema_version: 1,
					protocol: "buildplane-governed-session",
					request_id: request.request_id,
					operation: request.operation,
					status: "opened",
					recovery_ref: "host-recovery/substituted",
					session_ref: sessionRef,
					result: null,
				});
			},
		);
		await expect(
			broker?.openReviewerSession({
				kind: "governed-reviewer-session-open-v1",
				schemaVersion: 1,
				projectRoot,
				recoveryReference: recoveryRef,
			}),
		).rejects.toThrow(/recovery/i);
	});

	it("rejects unknown input fields, unsafe roots, and oversized source before spawning", async () => {
		const broker = await hostBroker.resolveHostOwnedGovernedBroker();
		childProcess.spawnSync.mockClear();
		const invalidInputs = [
			{
				kind: "new-candidate",
				packetSource: "{}",
				projectRoot,
				approval: "operator-requested",
				executor: "ambient-shell",
			},
			{
				kind: "new-candidate",
				packetSource: "{}",
				projectRoot: "/srv/buildplane/../secrets",
				approval: "operator-requested",
			},
			{
				kind: "new-candidate",
				packetSource: "x".repeat(512 * 1024 + 1),
				projectRoot,
				approval: "operator-requested",
			},
		];
		for (const input of invalidInputs) {
			await expect(
				broker?.openCandidateSession(input as never),
			).rejects.toThrow(/protected governed session client/i);
		}
		expect(childProcess.spawnSync).not.toHaveBeenCalled();
	});

	it("encodes preauthorization without treating its source or reference as session identity", async () => {
		const broker = await hostBroker.resolveHostOwnedGovernedBroker();
		childProcess.spawnSync.mockClear();
		await broker?.openCandidateSession({
			kind: "new-candidate",
			packetSource: "{}",
			projectRoot,
			approval: { preauthorizationRef: "preauth/approved-0001" },
		});
		let request = capturedRequest("open_candidate_session");
		expect(request.approval).toEqual({
			kind: "preauthorization_ref",
			preauthorization_ref: "preauth/approved-0001",
		});

		childProcess.spawnSync.mockClear();
		await broker?.openCandidateSession({
			kind: "new-candidate",
			packetSource: "{}",
			projectRoot,
			approval: { preauthorizedEnvelopeSource: '{"signed":"carrier"}' },
		});
		request = capturedRequest("open_candidate_session");
		expect(request.approval).toEqual({
			kind: "preauthorized_envelope_source",
			preauthorized_envelope_source: '{"signed":"carrier"}',
		});
		expect(request).not.toHaveProperty("recovery_ref");
		expect(request).not.toHaveProperty("session_ref");
	});

	it("keeps PlanForge session authority blocked until the protected protocol supports it", async () => {
		const broker = await hostBroker.resolveHostOwnedGovernedBroker();
		childProcess.spawnSync.mockClear();
		await expect(
			broker?.admitPlanForge({
				kind: "planforge-admission",
				planSource: new Uint8Array([1]),
				projectRoot,
				approval: "operator-requested",
			}),
		).rejects.toThrow(/not supported/i);
		await expect(
			broker?.openPlanForgeCandidateSession({
				kind: "planforge-candidate-session-open-v1",
				schemaVersion: 1,
				projectRoot,
				admissionRef: "host-admission/one",
				taskRef: "host-task/one",
			}),
		).rejects.toThrow(/not supported/i);
		expect(childProcess.spawnSync).not.toHaveBeenCalled();
	});
});
