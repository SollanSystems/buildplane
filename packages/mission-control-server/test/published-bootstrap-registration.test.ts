import { describe, expect, it } from "vitest";
import {
	INTERNAL_PACKAGE_ENTRYPOINTS,
	OPTIONAL_INTERNAL_PACKAGES,
} from "../../../scripts/published-bootstrap/stage-package.mjs";

const PACKAGE_NAME = "@buildplane/mission-control-server";

describe("mission-control-server published-bootstrap registration", () => {
	it("is registered as an optional internal package", () => {
		expect(OPTIONAL_INTERNAL_PACKAGES).toContain(PACKAGE_NAME);
	});

	it("is not a vendored runtime entrypoint (its dist is never required)", () => {
		expect(Object.keys(INTERNAL_PACKAGE_ENTRYPOINTS)).not.toContain(
			PACKAGE_NAME,
		);
	});
});
