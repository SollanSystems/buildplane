import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanWorkflowPreview } from "../src/workflow-scan";

function writeFixture(
	root: string,
	relativePath: string,
	content = "fixture\n",
): void {
	const target = join(root, relativePath);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content);
}

describe("workflow scan preview", () => {
	it("discovers supported workflow files with deterministic classification", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-workflow-scan-"));
		writeFixture(root, "CLAUDE.md");
		writeFixture(root, "AGENTS.md");
		writeFixture(root, ".claude/settings.json", "{}\n");
		writeFixture(root, ".claude/settings.local.json", "{}\n");
		writeFixture(root, ".claude/hooks/z-last.py");
		writeFixture(root, ".claude/hooks/a-first.py");
		writeFixture(root, ".codex/config.toml", "model = 'o3'\n");
		writeFixture(root, ".codex/AGENTS.md");
		writeFixture(root, ".claude/auth.json", "secret\n");
		writeFixture(root, ".codex/log/codex.log", "noise\n");

		expect(scanWorkflowPreview(root)).toEqual({
			preview: true,
			findings: [
				{ path: "AGENTS.md", source: "shared", kind: "instructions" },
				{ path: "CLAUDE.md", source: "shared", kind: "instructions" },
				{ path: ".claude/settings.json", source: "claude", kind: "config" },
				{
					path: ".claude/settings.local.json",
					source: "claude",
					kind: "config",
				},
				{ path: ".claude/hooks/a-first.py", source: "claude", kind: "hooks" },
				{ path: ".claude/hooks/z-last.py", source: "claude", kind: "hooks" },
				{ path: ".codex/AGENTS.md", source: "codex", kind: "instructions" },
				{ path: ".codex/config.toml", source: "codex", kind: "config" },
			],
		});
	});

	it("returns an empty preview when no supported workflow files exist", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-workflow-scan-empty-"));
		writeFixture(root, "README.md", "irrelevant\n");
		writeFixture(root, ".codex/auth.json", "ignored\n");

		expect(scanWorkflowPreview(root)).toEqual({
			preview: true,
			findings: [],
		});
	});

	it("scans only top-level claude hook files", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-workflow-scan-hooks-"));
		writeFixture(root, ".claude/hooks/pre_tool_use.py", "print('hi')\n");
		writeFixture(root, ".claude/hooks/nested/helper.py", "ignored\n");
		writeFixture(root, ".claude/hooks/logs/hook.log", "ignored\n");

		expect(scanWorkflowPreview(root)).toEqual({
			preview: true,
			findings: [
				{
					path: ".claude/hooks/pre_tool_use.py",
					source: "claude",
					kind: "hooks",
				},
			],
		});
	});

	it("ignores symlinked workflow targets that point outside the workspace", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-workflow-scan-symlink-"),
		);
		const external = mkdtempSync(
			join(tmpdir(), "buildplane-workflow-scan-external-"),
		);
		writeFixture(external, "external-config.toml", "model = 'o3'\n");
		mkdirSync(join(root, ".codex"), { recursive: true });
		symlinkSync(
			join(external, "external-config.toml"),
			join(root, ".codex/config.toml"),
		);
		mkdirSync(join(root, ".claude"), { recursive: true });
		symlinkSync(join(external), join(root, ".claude/hooks"));

		expect(scanWorkflowPreview(root)).toEqual({
			preview: true,
			findings: [],
		});
	});
});
