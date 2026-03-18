/**
 * A bounded piece of work dispatched by the execution kernel.
 *
 * Units are the atomic scheduling primitive in Buildplane.
 * The kernel owns their lifecycle; runtime executes them;
 * policy gates their advancement.
 */
export interface Unit {
	/** Unique identifier for this unit. */
	readonly id: string;

	/** The kind of work this unit represents. */
	readonly kind: string;

	/** The scope boundary for execution (e.g. "task", "step"). */
	readonly scope: string;

	/** References to inputs this unit depends on. */
	readonly inputRefs: readonly string[];

	/** Descriptions of outputs this unit is expected to produce. */
	readonly expectedOutputs: readonly string[];

	/** The verification contract that must be satisfied for completion. */
	readonly verificationContract: string;

	/** The policy profile governing this unit's execution. */
	readonly policyProfile: string;
}

/**
 * One end-to-end execution attempt of a Unit under a policy profile.
 *
 * Runs are append-only entries in the event log. The kernel
 * creates them; runtime populates evidence; policy evaluates
 * whether the run's outcome is acceptable.
 */
export interface Run {
	/** Unique identifier for this run. */
	readonly id: string;

	/** The unit this run is executing. */
	readonly unitId: string;

	/** Current lifecycle status of the run. */
	readonly status: "pending" | "running" | "passed" | "failed" | "cancelled";
}
