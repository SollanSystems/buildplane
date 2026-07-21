import { describe, expect, it } from "vitest";
import {
	buildClaimActivityV1,
	buildClose,
	buildFlush,
	buildHandshake,
	buildHeartbeatActivityV1,
	buildRecordActivityResultV1,
	type CloseAck,
	type ErrorLine,
	type FlushAck,
	type HandshakeAck,
	isActivityControlResponseLine,
	parseAckLine,
} from "../src/wire.js";

const digest = `sha256:${"a".repeat(64)}`;

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

	it("builds a closed governed activity claim", () => {
		const line = buildClaimActivityV1({
			requestId: "request-1",
			runId: "01919000-0000-7000-8000-000000000000",
			activityId: "model:attempt:1",
			idempotencyKey: "sha256:activity",
			dispatchEventId: "01919000-0000-7000-8000-000000000001",
			actionRequestEventId: "01919000-0000-7000-8000-000000000002",
			leaseDurationMs: 30_000,
		});
		expect(JSON.parse(line)).toEqual({
			control: "claim_activity_v1",
			request_id: "request-1",
			run_id: "01919000-0000-7000-8000-000000000000",
			activity_id: "model:attempt:1",
			idempotency_key: "sha256:activity",
			dispatch_event_id: "01919000-0000-7000-8000-000000000001",
			action_request_event_id: "01919000-0000-7000-8000-000000000002",
			lease_duration_ms: 30_000,
		});
		expect(() =>
			buildClaimActivityV1({
				requestId: "request-1",
				runId: "run",
				activityId: "activity",
				idempotencyKey: "key",
				dispatchEventId: "dispatch",
				actionRequestEventId: "action",
				leaseDurationMs: 999,
			}),
		).toThrow("leaseDurationMs");
	});

	it("requires paired activity result references and mandatory evidence", () => {
		const line = buildRecordActivityResultV1({
			requestId: "request-1",
			runId: "run",
			activityId: "activity",
			idempotencyKey: "key",
			leaseId: "lease",
			outcome: "succeeded",
			resultDigest: digest,
			resultRef: "cas://result",
			evidenceDigest: digest,
			evidenceRef: "cas://evidence",
		});
		expect(JSON.parse(line).result_digest).toBe(digest);
		expect(() =>
			buildRecordActivityResultV1({
				requestId: "request-1",
				runId: "run",
				activityId: "activity",
				idempotencyKey: "key",
				leaseId: "lease",
				outcome: "unknown",
				resultDigest: digest,
				resultRef: "cas://result",
				evidenceDigest: digest,
				evidenceRef: "cas://evidence",
			}),
		).toThrow("unknown outcome");
	});

	it("builds an authority-owned, closed activity heartbeat", () => {
		const line = buildHeartbeatActivityV1({
			requestId: "heartbeat-request-1",
			runId: "01919000-0000-7000-8000-000000000000",
			activityId: "model:attempt:1",
			idempotencyKey: "activity:heartbeat:1",
			leaseId: "lease:model:attempt:1",
			heartbeatId: "heartbeat:model:attempt:1",
		});
		expect(JSON.parse(line)).toEqual({
			control: "heartbeat_activity_v1",
			request_id: "heartbeat-request-1",
			run_id: "01919000-0000-7000-8000-000000000000",
			activity_id: "model:attempt:1",
			idempotency_key: "activity:heartbeat:1",
			lease_id: "lease:model:attempt:1",
			heartbeat_id: "heartbeat:model:attempt:1",
		});
		expect(() =>
			buildHeartbeatActivityV1({
				requestId: "heartbeat-request-1",
				runId: "run",
				activityId: "activity",
				idempotencyKey: "key",
				leaseId: "lease",
				heartbeatId: "",
			}),
		).toThrow("heartbeatId");
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

	it("strictly parses authority claim responses", () => {
		const line =
			'{"control":"claim_activity_v1_result","request_id":"request-1","outcome":"granted","claim_event_id":"01919000-0000-7000-8000-000000000001","claim_event_digest":"sha256:claim","lease_id":"lease-1","lease_expires_at":"2026-07-18T12:00:00Z"}';
		const ack = parseAckLine(line);
		expect(ack).toMatchObject({
			control: "claim_activity_v1_result",
			outcome: "granted",
			lease_id: "lease-1",
		});
		expect(isActivityControlResponseLine(line)).toBe(true);
		expect(
			parseAckLine(
				'{"control":"claim_activity_v1_result","request_id":"request-1","outcome":"granted","claim_event_id":"id","claim_event_digest":"sha256:claim","lease_id":"lease-1","lease_expires_at":"time","unexpected":true}',
			),
		).toBeNull();
	});

	it("strictly parses authority-owned heartbeat responses", () => {
		const recorded =
			'{"control":"heartbeat_activity_v1_result","request_id":"heartbeat-request-1","outcome":"recorded","heartbeat_event_id":"01919000-0000-7000-8000-000000000003","heartbeat_event_digest":"sha256:heartbeat","lease_expires_at":"2026-07-18T12:00:00Z"}';
		expect(parseAckLine(recorded)).toMatchObject({
			control: "heartbeat_activity_v1_result",
			outcome: "recorded",
			heartbeat_event_id: "01919000-0000-7000-8000-000000000003",
		});
		expect(isActivityControlResponseLine(recorded)).toBe(true);
		expect(
			parseAckLine(
				'{"control":"heartbeat_activity_v1_result","request_id":"heartbeat-request-1","outcome":"existing","heartbeat_event_id":"01919000-0000-7000-8000-000000000003","heartbeat_event_digest":"sha256:heartbeat","lease_expires_at":"2026-07-18T12:00:00Z"}',
			),
		).toMatchObject({ outcome: "existing" });
		expect(
			parseAckLine(
				'{"control":"heartbeat_activity_v1_result","request_id":"heartbeat-request-1","outcome":"lease_expired","claim_event_id":"01919000-0000-7000-8000-000000000004","lease_expires_at":"2026-07-18T12:00:00Z"}',
			),
		).toMatchObject({ outcome: "lease_expired" });
		expect(
			parseAckLine(
				'{"control":"heartbeat_activity_v1_result","request_id":"heartbeat-request-1","outcome":"recorded","heartbeat_event_id":"id","heartbeat_event_digest":"sha256:heartbeat","lease_expires_at":"time","unexpected":true}',
			),
		).toBeNull();
	});
});
