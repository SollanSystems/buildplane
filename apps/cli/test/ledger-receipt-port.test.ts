import type { TapeEmitter } from "@buildplane/ledger-client";
import type { PlanReceiptPayload } from "@buildplane/planforge";
import { describe, expect, it } from "vitest";
import { createLedgerReceiptPort } from "../src/ledger-receipt-port.js";

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

const PAYLOAD: PlanReceiptPayload = {
	plan_id: "pf-plan-abc",
	admission_event_id: "01919000-0000-7000-8000-000000000016",
	outcome: "completed",
	side_effects: ["fs.write:declared_scope"],
	result_digest:
		"sha256:0000000000000000000000000000000000000000000000000000000000000000",
	decided_at: "2026-06-04T00:00:00Z",
};

describe("createLedgerReceiptPort", () => {
	it("emits plan_receipt then awaits flush() (durable terminal receipt)", async () => {
		const emitter = createFakeEmitter();
		const port = createLedgerReceiptPort(emitter.emitter);

		await port.emitPlanReceipt(PAYLOAD);

		expect(emitter.emits).toHaveLength(1);
		const recorded = emitter.emits[0];
		expect(recorded?.kind).toBe("plan_receipt");
		expect(recorded?.payload).toEqual({ PlanReceiptRecordedV1: PAYLOAD });
		// flush called exactly once, AFTER the emit
		expect(emitter.flushCount).toBe(1);
		expect(emitter.flushAtSeq[0]).toBe(1);
	});
});
