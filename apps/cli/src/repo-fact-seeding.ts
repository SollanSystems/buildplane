import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildplaneStoragePort, RepoFact } from "@buildplane/kernel";

export const REPO_FACT_KEYS = {
	primaryLanguage: "repo.primary-language",
	testRunner: "repo.test-runner",
	buildCommand: "repo.build-command",
	typecheckCommand: "repo.typecheck-command",
	lintCommand: "repo.lint-command",
} as const;

export interface RepoSignals {
	primaryLanguage?: string;
	testRunner?: string;
	buildCommand?: string;
	typecheckCommand?: string;
	lintCommand?: string;
}

export interface SeedProvenance {
	branch?: string;
	commitSha?: string;
}

const SIGNAL_TO_KEY: ReadonlyArray<readonly [keyof RepoSignals, string]> = [
	["primaryLanguage", REPO_FACT_KEYS.primaryLanguage],
	["testRunner", REPO_FACT_KEYS.testRunner],
	["buildCommand", REPO_FACT_KEYS.buildCommand],
	["typecheckCommand", REPO_FACT_KEYS.typecheckCommand],
	["lintCommand", REPO_FACT_KEYS.lintCommand],
];

// Inspection-seeded `repo.*` facts are AUTHORITATIVE for that namespace and are
// written idempotent last-writer-wins (ADR 0001 VF-2): re-seeding the same key
// overwrites the prior value with no conservatism. If a promote-derived fact
// sanitized to a colliding `repo.*` key, a re-seed would supersede it; `createdBy:
// "system"` distinguishes seed provenance.
export function seedRepoFactsFromInspection(
	port: Pick<BuildplaneStoragePort, "upsertRepoFact">,
	signals: RepoSignals,
	provenance: SeedProvenance,
): RepoFact[] {
	const seeded: RepoFact[] = [];
	for (const [signalKey, factKey] of SIGNAL_TO_KEY) {
		const value = signals[signalKey];
		if (value === undefined || value === "") {
			continue;
		}
		seeded.push(
			port.upsertRepoFact({
				factKey,
				factValue: value,
				valueType: "string",
				scopeType: "repo",
				createdBy: "system",
				confidence: 1,
				branch: provenance.branch,
				commitSha: provenance.commitSha,
			}),
		);
	}
	return seeded;
}

export function detectRepoSignals(projectRoot: string): RepoSignals {
	const pkgPath = join(projectRoot, "package.json");
	if (!existsSync(pkgPath)) {
		return {};
	}
	let pkg: { scripts?: Record<string, string> };
	try {
		pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	} catch {
		return {};
	}
	const scripts = pkg.scripts ?? {};
	const hasTsconfig = existsSync(join(projectRoot, "tsconfig.json"));
	return {
		primaryLanguage: hasTsconfig ? "typescript" : "javascript",
		testRunner: scripts.test,
		buildCommand: scripts.build,
		typecheckCommand: scripts.typecheck,
		lintCommand: scripts.lint,
	};
}
