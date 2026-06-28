// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { EventTimeline } from "../src/panels/EventTimeline";
import { makeProjection } from "./fixtures";

describe("EventTimeline", () => {
	afterEach(() => {
		cleanup();
	});

	it("renders exactly the fixture events, in order, with nothing synthesized", () => {
		const projection = makeProjection();

		render(
			createElement(EventTimeline, {
				events: projection.eventTimeline,
			}),
		);

		const rows = screen.getAllByTestId("event-row");
		expect(rows).toHaveLength(projection.eventTimeline.length);

		const renderedKinds = rows.map((row) =>
			row.getAttribute("data-event-kind"),
		);
		expect(renderedKinds).toEqual(projection.eventTimeline.map((e) => e.kind));

		// the rendered summaries match the projection's, in order
		for (const [index, event] of projection.eventTimeline.entries()) {
			expect(rows[index].textContent).toContain(event.summary);
			expect(rows[index].textContent).toContain(event.occurredAt);
		}
	});

	it("labels the pane as the storage projection (Tier-1) view", () => {
		const projection = makeProjection();

		render(
			createElement(EventTimeline, {
				events: projection.eventTimeline,
			}),
		);

		const text = screen
			.getByTestId("event-timeline")
			.textContent?.toLowerCase();
		expect(text).toContain("storage projection");
		expect(text).toContain("tier-1");
	});
});
