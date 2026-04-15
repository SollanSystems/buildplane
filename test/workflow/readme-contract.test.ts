import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");

function extractTopLevelSection(markdown: string, heading: string) {
	const lines = markdown.split(/\r?\n/);
	let inCodeFence = false;
	let collecting = false;
	const collected: string[] = [];

	for (const line of lines) {
		if (/^```/.test(line)) {
			inCodeFence = !inCodeFence;
		}

		if (!inCodeFence && /^## /.test(line)) {
			if (collecting) {
				break;
			}

			collecting = line === heading;
		}

		if (collecting) {
			collected.push(line);
		}
	}

	return collected.join("\n");
}

const repoDevelopmentSection = extractTopLevelSection(
	readme,
	"## Getting started (repo development)",
);
const builtCliSection = extractTopLevelSection(
	readme,
	"## In-repo built CLI path",
);
const distributionSection = extractTopLevelSection(readme, "## Distribution");

describe("README contract", () => {
	it("documents the full repo development command surface in its own section", () => {
		expect(repoDevelopmentSection).toContain(
			"pnpm buildplane bootstrap doctor --json",
		);
		expect(repoDevelopmentSection).toContain("pnpm buildplane init");
		expect(repoDevelopmentSection).toContain("pnpm buildplane run --packet");
		expect(repoDevelopmentSection).toContain("pnpm buildplane status --json");
		expect(repoDevelopmentSection).toContain(
			"pnpm buildplane inspect <run-id> --json",
		);
		expect(repoDevelopmentSection).toContain("pnpm buildplane memory doctor");
		expect(repoDevelopmentSection).toContain(
			'BUILDPLANE_NATIVE_BIN="$PWD/native/target/debug/buildplane-native" pnpm buildplane memory doctor --json',
		);
		expect(repoDevelopmentSection).not.toContain("npm install -g buildplane");
		expect(repoDevelopmentSection).not.toMatch(/^buildplane\s/m);
		expect(repoDevelopmentSection).not.toContain("node apps/cli/dist/index.js");
	});

	it("documents the full in-repo built CLI command surface in its own section", () => {
		expect(builtCliSection).toContain(
			"node apps/cli/dist/index.js bootstrap doctor --json",
		);
		expect(builtCliSection).toContain("node apps/cli/dist/index.js init");
		expect(builtCliSection).toContain(
			"node apps/cli/dist/index.js run --packet",
		);
		expect(builtCliSection).toContain(
			"node apps/cli/dist/index.js status --json",
		);
		expect(builtCliSection).toContain(
			"node apps/cli/dist/index.js inspect <run-id> --json",
		);
		expect(builtCliSection).toContain(
			"node apps/cli/dist/index.js memory doctor --json",
		);
		expect(builtCliSection).not.toContain("npm install -g buildplane");
		expect(builtCliSection).not.toMatch(/^buildplane\s/m);
		expect(builtCliSection).not.toContain("pnpm buildplane");
		expect(builtCliSection).not.toContain("tsx");
	});

	it("pins the published Distribution section command surface", () => {
		expect(distributionSection).toContain(
			'tmp="$(mktemp)" && curl -fsSL https://raw.githubusercontent.com/SollanSystems/buildplane/main/scripts/published-bootstrap/install.sh -o "$tmp" && bash "$tmp"',
		);
		expect(distributionSection).toContain("npm install -g buildplane");
		expect(distributionSection).toContain("buildplane bootstrap doctor --json");
		expect(distributionSection).toContain("buildplane init");
		expect(distributionSection).toContain(
			"buildplane run --packet <path-to-packet.json>",
		);
		expect(distributionSection).toContain("buildplane status --json");
		expect(distributionSection).toContain("buildplane inspect <run-id> --json");
		expect(distributionSection).toContain(
			"Published/global installs do not yet include a verified `buildplane memory ...` contract.",
		);
		expect(distributionSection).not.toContain(
			"buildplane memory doctor --json",
		);
		expect(distributionSection).not.toContain("pnpm buildplane");
		expect(distributionSection).not.toContain("pnpm install");
		expect(distributionSection).not.toContain("pnpm build");
		expect(distributionSection).not.toContain("tsx");
		expect(distributionSection).not.toContain("node apps/cli/dist/index.js");
	});

	it("pins the clean-tree precondition inside the Distribution section", () => {
		expect(distributionSection).toMatch(/clean git working tree/i);
	});

	it("does not describe published install as future-only anywhere in the README", () => {
		expect(readme).not.toMatch(/not yet available|future-only/i);
	});
});
