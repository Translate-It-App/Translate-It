# Contributing to Translate It!

Thanks for helping improve Translate It! This guide covers how to find work, set up the project, validate changes, and submit a pull request.

## Getting Started

1. Check the [roadmap](https://github.com/orgs/Translate-It-App/projects/2), [Issues](https://github.com/Translate-It-App/Translate-It/issues), and [Discussions](https://github.com/Translate-It-App/Translate-It/discussions) for related work before starting; look for `good first issue` and `help wanted` labels. Issue Priority and Effort fields indicate relative urgency and complexity. Small, independent fixes can go directly to a PR.
2. Use Issues for actionable work and Discussions for early ideas, research, and questions. Before substantial changes (such as features, major UI/architecture work, or refactors), discuss scope on the relevant Issue. Coordinate before duplicating assigned or in-progress work.
3. Fork the repository, clone your fork, and create a branch. Run relevant local checks, then open a PR to upstream `main`. You can open a **Draft PR** to run GitHub Actions CI; code changes receive full validation. Address CI failures and finish the implementation before selecting **Ready for review**; selecting it does not itself rerun CI. Include a clear summary, link relevant Issues, and report validation you ran.

Maintainers decide assignments, priorities, scope, review, and merging; discussion, approval of an idea, and passing CI do not guarantee acceptance. Review may request revisions, and no timeline or turnaround is guaranteed. Roadmap `Ready` means prepared for implementation, not approved or available.

Keep ordinary collaboration public in Issues, Discussions, and PRs. Report vulnerabilities privately through [GitHub Private Vulnerability Reporting](../../SECURITY.md); do not post exploitable details publicly. Ordinary bugs belong in Issues. For commercial partnerships, see [PARTNERSHIPS.md](../../PARTNERSHIPS.md).

For non-coding help, see the [Translation Guide](./LOCALIZATION_GUIDE.md).

## Development Setup

Install [Node.js](https://nodejs.org/) 22.22.2+ in the 22.x line, 24.15.0+ in the 24.x line, or 26+, and [pnpm 12.11.2](https://pnpm.io/), the version pinned by the project and CI. Clone your fork (replace `YOUR_USERNAME` with your GitHub username):

```bash
git clone https://github.com/YOUR_USERNAME/Translate-It.git
cd Translate-It
git remote add upstream https://github.com/Translate-It-App/Translate-It.git
pnpm run setup
```

Setup checks tool versions and installs dependencies; it does not build or validate the extensions. The release-script tests require `git`, `bash`, and `jq` on `PATH` (on Windows, Git for Windows supplies `git` and `bash`).

## Development

Build a development extension or start a watch build:

```bash
pnpm run dev:chrome
pnpm run dev:firefox
pnpm run watch:chrome
pnpm run watch:firefox
```

Builds are written to `dist/chrome/Translate-It-v<version>/` and `dist/firefox/Translate-It-v<version>/`.

Load the Chrome build from `chrome://extensions` with Developer mode and **Load unpacked**. In Firefox, use `about:debugging` → **This Firefox** → **Load Temporary Add-on** and select the build's `manifest.json`. After a watch rebuild, reload the extension and refresh pages to reload content scripts. For logging setup and browser-specific DevTools instructions, see the [Logging System Guide](../technical/LOGGING_SYSTEM.md).

### Firefox Android

With ADB, an authorized USB-debugging device, and Firefox Android installed, run `pnpm run dev:android` for a build and deployment or `pnpm run watch:android` to redeploy build changes. For continuous development, run `pnpm run watch:firefox` and `pnpm run watch:android` in separate terminals. Select a device with `--device=<id>` or `ANDROID_DEVICE`; otherwise the runner auto-detects one.

## Code Quality and Validation

Running the full test suite locally can be time-consuming and resource-intensive, depending on your system. Run relevant tests and checks locally; the full test suite is optional. Browser-specific changes may still need manual testing. `pnpm run pre-submit` is an optional local check that runs lint, style lint, and a production build; it does not run tests or extension validation.

```bash
pnpm run test:run                 # all tests (optional locally)
pnpm run test:run path/to/test.js # focused test
pnpm run lint
pnpm run lint:styles
pnpm run validate
pnpm run pre-submit               # optional
```

Formatting is optional and limited to explicitly named files, for example `pnpm run format src/path/to/file.js`. ESLint and Stylelint are authoritative within their configured scopes; follow nearby conventions and review your diff to avoid unrelated formatting changes.

### Pull Request CI

CI runs when a PR is opened, reopened, or updated with commits, including Draft PRs. First-time external contributors may need maintainer approval before CI runs. A lightweight Preflight check runs first:

- Docs/metadata-only changes skip full validation; code, config, runtime, or unrecognized changes run JavaScript and style lint, localization checks, tests, build, and extension validation. If changes cannot be classified, Preflight runs full CI.
- Preflight considers the PR's complete changes against `main`, so a docs-only push still runs full CI if the PR also contains code or configuration changes.
- Do not delete or rename `docs/Changelog.md`; it is bundled into the extension and Preflight will fail.

Relevant pushes to `main` run full CI; docs/metadata-only pushes run Preflight and skip full validation. For release and development-package information, see [Packaging and Releases](./RELEASING.md).
