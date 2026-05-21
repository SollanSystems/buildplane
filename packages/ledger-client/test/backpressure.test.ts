import { EventEmitter } from "node:events";
import type { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { WriteQueue } from "../src/backpressure.js";

class MockPipe extends EventEmitter {
	public writes: string[] = [];
	public writable = true;

	write(chunk: string | Buffer, cb?: (err: Error | null) => void): boolean {
		const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		this.writes.push(s);
		if (cb) process.nextTick(() => cb(null));
		return this.writable;
	}

	drain() {
		this.writable = true;
		this.emit("drain");
	}

	fill() {
		this.writable = false;
	}
}

function asWritable(pipe: MockPipe): Writable {
	return pipe as unknown as Writable;
}

describe("WriteQueue", () => {
	it("writes a single line", async () => {
		const pipe = new MockPipe();
		const q = new WriteQueue(asWritable(pipe));
		q.write("hello\n");
		await q.flush();
		expect(pipe.writes).toEqual(["hello\n"]);
	});

	it("serializes concurrent writes", async () => {
		const pipe = new MockPipe();
		const q = new WriteQueue(asWritable(pipe));
		q.write("a\n");
		q.write("b\n");
		q.write("c\n");
		await q.flush();
		expect(pipe.writes).toEqual(["a\n", "b\n", "c\n"]);
	});

	it("awaits drain when pipe is full", async () => {
		const pipe = new MockPipe();
		pipe.fill();
		const q = new WriteQueue(asWritable(pipe), { highWatermark: 2 });
		q.write("a\n");
		q.write("b\n");
		const third = q.write("c\n");
		expect(q.depth()).toBeGreaterThanOrEqual(1);
		pipe.drain();
		await third;
		await q.flush();
		expect(pipe.writes).toEqual(["a\n", "b\n", "c\n"]);
	});

	it("keeps only one drain waiter active while the pipe is full", async () => {
		const pipe = new MockPipe();
		pipe.fill();
		const q = new WriteQueue(asWritable(pipe), { highWatermark: 100 });
		const writes = Array.from({ length: 20 }, (_, i) => q.write(`${i}\n`));

		await Promise.resolve();

		expect(pipe.listenerCount("drain")).toBeLessThanOrEqual(1);
		expect(pipe.listenerCount("error")).toBeLessThanOrEqual(1);
		pipe.drain();
		await Promise.all(writes);
		await q.flush();
		expect(pipe.writes).toEqual(Array.from({ length: 20 }, (_, i) => `${i}\n`));
	});

	it("reports depth accurately", async () => {
		const pipe = new MockPipe();
		pipe.fill();
		const q = new WriteQueue(asWritable(pipe), { highWatermark: 100 });
		q.write("a\n");
		q.write("b\n");
		await Promise.resolve();
		expect(q.depth()).toBeGreaterThan(0);
		pipe.drain();
		await q.flush();
		expect(q.depth()).toBe(0);
	});
});
