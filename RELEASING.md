# Releasing psy-core

The release pipeline is fully automated: push a `v*.*.*` git tag and the
GitHub Actions workflow at `.github/workflows/publish.yml` builds, verifies,
and publishes to npm with SLSA build provenance via OIDC.

## Release loop

1. Bump `package.json` `version` (semver: patch for fixes, minor for features, major for breaking).
2. Add a `## [X.Y.Z] - YYYY-MM-DD` entry to `CHANGELOG.md`. Update the `[Unreleased]` compare link at the bottom and add the new version's release-tag link.
3. Run `npm install` so `package-lock.json` picks up the bumped version.
4. Commit: `chore(release): vX.Y.Z — <one-line summary>`.
5. Push commit: `git push origin main`.
6. Tag: `git tag -a vX.Y.Z -m "vX.Y.Z — <summary>"`.
7. Push tag: `git push origin vX.Y.Z` ← this fires the publish workflow.

The workflow:
- Runs only on `v*.*.*` tag pushes (not branch pushes).
- Refuses to publish if the git tag does not match `package.json` `version`.
- Runs `npm run verify` (typecheck + tests + build) as a hard gate.
- Publishes via the `NPM_TOKEN` repo secret.
- Generates SLSA build provenance via OIDC; the published artifact gets the green "verified provenance" badge on npm linking back to the exact source commit + workflow run.

Watch the run: `gh run watch <run-id>` or the Actions tab on GitHub.

## When something fails

`gh run view <run-id> --log-failed` shows the failed step's logs. Common modes:

**`npm 403 Forbidden` on publish.** Token lost permissions, expired, or was scoped too narrowly. Regenerate the `NPM_TOKEN` repo secret, then `gh run rerun <run-id> --failed` to retry without re-pushing the tag.

**Tag/version mismatch.** `package.json` version doesn't match the tag name. Either bump `package.json` and commit (then move the tag to the new commit) or recut with the right tag.

**Test failure.** Fix the bug. If you want to keep the same version number: `git tag -d vX.Y.Z` and `git push origin :refs/tags/vX.Y.Z` to remove, then re-tag once fixed. Otherwise bump and recut.

**Provenance attestation rejected (`422 Unprocessable Entity`).** npm's provenance verifier rejects private GitHub source repos. Either flip the repo to public before tagging, or temporarily drop `--provenance` from the publish workflow and the `provenance` flag from `package.json`'s `publishConfig`.

## NPM_TOKEN

The publish workflow requires an `NPM_TOKEN` repository secret. Generate a granular access token with read-and-write permission on `psy-core` at npmjs.com, store it under repository secrets, and rotate annually. Configure 2FA-bypass on the token if your npm account has 2FA enabled — automated CI cannot complete an OTP challenge.
