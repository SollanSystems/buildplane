import { describe, expect, it } from "vitest";
import {
	assertActiveGovernedDispatchAuthorityWindowV1,
	inspectGovernedDispatchAuthorityWindowV1,
	validateGovernedDispatchAuthorityWindowV1,
} from "../src/governed-dispatch-authority-window.js";

function dispatch(
	overrides: Partial<{
		issuedAt: string;
		expiresAt: string;
		budget: unknown;
	}> = {},
) {
	return {
		issuedAt: "2026-07-25T12:00:00.000000000Z",
		expiresAt: "2026-07-25T12:10:00.000000000Z",
		budget: {},
		...overrides,
	};
}

describe("governed dispatch authority window", () => {
	it("keeps an omitted compute cap expiry-bounded for sealed V3 compatibility", () => {
		expect(
			inspectGovernedDispatchAuthorityWindowV1(
				dispatch(),
				"2026-07-25T12:01:00.000000000Z",
			),
		).toMatchObject({ state: "active", deadlineSource: "expiry" });
	});

	it("rejects a future-issued dispatch before any governed effect", () => {
		expect(
			inspectGovernedDispatchAuthorityWindowV1(
				dispatch({ issuedAt: "2026-07-25T12:00:00.000000001Z" }),
				"2026-07-25T12:00:00.000000000Z",
			),
		).toEqual({ state: "inactive", failure: "not-yet-active" });
	});

	it("enforces a supplied compute deadline even when the envelope expiry is later", () => {
		expect(
			inspectGovernedDispatchAuthorityWindowV1(
				dispatch({ budget: { maxComputeTimeMs: 1 } }),
				"2026-07-25T12:00:00.001000000Z",
			),
		).toEqual({ state: "inactive", failure: "compute-deadline-elapsed" });
	});

	it("keeps a structurally valid historical dispatch replayable after it expires", () => {
		const input = dispatch({ budget: { maxComputeTimeMs: 1 } });
		expect(validateGovernedDispatchAuthorityWindowV1(input)).toMatchObject({
			state: "valid",
			deadlineSource: "compute",
		});
		expect(
			inspectGovernedDispatchAuthorityWindowV1(
				input,
				"2026-07-25T12:00:01.000000000Z",
			),
		).toEqual({ state: "inactive", failure: "compute-deadline-elapsed" });
	});

	it("fails closed for a millisecond clock near a sub-millisecond expiry", () => {
		expect(
			inspectGovernedDispatchAuthorityWindowV1(
				dispatch({
					issuedAt: "2026-07-25T12:00:00.000000000Z",
					expiresAt: "2026-07-25T12:00:00.123500000Z",
				}),
				"2026-07-25T12:00:00.123Z",
			),
		).toEqual({ state: "inactive", failure: "expired" });
	});

	it("retains exact nanosecond clocks but widens source text beyond native precision", () => {
		const exact = dispatch({
			issuedAt: "2026-07-25T12:00:00.000000000Z",
			expiresAt: "2026-07-25T12:00:00.123456790Z",
		});
		expect(
			inspectGovernedDispatchAuthorityWindowV1(
				exact,
				"2026-07-25T12:00:00.123456789Z",
			),
		).toMatchObject({ state: "active" });
		expect(
			inspectGovernedDispatchAuthorityWindowV1(
				exact,
				"2026-07-25T12:00:00.1234567891Z",
			),
		).toEqual({ state: "inactive", failure: "expired" });
	});

	it("rejects invalid budget values and exposes a strict assertion API", () => {
		const input = dispatch({ budget: { maxComputeTimeMs: 0 } });
		expect(
			inspectGovernedDispatchAuthorityWindowV1(
				input,
				"2026-07-25T12:00:01.000000000Z",
			),
		).toEqual({ state: "inactive", failure: "invalid-budget" });
		expect(() =>
			assertActiveGovernedDispatchAuthorityWindowV1(
				input,
				"2026-07-25T12:00:01.000000000Z",
			),
		).toThrow("invalid budget");
	});
});
