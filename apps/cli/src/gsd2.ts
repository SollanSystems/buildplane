import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

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

export const GSD2_ADMISSION_COLUMNS = [
	"inbox",
	"triage",
	"planned",
	"architecture_review",
	"ready_for_execution",
	"running",
	"verifying",
	"blocked",
	"ready_for_pr",
	"pr_open",
	"accepted",
	"archived",
] as const;

export const GSD2_ARCHITECTURE_IMPACTS = [
	"none",
	"low",
	"medium",
	"high",
] as const;

const GSD2_ADMISSION_RECEIPT_TYPE = "task.admitted";
const GSD2_READY_COLUMN = "ready_for_execution";

type Gsd2RouteMode = (typeof GSD2_ROUTE_MODES)[number];
type Gsd2ArchitectureImpact = (typeof GSD2_ARCHITECTURE_IMPACTS)[number];

interface Gsd2Envelope {
	readonly id?: string;
	readonly status?: string;
	readonly goal?: string;
	readonly architectureImpact?: string;
	readonly requiredAdrs: readonly string[];
	readonly requestedCapabilities: readonly string[];
	readonly evidenceRequirements: readonly string[];
	readonly gateReceipts: readonly string[];
	readonly routing?: {
		readonly mode?: string;
		readonly frontDoor?: string;
		readonly backend?: string;
	};
	readonly verification?: {
		readonly commands: readonly string[];
	};
	readonly buildplane?: {
		readonly runIds: readonly string[];
	};
	readonly recovery?: {
		readonly allowedActions: readonly string[];
	};
}

interface AdmissionPlan {
	readonly taskId: string;
	readonly fromStatus: string;
	readonly toStatus: "READY";
	readonly kanbanColumn: "ready_for_execution";
	readonly route: Gsd2RouteMode;
	readonly backend: string;
	readonly gates: readonly string[];
	readonly requestedCapabilities: readonly string[];
	readonly evidenceRequirements: readonly string[];
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

interface RecoverArgs {
	readonly dryRun: boolean;
	readonly taskId?: string;
	readonly parentRunId?: string;
	readonly forkEventId?: string;
	readonly reason?: string;
	readonly packet?: string;
	readonly expectedEvidenceDelta: readonly string[];
}

interface RecoveryPlan {
	readonly taskId: string;
	readonly action: "buildplane_fork";
	readonly parentRunId: string;
	readonly forkEventId: string;
	readonly reason: string;
	readonly packetPath: string;
	readonly packetSha256: string;
	readonly expectedEvidenceDelta: readonly string[];
	readonly commandPreview: string;
	readonly createdAt: string;
}

const TASK_ID_PATTERN = /^G2-\d{4}$/;
const NEXT_TASK_NUMBER_LINE_PATTERN =
	/^next_task_number:\s*['"]?\s*(\d+)\s*['"]?(?:\s+#.*)?\s*$/gm;
const STATE_SCHEMA_VERSION_LINE_PATTERN =
	/^schema_version:\s*['"]?\s*(\d+)\s*['"]?(?:\s+#.*)?\s*$/gm;
const CURRENT_STATE_SCHEMA_VERSION = 1;
const DEFAULT_VERIFICATION_COMMANDS = ["git diff --check"] as const;
const DEFAULT_EVIDENCE_REQUIREMENTS = [
	"task.admitted receipt",
	"verifier.executed receipts",
	"evidence.accepted receipts",
] as const;
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
		architectureImpact: readScalar(content, "architecture_impact"),
		requiredAdrs: readTopLevelList(content, "required_adrs"),
		requestedCapabilities: readTopLevelList(content, "requested_capabilities"),
		evidenceRequirements: readTopLevelList(content, "evidence_requirements"),
		gateReceipts: readTopLevelList(content, "gate_receipts"),
		routing: {
			mode: readNestedScalar(content, "routing", "mode"),
			frontDoor: readNestedScalar(content, "routing", "front_door"),
			backend: readNestedScalar(content, "routing", "backend"),
		},
		verification: {
			commands: readNestedList(content, "verification", "commands"),
		},
		buildplane: {
			runIds: readNestedList(content, "buildplane", "run_ids"),
		},
		recovery: {
			allowedActions: readNestedList(content, "recovery", "allowed_actions"),
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
	if (
		envelope.architectureImpact !== undefined &&
		!isOneOf(envelope.architectureImpact, GSD2_ARCHITECTURE_IMPACTS)
	) {
		errors.push(
			`envelope.architecture_impact must be one of ${GSD2_ARCHITECTURE_IMPACTS.join(", ")}`,
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
			case "admit":
				return runAdmit(cwd, rest, stdout, stderr);
			case "validate":
				return runValidate(cwd, stdout);
			case "run":
				return runDryRun(cwd, rest, stdout, stderr);
			case "recover":
				return runRecover(cwd, rest, stdout, stderr);
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
		"  gsd2 admit [--dry-run] <task-id>",
		"  gsd2 validate",
		"  gsd2 run --dry-run <task-id>",
		"  gsd2 recover [--dry-run] <task-id> --parent-run <run-id> --at <event-id> --reason <text> --packet <file> --expected-evidence <text>",
		"",
		"Admission moves NEW tasks to READY with a local task.admitted receipt; it never executes workers.",
		"Milestone 1 is non-executing: dry-run previews routes and recovery plans but never spawns workers.",
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
	prepareStateForCommand(cwd);

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
	const lock = acquireMutationLock(root);
	try {
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
		migrateStateSchema(cwd);

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
		writeTextAtomic(
			join(taskDir, "task.md"),
			formatTaskMarkdown(taskId, parsed.goal),
		);
		writeTextAtomic(
			join(taskDir, "envelope.yaml"),
			formatEnvelopeYaml(taskId, parsed.goal, parsed.route, backend, now),
		);
		writeTextAtomic(
			join(taskDir, "receipt.yaml"),
			formatReceiptYaml(taskId, backend, now),
		);
		writeStateMarkdown(root, taskNumber + 1);

		stdout(`task-id: ${taskId}`);
		stdout(`route: ${parsed.route}`);
		stdout("will-execute: false");
		return 0;
	} finally {
		releaseMutationLock(lock);
	}
}

function runAdmit(
	cwd: string,
	argv: readonly string[],
	stdout: (line: string) => void,
	stderr: (line: string) => void,
): number {
	const parsed = parseAdmitArgs(argv);
	if (!parsed.taskId || !TASK_ID_PATTERN.test(parsed.taskId)) {
		stderr("gsd2 admit: missing required task id such as G2-0001");
		return 1;
	}
	if (existsSync(join(cwd, ".gsd2"))) {
		prepareStateForCommand(cwd);
	}
	const taskDir = join(cwd, ".gsd2", "tasks", parsed.taskId);
	const envelopePath = join(taskDir, "envelope.yaml");
	const receiptPath = join(taskDir, "receipt.yaml");
	if (!existsSync(envelopePath)) {
		stderr(`gsd2 admit: task ${parsed.taskId} not found`);
		return 1;
	}

	const envelopeContent = readFileSync(envelopePath, "utf8");
	const envelope = parseGsd2Envelope(envelopeContent);
	const planResult = buildAdmissionPlan(parsed.taskId, envelope);
	if (planResult.errors.length > 0) {
		for (const error of planResult.errors) {
			stderr(`gsd2 admit: ${parsed.taskId}/envelope.yaml: ${error}`);
		}
		return 1;
	}
	const plan = planResult.plan;
	if (parsed.dryRun) {
		stdout(`gsd2 admission dry-run: ${plan.taskId}`);
		stdout(`from-status: ${plan.fromStatus}`);
		stdout(`to-status: ${plan.toStatus}`);
		stdout(`kanban-column: ${plan.kanbanColumn}`);
		stdout(`route: ${plan.route}`);
		stdout(`backend: ${plan.backend}`);
		stdout("will-execute: false");
		stdout("required-gates:");
		for (const gate of plan.gates) {
			stdout(`  - ${gate}`);
		}
		stdout("requested-capabilities:");
		for (const capability of plan.requestedCapabilities) {
			stdout(`  - ${capability}`);
		}
		stdout("evidence-requirements:");
		for (const evidence of plan.evidenceRequirements) {
			stdout(`  - ${evidence}`);
		}
		return 0;
	}

	const lock = acquireMutationLock(join(cwd, ".gsd2"));
	try {
		const now = new Date().toISOString();
		const latestEnvelope = parseGsd2Envelope(
			readFileSync(envelopePath, "utf8"),
		);
		const latestPlanResult = buildAdmissionPlan(parsed.taskId, latestEnvelope);
		if (latestPlanResult.errors.length > 0) {
			for (const error of latestPlanResult.errors) {
				stderr(`gsd2 admit: ${parsed.taskId}/envelope.yaml: ${error}`);
			}
			return 1;
		}
		const latestPlan = latestPlanResult.plan;
		writeTextAtomic(
			envelopePath,
			markEnvelopeAdmitted(readFileSync(envelopePath, "utf8"), now),
		);
		writeTextAtomic(receiptPath, formatAdmissionReceiptYaml(latestPlan, now));
		stdout(`gsd2 admit: ${latestPlan.taskId}`);
		stdout(`status: ${latestPlan.toStatus}`);
		stdout(`kanban-column: ${latestPlan.kanbanColumn}`);
		stdout(`receipt: ${GSD2_ADMISSION_RECEIPT_TYPE}`);
		stdout("will-execute: false");
		return 0;
	} finally {
		releaseMutationLock(lock);
	}
}

function runValidate(cwd: string, stdout: (line: string) => void): number {
	const root = join(cwd, ".gsd2");
	if (!existsSync(root)) {
		stdout(
			'gsd2 validate: fail; no .gsd2 state found; run `gsd2 new "<goal>"` to create the first task.',
		);
		return 1;
	}
	prepareStateForCommand(cwd);

	const tasks = listTaskIds(cwd);
	const errors: string[] = [];
	for (const taskId of tasks) {
		const taskDir = join(cwd, ".gsd2", "tasks", taskId);
		const envelopePath = join(taskDir, "envelope.yaml");
		const receiptPath = join(taskDir, "receipt.yaml");
		if (!existsSync(envelopePath)) {
			errors.push(`${taskId}/envelope.yaml is missing`);
		} else {
			const envelope = parseGsd2Envelope(readFileSync(envelopePath, "utf8"));
			for (const error of validateGsd2Envelope(envelope)) {
				errors.push(`${taskId}/envelope.yaml: ${error}`);
			}
			if (
				envelope.id !== undefined &&
				TASK_ID_PATTERN.test(envelope.id) &&
				envelope.id !== taskId
			) {
				errors.push(
					`${taskId}/envelope.yaml: envelope.id must match task directory`,
				);
			}
		}
		if (!existsSync(receiptPath)) {
			errors.push(`${taskId}/receipt.yaml is missing`);
		} else {
			const receipt = parseGsd2Receipt(readFileSync(receiptPath, "utf8"));
			for (const error of validateGsd2Receipt(receipt)) {
				errors.push(`${taskId}/receipt.yaml: ${error}`);
			}
			if (
				receipt.taskId !== undefined &&
				TASK_ID_PATTERN.test(receipt.taskId) &&
				receipt.taskId !== taskId
			) {
				errors.push(
					`${taskId}/receipt.yaml: receipt.task_id must match task directory`,
				);
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
	if (existsSync(join(cwd, ".gsd2"))) {
		prepareStateForCommand(cwd);
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

function runRecover(
	cwd: string,
	argv: readonly string[],
	stdout: (line: string) => void,
	stderr: (line: string) => void,
): number {
	const parsed = parseRecoverArgs(argv);
	if ("error" in parsed) {
		stderr(`gsd2 recover: ${parsed.error}`);
		return 1;
	}
	const args = parsed.value;
	if (!args.taskId || !TASK_ID_PATTERN.test(args.taskId)) {
		stderr("gsd2 recover: missing required task id such as G2-0001");
		return 1;
	}
	if (!args.parentRunId) {
		stderr("gsd2 recover: missing required --parent-run <run-id>");
		return 1;
	}
	if (!args.forkEventId) {
		stderr("gsd2 recover: missing required --at <event-id>");
		return 1;
	}
	if (!args.reason) {
		stderr("gsd2 recover: missing required --reason <text>");
		return 1;
	}
	if (!args.packet) {
		stderr("gsd2 recover: missing required --packet <file>");
		return 1;
	}
	if (args.expectedEvidenceDelta.length === 0) {
		stderr("gsd2 recover: missing required --expected-evidence <text>");
		return 1;
	}

	const root = join(cwd, ".gsd2");
	if (!existsSync(root)) {
		stderr("gsd2 recover: no .gsd2 state found");
		return 1;
	}
	prepareStateForCommand(cwd);

	const taskDir = join(root, "tasks", args.taskId);
	const taskDirCheck = resolveStateTaskDirectory(root, taskDir);
	if ("error" in taskDirCheck) {
		stderr(`gsd2 recover: ${args.taskId}: ${taskDirCheck.error}`);
		return 1;
	}
	const envelopePath = join(taskDir, "envelope.yaml");
	if (!existsSync(envelopePath)) {
		stderr(`gsd2 recover: task ${args.taskId} not found`);
		return 1;
	}
	const envelope = parseGsd2Envelope(readFileSync(envelopePath, "utf8"));
	const envelopeErrors = validateGsd2Envelope(envelope);
	if (
		envelope.id !== undefined &&
		TASK_ID_PATTERN.test(envelope.id) &&
		envelope.id !== args.taskId
	) {
		envelopeErrors.push("envelope.id must match task directory");
	}
	if (envelopeErrors.length > 0) {
		for (const error of envelopeErrors) {
			stderr(`gsd2 recover: ${args.taskId}/envelope.yaml: ${error}`);
		}
		return 1;
	}

	const allowedActions = envelope.recovery?.allowedActions ?? [];
	if (!allowedActions.includes("buildplane_fork")) {
		stderr(
			`gsd2 recover: ${args.taskId}/envelope.yaml does not allow buildplane_fork recovery`,
		);
		return 1;
	}

	const parentRunId = normalizeSingleLine(args.parentRunId);
	if (parentRunId.length === 0) {
		stderr("gsd2 recover: missing required --parent-run <run-id>");
		return 1;
	}
	const forkEventId = normalizeSingleLine(args.forkEventId);
	if (forkEventId.length === 0) {
		stderr("gsd2 recover: missing required --at <event-id>");
		return 1;
	}
	const reason = normalizeSingleLine(args.reason);
	if (reason.length === 0) {
		stderr("gsd2 recover: missing required --reason <text>");
		return 1;
	}
	const expectedEvidenceDelta =
		args.expectedEvidenceDelta.map(normalizeSingleLine);
	if (
		expectedEvidenceDelta.length === 0 ||
		expectedEvidenceDelta.some((delta) => delta.length === 0)
	) {
		stderr("gsd2 recover: missing required --expected-evidence <text>");
		return 1;
	}

	const packetResolution = resolveWorkspacePacket(cwd, args.packet);
	if ("error" in packetResolution) {
		stderr(`gsd2 recover: ${packetResolution.error}`);
		return 1;
	}
	const packet = packetResolution.value;
	let packetSha256: string;
	try {
		const packetStat = statSync(packet.realPath);
		if (!packetStat.isFile()) {
			stderr(`gsd2 recover: packet is not a file: ${packet.displayPath}`);
			return 1;
		}
		packetSha256 = sha256File(packet.realPath);
	} catch {
		stderr(`gsd2 recover: packet not found: ${packet.displayPath}`);
		return 1;
	}

	const plan = buildRecoveryPlan({
		taskId: args.taskId,
		parentRunId,
		forkEventId,
		reason,
		packetPath: packet.displayPath,
		packetSha256,
		expectedEvidenceDelta,
		createdAt: new Date().toISOString(),
	});

	if (args.dryRun) {
		stdout(`gsd2 recovery dry-run: ${plan.taskId}`);
		stdout(`action: ${plan.action}`);
		stdout(`parent-run-id: ${plan.parentRunId}`);
		stdout(`fork-event-id: ${plan.forkEventId}`);
		stdout(`reason: ${plan.reason}`);
		stdout(`packet: ${plan.packetPath}`);
		stdout(`packet-sha256: ${plan.packetSha256}`);
		stdout("will-execute: false");
		stdout("expected-evidence-delta:");
		for (const delta of plan.expectedEvidenceDelta) {
			stdout(`  - ${delta}`);
		}
		stdout("command-preview:");
		stdout(`  - ${plan.commandPreview}`);
		return 0;
	}

	const lock = acquireMutationLock(root);
	try {
		writeTextAtomic(
			join(taskDir, "recovery-plan.yaml"),
			formatRecoveryPlanYaml(plan),
		);
		const backend =
			envelope.routing?.backend ??
			backendForRoute(asRouteMode(envelope.routing?.mode ?? "planning_only"));
		writeTextAtomic(
			join(taskDir, "receipt.yaml"),
			formatRecoveryReceiptYaml(plan, backend),
		);
	} finally {
		releaseMutationLock(lock);
	}

	stdout(`gsd2 recovery planned: ${plan.taskId}`);
	stdout(`recovery-plan: .gsd2/tasks/${plan.taskId}/recovery-plan.yaml`);
	stdout(`receipt: .gsd2/tasks/${plan.taskId}/receipt.yaml`);
	stdout("will-execute: false");
	stdout(
		"next-step: operator approval required before running buildplane fork",
	);
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

function parseAdmitArgs(argv: readonly string[]): {
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

function parseRecoverArgs(
	argv: readonly string[],
):
	| { value: RecoverArgs; error?: undefined }
	| { error: string; value?: undefined } {
	let dryRun = false;
	let taskId: string | undefined;
	let parentRunId: string | undefined;
	let forkEventId: string | undefined;
	let reason: string | undefined;
	let packet: string | undefined;
	const expectedEvidenceDelta: string[] = [];

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (token === "--parent-run" || token === "--parent-run-id") {
			const value = readFlagValue(argv, index, token);
			if ("error" in value) return { error: value.error };
			parentRunId = value.value;
			index += 1;
			continue;
		}
		if (token === "--at" || token === "--fork-event") {
			const value = readFlagValue(argv, index, token);
			if ("error" in value) return { error: value.error };
			forkEventId = value.value;
			index += 1;
			continue;
		}
		if (token === "--reason") {
			const value = readFlagValue(argv, index, token);
			if ("error" in value) return { error: value.error };
			reason = value.value;
			index += 1;
			continue;
		}
		if (token === "--packet") {
			const value = readFlagValue(argv, index, token);
			if ("error" in value) return { error: value.error };
			packet = value.value;
			index += 1;
			continue;
		}
		if (token === "--expected-evidence") {
			const value = readFlagValue(argv, index, token);
			if ("error" in value) return { error: value.error };
			expectedEvidenceDelta.push(value.value);
			index += 1;
			continue;
		}
		if (token.startsWith("--")) {
			return { error: `unknown argument: ${token}` };
		}
		if (taskId === undefined) {
			taskId = token;
			continue;
		}
		return { error: `unexpected argument: ${token}` };
	}

	return {
		value: {
			dryRun,
			taskId,
			parentRunId,
			forkEventId,
			reason,
			packet,
			expectedEvidenceDelta,
		},
	};
}

function readFlagValue(
	argv: readonly string[],
	index: number,
	flag: string,
): { ok: true; value: string } | { ok: false; error: string } {
	const value = argv[index + 1];
	if (!value || value.startsWith("--")) {
		return { ok: false, error: `${flag} requires a value` };
	}
	return { ok: true, value };
}

function buildAdmissionPlan(
	taskId: string,
	envelope: Gsd2Envelope,
): { plan: AdmissionPlan; errors: readonly string[] } {
	const errors: string[] = [...validateGsd2Envelope(envelope)];
	if (envelope.id !== taskId) {
		errors.push(`envelope.id must match task id ${taskId}`);
	}
	if (envelope.status !== "NEW") {
		errors.push("envelope.status must be NEW before admission");
	}
	if ((envelope.verification?.commands.length ?? 0) === 0) {
		errors.push("envelope.verification.commands is required for admission");
	}
	const route = asRouteMode(envelope.routing?.mode ?? "planning_only");
	const backend = envelope.routing?.backend ?? backendForRoute(route);
	const architectureImpact = asArchitectureImpact(
		envelope.architectureImpact ?? "low",
	);
	const requestedCapabilities =
		envelope.requestedCapabilities.length > 0
			? envelope.requestedCapabilities
			: defaultCapabilitiesForRoute(route);
	const evidenceRequirements =
		envelope.evidenceRequirements.length > 0
			? envelope.evidenceRequirements
			: DEFAULT_EVIDENCE_REQUIREMENTS;
	const gates = admissionGatesFor(route, architectureImpact);
	return {
		plan: {
			taskId,
			fromStatus: envelope.status ?? "UNKNOWN",
			toStatus: "READY",
			kanbanColumn: GSD2_READY_COLUMN,
			route,
			backend,
			gates,
			requestedCapabilities,
			evidenceRequirements,
		},
		errors,
	};
}

function admissionGatesFor(
	route: Gsd2RouteMode,
	architectureImpact: Gsd2ArchitectureImpact,
): string[] {
	const gates = [
		"task.envelope.valid",
		"task.scope.declared",
		"verification.plan.present",
	];
	if (route !== "planning_only" || architectureImpact !== "none") {
		gates.push("architecture.diff_scope");
	}
	return gates;
}

function defaultCapabilitiesForRoute(route: Gsd2RouteMode): string[] {
	switch (route) {
		case "planning_only":
			return ["fs.read:repo"];
		case "buildplane":
			return [
				"fs.read:repo",
				"fs.write:declared_scope",
				"command.execute:verification",
				"buildplane.run",
			];
		case "manual_recovery":
			return ["fs.read:repo", "operator.approval"];
		default:
			return [
				"fs.read:repo",
				"fs.write:declared_scope",
				"command.execute:verification",
			];
	}
}

function markEnvelopeAdmitted(content: string, now: string): string {
	return replaceTopLevelScalar(
		replaceTopLevelScalar(content, "status", "READY"),
		"updated_at",
		`"${now}"`,
	);
}

function formatAdmissionReceiptYaml(plan: AdmissionPlan, now: string): string {
	return `task_id: ${plan.taskId}
run_id: null
backend: ${plan.backend}
final_status: BLOCKED
checked_by: agent
checked_at: "${now}"
admission:
  receipt_type: ${GSD2_ADMISSION_RECEIPT_TYPE}
  from_status: ${plan.fromStatus}
  to_status: ${plan.toStatus}
  kanban_column: ${plan.kanbanColumn}
  admitted_at: "${now}"
  route: ${plan.route}
  backend: ${plan.backend}
  will_execute: false
  required_gates:
${formatYamlList(plan.gates, 4)}  requested_capabilities:
${formatYamlList(plan.requestedCapabilities, 4)}  evidence_requirements:
${formatYamlList(plan.evidenceRequirements, 4)}verification:
  required_complete: false
acceptance:
  explicitly_checked: false
unresolved_findings:
  - "Task is admitted to READY but execution and verification have not run."
recovery_next_step: "Prepare the selected backend only after explicit operator approval."
`;
}

function replaceTopLevelScalar(
	content: string,
	key: string,
	serializedValue: string,
): string {
	const pattern = new RegExp(`^${escapeRegExp(key)}:\\s*.*$`, "m");
	if (pattern.test(content)) {
		return content.replace(pattern, `${key}: ${serializedValue}`);
	}
	return `${content.replace(/\s*$/, "\n")}${key}: ${serializedValue}\n`;
}

function formatYamlList(values: readonly string[], spaces: number): string {
	const indent = " ".repeat(spaces);
	return values
		.map((value) => `${indent}- ${formatYamlString(value)}\n`)
		.join("");
}

function formatYamlString(value: string): string {
	return `"${escapeYamlString(sanitizeYamlListValue(value))}"`;
}

function sanitizeYamlListValue(value: string): string {
	return value.replace(/[\r\n]/g, " ").trim();
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
	const parsed = readNumberFromLastMatch(
		readFileSync(statePath, "utf8"),
		NEXT_TASK_NUMBER_LINE_PATTERN,
	);
	return parsed;
}

function writeStateMarkdown(root: string, nextTaskNumber: number): void {
	const statePath = join(root, "STATE.md");
	const existing = existsSync(statePath)
		? readFileSync(statePath, "utf8")
		: "# GSD-2 State\n\nCurrent status: initialized\n";
	const withoutCounter = existing
		.replace(STATE_SCHEMA_VERSION_LINE_PATTERN, "")
		.replace(NEXT_TASK_NUMBER_LINE_PATTERN, "");
	const updated = `${withoutCounter.replace(/\s*$/, "\n")}schema_version: ${CURRENT_STATE_SCHEMA_VERSION}\nnext_task_number: ${nextTaskNumber}\n`;
	writeTextAtomic(statePath, updated);
}

function prepareStateForCommand(cwd: string): void {
	const root = join(cwd, ".gsd2");
	const lock = acquireMutationLock(root);
	try {
		migrateStateSchema(cwd);
	} finally {
		releaseMutationLock(lock);
	}
}

function migrateStateSchema(cwd: string): void {
	const root = join(cwd, ".gsd2");
	const path = join(root, "STATE.md");
	if (!existsSync(path)) {
		return;
	}
	const content = readFileSync(path, "utf8");
	const version = readNumberFromLastMatch(
		content,
		STATE_SCHEMA_VERSION_LINE_PATTERN,
	);
	if (version === undefined) {
		const nextNumber =
			readNumberFromLastMatch(content, NEXT_TASK_NUMBER_LINE_PATTERN) ??
			Math.max(maxTaskDirectoryNumber(cwd) + 1, 1);
		writeStateMarkdown(root, nextNumber);
		return;
	}
	if (version !== CURRENT_STATE_SCHEMA_VERSION) {
		throw new Error(
			`unsupported .gsd2 state schema_version ${version} (supported: ${CURRENT_STATE_SCHEMA_VERSION})`,
		);
	}
}

function acquireMutationLock(root: string): { lockPath: string; fd: number } {
	mkdirSync(root, { recursive: true });
	const lockPath = join(root, "mutation.lock");
	try {
		const fd = openSync(lockPath, "wx");
		writeSync(fd, `${process.pid}\n`);
		fsyncSync(fd);
		return { lockPath, fd };
	} catch {
		throw new Error("mutation lock already held for this worktree");
	}
}

function releaseMutationLock(lock: { lockPath: string; fd: number }): void {
	try {
		closeSync(lock.fd);
	} finally {
		if (existsSync(lock.lockPath)) {
			unlinkSync(lock.lockPath);
		}
	}
}

function writeTextAtomic(path: string, content: string): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const tempPath = join(
		dir,
		`.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
	);
	const fd = openSync(tempPath, "wx");
	try {
		writeSync(fd, content);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tempPath, path);
	const dirFd = openSync(dir, "r");
	try {
		fsyncSync(dirFd);
	} finally {
		closeSync(dirFd);
	}
}

function readNumberFromLastMatch(
	content: string,
	pattern: RegExp,
): number | undefined {
	let last: RegExpExecArray | null = null;
	pattern.lastIndex = 0;
	let match = pattern.exec(content);
	while (match !== null) {
		last = match;
		match = pattern.exec(content);
	}
	if (!last) {
		return undefined;
	}
	const parsed = Number(last[1]);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
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
	return `id: ${taskId}\nstatus: NEW\ncreated_at: "${now}"\nupdated_at: "${now}"\ngoal: "${escapeYamlString(goal)}"\narchitecture_impact: low\nrequired_adrs: []\nscope:\n  allowed_paths:\n    - "."\n  forbidden_paths:\n    - ".env"\n    - "secrets/"\n  out_of_scope:\n    - "push"\n    - "deploy"\nrequested_capabilities:\n${formatYamlList(defaultCapabilitiesForRoute(route), 2)}evidence_requirements:\n${formatYamlList(DEFAULT_EVIDENCE_REQUIREMENTS, 2)}buildplane:\n  run_ids: []\ngate_receipts: []\nrouting:\n  mode: ${route}\n  front_door: auto-coder\n  backend: ${backend}\nverification:\n  commands:\n    - "git diff --check"\nrecovery:\n  max_attempts: 2\n  allowed_actions:\n    - retry_with_tighter_context\n    - fresh_worktree\n    - buildplane_replay\n    - buildplane_fork\n    - manual_escalation\n`;
}

function formatReceiptYaml(
	taskId: string,
	backend: string,
	now: string,
): string {
	return `task_id: ${taskId}\nrun_id: null\nbackend: ${backend}\nfinal_status: BLOCKED\nchecked_by: agent\nchecked_at: "${now}"\nverification:\n  required_complete: false\nacceptance:\n  explicitly_checked: false\nunresolved_findings:\n  - "Task has not executed; Milestone 1 only creates state and previews routes."\nrecovery_next_step: "Select an execution milestone explicitly before running workers."\n`;
}

function buildRecoveryPlan(input: {
	readonly taskId: string;
	readonly parentRunId: string;
	readonly forkEventId: string;
	readonly reason: string;
	readonly packetPath: string;
	readonly packetSha256: string;
	readonly expectedEvidenceDelta: readonly string[];
	readonly createdAt: string;
}): RecoveryPlan {
	const commandPreview = `pnpm buildplane fork ${shellArg(input.parentRunId)} --at ${shellArg(input.forkEventId)} --packet ${shellArg(input.packetPath)}`;
	return {
		taskId: input.taskId,
		action: "buildplane_fork",
		parentRunId: input.parentRunId,
		forkEventId: input.forkEventId,
		reason: input.reason,
		packetPath: input.packetPath,
		packetSha256: input.packetSha256,
		expectedEvidenceDelta: input.expectedEvidenceDelta,
		commandPreview,
		createdAt: input.createdAt,
	};
}

function formatRecoveryPlanYaml(plan: RecoveryPlan): string {
	return `kind: RecoveryPlan\ntask_id: ${plan.taskId}\ncreated_at: "${escapeYamlString(plan.createdAt)}"\naction: "${plan.action}"\nparent_run_id: "${escapeYamlString(plan.parentRunId)}"\nfork_event_id: "${escapeYamlString(plan.forkEventId)}"\nreason: "${escapeYamlString(plan.reason)}"\npacket:\n  path: "${escapeYamlString(plan.packetPath)}"\n  sha256: "${plan.packetSha256}"\nexpected_evidence_delta:\n${formatYamlList(plan.expectedEvidenceDelta, 2)}command_preview:\n  - "${escapeYamlString(plan.commandPreview)}"\nwill_execute: false\nnext_step: "operator approval required before running buildplane fork"\n`;
}

function formatRecoveryReceiptYaml(
	plan: RecoveryPlan,
	backend: string,
): string {
	return `task_id: ${plan.taskId}\nrun_id: null\nbackend: ${backend}\nfinal_status: BLOCKED\nchecked_by: agent\nchecked_at: "${escapeYamlString(plan.createdAt)}"\nverification:\n  required_complete: false\nacceptance:\n  explicitly_checked: false\nrecovery_plan_ref: .gsd2/tasks/${plan.taskId}/recovery-plan.yaml\nrecovery_action: "${plan.action}"\nparent_run_id: "${escapeYamlString(plan.parentRunId)}"\nfork_event_id: "${escapeYamlString(plan.forkEventId)}"\nexpected_evidence_delta:\n${formatYamlList(plan.expectedEvidenceDelta, 2)}unresolved_findings:\n  - "Recovery plan recorded but not executed; operator approval is required before running buildplane fork."\nrecovery_next_step: "operator approval required before running buildplane fork"\n`;
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function resolveStateTaskDirectory(
	stateRoot: string,
	taskDir: string,
): { value: string } | { error: string } {
	try {
		const realStateRoot = realpathSync(stateRoot);
		const realTaskDir = realpathSync(taskDir);
		if (!isPathInside(realStateRoot, realTaskDir)) {
			return { error: "task directory must resolve inside .gsd2 state" };
		}
		if (!statSync(realTaskDir).isDirectory()) {
			return { error: "task path is not a directory" };
		}
		return { value: realTaskDir };
	} catch {
		return { error: "task directory is not readable" };
	}
}

function resolveWorkspacePacket(
	cwd: string,
	packetArg: string,
): { value: { realPath: string; displayPath: string } } | { error: string } {
	const workspaceRoot = resolve(cwd);
	const packetPath = resolve(workspaceRoot, packetArg);
	if (!isPathInside(workspaceRoot, packetPath)) {
		return { error: "packet must be inside the workspace" };
	}
	const lexicalDisplayPath = safeWorkspaceDisplayPath(
		workspaceRoot,
		packetPath,
	);
	if (
		lexicalDisplayPath.length === 0 ||
		hasUnsafePathCharacters(lexicalDisplayPath)
	) {
		return { error: "packet path contains unsupported control characters" };
	}
	let realWorkspaceRoot: string;
	let realPacketPath: string;
	try {
		realWorkspaceRoot = realpathSync(workspaceRoot);
		realPacketPath = realpathSync(packetPath);
	} catch {
		return { error: `packet not found: ${lexicalDisplayPath}` };
	}
	if (!isPathInside(realWorkspaceRoot, realPacketPath)) {
		return { error: "packet must resolve inside the workspace" };
	}
	const displayPath = safeWorkspaceDisplayPath(
		realWorkspaceRoot,
		realPacketPath,
	);
	if (displayPath.length === 0 || hasUnsafePathCharacters(displayPath)) {
		return { error: "packet path contains unsupported control characters" };
	}
	return { value: { realPath: realPacketPath, displayPath } };
}

function safeWorkspaceDisplayPath(
	workspaceRoot: string,
	packetPath: string,
): string {
	return relative(workspaceRoot, packetPath).replace(/\\/g, "/");
}

function isPathInside(root: string, candidate: string): boolean {
	const relativePath = relative(root, candidate);
	return (
		relativePath.length > 0 &&
		relativePath !== ".." &&
		!relativePath.startsWith(`..${"/"}`) &&
		!relativePath.startsWith(`..${"\\"}`) &&
		!isAbsolute(relativePath)
	);
}

function hasUnsafePathCharacters(value: string): boolean {
	return Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint < 32 || codePoint === 127;
	});
}

function normalizeSingleLine(value: string): string {
	return Array.from(value)
		.filter((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint === 9 || codePoint >= 32;
		})
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

function shellArg(value: string): string {
	if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function writeIfMissing(path: string, content: string): void {
	if (!existsSync(path)) {
		writeTextAtomic(path, content);
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

function readTopLevelList(content: string, key: string): string[] {
	const scalar = readScalar(content, key);
	if (scalar === "[]") {
		return [];
	}
	const lines = content.split(/\r?\n/);
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
	return Array.from(value)
		.map((character) => {
			if (character === "\\") return "\\\\";
			if (character === '"') return '\\"';
			if (character === "\n") return "\\n";
			if (character === "\r") return "\\r";
			if (character === "\t") return "\\t";
			const codePoint = character.codePointAt(0) ?? 0;
			if (codePoint < 32 || codePoint === 127) {
				return `\\x${codePoint.toString(16).padStart(2, "0")}`;
			}
			return character;
		})
		.join("");
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

function asArchitectureImpact(value: string): Gsd2ArchitectureImpact {
	return isOneOf(value, GSD2_ARCHITECTURE_IMPACTS) ? value : "low";
}

function formatError(error: unknown): string {
	return error instanceof Error
		? `gsd2: ${error.message}`
		: "gsd2: unknown error";
}
