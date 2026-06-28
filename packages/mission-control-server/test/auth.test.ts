import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fileBearerTokenSource,
	isAuthorizedWrite,
} from "@buildplane/mission-control-server";
import { afterEach, describe, expect, it } from "vitest";

const cleanup: string[] = [];

afterEach(() => {
	while (cleanup.length > 0) {
		const path = cleanup.pop();
		if (path) {
			rmSync(path, { force: true, recursive: true });
		}
	}
});

describe("isAuthorizedWrite", () => {
	const tokenSource = { read: () => "expected-token" };

	it("accepts a matching bearer token", () => {
		expect(isAuthorizedWrite("Bearer expected-token", tokenSource)).toBe(true);
	});

	it("rejects a mismatched token", () => {
		expect(isAuthorizedWrite("Bearer wrong", tokenSource)).toBe(false);
	});

	it("rejects a missing authorization header", () => {
		expect(isAuthorizedWrite(undefined, tokenSource)).toBe(false);
	});

	it("fails closed when no token is configured", () => {
		expect(
			isAuthorizedWrite("Bearer anything", { read: () => undefined }),
		).toBe(false);
	});
});

describe("fileBearerTokenSource", () => {
	it("reads and trims the token file", () => {
		const dir = mkdtempSync(join(tmpdir(), "mc-token-"));
		cleanup.push(dir);
		const tokenPath = join(dir, "web-token");
		writeFileSync(tokenPath, "  file-token\n");

		expect(fileBearerTokenSource(tokenPath).read()).toBe("file-token");
	});

	it("returns undefined when the token file is absent", () => {
		expect(
			fileBearerTokenSource(join(tmpdir(), "mc-token-missing-xyz")).read(),
		).toBeUndefined();
	});
});
