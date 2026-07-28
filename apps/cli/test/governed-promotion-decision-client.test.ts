import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({
	spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawnSync: childProcess.spawnSync,
}));

const { submitProtectedPromotionDecision } = await import(
	"../src/governed-promotion-decision-client.js"
);

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const approvalEventId = "123e4567-e89b-12d3-a456-426614174001";
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
		stdout: `{"schema_version":2,"status":"sealed","promotion_decision_event_id":"${decisionEventId}"}\n`,
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

describe("protected promotion-decision native client", () => {
	it("uses only the fixed installed executable with closed stdin and no ambient environment", async () => {
		childProcess.spawnSync.mockReturnValue(nativeResult());

		await expect(
			submitProtectedPromotionDecision({
				promotionApprovalRequestEventId: approvalEventId,
				decision: "promote",
			}),
		).resolves.toEqual({
			status: "sealed",
			promotionDecisionEventId: decisionEventId,
		});

		expect(childProcess.spawnSync).toHaveBeenCalledWith(
			"/usr/libexec/buildplane/buildplane-authority-client",
			[],
			{
				input: JSON.stringify({
					schema_version: 1,
					promotion_approval_request_event_id: approvalEventId,
					decision: "promote",
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

	it("returns reconciliation only for the exact closed native response", async () => {
		childProcess.spawnSync.mockReturnValue(
			nativeResult({
				stdout:
					'{"schema_version":2,"status":"reconciliation_required","promotion_decision_event_id":null}\n',
			}),
		);

		await expect(
			submitProtectedPromotionDecision({
				promotionApprovalRequestEventId: approvalEventId,
				decision: "reject",
			}),
		).resolves.toEqual({ status: "reconciliation_required" });
	});

	it.each([
		{ stdout: '{"schema_version":1,"status":"sealed"}' },
		{ stdout: '{"status":"sealed","schema_version":1}\n' },
		{ stdout: '{"schema_version":1,"status":"sealed","extra":true}\n' },
		{ stderr: "client_blocked\n" },
		{ status: 1 },
		{ signal: "SIGTERM" },
		{ error: new Error("spawn failed") },
	])("blocks malformed or failed native completion %#", async (override) => {
		childProcess.spawnSync.mockReturnValue(nativeResult(override));
		await expect(
			submitProtectedPromotionDecision({
				promotionApprovalRequestEventId: approvalEventId,
				decision: "promote",
			}),
		).resolves.toBeUndefined();
	});

	it("blocks a synchronous spawn failure without exposing it", async () => {
		childProcess.spawnSync.mockImplementation(() => {
			throw new Error("sensitive local spawn detail");
		});
		await expect(
			submitProtectedPromotionDecision({
				promotionApprovalRequestEventId: approvalEventId,
				decision: "promote",
			}),
		).resolves.toBeUndefined();
	});

	it.each([
		["win32", approvalEventId, "promote"],
		["linux", "123E4567-E89B-12D3-A456-426614174001", "promote"],
		["linux", "host-recovery/promotion-decision", "reject"],
	] as const)(
		"does not spawn for unsupported or noncanonical input",
		async (platform, eventId, decision) => {
			setPlatform(platform);
			await expect(
				submitProtectedPromotionDecision({
					promotionApprovalRequestEventId: eventId,
					decision,
				}),
			).resolves.toBeUndefined();
			expect(childProcess.spawnSync).not.toHaveBeenCalled();
		},
	);
});
