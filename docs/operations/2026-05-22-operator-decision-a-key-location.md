# OPERATOR-DECISION-A — key-location policy

| | |
|---|---|
| **Status** | Resolved by autonomy default |
| **Date** | 2026-05-22 |
| **Scope** | Buildplane v0.5 M1 local-first signed tape |
| **Decision** | Use per-machine `~/.buildplane/keys/` with actor-scoped subpaths |

## Decision

For M1-S4 and later key-loading/signing work, use the documented M1 default:

```text
~/.buildplane/keys/
  kernel/<key-id>.ed25519
  worker/<worker-id>/<key-id>.ed25519
  operator/<operator-id>/<key-id>.ed25519   # only after approval events ship
```

Public-key metadata may be persisted next to private keys and in ledger-visible registries:

- `actor_id`
- `key_id`
- `algorithm`
- `public_key_hash`
- `created_at`
- optional `retired_at`

## Autonomy interpretation

The operator directive was: execute the full plan with the goal of autonomy. This resolves the prior operator-only blocker by adopting the spec's recommended safe default, without creating, loading, or committing any private key material in this docs-only decision slice.

## Boundaries for implementation

Future M1-S4 code must:

- create/load private keys only under the actor-scoped paths above;
- avoid logging private-key bytes or secret-shaped material;
- use deterministic fixture keys only in tests;
- keep real operator keys outside the repository;
- fail closed when signed append cannot persist both the event row and matching detached signature.

## Rationale

- Buildplane v0.5 is local-first and single-machine/single-operator.
- Actor-scoped subpaths preserve a migration path to per-operator and per-worker keys.
- The ledger can record `actor_id`, `key_id`, and `public_key_hash` now without requiring cloud identity, KMS, OS keychain, or hardware-backed keys.

## Follow-on card unblocked

This decision unblocks M1-S4 local keyring + signing-on-append planning and implementation after the current verification-on-read lane finishes its review gates.
