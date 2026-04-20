// Type shims for Rust primitives that typeshare emits verbatim.
// These are ambient aliases — no runtime value; pure TypeScript types.

/** UUIDv7 string (e.g. "018f4e2a-dead-7bee-beef-000000000001"). */
export type Uuid = string;

/** ISO-8601 datetime string emitted by chrono::DateTime<Utc>. */
export type DateTime<_Tz> = string;

/** Marker for the chrono UTC timezone (unused at runtime). */
export type Utc = never;

/** Arbitrary JSON value — equivalent to serde_json::Value. */
export type Value = unknown;

/** Ordered string-keyed map — equivalent to BTreeMap<K, V>. */
export type BTreeMap<K extends string, V> = Record<K, V>;
