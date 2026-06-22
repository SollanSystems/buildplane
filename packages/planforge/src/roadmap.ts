import type { PlanForgeAllowedSideEffect } from "./schema.js";

export const PLANFORGE_ROADMAP_SCHEMA_VERSION =
	"buildplane.roadmap.v0" as const;

export type RoadmapSliceStatus = "pending" | "in-progress" | "done";

export interface RoadmapSlice {
	readonly id: string;
	readonly title: string;
	readonly status: RoadmapSliceStatus;
	readonly objective: string;
	readonly allowedSideEffects: readonly PlanForgeAllowedSideEffect[];
	readonly verificationCommands: readonly string[];
	readonly acceptanceCriteria: readonly string[];
	readonly dependsOn: readonly string[];
	readonly pathGlobs: readonly string[];
}

export interface RoadmapDoc {
	readonly schemaVersion: typeof PLANFORGE_ROADMAP_SCHEMA_VERSION;
	readonly milestone: string;
	readonly slices: readonly RoadmapSlice[];
}

const STATUSES: readonly RoadmapSliceStatus[] = [
	"pending",
	"in-progress",
	"done",
];

function assertStringArray(
	value: unknown,
	field: string,
	sliceId: string,
): readonly string[] {
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
		throw new Error(
			`roadmap slice ${sliceId}: ${field} must be a string array`,
		);
	}
	return value as readonly string[];
}

function parseSlice(raw: unknown): RoadmapSlice {
	if (typeof raw !== "object" || raw === null) {
		throw new Error("roadmap slice must be an object");
	}
	const r = raw as Record<string, unknown>;
	const id = r.id;
	if (typeof id !== "string" || id.length === 0) {
		throw new Error("roadmap slice is missing a string id");
	}
	// Commas are prohibited in slice ids: GAP-2's Depends-on bullet is comma-split,
	// so a comma in an id would corrupt the dependency graph it round-trips through.
	if (id.includes(",")) {
		throw new Error(`roadmap slice ${id}: id must not contain a comma`);
	}
	if (
		typeof r.status !== "string" ||
		!STATUSES.includes(r.status as RoadmapSliceStatus)
	) {
		throw new Error(
			`roadmap slice ${id}: status must be one of ${STATUSES.join(", ")}`,
		);
	}
	if (typeof r.title !== "string" || typeof r.objective !== "string") {
		throw new Error(`roadmap slice ${id}: title and objective must be strings`);
	}
	const verificationCommands = assertStringArray(
		r.verificationCommands,
		"verificationCommands",
		id,
	);
	if (verificationCommands.length === 0) {
		throw new Error(
			`roadmap slice ${id}: verificationCommands must be non-empty (false-completion guard)`,
		);
	}
	return {
		id,
		title: r.title,
		status: r.status as RoadmapSliceStatus,
		objective: r.objective,
		allowedSideEffects: assertStringArray(
			r.allowedSideEffects,
			"allowedSideEffects",
			id,
		) as readonly PlanForgeAllowedSideEffect[],
		verificationCommands,
		acceptanceCriteria: assertStringArray(
			r.acceptanceCriteria,
			"acceptanceCriteria",
			id,
		),
		dependsOn: assertStringArray(r.dependsOn, "dependsOn", id),
		pathGlobs: assertStringArray(r.pathGlobs, "pathGlobs", id),
	};
}

export function loadRoadmapFromString(json: string): RoadmapDoc {
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch (err) {
		throw new Error(`roadmap is not valid JSON: ${String(err)}`);
	}
	if (typeof raw !== "object" || raw === null) {
		throw new Error("roadmap must be a JSON object");
	}
	const r = raw as Record<string, unknown>;
	if (r.schemaVersion !== PLANFORGE_ROADMAP_SCHEMA_VERSION) {
		throw new Error(
			`roadmap schemaVersion must be ${PLANFORGE_ROADMAP_SCHEMA_VERSION}`,
		);
	}
	if (typeof r.milestone !== "string") {
		throw new Error("roadmap milestone must be a string");
	}
	if (!Array.isArray(r.slices)) {
		throw new Error("roadmap slices must be an array");
	}
	return {
		schemaVersion: PLANFORGE_ROADMAP_SCHEMA_VERSION,
		milestone: r.milestone,
		slices: r.slices.map(parseSlice),
	};
}

export function selectNextRoadmapSlice(
	doc: RoadmapDoc,
	completedSliceIds: readonly string[],
): RoadmapSlice | undefined {
	const completed = new Set(completedSliceIds);
	for (const slice of doc.slices) {
		if (slice.status === "done" || completed.has(slice.id)) {
			continue;
		}
		if (slice.status !== "pending") {
			continue;
		}
		if (slice.dependsOn.every((dep) => completed.has(dep))) {
			return slice;
		}
	}
	return undefined;
}
