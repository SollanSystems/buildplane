import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const hostResolver = vi.hoisted(() => ({
	resolve: vi.fn(),
}));

vi.mock("../src/governed-authority-broker-host.js", async () => {
	const actual = await vi.importActual<
		typeof import("../src/governed-authority-broker-host.js")
	>("../src/governed-authority-broker-host.js");
	return {
		...actual,
		resolveHostOwnedGovernedBroker: hostResolver.resolve,
	};
});

const { runCli } = await import("../src/run-cli.js");

async function runCliCapture(root: string, argv: readonly string[]) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const exitCode = await runCli([...argv], {
		cwd: root,
		stdout: (line) => stdout.push(line),
		stderr: (line) => stderr.push(line),
	});
	return { exitCode, stdout, stderr };
}

function digest(character: string): string {
	return `sha256:${character.repeat(64)}`;
}

function git(root: string, args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd: root,
		encoding: "utf8",
		env: Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
		),
	});
}

function createGitProject(): string {
	const root = mkdtempSync(join(tmpdir(), "buildplane-planforge-broker-"));
	git(root, ["init"]);
	git(root, ["config", "user.name", "Buildplane Tests"]);
	git(root, ["config", "user.email", "tests@example.com"]);
	writeFileSync(join(root, "tracked.txt"), "baseline\n");
	git(root, ["add", "tracked.txt"]);
	git(root, ["commit", "-m", "baseline"]);
	return root;
}

function snapshotRoot(root: string): {
	readonly targetRef: string;
	readonly head: string;
	readonly tree: string;
	readonly count: string;
	readonly status: string;
} {
	return {
		targetRef: git(root, ["symbolic-ref", "--quiet", "HEAD"]).trim(),
		head: git(root, ["rev-parse", "HEAD"]).trim(),
		tree: git(root, ["rev-parse", "HEAD^{tree}"]).trim(),
		count: git(root, ["rev-list", "--count", "HEAD"]).trim(),
		status: git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
	};
}

afterEach(() => {
	hostResolver.resolve.mockReset();
});

describe("PlanForge governed broker views", () => {
	it("fails closed before passing project-root scope to a legacy PlanForge admission", async () => {
		const root = createGitProject();
		const inputPath = join(root, "untrusted-plan.md");
		writeFileSync(
			inputPath,
			Buffer.concat([
				Buffer.from("# not locally parsed\r\n"),
				Buffer.from([0x00, 0x80, 0xff]),
				Buffer.from("broker owns this\n"),
			]),
		);
		const expectedSource = readFileSync(inputPath);
		const before = snapshotRoot(root);
		const admitPlanForge = vi.fn(async () => {
			throw new Error("legacy admission must not receive the target root");
		});
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
			admitPlanForge,
		});

		const result = await runCliCapture(root, [
			"planforge",
			"admit",
			"--input",
			inputPath,
			"--approve",
			"--json",
		]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toEqual([]);
		expect(JSON.parse(result.stdout.join("\\n"))).toMatchObject({
			error: {
				message: expect.stringContaining("native trusted host contract"),
			},
		});
		expect(admitPlanForge).not.toHaveBeenCalled();
		expect(snapshotRoot(root)).toEqual(before);
		expect(readFileSync(inputPath)).toEqual(expectedSource);
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
	});

	it("does not invoke a legacy admission callback that would return an unbound source", async () => {
		const root = createGitProject();
		const inputPath = join(root, "untrusted-plan.md");
		writeFileSync(inputPath, "exact original source\n");
		const before = snapshotRoot(root);
		const admitPlanForge = vi.fn(async () => ({
			kind: "host-owned-planforge-admission-v1",
			admissionRef: "host-admission/mismatched-source",
			taskRefs: ["host-task/mismatched-source"],
			planSourceDigest: digest("a"),
			admissionDigest: digest("b"),
		}));
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
			admitPlanForge,
		});

		const result = await runCliCapture(root, [
			"planforge",
			"admit",
			"--input",
			inputPath,
			"--approve",
			"--json",
		]);

		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			error: {
				message: expect.stringContaining("native trusted host contract"),
			},
		});
		expect(admitPlanForge).not.toHaveBeenCalled();
		expect(snapshotRoot(root)).toEqual(before);
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
	});

	it("does not invoke a legacy admission callback that could alter the untracked input", async () => {
		const root = createGitProject();
		const inputPath = join(root, "untracked-plan.md");
		writeFileSync(inputPath, "original untrusted source\n");
		const before = snapshotRoot(root);
		const admitPlanForge = vi.fn(async () => {
			writeFileSync(inputPath, "host-mutated untrusted source\n");
			return {
				kind: "host-owned-planforge-admission-v1",
				admissionRef: "host-admission/changed-source",
				taskRefs: ["host-task/changed-source"],
				planSourceDigest: digest("a"),
				admissionDigest: digest("b"),
			};
		});
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
			admitPlanForge,
		});

		const result = await runCliCapture(root, [
			"planforge",
			"admit",
			"--input",
			inputPath,
			"--approve",
			"--json",
		]);

		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			error: {
				message: expect.stringContaining("native trusted host contract"),
			},
		});
		expect(admitPlanForge).not.toHaveBeenCalled();
		expect(snapshotRoot(root)).toEqual(before);
		expect(readFileSync(inputPath, "utf8")).toBe("original untrusted source\n");
	});

	it("does not invoke a legacy admission callback that could change the target", async () => {
		const root = createGitProject();
		const inputPath = join(root, "untrusted-plan.md");
		writeFileSync(inputPath, "untrusted source\n");
		const before = snapshotRoot(root);
		const admitPlanForge = vi.fn(async () => {
			writeFileSync(join(root, "tracked.txt"), "mutated\n");
			git(root, ["add", "tracked.txt"]);
			git(root, ["commit", "-m", "invalid host admission target mutation"]);
			throw new Error("host admission failed after an invalid target mutation");
		});
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
			admitPlanForge,
		});

		const result = await runCliCapture(root, [
			"planforge",
			"admit",
			"--input",
			inputPath,
			"--approve",
			"--json",
		]);

		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			error: {
				message: expect.stringContaining("native trusted host contract"),
			},
		});
		expect(admitPlanForge).not.toHaveBeenCalled();
		expect(snapshotRoot(root)).toEqual(before);
	});

	it("fails closed without a host broker before reading source or creating project state", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-planforge-broker-"));
		const inputPath = join(root, "missing-plan.md");
		hostResolver.resolve.mockResolvedValue(undefined);

		const result = await runCliCapture(root, [
			"planforge",
			"admit",
			"--input",
			inputPath,
			"--approve",
			"--json",
		]);

		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout.join("\\n"))).toMatchObject({
			error: {
				message: expect.stringContaining("governed broker is unavailable"),
			},
		});
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
	});

	it("fails closed before passing the target checkout to a legacy PlanForge candidate session", async () => {
		const root = createGitProject();
		const before = snapshotRoot(root);
		const openPlanForgeCandidateSession = vi.fn(async () => {
			throw new Error(
				"legacy candidate session must not receive the target root",
			);
		});
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
			openPlanForgeCandidateSession,
		});

		const result = await runCliCapture(root, [
			"planforge",
			"dispatch",
			"--admission-ref",
			"host-admission/plan-123",
			"--task-ref",
			"host-task/one",
			"--json",
		]);

		expect(result.exitCode).toBe(2);
		expect(openPlanForgeCandidateSession).not.toHaveBeenCalled();
		expect(JSON.parse(result.stdout.join("\n"))).toEqual({
			governance: "governed",
			status: "recovery-required",
			executionStarted: "unknown",
			promotion: { state: "not-authorized" },
			recovery: {
				action: "contact-host",
				retry: "blocked",
			},
		});
		expect(snapshotRoot(root)).toEqual(before);
	});

	it("does not invoke a legacy PlanForge candidate callback even when it would return a mismatched receipt", async () => {
		const root = createGitProject();
		const before = snapshotRoot(root);
		const openPlanForgeCandidateSession = vi.fn(async () => {
			throw new Error("legacy candidate session must not be opened");
		});
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
			openPlanForgeCandidateSession,
		});

		const result = await runCliCapture(root, [
			"planforge",
			"dispatch",
			"--admission-ref",
			"host-admission/plan-123",
			"--task-ref",
			"host-task/one",
			"--json",
		]);

		expect(result.exitCode).toBe(2);
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			governance: "governed",
			status: "recovery-required",
		});
		expect(openPlanForgeCandidateSession).not.toHaveBeenCalled();
		expect(snapshotRoot(root)).toEqual(before);
	});

	it("does not open legacy PlanForge admission or candidate callbacks against the target root", async () => {
		const root = createGitProject();
		const inputPath = join(root, "untrusted-plan.md");
		writeFileSync(inputPath, "untrusted source\n");
		const before = snapshotRoot(root);
		const admitPlanForge = vi.fn(async () => {
			writeFileSync(join(root, "tracked.txt"), "admission mutation\n");
			git(root, ["add", "tracked.txt"]);
			git(root, ["commit", "-m", "invalid admission mutation"]);
			return {
				kind: "host-owned-planforge-admission-v1",
				admissionRef: "host-admission/plan-123",
				taskRefs: ["host-task/one"],
				planSourceDigest: digest("a"),
				admissionDigest: digest("b"),
			};
		});
		const openPlanForgeCandidateSession = vi.fn(async () => {
			writeFileSync(join(root, "tracked.txt"), "candidate mutation\n");
			git(root, ["add", "tracked.txt"]);
			git(root, ["commit", "-m", "invalid candidate mutation"]);
			return {
				kind: "host-owned-planforge-candidate-session-v1",
				schemaVersion: 1,
				recoveryRef: "host-recovery/planforge-target-mutation",
				run: async () => {
					throw new Error("unreachable legacy candidate run");
				},
			};
		});
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
			admitPlanForge,
			openPlanForgeCandidateSession,
		});

		const admission = await runCliCapture(root, [
			"planforge",
			"admit",
			"--input",
			inputPath,
			"--approve",
			"--json",
		]);
		const candidate = await runCliCapture(root, [
			"planforge",
			"dispatch",
			"--admission-ref",
			"host-admission/plan-123",
			"--task-ref",
			"host-task/one",
			"--json",
		]);

		expect(admission.exitCode).toBe(1);
		expect(JSON.parse(admission.stdout.join("\n"))).toMatchObject({
			error: {
				message: expect.stringContaining("native trusted host contract"),
			},
		});
		expect(candidate.exitCode).toBe(2);
		expect(JSON.parse(candidate.stdout.join("\n"))).toMatchObject({
			governance: "governed",
			status: "recovery-required",
		});
		expect(admitPlanForge).not.toHaveBeenCalled();
		expect(openPlanForgeCandidateSession).not.toHaveBeenCalled();
		expect(snapshotRoot(root)).toEqual(before);
	});

	it("rejects an extensible PlanForge candidate-session wrapper before it can run", async () => {
		const root = createGitProject();
		const before = snapshotRoot(root);
		const run = vi.fn();
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
			openPlanForgeCandidateSession: async () => ({
				kind: "host-owned-planforge-candidate-session-v1",
				schemaVersion: 1,
				recoveryRef: "host-recovery/planforge-extra",
				run,
				extra: "must-not-cross-host-boundary",
			}),
		});

		const result = await runCliCapture(root, [
			"planforge",
			"dispatch",
			"--admission-ref",
			"host-admission/plan-123",
			"--task-ref",
			"host-task/one",
			"--json",
		]);

		expect(result.exitCode).toBe(2);
		expect(run).not.toHaveBeenCalled();
		expect(snapshotRoot(root)).toEqual(before);
	});

	it("fails closed before host resolution for invalid or unavailable PlanForge dispatch authority", async () => {
		const root = createGitProject();
		hostResolver.resolve.mockResolvedValue(undefined);

		const unavailable = await runCliCapture(root, [
			"planforge",
			"dispatch",
			"--admission-ref",
			"host-admission/plan-123",
			"--task-ref",
			"host-task/one",
			"--json",
		]);
		expect(unavailable.exitCode).toBe(1);
		expect(JSON.parse(unavailable.stdout.join("\n"))).toMatchObject({
			error: {
				message: expect.stringContaining("governed broker is unavailable"),
			},
		});

		hostResolver.resolve.mockClear();
		const invalid = await runCliCapture(root, [
			"planforge",
			"dispatch",
			"--admission-ref",
			"../not-a-host-ref",
			"--task-ref",
			"host-task/one",
			"--json",
		]);
		expect(invalid.exitCode).toBe(1);
		expect(hostResolver.resolve).not.toHaveBeenCalled();
	});
});
