import { join } from "node:path";

export interface BuildplaneProjectLayout {
	readonly projectRoot: string;
	readonly buildplaneDir: string;
	readonly stateDbPath: string;
	readonly artifactsDir: string;
	readonly evidenceDir: string;
	readonly runsDir: string;
	readonly logsDir: string;
	readonly workspacesDir: string;
	readonly projectJsonPath: string;
}

export function resolveProjectLayout(
	projectRoot: string,
): BuildplaneProjectLayout {
	const buildplaneDir = join(projectRoot, ".buildplane");

	return {
		projectRoot,
		buildplaneDir,
		stateDbPath: join(buildplaneDir, "state.db"),
		artifactsDir: join(buildplaneDir, "artifacts"),
		evidenceDir: join(buildplaneDir, "evidence"),
		runsDir: join(buildplaneDir, "runs"),
		logsDir: join(buildplaneDir, "logs"),
		workspacesDir: join(buildplaneDir, "workspaces"),
		projectJsonPath: join(buildplaneDir, "project.json"),
	};
}
