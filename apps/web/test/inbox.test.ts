// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../src/api";
import { Inbox } from "../src/Inbox";
import type { PendingOperatorDecision } from "../src/types";

vi.mock("../src/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/api")>();
	return {
		...actual,
		fetchInbox: vi.fn(),
		postDecision: vi.fn(),
		setAuthToken: vi.fn(),
	};
});

const resumeItem: PendingOperatorDecision = {
	runId: "run-resume-1",
	subject: "resume",
	since: "2026-06-20T10:00:00.000Z",
};

const mergeItem: PendingOperatorDecision = {
	runId: "run-merge-1",
	subject: "merge",
	since: "2026-06-20T11:00:00.000Z",
};

describe("Inbox", () => {
	beforeEach(() => {
		vi.mocked(api.fetchInbox).mockReset();
		vi.mocked(api.postDecision).mockReset();
		vi.mocked(api.setAuthToken).mockReset();
	});

	afterEach(() => {
		cleanup();
	});

	it("renders both resume and merge pending flows with a subject-split badge", async () => {
		vi.mocked(api.fetchInbox).mockResolvedValue([resumeItem, mergeItem]);

		render(createElement(Inbox));

		expect(
			await screen.findByTestId(`inbox-item-${resumeItem.runId}`),
		).toBeTruthy();
		expect(screen.getByTestId(`inbox-item-${mergeItem.runId}`)).toBeTruthy();

		expect(screen.getByTestId("badge-total").textContent).toContain("2");
		expect(screen.getByTestId("badge-resume").textContent).toContain("1");
		expect(screen.getByTestId("badge-merge").textContent).toContain("1");

		const link = screen.getByTestId(
			`inspector-link-${mergeItem.runId}`,
		) as HTMLAnchorElement;
		expect(link.getAttribute("href")).toBe(`#/runs?run=${mergeItem.runId}`);
	});

	it("approving a merge item posts an approved/merge decision exactly once and removes it", async () => {
		vi.mocked(api.fetchInbox).mockResolvedValue([resumeItem, mergeItem]);
		vi.mocked(api.postDecision).mockResolvedValue({
			ok: true,
			runId: mergeItem.runId,
		});

		render(createElement(Inbox));

		fireEvent.click(await screen.findByTestId(`approve-${mergeItem.runId}`));
		fireEvent.click(await screen.findByTestId("decision-confirm"));

		await waitFor(() => {
			expect(api.postDecision).toHaveBeenCalledTimes(1);
		});
		expect(api.postDecision).toHaveBeenCalledWith(mergeItem.runId, {
			decision: "approved",
			subject: "merge",
		});

		await waitFor(() => {
			expect(screen.queryByTestId(`inbox-item-${mergeItem.runId}`)).toBeNull();
		});
	});

	it("rejecting a resume item posts a rejected/resume decision exactly once", async () => {
		vi.mocked(api.fetchInbox).mockResolvedValue([resumeItem, mergeItem]);
		vi.mocked(api.postDecision).mockResolvedValue({
			ok: true,
			runId: resumeItem.runId,
		});

		render(createElement(Inbox));

		fireEvent.click(await screen.findByTestId(`reject-${resumeItem.runId}`));
		fireEvent.click(await screen.findByTestId("decision-confirm"));

		await waitFor(() => {
			expect(api.postDecision).toHaveBeenCalledTimes(1);
		});
		expect(api.postDecision).toHaveBeenCalledWith(resumeItem.runId, {
			decision: "rejected",
			subject: "resume",
		});

		await waitFor(() => {
			expect(screen.queryByTestId(`inbox-item-${resumeItem.runId}`)).toBeNull();
		});
	});

	it("surfaces an explicit conflict error and keeps the item (no silent success)", async () => {
		vi.mocked(api.fetchInbox).mockResolvedValue([mergeItem]);
		vi.mocked(api.postDecision).mockRejectedValue(
			new api.DecisionConflictError("run is already merged"),
		);

		render(createElement(Inbox));

		fireEvent.click(await screen.findByTestId(`approve-${mergeItem.runId}`));
		fireEvent.click(await screen.findByTestId("decision-confirm"));

		const error = await screen.findByRole("alert");
		expect(error.textContent).toContain("run is already merged");

		expect(screen.getByTestId(`inbox-item-${mergeItem.runId}`)).toBeTruthy();
	});

	it("prompts for an auth token when the decision is unauthorized", async () => {
		vi.mocked(api.fetchInbox).mockResolvedValue([mergeItem]);
		vi.mocked(api.postDecision).mockRejectedValue(new api.UnauthorizedError());

		render(createElement(Inbox));

		fireEvent.click(await screen.findByTestId(`approve-${mergeItem.runId}`));
		fireEvent.click(await screen.findByTestId("decision-confirm"));

		expect(await screen.findByTestId("decision-auth-prompt")).toBeTruthy();
		expect(screen.getByTestId("decision-token-input")).toBeTruthy();

		fireEvent.change(screen.getByTestId("decision-token-input"), {
			target: { value: "secret-token" },
		});
		fireEvent.click(screen.getByTestId("decision-token-submit"));

		await waitFor(() => {
			expect(api.postDecision).toHaveBeenCalledTimes(2);
		});
		expect(api.setAuthToken).toHaveBeenCalledWith("secret-token");
	});
});
