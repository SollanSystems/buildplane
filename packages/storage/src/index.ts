import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { BuildplaneStoragePort } from "@buildplane/kernel";
import {
	assertBuildplaneDatabaseIsInitialized,
	insertProjectInitializedEvent,
	openBuildplaneDatabase,
} from "./database.js";
import { resolveProjectLayout } from "./project-layout.js";
import {
	bootstrapStorageProjectionSchema,
	createStorageStore,
} from "./store.js";

export type {
	ArtifactRecord,
	DecisionRecord,
	EvidenceRecord,
} from "./contracts";

export { createEventStore, type EventStore } from "./event-store.js";
export type { RunHistoryEntry } from "./store.js";

export interface ProjectInitializationResult {
	readonly created: boolean;
	readonly projectRoot: string;
	readonly stateDbPath: string;
}

export interface BuildplaneStorage extends BuildplaneStoragePort {
	initializeProject(): ProjectInitializationResult;
	getRunHistory(): import("./store.js").RunHistoryEntry[];
	getPacketSnapshot(
		runId: string,
	): import("@buildplane/kernel").UnitPacket | null;
}

export function createBuildplaneStorage(
	projectRoot: string,
): BuildplaneStorage {
	const layout = resolveProjectLayout(projectRoot);

	const store = createStorageStore(projectRoot);

	return {
		...store,
		initializeProject() {
			const hasProjectJson = existsSync(layout.projectJsonPath);
			const hasStateDb = existsSync(layout.stateDbPath);
			const initializedAt = new Date().toISOString();

			if (hasProjectJson !== hasStateDb) {
				throw new Error(
					"Buildplane state is incomplete: project.json exists but state.db is missing. Remove .buildplane or repair the state before rerunning `buildplane init`.",
				);
			}

			const created = !hasProjectJson;

			mkdirSync(layout.buildplaneDir, { recursive: true });
			mkdirSync(layout.artifactsDir, { recursive: true });
			mkdirSync(layout.evidenceDir, { recursive: true });
			mkdirSync(layout.runsDir, { recursive: true });
			mkdirSync(layout.logsDir, { recursive: true });

			const database = openBuildplaneDatabase(layout.stateDbPath);
			bootstrapStorageProjectionSchema(database);

			if (created) {
				writeFileSync(
					layout.projectJsonPath,
					JSON.stringify({
						schemaVersion: 1,
						defaultPolicyProfile: "default",
						initializedAt,
					}),
				);

				database
					.prepare(
						`INSERT INTO projects (project_root, initialized_at, default_policy_profile) VALUES (?, ?, ?)`,
					)
					.run(projectRoot, initializedAt, "default");

				insertProjectInitializedEvent(database, {
					projectRoot,
					defaultPolicyProfile: "default",
					initializedAt,
				});
			} else {
				assertBuildplaneDatabaseIsInitialized(layout.stateDbPath, projectRoot);
			}

			database.close();

			return {
				created,
				projectRoot,
				stateDbPath: layout.stateDbPath,
			};
		},
	};
}
