// @jsxRuntime automatic
// @jsxImportSource react
import type { InspectorProjection } from "../types";

interface EvidencePaneProps {
	evidencePane: InspectorProjection["evidencePane"];
	missingEvidence: readonly string[];
	missingEvidenceCount: number;
}

/**
 * Renders evidence, decisions, and artifacts from the projection, plus the
 * missing-evidence requirements as MISSING. The pane never fabricates a passing
 * state — required-but-absent evidence is surfaced explicitly.
 */
export function EvidencePane({
	evidencePane,
	missingEvidence,
	missingEvidenceCount,
}: EvidencePaneProps) {
	const { evidence, decisions, artifacts } = evidencePane;

	return (
		<section className="evidence-pane" data-testid="evidence-pane">
			<div className="evidence-group" data-testid="evidence-list">
				<h3>Evidence</h3>
				<ul>
					{evidence.map((item) => (
						<li
							key={item.id}
							className="evidence-item"
							data-testid="evidence-item"
							data-status={item.status}
						>
							<span className="evidence-kind">{item.kind}</span>
							<span className="evidence-status">{item.status}</span>
							{item.message ? (
								<span className="evidence-message">{item.message}</span>
							) : null}
						</li>
					))}
				</ul>
			</div>

			<div className="decision-group" data-testid="decision-list">
				<h3>Decisions</h3>
				<ul>
					{decisions.map((item) => (
						<li
							key={item.id}
							className="decision-item"
							data-testid="decision-item"
							data-outcome={item.outcome}
						>
							<span className="decision-kind">{item.kind}</span>
							<span className="decision-outcome">{item.outcome}</span>
							{item.reasons.length > 0 ? (
								<ul className="decision-reasons">
									{item.reasons.map((reason) => (
										<li key={reason}>{reason}</li>
									))}
								</ul>
							) : null}
						</li>
					))}
				</ul>
			</div>

			<div className="artifact-group" data-testid="artifact-list">
				<h3>Artifacts</h3>
				<ul>
					{artifacts.map((item) => (
						<li
							key={item.id}
							className="artifact-item"
							data-testid="artifact-item"
						>
							<span className="artifact-type">{item.type}</span>
							<span className="artifact-location">{item.location}</span>
						</li>
					))}
				</ul>
			</div>

			<div className="missing-evidence-group" data-testid="missing-evidence">
				<h3>Missing evidence ({missingEvidenceCount})</h3>
				{missingEvidence.length > 0 ? (
					<ul>
						{missingEvidence.map((requirement) => (
							<li
								key={requirement}
								className="missing-evidence-item"
								data-testid="missing-evidence-item"
							>
								{requirement}
							</li>
						))}
					</ul>
				) : (
					<p data-testid="missing-evidence-empty">none</p>
				)}
			</div>
		</section>
	);
}
