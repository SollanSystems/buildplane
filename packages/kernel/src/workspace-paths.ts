import {
	isAbsolute,
	normalize,
	relative,
	resolve,
	sep,
	win32,
} from "node:path";

import type { UnitPacket } from "./run-loop.js";

function normalizeWorkspaceRelativePath(
	value: string,
	workspaceRoot: string,
	label: string,
	options?: {
		allowWorkspaceRoot?: boolean;
	},
): string {
	const canonicalValue = value.replaceAll("\\", "/");
	if (isAbsolute(canonicalValue) || win32.isAbsolute(value)) {
		throw new Error(`${label} must not be absolute`);
	}

	const normalizedValue = normalize(canonicalValue);
	const normalizedWorkspaceRoot = resolve(sep, workspaceRoot);
	const resolvedPath = resolve(normalizedWorkspaceRoot, normalizedValue);
	const relativeToWorkspaceRoot = relative(
		normalizedWorkspaceRoot,
		resolvedPath,
	);

	if (
		relativeToWorkspaceRoot.startsWith(`..${sep}`) ||
		relativeToWorkspaceRoot === ".." ||
		isAbsolute(relativeToWorkspaceRoot)
	) {
		throw new Error(`${label} is outside the worktree root`);
	}

	const normalizedRelativePath = relativeToWorkspaceRoot || ".";
	if (normalizedRelativePath === "." && options?.allowWorkspaceRoot !== true) {
		throw new Error(`${label} must not be the worktree root`);
	}

	return normalizedRelativePath.replaceAll("\\", "/");
}

export function validatePacketForWorkspaceRoot(
	packet: UnitPacket,
	workspaceRoot: string,
): UnitPacket {
	return {
		...packet,
		unit: {
			...packet.unit,
			expectedOutputs: packet.unit.expectedOutputs.map((outputPath) =>
				normalizeWorkspaceRelativePath(
					outputPath,
					workspaceRoot,
					"unit expected output",
				),
			),
		},
		execution: packet.execution
			? {
					...packet.execution,
					cwd:
						packet.execution.cwd === undefined
							? undefined
							: normalizeWorkspaceRelativePath(
									packet.execution.cwd,
									workspaceRoot,
									"execution cwd",
									{ allowWorkspaceRoot: true },
								),
				}
			: undefined,
		verification: {
			...packet.verification,
			requiredOutputs: packet.verification.requiredOutputs.map((outputPath) =>
				normalizeWorkspaceRelativePath(
					outputPath,
					workspaceRoot,
					"required output",
				),
			),
		},
	};
}
