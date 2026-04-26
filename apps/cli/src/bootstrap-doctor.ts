import {
	type CapabilityCheck,
	type CapabilityProbeResult,
	type InspectCapabilitiesOptions,
	inspectCapabilities,
} from "./capabilities.js";

export type BootstrapDoctorProbeResult = CapabilityProbeResult;

export interface BootstrapDoctorCheck {
	readonly id: Extract<
		CapabilityCheck["id"],
		"node" | "node_sqlite" | "npm" | "git"
	>;
	readonly label: string;
	readonly ok: boolean;
	readonly required: true;
	readonly expected?: string;
	readonly detected?: string;
	readonly command?: string;
	readonly message: string;
}

export interface BootstrapDoctorReport {
	readonly ok: boolean;
	readonly checks: readonly BootstrapDoctorCheck[];
	readonly notes: readonly string[];
}

export interface BootstrapDoctorOptions extends InspectCapabilitiesOptions {}

function toBootstrapDoctorCheck(
	capability: CapabilityCheck,
): BootstrapDoctorCheck {
	if (
		capability.id !== "node" &&
		capability.id !== "node_sqlite" &&
		capability.id !== "npm" &&
		capability.id !== "git"
	) {
		throw new Error(
			`Unsupported bootstrap doctor capability: ${capability.id}`,
		);
	}
	return {
		id: capability.id,
		label: capability.label,
		ok: capability.ok,
		required: true,
		expected: capability.expected,
		detected: capability.detected,
		command: capability.command,
		message: capability.message,
	};
}

export function inspectBootstrapDoctor(
	options: BootstrapDoctorOptions = {},
): BootstrapDoctorReport {
	const capabilityReport = inspectCapabilities(options);
	const capabilityById = new Map(
		capabilityReport.capabilities.map((capability) => [
			capability.id,
			capability,
		]),
	);
	const checkIds = ["node", "node_sqlite", "npm", "git"] as const;
	const checks = checkIds.map((id) => {
		const capability = capabilityById.get(id);
		if (!capability) {
			throw new Error(`Missing capability check: ${id}`);
		}
		return toBootstrapDoctorCheck(capability);
	});

	return {
		ok: checks.every((check) => check.ok),
		checks,
		notes: capabilityReport.notes,
	};
}
