/**
 * Read-only validation for extension localization catalogs.
 *
 * Usage:
 *   pnpm i18n:validate
 */

const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..", "..");
const DEFAULT_LOCALES_DIR = path.join(projectRoot, "src", "_locales");
const DEFAULT_MANIFEST_PATH = path.join(
  projectRoot,
  "src",
  "shared",
  "config",
  "LocaleManifest.js",
);
const REFERENCE_LOCALE = "en";
const ALLOWED_ENTRY_FIELDS = new Set([
  "message",
  "description",
  "placeholders",
  "note",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readManifestLocales(manifestPath, errors) {
  let source;

  try {
    source = fs.readFileSync(manifestPath, "utf8");
  } catch (error) {
    errors.push(
      `${manifestPath}: unable to read locale manifest (${error.message})`,
    );
    return [];
  }

  const declaration = source.match(
    /export\s+const\s+UI_LOCALES\s*=\s*\[([\s\S]*?)\];/,
  );
  if (!declaration) {
    errors.push(`${manifestPath}: unable to find the UI_LOCALES declaration`);
    return [];
  }

  const locales = [
    ...declaration[1].matchAll(/\bcode\s*:\s*['"]([^'"]+)['"]/g),
  ].map((match) => match[1]);

  if (locales.length === 0) {
    errors.push(
      `${manifestPath}: UI_LOCALES does not declare any locale codes`,
    );
    return [];
  }

  const duplicateLocales = locales.filter(
    (locale, index) => locales.indexOf(locale) !== index,
  );
  for (const locale of new Set(duplicateLocales)) {
    errors.push(`${manifestPath}: duplicate locale code "${locale}"`);
  }

  if (!locales.includes(REFERENCE_LOCALE)) {
    errors.push(
      `${manifestPath}: reference locale "${REFERENCE_LOCALE}" is not declared`,
    );
  }

  return [...new Set(locales)];
}

function readCatalog(filePath, errors) {
  let source;

  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    errors.push(`${filePath}: unable to read catalog (${error.message})`);
    return null;
  }

  let catalog;
  try {
    catalog = JSON.parse(source);
  } catch (error) {
    errors.push(`${filePath}: malformed JSON (${error.message})`);
    return null;
  }

  if (!isPlainObject(catalog)) {
    errors.push(`${filePath}: catalog root must be a JSON object`);
    return null;
  }

  return catalog;
}

function referencedPlaceholderNames(message) {
  const names = new Set();
  for (const match of message.matchAll(/\$([A-Za-z0-9_@]+)\$/g)) {
    names.add(match[1].toLowerCase());
  }
  return names;
}

function validatePlaceholders(filePath, key, message, placeholders, errors) {
  if (!isPlainObject(placeholders)) {
    errors.push(`${filePath}: key "${key}" placeholders must be an object`);
    return new Map();
  }

  const definitions = new Map();
  for (const name of Object.keys(placeholders)) {
    const normalizedName = name.toLowerCase();
    const placeholder = placeholders[name];
    if (definitions.has(normalizedName)) {
      errors.push(
        `${filePath}: key "${key}" has duplicate placeholder "${name}" when compared case-insensitively`,
      );
    }

    if (!isPlainObject(placeholder)) {
      errors.push(
        `${filePath}: key "${key}" placeholder "${name}" must be an object`,
      );
      continue;
    }

    if (typeof placeholder.content !== "string") {
      errors.push(
        `${filePath}: key "${key}" placeholder "${name}" must have a string content field`,
      );
    }

    if (
      Object.hasOwn(placeholder, "example") &&
      typeof placeholder.example !== "string"
    ) {
      errors.push(
        `${filePath}: key "${key}" placeholder "${name}" example must be a string`,
      );
    }

    definitions.set(normalizedName, {
      content: placeholder.content,
      displayName: name,
    });
  }

  if (typeof message === "string") {
    const referenced = referencedPlaceholderNames(message);
    for (const name of referenced) {
      if (!definitions.has(name)) {
        errors.push(
          `${filePath}: key "${key}" message references undefined placeholder "${name}"`,
        );
      }
    }
    for (const [name, definition] of definitions) {
      if (!referenced.has(name)) {
        errors.push(
          `${filePath}: key "${key}" declares unused placeholder "${definition.displayName}"`,
        );
      }
    }
  }

  return definitions;
}

function validateCatalogStructure(filePath, catalog, errors) {
  const placeholderNames = new Map();

  for (const [key, entry] of Object.entries(catalog)) {
    if (!isPlainObject(entry)) {
      errors.push(`${filePath}: key "${key}" must map to a message object`);
      continue;
    }

    for (const field of Object.keys(entry)) {
      if (!ALLOWED_ENTRY_FIELDS.has(field)) {
        errors.push(`${filePath}: key "${key}" has unknown field "${field}"`);
      }
    }

    if (typeof entry.message !== "string") {
      errors.push(`${filePath}: key "${key}" must have a string message field`);
    }

    for (const field of ["description", "note"]) {
      if (Object.hasOwn(entry, field) && typeof entry[field] !== "string") {
        errors.push(`${filePath}: key "${key}" ${field} must be a string`);
      }
    }

    if (Object.hasOwn(entry, "placeholders")) {
      placeholderNames.set(
        key,
        validatePlaceholders(
          filePath,
          key,
          entry.message,
          entry.placeholders,
          errors,
        ),
      );
    } else {
      placeholderNames.set(key, new Map());
    }
  }

  return placeholderNames;
}

function compareCatalogs(
  filePath,
  referenceCatalog,
  catalog,
  referencePlaceholders,
  placeholders,
  errors,
) {
  const referenceKeys = Object.keys(referenceCatalog);
  const catalogKeys = Object.keys(catalog);
  const catalogKeySet = new Set(catalogKeys);
  const referenceKeySet = new Set(referenceKeys);

  for (const key of referenceKeys) {
    if (!catalogKeySet.has(key)) {
      errors.push(`${filePath}: missing key "${key}"`);
    }
  }

  for (const key of catalogKeys) {
    if (!referenceKeySet.has(key)) {
      errors.push(`${filePath}: extra key "${key}"`);
    }
  }

  for (const key of referenceKeys) {
    if (!catalogKeySet.has(key)) continue;

    const expected = referencePlaceholders.get(key) || new Map();
    const actual = placeholders.get(key) || new Map();
    const expectedNames = [...expected.keys()].sort();
    const actualNames = [...actual.keys()].sort();
    if (expectedNames.join("\0") !== actualNames.join("\0")) {
      errors.push(
        `${filePath}: key "${key}" placeholders must match the English reference ` +
          `(expected: ${expectedNames.join(", ") || "none"}; actual: ${actualNames.join(", ") || "none"})`,
      );
    }

    for (const name of expectedNames) {
      if (!actual.has(name)) continue;
      const expectedContent = expected.get(name).content;
      const actualContent = actual.get(name).content;
      if (expectedContent !== actualContent) {
        errors.push(
          `${filePath}: key "${key}" placeholder "${name}" content must match the English reference ` +
            `(expected: ${JSON.stringify(expectedContent)}; actual: ${JSON.stringify(actualContent)})`,
        );
      }
    }
  }
}

function validateLocalization({
  localesDir = DEFAULT_LOCALES_DIR,
  manifestPath = DEFAULT_MANIFEST_PATH,
} = {}) {
  const errors = [];
  const locales = readManifestLocales(manifestPath, errors);
  const catalogs = new Map();
  const placeholders = new Map();

  for (const locale of locales) {
    const filePath = path.join(localesDir, locale, "messages.json");
    const catalog = readCatalog(filePath, errors);
    if (!catalog) continue;

    catalogs.set(locale, { filePath, catalog });
    placeholders.set(
      locale,
      validateCatalogStructure(filePath, catalog, errors),
    );
  }

  const reference = catalogs.get(REFERENCE_LOCALE);
  if (reference) {
    for (const locale of locales) {
      if (locale === REFERENCE_LOCALE) continue;

      const target = catalogs.get(locale);
      if (!target) continue;

      compareCatalogs(
        target.filePath,
        reference.catalog,
        target.catalog,
        placeholders.get(REFERENCE_LOCALE),
        placeholders.get(locale),
        errors,
      );
    }
  }

  return {
    errors,
    locales,
    messageCount: reference ? Object.keys(reference.catalog).length : 0,
  };
}

function parseArguments(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--locales-dir" || argument === "--manifest") {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a path`);
      options[argument === "--locales-dir" ? "localesDir" : "manifestPath"] =
        path.resolve(value);
      index += 1;
      continue;
    }

    throw new Error(`unknown argument: ${argument}`);
  }

  return options;
}

function runCli(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(args);
  } catch (error) {
    console.error(`Localization validation failed: ${error.message}`);
    return 1;
  }

  const result = validateLocalization(options);
  if (result.errors.length > 0) {
    console.error("Localization validation failed:");
    for (const error of result.errors) console.error(`- ${error}`);
    return 1;
  }

  console.log(
    `Localization validation passed for ${result.locales.length} locales ` +
      `and ${result.messageCount} reference messages.`,
  );
  return 0;
}

if (require.main === module) {
  process.exitCode = runCli();
}

module.exports = {
  validateLocalization,
  runCli,
};
