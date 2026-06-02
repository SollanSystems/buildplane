import type { TapeEmitter } from "@buildplane/ledger-client";
import { digest } from "@buildplane/planforge";
import { describe, expect, it } from "vitest";
import { createLedgerActivityPort } from "../src/ledger-activity-port.js";

interface RecordedEmit {
	readonly kind: string;
	readonly payload: unknown;
	readonly emitSeq: number;
}

interface FakeEmitter {
	readonly emitter: TapeEmitter;
	readonly emits: RecordedEmit[];
	flushCount: number;
	flushAtSeq: number[];
}

function createFakeEmitter(): FakeEmitter {
	let seq = 0;
	const emits: RecordedEmit[] = [];
	const fake: FakeEmitter = {
		emits,
		flushCount: 0,
		flushAtSeq: [],
		emitter: {
			emit(kind: string, payload: unknown) {
				emits.push({ kind, payload, emitSeq: seq++ });
			},
			async flush() {
				fake.flushCount += 1;
				fake.flushAtSeq.push(seq);
			},
			async close() {},
			onFailure() {},
			stats() {
				return {
					eventsEmitted: emits.length,
					lastAckedEventId: null,
					queueDepth: 0,
				};
			},
		},
	};
	return fake;
}

describe("createLedgerActivityPort", () => {
	it("emits activity_started then awaits flush() (write-ahead)", async () => {
		const emitter = createFakeEmitter();
		const port = createLedgerActivityPort(emitter.emitter);

		await port.activityStarted({
			runId: "run-1",
			activityId: "act-1",
			activityType: "command",
			input: { command: "true" },
		});

		expect(emitter.emits).toHaveLength(1);
		const recorded = emitter.emits[0];
		expect(recorded?.kind).toBe("activity_started");
		expect(recorded?.payload).toEqual({
			ActivityStartedV1: {
				run_id: "run-1",
				activity_id: "act-1",
				activity_type: "command",
				input_digest: digest({ command: "true" }),
			},
		});
		// flush called exactly once, AFTER the emit
		expect(emitter.flushCount).toBe(1);
		expect(emitter.flushAtSeq[0]).toBe(1);
		// digest is sha256:<hex>
		const payload = recorded?.payload as {
			ActivityStartedV1: { input_digest: string };
		};
		expect(payload.ActivityStartedV1.input_digest).toMatch(
			/^sha256:[0-9a-f]+$/,
		);
	});

	it("emits activity_completed with result_digest and inline result (no pre-flush required)", async () => {
		const emitter = createFakeEmitter();
		const port = createLedgerActivityPort(emitter.emitter);
		const result = { exitCode: 0, stdout: "ok\n", stderr: "" };

		await port.activityCompleted({
			runId: "run-1",
			activityId: "act-1",
			result,
		});

		expect(emitter.emits).toHaveLength(1);
		const recorded = emitter.emits[0];
		expect(recorded?.kind).toBe("activity_completed");
		expect(recorded?.payload).toEqual({
			ActivityCompletedV1: {
				run_id: "run-1",
				activity_id: "act-1",
				result_digest: digest(result),
				result,
			},
		});
		const payload = recorded?.payload as {
			ActivityCompletedV1: { result_digest: string };
		};
		expect(payload.ActivityCompletedV1.result_digest).toMatch(
			/^sha256:[0-9a-f]+$/,
		);
	});
});
