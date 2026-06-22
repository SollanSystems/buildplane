import { digest } from "./digest.js";
import type { PlanForgePlan, PlanForgeTask } from "./schema.js";

/** Wire shape attached at dispatch; validated by @buildplane/capability-broker at parse time. */
export const PLANFORGE_CAPABILITY_BUNDLE_SCHEMA_VERSION =
	"buildplane.capability_bundle.v0" as const;

export interface PlanForgeAttachedCapabilityBundle {
	readonly schemaVersion: typeof PLANFORGE_CAPABILITY_BUNDLE_SCHEMA_VERSION;
	readonly bundleId: string;
	readonly fsWrite?: readonly string[];
	readonly tools?: {
		readonly write_file?: { readonly enabled?: boolean };
		readonly run_command?: { readonly allowlist?: readonly string[] };
	};
}

/** The loop worker binary. Dispatched packets route to the ClaudeCodeExecutor,
 * which spawns `claude` directly; but the worker (claude, running in the
 * worktree) may recursively invoke `claude`/sub-tooling through the run_command
 * tool, which is gated by this allowlist. Adding it here authorizes that path.
 * CAPABILITY TRUST SURFACE — reviewed under L1/L2 2-role + adversarial. The
 * GAP-4 escape (allowlisting `claude` would otherwise permit
 * `claude --dangerously-skip-permissions ...`, since `commandMatchesAllowlist`
 * matches argv0/prefix) is closed in @buildplane/capability-broker's
 * evaluate.ts: a worker-binary invocation carrying any permission-escape flag is
 * denied + quarantined regardless of allowlisting (GAP-10). */
const WORKER_RUN_COMMAND_BINARY = "claude" as const;

const SIDE_EFFECT_FS_WRITE_GLOBS: Record<string, readonly string[]> = {
	"local-doc": ["docs/**"],
	"local-fixture": [
		"apps/cli/test/fixtures/**",
		"packages/**/test/fixtures/**",
	],
	"local-receipt": ["docs/operations/**"],
	"code-edit": [
		"src/**",
		"test/**",
		"packages/**/src/**",
		"packages/**/test/**",
	],
};

function allowlistFromVerificationCommands(
	commands: readonly string[],
): string[] {
	const seen = new Set<string>();
	for (const line of commands) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		const argv0 = trimmed.split(/\s+/)[0];
		if (argv0) {
			seen.add(argv0);
		}
	}
	return [...seen];
}

function fsWriteGlobsFromTask(task: PlanForgeTask): string[] {
	const globs = new Set<string>();
	for (const effect of task.allowedSideEffects) {
		const mapped = SIDE_EFFECT_FS_WRITE_GLOBS[effect];
		if (mapped) {
			for (const g of mapped) {
				globs.add(g);
			}
		}
	}
	return [...globs];
}

/**
 * Deterministic default capability bundle for one PlanForge task (M3-S3).
 * Full plan-level overrides land in M3-S7; this maps allowedSideEffects and
 * verificationCommands from the admitted plan shape.
 */
export function buildDefaultCapabilityBundleForTask(
	plan: PlanForgePlan,
	task: PlanForgeTask,
): PlanForgeAttachedCapabilityBundle {
	const fsWrite = fsWriteGlobsFromTask(task);
	const allowlist = [
		WORKER_RUN_COMMAND_BINARY,
		...allowlistFromVerificationCommands(task.verificationCommands).filter(
			(c) => c !== WORKER_RUN_COMMAND_BINARY,
		),
	];
	return {
		schemaVersion: PLANFORGE_CAPABILITY_BUNDLE_SCHEMA_VERSION,
		bundleId: `${plan.id}:${task.id}`,
		...(fsWrite.length > 0 ? { fsWrite } : {}),
		tools: {
			write_file: { enabled: fsWrite.length > 0 },
			...(allowlist.length > 0 ? { run_command: { allowlist } } : {}),
		},
	};
}

/**
 * Run-wide capability envelope for an admitted plan (M3-S7): the deterministic
 * (sorted) union of every task's default bundle. `bundleId` is the plan id.
 * This is the auditable "what can this plan's workers touch in aggregate" view;
 * dispatch still attaches the tighter per-task bundle to each UnitPacket.
 */
export function buildDefaultCapabilityBundleForPlan(
	plan: PlanForgePlan,
): PlanForgeAttachedCapabilityBundle {
	const fsWrite = new Set<string>();
	const allowlist = new Set<string>();
	for (const task of plan.tasks) {
		const taskBundle = buildDefaultCapabilityBundleForTask(plan, task);
		for (const glob of taskBundle.fsWrite ?? []) {
			fsWrite.add(glob);
		}
		for (const entry of taskBundle.tools?.run_command?.allowlist ?? []) {
			allowlist.add(entry);
		}
	}
	const fsWriteSorted = [...fsWrite].sort();
	const allowlistSorted = [...allowlist].sort();
	return {
		schemaVersion: PLANFORGE_CAPABILITY_BUNDLE_SCHEMA_VERSION,
		bundleId: plan.id,
		...(fsWriteSorted.length > 0 ? { fsWrite: fsWriteSorted } : {}),
		tools: {
			write_file: { enabled: fsWriteSorted.length > 0 },
			...(allowlistSorted.length > 0
				? { run_command: { allowlist: allowlistSorted } }
				: {}),
		},
	};
}

export function capabilityBundleDigest(
	bundle: PlanForgeAttachedCapabilityBundle,
): string {
	return digest(bundle);
}
