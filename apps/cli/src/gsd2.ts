import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const GSD2_TASK_STATUSES = [
	"NEW",
	"READY",
	"RUNNING",
	"VERIFYING",
	"PASSED",
	"BLOCKED",
	"FAILED",
	"RETRYING",
	"ESCALATED",
] as const;

export const GSD2_ROUTE_MODES = [
	"planning_only",
	"direct",
	"worktree_kernel",
	"buildplane",
	"manual_recovery",
] as const;

export const GSD2_FINAL_STATUSES = ["PASSED", "BLOCKED", "FAILED"] as const;

type Gsd2RouteMode = (typeof GSD2_ROUTE_MODES)[number];

interface Gsd2Envelope {
	readonly id?: string;
	readonly status?: string;
	readonly goal?: string;
	readonly routing?: {
		readonly mode?: string;
		readonly frontDoor?: string;
		readonly backend?: string;
	};
	readonly verification?: {
		readonly commands: readonly string[];
	};
}

interface Gsd2Receipt {
	readonly taskId?: string;
	readonly finalStatus?: string;
	readonly backend?: string;
}

interface RunGsd2Options {
	readonly cwd?: string;
	readonly stdout?: (line: string) => void;
	readonly stderr?: (line: string) => void;
}

const TASK_ID_PATTERN = /^G2-\d{4}$/;
const DEFAULT_VERIFICATION_COMMANDS = ["git diff --check"] as const;
const DEFAULT_RECOVERY_ACTIONS = [
	"retry_with_tighter_context",
	"fresh_worktree",
	"buildplane_replay",
	"buildplane_fork",
	"manual_escalation",
] as const;

export function parseGsd2Envelope(content: string): Gsd2Envelope {
	return {
		id: readScalar(content, "id"),
		status: readScalar(content, "status"),
		goal: readScalar(content, "goal"),
		routing: {
			mode: readNestedScalar(content, "routing", "mode"),
			frontDoor: readNestedScalar(content, "routing", "front_door"),
			backend: readNestedScalar(content, "routing", "backend"),
		},
		verification: {
			commands: readNestedList(content, "verification", "commands"),
		},
	};
}

export function parseGsd2Receipt(content: string): Gsd2Receipt {
	return {
		taskId: readScalar(content, "task_id"),
		backend: readScalar(content, "backend"),
		finalStatus: readScalar(content, "final_status"),
	};
}

export function validateGsd2Envelope(envelope: Gsd2Envelope): string[] {
	const errors: string[] = [];
	if (!envelope.id || !TASK_ID_PATTERN.test(envelope.id)) {
		errors.push("envelope.id must match G2-0001 format");
	}
	if (!isOneOf(envelope.status, GSD2_TASK_STATUSES)) {
		errors.push(
			`envelope.status must be one of ${GSD2_TASK_STATUSES.join(", ")}`,
		);
	}
	if (!envelope.goal || envelope.goal.trim().length === 0) {
		errors.push("envelope.goal is required");
	}
	if (!isOneOf(envelope.routing?.mode, GSD2_ROUTE_MODES)) {
		errors.push(
			`envelope.routing.mode must be one of ${GSD2_ROUTE_MODES.join(", ")}`,
		);
	}
	return errors;
}

export function validateGsd2Receipt(receipt: Gsd2Receipt): string[] {
	const errors: string[] = [];
	if (!receipt.taskId || !TASK_ID_PATTERN.test(receipt.taskId)) {
		errors.push("receipt.task_id must match G2-0001 format");
	}
	if (!isOneOf(receipt.finalStatus, GSD2_FINAL_STATUSES)) {
		errors.push(
			`receipt.final_status must be one of ${GSD2_FINAL_STATUSES.join(", ")}`,
		);
	}
	return errors;
}

export async function runGsd2(
	argv: readonly string[],
	options: RunGsd2Options = {},
): Promise<number> {
	const stdout = options.stdout ?? console.log;
	const stderr = options.stderr ?? console.error;
	const parsedGlobalArgs = parseGlobalArgs(argv, options.cwd ?? process.cwd());
	if (parsedGlobalArgs.error) {
		stderr(parsedGlobalArgs.error);
		return 1;
	}
	const cwd = parsedGlobalArgs.cwd;
	const [command, ...rest] = parsedGlobalArgs.argv;

	if (!command || command === "--help" || command === "help") {
		for (const line of formatHelp()) {
			stdout(line);
		}
		return 0;
	}

	try {
		switch (command) {
			case "status":
				return runStatus(cwd, stdout);
			case "new":
				return runNew(cwd, rest, stdout, stderr);
			case "validate":
				return runValidate(cwd, stdout);
			case "run":
				return runDryRun(cwd, rest, stdout, stderr);
			default:
				stderr(`gsd2: unknown command '${command}'`);
				return 1;
		}
	} catch (error) {
		stderr(formatError(error));
		return 1;
	}
}

function formatHelp(): string[] {
	return [
		"GSD-2 repo-local task state",
		"",
		"Usage:",
		"  gsd2 status",
		'  gsd2 new "<goal>" [--route <mode>]',
		"  gsd2 validate",
		"  gsd2 run --dry-run <task-id>",
		"",
		"Milestone 1 is non-executing: dry-run previews routes but never spawns workers.",
	];
}

function runStatus(cwd: string, stdout: (line: string) => void): number {
	const root = join(cwd, ".gsd2");
	if (!existsSync(root)) {
		stdout(
			'gsd2: no .gsd2 state found; run `gsd2 new "<goal>"` to create the first task.',
		);
		return 1;
	}

	const tasks = listTaskIds(cwd);
	stdout("gsd2 status: ready");
	stdout(`tasks: ${tasks.length}`);
	if (tasks.length > 0) {
		stdout(`latest: ${tasks[tasks.length - 1]}`);
	}
	return 0;
}

function runNew(
	cwd: string,
	argv: readonly string[],
	stdout: (line: string) => void,
	stderr: (line: string) => void,
): number {
	const parsed = parseNewArgs(argv);
	if (!parsed.goal) {
		stderr("gsd2 new: missing required goal");
		return 1;
	}
	if (!isOneOf(parsed.route, GSD2_ROUTE_MODES)) {
		stderr(`gsd2 new: route must be one of ${GSD2_ROUTE_MODES.join(", ")}`);
		return 1;
	}

	const root = join(cwd, ".gsd2");
	mkdirSync(join(root, "tasks"), { recursive: true });
	writeIfMissing(
		join(root, "PROJECT.md"),
		"# GSD-2 Project\n\nRepo-local autonomous-work state.\n",
	);
	if (!existsSync(join(root, "STATE.md"))) {
		writeStateMarkdown(root, Math.max(maxTaskDirectoryNumber(cwd) + 1, 1));
	}
	writeIfMissing(join(root, "QUEUE.md"), "# GSD-2 Queue\n\n");
	writeIfMissing(
		join(root, "config.yaml"),
		"version: 0\nrouting:\n  default_front_door: auto-coder\nsafety:\n  no_push_by_default: true\n  no_deploy_by_default: true\n",
	);

	const taskNumber = nextTaskNumber(cwd);
	if (taskNumber === undefined) {
		stderr(
			"gsd2 new: task id space exhausted for V0 format G2-0001 through G2-9999",
		);
		return 1;
	}
	const taskId = formatTaskId(taskNumber);
	const taskDir = join(root, "tasks", taskId);
	mkdirSync(taskDir, { recursive: true });
	const backend = backendForRoute(parsed.route);
	const now = new Date().toISOString();
	writeFileSync(
		join(taskDir, "task.md"),
		formatTaskMarkdown(taskId, parsed.goal),
	);
	writeFileSync(
		join(taskDir, "envelope.yaml"),
		formatEnvelopeYaml(taskId, parsed.goal, parsed.route, backend, now),
	);
	writeFileSync(
		join(taskDir, "receipt.yaml"),
		formatReceiptYaml(taskId, backend, now),
	);
	writeStateMarkdown(root, taskNumber + 1);

	stdout(`task-id: ${taskId}`);
	stdout(`route: ${parsed.route}`);
	stdout("will-execute: false");
	return 0;
}

function runValidate(cwd: string, stdout: (line: string) => void): number {
	const root = join(cwd, ".gsd2");
	if (!existsSync(root)) {
		stdout(
			'gsd2 validate: fail; no .gsd2 state found; run `gsd2 new "<goal>"` to create the first task.',
		);
		return 1;
	}

	const tasks = listTaskIds(cwd);
	const errors: string[] = [];
	for (const taskId of tasks) {
		const taskDir = join(cwd, ".gsd2", "tasks", taskId);
		const envelopePath = join(taskDir, "envelope.yaml");
		const receiptPath = join(taskDir, "receipt.yaml");
		if (!existsSync(envelopePath)) {
			errors.push(`${taskId}/envelope.yaml is missing`);
		} else {
			for (const error of validateGsd2Envelope(
				parseGsd2Envelope(readFileSync(envelopePath, "utf8")),
			)) {
				errors.push(`${taskId}/envelope.yaml: ${error}`);
			}
		}
		if (!existsSync(receiptPath)) {
			errors.push(`${taskId}/receipt.yaml is missing`);
		} else {
			for (const error of validateGsd2Receipt(
				parseGsd2Receipt(readFileSync(receiptPath, "utf8")),
			)) {
				errors.push(`${taskId}/receipt.yaml: ${error}`);
			}
		}
	}

	if (errors.length > 0) {
		stdout("gsd2 validate: fail");
		for (const error of errors) {
			stdout(`  - ${error}`);
		}
		return 1;
	}
	stdout("gsd2 validate: pass");
	stdout(`tasks: ${tasks.length}`);
	return 0;
}

function runDryRun(
	cwd: string,
	argv: readonly string[],
	stdout: (line: string) => void,
	stderr: (line: string) => void,
): number {
	const parsed = parseDryRunArgs(argv);
	if (!parsed.dryRun) {
		stderr("gsd2 run: Milestone 1 only supports --dry-run");
		return 1;
	}
	if (!parsed.taskId || !TASK_ID_PATTERN.test(parsed.taskId)) {
		stderr("gsd2 run --dry-run: missing required task id such as G2-0001");
		return 1;
	}
	const envelopePath = join(
		cwd,
		".gsd2",
		"tasks",
		parsed.taskId,
		"envelope.yaml",
	);
	if (!existsSync(envelopePath)) {
		stderr(`gsd2 run --dry-run: task ${parsed.taskId} not found`);
		return 1;
	}
	const envelope = parseGsd2Envelope(readFileSync(envelopePath, "utf8"));
	const envelopeErrors = validateGsd2Envelope(envelope);
	if (envelopeErrors.length > 0) {
		for (const error of envelopeErrors) {
			stderr(`gsd2 run --dry-run: ${parsed.taskId}/envelope.yaml: ${error}`);
		}
		return 1;
	}
	const route = asRouteMode(envelope.routing?.mode ?? "planning_only");
	const backend = envelope.routing?.backend ?? backendForRoute(route);
	const commands =
		envelope.verification?.commands.length === 0
			? DEFAULT_VERIFICATION_COMMANDS
			: (envelope.verification?.commands ?? DEFAULT_VERIFICATION_COMMANDS);

	stdout(`gsd2 dry-run: ${parsed.taskId}`);
	stdout(`front-door: ${envelope.routing?.frontDoor ?? "auto-coder"}`);
	stdout(`route: ${route}`);
	stdout(`backend: ${backend}`);
	stdout("will-execute: false");
	stdout("verification:");
	for (const command of commands) {
		stdout(`  - ${command}`);
	}
	stdout("recovery:");
	for (const action of DEFAULT_RECOVERY_ACTIONS) {
		stdout(`  - ${action}`);
	}
	return 0;
}

function parseNewArgs(argv: readonly string[]): {
	goal: string;
	route: string;
} {
	let goal = "";
	let route: string = "planning_only";
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === "--route") {
			route = argv[index + 1] ?? "";
			index += 1;
			continue;
		}
		if (!token.startsWith("--") && goal.length === 0) {
			goal = token;
		}
	}
	return { goal, route };
}

function parseGlobalArgs(
	argv: readonly string[],
	defaultCwd: string,
): { argv: string[]; cwd: string; error?: string } {
	const commandArgv: string[] = [];
	let cwd = defaultCwd;
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === "--workspace") {
			const workspace = argv[index + 1];
			if (!workspace) {
				return {
					argv: commandArgv,
					cwd,
					error: "gsd2: --workspace requires a path",
				};
			}
			cwd = workspace;
			index += 1;
			continue;
		}
		commandArgv.push(token);
	}
	return { argv: commandArgv, cwd };
}

function parseDryRunArgs(argv: readonly string[]): {
	dryRun: boolean;
	taskId?: string;
} {
	let dryRun = false;
	let taskId: string | undefined;
	for (const token of argv) {
		if (token === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (!token.startsWith("--") && taskId === undefined) {
			taskId = token;
		}
	}
	return { dryRun, taskId };
}

function listTaskIds(cwd: string): string[] {
	const tasksRoot = join(cwd, ".gsd2", "tasks");
	if (!existsSync(tasksRoot)) {
		return [];
	}
	return readdirSync(tasksRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && TASK_ID_PATTERN.test(entry.name))
		.map((entry) => entry.name)
		.sort();
}

function nextTaskNumber(cwd: string): number | undefined {
	const maxDirectoryNumber = maxTaskDirectoryNumber(cwd);
	const stateNumber = readNextTaskNumber(cwd);
	const nextNumber = Math.max(maxDirectoryNumber + 1, stateNumber ?? 1);
	return nextNumber > 9999 ? undefined : nextNumber;
}

function maxTaskDirectoryNumber(cwd: string): number {
	return listTaskIds(cwd).reduce((max, taskId) => {
		const numeric = Number(taskId.slice(3));
		return Number.isNaN(numeric) ? max : Math.max(max, numeric);
	}, 0);
}

function readNextTaskNumber(cwd: string): number | undefined {
	const statePath = join(cwd, ".gsd2", "STATE.md");
	if (!existsSync(statePath)) {
		return undefined;
	}
	const value = readScalar(readFileSync(statePath, "utf8"), "next_task_number");
	if (!value) {
		return undefined;
	}
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function writeStateMarkdown(root: string, nextTaskNumber: number): void {
	writeFileSync(
		join(root, "STATE.md"),
		`# GSD-2 State\n\nCurrent status: initialized\nnext_task_number: ${nextTaskNumber}\n`,
	);
}

function formatTaskId(taskNumber: number): string {
	return `G2-${String(taskNumber).padStart(4, "0")}`;
}

function backendForRoute(route: Gsd2RouteMode): string {
	switch (route) {
		case "worktree_kernel":
			return "worktree-kernel";
		case "buildplane":
			return "buildplane";
		case "direct":
			return "direct";
		default:
			return "none";
	}
}

function formatTaskMarkdown(taskId: string, goal: string): string {
	return `# ${taskId}\n\n## Goal\n\n${goal}\n\n## Acceptance\n\n- Route preview and receipts remain non-executing until a later milestone explicitly enables a backend.\n`;
}

function formatEnvelopeYaml(
	taskId: string,
	goal: string,
	route: Gsd2RouteMode,
	backend: string,
	now: string,
): string {
	return `id: ${taskId}\nstatus: NEW\ncreated_at: "${now}"\nupdated_at: "${now}"\ngoal: "${escapeYamlString(goal)}"\nrouting:\n  mode: ${route}\n  front_door: auto-coder\n  backend: ${backend}\nverification:\n  commands:\n    - "git diff --check"\nrecovery:\n  max_attempts: 2\n  allowed_actions:\n    - retry_with_tighter_context\n    - fresh_worktree\n    - buildplane_replay\n    - buildplane_fork\n    - manual_escalation\n`;
}

function formatReceiptYaml(
	taskId: string,
	backend: string,
	now: string,
): string {
	return `task_id: ${taskId}\nrun_id: null\nbackend: ${backend}\nfinal_status: BLOCKED\nchecked_by: agent\nchecked_at: "${now}"\nverification:\n  required_complete: false\nacceptance:\n  explicitly_checked: false\nunresolved_findings:\n  - "Task has not executed; Milestone 1 only creates state and previews routes."\nrecovery_next_step: "Select an execution milestone explicitly before running workers."\n`;
}

function writeIfMissing(path: string, content: string): void {
	if (!existsSync(path)) {
		writeFileSync(path, content);
	}
}

function readScalar(content: string, key: string): string | undefined {
	const escapedKey = escapeRegExp(key);
	const match = new RegExp(`^${escapedKey}:\\s*(.+?)\\s*$`, "m").exec(content);
	return match ? cleanScalar(match[1] ?? "") : undefined;
}

function readNestedScalar(
	content: string,
	section: string,
	key: string,
): string | undefined {
	return readScalar(extractSection(content, section), key);
}

function readNestedList(
	content: string,
	section: string,
	key: string,
): string[] {
	const sectionContent = extractSection(content, section);
	const lines = sectionContent.split(/\r?\n/);
	const values: string[] = [];
	let inList = false;
	for (const line of lines) {
		if (new RegExp(`^${escapeRegExp(key)}:`).test(line)) {
			inList = true;
			continue;
		}
		if (inList && /^\s{2}-\s+/.test(line)) {
			values.push(cleanScalar(line.replace(/^\s{2}-\s+/, "")));
			continue;
		}
		if (inList && /^\S/.test(line)) {
			break;
		}
	}
	return values;
}

function extractSection(content: string, section: string): string {
	const lines = content.split(/\r?\n/);
	const collected: string[] = [];
	let collecting = false;
	for (const line of lines) {
		if (new RegExp(`^${escapeRegExp(section)}:`).test(line)) {
			collecting = true;
			continue;
		}
		if (collecting && /^\S/.test(line)) {
			break;
		}
		if (collecting) {
			collected.push(line.replace(/^\s{2}/, ""));
		}
	}
	return collected.join("\n");
}

function cleanScalar(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function escapeYamlString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isOneOf<T extends readonly string[]>(
	value: string | undefined,
	allowed: T,
): value is T[number] {
	return typeof value === "string" && allowed.includes(value);
}

function asRouteMode(value: string): Gsd2RouteMode {
	return isOneOf(value, GSD2_ROUTE_MODES) ? value : "planning_only";
}

function formatError(error: unknown): string {
	return error instanceof Error
		? `gsd2: ${error.message}`
		: "gsd2: unknown error";
}
