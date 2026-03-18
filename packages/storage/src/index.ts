import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import {
	assertBuildplaneDatabaseIsInitialized,
	insertProjectInitializedEvent,
	openBuildplaneDatabase,
} from "./database.js";
import { resolveProjectLayout } from "./project-layout.js";

export type {
	ArtifactRecord,
	DecisionRecord,
	EvidenceRecord,
} from "./contracts";

export interface ProjectInitializationResult {
	readonly created: boolean;
	readonly projectRoot: string;
	readonly stateDbPath: string;
}

export interface BuildplaneStorage {
	initializeProject(): ProjectInitializationResult;
}

export function createBuildplaneStorage(
	projectRoot: string,
): BuildplaneStorage {
	const layout = resolveProjectLayout(projectRoot);

	return {
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

			if (created) {
				const database = openBuildplaneDatabase(layout.stateDbPath);

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
				database.close();
			} else {
				assertBuildplaneDatabaseIsInitialized(layout.stateDbPath, projectRoot);
			}

			return {
				created,
				projectRoot,
				stateDbPath: layout.stateDbPath,
			};
		},
	};
}
