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
const highTrustLoopSection = extractTopLevelSection(
	readme,
	"## High-trust operator loop",
);

describe("README contract", () => {
	it("documents the full repo development command surface in its own section", () => {
		expect(repoDevelopmentSection).toContain(
			"pnpm buildplane bootstrap doctor --json",
		);
		expect(repoDevelopmentSection).toContain(
			"pnpm buildplane bootstrap doctor --capabilities --json",
		);
		expect(repoDevelopmentSection).toContain("pnpm buildplane init");
		expect(repoDevelopmentSection).toContain("pnpm buildplane run --packet");
		expect(repoDevelopmentSection).toContain("pnpm buildplane status --json");
		expect(repoDevelopmentSection).toContain(
			"pnpm buildplane inspect <run-id> --json",
		);
		expect(repoDevelopmentSection).toContain(
			"pnpm buildplane replay <run-id> --json",
		);
		expect(repoDevelopmentSection).toContain(
			"pnpm buildplane fork <run-id> --at <event-id> --packet <fixed-packet.json>",
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
		expect(builtCliSection).toContain(
			"node apps/cli/dist/index.js bootstrap doctor --capabilities --json",
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
			"node apps/cli/dist/index.js replay <run-id> --json",
		);
		expect(builtCliSection).toContain(
			"node apps/cli/dist/index.js fork <run-id> --at <event-id> --packet <fixed-packet.json>",
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
		expect(distributionSection).toContain(
			"buildplane bootstrap doctor --capabilities --json",
		);
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

	it("links to the model benchmark summary doc", () => {
		expect(readme).toContain("docs/benchmarks/model-codex.md");
		expect(readme).toContain("model-codex");
		expect(readme).toContain("reviewer-rescue");
		expect(readme).toContain("raw one-shot path");
		expect(readme).toContain("implement-then-review");
	});

	it("does not describe published install as future-only anywhere in the README", () => {
		expect(readme).not.toMatch(/not yet available|future-only/i);
	});

	it("does not leave the local run loop contradicted by stale future-only maturity language", () => {
		expect(readme).not.toContain(
			"Worktree isolation, replay, richer policy, and model-backed execution come later.",
		);
		expect(readme).toContain(
			"Broader repo-local surfaces already include history/status/inspect",
		);
	});

	it("keeps replay, fork, and event-tape docs tied to the operator loop", () => {
		expect(readme).toContain("docs/ledger.md");
		expect(readme).toContain("inspect the event tape");
		expect(readme).toContain("replay the stored packet snapshot");
		expect(readme).toContain("fork from a unit boundary");
		expect(readme).toContain(
			"buildplane ledger replay --run-id <run-id> --workspace <path>",
		);
	});

	it("presents replay review and recovery as the high-trust operator loop", () => {
		expect(highTrustLoopSection).toContain("run with implement-then-review");
		expect(highTrustLoopSection).toContain("inspect the event tape");
		expect(highTrustLoopSection).toContain("replay the stored packet snapshot");
		expect(highTrustLoopSection).toContain("fork from a unit boundary");
		expect(highTrustLoopSection).toContain("reviewer-rescue");
		expect(highTrustLoopSection).toContain("raw one-shot path");
	});

	it("documents the Node baseline and published runtime range", () => {
		expect(readme).toContain(".node-version");
		expect(readme).toContain("24.13.1");
		expect(readme).toContain(">=24.13.1 <25");
		expect(readme).toContain(
			"`.node-version` (`24.13.1`) as the tested development baseline",
		);
	});

	it("documents capability doctor output for published/global installs", () => {
		expect(distributionSection).toContain(
			"buildplane bootstrap doctor --capabilities --json",
		);
		expect(readme).toContain("node:sqlite");
		expect(distributionSection).toContain("Published/global native memory");
	});

	it("documents the explicit deterministic CI trust gate", () => {
		for (const command of [
			"pnpm lint",
			"pnpm typecheck",
			"pnpm test",
			"pnpm build",
			"cargo test --manifest-path native/Cargo.toml",
			"pnpm verify:published-bootstrap",
		]) {
			expect(readme).toContain(command);
		}
	});
});
