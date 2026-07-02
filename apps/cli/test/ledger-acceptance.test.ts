import { describe, expect, it, vi } from "vitest";
import {
	createAcceptancePort,
	emitAcceptanceRecorded,
	evaluateAcceptanceDiffScope,
} from "../src/ledger-acceptance.js";

describe("emitAcceptanceRecorded", () => {
	it("emits acceptance_recorded with an all-string AcceptanceRecordedV1 payload", () => {
		const emit = vi.fn();
		const emitter = { emit, flush: vi.fn() } as never;

		emitAcceptanceRecorded(emitter, {
			planId: "plan-1",
			admissionEventId: "42",
			contractDigest: "sha256:cc",
			outcome: "passed",
			diffScopeStatus: "passed",
			outOfScopeFiles: [],
			checkResults: [{ command: "pnpm lint", exitCode: 0 }],
			evaluatedAt: "2026-06-19T00:00:00.000Z",
		});

		expect(emit).toHaveBeenCalledWith("acceptance_recorded", {
			AcceptanceRecordedV1: {
				plan_id: "plan-1",
				admission_event_id: "42",
				contract_digest: "sha256:cc",
				outcome: "passed",
				diff_scope_status: "passed",
				out_of_scope_files: [],
				checks: [{ command: "pnpm lint", exit_code: "0", status: "passed" }],
				evaluated_at: "2026-06-19T00:00:00.000Z",
			},
		});
	});

	it("marks a non-zero check exit_code as a failed check status", () => {
		const emit = vi.fn();
		const emitter = { emit, flush: vi.fn() } as never;

		emitAcceptanceRecorded(emitter, {
			planId: "plan-1",
			admissionEventId: "42",
			contractDigest: "sha256:cc",
			outcome: "rejected",
			diffScopeStatus: "passed",
			outOfScopeFiles: [],
			checkResults: [{ command: "pnpm lint", exitCode: 2 }],
			evaluatedAt: "2026-06-19T00:00:00.000Z",
		});

		expect(emit).toHaveBeenCalledWith(
			"acceptance_recorded",
			expect.objectContaining({
				AcceptanceRecordedV1: expect.objectContaining({
					checks: [{ command: "pnpm lint", exit_code: "2", status: "failed" }],
				}),
			}),
		);
	});
});

describe("createAcceptancePort", () => {
	it("appends plan identity and flushes write-ahead before resolving", async () => {
		const emit = vi.fn();
		const flush = vi.fn().mockResolvedValue(undefined);
		// M6-S7: recordAcceptance reads the post-flush ack to return the acceptance
		// event id, so the emitter double must implement `stats()`.
		const stats = vi.fn().mockReturnValue({
			eventsEmitted: 1,
			lastAckedEventId: "acc-event-9",
			queueDepth: 0,
		});
		const emitter = { emit, flush, stats } as never;

		const port = createAcceptancePort(emitter, {
			planId: "plan-1",
			contractDigest: "sha256:dd",
		});

		const acceptanceEventId = await port.recordAcceptance({
			runId: "run-9",
			admissionEventId: "7",
			outcome: "passed",
			diffScopeStatus: "passed",
			outOfScopeFiles: [],
			checkResults: [],
			evaluatedAt: "2026-06-19T00:00:00.000Z",
		});

		// The signed acceptance event id is surfaced for terminal result_ready chaining.
		expect(acceptanceEventId).toBe("acc-event-9");

		expect(emit).toHaveBeenCalledWith(
			"acceptance_recorded",
			expect.objectContaining({
				AcceptanceRecordedV1: expect.objectContaining({
					plan_id: "plan-1",
					admission_event_id: "7",
					contract_digest: "sha256:dd",
				}),
			}),
		);
		expect(flush).toHaveBeenCalledTimes(1);
	});
});

describe("evaluateAcceptanceDiffScope", () => {
	it("reports blocked status and the files escaping the allowed globs", () => {
		const result = evaluateAcceptanceDiffScope(
			["docs/ok.md", "src/sneaky.ts"],
			{
				contract_version: "v0",
				diff_scope: { allowed_globs: ["docs/**"] },
				checks: [],
			},
		);

		expect(result.status).toBe("blocked");
		expect(result.outOfScopeFiles).toEqual(["src/sneaky.ts"]);
	});

	it("reports passed status with no escaping files when the diff is in scope", () => {
		const result = evaluateAcceptanceDiffScope(["docs/ok.md"], {
			contract_version: "v0",
			diff_scope: { allowed_globs: ["docs/**"] },
			checks: [],
		});

		expect(result.status).toBe("passed");
		expect(result.outOfScopeFiles).toEqual([]);
	});
});
