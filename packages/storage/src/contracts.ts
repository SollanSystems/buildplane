/**
 * A persisted record of a produced output artifact.
 *
 * Storage owns the durable representation; the kernel
 * defines what artifacts are expected, the runtime produces
 * them, and storage records their existence and location.
 */
export interface ArtifactRecord {
  /** Unique identifier for this artifact record. */
  readonly id: string;

  /** The run that produced this artifact. */
  readonly runId: string;

  /** Artifact classification (e.g. "summary", "diff", "test-report"). */
  readonly type: string;

  /** Path or URI where the artifact content is stored. */
  readonly location: string;
}

/**
 * A persisted record of an objective signal gathered during execution.
 *
 * Evidence is captured by the runtime and evaluated by policy.
 * Storage owns the durable record of what was observed.
 */
export interface EvidenceRecord {
  /** Unique identifier for this evidence record. */
  readonly id: string;

  /** The run that produced this evidence. */
  readonly runId: string;

  /** Classification of the evidence signal (e.g. "command-exit", "test-result"). */
  readonly kind: string;

  /** Evaluated status of this evidence (e.g. "pass", "fail", "inconclusive"). */
  readonly status: string;
}

/**
 * A persisted record of a judgment or routing choice made during execution.
 *
 * Decisions capture why the system chose a particular path —
 * advancement, retry, escalation, or cancellation. Policy
 * produces them; storage preserves them for audit and replay.
 */
export interface DecisionRecord {
  /** Unique identifier for this decision record. */
  readonly id: string;

  /** The run this decision pertains to. */
  readonly runId: string;

  /** Classification of the decision (e.g. "advance-unit", "retry", "escalate"). */
  readonly kind: string;

  /** The resolved outcome (e.g. "approved", "rejected", "deferred"). */
  readonly outcome: string;
}
