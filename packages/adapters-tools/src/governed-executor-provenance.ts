/**
 * Runtime provenance for the small set of concrete executors allowed to carry
 * governed effects. This is intentionally an internal module: a TypeScript
 * structural match or a self-declared sandbox attestation is not sufficient
 * to cross the ActionGateway boundary.
 *
 * Code running inside this package is part of the trusted computing base. The
 * public package barrel does not expose this registry, so applications and
 * adapters cannot turn an arbitrary host-shell callback into a governed
 * executor merely by copying the V1 attestation fields.
 */
const trustedGovernedExecutors = new WeakSet<object>();

/**
 * Internal factory hook used only by the concrete rootless-OCI executor.
 * Requiring a frozen object avoids registering a mutable callback holder that
 * could be swapped after admission.
 */
export function registerTrustedGovernedActionExecutor<T extends object>(
	executor: T,
): T {
	if (!Object.isFrozen(executor)) {
		throw new TypeError(
			"trusted governed executors must be immutable before registration.",
		);
	}
	trustedGovernedExecutors.add(executor);
	return executor;
}

/**
 * Internal predicate used by ActionGateway and governed workers before they
 * inspect or invoke an executor. There is deliberately no public setter,
 * token, or serializable brand.
 */
export function isTrustedGovernedActionExecutor(
	executor: unknown,
): executor is object {
	return (
		typeof executor === "object" &&
		executor !== null &&
		trustedGovernedExecutors.has(executor)
	);
}
