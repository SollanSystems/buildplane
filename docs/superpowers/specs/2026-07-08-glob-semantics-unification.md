# Glob semantics unification — envelope subset + diff-scope matching (post-v0.5 step 2)

**Problem.** The `code-edit` side-effect vocabulary shipped at M6-S4 (`packages/**/src/**`,
`native/crates/**/src/**`, …) is consumed by three matchers with three different semantics:

1. **Broker enforcement** (`@buildplane/capability-broker` `evaluate.ts`): real `minimatch`
   (`dot:true`) — middle `**` works, matches zero-or-more segments. CORRECT reference.
2. **Acceptance diff-scope** (`@buildplane/policy` `diff-scope.ts` `matchesPattern`): the
   trailing-`/**` shortcut fires before the regex branch, so any middle-wildcard pattern
   ending in `/**` degrades to the literal prefix `packages/**/src` and matches **nothing**.
   The M6-S4 vocabulary is dead at acceptance — a diff under `packages/x/src/y.ts` is
   rejected as out-of-scope even though the broker allowed the writes.
3. **Envelope admission subset** (`authorization-envelope.ts` `globIsSubset`): handles only
   `**` / exact-equal / trailing-`/**` parents — a middle-wildcard envelope glob can never
   cover any proposal. This is the known dogfood blocker; the M6-S6 workaround (envelope
   globs byte-identical to the proposal) made the subset check vacuous.

**Fix.** One shared module `packages/policy/src/segment-glob.ts` defining the vocabulary
semantics, equal to `minimatch(path, pattern, { dot: true })` for the restricted vocabulary:

- A pattern is `/`-separated segments; a segment is a literal, exactly `**` (globstar), or a
  literal containing `*` (each `*` = `[^/]*`).
- `**` matches **zero or more** whole segments (minimatch globstar semantics — so
  `a/**/b` covers `a/b`).
- `segmentGlobMatches(path, pattern)` — matching, used by diff-scope for any pattern
  containing `*`. Differentially tested against real `minimatch` (policy devDependency,
  test-only; policy runtime stays dependency-free).
- `segmentGlobIsSubset(child, parent)` — language inclusion (every path matched by `child`
  is matched by `parent`), used by the envelope gate. Implemented as NFA inclusion over the
  segment alphabet (parent NFA determinized by subset construction; child NFA walked in
  product; any child-accepting/parent-non-accepting reachable state ⇒ NOT subset).
  Conservative rule: a segment containing `*` (other than exactly `**`) participates in
  subset decisions only via exact segment equality — may under-admit, never over-admits.

**Behavior changes (all reviewed as the trust surface they are):**

- Envelope admission: middle-wildcard envelope globs can now cover narrower proposals
  (e.g. `packages/**/src/**` covers `packages/kernel/src/**`). Failure mode to review =
  over-admission; gated by a brute-force differential test (enumerate patterns over
  `{a, b, **}` × paths over `{a, b, c}`: `subset(c,p)` ⇒ every path matched by `c` is
  matched by `p` under the SAME matcher used at enforcement).
- Acceptance diff-scope: middle-wildcard `allowed_globs`/`denied_globs` come alive
  (previously matched nothing — the vocabulary was unenforceable). Two deliberate
  tightenings vs the old code: trailing-`/**` no longer matches the bare prefix as a file
  (minimatch `src/**` does not match a file literally named `src`), and `a**b` inside a
  segment no longer crosses `/` (old `globToRegex` turned any `**` into `.*`). Both are
  fail-closed directions.
- Broker: untouched (already minimatch).

**Non-goals.** No change to broker evaluate, no new event kinds, no vocabulary additions,
no `planforge` changes. `normalizeGlob`/`normalizePattern` fail-closed rejection
(absolute/traversal/NUL) unchanged.

**Ceremony.** L1/L2 (admission + acceptance gate logic): TDD, 2-role review, plus an
adversarial reviewer explicitly briefed to construct over-admission / over-acceptance
counterexamples. The differential + brute-force tests are the deterministic gate.

## Adversarial finding (2026-07-08) — CONFIRMED and fixed pre-PR

The adversarial pass found a real **over-admission**: the shared `normalize()` stripped a
leading `./` and did not reject bare/interior/trailing `.` or `..` segments (only the `../`
*prefix* form). So `segmentGlobIsSubset("..", "**")`, `segmentGlobIsSubset("src/.", "src/**")`,
`segmentGlobIsSubset("a/./b", "a/*/b")`, and `segmentGlobIsSubset("src/**", "./src/**")` all
returned `true` — auto-admitting a traversal-looking proposal glob with no operator pause and
falsifying the stated "traversal rejected" invariant. Under the enforcement matcher (`minimatch`,
`dot:true`) these self-match as literals but never match under a wildcard, so admitting them is
over-admission by definition. (The NFA/product core itself was proven sound: 17,799 subset-true
pairs, 0 escapes, on the dot-free alphabet.)

Two contributing test blind spots, both now closed:
1. The soundness gate compared `segmentGlobMatches` on **both** sides — a self-consistency test
   whose `.`/`..` divergence cancelled. It is rewritten to use **real minimatch on both sides**
   (enforcement truth).
2. Both brute-force alphabets excluded `.`, `..`, and `./`. They now include them.

**Fix:** `normalize()` no longer strips `./` and rejects backslashes; a new `splitSegments`
fails closed on any empty / `.` / `..` segment (which subsumes the old `../`/`/../` checks). A
`./`-prefixed glob now yields a leading `.` segment and is rejected — consistent with the broker,
which matches nothing for `./…`. Re-verified with the attacker's own methodology: 11,955
subset-true pairs, **0 over-admissions** under real minimatch across a `.`/`..`/`./`/`*`-inclusive
alphabet. The diff-scope twin normalizers (`normalizeChangedPath`/`normalizePattern`) are left as
the attacker rated them — non-critical/neutralized: real changed-file lists carry no `.`/`..`/`//`
segments, and every wildcard pattern now routes through the hardened `segmentGlobMatches`, so the
only residual is a literal (non-wildcard) `.`/`..` scope pattern matching a file literally named
`.`/`..`, which is not a wildcard over-admission and needs unrealistic inputs.
