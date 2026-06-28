// @jsxRuntime automatic
// @jsxImportSource react
import type { InspectorProjection } from "../types";

interface OutcomeStripProps {
	outcomeStrip: InspectorProjection["outcomeStrip"];
}

/**
 * Renders the outcome strip. The verdict is read VERBATIM from the projection
 * (`outcomeStrip.verdict`) — the UI never computes or re-derives a verdict; that
 * lives in the kernel's `createInspectorProjection`.
 */
export function OutcomeStrip({ outcomeStrip }: OutcomeStripProps) {
	const {
		verdict,
		runStatus,
		terminalEventKind,
		eventCount,
		evidenceCount,
		decisionCount,
		artifactCount,
		missingEvidenceCount,
		failure,
	} = outcomeStrip;

	return (
		<section className="outcome-strip" data-testid="outcome-strip">
			<span
				className="outcome-verdict"
				data-testid="outcome-verdict"
				data-verdict={verdict}
			>
				{verdict}
			</span>
			<dl className="outcome-counts">
				<div className="outcome-count">
					<dt>Status</dt>
					<dd data-testid="outcome-run-status">{runStatus}</dd>
				</div>
				{terminalEventKind ? (
					<div className="outcome-count">
						<dt>Terminal event</dt>
						<dd data-testid="outcome-terminal-event">{terminalEventKind}</dd>
					</div>
				) : null}
				<div className="outcome-count">
					<dt>Events</dt>
					<dd data-testid="outcome-event-count">{eventCount}</dd>
				</div>
				<div className="outcome-count">
					<dt>Evidence</dt>
					<dd data-testid="outcome-evidence-count">{evidenceCount}</dd>
				</div>
				<div className="outcome-count">
					<dt>Decisions</dt>
					<dd data-testid="outcome-decision-count">{decisionCount}</dd>
				</div>
				<div className="outcome-count">
					<dt>Artifacts</dt>
					<dd data-testid="outcome-artifact-count">{artifactCount}</dd>
				</div>
				<div className="outcome-count">
					<dt>Missing evidence</dt>
					<dd data-testid="outcome-missing-evidence-count">
						{missingEvidenceCount}
					</dd>
				</div>
			</dl>
			{failure ? (
				<div className="outcome-failure" data-testid="outcome-failure">
					{failure.kind ? (
						<span
							className="outcome-failure-kind"
							data-testid="outcome-failure-kind"
						>
							{failure.kind}
						</span>
					) : null}
					{failure.message ? (
						<span
							className="outcome-failure-message"
							data-testid="outcome-failure-message"
						>
							{failure.message}
						</span>
					) : null}
				</div>
			) : null}
		</section>
	);
}
