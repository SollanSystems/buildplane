import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture, makeForkFixture } from "./fixtures.js";

const recordedCommand = {
	command: "node",
	args: [
		"-e",
		"const fs = require('fs'); fs.writeFileSync('vcr-side-effect.txt', 'executed'); console.log('recorded-vcr-output');",
	],
};

function uuidBefore(id: string): string {
	const chars = id.split("");
	const hex = "0123456789abcdef";
	for (let i = chars.length - 1; i >= 0; i -= 1) {
		if (chars[i] === "-") {
			continue;
		}
		const value = hex.indexOf(chars[i]);
		if (value > 0) {
			chars[i] = hex[value - 1];
			for (let j = i + 1; j < chars.length; j += 1) {
				if (chars[j] !== "-") {
					chars[j] = "f";
				}
			}
			return chars.join("");
		}
	}
	throw new Error(`fixture: cannot derive predecessor for ${id}`);
}

function uuidAfter(id: string): string {
	const chars = id.split("");
	const hex = "0123456789abcdef";
	for (let i = chars.length - 1; i >= 0; i -= 1) {
		if (chars[i] === "-") {
			continue;
		}
		const value = hex.indexOf(chars[i]);
		if (value >= 0 && value < hex.length - 1) {
			chars[i] = hex[value + 1];
			for (let j = i + 1; j < chars.length; j += 1) {
				if (chars[j] !== "-") {
					chars[j] = "0";
				}
			}
			return chars.join("");
		}
	}
	throw new Error(`fixture: cannot derive successor for ${id}`);
}

function insertToolRequestEvent(
	db: DatabaseSync,
	input: {
		id: string;
		parentRunId: string;
		parentEventId?: string | null;
		command: { command: string; args?: readonly string[] };
		unitId: string;
	},
): void {
	db.prepare(
		"INSERT INTO events (id, run_id, parent_event_id, schema_version, kind, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).run(
		input.id,
		input.parentRunId,
		input.parentEventId ?? null,
		1,
		"tool_request",
		"2026-01-01T00:00:00.000Z",
		JSON.stringify({
			ToolRequestStoredV1: {
				tool_name: "run_command",
				arguments: input.command,
				env: {
					redacted: false,
					hash: "sha256:e3b0c44298fc1c149afbf4c8996fb924",
					hint: "env_var",
				},
				working_directory: "",
				unit_id: input.unitId,
			},
		}),
	);
}

function insertToolResultEvent(
	db: DatabaseSync,
	input: {
		id: string;
		parentRunId: string;
		requestId: string;
		stdout: string;
		stderr?: string;
		exitCode?: number | null;
		output?: unknown;
	},
): void {
	db.prepare(
		"INSERT INTO events (id, run_id, parent_event_id, schema_version, kind, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).run(
		input.id,
		input.parentRunId,
		input.requestId,
		1,
		"tool_result",
		"2026-01-01T00:00:01.000Z",
		JSON.stringify({
			ToolResultV1: {
				tool_request_id: input.requestId,
				stdout: input.stdout,
				stderr: input.stderr ?? "",
				exit_code: input.exitCode === undefined ? 0 : input.exitCode,
				output: input.output ?? null,
				duration_ms: 0,
			},
		}),
	);
}

describe("fork --vcr basic [Phase F]", () => {
	it("replays recorded tool outputs from parent tape without re-executing", async () => {
		const fixture = await makeForkFixture({
			forkArgs: ["--vcr"],
			parentPacket: {
				unit: {
					id: "u-parent-vcr",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: recordedCommand,
				verification: { requiredOutputs: [] },
			},
			forkPacket: {
				unit: {
					id: "u-fork-vcr",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: recordedCommand,
				verification: { requiredOutputs: [] },
			},
		});

		try {
			expect(
				fixture.forkExitCode,
				`${fixture.forkStdout}\n${fixture.forkStderr}`,
			).toBe(0);
			expect(existsSync(join(fixture.dir, "vcr-side-effect.txt"))).toBe(false);

			const db = new DatabaseSync(fixture.eventsDbPath, { readOnly: true });
			const row = db
				.prepare(
					"SELECT payload FROM events WHERE run_id = ? AND kind = 'tool_result' ORDER BY id DESC LIMIT 1",
				)
				.get(fixture.forkRunId) as { payload: string };
			db.close();

			const payload = JSON.parse(row.payload) as {
				ToolResultV1: { stdout: string; output?: { vcr?: string } };
			};
			expect(payload.ToolResultV1.stdout.trim()).toBe("recorded-vcr-output");
			expect(payload.ToolResultV1.output?.vcr).toBe("hit");
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);

	it("materializes required outputs from the recorded VCR output store on replay hits", async () => {
		const requiredOutput = "vcr-required-output.txt";
		const execution = {
			command: "node",
			args: ["-e", "console.log('required-output');"],
		};
		const fixture = await makeForkFixture({
			beforeFork: ({ dir, parentRunId }) => {
				const outputStore = join(
					dir,
					".buildplane",
					"vcr",
					parentRunId,
					"outputs",
				);
				mkdirSync(outputStore, { recursive: true });
				writeFileSync(
					join(outputStore, requiredOutput),
					"from-recorded-vcr-output-store",
				);
			},
			forkArgs: ["--vcr"],
			parentPacket: {
				unit: {
					id: "u-parent-vcr-required-output",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution,
				verification: { requiredOutputs: [] },
			},
			forkPacket: {
				unit: {
					id: "u-fork-vcr-required-output",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [requiredOutput],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution,
				verification: { requiredOutputs: [requiredOutput] },
			},
		});

		try {
			const db = new DatabaseSync(fixture.eventsDbPath, { readOnly: true });
			const row = db
				.prepare(
					"SELECT payload FROM events WHERE run_id = ? AND kind = 'tool_result' ORDER BY id DESC LIMIT 1",
				)
				.get(fixture.forkRunId) as { payload: string };

			expect(
				fixture.forkExitCode,
				`${fixture.forkStdout}\n${fixture.forkStderr}\n${row?.payload ?? ""}`,
			).toBe(0);

			const payload = JSON.parse(row.payload) as {
				ToolResultV1: {
					output?: {
						vcr?: string;
						materialized_outputs?: { path: string; status: string }[];
					};
				};
			};
			expect(payload.ToolResultV1.output?.vcr).toBe("hit");
			expect(payload.ToolResultV1.output?.materialized_outputs).toContainEqual({
				path: requiredOutput,
				source: "parent_vcr_output_store",
				status: "copied",
			});
			const workspaceWrite = db
				.prepare(
					"SELECT payload FROM events WHERE run_id = ? AND kind = 'workspace_write' ORDER BY id DESC LIMIT 1",
				)
				.get(fixture.forkRunId) as { payload: string };
			db.close();
			expect(workspaceWrite.payload).toContain(requiredOutput);
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);

	it("does not capture traversal outputs outside the VCR output store", async () => {
		const requiredOutput = "../escaped-vcr-capture.txt";
		const fixture = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "u-parent-vcr-capture-traversal",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [requiredOutput],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "node",
					args: [
						"-e",
						"require('fs').writeFileSync('../escaped-vcr-capture.txt', 'outside');",
					],
				},
				verification: { requiredOutputs: [requiredOutput] },
			},
		});

		try {
			expect(fixture.exitCode).toBe(1);
			const db = new DatabaseSync(fixture.eventsDbPath, { readOnly: true });
			const row = db
				.prepare("SELECT DISTINCT run_id FROM events LIMIT 1")
				.get() as { run_id: string };
			db.close();

			expect(
				existsSync(
					resolve(
						fixture.dir,
						".buildplane",
						"vcr",
						row.run_id,
						"escaped-vcr-capture.txt",
					),
				),
			).toBe(false);
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);

	it("scopes replay matches to events at or after the fork point", async () => {
		const scopedCommand = {
			command: "node",
			args: ["-e", "console.log('post-fork-output');"],
		};
		const fixture = await makeForkFixture({
			beforeFork: ({ eventsDbPath, parentRunId, targetId }) => {
				const resultId = uuidBefore(targetId);
				const requestId = uuidBefore(resultId);
				const db = new DatabaseSync(eventsDbPath);
				try {
					const runStarted = db
						.prepare(
							"SELECT id FROM events WHERE run_id = ? AND kind = 'run_started' ORDER BY id ASC LIMIT 1",
						)
						.get(parentRunId) as { id: string };
					if (
						!(
							runStarted.id < requestId &&
							requestId < resultId &&
							resultId < targetId
						)
					) {
						throw new Error(
							"fixture: injected event ids do not precede fork target",
						);
					}
					insertToolRequestEvent(db, {
						command: scopedCommand,
						id: requestId,
						parentRunId,
						parentEventId: runStarted.id,
						unitId: "u-parent-vcr-scoped-pre-fork",
					});
					insertToolResultEvent(db, {
						id: resultId,
						parentRunId,
						requestId,
						stdout: "pre-fork-stale-output\n",
					});
				} finally {
					db.close();
				}
			},
			forkArgs: ["--vcr"],
			parentPacket: {
				unit: {
					id: "u-parent-vcr-scoped",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: scopedCommand,
				verification: { requiredOutputs: [] },
			},
			forkPacket: {
				unit: {
					id: "u-fork-vcr-scoped",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: scopedCommand,
				verification: { requiredOutputs: [] },
			},
		});

		try {
			expect(
				fixture.forkExitCode,
				`${fixture.forkStdout}\n${fixture.forkStderr}`,
			).toBe(0);
			const db = new DatabaseSync(fixture.eventsDbPath, { readOnly: true });
			const row = db
				.prepare(
					"SELECT payload FROM events WHERE run_id = ? AND kind = 'tool_result' ORDER BY id DESC LIMIT 1",
				)
				.get(fixture.forkRunId) as { payload: string };
			db.close();

			const payload = JSON.parse(row.payload) as {
				ToolResultV1: { stdout: string; output?: { vcr?: string } };
			};
			expect(payload.ToolResultV1.output?.vcr).toBe("hit");
			expect(payload.ToolResultV1.stdout).toContain("post-fork-output");
			expect(payload.ToolResultV1.stdout).not.toContain(
				"pre-fork-stale-output",
			);
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);

	it("uses causal parentage instead of lexical UUID range for the fork boundary", async () => {
		const causalCommand = {
			command: "node",
			args: ["-e", "console.log('causal-child-command-should-not-run');"],
		};
		const fixture = await makeForkFixture({
			beforeFork: ({ eventsDbPath, parentRunId, targetId }) => {
				const resultId = uuidBefore(targetId);
				const requestId = uuidBefore(resultId);
				if (!(requestId < resultId && resultId < targetId)) {
					throw new Error(
						"fixture: injected event ids do not precede fork target",
					);
				}
				const db = new DatabaseSync(eventsDbPath);
				try {
					insertToolRequestEvent(db, {
						id: requestId,
						parentRunId,
						parentEventId: targetId,
						command: causalCommand,
						unitId: "u-parent-vcr-causal-child",
					});
					insertToolResultEvent(db, {
						id: resultId,
						parentRunId,
						requestId,
						stdout: "causal-child-output\n",
					});
				} finally {
					db.close();
				}
			},
			forkArgs: ["--vcr"],
			parentPacket: {
				unit: {
					id: "u-parent-vcr-causal-source",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: { command: "node", args: ["-e", "console.log('parent')"] },
				verification: { requiredOutputs: [] },
			},
			forkPacket: {
				unit: {
					id: "u-fork-vcr-causal-child",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: causalCommand,
				verification: { requiredOutputs: [] },
			},
		});

		try {
			expect(
				fixture.forkExitCode,
				`${fixture.forkStdout}\n${fixture.forkStderr}`,
			).toBe(0);
			const db = new DatabaseSync(fixture.eventsDbPath, { readOnly: true });
			const row = db
				.prepare(
					"SELECT payload FROM events WHERE run_id = ? AND kind = 'tool_result' ORDER BY id DESC LIMIT 1",
				)
				.get(fixture.forkRunId) as { payload: string };
			db.close();

			const payload = JSON.parse(row.payload) as {
				ToolResultV1: { stdout: string; output?: { vcr?: string } };
			};
			expect(payload.ToolResultV1.output?.vcr).toBe("hit");
			expect(payload.ToolResultV1.stdout).toContain("causal-child-output");
			expect(payload.ToolResultV1.stdout).not.toContain(
				"causal-child-command-should-not-run",
			);
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);

	it("buffers out-of-order tool results until their request key is known", async () => {
		const outOfOrderCommand = {
			command: "node",
			args: ["-e", "console.log('fork-command-that-should-not-run');"],
		};
		const fixture = await makeForkFixture({
			beforeFork: ({ eventsDbPath, parentRunId, targetId }) => {
				const resultId = uuidAfter(targetId);
				const requestId = uuidAfter(resultId);
				if (!(targetId < resultId && resultId < requestId)) {
					throw new Error(
						"fixture: injected event ids do not follow fork target",
					);
				}
				const db = new DatabaseSync(eventsDbPath);
				try {
					insertToolResultEvent(db, {
						id: resultId,
						parentRunId,
						requestId,
						stdout: "out-of-order-parent-output\n",
					});
					insertToolRequestEvent(db, {
						id: requestId,
						parentRunId,
						parentEventId: targetId,
						command: outOfOrderCommand,
						unitId: "u-parent-vcr-out-of-order",
					});
				} finally {
					db.close();
				}
			},
			forkArgs: ["--vcr"],
			parentPacket: {
				unit: {
					id: "u-parent-vcr-out-of-order-source",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: { command: "node", args: ["-e", "console.log('parent')"] },
				verification: { requiredOutputs: [] },
			},
			forkPacket: {
				unit: {
					id: "u-fork-vcr-out-of-order",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: outOfOrderCommand,
				verification: { requiredOutputs: [] },
			},
		});

		try {
			expect(
				fixture.forkExitCode,
				`${fixture.forkStdout}\n${fixture.forkStderr}`,
			).toBe(0);
			const db = new DatabaseSync(fixture.eventsDbPath, { readOnly: true });
			const row = db
				.prepare(
					"SELECT payload FROM events WHERE run_id = ? AND kind = 'tool_result' ORDER BY id DESC LIMIT 1",
				)
				.get(fixture.forkRunId) as { payload: string };
			db.close();

			const payload = JSON.parse(row.payload) as {
				ToolResultV1: { stdout: string; output?: { vcr?: string } };
			};
			expect(payload.ToolResultV1.output?.vcr).toBe("hit");
			expect(payload.ToolResultV1.stdout).toContain(
				"out-of-order-parent-output",
			);
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);

	it("ignores synthetic VCR miss receipts when building the replay cassette", async () => {
		const reexecutedCommand = {
			command: "node",
			args: ["-e", "console.log('fork-command-that-should-not-run');"],
		};
		const fixture = await makeForkFixture({
			beforeFork: ({ eventsDbPath, parentRunId, targetId }) => {
				const requestId = uuidAfter(targetId);
				const missResultId = uuidAfter(requestId);
				const realResultId = uuidAfter(missResultId);
				if (
					!(
						targetId < requestId &&
						requestId < missResultId &&
						missResultId < realResultId
					)
				) {
					throw new Error(
						"fixture: injected event ids do not follow fork target",
					);
				}
				const db = new DatabaseSync(eventsDbPath);
				try {
					insertToolRequestEvent(db, {
						id: requestId,
						parentRunId,
						parentEventId: targetId,
						command: reexecutedCommand,
						unitId: "u-parent-vcr-reexecute",
					});
					insertToolResultEvent(db, {
						id: missResultId,
						parentRunId,
						requestId,
						stdout: "",
						stderr: "VCR miss; explicit reexecute policy selected",
						exitCode: null,
						output: { policy: "reexecute", vcr: "miss" },
					});
					insertToolResultEvent(db, {
						id: realResultId,
						parentRunId,
						requestId,
						stdout: "real-reexecute-output\n",
					});
				} finally {
					db.close();
				}
			},
			forkArgs: ["--vcr"],
			parentPacket: {
				unit: {
					id: "u-parent-vcr-reexecute-source",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: { command: "node", args: ["-e", "console.log('parent')"] },
				verification: { requiredOutputs: [] },
			},
			forkPacket: {
				unit: {
					id: "u-fork-vcr-reexecute",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: reexecutedCommand,
				verification: { requiredOutputs: [] },
			},
		});

		try {
			expect(
				fixture.forkExitCode,
				`${fixture.forkStdout}\n${fixture.forkStderr}`,
			).toBe(0);
			const db = new DatabaseSync(fixture.eventsDbPath, { readOnly: true });
			const row = db
				.prepare(
					"SELECT payload FROM events WHERE run_id = ? AND kind = 'tool_result' ORDER BY id DESC LIMIT 1",
				)
				.get(fixture.forkRunId) as { payload: string };
			db.close();

			const payload = JSON.parse(row.payload) as {
				ToolResultV1: { stdout: string; output?: { vcr?: string } };
			};
			expect(payload.ToolResultV1.output?.vcr).toBe("hit");
			expect(payload.ToolResultV1.stdout).toContain("real-reexecute-output");
			expect(payload.ToolResultV1.stdout).not.toContain(
				"fork-command-that-should-not-run",
			);
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);
});
