// @jsxRuntime automatic
// @jsxImportSource react
import type { InspectorProjection } from "../types";

interface EventTimelineProps {
	events: InspectorProjection["eventTimeline"];
}

/**
 * Renders the event timeline — the storage projection (Tier-1) view. Events are
 * rendered in the exact order given, with no synthesis, reordering, or kind
 * filtering: each row is one projection entry.
 */
export function EventTimeline({ events }: EventTimelineProps) {
	return (
		<section className="event-timeline" data-testid="event-timeline">
			<header className="panel-header">
				<h2>Event timeline</h2>
				<p className="panel-subtitle">storage projection (Tier-1)</p>
			</header>
			<ol className="event-timeline-list">
				{events.map((event) => (
					<li
						key={event.id}
						className="event-row"
						data-testid="event-row"
						data-event-kind={event.kind}
					>
						<span className="event-kind">{event.kind}</span>
						<time className="event-occurred-at">{event.occurredAt}</time>
						<span className="event-summary">{event.summary}</span>
						{event.metadata ? (
							<dl className="event-metadata" data-testid="event-metadata">
								{Object.entries(event.metadata).map(([key, value]) => (
									<div key={key} className="event-metadata-entry">
										<dt>{key}</dt>
										<dd>{String(value)}</dd>
									</div>
								))}
							</dl>
						) : null}
					</li>
				))}
			</ol>
		</section>
	);
}
