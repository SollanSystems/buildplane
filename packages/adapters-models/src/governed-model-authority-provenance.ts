/**
 * Nominal provenance for the native transactional model-authority bridge.
 *
 * A structural `{ authorize() {} }` object is not authority. The required
 * isolated broker/native bridge does not exist in this process yet, so this
 * production module intentionally has no registration or minting hook. A
 * JavaScript caller must not be able to bless its own resolver merely by
 * importing an internal source module.
 */
/**
 * Always false until an isolated authority-broker composition replaces this
 * module. This fail-closed seam prevents the governed API worker from turning
 * any process-local JavaScript callback into model-action authority.
 */
export function isRegisteredNativeModelActionAuthorityResolver(
	_resolver: unknown,
): _resolver is object {
	return false;
}
