// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { OutcomeStrip } from "../src/panels/OutcomeStrip";
import { makeBlockedProjection, makeProjection } from "./fixtures";

describe("OutcomeStrip", () => {
	afterEach(() => {
		cleanup();
	});

	it("renders the verdict and counts from the projection", () => {
		const projection = makeProjection();

		render(
			createElement(OutcomeStrip, {
				outcomeStrip: projection.outcomeStrip,
			}),
		);

		expect(screen.getByTestId("outcome-verdict").textContent).toBe("PASSED");
		expect(screen.getByTestId("outcome-event-count").textContent).toBe("3");
		expect(screen.getByTestId("outcome-evidence-count").textContent).toBe("2");
		expect(screen.getByTestId("outcome-decision-count").textContent).toBe("1");
		expect(screen.getByTestId("outcome-artifact-count").textContent).toBe("1");
		expect(
			screen.getByTestId("outcome-missing-evidence-count").textContent,
		).toBe("0");
	});

	it("reflects the projection's BLOCKED verdict verbatim and shows the failure", () => {
		const projection = makeBlockedProjection();
		// guard: the fixture is a genuine blocked case (missing evidence present),
		// and its runStatus is NOT "blocked" — so a verbatim render is the only
		// way the strip can read "BLOCKED".
		expect(projection.missingEvidence.length).toBeGreaterThan(0);
		expect(projection.outcomeStrip.runStatus).toBe("suspended");

		render(
			createElement(OutcomeStrip, {
				outcomeStrip: projection.outcomeStrip,
			}),
		);

		expect(screen.getByTestId("outcome-verdict").textContent).toBe("BLOCKED");
		expect(screen.getByTestId("outcome-failure-message").textContent).toContain(
			"missing required evidence",
		);
	});
});
