import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const optInModule = import("../../scripts/ci/pr-auto-merge-opt-in.mjs");
const tempDirs: string[] = [];

function _makeTempDir() {
	const dir = mkdtempSync(join(tmpdir(), "bp-auto-merge-opt-in-"));
	tempDirs.push(dir);
	return dir;
}

function _makeReceipt(
	dir: string,
	opts: {
		prNumber?: number;
		headSha?: string;
		verdict?: string;
	},
) {
	const receipt = {
		timestamp: new Date().toISOString(),
		pr: opts.prNumber ?? 126,
		url: `https://github.com/SollanSystems/buildplane/pull/${opts.prNumber ?? 126}`,
		headSha: opts.headSha ?? "abc123def456",
		verdict: opts.verdict ?? "PASS",
	};
	const path = join(dir, "receipt.json");
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

describe("pr auto-merge opt-in helper", () => {
	it("parses required arguments", async () => {
		const { parseArgs } = await optInModule;
		const args = parseArgs(["--pr", "126", "--expected-head", "abc123def456"]);
		expect(args.pr).toBe("126");
		expect(args.expectedHead).toBe("abc123def456");
		expect(args.dryRun).toBe(false);
		expect(args.markReady).toBe(false);
		expect(args.jsonOnly).toBe(false);
	});

	it("parses --dry-run flag", async () => {
		const { parseArgs } = await optInModule;
		const args = parseArgs([
			"--pr",
			"126",
			"--expected-head",
			"abc123",
			"--dry-run",
		]);
		expect(args.dryRun).toBe(true);
	});

	it("parses --mark-ready flag", async () => {
		const { parseArgs } = await optInModule;
		const args = parseArgs([
			"--pr",
			"126",
			"--expected-head",
			"abc123",
			"--mark-ready",
		]);
		expect(args.markReady).toBe(true);
	});

	it("rejects missing --pr", async () => {
		const { parseArgs } = await optInModule;
		expect(() => parseArgs(["--expected-head", "abc123"])).toThrow(
			"--pr <number> is required",
		);
	});

	it("rejects missing --expected-head", async () => {
		const { parseArgs } = await optInModule;
		expect(() => parseArgs(["--pr", "126"])).toThrow(
			"--expected-head <sha> is required",
		);
	});

	it("rejects non-numeric --pr", async () => {
		const { parseArgs } = await optInModule;
		expect(() => parseArgs(["--pr", "abc", "--expected-head", "sha"])).toThrow(
			"--pr <number> is required",
		);
	});

	it("rejects unknown arguments", async () => {
		const { parseArgs } = await optInModule;
		expect(() =>
			parseArgs(["--pr", "126", "--expected-head", "abc", "--bogus"]),
		).toThrow("Unknown argument");
	});

	it("parses --json flag", async () => {
		const { parseArgs } = await optInModule;
		const args = parseArgs([
			"--pr",
			"126",
			"--expected-head",
			"abc123",
			"--json",
		]);
		expect(args.jsonOnly).toBe(true);
	});

	it("parses --allow-deployments flag", async () => {
		const { parseArgs } = await optInModule;
		const args = parseArgs([
			"--pr",
			"126",
			"--expected-head",
			"abc123",
			"--allow-deployments",
		]);
		expect(args.allowDeployments).toBe(true);
	});

	it("--help prints usage and exits", async () => {
		const { usage } = await optInModule;
		let exitCode = -1;
		const origExit = process.exit;
		process.exit = (code?: number) => {
			exitCode = code ?? -1;
			throw new Error("exit");
		};
		try {
			usage(0);
		} catch {}
		process.exit = origExit;
		expect(exitCode).toBe(0);
	});
});

describe("prShortSha", () => {
	it("returns short sha for long sha", async () => {
		const { prShortSha } = await optInModule;
		expect(prShortSha("abc123def456789")).toBe("abc123d");
	});

	it("returns same value for short sha", async () => {
		const { prShortSha } = await optInModule;
		expect(prShortSha("abc")).toBe("abc");
	});

	it("returns undefined for falsy input", async () => {
		const { prShortSha } = await optInModule;
		expect(prShortSha(undefined)).toBeUndefined();
		expect(prShortSha("")).toBe("");
	});
});

describe("labelNames", () => {
	it("handles flat array", async () => {
		const { labelNames } = await optInModule;
		expect(labelNames(["foo", "bar"])).toEqual(["foo", "bar"]);
	});

	it("handles nodes array", async () => {
		const { labelNames } = await optInModule;
		expect(labelNames({ nodes: [{ name: "foo" }, { name: "bar" }] })).toEqual([
			"foo",
			"bar",
		]);
	});

	it("handles empty labels", async () => {
		const { labelNames } = await optInModule;
		expect(labelNames([])).toEqual([]);
		expect(labelNames(undefined)).toEqual([]);
		expect(labelNames(null as any)).toEqual([]);
	});
});

describe("summarizeReviewThreads", () => {
	it("summarizes resolved and unresolved threads", async () => {
		const { summarizeReviewThreads } = await optInModule;
		const threads = {
			nodes: [
				{
					isResolved: true,
					comments: { nodes: [{ author: { login: "alice" } }] },
				},
				{ isResolved: false, path: "src/foo.ts", line: 42, isOutdated: false },
				{
					isResolved: false,
					path: "src/bar.ts",
					line: 7,
					isOutdated: true,
					comments: [{ author: { login: "bob" } }],
				},
			],
		};
		const result = summarizeReviewThreads(threads);
		expect(result.total).toBe(3);
		expect(result.unresolvedCount).toBe(2);
		expect(result.unresolved[0].path).toBe("src/foo.ts");
	});

	it("handles empty threads", async () => {
		const { summarizeReviewThreads } = await optInModule;
		const result = summarizeReviewThreads(undefined);
		expect(result.total).toBe(0);
		expect(result.unresolvedCount).toBe(0);
	});

	it("builds a dedicated GraphQL review-thread query", async () => {
		const { buildReviewThreadsGraphqlArgs } = await optInModule;
		const args = buildReviewThreadsGraphqlArgs(128);
		expect(args).toContain("owner=SollanSystems");
		expect(args).toContain("repo=buildplane");
		expect(args).toContain("number=128");
		expect(args.join(" ")).toContain("reviewThreads(first:100)");
	});
});

describe("hasCheckPending", () => {
	it("detects pending statuses", async () => {
		const { hasCheckPending } = await optInModule;
		expect(hasCheckPending([{ status: "IN_PROGRESS" }])).toBe(true);
		expect(hasCheckPending([{ status: "PENDING" }])).toBe(true);
		expect(hasCheckPending([{ status: "QUEUED" }])).toBe(true);
	});

	it("detects null conclusion as pending", async () => {
		const { hasCheckPending } = await optInModule;
		expect(hasCheckPending([{ status: "COMPLETED", conclusion: null }])).toBe(
			true,
		);
	});

	it("passes completed checks", async () => {
		const { hasCheckPending } = await optInModule;
		expect(
			hasCheckPending([{ status: "COMPLETED", conclusion: "SUCCESS" }]),
		).toBe(false);
	});

	it("handles empty items", async () => {
		const { hasCheckPending } = await optInModule;
		expect(hasCheckPending([])).toBe(false);
		expect(hasCheckPending(undefined as any)).toBe(false);
		expect(hasCheckPending(null as any)).toBe(false);
	});
});

describe("rollupItems", () => {
	it("flattens statusCheckRollup", async () => {
		const { rollupItems } = await optInModule;
		const items = rollupItems([
			{
				name: "verify",
				status: "COMPLETED",
				conclusion: "SUCCESS",
				__typename: "CheckRun",
			},
			{
				context: "lint",
				status: "COMPLETED",
				conclusion: "FAILURE",
				__typename: "StatusContext",
			},
		]);
		expect(items).toHaveLength(2);
		expect(items[0].name).toBe("verify");
		expect(items[0].conclusion).toBe("SUCCESS");
		expect(items[1].name).toBe("lint");
		expect(items[1].conclusion).toBe("FAILURE");
	});

	it("handles non-array input", async () => {
		const { rollupItems } = await optInModule;
		expect(rollupItems(undefined as any)).toEqual([]);
		expect(rollupItems(null as any)).toEqual([]);
	});
});

describe("runPreChecks", () => {
	it("blocks merged PR", async () => {
		const { runPreChecks, BLOCKED_ALREADY_MERGED } = await optInModule;
		const pr = mockPr({ state: "MERGED" });
		const blockers = runPreChecks(pr, pr.headRefOid);
		expect(blockers.some((b) => b.status === BLOCKED_ALREADY_MERGED)).toBe(
			true,
		);
	});

	it("blocks closed PR", async () => {
		const { runPreChecks, BLOCKED_ALREADY_MERGED } = await optInModule;
		const pr = mockPr({ state: "CLOSED" });
		const blockers = runPreChecks(pr, pr.headRefOid);
		expect(blockers.some((b) => b.status === BLOCKED_ALREADY_MERGED)).toBe(
			true,
		);
	});

	it("blocks missing expected head", async () => {
		const { runPreChecks, BLOCKED_SHA_MISSING } = await optInModule;
		const pr = mockPr();
		const blockers = runPreChecks(pr, undefined);
		expect(blockers.some((b) => b.status === BLOCKED_SHA_MISSING)).toBe(true);
	});

	it("blocks SHA mismatch", async () => {
		const { runPreChecks, BLOCKED_SHA_MISMATCH } = await optInModule;
		const pr = mockPr({ headRefOid: "abc123" });
		const blockers = runPreChecks(pr, "def456");
		expect(blockers.some((b) => b.status === BLOCKED_SHA_MISMATCH)).toBe(true);
	});

	it("blocks draft PR when markReady is false", async () => {
		const { runPreChecks, BLOCKED_DRAFT } = await optInModule;
		const pr = mockPr({ isDraft: true });
		const blockers = runPreChecks(pr, pr.headRefOid, false);
		expect(blockers.some((b) => b.status === BLOCKED_DRAFT)).toBe(true);
	});

	it("allows draft PR when markReady is true", async () => {
		const { runPreChecks } = await optInModule;
		const pr = mockPr({ isDraft: true });
		const blockers = runPreChecks(pr, pr.headRefOid, true);
		expect(blockers.some((b) => b.status === "BLOCKED_DRAFT")).toBe(false);
	});

	it("blocks when no checks observed", async () => {
		const { runPreChecks, BLOCKED_CHECKS_PENDING } = await optInModule;
		const pr = mockPr({ checksLength: 0 });
		const blockers = runPreChecks(pr, pr.headRefOid);
		expect(blockers.some((b) => b.status === BLOCKED_CHECKS_PENDING)).toBe(
			true,
		);
	});

	it("blocks unresolved review threads", async () => {
		const { runPreChecks, BLOCKED_REVIEW_THREADS } = await optInModule;
		const pr = mockPr({ unresolvedCount: 3 });
		const blockers = runPreChecks(pr, pr.headRefOid);
		expect(blockers.some((b) => b.status === BLOCKED_REVIEW_THREADS)).toBe(
			true,
		);
	});

	it("passes clean PR", async () => {
		const { runPreChecks } = await optInModule;
		const pr = mockPr({
			unresolvedCount: 0,
			isDraft: false,
			hasCheckPending: false,
			checksLength: 1,
		});
		const blockers = runPreChecks(pr, pr.headRefOid, false);
		expect(blockers).toHaveLength(0);
	});
});

describe("planMutations", () => {
	it("plans to add label when missing", async () => {
		const { planMutations } = await optInModule;
		const pr = mockPr({ labels: [] });
		const ops = planMutations(pr);
		expect(ops.some((o) => o.op === "add-label")).toBe(true);
	});
});

// ── helpers ──────────────────────────────────────────────────────────────────

function mockPr(
	overrides: {
		state?: string;
		isDraft?: boolean;
		headRefOid?: string;
		labels?: string[];
		unresolvedCount?: number;
		hasCheckPending?: boolean;
		checksLength?: number;
	} = {},
) {
	const hasCheckPending = overrides.hasCheckPending ?? false;
	const checksLength = overrides.checksLength;
	const defaultChecks =
		checksLength !== undefined
			? checksLength > 0
				? Array.from({ length: checksLength }, (_, i) => ({
						name: `check-${i}`,
						status: "COMPLETED",
						conclusion: "SUCCESS",
						type: "CheckRun",
					}))
				: []
			: [
					{
						name: "verify",
						status: "COMPLETED",
						conclusion: "SUCCESS",
						type: "CheckRun",
					},
				];
	return {
		number: 126,
		url: "https://github.com/SollanSystems/buildplane/pull/126",
		state: overrides.state ?? "OPEN",
		isDraft: overrides.isDraft ?? false,
		baseRefName: "main",
		headRefName: "feat/test",
		headRefOid:
			overrides.headRefOid ?? "abc123def4567890abc123def4567890abc123de",
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		reviewDecision: "APPROVED",
		autoMergeRequest: null,
		labels: overrides.labels ?? ["buildplane:auto-merge"],
		reviewThreads: {
			total: overrides.unresolvedCount ?? 0,
			unresolved: Array.from(
				{ length: overrides.unresolvedCount ?? 0 },
				(_, i) => ({
					commentAuthor: `user-${i}`,
					isOutdated: false,
					line: null,
					path: null,
				}),
			),
			unresolvedCount: overrides.unresolvedCount ?? 0,
		},
		hasLabel: (overrides.labels ?? ["buildplane:auto-merge"]).includes(
			"buildplane:auto-merge",
		),
		checks: hasCheckPending
			? [
					{
						name: "verify",
						status: "IN_PROGRESS",
						conclusion: null,
						type: "CheckRun",
					},
				]
			: defaultChecks,
	};
}
