import { describe, expect, it } from "vitest";
import {
	buildClose,
	buildFlush,
	buildHandshake,
	type CloseAck,
	type ErrorLine,
	type FlushAck,
	type HandshakeAck,
	parseAckLine,
} from "../src/wire.js";

describe("wire builders", () => {
	it("builds a handshake line", () => {
		const line = buildHandshake({
			protocol: 1,
			runId: "01919000-0000-7000-8000-000000000000",
			startedAt: "2026-04-17T12:00:00Z",
			schemaVersion: 1,
		});
		expect(line).toContain(`"control":"handshake"`);
		expect(line).toContain(`"protocol":1`);
		expect(line).toContain(`"schema_version":1`);
		expect(line.endsWith("\n")).toBe(true);
	});

	it("builds a flush line with seq", () => {
		expect(buildFlush(42)).toBe(`{"control":"flush","seq":42}\n`);
	});

	it("builds a close line with seq", () => {
		expect(buildClose(43)).toBe(`{"control":"close","seq":43}\n`);
	});
});

describe("parseAckLine", () => {
	it("parses a handshake_ack success", () => {
		const line = `{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}`;
		const ack = parseAckLine(line) as HandshakeAck;
		expect(ack.control).toBe("handshake_ack");
		expect(ack.ready).toBe(true);
		expect(ack.ledger_version).toBe("0.1.0");
	});

	it("parses a handshake_ack rejection", () => {
		const line = `{"control":"handshake_ack","ready":false,"reason":"bad schema"}`;
		const ack = parseAckLine(line) as HandshakeAck;
		expect(ack.ready).toBe(false);
		expect(ack.reason).toBe("bad schema");
	});

	it("parses a flush_ack", () => {
		const line = `{"control":"flush_ack","seq":7,"last_event_id":"01919000-0000-7000-8000-000000000001"}`;
		const ack = parseAckLine(line) as FlushAck;
		expect(ack.control).toBe("flush_ack");
		expect(ack.seq).toBe(7);
	});

	it("parses a close_ack", () => {
		const line = `{"control":"close_ack","events_written":5,"last_event_id":"01919000-0000-7000-8000-000000000002"}`;
		const ack = parseAckLine(line) as CloseAck;
		expect(ack.control).toBe("close_ack");
		expect(ack.events_written).toBe(5);
	});

	it("parses an error line", () => {
		const line = `{"control":"error","kind":"malformed_event","line":15,"message":"bad json"}`;
		const ack = parseAckLine(line) as ErrorLine;
		expect(ack.control).toBe("error");
		expect(ack.kind).toBe("malformed_event");
		expect(ack.line).toBe(15);
	});

	it("returns null on unrecognized control", () => {
		const line = `{"control":"unknown"}`;
		expect(parseAckLine(line)).toBeNull();
	});

	it("returns null on non-json", () => {
		expect(parseAckLine("not json")).toBeNull();
	});
});
