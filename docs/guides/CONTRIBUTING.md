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

## Technical Documentation

For a deeper dive into the architecture and system design, please refer to:
- [Architecture Overview](../technical/ARCHITECTURE.md)
- [Desktop FAB System](../technical/DESKTOP_FAB_SYSTEM.md)
- [Mobile Support Architecture](../technical/MOBILE_SUPPORT.md)
- [Translation Provider Logic](../technical/TRANSLATION_PROVIDER_LOGIC.md)
- [Messaging System](../technical/MessagingSystem.md)
- [And more in the docs folder...](../technical/)
