import { existsSync } from "node:fs";

export interface AdmittedPlanRecord {
	readonly authorizedNextStep: string;
	readonly signedByKernel: boolean;
}

export interface AdmittedPlanReader {
	read(
		eventsDbPath: string,
		eventId: string,
	): Promise<AdmittedPlanRecord | undefined>;
}

/**
 * Reads a signed `plan_admitted` event by its tape event id and reports whether a
 * kernel-signed signature row exists. Structural signature check only (actor / key /
 * algorithm columns) — full Ed25519 byte verification is the external verifier's job
 * (M3). Read-only; never mutates the tape.
 */
export function createDefaultAdmittedPlanReader(): AdmittedPlanReader {
	return {
		async read(eventsDbPath, eventId) {
			if (!existsSync(eventsDbPath)) {
				return undefined;
			}
			const { DatabaseSync } = await import("node:sqlite");
			const db = new DatabaseSync(eventsDbPath, { readOnly: true });
			try {
				const row = db
					.prepare(
						"SELECT payload FROM events WHERE id = ? AND kind = 'plan_admitted'",
					)
					.get(eventId) as { payload?: string } | undefined;
				if (!row?.payload) {
					return undefined;
				}
				const parsed = JSON.parse(row.payload) as {
					PlanAdmittedV1?: { authorized_next_step?: string };
				};
				const sig = db
					.prepare(
						"SELECT actor_id, key_id, algorithm FROM event_signatures WHERE event_id = ?",
					)
					.get(eventId) as
					| { actor_id?: string; key_id?: string; algorithm?: string }
					| undefined;
				return {
					authorizedNextStep: parsed.PlanAdmittedV1?.authorized_next_step ?? "",
					signedByKernel:
						sig?.actor_id === "kernel" &&
						sig?.key_id === "kernel-main" &&
						sig?.algorithm === "ed25519",
				};
			} finally {
				db.close();
			}
		},
	};
}
