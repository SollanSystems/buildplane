import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { performHandshake } from "../src/handshake.js";

class MockWritable extends EventEmitter {
	public writes: string[] = [];
	write(chunk: string): boolean {
		this.writes.push(chunk);
		return true;
	}
}

class MockReadable extends EventEmitter {
	push(line: string) {
		this.emit("data", Buffer.from(line));
	}
}

function asWritable(w: MockWritable): Writable {
	return w as unknown as Writable;
}
function asReadable(r: MockReadable): Readable {
	return r as unknown as Readable;
}

describe("performHandshake", () => {
	it("resolves on ready:true", async () => {
		const stdin = new MockWritable();
		const stderr = new MockReadable();
		const promise = performHandshake({
			stdin: asWritable(stdin),
			stderr: asReadable(stderr),
			runId: "01919000-0000-7000-8000-000000000000",
			schemaVersion: 1,
			timeoutMs: 5000,
		});
		setImmediate(() => {
			stderr.push(
				`{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}\n`,
			);
		});
		const result = await promise;
		expect(result.ready).toBe(true);
		expect(result.ledgerVersion).toBe("0.1.0");
		expect(stdin.writes[0]).toContain(`"control":"handshake"`);
	});

	it("rejects on ready:false with reason", async () => {
		const stdin = new MockWritable();
		const stderr = new MockReadable();
		const promise = performHandshake({
			stdin: asWritable(stdin),
			stderr: asReadable(stderr),
			runId: "01919000-0000-7000-8000-000000000000",
			schemaVersion: 99,
			timeoutMs: 5000,
		});
		setImmediate(() => {
			stderr.push(
				`{"control":"handshake_ack","ready":false,"reason":"bad schema"}\n`,
			);
		});
		await expect(promise).rejects.toThrow(/bad schema/);
	});

	it("rejects on timeout", async () => {
		const stdin = new MockWritable();
		const stderr = new MockReadable();
		const promise = performHandshake({
			stdin: asWritable(stdin),
			stderr: asReadable(stderr),
			runId: "01919000-0000-7000-8000-000000000000",
			schemaVersion: 1,
			timeoutMs: 50,
		});
		await expect(promise).rejects.toThrow(/handshake.*timeout/i);
	});
});
