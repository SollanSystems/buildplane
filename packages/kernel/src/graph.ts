import type { UnitPacket } from "./run-loop.js";

/**
 * A single node in a unit execution graph.
 *
 * Extends `UnitPacket` with an optional dependency list. The `dependsOn`
 * field references `unit.id` values of other nodes in the same graph that
 * must reach `"passed"` status before this node is eligible to dispatch.
 */
export interface UnitGraphNode extends UnitPacket {
	/**
	 * IDs of nodes (via `unit.id`) that must pass before this node is ready.
	 * Omit or leave empty for nodes with no dependencies.
	 */
	readonly dependsOn?: readonly string[];
}

/**
 * A directed acyclic graph of units to execute.
 *
 * Nodes are executed in dependency order; independent nodes may execute
 * concurrently up to `maxConcurrent`. Failure of a node causes all
 * transitive dependents to be cancelled (fail-fast).
 */
export interface UnitGraph {
	readonly nodes: readonly UnitGraphNode[];
	/** Maximum number of units to run concurrently. Default: 2. */
	readonly maxConcurrent?: number;
}

/** Per-node execution outcome in a completed graph run. */
export interface GraphNodeOutcome {
	readonly unitId: string;
	/** `"cancelled"` means the node was never dispatched due to a failed dependency. */
	readonly status: "passed" | "failed" | "cancelled";
	/** Set for nodes that were dispatched (not cancelled). */
	readonly runId?: string;
	/** Decision reasons from policy evaluation, if available. */
	readonly decisionReasons?: readonly string[];
}

/** Aggregate result of a completed graph run. */
export interface GraphResult {
	readonly outcome: "passed" | "failed";
	readonly nodes: readonly GraphNodeOutcome[];
}

/** Internal status tracked per node inside the scheduler. */
export type NodeStatus =
	| "pending"
	| "running"
	| "passed"
	| "failed"
	| "cancelled";

export interface GraphSchedulerOptions {
	readonly maxConcurrent: number;
}

/**
 * Pure scheduler for a `UnitGraph`. Tracks node states and determines
 * which nodes are eligible to dispatch next.
 *
 * No I/O — callers drive the state machine by calling `markRunning`,
 * `markPassed`, `markFailed` as dispatch and completion events arrive.
 */
export interface GraphScheduler {
	/**
	 * Returns unit IDs that are ready to dispatch now:
	 * - status is `"pending"`
	 * - all `dependsOn` are `"passed"`
	 * - running count is below `maxConcurrent`
	 */
	readyUnits(): readonly string[];

	/** Mark a unit as dispatched. Requires current status `"pending"`. */
	markRunning(unitId: string): void;

	/** Mark a unit as completed successfully. Requires current status `"running"`. */
	markPassed(unitId: string): void;

	/**
	 * Mark a unit as failed. Requires current status `"running"`.
	 * Transitively cancels all dependents of this unit.
	 */
	markFailed(unitId: string): void;

	/** True when no units remain in `"pending"` or `"running"` state. */
	isDone(): boolean;

	/** Overall graph outcome. Only valid when `isDone()` is true. */
	outcome(): "passed" | "failed" | "running";

	/** Unit IDs that were cancelled due to a failed dependency. */
	cancelledUnits(): readonly string[];

	/** Build the final `GraphResult`. Only meaningful when `isDone()` is true. */
	toResult(
		runIdMap: ReadonlyMap<string, string>,
		decisionReasonsMap?: ReadonlyMap<string, readonly string[]>,
	): GraphResult;
}

/**
 * Create a new `GraphScheduler` for the given graph.
 *
 * @param graph The unit graph to schedule.
 * @param options Scheduler options (defaults: maxConcurrent=2).
 */
export function createGraphScheduler(
	graph: UnitGraph,
	options?: Partial<GraphSchedulerOptions>,
): GraphScheduler {
	const maxConcurrent = options?.maxConcurrent ?? graph.maxConcurrent ?? 2;

	// Validate: all dependsOn references must resolve to existing unit IDs
	const nodeIds = new Set(graph.nodes.map((n) => n.unit.id));
	for (const node of graph.nodes) {
		for (const dep of node.dependsOn ?? []) {
			if (!nodeIds.has(dep)) {
				throw new Error(
					`UnitGraph: node '${node.unit.id}' depends on unknown unit '${dep}'`,
				);
			}
		}
	}

	// Detect dependency cycles using DFS
	const visited = new Set<string>();
	const visiting = new Set<string>();

	function detectCycle(unitId: string, path: string[]): void {
		if (visiting.has(unitId)) {
			const cycleStart = path.indexOf(unitId);
			const cyclePath = [...path.slice(cycleStart), unitId];
			throw new Error(`Dependency cycle detected: ${cyclePath.join(" -> ")}`);
		}
		if (visited.has(unitId)) return;

		visiting.add(unitId);
		const node = graph.nodes.find(n => n.unit.id === unitId);
		for (const dep of node?.dependsOn ?? []) {
			detectCycle(dep, [...path, unitId]);
		}
		visiting.delete(unitId);
		visited.add(unitId);
	}

	for (const node of graph.nodes) {
		if (!visited.has(node.unit.id)) {
			detectCycle(node.unit.id, []);
		}
	}

	// State map: unitId → NodeStatus
	const state = new Map<string, NodeStatus>(
		graph.nodes.map((n) => [n.unit.id, "pending"]),
	);

	// Reverse dependency map: unitId → set of unit IDs that depend on it
	const dependents = new Map<string, Set<string>>();
	for (const node of graph.nodes) {
		for (const dep of node.dependsOn ?? []) {
			let set = dependents.get(dep);
			if (!set) {
				set = new Set();
				dependents.set(dep, set);
			}
			set.add(node.unit.id);
		}
	}

	// Dependency map: unitId → set of unit IDs it depends on
	const dependencies = new Map<string, readonly string[]>(
		graph.nodes.map((n) => [n.unit.id, n.dependsOn ?? []]),
	);

	function runningCount(): number {
		let count = 0;
		for (const status of state.values()) {
			if (status === "running") count++;
		}
		return count;
	}

	function cancelTransitiveDependents(unitId: string): void {
		const direct = dependents.get(unitId);
		if (!direct) return;
		for (const depId of direct) {
			const current = state.get(depId);
			if (current === "pending" || current === "running") {
				state.set(depId, "cancelled");
				cancelTransitiveDependents(depId);
			}
		}
	}

	return {
		readyUnits(): readonly string[] {
			if (runningCount() >= maxConcurrent) return [];
			const slots = maxConcurrent - runningCount();
			const ready: string[] = [];
			for (const node of graph.nodes) {
				if (ready.length >= slots) break;
				const id = node.unit.id;
				if (state.get(id) !== "pending") continue;
				const deps = dependencies.get(id) ?? [];
				const depsAllPassed = deps.every((d) => state.get(d) === "passed");
				if (depsAllPassed) ready.push(id);
			}
			return ready;
		},

		markRunning(unitId: string): void {
			if (state.get(unitId) !== "pending") {
				throw new Error(
					`markRunning: unit '${unitId}' is not pending (status: '${state.get(unitId)}')`,
				);
			}
			state.set(unitId, "running");
		},

		markPassed(unitId: string): void {
			if (state.get(unitId) !== "running") {
				throw new Error(
					`markPassed: unit '${unitId}' is not running (status: '${state.get(unitId)}')`,
				);
			}
			state.set(unitId, "passed");
		},

		markFailed(unitId: string): void {
			if (state.get(unitId) !== "running") {
				throw new Error(
					`markFailed: unit '${unitId}' is not running (status: '${state.get(unitId)}')`,
				);
			}
			state.set(unitId, "failed");
			cancelTransitiveDependents(unitId);
		},

		isDone(): boolean {
			for (const status of state.values()) {
				if (status === "pending" || status === "running") return false;
			}
			return true;
		},

		outcome(): "passed" | "failed" | "running" {
			for (const status of state.values()) {
				if (status === "pending" || status === "running") return "running";
			}
			for (const status of state.values()) {
				if (status === "failed") return "failed";
			}
			return "passed";
		},

		cancelledUnits(): readonly string[] {
			return [...state.entries()]
				.filter(([, s]) => s === "cancelled")
				.map(([id]) => id);
		},

		toResult(
			runIdMap: ReadonlyMap<string, string>,
			decisionReasonsMap?: ReadonlyMap<string, readonly string[]>,
		): GraphResult {
			const nodes: GraphNodeOutcome[] = graph.nodes.map((n) => {
				const id = n.unit.id;
				const status = state.get(id)!;
				if (status === "pending" || status === "running") {
					throw new Error(
						`toResult: graph is not done — unit '${id}' is still '${status}'`,
					);
				}
				return {
					unitId: id,
					status: status as "passed" | "failed" | "cancelled",
					runId: runIdMap.get(id),
					decisionReasons: decisionReasonsMap?.get(id),
				};
			});
			return {
				outcome: nodes.some((n) => n.status === "failed") ? "failed" : "passed",
				nodes,
			};
		},
	};
}
