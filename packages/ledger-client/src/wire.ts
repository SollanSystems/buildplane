/**
 * Wire protocol primitives for the bp-ledger IPC.
 *
 * Control messages go TS -> Rust on stdin (via string lines) and Rust -> TS on
 * stderr (as JSON ack lines). This file has no I/O — it builds strings and
 * parses strings.
 */

export interface HandshakeArgs {
	protocol: number;
	runId: string;
	startedAt: string;
	schemaVersion: number;
}

export function buildHandshake(args: HandshakeArgs): string {
	return `${JSON.stringify({
		control: "handshake",
		protocol: args.protocol,
		run_id: args.runId,
		started_at: args.startedAt,
		schema_version: args.schemaVersion,
	})}\n`;
}

export function buildFlush(seq: number): string {
	return `{"control":"flush","seq":${seq}}\n`;
}

export function buildClose(seq: number): string {
	return `{"control":"close","seq":${seq}}\n`;
}

export interface HandshakeAck {
	control: "handshake_ack";
	ready: boolean;
	ledger_version?: string;
	schema_version?: number;
	reason?: string;
}

export interface FlushAck {
	control: "flush_ack";
	seq: number;
	last_event_id: string;
}

export interface CloseAck {
	control: "close_ack";
	events_written: number;
	last_event_id: string;
}

export interface ErrorLine {
	control: "error";
	kind: string;
	line: number;
	message: string;
}

export type AckLine = HandshakeAck | FlushAck | CloseAck | ErrorLine;

/** Parse a JSON ack line from the ledger's stderr. Returns null if unrecognized. */
export function parseAckLine(line: string): AckLine | null {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	if (
		typeof value !== "object" ||
		value === null ||
		!("control" in value) ||
		typeof (value as { control: unknown }).control !== "string"
	) {
		return null;
	}
	const control = (value as { control: string }).control;
	switch (control) {
		case "handshake_ack":
		case "flush_ack":
		case "close_ack":
		case "error":
			return value as AckLine;
		default:
			return null;
	}
}
