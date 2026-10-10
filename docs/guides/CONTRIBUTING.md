# Contributing to Translate It!

This document provides instructions for setting up the project locally and the workflow for making changes.

## How to Contribute

We welcome contributions of all kinds! While we have a recommended workflow to keep things organized, we aren't overly strict. The most important thing is that your contribution is clear and easy to understand.

### Recommended Workflow:

1. **Fork the Repository**: Create your own copy of the project.
2. **Create a Branch**: It’s helpful to use a descriptive name like `feature/new-button` or `fix/typo`.
3. **Make Your Changes**: Implement your feature or fix.
4. **Validation**: It's a good idea to run a quick lint/build check (see [Code Quality](#code-quality-and-validation)) to ensure everything is working correctly.
5. **Submit a Pull Request (PR)**:
   - Give your PR a clear title (preferably naming the feature or fix you added).
   - Briefly explain what you’ve changed.

*Don't worry if you don't follow every step perfectly—we're happy to help you through the process!*

---

## Help with Localization

If you'd like to localize **Translate It!** into your language.

We have a dedicated **[Translation Guide](./LOCALIZATION_GUIDE.md)** that explains:
- How to translate strings without any coding knowledge.
- How to use simple commands to sync translation keys.

*Even if you aren't a developer, you can still help by translating the strings in the locale files!*


## 🛠 Development Notes

### Prerequisites

Make sure [**Node.js**](https://nodejs.org/) and [**pnpm**](https://pnpm.io/) are installed. Then, clone the repository and install the dependencies:

```bash
git clone https://github.com/Translate-It-App/Translate-It.git
cd Translate-It
pnpm install
```

The `scripts/ci/*.test.js` tests execute the release shell scripts, so they also require `git`, `bash`, and `jq` on `PATH`. On Windows, install [Git for Windows](https://git-scm.com/download/win) (which provides `git` and `bash`) and a `jq` executable. The preflight tests use the real `git` with temporary local repositories; the release tests mock the GitHub CLI (`gh`) and other relevant commands. None of these tests make real GitHub API calls.

### Initial Setup

After installing dependencies, run the setup command to ensure all development tools are configured:

```bash
pnpm run setup
```

This will configure the development environment and install any additional tools needed for validation.

### Building for Development

To generate the unpacked extension files for development, run:

```bash
# Build for both browsers (Parallel)
pnpm run build

# Build for a specific browser
pnpm run build:chrome
pnpm run build:firefox
```

To actively develop and apply changes in real time, use the following commands:

```bash
# Watch for changes
pnpm run watch:chrome
pnpm run watch:firefox
```

### Code Quality and Validation

#### Linting

To ensure code quality and catch potential issues early, you can run ESLint and Stylelint:

```bash
# Lint JS source code
pnpm run lint

# Lint CSS styles
pnpm run lint:styles

# Format code with Prettier
pnpm run format
```

#### Extension Validation

Validate the built extensions to ensure they meet browser store requirements:

```bash
# Validate both browsers
pnpm run validate

# Validate specific browsers
pnpm run validate:firefox
pnpm run validate:chrome
```

**Note:** For Chrome validation, you need `web-ext` installed. If it's not available, install it with:

```bash
pnpm run setup:chrome-validator
```

#### Pre-submission Workflow

Before submitting your changes, run the comprehensive pre-submission check:

```bash
pnpm run pre-submit
```

This command runs linting (JS & Styles) and builds the extension.

#### PR CI Behavior

CI runs on every pull request when it is opened, reopened, or updated with new commits. A lightweight Preflight check runs first:

- Docs/metadata-only changes skip full validation and finish quickly.
- Code, config, runtime, or unrecognized changes run the full CI (lint, tests, build, validate).
- If a PR cannot be classified (e.g. GitHub API trouble), Preflight falls back to full CI to be safe.
- Do not delete or rename `docs/Changelog.md` — it is bundled into the extension, so Preflight fails the PR in that case.

Preflight evaluates the PR's full set of changes against `main`, not only the latest commit. A docs-only push will still run full CI if the PR also contains code or configuration changes.

Relevant pushes to `main` run the same lint, Stylelint, tests, build, and validation checks. Docs/metadata-only pushes run Preflight and skip full CI. Successful relevant builds on `main` update a rolling `Development Build` GitHub Pre-release containing Chrome and Firefox development ZIPs; these are not official stable releases. Official GitHub Releases (versioned stable releases) remain authoritative attested packages.

### Packaging for Distribution

When you are ready to create distributable packages, use the following commands.

**To package the source code:**

This command creates a `.zip` archive of the project's source files, named `Source-vX.X.X.zip`.

```bash
pnpm run source
```

**To create a full release:**

This command bundles everything. It creates the source code archive and builds the final, installable `.zip` packages for both browsers.

```bash
pnpm run publish
```

After running, the `dist/Publish` directory will contain:

- `Source-vX.X.X.zip`
- `Translate-It-vX.X.X-for-Chrome.zip`
- `Translate-It-vX.X.X-for-Firefox.zip`

### Creating an Official Release (maintainers)

Official release artifacts are prepared by GitHub Actions. The manually started `Official Release` workflow prepares or resumes the version tag and **draft** Release, builds and attests the Chrome/Firefox ZIPs, attaches them, and verifies the tag, Release, and exact asset set. For a new Draft, it automatically prepares complete release notes from the exact matching `docs/Changelog.md` entry (including its date) plus GitHub-generated release notes. It leaves the verified Release as a draft; the maintainer should then:

1. Inspect the Draft Release, review its automatically prepared notes, and inspect both attached browser artifacts (Chrome and Firefox).
2. Optionally edit the release notes.
3. Manually publish it as a stable release, ensuring it is **not** marked as a prerelease and **is** marked as the latest release.

Before starting a release:

1. Bump `version` in `package.json` and add the matching `docs/Changelog.md` entry on `main` (the workflow requires the tag to match the packaged version).
2. In the repository's **Actions** tab, run the **Official Release** workflow and provide the version tag, for example `v1.21.0`.

The workflow fails closed: failures leave the Release as a draft. Existing version tags are never moved or overwritten, but a verified interrupted Draft for the same version may be resumed instead of duplicated. Conflicting or unexpected state fails closed.

## Technical Documentation

For a deeper dive into the architecture and system design, please refer to:
- [Architecture Overview](../technical/ARCHITECTURE.md)
- [Desktop FAB System](../technical/DESKTOP_FAB_SYSTEM.md)
- [Mobile Support Architecture](../technical/MOBILE_SUPPORT.md)
- [Translation Provider Logic](../technical/TRANSLATION_PROVIDER_LOGIC.md)
- [Messaging System](../technical/MessagingSystem.md)
- [And more in the docs folder...](../technical/)
