// @jsxRuntime automatic
// @jsxImportSource react
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { fetchInspector } from "./api";
import { EventTimeline } from "./panels/EventTimeline";
import { EvidencePane } from "./panels/EvidencePane";
import { OutcomeStrip } from "./panels/OutcomeStrip";
import { RunList } from "./RunList";
import type { InspectorProjection } from "./types";

/** Read an optional `?run=<id>` deep-link out of the location hash. */
function runIdFromHash(): string | undefined {
	const queryIndex = window.location.hash.indexOf("?");
	if (queryIndex === -1) {
		return undefined;
	}
	const params = new URLSearchParams(
		window.location.hash.slice(queryIndex + 1),
	);
	return params.get("run") ?? undefined;
}

/**
 * Run Inspector container: a run list plus the three projection panels for the
 * selected run. The container owns the fetch; the panels are prop-driven so they
 * stay testable without mocking.
 */
export function Inspector() {
	const [selectedRunId, setSelectedRunId] = useState<string | undefined>(
		runIdFromHash,
	);
	const [projection, setProjection] = useState<InspectorProjection | null>(
		null,
	);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!selectedRunId) {
			setProjection(null);
			setError(null);
			setLoading(false);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setError(null);
		fetchInspector(selectedRunId)
			.then((result) => {
				if (!cancelled) {
					setProjection(result);
					setLoading(false);
				}
			})
			.catch((cause: unknown) => {
				if (!cancelled) {
					setProjection(null);
					setError(
						cause instanceof Error ? cause.message : "failed to load inspector",
					);
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [selectedRunId]);

	const handleSelect = useCallback((runId: string) => {
		setSelectedRunId(runId);
	}, []);

	let detail: ReactNode;
	if (!selectedRunId) {
		detail = <p data-testid="inspector-empty">Select a run to inspect.</p>;
	} else if (error) {
		detail = (
			<p className="inspector-error" data-testid="inspector-error">
				{error}
			</p>
		);
	} else if (loading || !projection) {
		detail = (
			<p className="inspector-loading" data-testid="inspector-loading">
				loading…
			</p>
		);
	} else {
		detail = (
			<>
				<OutcomeStrip outcomeStrip={projection.outcomeStrip} />
				<EventTimeline events={projection.eventTimeline} />
				<EvidencePane
					evidencePane={projection.evidencePane}
					missingEvidence={projection.missingEvidence}
					missingEvidenceCount={projection.missingEvidence.length}
				/>
			</>
		);
	}

	return (
		<section className="inspector" data-testid="inspector-view">
			<RunList selectedRunId={selectedRunId} onSelect={handleSelect} />
			<div className="inspector-detail" data-testid="inspector-detail">
				{detail}
			</div>
		</section>
	);
}
