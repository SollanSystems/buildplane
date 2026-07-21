import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createTapeEmitter } from "../src/emitter.js";

class MockWritable extends EventEmitter {
	public writes: string[] = [];
	write(chunk: string): boolean {
		this.writes.push(chunk);
		return true;
	}
	end() {}
}
class MockReadable extends EventEmitter {
	push(line: string) {
		this.emit("data", Buffer.from(line));
	}
}
const asWritable = (w: MockWritable) => w as unknown as Writable;
const asReadable = (r: MockReadable) => r as unknown as Readable;

function createMock() {
	const stdin = new MockWritable();
	const stderr = new MockReadable();
	let exitResolve: (code: number) => void = () => {};
	const childExit = new Promise<number>((r) => {
		exitResolve = r;
	});
	return { stdin, stderr, childExit, exitResolve };
}

describe("createTapeEmitter", () => {
	const runId = "01919000-0000-7000-8000-000000000000";
	const digest = `sha256:${"a".repeat(64)}`;

	it("resolves after handshake success", async () => {
		const { stdin, stderr, childExit } = createMock();
		const emitterP = createTapeEmitter({
			childStdin: asWritable(stdin),
			childStderr: asReadable(stderr),
			childExit,
			workspacePath: "/tmp/ws",
			runId,
		});
		setImmediate(() => {
			stderr.push(
				`{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}\n`,
			);
		});
		const emitter = await emitterP;
		expect(stdin.writes[0]).toContain(`"control":"handshake"`);
		expect(emitter.stats().eventsEmitted).toBe(0);
	});

	it("emits an event as a JSONL line after handshake", async () => {
		const { stdin, stderr, childExit } = createMock();
		const emitterP = createTapeEmitter({
			childStdin: asWritable(stdin),
			childStderr: asReadable(stderr),
			childExit,
			workspacePath: "/tmp/ws",
			runId,
		});
		setImmediate(() =>
			stderr.push(
				`{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}\n`,
			),
		);
		const emitter = await emitterP;
		emitter.emit("run_started", { RunStartedV1: { packet_hash: "sha256:aa" } });
		await new Promise((r) => setImmediate(r));
		expect(stdin.writes.length).toBeGreaterThanOrEqual(2);
		const eventLine = stdin.writes[1];
		expect(eventLine).toContain(`"kind":"run_started"`);
		expect(eventLine).toContain(`"run_id":"${runId}"`);
		expect(eventLine.endsWith("\n")).toBe(true);
	});

	it("onFailure fires when child exits non-zero unexpectedly", async () => {
		const { stdin, stderr, childExit, exitResolve } = createMock();
		const emitterP = createTapeEmitter({
			childStdin: asWritable(stdin),
			childStderr: asReadable(stderr),
			childExit,
			workspacePath: "/tmp/ws",
			runId,
		});
		setImmediate(() =>
			stderr.push(
				`{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}\n`,
			),
		);
		const emitter = await emitterP;
		const cb = vi.fn();
		emitter.onFailure(cb);
		exitResolve(42);
		await new Promise((r) => setImmediate(r));
		expect(cb).toHaveBeenCalledOnce();
		expect(cb.mock.calls[0][0].exitCode).toBe(42);
		expect(cb.mock.calls[0][0].kind).toBe("exit");
	});

	it("emit after failure is a no-op", async () => {
		const { stdin, stderr, childExit, exitResolve } = createMock();
		const emitterP = createTapeEmitter({
			childStdin: asWritable(stdin),
			childStderr: asReadable(stderr),
			childExit,
			workspacePath: "/tmp/ws",
			runId,
		});
		setImmediate(() =>
			stderr.push(
				`{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}\n`,
			),
		);
		const emitter = await emitterP;
		exitResolve(1);
		await new Promise((r) => setImmediate(r));
		const writesBefore = stdin.writes.length;
		emitter.emit("run_completed", {});
		await new Promise((r) => setImmediate(r));
		expect(stdin.writes.length).toBe(writesBefore);
	});

	it("flush resolves when ledger sends flush_ack", async () => {
		const { stdin, stderr, childExit } = createMock();
		const emitterP = createTapeEmitter({
			childStdin: asWritable(stdin),
			childStderr: asReadable(stderr),
			childExit,
			workspacePath: "/tmp/ws",
			runId,
		});
		setImmediate(() =>
			stderr.push(
				`{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}\n`,
			),
		);
		const emitter = await emitterP;
		const flushP = emitter.flush();
		// flush() routes through the queue, so the line lands on stdin after a
		// microtask. Wait for the queue to drain before asserting on writes.
		await new Promise((r) => setImmediate(r));
		const flushLine = stdin.writes.find((w) => w.includes(`"control":"flush"`));
		expect(flushLine).toBeTruthy();
		const seq = JSON.parse(flushLine!).seq;
		setImmediate(() =>
			stderr.push(
				`{"control":"flush_ack","seq":${seq},"last_event_id":"01919000-0000-7000-8000-000000000001"}\n`,
			),
		);
		await flushP;
	});

	it("claims a governed activity through the signed ledger control channel", async () => {
		const { stdin, stderr, childExit } = createMock();
		const emitterP = createTapeEmitter({
			childStdin: asWritable(stdin),
			childStderr: asReadable(stderr),
			childExit,
			workspacePath: "/tmp/ws",
			runId,
		});
		setImmediate(() =>
			stderr.push(
				`{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}\n`,
			),
		);
		const emitter = await emitterP;
		const claimP = emitter.claimActivity({
			requestId: "claim-request-1",
			runId,
			activityId: "model:attempt:1",
			idempotencyKey: "sha256:activity",
			dispatchEventId: "01919000-0000-7000-8000-000000000001",
			actionRequestEventId: "01919000-0000-7000-8000-000000000002",
			leaseDurationMs: 30_000,
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(stdin.writes.at(-1)).toContain(`"control":"claim_activity_v1"`);
		stderr.push(
			'{"control":"claim_activity_v1_result","request_id":"claim-request-1","outcome":"granted","claim_event_id":"01919000-0000-7000-8000-000000000003","claim_event_digest":"sha256:claim","lease_id":"lease-1","lease_expires_at":"2026-07-18T12:00:00Z"}\n',
		);
		await expect(claimP).resolves.toMatchObject({
			outcome: "granted",
			lease_id: "lease-1",
		});
	});

	it("fails closed on a malformed activity authority response", async () => {
		const { stdin, stderr, childExit } = createMock();
		const emitterP = createTapeEmitter({
			childStdin: asWritable(stdin),
			childStderr: asReadable(stderr),
			childExit,
			workspacePath: "/tmp/ws",
			runId,
		});
		setImmediate(() =>
			stderr.push(
				`{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}\n`,
			),
		);
		const emitter = await emitterP;
		const failure = vi.fn();
		emitter.onFailure(failure);
		const claimP = emitter.claimActivity({
			requestId: "claim-request-1",
			runId,
			activityId: "model:attempt:1",
			idempotencyKey: "sha256:activity",
			dispatchEventId: "01919000-0000-7000-8000-000000000001",
			actionRequestEventId: "01919000-0000-7000-8000-000000000002",
			leaseDurationMs: 30_000,
		});
		await new Promise((resolve) => setImmediate(resolve));
		stderr.push(
			'{"control":"claim_activity_v1_result","request_id":"claim-request-1","outcome":"granted","claim_event_id":"id","claim_event_digest":"sha256:claim","lease_id":"lease-1","lease_expires_at":"time","unexpected":true}\n',
		);
		await expect(claimP).rejects.toThrow(
			"malformed activity authority response",
		);
		expect(failure).toHaveBeenCalledOnce();
	});

	it("records a terminal governed activity result through the control channel", async () => {
		const { stdin, stderr, childExit } = createMock();
		const emitterP = createTapeEmitter({
			childStdin: asWritable(stdin),
			childStderr: asReadable(stderr),
			childExit,
			workspacePath: "/tmp/ws",
			runId,
		});
		setImmediate(() =>
			stderr.push(
				`{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}\n`,
			),
		);
		const emitter = await emitterP;
		const recordP = emitter.recordActivityResult({
			requestId: "result-request-1",
			runId,
			activityId: "model:attempt:1",
			idempotencyKey: "sha256:activity",
			leaseId: "lease-1",
			outcome: "succeeded",
			resultDigest: digest,
			resultRef: "cas://result",
			evidenceDigest: digest,
			evidenceRef: "cas://evidence",
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(stdin.writes.at(-1)).toContain(
			`"control":"record_activity_result_v1"`,
		);
		stderr.push(
			'{"control":"record_activity_result_v1_result","request_id":"result-request-1","outcome":"recorded","result_event_id":"01919000-0000-7000-8000-000000000003","result_event_digest":"sha256:result","result_outcome":"succeeded"}\n',
		);
		await expect(recordP).resolves.toMatchObject({
			outcome: "recorded",
			result_outcome: "succeeded",
		});
	});

	it("heartbeats a governed activity through the authority-owned control channel", async () => {
		const { stdin, stderr, childExit } = createMock();
		const emitterP = createTapeEmitter({
			childStdin: asWritable(stdin),
			childStderr: asReadable(stderr),
			childExit,
			workspacePath: "/tmp/ws",
			runId,
		});
		setImmediate(() =>
			stderr.push(
				`{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}\n`,
			),
		);
		const emitter = await emitterP;
		const heartbeatP = emitter.heartbeatActivity({
			requestId: "heartbeat-request-1",
			runId,
			activityId: "model:attempt:1",
			idempotencyKey: "sha256:activity",
			leaseId: "lease-1",
			heartbeatId: "heartbeat-1",
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(stdin.writes.at(-1)).toContain(`"control":"heartbeat_activity_v1"`);
		stderr.push(
			'{"control":"heartbeat_activity_v1_result","request_id":"heartbeat-request-1","outcome":"existing","heartbeat_event_id":"01919000-0000-7000-8000-000000000003","heartbeat_event_digest":"sha256:heartbeat","lease_expires_at":"2026-07-18T12:00:00Z"}\n',
		);
		await expect(heartbeatP).resolves.toMatchObject({
			outcome: "existing",
			heartbeat_event_id: "01919000-0000-7000-8000-000000000003",
		});
	});

	it("refuses caller-crafted trust-spine activity events on the generic emitter", async () => {
		const { stdin, stderr, childExit } = createMock();
		const emitterP = createTapeEmitter({
			childStdin: asWritable(stdin),
			childStderr: asReadable(stderr),
			childExit,
			workspacePath: "/tmp/ws",
			runId,
		});
		setImmediate(() =>
			stderr.push(
				`{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}\n`,
			),
		);
		const emitter = await emitterP;

		expect(() =>
			emitter.emit("activity_heartbeat_recorded_v1", {
				forged: true,
			}),
		).toThrow("authority-owned control");
		expect(
			stdin.writes.some((line) =>
				line.includes("activity_heartbeat_recorded_v1"),
			),
		).toBe(false);
	});
});
