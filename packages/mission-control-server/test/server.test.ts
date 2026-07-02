import type { AddressInfo } from "node:net";
import {
	createMissionControlServer,
	type MissionControlServer,
	type MissionControlServerDeps,
	resolveBindHost,
} from "@buildplane/mission-control-server";
import { afterEach, describe, expect, it, vi } from "vitest";

function makeServerDeps(
	overrides: Partial<MissionControlServerDeps> = {},
): MissionControlServerDeps {
	return {
		orchestrator: {
			inspect: vi.fn(),
			recordOperatorDecision: vi.fn(() => Promise.resolve()),
			recoverPendingDecisions: vi.fn(() =>
				Promise.resolve({ recovered: 0, failed: [] }),
			),
		},
		store: {
			listRunsByStatus: vi.fn(() => [] as never),
			listPendingOperatorDecisions: vi.fn(() => []),
			getStatusSnapshot: vi.fn(
				() =>
					({
						initialized: true,
						runCounts: {
							pending: 0,
							running: 0,
							passed: 0,
							failed: 0,
							cancelled: 0,
							suspended: 0,
						},
					}) as never,
			),
		},
		tokenSource: { read: () => "tok" },
		...overrides,
	};
}

describe("resolveBindHost", () => {
	it("defaults to loopback 127.0.0.1", () => {
		expect(resolveBindHost({}, {})).toBe("127.0.0.1");
	});

	it("binds externally only when BUILDPLANE_WEB_ALLOW_EXTERNAL=1", () => {
		expect(resolveBindHost({}, { BUILDPLANE_WEB_ALLOW_EXTERNAL: "1" })).toBe(
			"0.0.0.0",
		);
	});

	it("honors an explicit allowExternal override", () => {
		expect(resolveBindHost({ allowExternal: true }, {})).toBe("0.0.0.0");
	});
});

describe("createMissionControlServer", () => {
	let running: MissionControlServer | undefined;

	afterEach(async () => {
		if (running) {
			await running.close();
			running = undefined;
		}
	});

	it("binds to the loopback interface by default", async () => {
		running = createMissionControlServer(makeServerDeps());
		const address = await running.listen(0);
		expect(address.host).toBe("127.0.0.1");

		const bound = running.server.address() as AddressInfo;
		expect(bound.address).toBe("127.0.0.1");
	});

	it("runs the crash reconciler exactly once on boot and logs the recovered count", async () => {
		const logs: string[] = [];
		const recoverPendingDecisions = vi.fn(() =>
			Promise.resolve({ recovered: 2, failed: [] }),
		);
		const deps = makeServerDeps({
			orchestrator: {
				inspect: vi.fn(),
				recordOperatorDecision: vi.fn(() => Promise.resolve()),
				recoverPendingDecisions,
			},
			logger: (message) => logs.push(message),
		});
		running = createMissionControlServer(deps);
		await running.listen(0);

		expect(recoverPendingDecisions).toHaveBeenCalledTimes(1);
		expect(logs.join("\n")).toMatch(/recovered 2 pending operator decision/i);
	});

	it("serves a read endpoint over real HTTP", async () => {
		running = createMissionControlServer(makeServerDeps());
		const address = await running.listen(0);
		const res = await fetch(`http://127.0.0.1:${address.port}/api/status`);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ initialized: true });
	});

	it("rejects an unauthenticated decision write with 401", async () => {
		const deps = makeServerDeps();
		running = createMissionControlServer(deps);
		const address = await running.listen(0);
		const res = await fetch(
			`http://127.0.0.1:${address.port}/api/runs/run-1/decision`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ decision: "approved", subject: "merge" }),
			},
		);
		expect(res.status).toBe(401);
		expect(deps.orchestrator.recordOperatorDecision).not.toHaveBeenCalled();
	});
});
