// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DecisionConflictError,
	fetchRuns,
	postDecision,
	setAuthToken,
	UnauthorizedError,
} from "../src/api";

function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("api client", () => {
	beforeEach(() => {
		setAuthToken(null);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("fetchRuns parses { runs, cursor }", async () => {
		const payload = {
			runs: [{ id: "r1", unitId: "u1", status: "suspended" }],
			cursor: "next-cursor",
		};
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload, 200));
		vi.stubGlobal("fetch", fetchMock);

		const result = await fetchRuns("suspended");

		expect(result.runs).toEqual(payload.runs);
		expect(result.cursor).toBe("next-cursor");

		const url = String(fetchMock.mock.calls[0][0]);
		expect(url).toContain("/api/runs");
		expect(url).toContain("status=suspended");
	});

	it("postDecision sends Authorization: Bearer <token> and the JSON body", async () => {
		setAuthToken("t");
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ ok: true, runId: "r1" }, 200));
		vi.stubGlobal("fetch", fetchMock);

		const result = await postDecision("r1", {
			decision: "approved",
			subject: "merge",
		});

		expect(result).toEqual({ ok: true, runId: "r1" });

		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toContain("/api/runs/r1/decision");
		expect(init.method).toBe("POST");
		expect(init.headers.Authorization).toBe("Bearer t");
		expect(JSON.parse(init.body)).toEqual({
			decision: "approved",
			subject: "merge",
		});
	});

	it("postDecision omits the Authorization header when the token is null", async () => {
		// beforeEach already resets the token to null.
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ ok: true, runId: "r1" }, 200));
		vi.stubGlobal("fetch", fetchMock);

		await postDecision("r1", { decision: "approved", subject: "merge" });

		const [, init] = fetchMock.mock.calls[0];
		expect("Authorization" in init.headers).toBe(false);
	});

	it("postDecision rejects with UnauthorizedError on HTTP 401", async () => {
		setAuthToken("t");
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			postDecision("r1", { decision: "approved", subject: "merge" }),
		).rejects.toBeInstanceOf(UnauthorizedError);
	});

	it("postDecision rejects with DecisionConflictError on HTTP 400 invalid_decision", async () => {
		setAuthToken("t");
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				jsonResponse(
					{ error: "invalid_decision", message: "run is already merged" },
					400,
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		const rejection = postDecision("r1", {
			decision: "approved",
			subject: "merge",
		});

		await expect(rejection).rejects.toBeInstanceOf(DecisionConflictError);
		await expect(rejection).rejects.toThrow("run is already merged");
	});
});
