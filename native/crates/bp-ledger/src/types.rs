//! Primitive type aliases used by typeshare to bridge Rust 64-bit integers to
//! TypeScript. `u64` is not directly expressible in TypeScript without BigInt;
//! the `U64` alias lets typeshare map it to `string` via `typeshare.toml`.

/// A u64 aliased so typeshare can map it to `string` in TypeScript.
/// Mapping is declared in `typeshare.toml` under `[typescript.type_mappings]`.
pub type U64 = u64;
