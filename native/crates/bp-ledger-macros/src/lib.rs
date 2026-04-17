//! Procedural macros for bp-ledger.
//!
//! Provides `#[secret]` to mark fields that must be redacted at serialize time.

use proc_macro::TokenStream;

/// `#[secret]` — marks a struct field as sensitive. On serialization, the field's
/// value is replaced with a `{ "redacted": true, "hash": "sha256:<hex>", "hint": "<kind>" }`
/// shape instead of the raw bytes. Real implementation added in Task 6.
#[proc_macro_attribute]
pub fn secret(_args: TokenStream, item: TokenStream) -> TokenStream {
    item
}
