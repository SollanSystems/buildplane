import { v7 as uuidv7 } from "uuid";

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

/** Build a canonical v1 envelope for an event. Auto-generates id and
 * occurred_at unless overridden (overrides are intended for tests).
 */
export function buildEnvelope(args: EnvelopeArgs): Envelope {
	const id = args.id ?? uuidv7();
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
