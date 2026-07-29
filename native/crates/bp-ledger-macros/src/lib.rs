//! Procedural macros for bp-ledger.
//!
//! Provides `#[secret(hint = "...")]` to mark fields that must be redacted at
//! serialize time.
//!
//! Usage: annotate the containing struct with `#[derive(Serialize, RedactSecrets)]`
//! and mark sensitive fields with `#[secret(hint = "...")]`.
//!
//! `RedactSecrets` generates a custom `Serialize` impl that replaces secret
//! fields with `{ "redacted": true, "hash": "sha256:<hex>", "hint": "<hint>" }`.
//! The `#[derive(Serialize)]` annotation must be removed from structs that use
//! `RedactSecrets` — `RedactSecrets` owns the `Serialize` impl entirely.

use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::{format_ident, quote};
use syn::{parse_macro_input, Data, DeriveInput, Expr, ExprLit, Fields, Lit, Meta};

/// No-op attribute kept so `#[secret(hint = "...")]` is accepted at field
/// position without rustc complaining about an unknown attribute.
/// The actual work is done by `#[derive(RedactSecrets)]` on the struct.
#[proc_macro_attribute]
pub fn secret(_args: TokenStream, item: TokenStream) -> TokenStream {
    item
}

/// Derive macro that generates a `Serialize` impl replacing `#[secret]`-marked
/// fields with a redaction envelope instead of their raw values.
///
/// The generated impl serialises the struct as a JSON object where every
/// `#[secret(hint = "...")]` field becomes:
/// ```json
/// { "redacted": true, "hash": "sha256:<hex>", "hint": "<hint>" }
/// ```
///
/// Because this macro emits its own full `Serialize` impl, you must **not**
/// also derive `serde::Serialize` on the same struct — remove it and use only
/// `RedactSecrets`.
#[proc_macro_derive(RedactSecrets, attributes(secret))]
pub fn derive_redact_secrets(input: TokenStream) -> TokenStream {
    let ast = parse_macro_input!(input as DeriveInput);
    impl_redact_secrets(&ast)
        .unwrap_or_else(|e| e.to_compile_error())
        .into()
}

fn impl_redact_secrets(ast: &DeriveInput) -> syn::Result<TokenStream2> {
    let struct_name = &ast.ident;
    let (impl_generics, ty_generics, where_clause) = ast.generics.split_for_impl();

    let fields = match &ast.data {
        Data::Struct(s) => match &s.fields {
            Fields::Named(f) => &f.named,
            _ => {
                return Err(syn::Error::new_spanned(
                    struct_name,
                    "RedactSecrets only supports structs with named fields",
                ))
            }
        },
        _ => {
            return Err(syn::Error::new_spanned(
                struct_name,
                "RedactSecrets only supports structs",
            ))
        }
    };

    struct FieldInfo<'a> {
        ident: &'a syn::Ident,
        is_secret: bool,
        hint: String,
    }

    let mut field_infos: Vec<FieldInfo> = Vec::new();
    for field in fields {
        let ident = field.ident.as_ref().expect("named field");
        let mut is_secret = false;
        let mut hint = String::from("secret");

        for attr in &field.attrs {
            if attr.path().is_ident("secret") {
                is_secret = true;
                if let Meta::List(list) = &attr.meta {
                    if let Ok(nv) = syn::parse2::<syn::MetaNameValue>(list.tokens.clone()) {
                        if nv.path.is_ident("hint") {
                            if let Expr::Lit(ExprLit {
                                lit: Lit::Str(s), ..
                            }) = &nv.value
                            {
                                hint = s.value();
                            }
                        }
                    }
                }
                break;
            }
        }

        field_infos.push(FieldInfo {
            ident,
            is_secret,
            hint,
        });
    }

    // Generate per-secret-field helper modules with the hash/redact function.
    let helper_modules: Vec<TokenStream2> = field_infos
        .iter()
        .filter(|f| f.is_secret)
        .map(|f| {
            let mod_name = format_ident!("__bp_ledger_redact_{}", f.ident);
            let hint = &f.hint;
            quote! {
                #[doc(hidden)]
                #[allow(non_snake_case)]
                mod #mod_name {
                    pub fn redact<T, S>(
                        value: &T,
                        serializer: S,
                    ) -> ::std::result::Result<S::Ok, S::Error>
                    where
                        T: ::serde::Serialize,
                        S: ::serde::Serializer,
                    {
                        use ::serde::Serialize as _;
                        use ::sha2::Digest as _;
                        let bytes = ::serde_json::to_vec(value)
                            .map_err(::serde::ser::Error::custom)?;
                        let mut hasher = ::sha2::Sha256::new();
                        hasher.update(&bytes);
                        let hash = format!("sha256:{:x}", hasher.finalize());
                        let redacted = ::serde_json::json!({
                            "redacted": true,
                            "hash": hash,
                            "hint": #hint,
                        });
                        redacted.serialize(serializer)
                    }
                }
            }
        })
        .collect();

    // Generate per-field serialize_entry calls inside a map serializer.
    let field_count = field_infos.len();
    let serialize_entries: Vec<TokenStream2> = field_infos
        .iter()
        .map(|f| {
            let ident = f.ident;
            let key = ident.to_string();
            if f.is_secret {
                let mod_name = format_ident!("__bp_ledger_redact_{}", ident);
                quote! {
                    {
                        // Thin newtype wrapper that routes through the helper.
                        struct __Wrap<'__a, T: ::serde::Serialize>(&'__a T);
                        impl<'__a, T: ::serde::Serialize> ::serde::Serialize for __Wrap<'__a, T> {
                            fn serialize<__S: ::serde::Serializer>(
                                &self,
                                s: __S,
                            ) -> ::std::result::Result<__S::Ok, __S::Error> {
                                #mod_name::redact(self.0, s)
                            }
                        }
                        map.serialize_entry(#key, &__Wrap(&self.#ident))?;
                    }
                }
            } else {
                quote! {
                    map.serialize_entry(#key, &self.#ident)?;
                }
            }
        })
        .collect();

    let expanded = quote! {
        #(#helper_modules)*

        impl #impl_generics ::serde::Serialize for #struct_name #ty_generics #where_clause {
            fn serialize<__S: ::serde::Serializer>(
                &self,
                serializer: __S,
            ) -> ::std::result::Result<__S::Ok, __S::Error> {
                use ::serde::ser::SerializeMap as _;
                let mut map = serializer.serialize_map(Some(#field_count))?;
                #(#serialize_entries)*
                map.end()
            }
        }
    };

    Ok(expanded)
}
