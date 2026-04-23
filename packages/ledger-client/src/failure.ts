import type { Readable } from "node:stream";

export type LedgerFailureKind =
	| "exit"
	| "handshake_timeout"
	| "handshake_rejected"
	| "protocol_error";

export interface LedgerFailure {
	kind: LedgerFailureKind;
	exitCode: number | null;
	stderrTail: string;
	lastAckedEventId: string | null;
	message: string;
}

/** Accumulates the last N bytes of a Readable stream (default 8 KiB).
 * Detaches on close.
 */
export class StderrTailer {
	private buf: string = "";
	private readonly limit: number;

	constructor(stream: Readable, limit = 8 * 1024) {
		this.limit = limit;
		const onData = (chunk: Buffer | string) => {
			const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			this.buf = (this.buf + s).slice(-this.limit);
		};
		stream.on("data", onData);
		stream.once("close", () => stream.off("data", onData));
	}

	tail(): string {
		return this.buf;
	}
}

export class LedgerHandshakeError extends Error {
	constructor(readonly failure: LedgerFailure) {
		super(failure.message);
		this.name = "LedgerHandshakeError";
	}
}
