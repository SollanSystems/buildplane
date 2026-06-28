// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App";

describe("App", () => {
	beforeEach(() => {
		window.location.hash = "";
	});

	afterEach(() => {
		cleanup();
	});

	it("renders the nav and the inspector stub by default", () => {
		render(createElement(App));

		expect(screen.getByTestId("nav-runs")).toBeTruthy();
		expect(screen.getByTestId("nav-inbox")).toBeTruthy();
		expect(screen.getByTestId("inspector-view")).toBeTruthy();
		expect(screen.queryByTestId("inbox-view")).toBeNull();
	});

	it("navigates to the inbox stub when the Inbox nav is clicked", () => {
		render(createElement(App));

		fireEvent.click(screen.getByTestId("nav-inbox"));

		expect(screen.getByTestId("inbox-view")).toBeTruthy();
		expect(screen.queryByTestId("inspector-view")).toBeNull();
	});
});
