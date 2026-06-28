// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProjection } from "./fixtures";

const { fetchRuns, fetchInspector } = vi.hoisted(() => ({
	fetchRuns: vi.fn(),
	fetchInspector: vi.fn(),
}));

vi.mock("../src/api", () => ({ fetchRuns, fetchInspector }));

import { Inspector } from "../src/Inspector";

describe("Inspector", () => {
	beforeEach(() => {
		window.location.hash = "";
		fetchRuns.mockReset();
		fetchInspector.mockReset();
	});

	afterEach(() => {
		cleanup();
	});

	it("loads and renders the projection panels for the selected run", async () => {
		fetchRuns.mockResolvedValue({
			runs: [{ id: "run-1", unitId: "u1", status: "running" }],
		});
		fetchInspector.mockResolvedValue(makeProjection());

		render(createElement(Inspector));

		const item = await screen.findByTestId("run-list-item");
		fireEvent.click(item);

		expect((await screen.findByTestId("outcome-verdict")).textContent).toBe(
			"PASSED",
		);
		expect(screen.getByTestId("event-timeline")).toBeTruthy();
		expect(screen.getByTestId("evidence-pane")).toBeTruthy();
		expect(fetchInspector).toHaveBeenCalledWith("run-1");
	});

	it("preselects the run named by a ?run= hash deep-link", async () => {
		window.location.hash = "#/runs?run=run-1";
		fetchRuns.mockResolvedValue({ runs: [] });
		fetchInspector.mockResolvedValue(makeProjection({ runId: "run-1" }));

		render(createElement(Inspector));

		expect((await screen.findByTestId("outcome-verdict")).textContent).toBe(
			"PASSED",
		);
		expect(fetchInspector).toHaveBeenCalledWith("run-1");
	});
});
