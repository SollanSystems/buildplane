import type { Readable, Writable } from "node:stream";
import { type LedgerFailure, LedgerHandshakeError } from "./failure.js";
import { buildHandshake, parseAckLine } from "./wire.js";

export interface HandshakeInput {
	stdin: Writable;
	stderr: Readable;
	runId: string;
	schemaVersion: number;
	timeoutMs: number;
}

export interface HandshakeResult {
	ready: true;
	ledgerVersion: string;
	schemaVersion: number;
}

/** Write a handshake line to stdin and await the ledger's handshake_ack on stderr.
 * Rejects with LedgerHandshakeError on timeout, rejection, or stream close.
 */
export function performHandshake(
	input: HandshakeInput,
): Promise<HandshakeResult> {
	return new Promise<HandshakeResult>((resolve, reject) => {
		const handshakeLine = buildHandshake({
			protocol: 1,
			runId: input.runId,
			startedAt: new Date().toISOString(),
			schemaVersion: input.schemaVersion,
		});

		let buffer = "";
		let settled = false;

		const cleanup = () => {
			input.stderr.off("data", onData);
			input.stderr.off("close", onClose);
			clearTimeout(timeout);
		};

		const settleWith = (
			ok: boolean,
			result: HandshakeResult | LedgerFailure,
		) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (ok) {
				resolve(result as HandshakeResult);
			} else {
				reject(new LedgerHandshakeError(result as LedgerFailure));
			}
		};

		const onData = (chunk: Buffer | string) => {
			const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			buffer += s;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				const ack = parseAckLine(line);
				if (ack && ack.control === "handshake_ack") {
					if (ack.ready) {
						settleWith(true, {
							ready: true,
							ledgerVersion: ack.ledger_version ?? "unknown",
							schemaVersion: ack.schema_version ?? input.schemaVersion,
						});
					} else {
						settleWith(false, {
							kind: "handshake_rejected",
							exitCode: null,
							stderrTail: line,
							lastAckedEventId: null,
							message: ack.reason ?? "handshake rejected",
						});
					}
					return;
				}
			}
		};

		const onClose = () => {
			settleWith(false, {
				kind: "handshake_timeout",
				exitCode: null,
				stderrTail: buffer,
				lastAckedEventId: null,
				message: "ledger stderr closed before handshake_ack",
			});
		};

		const timeout = setTimeout(() => {
			settleWith(false, {
				kind: "handshake_timeout",
				exitCode: null,
				stderrTail: buffer,
				lastAckedEventId: null,
				message: `handshake timeout: ledger did not respond within ${input.timeoutMs}ms`,
			});
		}, input.timeoutMs);

		input.stderr.on("data", onData);
		input.stderr.once("close", onClose);

		input.stdin.write(handshakeLine);
	});
}
