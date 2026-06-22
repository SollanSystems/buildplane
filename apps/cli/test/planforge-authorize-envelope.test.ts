import { describe, expect, it } from "vitest";
import {
	buildAuthorizeEnvelopePayload,
	parseEnvelopeArgs,
} from "../src/planforge-authorize-envelope.js";

const baseArgs = [
	"--milestone",
	"M5",
	"--side-effects",
	"code-edit",
	"--path-globs",
	"src/**,test/**",
	"--max-iterations",
	"8",
	"--token-budget",
	"4000000",
	"--verification-cmds",
	"pnpm vitest run,cargo test,tsc --noEmit",
	"--expires-at",
	"2026-07-01T00:00:00Z",
	"--approve",
	"--operator",
	"khall",
];

describe("planforge authorize-envelope", () => {
	it("fails closed without --approve", () => {
		expect(() =>
			parseEnvelopeArgs(baseArgs.filter((a) => a !== "--approve")),
		).toThrow(/--approve/);
	});

	it("fails closed without --operator", () => {
		expect(() =>
			parseEnvelopeArgs(
				baseArgs.filter(
					(a, i) =>
						a !== "khall" &&
						baseArgs[i - 1] !== "--operator" &&
						a !== "--operator",
				),
			),
		).toThrow(/--operator/);
	});

	it("rejects a non-positive --max-iterations", () => {
		const bad = baseArgs.map((a) => (a === "8" ? "0" : a));
		expect(() => parseEnvelopeArgs(bad)).toThrow(/max-iterations/);
	});

	it("rejects a non-RFC3339 --expires-at", () => {
		const bad = baseArgs.map((a) =>
			a === "2026-07-01T00:00:00Z" ? "not-a-date" : a,
		);
		expect(() => parseEnvelopeArgs(bad)).toThrow(/expires-at/);
	});

	it("builds a v0 envelope payload with canonical-JSON envelope + authorize-envelope subject", () => {
		const parsed = parseEnvelopeArgs(baseArgs);
		const payload = buildAuthorizeEnvelopePayload(
			parsed,
			new Date("2026-06-22T00:00:00Z"),
		);
		expect(payload.subject).toBe("authorize-envelope");
		expect(payload.decision).toBe("approved");
		expect(payload.decided_by).toBe("operator:khall");
		expect(payload.envelope).toContain('"milestone":"M5"');
		expect(payload.envelope.indexOf("allowed_side_effects")).toBeLessThan(
			payload.envelope.indexOf("path_globs"),
		);
	});

	it("normalizes verification-cmds to their argv0 allowlist", () => {
		const parsed = parseEnvelopeArgs(baseArgs);
		expect(parsed.envelope.allowed_verification_cmds).toEqual([
			"pnpm",
			"cargo",
			"tsc",
		]);
	});

	it("is idempotent: identical envelopes produce the same run id", () => {
		const a = parseEnvelopeArgs(baseArgs);
		const b = parseEnvelopeArgs(baseArgs);
		const pa = buildAuthorizeEnvelopePayload(
			a,
			new Date("2026-06-22T00:00:00Z"),
		);
		const pb = buildAuthorizeEnvelopePayload(
			b,
			new Date("2026-06-23T11:00:00Z"),
		);
		expect(pa.run_id).toBe(pb.run_id);
	});
});
