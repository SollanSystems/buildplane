import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const releaseEvidenceWrapper = join(
	root,
	"scripts",
	"trust-spine",
	"verify-release-evidence.mjs",
);

function runReleaseEvidenceWrapper(env: Record<string, string | undefined>) {
	const childEnv = { ...process.env };
	delete childEnv.TRUST_SPINE_CAMPAIGN_BUNDLE;
	delete childEnv.GITHUB_SHA;
	delete childEnv.GITHUB_REF;
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) {
			delete childEnv[key];
		} else {
			childEnv[key] = value;
		}
	}
	return spawnSync(process.execPath, [releaseEvidenceWrapper], {
		cwd: root,
		encoding: "utf8",
		env: childEnv,
	});
}

describe("Trust Spine release gate workflow boundary", () => {
	it("binds every release:publish invocation to the release-evidence wrapper first", () => {
		const packageJson = JSON.parse(
			readFileSync(join(root, "package.json"), "utf8"),
		) as { scripts?: Record<string, string> };

		expect(packageJson.scripts?.["verify:trust-spine:release-evidence"]).toBe(
			"node ./scripts/trust-spine/verify-release-evidence.mjs",
		);
		expect(packageJson.scripts?.["release:publish"]).toMatch(
			/^pnpm verify:trust-spine:release-evidence && pnpm build/,
		);
	});

	it("fails closed before publication when the required release identity is absent", () => {
		const result = runReleaseEvidenceWrapper({});

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("TRUST_SPINE_CAMPAIGN_BUNDLE");
	});

	it("rejects a non-absolute campaign bundle before it can invoke the gate", () => {
		const result = runReleaseEvidenceWrapper({
			TRUST_SPINE_CAMPAIGN_BUNDLE: "campaign.json",
			GITHUB_SHA: "a".repeat(40),
			GITHUB_REF: "refs/heads/main",
		});

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"TRUST_SPINE_CAMPAIGN_BUNDLE must be an absolute path",
		);
	});

	it("requires the exact GitHub SHA and canonical main ref", () => {
		const bundlePath = join(
			mkdtempSync(join(tmpdir(), "buildplane-trust-spine-release-")),
			"campaign.json",
		);
		writeFileSync(bundlePath, "{}", "utf8");

		const invalidSha = runReleaseEvidenceWrapper({
			TRUST_SPINE_CAMPAIGN_BUNDLE: bundlePath,
			GITHUB_SHA: "not-a-sha",
			GITHUB_REF: "refs/heads/main",
		});
		expect(invalidSha.status).toBe(1);
		expect(invalidSha.stderr).toContain(
			"GITHUB_SHA must be an exact 40-character lowercase Git SHA",
		);

		const invalidRef = runReleaseEvidenceWrapper({
			TRUST_SPINE_CAMPAIGN_BUNDLE: bundlePath,
			GITHUB_SHA: "a".repeat(40),
			GITHUB_REF: "main",
		});
		expect(invalidRef.status).toBe(1);
		expect(invalidRef.stderr).toContain("GITHUB_REF must be refs/heads/main");
	});

	it("passes the absolute bundle and GitHub identity through the Trust Spine gate", () => {
		const bundlePath = join(
			mkdtempSync(join(tmpdir(), "buildplane-trust-spine-release-")),
			"campaign.json",
		);
		writeFileSync(bundlePath, "{}", "utf8");

		const result = runReleaseEvidenceWrapper({
			TRUST_SPINE_CAMPAIGN_BUNDLE: bundlePath,
			GITHUB_SHA: "a".repeat(40),
			GITHUB_REF: "refs/heads/main",
		});

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("trust-spine-release-gate:");
	});

	it("runs the evidence gate only for a landing publish and before changesets publish", () => {
		const packageJson = JSON.parse(
			readFileSync(join(root, "package.json"), "utf8"),
		) as { scripts?: Record<string, string> };
		const workflow = readFileSync(
			join(root, ".github", "workflows", "release.yml"),
			"utf8",
		);
		const script = packageJson.scripts?.["trust-spine:release-preflight"];

		expect(script).toContain("trust-spine-release-preflight-cli.ts");
		expect(workflow).toContain("Verify Trust Spine release evidence");
		expect(workflow).toContain(
			"startsWith(github.event.head_commit.message, 'chore: version packages')",
		);
		expect(workflow).toContain(
			`pnpm trust-spine:release-preflight -- --stage runner --bundle "\${TRUST_SPINE_CAMPAIGN_BUNDLE}" --commit "\${GITHUB_SHA}" --ref "\${GITHUB_REF}"`,
		);
		const changesetsAction = workflow.slice(
			workflow.indexOf("uses: changesets/action"),
		);
		expect(changesetsAction).toContain(
			`TRUST_SPINE_CAMPAIGN_BUNDLE: \${{ vars.TRUST_SPINE_CAMPAIGN_BUNDLE }}`,
		);
		expect(
			workflow.indexOf("Verify Trust Spine release evidence"),
		).toBeLessThan(workflow.indexOf("uses: changesets/action"));
	});
});
