import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const execModule = import("../../scripts/ci/pr-auto-merge-execute.mjs");
const tempDirs: string[] = [];

function makeTempDir() {
	const dir = mkdtempSync(join(tmpdir(), "bp-auto-merge-exec-"));
	tempDirs.push(dir);
	return dir;
}

function makeReceipt(dir: string, overrides: Record<string, unknown> = {}) {
	const extra = (overrides.extra as Record<string, unknown>) ?? {};
	const timestamp = (extra.timestamp as string) ?? new Date().toISOString();
	const receipt: Record<string, unknown> = {
		timestamp,
		pr: overrides.pr ?? 126,
		url: `https://github.com/SollanSystems/buildplane/pull/${overrides.pr ?? 126}`,
		headSha: overrides.headSha ?? "abc123def4567890abc123def4567890abc123de",
		expectedHeadSha:
			overrides.headSha ?? "abc123def4567890abc123def4567890abc123de",
		verdict: overrides.verdict ?? "AUTO_MERGE_READY",
	};
	Object.keys(extra).forEach((k) => {
		if (k !== "timestamp") receipt[k] = extra[k];
	});
	const path = join(dir, "eligibility-receipt.json");
	writeFileSync(path, JSON.stringify(receipt, null, 2));
	return path;
}

function makeCanonicalEligibilityReceipt(
	dir: string,
	overrides: Record<string, unknown> = {},
) {
	const extra = (overrides.extra as Record<string, unknown>) ?? {};
	const timestamp = (extra.timestamp as string) ?? new Date().toISOString();
	const headSha =
		(overrides.headSha as string) ?? "abc123def4567890abc123def4567890abc123de";
	const receipt: Record<string, unknown> = {
		timestamp,
		status: overrides.verdict ?? "AUTO_MERGE_READY",
		pr: {
			number: overrides.pr ?? 126,
			headRefOid: headSha,
			url: `https://github.com/SollanSystems/buildplane/pull/${overrides.pr ?? 126}`,
		},
		review: {
			expectedBase: overrides.expectedBase ?? "main",
			expectedHead: headSha,
			reviewAssertion: {
				asserted: true,
				currentPrHeadSha: headSha,
				reason: "review PASS",
				reviewedCommitSha: headSha,
				source: "--review-pass",
				structured: true,
				verdict: "PASS",
			},
		},
		...extra,
	};
	const path = join(dir, "canonical-eligibility-receipt.json");
	writeFileSync(path, JSON.stringify(receipt, null, 2));
	return path;
}

afterEach(() => {
	for (const dir of tempDirs) {
		try {
			rmSync(dir, { force: true, recursive: true });
		} catch {
			/* ok */
		}
	}
	tempDirs.length = 0;
});

describe("pr auto-merge execute", () => {
	it("parses required arguments", async () => {
		const { parseArgs } = await execModule;
		const args = parseArgs(["--pr", "126", "--receipt", "/tmp/receipt.json"]);
		expect(args.pr).toBe("126");
		expect(args.receipt).toBe("/tmp/receipt.json");
		expect(args.dryRun).toBe(false);
		expect(args.directMerge).toBe(false);
	});

	it("builds live eligibility args with expected base", async () => {
		const { buildLiveEligibilityArgs } = await execModule;
		expect(
			buildLiveEligibilityArgs(
				126,
				"abc123def4567890abc123def4567890abc123de",
				"main",
			),
		).toEqual([
			"scripts/ci/pr-auto-merge-eligibility.mjs",
			"--pr",
			"126",
			"--expected-head",
			"abc123def4567890abc123def4567890abc123de",
			"--expected-base",
			"main",
			"--review-pass",
			"--json",
		]);
	});

	it("pins native auto-merge to the reviewed head SHA", async () => {
		const { buildEnableAutoMergeArgs } = await execModule;
		const args = buildEnableAutoMergeArgs(
			"PR_kwDORp5t8M7esxmN",
			"abc123def4567890abc123def4567890abc123de",
		);
		expect(args).toContain(
			"expectedHeadOid=abc123def4567890abc123def4567890abc123de",
		);
		expect(args.join(" ")).toContain("expectedHeadOid: $expectedHeadOid");
	});

	it("fails closed when native auto-merge PR ID lookup is unavailable", async () => {
		const { missingNativeAutoMergePrIdBlocker } = await execModule;
		const blocker = missingNativeAutoMergePrIdBlocker(128);
		expect(blocker.status).toBe("BLOCKED_PR_ID_LOOKUP");
		expect(blocker.reason).toContain("native auto-merge");
		expect(blocker.reason).toContain("--direct-merge explicitly");
	});

	it("parses --dry-run flag", async () => {
		const { parseArgs } = await execModule;
		const args = parseArgs([
			"--pr",
			"126",
			"--receipt",
			"/tmp/receipt.json",
			"--dry-run",
		]);
		expect(args.dryRun).toBe(true);
	});

	it("parses --direct-merge flag", async () => {
		const { parseArgs } = await execModule;
		const args = parseArgs([
			"--pr",
			"126",
			"--receipt",
			"/tmp/receipt.json",
			"--direct-merge",
		]);
		expect(args.directMerge).toBe(true);
	});

	it("parses --json flag", async () => {
		const { parseArgs } = await execModule;
		const args = parseArgs([
			"--pr",
			"126",
			"--receipt",
			"/tmp/receipt.json",
			"--json",
		]);
		expect(args.jsonOnly).toBe(true);
	});

	it("parses --expected-base", async () => {
		const { parseArgs } = await execModule;
		const args = parseArgs([
			"--pr",
			"126",
			"--receipt",
			"/tmp/receipt.json",
			"--expected-base",
			"develop",
		]);
		expect(args.expectedBase).toBe("develop");
	});

	it("rejects missing --pr", async () => {
		const { parseArgs } = await execModule;
		expect(() => parseArgs(["--receipt", "/tmp/r.json"])).toThrow(
			"--pr <number> is required",
		);
	});

	it("rejects missing --receipt", async () => {
		const { parseArgs } = await execModule;
		expect(() => parseArgs(["--pr", "126"])).toThrow(
			"--receipt <path> is required",
		);
	});

	it("rejects unknown arguments", async () => {
		const { parseArgs } = await execModule;
		expect(() =>
			parseArgs(["--pr", "126", "--receipt", "/tmp/r.json", "--bogus"]),
		).toThrow("Unknown argument");
	});
});

describe("readReceipt", () => {
	it("reads valid AUTO_MERGE_READY receipt", async () => {
		const { readReceipt } = await execModule;
		const dir = makeTempDir();
		const path = makeReceipt(dir, { pr: 125 });
		const result = readReceipt(path);
		expect(result.valid).toBe(true);
		expect(result.pr).toBe(125);
		expect(result.headSha).toBe("abc123def4567890abc123def4567890abc123de");
	});

	it("reads canonical nested eligibility receipt", async () => {
		const { readReceipt } = await execModule;
		const dir = makeTempDir();
		const path = makeCanonicalEligibilityReceipt(dir, { pr: 127 });
		const result = readReceipt(path);
		expect(result.valid).toBe(true);
		expect(result.pr).toBe(127);
		expect(result.headSha).toBe("abc123def4567890abc123def4567890abc123de");
	});

	it("blocks missing receipt path", async () => {
		const { readReceipt } = await execModule;
		const result = readReceipt("/nonexistent/path.json");
		expect(result.valid).toBe(false);
		expect(result.status).toBe("BLOCKED_NO_RECEIPT");
	});

	it("blocks receipt with non-READY verdict", async () => {
		const { readReceipt } = await execModule;
		const dir = makeTempDir();
		const path = makeReceipt(dir, { verdict: "BLOCKED_CHECKS" });
		const result = readReceipt(path);
		expect(result.valid).toBe(false);
		expect(result.status).toBe("BLOCKED_RECEIPT_NOT_READY");
	});

	it("blocks receipt missing pr field", async () => {
		const { readReceipt } = await execModule;
		const dir = makeTempDir();
		// Write receipt with pr: null to simulate missing field
		const path = join(dir, "receipt.json");
		writeFileSync(
			path,
			JSON.stringify({
				timestamp: new Date().toISOString(),
				pr: null,
				headSha: "abc123def4567890abc123def4567890abc123de",
				verdict: "AUTO_MERGE_READY",
			}),
		);
		const result = readReceipt(path);
		expect(result.valid).toBe(false);
	});

	it("blocks receipt missing headSha", async () => {
		const { readReceipt } = await execModule;
		const dir = makeTempDir();
		const path = join(dir, "receipt.json");
		writeFileSync(
			path,
			JSON.stringify({
				timestamp: new Date().toISOString(),
				pr: 126,
				verdict: "AUTO_MERGE_READY",
			}),
		);
		const result = readReceipt(path);
		expect(result.valid).toBe(false);
	});

	it("blocks stale receipt", async () => {
		const { readReceipt } = await execModule;
		const dir = makeTempDir();
		const path = makeReceipt(dir, {
			extra: { timestamp: new Date(Date.now() - 20 * 60000).toISOString() },
			timestamp: undefined,
		});
		const result = readReceipt(path);
		expect(result.valid).toBe(false);
		expect(result.status).toBe("BLOCKED_STALE_RECEIPT");
	});

	it("blocks malformed receipt timestamp", async () => {
		const { readReceipt } = await execModule;
		const dir = makeTempDir();
		const path = makeReceipt(dir, {
			extra: { timestamp: "not-a-date" },
			timestamp: undefined,
		});
		const result = readReceipt(path);
		expect(result.valid).toBe(false);
		expect(result.status).toBe("BLOCKED_STALE_RECEIPT");
		expect(result.reason).toContain("invalid timestamp");
	});

	it("blocks future receipt timestamp", async () => {
		const { readReceipt } = await execModule;
		const dir = makeTempDir();
		const path = makeReceipt(dir, {
			extra: { timestamp: new Date(Date.now() + 20 * 60000).toISOString() },
			timestamp: undefined,
		});
		const result = readReceipt(path);
		expect(result.valid).toBe(false);
		expect(result.status).toBe("BLOCKED_STALE_RECEIPT");
		expect(result.reason).toContain("future");
	});

	it("blocks non-JSON receipt", async () => {
		const { readReceipt } = await execModule;
		const dir = makeTempDir();
		const path = join(dir, "bad.txt");
		writeFileSync(path, "not json at all");
		const result = readReceipt(path);
		expect(result.valid).toBe(false);
		expect(result.status).toBe("BLOCKED_RECEIPT_UNREADABLE");
	});
});

describe("post-merge verification", () => {
	it("requires merged PR, default-branch containment, zero deployments, and completed successful checks", async () => {
		const { isPostMergeVerified } = await execModule;
		expect(
			isPostMergeVerified({
				checkRuns: [
					{ conclusion: "SUCCESS", name: "verify", status: "COMPLETED" },
				],
				deploymentCount: 0,
				merged: true,
				onDefaultBranch: true,
			}),
		).toBe(true);
		expect(
			isPostMergeVerified({
				checkRuns: [
					{ conclusion: "SUCCESS", name: "verify", status: "COMPLETED" },
				],
				deploymentCount: 0,
				merged: true,
				onDefaultBranch: false,
			}),
		).toBe(false);
		expect(
			isPostMergeVerified({
				checkRuns: [
					{ conclusion: "SUCCESS", name: "verify", status: "COMPLETED" },
				],
				deploymentCount: 1,
				merged: true,
				onDefaultBranch: true,
			}),
		).toBe(false);
		expect(
			isPostMergeVerified({
				checkRuns: [
					{ conclusion: "FAILURE", name: "verify", status: "COMPLETED" },
				],
				deploymentCount: 0,
				merged: true,
				onDefaultBranch: true,
			}),
		).toBe(false);
		expect(
			isPostMergeVerified({
				checkRuns: [
					{ conclusion: null, name: "verify", status: "IN_PROGRESS" },
				],
				deploymentCount: 0,
				merged: true,
				onDefaultBranch: true,
			}),
		).toBe(false);
		expect(
			isPostMergeVerified({
				checkRuns: [],
				deploymentCount: 0,
				merged: true,
				onDefaultBranch: true,
			}),
		).toBe(false);
	});
});

describe("prShortSha", () => {
	it("returns short sha for long sha", async () => {
		const { prShortSha } = await execModule;
		expect(prShortSha("abc123def456789")).toBe("abc123d");
	});

	it("returns same value for short sha", async () => {
		const { prShortSha } = await execModule;
		expect(prShortSha("abc")).toBe("abc");
	});
});
