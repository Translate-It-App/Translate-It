# Contributing to Translate It!

Thank you for your interest in Translate It! The workflow below helps you find useful work, choose the right channel, coordinate changes, and submit them for review.

## Getting Started

1. **Find existing work.** Browse the public [Translate It Roadmap](https://github.com/orgs/Translate-It-App/projects/2), then search [GitHub Issues](https://github.com/Translate-It-App/Translate-It/issues) and [Discussions](https://github.com/Translate-It-App/Translate-It/discussions) for related work. Add context to an existing item rather than creating a duplicate. Look for `good first issue` and `help wanted` labels when available. The roadmap needs no permission or edit access to browse.
2. **Choose a channel.** Use Issues for actionable bugs, feature requests, enhancements, documentation, and technical debt; feature requests need no prior approval. See the [Project Backlog](../Backlog.md) for detailed tracking rules. Use Discussions for early ideas, research, architecture or product discussion, and Q&A. When a Discussion becomes actionable, create an Issue or link it to an existing one. Small independent fixes (such as typos, minor documentation corrections, and straightforward bug fixes) may go directly to a PR without an Issue.
3. **Coordinate before substantial work.** Comment on the relevant Issue to express interest and discuss scope before beginning substantial changes, including new features, major UI/UX or architectural changes, and substantial refactors. Do not duplicate assigned or in-progress work without coordinating with the maintainer. Design suggestions and feedback are welcome on existing Issues, including those assigned to someone else.
4. **Make and validate your change.** Fork the repository, create a branch, and implement the change. Run relevant checks locally (see [Code Quality and Validation](#code-quality-and-validation)); running the full test suite locally is optional. Browser-specific changes may still need manual testing.
5. **Submit a pull request.** Open a PR from your fork's branch to upstream `main`. You can open it as a **Draft PR** to use GitHub Actions CI for full validation. Address CI failures and finish the implementation before selecting **Ready for review**. Include a clear title and summary, link relevant Issues when applicable, and report the validation you ran.

The roadmap's `Ready` status means work has been prepared for implementation; it does not mean it is available. An unassigned Issue is not necessarily approved for implementation, and expressing interest is neither ownership nor a guarantee of acceptance. Maintainers control assignments, priorities, scope, review, and merge decisions; prior discussion or approval of an idea and passing CI do not guarantee that an implementation will be accepted or merged. Review may request revisions, and a particular assignment, timeline, or review turnaround is not guaranteed.

Issues also carry Organization Issue Fields describing relative urgency and complexity: **Priority** (`Urgent`, `High`, `Medium`, `Low`) and **Effort** (`Small`, `Medium`, `Large`). These complement the Roadmap's `Status` and help gauge a task before starting.

Keep ordinary collaboration public and traceable in Issues, Discussions, and PRs; uncertainty can be discussed there, and questions are welcome. Use Issue comments for coordination rather than private messages. Report sensitive vulnerabilities privately through GitHub Private Vulnerability Reporting as described in [SECURITY.md](../../SECURITY.md); do not post exploitable details in public Issues, Discussions, or PRs (ordinary bugs belong in Issues). For commercial partnerships, see [PARTNERSHIPS.md](../../PARTNERSHIPS.md) or email [partnerships@translate-it.app](mailto:partnerships@translate-it.app).

---

## Help with Localization

If you'd like to localize **Translate It!** into your language.

We have a dedicated **[Translation Guide](./LOCALIZATION_GUIDE.md)** that explains:
- How to translate strings without any coding knowledge.
- How to use simple commands to sync translation keys.

*Even if you aren't a developer, you can still help by translating the strings in the locale files!*


## 🛠 Development Notes

### Prerequisites

Install [**Node.js 22.22.2 or later in the 22.x line, Node.js 24.15.0 or later in the 24.x line, or Node.js 26+**](https://nodejs.org/) and [**pnpm 12.11.2**](https://pnpm.io/) (the version pinned by the project and CI). Clone upstream to build or explore the project; to contribute, clone your fork instead. Run setup from either clone:

```bash
git clone https://github.com/Translate-It-App/Translate-It.git
cd Translate-It
pnpm run setup
```

The `scripts/ci/*.test.js` tests execute the release shell scripts, so they also require `git`, `bash`, and `jq` on `PATH`. On Windows, install [Git for Windows](https://git-scm.com/download/win) (which provides `git` and `bash`) and a `jq` executable. The preflight tests use the real `git` with temporary local repositories; the release tests mock the GitHub CLI (`gh`) and other relevant commands. None of these tests make real GitHub API calls.

`pnpm run setup` checks the required tool versions and runs `pnpm install --frozen-lockfile`. It does not build the extensions or run validation.

### Building for Development

To generate the unpacked extension files for development, run:

```bash
# One-time development build (does not watch for changes)
pnpm run dev:chrome
pnpm run dev:firefox

# Production build for both browsers in parallel (optimized, with ZIP packages)
pnpm run build

# Production build for a specific browser
pnpm run build:chrome
pnpm run build:firefox
```

Development builds preserve console calls and skip production minification; production builds apply optimizations and create ZIP packages. Both build types use versioned output folders: `dist/chrome/Translate-It-v<version>/` and `dist/firefox/Translate-It-v<version>/`, where `<version>` is read from `package.json`.

To load a development build, open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**, selecting the Chrome output folder. In Firefox, open `about:debugging` → **This Firefox** → **Load Temporary Add-on**, and select `manifest.json` inside the Firefox output folder.

To actively develop and apply changes in real time, use the following commands:

```bash
# Watch for changes (0 ms delay by default; preserves existing behavior)
pnpm run watch:chrome
pnpm run watch:chrome --delay=30000
pnpm run watch:firefox
pnpm run watch:firefox --delay=30000
```

The optional `--delay` is a non-negative integer number of milliseconds. The initial build starts immediately; after a change, a rebuild waits until no further changes occur for the specified duration. The default is `0`, preserving the existing rebuild behavior. Watch builds update the output files but do not automatically reload the extension. Reload it in `chrome://extensions` or `about:debugging` after a rebuild; refresh open pages as well to reload content scripts, and reopen extension views such as the popup or Options page.

### Viewing Logs and Debug Mode

Development builds do not strip console calls, but the logging system defaults each component to **Warn**, so Debug-level messages are hidden until enabled. To enable targeted debug output:

1. Open **Options** → **Advance** and check **Debug Mode**.
2. Expand the **Debug Mode** section and find the component you want to inspect.
3. Change that component from **Warn** (the default) to **Debug**. Log levels are ordered **Error (0)**, **Warn (1)**, **Info (2)**, **Debug (3)**; selecting Debug shows all levels for that component. Prefer changing only the relevant component.
4. Choose **Save Settings** in the Options navigation. If settings appear stale, reload the extension and refresh the page or reopen the extension view.

Debug Mode enables global `SafeConsole` output but does not raise component levels by itself. When finished, restore changed components to **Warn**, turn off **Debug Mode**, and save settings again. See [Logging System](../technical/LOGGING_SYSTEM.md) for advanced details.

Open DevTools for the context that produced the message; extension contexts have separate consoles:

- **Content scripts:** inspect the webpage tab. In Chrome, select the extension/content-script context from the Console context dropdown; in Firefox, use that page's DevTools.
- **Background:** in Chrome, open `chrome://extensions` and choose **Inspect views** for the service worker. In Firefox, open `about:debugging` → **This Firefox** → **Inspect** for the extension, then use its Console; Firefox uses an event page, not a service worker.
- **Popup:** in Chrome, right-click the open popup and choose **Inspect**. In Firefox, open the extension Toolbox and select the popup in its page selector (disable popup auto-hide if needed).
- **Options:** inspect the Options tab in Chrome; in Firefox, use the extension Toolbox to select the Options iframe.
- **Side Panel:** in Chrome, right-click the open panel and choose **Inspect**. In Firefox, use the extension Toolbox document selector to choose the sidebar.

Before sharing logs, redact API keys, credentials, private text, and other sensitive data. See the browser guides for [Chrome](https://developer.chrome.com/docs/extensions/get-started/tutorial/debug) and [Firefox](https://extensionworkshop.com/documentation/develop/debugging/) for more debugging details.

### Firefox Android Development

Prerequisites: ADB installed, a connected and authorized Android device (USB debugging on), and Firefox Android installed on the device.

```bash
# One-time Firefox development build, then deploy to the device
pnpm run dev:android

# Deploy the existing build; web-ext watches the build output for changes
pnpm run watch:android
```

For continuous development, run `watch:firefox` and `watch:android` in separate terminals: the first rebuilds on source changes, the second redeploys the build output to the device.

Select a device with `--device=<id>` (for example `pnpm run dev:android -- --device=emulator-5554`) or the `ANDROID_DEVICE` environment variable; otherwise the runner auto-detects a connected device, preferring USB. Without a usable device it exits with an error before deploying.

### Code Quality and Validation

Running the full test suite locally can be time-consuming and resource-intensive, depending on your system. Run relevant tests and checks locally, and use a Draft PR to let GitHub Actions CI perform full validation.

#### Linting

To ensure code quality and catch potential issues early, you can run ESLint and Stylelint:

```bash
# Run tests
pnpm run test:run

# Run one test file
pnpm run test:run src/shared/logging/logConstants.test.js

# Lint JS source code
pnpm run lint

# Lint CSS styles
pnpm run lint:styles

# Format only the files you changed (optional; requires explicit paths)
pnpm run format src/path/to/file.js
```

Formatting is optional. Running `pnpm run format` without file paths prints usage and exits without reading stdin or modifying files.

Recommended flow: make changes, format only the touched files if useful, run relevant lint and tests, then review `git diff` before committing. The full test suite and `pnpm run pre-submit` are optional local checks; use CI for full validation when helpful.

#### Coding Style

ESLint (JS/Vue) and Stylelint (CSS/SCSS) are the linting authorities within their configured scopes; keep their rules passing. Prettier stays optional and manual, formatting only explicitly passed files. Some Prettier-formatted Vue files may still report ESLint warnings (indent/closing-bracket); the lint rules take precedence and are not relaxed. When modifying existing files, follow the nearby established conventions, and always review the formatting diff so unrelated lines are not swept in. Broader formatting adoption happens gradually through separate formatting-only PRs, never mixed into feature or fix work.

#### Extension Validation

Validate the built extensions to ensure they meet browser store requirements:

```bash
# Validate both browsers
pnpm run validate

# Validate specific browsers
pnpm run validate:firefox
pnpm run validate:chrome
```

`web-ext` is included in the project dependencies. `pnpm run setup:chrome-validator` remains available as a legacy fallback if it is missing locally.

#### Pre-submission Workflow

As an optional local check, you can run the comprehensive pre-submission check:

```bash
pnpm run pre-submit
```

This command runs ESLint, Stylelint, and the production build. It does not run tests or validation, so it is not a replacement for full CI, where tests and validation still run.

#### PR CI Behavior

CI runs on every pull request when it is opened, reopened, or updated with new commits, including Draft PRs. Selecting **Ready for review** does not itself rerun CI. A lightweight Preflight check runs first:

For first-time external contributors, CI may require maintainer approval before it runs.

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
