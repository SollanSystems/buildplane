import type {
	InspectSnapshot,
	PendingOperatorDecision,
	RecordOperatorDecisionInput,
	RunPage,
	RunStatus,
	StatusSnapshot,
} from "@buildplane/kernel";
import {
	handleApiRequest,
	type MissionControlRouterDeps,
} from "@buildplane/mission-control-server";
import { describe, expect, it, vi } from "vitest";

function runPage(runs: Array<{ id: string }>, cursor?: string): RunPage {
	const page = runs.map((run) => ({
		id: run.id,
		unitId: `unit-${run.id}`,
		status: "running" as RunStatus,
	})) as unknown as Array<unknown> & { cursor?: string };
	if (cursor) {
		page.cursor = cursor;
	}
	return page as unknown as RunPage;
}

function inspectSnapshot(id: string): InspectSnapshot {
	return {
		run: { id, unitId: `unit-${id}`, status: "passed" },
		evidence: [{ kind: "ci", status: "passed" }],
		decisions: [],
		artifacts: [],
		provenance: {
			route: { worker: "claude", source: "packet" },
			policy: { profile: "default" },
		},
		eventTape: {
			eventCount: 1,
			lastKind: "plan_receipt",
			terminalStatus: "passed",
			events: [],
		},
	} as unknown as InspectSnapshot;
}

function staticToken(token: string) {
	return { read: () => token };
}

function makeDeps(
	overrides: Partial<MissionControlRouterDeps> = {},
): MissionControlRouterDeps {
	return {
		orchestrator: {
			inspect: vi.fn(() => inspectSnapshot("run-1")),
			recordOperatorDecision: vi.fn(() => Promise.resolve()),
			recoverPendingDecisions: vi.fn(() =>
				Promise.resolve({ recovered: 0, failed: [] }),
			),
		},
		store: {
			listRunsByStatus: vi.fn(() => runPage([{ id: "run-1" }])),
			listPendingOperatorDecisions: vi.fn(
				() =>
					[
						{ runId: "run-7", subject: "merge", since: "2026-06-28T00:00:00Z" },
					] as readonly PendingOperatorDecision[],
			),
			getStatusSnapshot: vi.fn(
				() =>
					({
						initialized: true,
						runCounts: {
							pending: 0,
							running: 1,
							passed: 2,
							failed: 0,
							cancelled: 0,
							suspended: 1,
						},
					}) as StatusSnapshot,
			),
		},
		tokenSource: staticToken("s3cret"),
		...overrides,
	};
}

function request(
	partial: Partial<Parameters<typeof handleApiRequest>[1]> & {
		method: string;
		pathname: string;
	},
): Parameters<typeof handleApiRequest>[1] {
	return {
		query: new URLSearchParams(),
		...partial,
	};
}

describe("GET /api/runs", () => {
	it("returns the run page for the requested status", async () => {
		const deps = makeDeps();
		const response = await handleApiRequest(
			deps,
			request({
				method: "GET",
				pathname: "/api/runs",
				query: new URLSearchParams({ status: "running", limit: "10" }),
			}),
		);

		expect(response.status).toBe(200);
		expect(deps.store.listRunsByStatus).toHaveBeenCalledWith("running", {
			limit: 10,
		});
		expect(response.body).toEqual({
			runs: [{ id: "run-1", unitId: "unit-run-1", status: "running" }],
		});
	});

	it("propagates the keyset cursor without backdating", async () => {
		const deps = makeDeps({
			store: {
				...makeDeps().store,
				listRunsByStatus: vi.fn(() => runPage([{ id: "run-1" }], "cursor-2")),
			},
		});
		const response = await handleApiRequest(
			deps,
			request({
				method: "GET",
				pathname: "/api/runs",
				query: new URLSearchParams({ status: "running" }),
			}),
		);

		expect(response.status).toBe(200);
		expect((response.body as { cursor?: string }).cursor).toBe("cursor-2");
	});

	it("rejects an unknown status with 400", async () => {
		const response = await handleApiRequest(
			makeDeps(),
			request({
				method: "GET",
				pathname: "/api/runs",
				query: new URLSearchParams({ status: "bogus" }),
			}),
		);
		expect(response.status).toBe(400);
	});

	it("returns 400 (not 500) when the cursor decode throws", async () => {
		const deps = makeDeps({
			store: {
				...makeDeps().store,
				listRunsByStatus: vi.fn(() => {
					throw new Error("Invalid run cursor: 'broken'");
				}),
			},
		});
		const response = await handleApiRequest(
			deps,
			request({
				method: "GET",
				pathname: "/api/runs",
				query: new URLSearchParams({ status: "running", cursor: "broken" }),
			}),
		);
		expect(response.status).toBe(400);
	});
});

describe("GET /api/runs/:id/inspector", () => {
	it("returns the inspector projection for the run", async () => {
		const deps = makeDeps();
		const response = await handleApiRequest(
			deps,
			request({ method: "GET", pathname: "/api/runs/run-1/inspector" }),
		);

		expect(response.status).toBe(200);
		expect(deps.orchestrator.inspect).toHaveBeenCalledWith("run-1");
		expect(response.body).toMatchObject({
			kind: "run-inspector",
			runId: "run-1",
		});
	});

	it("returns 404 when the run cannot be inspected", async () => {
		const deps = makeDeps({
			orchestrator: {
				inspect: vi.fn(() => {
					throw new Error("unknown run");
				}),
				recordOperatorDecision: vi.fn(() => Promise.resolve()),
			},
		});
		const response = await handleApiRequest(
			deps,
			request({ method: "GET", pathname: "/api/runs/ghost/inspector" }),
		);
		expect(response.status).toBe(404);
	});
});

describe("GET /api/status", () => {
	it("returns the status snapshot", async () => {
		const response = await handleApiRequest(
			makeDeps(),
			request({ method: "GET", pathname: "/api/status" }),
		);
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({ initialized: true });
	});
});

describe("GET /api/inbox", () => {
	it("returns the pending operator decisions", async () => {
		const response = await handleApiRequest(
			makeDeps(),
			request({ method: "GET", pathname: "/api/inbox" }),
		);
		expect(response.status).toBe(200);
		expect(response.body).toEqual([
			{ runId: "run-7", subject: "merge", since: "2026-06-28T00:00:00Z" },
		]);
	});
});

describe("POST /api/runs/:id/decision", () => {
	it("returns 401 without a valid bearer token", async () => {
		const deps = makeDeps();
		const response = await handleApiRequest(
			deps,
			request({
				method: "POST",
				pathname: "/api/runs/run-1/decision",
				body: { decision: "approved", subject: "merge" },
			}),
		);

		expect(response.status).toBe(401);
		expect(deps.orchestrator.recordOperatorDecision).not.toHaveBeenCalled();
	});

	it("records the decision exactly once with the right runId/decision/subject", async () => {
		const deps = makeDeps();
		const response = await handleApiRequest(
			deps,
			request({
				method: "POST",
				pathname: "/api/runs/run-1/decision",
				authorizationHeader: "Bearer s3cret",
				body: { decision: "approved", subject: "merge" },
			}),
		);

		expect(response.status).toBe(200);
		expect(deps.orchestrator.recordOperatorDecision).toHaveBeenCalledTimes(1);
		const input = (
			deps.orchestrator.recordOperatorDecision as unknown as {
				mock: { calls: RecordOperatorDecisionInput[][] };
			}
		).mock.calls[0][0];
		expect(input).toMatchObject({
			runId: "run-1",
			decision: "approved",
			subject: "merge",
		});
		expect(input.decidedBy.length).toBeGreaterThan(0);
		expect(input.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("maps an OperatorDecisionValidationError to 400", async () => {
		const validationError = new Error("subject must be 'merge' or 'resume'.");
		validationError.name = "OperatorDecisionValidationError";
		const deps = makeDeps({
			orchestrator: {
				inspect: vi.fn(() => inspectSnapshot("run-1")),
				recordOperatorDecision: vi.fn(() => Promise.reject(validationError)),
				recoverPendingDecisions: vi.fn(() =>
					Promise.resolve({ recovered: 0, failed: [] }),
				),
			},
		});
		const response = await handleApiRequest(
			deps,
			request({
				method: "POST",
				pathname: "/api/runs/run-1/decision",
				authorizationHeader: "Bearer s3cret",
				body: { decision: "approved", subject: "bogus" },
			}),
		);
		expect(response.status).toBe(400);
	});
});
