import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createTapeEmitter } from "../src/emitter.js";

class MockWritable extends EventEmitter {
	public writes: string[] = [];
	/** When set, `write` throws instead of accepting the chunk. */
	public throwOnWrite: Error | null = null;
	/** When true, `write` reports backpressure so the queue awaits `drain`. */
	public backpressured = false;
	write(chunk: string): boolean {
		if (this.throwOnWrite) throw this.throwOnWrite;
		this.writes.push(chunk);
		return !this.backpressured;
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

	it("resolves a retry candidate action identity through the closed native control", async () => {
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
		const identityP = emitter.resolveRetryCandidateActionIdentity({
			requestId: "retry-identity-request-1",
			runId,
			dispatchEventId: "01919000-0000-7000-8000-000000000001",
			candidateRef: "refs/buildplane/candidates/candidate-1/run-1/2",
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(JSON.parse(stdin.writes.at(-1)!)).toEqual({
			control: "resolve_retry_candidate_action_identity_v1",
			request_id: "retry-identity-request-1",
			run_id: runId,
			dispatch_event_id: "01919000-0000-7000-8000-000000000001",
			candidate_ref: "refs/buildplane/candidates/candidate-1/run-1/2",
		});
		stderr.push(
			'{"control":"resolve_retry_candidate_action_identity_v1_result","request_id":"retry-identity-request-1","outcome":"resolved","action_id":"git-candidate-create:candidate-1/run-1/2","activity_id":"git-candidate-create:candidate-1/run-1/2","idempotency_key":"dispatch:run-1:retry-candidate"}\n',
		);
		await expect(identityP).resolves.toMatchObject({
			outcome: "resolved",
			action_id: "git-candidate-create:candidate-1/run-1/2",
		});
	});

	it("fails closed on a malformed retry candidate action identity response", async () => {
		const { stdin, stderr, childExit } = createMock();
		const emitterP = createTapeEmitter({
			childStdin: asWritable(stdin),
			childStderr: asReadable(stderr),
			childExit,
			workspacePath: "/tmp/ws",
			runId,
			activityControlTimeoutMs: 100,
		});
		setImmediate(() =>
			stderr.push(
				`{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}\n`,
			),
		);
		const emitter = await emitterP;
		const failure = vi.fn();
		emitter.onFailure(failure);
		const identityP = emitter.resolveRetryCandidateActionIdentity({
			requestId: "retry-identity-request-1",
			runId,
			dispatchEventId: "01919000-0000-7000-8000-000000000001",
			candidateRef: "refs/buildplane/candidates/candidate-1/run-1/2",
		});
		await new Promise((resolve) => setImmediate(resolve));
		stderr.push(
			'{"control":"resolve_retry_candidate_action_identity_v1_result","request_id":"retry-identity-request-1","outcome":"resolved","action_id":"action","activity_id":"activity","idempotency_key":"key","unexpected":true}\n',
		);
		await expect(identityP).rejects.toThrow(
			"malformed activity authority response",
		);
		expect(failure).toHaveBeenCalledOnce();
	});

	it("fails closed when a retry identity request receives another control response", async () => {
		const { stdin, stderr, childExit } = createMock();
		const emitterP = createTapeEmitter({
			childStdin: asWritable(stdin),
			childStderr: asReadable(stderr),
			childExit,
			workspacePath: "/tmp/ws",
			runId,
			activityControlTimeoutMs: 100,
		});
		setImmediate(() =>
			stderr.push(
				`{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}\n`,
			),
		);
		const emitter = await emitterP;
		const identityP = emitter.resolveRetryCandidateActionIdentity({
			requestId: "retry-identity-request-1",
			runId,
			dispatchEventId: "01919000-0000-7000-8000-000000000001",
			candidateRef: "refs/buildplane/candidates/candidate-1/run-1/2",
		});
		await new Promise((resolve) => setImmediate(resolve));
		stderr.push(
			'{"control":"claim_activity_v1_result","request_id":"retry-identity-request-1","outcome":"rejected","code":"wrong_control","message":"wrong control"}\n',
		);
		await expect(identityP).rejects.toThrow("incompatible pending control");
	});

	it("fails closed on an unsolicited retry candidate action identity response", async () => {
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
		stderr.push(
			'{"control":"resolve_retry_candidate_action_identity_v1_result","request_id":"unsolicited-request","outcome":"rejected","code":"untrusted","message":"unsolicited"}\n',
		);
		await new Promise((resolve) => setImmediate(resolve));
		expect(failure).toHaveBeenCalledOnce();
		expect(failure.mock.calls[0][0].message).toContain("unsolicited");
	});

	const handshakeAck = `{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}\n`;
	const tick = () => new Promise((r) => setImmediate(r));

	async function createReadyEmitter(
		extra: { stallTimeoutMs?: number } = {},
	): Promise<{
		emitter: Awaited<ReturnType<typeof createTapeEmitter>>;
		stdin: MockWritable;
		stderr: MockReadable;
		exitResolve: (code: number) => void;
	}> {
		const { stdin, stderr, childExit, exitResolve } = createMock();
		const emitterP = createTapeEmitter({
			childStdin: asWritable(stdin),
			childStderr: asReadable(stderr),
			childExit,
			workspacePath: "/tmp/ws",
			runId,
			...extra,
		});
		setImmediate(() => stderr.push(handshakeAck));
		return { emitter: await emitterP, stdin, stderr, exitResolve };
	}

	it("surfaces a throwing emit pipe write while the child is still alive", async () => {
		const { emitter, stdin } = await createReadyEmitter();
		const failure = vi.fn();
		emitter.onFailure(failure);

		// The child never exits and never writes a protocol error line: before
		// this slice the rejection was swallowed by `catch(() => {})` and the
		// event vanished with no loud path at all.
		stdin.throwOnWrite = new Error("EPIPE: broken pipe");
		emitter.emit("run_started", { RunStartedV1: { packet_hash: "sha256:aa" } });
		await tick();

		expect(failure).toHaveBeenCalledOnce();
		const record = failure.mock.calls[0][0];
		expect(record.kind).toBe("protocol_error");
		expect(record.exitCode).toBeNull();
		expect(record.message).toContain("run_started");
		expect(record.message).toContain("EPIPE");

		// The failure latches: later emits no-op instead of writing.
		stdin.throwOnWrite = null;
		const writesBefore = stdin.writes.length;
		emitter.emit("unit_started", {});
		await tick();
		expect(stdin.writes.length).toBe(writesBefore);

		await expect(emitter.close()).rejects.toThrow("ledger failed");
	});

	it("surfaces a pipe error raised while an emit awaits drain", async () => {
		const { emitter, stdin } = await createReadyEmitter();
		const failure = vi.fn();
		emitter.onFailure(failure);

		stdin.backpressured = true;
		emitter.emit("run_started", { RunStartedV1: { packet_hash: "sha256:aa" } });
		await tick();
		stdin.emit("error", new Error("EPIPE: broken pipe"));
		await tick();

		expect(failure).toHaveBeenCalledOnce();
		expect(failure.mock.calls[0][0].kind).toBe("protocol_error");
		expect(failure.mock.calls[0][0].message).toContain("EPIPE");
	});

	it("fails loud when a flush ack never arrives", async () => {
		const { emitter } = await createReadyEmitter({ stallTimeoutMs: 50 });
		const failure = vi.fn();
		emitter.onFailure(failure);

		await expect(emitter.flush()).rejects.toThrow(/timed out .*flush_ack/);
		expect(failure).toHaveBeenCalledOnce();
		const record = failure.mock.calls[0][0];
		expect(record.kind).toBe("protocol_error");
		expect(record.message).toContain("queueDepth=");
		expect(record.message).toContain("lastAckedEventId=");
	});

	it("fails loud when a close ack never arrives", async () => {
		const { emitter } = await createReadyEmitter({ stallTimeoutMs: 50 });
		const failure = vi.fn();
		emitter.onFailure(failure);

		await expect(emitter.close()).rejects.toThrow(/timed out .*close_ack/);
		expect(failure).toHaveBeenCalledOnce();
		expect(failure.mock.calls[0][0].kind).toBe("protocol_error");
	});

	it("fails loud when the child never exits after a close ack", async () => {
		const { emitter, stdin, stderr } = await createReadyEmitter({
			stallTimeoutMs: 50,
		});
		const failure = vi.fn();
		emitter.onFailure(failure);

		const closeP = emitter.close();
		await tick();
		const closeLine = stdin.writes.find((w) => w.includes(`"control":"close"`));
		expect(closeLine).toBeTruthy();
		const seq = JSON.parse(closeLine as string).seq;
		stderr.push(
			`{"control":"close_ack","seq":${seq},"last_event_id":"01919000-0000-7000-8000-000000000001"}\n`,
		);

		// The ack lands, so the old code advanced to an unbounded
		// `await opts.childExit` and hung forever on a child that never exits.
		await expect(closeP).rejects.toThrow(/timed out .*ledger exit/);
		expect(failure).toHaveBeenCalledOnce();
		expect(failure.mock.calls[0][0].kind).toBe("protocol_error");
	});

	it("close resolves normally when the ack and the child exit arrive", async () => {
		const { emitter, stdin, stderr, exitResolve } = await createReadyEmitter({
			stallTimeoutMs: 50,
		});
		const failure = vi.fn();
		emitter.onFailure(failure);

		const closeP = emitter.close();
		await tick();
		const closeLine = stdin.writes.find((w) => w.includes(`"control":"close"`));
		const seq = JSON.parse(closeLine as string).seq;
		stderr.push(
			`{"control":"close_ack","seq":${seq},"last_event_id":"01919000-0000-7000-8000-000000000001"}\n`,
		);
		exitResolve(0);

		await expect(closeP).resolves.toBeUndefined();
		expect(failure).not.toHaveBeenCalled();
		expect(emitter.stats().lastAckedEventId).toBe(
			"01919000-0000-7000-8000-000000000001",
		);
	});

	it("rejects a non-positive stall timeout", async () => {
		const { stdin, stderr, childExit } = createMock();
		setImmediate(() => stderr.push(handshakeAck));
		await expect(
			createTapeEmitter({
				childStdin: asWritable(stdin),
				childStderr: asReadable(stderr),
				childExit,
				workspacePath: "/tmp/ws",
				runId,
				stallTimeoutMs: 0,
			}),
		).rejects.toThrow("stallTimeoutMs must be a positive integer");
	});

	it("refuses caller-crafted trust-spine authority events on the generic emitter", async () => {
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

		for (const kind of [
			"activity_heartbeat_recorded_v1",
			"dispatch_envelope_v5",
			"governed_dispatch_v5_admission_recorded_v1",
			"context_manifest_declared_v1",
			"worker_manifest_declared_v1",
			"sandbox_profile_declared_v1",
			"attempt_context_declared_v1",
		]) {
			expect(() =>
				emitter.emit(kind, {
					forged: true,
				}),
			).toThrow("authority-owned control");
			expect(stdin.writes.some((line) => line.includes(kind))).toBe(false);
		}
	});
});
