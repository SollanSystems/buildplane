import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({
	spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawnSync: childProcess.spawnSync,
}));

const { executeProtectedPromotion } = await import(
	"../src/governed-promotion-execution-client.js"
);

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const decisionEventId = "123e4567-e89b-12d3-a456-426614174003";

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		configurable: true,
		value: platform,
	});
}

function nativeResult(overrides: Record<string, unknown> = {}) {
	return {
		error: undefined,
		signal: null,
		status: 0,
		stderr: "",
		stdout: '{"schema_version":1,"status":"recorded"}\n',
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

describe("protected promotion-execution native client", () => {
	it("submits only the sealed decision identity through the fixed no-authority executable", async () => {
		childProcess.spawnSync.mockReturnValue(nativeResult());

		await expect(
			executeProtectedPromotion({
				promotionDecisionEventId: decisionEventId,
			}),
		).resolves.toEqual({ status: "recorded" });

		expect(childProcess.spawnSync).toHaveBeenCalledWith(
			"/usr/libexec/buildplane/buildplane-authority-client",
			[],
			{
				input: JSON.stringify({
					schema_version: 1,
					operation: "execute_promotion",
					promotion_decision_event_id: decisionEventId,
				}),
				encoding: "utf8",
				env: {},
				shell: false,
				timeout: 10_000,
				maxBuffer: 1_024,
				windowsHide: true,
			},
		);
	});

	it.each([
		"rejected",
		"pending",
		"recorded",
		"lease_expired",
		"reconciliation_required",
	] as const)("accepts only the exact closed native status %s", async (status) => {
		childProcess.spawnSync.mockReturnValue(
			nativeResult({
				stdout: `{"schema_version":1,"status":"${status}"}\n`,
			}),
		);

		await expect(
			executeProtectedPromotion({
				promotionDecisionEventId: decisionEventId,
			}),
		).resolves.toEqual({ status });
	});

	it.each([
		{ stdout: '{"schema_version":1,"status":"recorded"}' },
		{ stdout: '{"status":"recorded","schema_version":1}\n' },
		{ stdout: '{"schema_version":1,"status":"approved"}\n' },
		{ stdout: '{"schema_version":1,"status":"recorded","extra":true}\n' },
		{ stderr: "client_blocked\n" },
		{ status: 1 },
		{ signal: "SIGTERM" },
		{ error: new Error("spawn failed") },
	])("blocks malformed or failed native completion %#", async (override) => {
		childProcess.spawnSync.mockReturnValue(nativeResult(override));
		await expect(
			executeProtectedPromotion({
				promotionDecisionEventId: decisionEventId,
			}),
		).resolves.toBeUndefined();
	});

	it.each([
		["win32", decisionEventId],
		["linux", "123E4567-E89B-12D3-A456-426614174003"],
		["linux", "host-recovery/promotion-execution"],
	] as const)("does not spawn for unsupported or noncanonical input", async (platform, eventId) => {
		setPlatform(platform);
		await expect(
			executeProtectedPromotion({
				promotionDecisionEventId: eventId,
			}),
		).resolves.toBeUndefined();
		expect(childProcess.spawnSync).not.toHaveBeenCalled();
	});
});
