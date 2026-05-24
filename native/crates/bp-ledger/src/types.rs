//! Primitive type aliases used by typeshare to bridge Rust 64-bit integers to
//! TypeScript. The current ledger wire format serializes these values as JSON
//! numbers, so `typeshare.toml` maps the `U64` alias to TypeScript `number`.

/// A u64 aliased so typeshare can map it consistently in TypeScript.
/// Mapping is declared in `typeshare.toml` under `[typescript.type_mappings]`.
pub type U64 = u64;
