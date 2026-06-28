// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { EvidencePane } from "../src/panels/EvidencePane";
import { makeBlockedProjection, makeProjection } from "./fixtures";

describe("EvidencePane", () => {
	afterEach(() => {
		cleanup();
	});

	it("renders evidence, decisions, and artifacts from the projection", () => {
		const projection = makeProjection();

		render(
			createElement(EvidencePane, {
				evidencePane: projection.evidencePane,
				missingEvidence: projection.missingEvidence,
				missingEvidenceCount: projection.outcomeStrip.missingEvidenceCount,
			}),
		);

		expect(screen.getAllByTestId("evidence-item")).toHaveLength(2);
		expect(screen.getAllByTestId("decision-item")).toHaveLength(1);
		expect(screen.getAllByTestId("artifact-item")).toHaveLength(1);
		// a decision's reasons are surfaced
		expect(screen.getByTestId("decision-list").textContent).toContain(
			"diff in scope",
		);
	});

	it("renders missing evidence as missing and never invents passing state", () => {
		const projection = makeBlockedProjection();

		render(
			createElement(EvidencePane, {
				evidencePane: projection.evidencePane,
				missingEvidence: projection.missingEvidence,
				missingEvidenceCount: projection.outcomeStrip.missingEvidenceCount,
			}),
		);

		const missing = screen.getAllByTestId("missing-evidence-item");
		expect(missing.map((node) => node.textContent)).toEqual(["ci", "lint"]);

		// blocked fixture carries no evidence — nothing is fabricated as passing
		expect(screen.queryByTestId("evidence-item")).toBeNull();
	});
});
