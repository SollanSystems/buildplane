import { v7 as uuidv7 } from "uuid";
import { assertActionReceiptRecordedV2SafeIntegerResources } from "./payload.js";

export interface EnvelopeArgs {
	runId: string;
	schemaVersion: number;
	kind: string;
	// biome-ignore lint/suspicious/noExplicitAny: Payload is the union from generated+payload.ts
	payload: any;
	parent?: string;
	id?: string;
	occurredAt?: string;
}

export interface Envelope {
	id: string;
	run_id: string;
	parent_event_id: string | null;
	schema_version: number;
	kind: string;
	occurred_at: string;
	// biome-ignore lint/suspicious/noExplicitAny: see above
	payload: any;
}

/** Generate a UUIDv7 for ledger-local correlation identifiers. */
export function newLedgerEventId(): string {
	return uuidv7();
}

/** Build a canonical v1 envelope for an event. Auto-generates id and
 * occurred_at unless overridden (overrides are intended for tests).
 */
export function buildEnvelope(args: EnvelopeArgs): Envelope {
	if (args.kind === "action_receipt_recorded_v2") {
		assertActionReceiptRecordedV2SafeIntegerResources(args.payload);
	}
	const id = args.id ?? newLedgerEventId();
	const occurredAt = args.occurredAt ?? new Date().toISOString();
	return {
		id,
		run_id: args.runId,
		parent_event_id: args.parent ?? null,
		schema_version: args.schemaVersion,
		kind: args.kind,
		occurred_at: occurredAt,
		payload: args.payload,
	};
}
