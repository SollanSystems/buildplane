// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchRuns, fetchInspector } = vi.hoisted(() => ({
	fetchRuns: vi.fn(),
	fetchInspector: vi.fn(),
}));

vi.mock("../src/api", () => ({ fetchRuns, fetchInspector }));

import { RunList } from "../src/RunList";

describe("RunList", () => {
	beforeEach(() => {
		fetchRuns.mockReset();
		fetchInspector.mockReset();
	});

	afterEach(() => {
		cleanup();
	});

	it("renders fetched runs and calls onSelect when a run is clicked", async () => {
		fetchRuns.mockResolvedValue({
			runs: [
				{ id: "run-a", unitId: "u-a", status: "running" },
				{ id: "run-b", unitId: "u-b", status: "running" },
			],
		});
		const onSelect = vi.fn();

		render(createElement(RunList, { onSelect }));

		const items = await screen.findAllByTestId("run-list-item");
		expect(items).toHaveLength(2);
		expect(items[0].textContent).toContain("run-a");

		fireEvent.click(items[0]);
		expect(onSelect).toHaveBeenCalledWith("run-a");
	});

	it("refetches runs for a newly selected status", async () => {
		fetchRuns.mockResolvedValue({ runs: [] });

		render(createElement(RunList, { onSelect: vi.fn() }));

		await screen.findByTestId("run-list-empty");
		expect(fetchRuns).toHaveBeenCalledWith("running");

		fireEvent.change(screen.getByTestId("run-list-status"), {
			target: { value: "suspended" },
		});

		expect(fetchRuns).toHaveBeenCalledWith("suspended");
	});
});
