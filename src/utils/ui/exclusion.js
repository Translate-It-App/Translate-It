// src/utils/exclusion.js

// لیست سایت‌هایی که به صورت پیش‌فرض و همیشگی غیرفعال هستند
export const DEFAULT_EXCLUDED_SITES = [
  // "accounts.google.com",
  // "chrome.google.com/webstore",
  // "addons.mozilla.org",
  // "meet.google.com",
  // "acrobat.adobe.com",
  // "developer.chrome.com",
  // "docs.google.com",
  // "docs.microsoft.com",
  // "developers.google.com",
  // "ai.google.dev"
  // "t24.theorie24.de"
];

export const DEFAULT_EXCLUDED_TEXT_FIELDS_ICON = [
  "microsoftonline.com",
  "docs.microsoft.com",
  "cloud.microsoft",
  "word.cloud.microsoft",
  "excel.cloud.microsoft",
  "powerpoint.cloud.microsoft",
  "microsoft365.com",
  "word.office365.com",
  "excel.office365.com",
  "powerpoint.office365.com",
  "office.com",
  "live.com",
  "outlook.office.com",
  "word.office.com",
  "excel.office.com",
  "powerpoint.office.com",
  "excel.live.com",
  "powerpoint.live.com",
  "onedrive.live.com",
  "sharepoint.com",
  "acrobat.adobe.com",
  "docs.google.com/document",
  "docs.google.com/spreadsheets",
  "docs.google.com/presentation",
  "docs.google.com/forms",
  "docs.google.com/drawings",
  "docs.google.com/sites",
  "canva.com/design",
  "dochub.com",
  "edit-document.pdffiller.com",
  "zoho.com/writer",
  "zoho.com/sheet",
  "zoho.com/show",
];

/**
 * Build a stable exclusion key for a URL.
 * Web pages keep hostname-based exclusions, while local files use the file path.
 *
 * @param {string} url - URL to normalize
 * @returns {string} Normalized exclusion key, or empty string when URL is invalid
 */
export function getUrlExclusionKey(url) {
  if (!url || typeof url !== "string") return "";

  try {
    const urlObj = new URL(url);

    if (urlObj.protocol === "file:") {
      return `file://${urlObj.host}${urlObj.pathname}`;
    }

    return urlObj.hostname || "";
  } catch {
    return "";
  }
}

/**
 * Check whether a stored exclusion entry matches the current URL.
 *
 * @param {string} url - Current page URL
 * @param {string} exclusionEntry - Stored exclusion entry
 * @returns {boolean} True when the entry excludes the URL
 */
export function matchesExcludedEntry(url, exclusionEntry) {
  if (!url || !exclusionEntry) return false;

  const normalizedEntry = exclusionEntry.trim();
  if (!normalizedEntry) return false;

  const exclusionKey = getUrlExclusionKey(url);
  if (!exclusionKey) return false;

  if (normalizedEntry.startsWith("file://")) {
    return exclusionKey === normalizedEntry;
  }

  return url.includes(normalizedEntry);
}

/**
 * بررسی می‌کند که آیا یک URL در لیست پیش‌فرض مستثنی
 * برای قابلیت نمایش آیکون ترجمه در فیلد متنی است یا خیر
 * @param {string} url - آدرس صفحه‌ای که باید بررسی شود
 * @param {string[]} userExcludedSites - لیست سایت‌های مستثنی شده توسط کاربر (اختیاری)
 * @returns {boolean} - اگر URL باید مستثنی شود، true برمی‌گرداند
 */
export function isUrlExcluded_TEXT_FIELDS_ICON(url, userExcludedSites = []) {
  if (!url) return true; // URL نامعتبر را همیشه مستثنی کن

  // ۱. بررسی در لیست پیش‌فرض
  const isDefaultExcluded = DEFAULT_EXCLUDED_TEXT_FIELDS_ICON.some((site) =>
    url.includes(site),
  );
  if (isDefaultExcluded) {
    return true;
  }

  // ۲. بررسی در لیست کاربر
  const isUserExcluded = userExcludedSites.some((site) => matchesExcludedEntry(url, site));
  if (isUserExcluded) {
    return true;
  }

  return false;
}

/**
 * بررسی می‌کند که آیا یک URL در لیست پیش‌فرض یا لیست کاربر مستثنی شده است یا خیر
 * @param {string} url - آدرس صفحه‌ای که باید بررسی شود
 * @param {string[]} userExcludedSites - لیست سایت‌های مستثنی شده توسط کاربر
 * @returns {boolean} - اگر URL باید مستثنی شود، true برمی‌گرداند
 */
export function isUrlExcluded(url, userExcludedSites = []) {
  if (!url) return true; // URL نامعتبر را همیشه مستثنی کن

  // ۱. بررسی در لیست پیش‌فرض
  const isDefaultExcluded = DEFAULT_EXCLUDED_SITES.some((site) =>
    url.includes(site),
  );
  if (isDefaultExcluded) {
    return true;
  }

  // ۲. بررسی در لیست کاربر
  const isUserExcluded = userExcludedSites.some((site) => matchesExcludedEntry(url, site));
  if (isUserExcluded) {
    return true;
  }

  return false;
}

/**
 * Checks whether a URL matches a configured auto-translation rule.
 *
 * @param {string} url - Current page URL
 * @param {string} rule - Configured auto-translate rule
 * @returns {boolean} True if matched
 */
export function matchesAutoTranslateRule(url, rule) {
  if (!url || !rule) return false;

  const ruleClean = rule.trim();
  if (!ruleClean) return false;

  // 1. file:// rules: exact match only
  if (ruleClean.startsWith('file://')) {
    return url === ruleClean;
  }

  // 2. Parse target URL
  let targetUrl;
  try {
    targetUrl = new URL(url);
  } catch {
    return false;
  }

  // Target protocol must be http or https
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    return false;
  }

  // 3. Determine wildcard scopes
  const hasWildcardHost = ruleClean.startsWith('*.');
  const hasWildcardPath = ruleClean.endsWith('/*');

  // Clean wildcards for URL parsing
  let parsedRule = ruleClean;
  if (hasWildcardHost) parsedRule = parsedRule.slice(2);
  if (hasWildcardPath) parsedRule = parsedRule.slice(0, -2);

  // Parse rule URL (detect protocol, ignoring http vs https distinction)
  const hasProtocol = /^[a-zA-Z0-9+-.]+:\/\//.test(parsedRule);
  let ruleUrl;
  try {
    if (hasProtocol) {
      // Normalize to https protocol to ignore http vs https difference
      const normalizedRuleProtocol = parsedRule.replace(/^[a-zA-Z0-9+-.]+:\/\//, 'https://');
      ruleUrl = new URL(normalizedRuleProtocol);
    } else {
      ruleUrl = new URL('https://' + parsedRule);
    }
  } catch {
    return false;
  }

  // 4. Hostname check
  const targetHost = targetUrl.hostname.toLowerCase();
  const ruleHost = ruleUrl.hostname.toLowerCase();
  if (hasWildcardHost) {
    const isSubdomainOrRoot = targetHost === ruleHost || targetHost.endsWith('.' + ruleHost);
    if (!isSubdomainOrRoot) return false;
  } else {
    if (targetHost !== ruleHost) return false;
  }

  // 5. Pathname check
  let targetPath = targetUrl.pathname;
  let rulePath = ruleUrl.pathname;

  // Normalize trailing slashes for comparisons
  if (targetPath.endsWith('/') && targetPath.length > 1) targetPath = targetPath.slice(0, -1);
  if (rulePath.endsWith('/') && rulePath.length > 1) rulePath = rulePath.slice(0, -1);

  if (hasWildcardPath) {
    // Subtree segment matching (e.g. /docs matches /docs, /docs/page, but not /docs-archive)
    const normalizedRulePath = rulePath === '/' ? '/' : rulePath + '/';
    const normalizedTargetPath = targetPath === '/' ? '/' : targetPath + '/';
    return normalizedTargetPath.startsWith(normalizedRulePath);
  } else {
    // Exact path match
    return targetPath === rulePath;
  }
}

/**
 * Normalizes a URL for auto-translation rules.
 * Only supports http:, https:, and file: protocols.
 * Strips queries/hashes and canonicalizes http/https to https.
 *
 * @param {string} urlStr - The URL to normalize
 * @returns {string} The normalized URL or empty string if unsupported/invalid
 */
export function normalizeAutoTranslateRuleUrl(urlStr) {
  if (!urlStr) return '';
  try {
    const url = new URL(urlStr);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'file:') {
      return '';
    }
    if (url.protocol === 'file:') {
      return `file://${url.pathname}`;
    }
    // Normalize http/https to https to prevent duplicate rules representing the same logical page
    return `https://${url.host}${url.pathname}`;
  } catch {
    return '';
  }
}

/** Return the host-wide auto-translate rule for an HTTP(S) URL. */
export function getAutoTranslateSiteRule(url) {
  if (!url) return '';
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return '';
    return `${parsedUrl.hostname.toLowerCase()}/*`;
  } catch {
    return '';
  }
}

/** Whether a rule is an exact page rule for the given URL. */
export function isExactPageRule(url, rule) {
  if (typeof rule !== 'string' || rule.includes('*')) return false;
  const normalizedRule = rule.trim();

  try {
    if (new URL(url).protocol === 'file:') {
      const normalizedUrl = normalizeAutoTranslateRuleUrl(url);
      return !!normalizedUrl && normalizedUrl === normalizedRule;
    }
  } catch {
    return false;
  }

  return matchesAutoTranslateRule(url, rule);
}

/** Whether a rule is the exact host-wide scope for the current URL. */
export function isSiteScopeRule(url, rule) {
  if (typeof rule !== 'string') return false;
  const siteRule = getAutoTranslateSiteRule(url);
  if (!siteRule) return false;

  const match = rule.trim().match(/^(?:https?:\/\/)?([^/?#]+)\/\*$/i);
  if (!match) return false;

  const authority = match[1];
  if (authority.includes('*') || authority.includes('@')) return false;

  try {
    const ruleHostname = new URL(`https://${authority}`).hostname.toLowerCase();
    return ruleHostname === siteRule.slice(0, -2);
  } catch {
    return false;
  }
}

/** Classify how a configured rule applies to the current URL. */
export function classifyAutoTranslateRule(url, rule) {
  if (isExactPageRule(url, rule)) return 'page';
  if (isSiteScopeRule(url, rule)) return 'site';
  if (matchesAutoTranslateRule(url, rule)) return 'match';
  return 'none';
}
