import type { Writable } from "node:stream";

export interface WriteQueueOptions {
	/** Maximum number of pending writes before new writes await the head of the chain. Default 1024. */
	highWatermark?: number;
}

/** A serial write queue that awaits `drain` when the underlying pipe is full.
 * Public `write()` returns a Promise<void> that resolves when the line has
 * been handed to the pipe (not necessarily flushed to disk). Internal state
 * is a linear chain of promises; `depth()` reports in-flight writes.
 */
export class WriteQueue {
	private tail: Promise<void> = Promise.resolve();
	private inFlight: number = 0;
	private drainPromise: Promise<void> | null = null;
	private readonly highWatermark: number;

	constructor(
		private readonly pipe: Writable,
		opts: WriteQueueOptions = {},
	) {
		this.highWatermark = opts.highWatermark ?? 1024;
	}

	write(chunk: string): Promise<void> {
		const prev = this.tail;
		const shouldBlock = this.inFlight >= this.highWatermark;
		const waitForHead = shouldBlock ? prev : Promise.resolve();

		this.inFlight += 1;
		const current = waitForHead.then(async () => {
			const ok = this.pipe.write(chunk);
			if (!ok) {
				await this.waitForDrain();
			}
		});
		this.tail = current.catch(() => undefined);
		return current.finally(() => {
			this.inFlight = Math.max(0, this.inFlight - 1);
		});
	}

	private waitForDrain(): Promise<void> {
		this.drainPromise ??= new Promise<void>((resolve, reject) => {
			const clear = () => {
				this.pipe.off("drain", onDrain);
				this.pipe.off("error", onError);
				this.drainPromise = null;
			};
			const onDrain = () => {
				clear();
				resolve();
			};
			const onError = (error: Error) => {
				clear();
				reject(error);
			};

			this.pipe.once("drain", onDrain);
			this.pipe.once("error", onError);
		});
		return this.drainPromise;
	}

	async flush(): Promise<void> {
		await this.tail;
	}

	depth(): number {
		return this.inFlight;
	}
}
