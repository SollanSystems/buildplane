export const SUPPORTED_NODE_VERSION = "24.13.1";

export function assertSupportedNodeVersion(
	current = process.versions.node,
): void {
	if (current !== SUPPORTED_NODE_VERSION) {
		throw new Error(
			`Buildplane requires Node ${SUPPORTED_NODE_VERSION}. Detected ${current}.`,
		);
	}
}
