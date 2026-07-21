/**
 * Bind npm publication to the Trust Spine's host-issued release evidence.
 *
 * This process boundary is intentionally independent of the release workflow:
 * changesets/action can invoke `pnpm release:publish` without running a
 * preceding workflow step, so the publish command itself must reject an
 * unbound or unverified release.
 */

import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const filename = fileURLToPath(import.meta.url);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const gateEntrypoint = fileURLToPath(
	new URL("../../eval/trust-spine-release-gate-cli.ts", import.meta.url),
);
const exactGitSha = /^[a-f0-9]{40}$/;
const canonicalReleaseRef = "refs/heads/main";

/**
 * @param {NodeJS.ProcessEnv} env
 */
function requireReleaseIdentity(env) {
	const campaignBundle = env.TRUST_SPINE_CAMPAIGN_BUNDLE;
	if (typeof campaignBundle !== "string" || !isAbsolute(campaignBundle)) {
		throw new Error("TRUST_SPINE_CAMPAIGN_BUNDLE must be an absolute path.");
	}

	const commit = env.GITHUB_SHA;
	if (typeof commit !== "string" || !exactGitSha.test(commit)) {
		throw new Error(
			"GITHUB_SHA must be an exact 40-character lowercase Git SHA.",
		);
	}

	const ref = env.GITHUB_REF;
	if (ref !== canonicalReleaseRef) {
		throw new Error(`GITHUB_REF must be ${canonicalReleaseRef}.`);
	}

	return { campaignBundle, commit, ref };
}

/**
 * Run the immutable campaign gate with the GitHub release identity. A gate
 * rejection returns its exact non-zero exit code so no build or npm command
 * can continue after failed evidence verification.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function verifyReleaseEvidence(env = process.env) {
	const { campaignBundle, commit, ref } = requireReleaseIdentity(env);
	const gate = spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			gateEntrypoint,
			"--bundle",
			campaignBundle,
			"--commit",
			commit,
			"--ref",
			ref,
		],
		{
			cwd: repositoryRoot,
			env,
			stdio: "inherit",
		},
	);
	if (gate.error) {
		throw gate.error;
	}
	return gate.status ?? 1;
}

function isExecutedDirectly() {
	return resolve(process.argv[1] ?? "") === filename;
}

if (isExecutedDirectly()) {
	try {
		process.exitCode = verifyReleaseEvidence();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	}
}
