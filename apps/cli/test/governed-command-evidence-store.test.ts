import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createGovernedCommandEvidenceStore,
	GovernedCommandEvidenceConflictError,
} from "../src/governed-command-evidence-store.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "buildplane-governed-evidence-"));
	temporaryRoots.push(root);
	return root;
}

function storeAt(root: string) {
	return createGovernedCommandEvidenceStore({
		projectRoot: temporaryRoot(),
		root,
	});
}

function canonicalInput(overrides: Record<string, unknown> = {}) {
	return {
		runId: "run-evidence-store",
		actionId: "governed:run-evidence-store:command",
		command: "node",
		args: ["--version", "--token", "input-secret-should-not-persist"],
		cwd: "workspace/private-directory",
		...overrides,
	};
}

function actionResult(overrides: Record<string, unknown> = {}) {
	return {
		runId: "run-evidence-store",
		actionId: "governed:run-evidence-store:command",
		actionRequestRef: "00000000-0000-7000-8000-000000000001",
		actionRequestDigest: DIGEST_A,
		gatewayResult: {
			outcome: "succeeded" as const,
			inputDigest: DIGEST_B,
			resultDigest: DIGEST_C,
			exitCode: 0,
		},
		outputChecks: [
			{ path: "dist/private-output.txt", exists: true },
			{ path: "dist/another-output.txt", exists: false },
		],
		...overrides,
	};
}

function contentAddressedRecords(root: string): readonly string[] {
	const blobs = join(root, "blobs");
	if (!readdirSync(root).includes("blobs")) return [];
	const result: string[] = [];
	function walk(current: string): void {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile()) result.push(path);
		}
	}
	walk(blobs);
	return result.sort();
}

function everyStoredRecord(root: string): string {
	const result: string[] = [];
	function walk(current: string): void {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile()) result.push(readFileSync(path, "utf8"));
		}
	}
	walk(root);
	return result.join("\n");
}

describe("governed command evidence store", () => {
	it("writes deterministic content-addressed input, result, and evidence records exactly once", async () => {
		const root = temporaryRoot();
		const projectRoot = temporaryRoot();
		const firstStore = createGovernedCommandEvidenceStore({
			projectRoot,
			root,
		});
		const secondStore = createGovernedCommandEvidenceStore({
			projectRoot,
			root,
		});

		const firstInput = await firstStore.persistCanonicalInput(canonicalInput());
		const repeatedInput = await secondStore.persistCanonicalInput(
			canonicalInput(),
		);
		expect(repeatedInput).toEqual(firstInput);
		expect(firstInput.canonicalInputDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(firstInput.canonicalInputRef).toBe(
			`cas://governed-command-evidence/sha256/${firstInput.canonicalInputDigest.slice("sha256:".length)}`,
		);
		expect(contentAddressedRecords(root)).toHaveLength(1);

		const firstResult = await firstStore.persistActionResult(actionResult());
		const repeatedResult = await secondStore.persistActionResult(
			actionResult({
				outputChecks: [
					{ path: "dist/another-output.txt", exists: false },
					{ path: "dist/private-output.txt", exists: true },
				],
			}),
		);
		expect(repeatedResult).toEqual(firstResult);
		expect(firstResult.resultDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(firstResult.resultRef).toBe(
			`cas://governed-command-evidence/sha256/${firstResult.resultDigest?.slice("sha256:".length)}`,
		);
		expect(firstResult.evidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(contentAddressedRecords(root)).toHaveLength(3);
	});

	it("fails closed on a conflicting input or action-result identity", async () => {
		const root = temporaryRoot();
		const store = storeAt(root);
		await store.persistCanonicalInput(canonicalInput());
		await expect(
			store.persistCanonicalInput(
				canonicalInput({ command: "different-command" }),
			),
		).rejects.toBeInstanceOf(GovernedCommandEvidenceConflictError);

		await store.persistActionResult(actionResult());
		await expect(
			store.persistActionResult(
				actionResult({
					gatewayResult: {
						outcome: "succeeded",
						inputDigest: DIGEST_B,
						resultDigest: `sha256:${"d".repeat(64)}`,
						exitCode: 0,
					},
				}),
			),
		).rejects.toBeInstanceOf(GovernedCommandEvidenceConflictError);
	});

	it("does not retain command secrets, output paths, stdout, or stderr and withholds results for non-success", async () => {
		const root = temporaryRoot();
		const store = storeAt(root);
		await store.persistCanonicalInput(
			canonicalInput({
				command: "command-with-input-secret",
				args: ["TOP_SECRET_ARGUMENT"],
				cwd: "TOP_SECRET_CWD",
			}),
		);
		const denied = await store.persistActionResult(
			actionResult({
				gatewayResult: {
					outcome: "denied",
					inputDigest: DIGEST_B,
					resultDigest: DIGEST_C,
					stdout: "TOP_SECRET_STDOUT",
					stderr: "TOP_SECRET_STDERR",
				},
				outputChecks: [{ path: "TOP_SECRET_OUTPUT_PATH", exists: false }],
			}),
		);
		expect(denied.resultDigest).toBeUndefined();
		expect(denied.resultRef).toBeUndefined();
		expect(denied.redactions).toEqual([
			expect.objectContaining({ field: "outputChecks[0].path" }),
		]);
		const stored = everyStoredRecord(root);
		for (const secret of [
			"command-with-input-secret",
			"TOP_SECRET_ARGUMENT",
			"TOP_SECRET_CWD",
			"TOP_SECRET_OUTPUT_PATH",
			"TOP_SECRET_STDOUT",
			"TOP_SECRET_STDERR",
		]) {
			expect(stored).not.toContain(secret);
		}
	});

	it("rejects traversal roots, symbolic-link roots, and a result without an input identity", async () => {
		const root = temporaryRoot();
		const traversal = `${root}${sep}nested${sep}..${sep}escaped`;
		expect(() =>
			createGovernedCommandEvidenceStore({
				projectRoot: temporaryRoot(),
				root: traversal,
			}),
		).toThrow(/traversal/i);

		const outside = join(root, "outside");
		const linkedRoot = join(root, "linked-root");
		mkdirSync(outside);
		symlinkSync(
			outside,
			linkedRoot,
			process.platform === "win32" ? "junction" : "dir",
		);
		expect(() =>
			createGovernedCommandEvidenceStore({
				projectRoot: temporaryRoot(),
				root: linkedRoot,
			}),
		).toThrow(/symbolic-link/i);

		const emptyStore = storeAt(join(root, "empty-store"));
		await expect(
			emptyStore.persistActionResult(actionResult()),
		).rejects.toThrow(/no durable canonical input/i);
	});

	it("keeps production evidence outside every project and candidate mount", async () => {
		const hostParent = temporaryRoot();
		const projectRoot = join(hostParent, "project");
		const candidateRoot = join(projectRoot, ".worktrees", "candidate");
		mkdirSync(candidateRoot, { recursive: true });

		const store = createGovernedCommandEvidenceStore({ projectRoot });
		await store.persistCanonicalInput(canonicalInput());

		const hostEvidenceParent = join(hostParent, ".buildplane-host-evidence");
		expect(existsSync(hostEvidenceParent)).toBe(true);
		expect(existsSync(join(projectRoot, ".buildplane"))).toBe(false);
		expect(relative(projectRoot, hostEvidenceParent)).toMatch(/^\.\./);
		expect(relative(candidateRoot, hostEvidenceParent)).toMatch(/^\.\./);

		expect(() =>
			createGovernedCommandEvidenceStore({
				projectRoot,
				root: join(projectRoot, ".buildplane", "governed-command-evidence"),
			}),
		).toThrow(/outside projectRoot/i);
	});
});
