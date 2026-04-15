# Buildplane Bootstrap Doctor Requirements

## Goal

Add the smallest useful post-installer follow-up for published Buildplane adoption: a report-only bootstrap doctor that tells an operator whether the basic host prerequisites for the published CLI are present before they try normal Buildplane commands.

## User story

As a new Buildplane operator using the published install path, I want a deterministic command that reports whether my host meets the minimum prerequisites, so I can diagnose setup issues without guessing from a hard failure.

## In scope

Add a new command surface:

- `buildplane bootstrap doctor`
- `buildplane bootstrap doctor --json`

The command must:

- work before `buildplane init`
- work outside a git repo
- not create `.buildplane`
- be read-only
- perform no network calls
- perform no auto-fix/remediation
- emit deterministic human and JSON output
- return exit code `0` when all required checks pass
- return exit code `1` when any required check fails

## Required checks

The first slice only reports these prerequisites:

1. Node version matches `24.13.1`
2. `npm` is resolvable and `npm --version` succeeds
3. `git` is resolvable and `git --version` succeeds

Each check must surface enough detail for operators to see:

- check name
- pass/fail status
- required version/command expectation where relevant
- detected version/path or failure reason

## Informational note

Human and JSON output should include one explicit informational note:

- published/global installs do not yet include a verified `buildplane memory ...` contract

This note is informational only, not a failing prerequisite.

## Node guard behavior

Today the published entrypoint exits immediately on unsupported Node versions.

For this slice only:

- `bootstrap doctor` must be allowed to run even when the current Node version is unsupported
- all other command surfaces must keep the strict existing Node guard behavior

## Output requirements

### Human output

Human output should be compact and terminal-safe, for example:

- overall bootstrap status
- one line per prerequisite check
- one final informational note block

### JSON output

JSON output should be machine-readable and deterministic, with at minimum:

- `ok`
- `checks`
- `notes`

`checks` entries should carry stable ids/fields rather than free-form-only text.

## Constraints

- Keep the slice TypeScript CLI only
- Prefer narrow helper/module additions over broad CLI refactors
- Do not widen into installer transport validation, PATH rewriting, or host auto-remediation
- Do not relax the strict Node guard for `--help` or unrelated commands
- Keep the published README honest; only update docs if the new command is intentionally part of the published contract

## Out of scope

- auto-installing Node, npm, git, or PATH entries
- Windows-specific installer flows
- PowerShell or shell-script doctor implementations
- workflow import/apply changes
- native `buildplane memory ...` enablement
- repo cleanliness checks
- auth/session validation for Claude/Codex providers
- curl/bash transport checks
- generalized environment doctor for every future dependency

## Acceptance criteria

- `buildplane bootstrap doctor` works pre-init and outside repos
- on unsupported Node, `buildplane bootstrap doctor` reports the Node failure instead of crashing before command dispatch
- on unsupported Node, unrelated commands still fail with the existing strict version error
- no `.buildplane` directory is created by doctor runs
- human and JSON outputs are deterministic
- focused CLI/workflow tests cover the new command and the guard bypass behavior
