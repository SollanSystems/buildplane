import type { Readable, Writable } from "node:stream";
import { WriteQueue } from "./backpressure.js";
import { buildEnvelope } from "./envelope.js";
import { type LedgerFailure, StderrTailer } from "./failure.js";
import { performHandshake } from "./handshake.js";
import { buildClose, buildFlush, parseAckLine } from "./wire.js";

export interface CreateTapeEmitterOptions {
	childStdin: Writable;
	childStderr: Readable;
	childExit: Promise<number>;
	workspacePath: string;
	runId: string;
	/** Default: 30_000 ms. */
	handshakeTimeoutMs?: number;
	/** Default: 1024 events. */
	queueHighWatermark?: number;
	/** Default: 1. */
	schemaVersion?: number;
}

export interface EmitOptions {
	/** Parent event id, if any. UUIDv7. */
	parent?: string;
	/** Override auto-assigned id (tests only). */
	id?: string;
	/** Override occurred_at (tests only). */
	occurredAt?: string;
}

export interface TapeEmitter {
	emit(kind: string, payload: unknown, opts?: EmitOptions): void;
	flush(): Promise<void>;
	close(): Promise<void>;
	onFailure(cb: (reason: LedgerFailure) => void): void;
	stats(): {
		eventsEmitted: number;
		lastAckedEventId: string | null;
		queueDepth: number;
	};
}

export async function createTapeEmitter(
	opts: CreateTapeEmitterOptions,
): Promise<TapeEmitter> {
	const schemaVersion = opts.schemaVersion ?? 1;
	const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 30_000;
	const highWatermark = opts.queueHighWatermark ?? 1024;

	const tailer = new StderrTailer(opts.childStderr);

	await performHandshake({
		stdin: opts.childStdin,
		stderr: opts.childStderr,
		runId: opts.runId,
		schemaVersion,
		timeoutMs: handshakeTimeoutMs,
	});

	const queue = new WriteQueue(opts.childStdin, { highWatermark });
	const failureCallbacks: Array<(r: LedgerFailure) => void> = [];
	let failed = false;
	let eventsEmitted = 0;
	let lastAckedEventId: string | null = null;
	let flushSeq = 0;
	const pendingFlushes = new Map<
		number,
		{ resolve: () => void; reject: (e: Error) => void }
	>();
	let closeResolve: (() => void) | null = null;
	let closeReject: ((e: Error) => void) | null = null;

	let stderrBuf = "";
	const onStderrData = (chunk: Buffer | string) => {
		const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		stderrBuf += s;
		const lines = stderrBuf.split("\n");
		stderrBuf = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			const ack = parseAckLine(line);
			if (!ack) continue;
			if (ack.control === "flush_ack") {
				lastAckedEventId = ack.last_event_id || lastAckedEventId;
				const pending = pendingFlushes.get(ack.seq);
				if (pending) {
					pending.resolve();
					pendingFlushes.delete(ack.seq);
				}
			} else if (ack.control === "close_ack") {
				lastAckedEventId = ack.last_event_id || lastAckedEventId;
				if (closeResolve) closeResolve();
			} else if (ack.control === "error") {
				markFailed({
					kind: "protocol_error",
					exitCode: null,
					stderrTail: tailer.tail(),
					lastAckedEventId,
					message: `${ack.kind}: ${ack.message}`,
				});
			}
		}
	};
	opts.childStderr.on("data", onStderrData);

	function markFailed(failure: LedgerFailure): void {
		if (failed) return;
		failed = true;
		for (const cb of failureCallbacks) {
			try {
				cb(failure);
			} catch {}
		}
		for (const [, p] of pendingFlushes) {
			p.reject(new Error(failure.message));
		}
		pendingFlushes.clear();
		if (closeReject) closeReject(new Error(failure.message));
	}

	opts.childExit.then((code) => {
		if (code !== 0) {
			markFailed({
				kind: "exit",
				exitCode: code,
				stderrTail: tailer.tail(),
				lastAckedEventId,
				message: `ledger exited with code ${code}`,
			});
		}
	});

	return {
		emit(kind, payload, emitOpts) {
			if (failed) return;
			const env = buildEnvelope({
				runId: opts.runId,
				schemaVersion,
				kind,
				payload,
				parent: emitOpts?.parent,
				id: emitOpts?.id,
				occurredAt: emitOpts?.occurredAt,
			});
			const line = `${JSON.stringify(env)}\n`;
			eventsEmitted += 1;
			queue.write(line).catch(() => {
				// Failure surfaced via onFailure; don't bubble here.
			});
		},
		async flush() {
			if (failed) throw new Error("ledger failed; flush unavailable");
			const seq = flushSeq++;
			const promise = new Promise<void>((resolve, reject) => {
				pendingFlushes.set(seq, { resolve, reject });
			});
			// Route through the queue so flush is serialized AFTER all preceding
			// emits. Bypassing would let flush ack before queued events reach the
			// ledger, breaking the "flush everything written so far" contract.
			await queue.write(buildFlush(seq));
			await promise;
		},
		async close() {
			if (failed) throw new Error("ledger failed; close unavailable");
			const seq = flushSeq++;
			const promise = new Promise<void>((resolve, reject) => {
				closeResolve = resolve;
				closeReject = reject;
			});
			await queue.write(buildClose(seq));
			await promise;
			const code = await opts.childExit;
			if (code !== 0 && !failed) {
				throw new Error(`ledger exited with code ${code} after close`);
			}
		},
		onFailure(cb) {
			failureCallbacks.push(cb);
		},
		stats() {
			return {
				eventsEmitted,
				lastAckedEventId,
				queueDepth: queue.depth(),
			};
		},
	};
}
