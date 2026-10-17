import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const validatorPath = join(root, "scripts/localization/validate-i18n.cjs");

function runValidator(args = []) {
  return spawnSync(process.execPath, [validatorPath, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
  });
}

function withFixture(catalogs, callback) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "localization-validation-"));
  const localesDir = join(fixtureRoot, "_locales");
  const manifestPath = join(fixtureRoot, "LocaleManifest.js");

  try {
    const localeCodes = Object.keys(catalogs);
    const declarations = localeCodes
      .map((code) => `  { code: '${code}', name: '${code}' },`)
      .join("\n");
    writeFileSync(
      manifestPath,
      `export const UI_LOCALES = [\n${declarations}\n];\n`,
      "utf8",
    );

    for (const [locale, catalog] of Object.entries(catalogs)) {
      const localeDir = join(localesDir, locale);
      mkdirSync(localeDir, { recursive: true });
      writeFileSync(
        join(localeDir, "messages.json"),
        typeof catalog === "string"
          ? catalog
          : `${JSON.stringify(catalog, null, 2)}\n`,
        "utf8",
      );
    }

    const result = runValidator([
      "--manifest",
      manifestPath,
      "--locales-dir",
      localesDir,
    ]);
    callback(result);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

describe("localization validation", () => {
  it("passes the current catalogs and is wired into package scripts and CI", () => {
    const packageJson = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    );
    const workflow = readFileSync(
      join(root, ".github/workflows/ci.yml"),
      "utf8",
    );

    expect(packageJson.scripts["i18n:validate"]).toBe(
      "node scripts/localization/validate-i18n.cjs",
    );
    expect(workflow).toContain("run: pnpm run i18n:validate");

    const result = runValidator();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Localization validation passed for");
  });

  it("accepts empty messages and matching placeholder definitions", () => {
    const english = {
      empty_allowed: { message: "" },
      greeting: {
        message: "Hello $NAME$",
        placeholders: { name: { content: "$1", example: "Ada" } },
      },
      numbered_placeholder: {
        message: "Hello $1NAME$",
        placeholders: { "1name": { content: "$1" } },
      },
    };
    const translated = {
      empty_allowed: { message: "" },
      greeting: {
        message: "Welcome $NAME$",
        placeholders: { name: { content: "$1", example: "Ada" } },
      },
      numbered_placeholder: {
        message: "Welcome $1NAME$",
        placeholders: { "1name": { content: "$1" } },
      },
    };

    withFixture({ en: english, fa: translated, ja: translated }, (result) => {
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    });
  });

  it("reports malformed JSON with the affected file", () => {
    const valid = { greeting: { message: "Hello" } };

    withFixture({ en: valid, fa: valid, ja: "{ invalid json" }, (result) => {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ja");
      expect(result.stderr).toContain("messages.json: malformed JSON");
    });
  });

  it("reports missing, extra, and invalid message entries", () => {
    const english = {
      greeting: { message: "Hello" },
      farewell: { message: "Goodbye" },
    };
    const invalid = {
      greeting: { message: 42 },
      unexpected: { message: "Extra" },
    };

    withFixture({ en: english, fa: invalid, ja: english }, (result) => {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'key "greeting" must have a string message field',
      );
      expect(result.stderr).toContain('missing key "farewell"');
      expect(result.stderr).toContain('extra key "unexpected"');
    });
  });

  it("reports placeholder definitions that differ from English", () => {
    const english = {
      greeting: {
        message: "Hello $NAME$",
        placeholders: { name: { content: "$1" } },
      },
      welcome: {
        message: "Welcome $NAME$",
        placeholders: { name: { content: "$1" } },
      },
    };
    const invalid = {
      greeting: {
        message: "Hello $NAME$",
        placeholders: { name: { content: "$2" } },
      },
      welcome: {
        message: "Welcome $USER$",
        placeholders: { name: { content: "$1" } },
      },
    };

    withFixture({ en: english, fa: invalid, ja: english }, (result) => {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'key "greeting" placeholder "name" content must match the English reference',
      );
      expect(result.stderr).toContain(
        'key "welcome" message references undefined placeholder "user"',
      );
    });
  });
});
