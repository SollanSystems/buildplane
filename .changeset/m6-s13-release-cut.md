---
"buildplane": minor
---

cut the public v0.5 release wiring (M6-S13): add an MIT `LICENSE`, flip changesets `access` to `public`, remove `apps/cli`'s `private` flag + add `publishConfig.access: public`, and drop the stale `gsd2` bin from the published surface (operator decision O5 — `src/gsd2*.ts` + its tests stay, source cleanup is post-v0.5). The release workflow now wires `changeset publish` guarded by `NPM_TOKEN` (fails loud on a release-landing push when the token is missing), with `RELEASE_TOKEN` fed to checkout + the changesets step and a `GITHUB_TOKEN` fallback. The GitHub-release tag `v0.5.0` is independent of npm semver — the published npm version continues upward from `0.12.2` (npm rejects downgrades), so this bump lands as `>=0.13.0`, not `0.5.0`.
