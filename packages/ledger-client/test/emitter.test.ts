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
});
