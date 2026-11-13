# Packaging and Releases

## Package for Distribution

To create just the source archive:

```bash
pnpm run source
```

To build and validate both browser packages and create the source archive:

```bash
pnpm run publish
```

The output is in `dist/Publish/`:

- `Source-vX.X.X.zip`
- `Translate-It-vX.X.X-for-Chrome.zip`
- `Translate-It-vX.X.X-for-Firefox.zip`

## Create an Official Release (maintainers)

Official releases are prepared by the **Official Release** GitHub Actions workflow. Before starting, update `version` in `package.json` and add the matching, dated release heading and notes to [`docs/Changelog.md`](../Changelog.md) on `main`. The heading must match the version tag and use the date format expected by the workflow (for example, `#### v1.21.0 – Released on November 03, 2026`). The workflow checks the version and changelog section, pins preparation to `main`, and builds from the verified release commit.

1. In the repository's **Actions** tab, run **Official Release** and enter the version tag, for example `v1.21.0`.
2. When the workflow succeeds, inspect the Release draft, its generated notes, and both attached ZIPs (Chrome and Firefox). The notes combine the exact matching changelog section with GitHub-generated release notes. Review them carefully; edit if needed.
3. Only after review, manually publish the draft as a stable release: do not mark it as a prerelease, and mark it as the latest release.

The workflow leaves the Release as a draft and fails closed on errors or unexpected state. It never moves or overwrites an existing version tag. A verified interrupted draft for the same version may be resumed; conflicts or other unexpected state must be resolved rather than bypassed.

## Development Build

Successful relevant CI runs on pushes to `main` automatically publish or update the rolling **Development Build** GitHub Pre-release with Chrome and Firefox ZIPs. It is a prerelease for development testing, not an official stable release.
