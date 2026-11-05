/**
 * Language Constants and Mappings
 * Shared language name to code mappings used across translation providers
 */

import { AUTO_DETECT_VALUE } from './constants.js';
import { UI_LOCALES } from './LocaleManifest.js';

// UI Locale to Language Code Mapping
// Dynamically generated from UI_LOCALES manifest
export const UI_LOCALE_TO_CODE_MAP = UI_LOCALES.reduce((map, locale) => {
  // Add the primary name and all aliases to the map
  map[locale.name] = locale.code;
  if (locale.aliases) {
    locale.aliases.forEach(alias => {
      map[alias] = locale.code;
    });
  }
  return map;
}, {});

// Standard language name to code mapping
export const LANGUAGE_NAME_TO_CODE_MAP = {
  acehnese: "ace",
  afrikaans: "af",
  albanian: "sq",
  amharic: "am",
  arabic: "ar",
  armenian: "hy",
  azerbaijani: "az",
  belarusian: "be",
  bengali: "bn",
  bulgarian: "bg",
  burmese: "my",
  catalan: "ca",
  cebuano: "ceb",
  "chinese (simplified)": "zh-cn",
  chinese: "zh-cn",
  "chinese (traditional)": "zh-tw",
  "chinese (classical)": "lzh",
  cantonese: "yue",
  croatian: "hr",
  czech: "cs",
  danish: "da",
  dutch: "nl",
  english: "en",
  estonian: "et",
  farsi: "fa",
  persian: "fa",
  filipino: "fil",
  finnish: "fi",
  french: "fr",
  "gaelic (scottish)": "gd",
  georgian: "ka",
  german: "de",
  greek: "el",
  hebrew: "he",
  hindi: "hi",
  hungarian: "hu",
  indonesian: "id",
  italian: "it",
  japanese: "ja",
  kannada: "kn",
  kazakh: "kk",
  khmer: "km",
  korean: "ko",
  lao: "lo",
  latvian: "lv",
  lithuanian: "lt",
  malay: "ms",
  malayalam: "ml",
  marathi: "mr",
  nepali: "ne",
  norwegian: "no",
  odia: "or",
  pashto: "ps",
  polish: "pl",
  portuguese: "pt",
  punjabi: "pa",
  romanian: "ro",
  russian: "ru",
  serbian: "sr",
  sinhala: "si",
  slovak: "sk",
  slovenian: "sl",
  spanish: "es",
  swahili: "sw",
  swedish: "sv",
  tagalog: "tl",
  tamil: "ta",
  telugu: "te",
  thai: "th",
  turkish: "tr",
  ukrainian: "uk",
  urdu: "ur",
  uzbek: "uz",
  vietnamese: "vi",
};

// Reverse mapping: language code to language name
export const LANGUAGE_CODE_TO_NAME_MAP = Object.fromEntries(
  Object.entries(LANGUAGE_NAME_TO_CODE_MAP).map(([name, code]) => [code, name])
);

/**
 * Languages that are considered "Global Favorites" or "Commonly Encountered".
 * Used by the LanguageDetectionService to filter out unreliable statistical guesses
 * for short strings.
 */
export const GLOBAL_TRUSTED_LANGUAGES = [
  // Major World Languages (High population/usage)
  'en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'zh-cn', 'ja', 'ko', 'tr', 'id', 'ms', 'hi',
  'ar', 'fa', 'ur', 'bn', 'vi', 'th', 'pl', 'uk', 'nl', 'sv', 'no', 'fi', 'el', 'he',
  // Specific supported variants and minor languages with high reliable detection
  'ml', 'ta', 'te', 'kn', 'mr', 'ne', 'my', 'km', 'lo', 'am', 'hy', 'ka', 'ace', 'gd'
];

/**
 * Provider-Specific Language Pair Restrictions
 * Used for providers that don't support "any-to-any" translation (like Vajehyab).
 * Format: { providerId: { sourceCode: [targetCodes] } }
 */
export const PROVIDER_LANGUAGE_PAIRS = {
  vajehyab: {
    'fa': ['en', 'ar', 'tr'],
    'en': ['fa'],
    'ar': ['fa']
  }
};

/**
 * Standard RTL (Right-to-Left) language codes.
 * This is the Single Source of Truth for the entire extension.
 */
export const RTL_LANGUAGES = new Set([
  'ar',   // Arabic
  'fa',   // Persian (Farsi)
  'he',   // Hebrew
  'ur',   // Urdu
  'ps',   // Pashto
  'sd',   // Sindhi
  'ckb',  // Central Kurdish (Sorani)
  'ku',   // Kurdish (general, when using Arabic script)
  'yi',   // Yiddish
  'ug',   // Uyghur
  'dv',   // Divehi
  'syr',  // Syriac
  'arc',  // Aramaic
  'azb'   // South Azerbaijani
]);

// Provider-specific language code mappings
export const PROVIDER_LANGUAGE_MAPPINGS = {
  // Google Translate Language Codes
  GOOGLE: {
    ...LANGUAGE_NAME_TO_CODE_MAP,
    "zh-cn": "zh-CN",
    "zh-tw": "zh-TW",
    "lzh": "zh-CN",   // Google Classical fallback
    "yue": "yue",     // Cantonese
    "ps": "ps",
    "ur": "ur",
    "ak": "ak", "ace": "ace", "ach": "ach", "aa": "aa", "awa": "awa", "bal": "bal", 
    "ban": "ban", "bci": "bci", "btk": "btk", "bts": "bts", "bbc": "bbc", "bew": "bew", 
    "bik": "bik", "bua": "bua", "ch": "ch", "ce": "ce", "chk": "chk", "chv": "chv", 
    "crh": "crh", "din": "din", "doi": "doi", "dyu": "dyu", "dz": "dz", "ee": "ee", 
    "fon": "fon", "fr-CA": "fr-CA", "fur": "fur", "ff": "ff", "gaa": "gaa", "gri": "gri", 
    "hrp": "hrp", "hnn": "hnn", "hsb": "hsb", "iba": "iba", "ilo": "ilo", "inh": "inh", 
    "ikt": "ikt", "iu": "iu", "jam": "jam", "jbo": "jbo", "kac": "kac", "kl": "kl", 
    "kau": "kau", "pam": "pam", "kha": "kha", "kmb": "kmb", "kon": "kon", "krw": "krw", 
    "kru": "kru", "lij": "lij", "li": "li", "lmo": "lmo", "lua": "lua", "mad": "mad", 
    "mak": "mak", "mfa": "mfa", "mwr": "mwr", "mfe": "mfe", "mhr": "mhr", "min": "min", 
    "mzo": "mzo", "nah": "nah", "nd": "nd", "nr": "nr", "new": "new", "nko": "nko", 
    "nus": "nus", "oc": "oc", "os": "os", "pag": "pag", "pap": "pap", "qvi": "qvi", 
    "rom": "rom", "rn": "rn", "smn": "smn", "sag": "sag", "sat": "sat", "se": "se", 
    "nso": "nso", "st": "st", "sn": "sn", "crs": "crs", "shn": "shn", "szl": "szl", 
    "skr": "skr", "ss": "ss", "ty": "ty", "tmh": "tmh", "tet": "tet", "bo": "bo", 
    "tiv": "tiv", "tpi": "tpi", "to": "to", "tum": "tum", "tyv": "tyv", "udm": "udm", 
    "ve": "ve", "vec": "vec", "war": "war", "wol": "wol", "sah": "sah"
  },

  // Lingva Translate (Google Proxy) - Needs specific codes
  LINGVA: {
    ...LANGUAGE_NAME_TO_CODE_MAP,
    "zh-cn": "zh",
    "zh-tw": "zh_HANT",
    "lzh": "zh",
    "yue": "zh", // Lingva/Google Cantonese fallback
  },

  // Bing Translate Language Codes
  BING: {
    auto: "auto-detect",
    "zh-cn": "zh-Hans",
    "zh-tw": "zh-Hant",
    "zh": "zh-Hans",
    "lzh": "lzh",
    "yue": "yue",
    "no": "nb",
    "nb": "nb",
    "fa": "fa",
    "prs": "prs",
    "sr": "sr-Cyrl",
    "sr-cyrl": "sr-Cyrl",
    "sr-latn": "sr-Latn",
    "hmn": "mww",
    "tl": "fil",
    "iw": "he",
    // Standard Identity Mappings for Bing
    ace: "ace", af: "af", sq: "sq", am: "am", ar: "ar", arz: "arz", ary: "ary", arb: "arb", 
    hy: "hy", as: "as", ast: "ast", az: "az", ban: "ban", bn: "bn", ba: "ba", eu: "eu", 
    bbc: "bbc", be: "be", bho: "bho", bik: "bik", brx: "brx", bs: "bs", bg: "bg", ca: "ca", 
    ceb: "ceb", hne: "hne", co: "co", hr: "hr", cs: "cs", da: "da", dv: "dv", doi: "doi", 
    nl: "nl", en: "en", "en-gb": "en-GB", epo: "epo", et: "et", fo: "fo", fj: "fj", 
    fil: "fil", fi: "fi", fr: "fr", "fr-ca": "fr-CA", fy: "fy", fur: "fur", gl: "gl", 
    lug: "lug", ka: "ka", de: "de", el: "el", gu: "gu", ht: "ht", ha: "ha", he: "he", 
    hil: "hil", hi: "hi", mww: "mww", hu: "hu", iba: "iba", is: "is", ig: "ig", ilo: "ilo", 
    id: "id", ikt: "ikt", iu: "iu", "iu-latn": "iu-Latn", ga: "ga", it: "it", jam: "jam", 
    ja: "ja", jav: "jav", kea: "kea", kn: "kn", pam: "pam", ks: "ks", kk: "kk", km: "km", 
    rw: "rw", "tlh-latn": "tlh-Latn", gom: "gom", ko: "ko", kri: "kri", ku: "ku", 
    kmr: "kmr", ky: "ky", lo: "lo", la: "la", lv: "lv", lij: "lij", lim: "lim", ln: "ln", 
    lt: "lt", lmo: "lmo", dsb: "dsb", lb: "lb", mk: "mk", mai: "mai", mg: "mg", ms: "ms", 
    ml: "ml", mt: "mt", mr: "mr", mwr: "mwr", mfe: "mfe", min: "min", "mn-cyrl": "mn-Cyrl", 
    "mn-mong": "mn-Mong", my: "my", mi: "mi", ne: "ne", nya: "nya", oc: "oc", or: "or", 
    pap: "pap", ps: "ps", pl: "pl", "pt-pt": "pt-PT", pa: "pa", pnb: "pnb", otq: "otq", 
    ro: "ro", run: "run", ru: "ru", sm: "sm", sa: "sa", srd: "srd", st: "st", tn: "tn", 
    crs: "crs", sn: "sn", scn: "scn", sd: "sd", si: "si", sk: "sk", sl: "sl", so: "so", 
    es: "es", su: "su", sw: "sw", sv: "sv", ty: "ty", tgk: "tgk", ta: "ta", tt: "tt", 
    te: "te", tet: "tet", th: "th", bo: "bo", ti: "ti", tpi: "tpi", to: "to", tr: "tr", 
    tk: "tk", uk: "uk", hsb: "hsb", ur: "ur", ug: "ug", uz: "uz", vec: "vec", vi: "vi", 
    war: "war", cy: "cy", xh: "xh", ydd: "ydd", yo: "yo", yua: "yua", zu: "zu"
  },

  // Yandex Translate - based on provided list
  YANDEX: {
    auto: "auto",
    "zh-cn": "zh",
    "zh-tw": "zh",
    "zh": "zh",
    "fa": "fa",
    "ps": "fa", // Pashto fallback
    "ne": "ne",
    "ur": "ur",
    "iw": "he",
    "jw": "jv",
    "tl": "tl",
    "no": "no",
    // Standard and Special Mappings for Yandex
    abq: "abq", ab: "ab", af: "af", sq: "sq", am: "am", ar: "ar", hy: "hy", az: "az", 
    ba: "ba", eu: "eu", be: "be", bn: "bn", bs: "bs", bg: "bg", my: "my", bua: "bua", 
    ca: "ca", ceb: "ceb", cv: "cv", hr: "hr", cs: "cs", da: "da", nl: "nl", sjn: "sjn", 
    emj: "emj", myv: "myv", eo: "eo", et: "et", fi: "fi", fr: "fr", gl: "gl", glt: "glt", 
    ka: "ka", de: "de", el: "el", gu: "gu", ht: "ht", he: "he", mrj: "mrj", hi: "hi", 
    hu: "hu", is: "is", id: "id", ga: "ga", it: "it", ja: "ja", jv: "jv", kbd: "kbd", 
    kn: "kn", krc: "krc", kk: "kk", kazlat: "kazlat", km: "km", kv: "kv", ko: "ko", 
    ky: "ky", lo: "lo", la: "la", lv: "lv", lt: "lt", lb: "lb",
    // Other existing ones
    mk: "mk", mg: "mg", ms: "ms", ml: "ml", mt: "mt", mi: "mi", mr: "mr", mn: "mn", 
    pl: "pl", pt: "pt", pa: "pa", ro: "ro", ru: "ru", gd: "gd", sr: "sr", 
    si: "si", sk: "sk", sl: "sl", es: "es", su: "su", sw: "sw", sv: "sv", tg: "tg", 
    ta: "ta", te: "te", th: "th", tr: "tr", uk: "uk", uz: "uz", vi: "vi", 
    cy: "cy", xh: "xh", yi: "yi"
  },

  // Browser Translation API (Chrome Local)
  BROWSER: {
    "afrikaans": "af",
    "albanian": "sq",
    "arabic": "ar",
    "azerbaijani": "az",
    "belarusian": "be",
    "bengali": "bn",
    "bulgarian": "bg",
    "catalan": "ca",
    "chinese (simplified)": "zh",
    "zh-cn": "zh",
    "zh-tw": "zh",
    "lzh": "zh",
    "chinese": "zh",
    "croatian": "hr",
    "czech": "cs",
    "danish": "da",
    "dutch": "nl",
    "english": "en",
    "estonian": "et",
    "farsi": "fa",
    "persian": "fa",
    "ps": "fa",
    "mr": "hi",
    "ne": "hi",
    "ur": "ur",
    "filipino": "fil",
    "finnish": "fi",
    "french": "fr",
    "german": "de",
    "greek": "el",
    "hebrew": "he",
    "hindi": "hi",
    "hungarian": "hu",
    "indonesian: ": "id",
    "italian": "it",
    "japanese": "ja",
    "korean": "ko",
    "latvian": "lv",
    "lithuanian": "lt",
    "malay": "ms",
    "norwegian": "no",
    "polish": "pl",
    "portuguese": "pt",
    "romanian": "ro",
    "russian": "ru",
    "serbian": "sr",
    "slovak": "sk",
    "slovenian": "sl",
    "spanish": "es",
    "swedish: ": "sv",
    "thai": "th",
    "turkish": "tr",
    "ukrainian": "uk",
    "vietnamese": "vi"
  },

  // DeepL Translate Language Codes (UPPERCASE)
  // Standard languages
  DEEPL: {
    auto: '',
    'bg': 'BG', 'cs': 'CS', 'da': 'DA', 'de': 'DE', 'el': 'EL', 'en': 'EN', 'es': 'ES', 
    'et': 'ET', 'fi': 'FI', 'fr': 'FR', 'hu': 'HU', 'id': 'ID', 'it': 'IT', 'ja': 'JA', 
    'ko': 'KO', 'lt': 'LT', 'lv': 'LV', 'nb': 'NB', 'nl': 'NL', 'pl': 'PL', 'pt': 'PT', 
    'pt-br': 'PT-BR', 'ro': 'RO', 'ru': 'RU', 'sk': 'SK', 'sl': 'SL', 'sv': 'SV', 
    'tr': 'TR', 'uk': 'UK', 
    'zh': 'ZH', 
    'zh-cn': 'ZH-HANS', 
    'zh-tw': 'ZH-HANT',
  },

  // Vajehyab Dictionary - Persian, English, Arabic, Turkish
  VAJEHYAB: {
    ...LANGUAGE_NAME_TO_CODE_MAP,
    "fa": "fa",
    "en": "en",
    "ar": "ar",
    "tr": "tr"
  },
};

/**
 * Provider-specific supported language codes
 * Maps each provider to the list of language codes they support
 *
 * IMPORTANT: For providers that use different codes (like browserapi using 'zh' instead of 'zh-CN'),
 * we use canonical codes and a variation mapping to handle different code formats.
 */

/**
 * Canonical language code mapping
 * Maps different code variations to a canonical form for matching
 */
const CANONICAL_CODE_MAP = {
  // Chinese variations
  'zh': 'zh-cn',
  'zhcn': 'zh-cn',     // zh-CN normalized
  'zhtw': 'zh-tw',     // zh-TW normalized
  'zhans': 'zh-cn',    // zh-Hans normalized
  'zhant': 'zh-tw',    // zh-Hant normalized
  'yue': 'yue',
  'lzh': 'lzh',

  // Filipino/Tagalog variations
  'fil': 'fil',
  'tl': 'tl',
};

/**
 * Get canonical code for a language code
 * Handles variations like zh-CN -> zh, tl -> fil
 * @param {string} code - Language code to canonicalize
 * @returns {string} Canonical language code
 */
export function getCanonicalCode(code) {
  if (!code) return code;
  const lower = code.toLowerCase();
  const stripped = lower.replace(/[-_]/g, '');
  
  // Only apply mapping if we have a specific rule for this variation
  if (CANONICAL_CODE_MAP[stripped]) {
    return CANONICAL_CODE_MAP[stripped];
  }
  
  // Otherwise, return the lowercase version (preserving hyphens if present)
  return lower;
}

export const PROVIDER_SUPPORTED_LANGUAGES = {
  // Google Translate - supports all standard languages and many new ones from user list
  google: [
    'af', 'sq', 'am', 'ar', 'hy', 'as', 'ay', 'az', 'bm', 'ba', 'eu', 'be', 'bn', 'bho', 'bs', 'br', 'bg', 'ca', 'ceb', 'ny', 'zh-cn', 'zh-tw', 'co', 'hr', 'cs', 'da', 'dv', 'doi', 'nl', 'en', 'eo', 'et', 'ee', 'tl', 'fi', 'fr', 'fy', 'gl', 'ka', 'de', 'el', 'gn', 'gu', 'ht', 'ha', 'haw', 'iw', 'he', 'hi', 'hmn', 'hu', 'is', 'ig', 'ilo', 'id', 'ga', 'it', 'ja', 'jw', 'kn', 'kk', 'km', 'rw', 'gom', 'ko', 'kri', 'ku', 'ckb', 'ky', 'lo', 'la', 'lv', 'ln', 'lt', 'lg', 'lb', 'mk', 'mai', 'mg', 'ms', 'ml', 'mt', 'mi', 'mr', 'mni-mtei', 'lus', 'mn', 'my', 'ne', 'no', 'or', 'om', 'ps', 'fa', 'pl', 'pt', 'pa', 'qu', 'ro', 'ru', 'sm', 'sa', 'gd', 'nso', 'sr', 'st', 'sn', 'sd', 'si', 'sk', 'sl', 'so', 'es', 'su', 'sw', 'sv', 'tg', 'ta', 'tt', 'te', 'th', 'ti', 'ts', 'tr', 'tk', 'ak', 'uk', 'ur', 'ug', 'uz', 'vi', 'cy', 'xh', 'yi', 'yo', 'zu',
    'yue', 'ace', 'ach', 'aa', 'awa', 'bal', 'ban', 'bci', 'btk', 'bts', 'bbc', 'bew', 'bik', 'bua', 'ch', 'ce', 'chk', 'chv', 'crh', 'din', 'dyu', 'dz', 'fon', 'fr-CA', 'fur', 'ff', 'gaa', 'gri', 'hrp', 'hnn', 'hsb', 'iba', 'inh', 'ikt', 'iu', 'jam', 'jbo', 'kac', 'kl', 'kau', 'pam', 'kha', 'kmb', 'kon', 'krw', 'kru', 'lij', 'li', 'lmo', 'lua', 'mad', 'mak', 'mfa', 'mwr', 'mfe', 'mhr', 'min', 'mzo', 'nah', 'nd', 'nr', 'new', 'nko', 'nus', 'oc', 'os', 'pag', 'pap', 'qvi', 'rom', 'rn', 'smn', 'sag', 'sat', 'se', 'crs', 'shn', 'szl', 'skr', 'ss', 'ty', 'tmh', 'tet', 'bo', 'tiv', 'tpi', 'to', 'tum', 'tyv', 'udm', 've', 'vec', 'war', 'wol', 'sah'
  ],

  // Bing Translate - languages from the provided HTML list
  bing: [
    'ace', 'af', 'sq', 'am', 'ar', 'arz', 'ary', 'arb', 'hy', 'as', 'ast', 'az', 'ban', 'bn', 'ba', 'eu', 'bbc', 'be', 'bho', 'bik', 'brx', 'bs', 'bg', 'yue', 'ca', 'ceb', 'hne', 'lzh', 'zh-Hans', 'zh-Hant', 'co', 'hr', 'cs', 'da', 'prs', 'dv', 'doi', 'nl', 'en', 'en-GB', 'epo', 'et', 'fo', 'fj', 'fil', 'fi', 'fr', 'fr-CA', 'fy', 'fur', 'gl', 'gd', 'lug', 'ka', 'de', 'el', 'gu', 'ht', 'ha', 'he', 'hil', 'hi', 'mww', 'hu', 'iba', 'is', 'ig', 'ilo', 'id', 'ikt', 'iu', 'iu-Latn', 'ga', 'it', 'jam', 'ja', 'jav', 'kea', 'kn', 'pam', 'ks', 'kk', 'km', 'rw', 'tlh-Latn', 'gom', 'ko', 'kri', 'ku', 'kmr', 'ky', 'lo', 'la', 'lv', 'lij', 'lim', 'ln', 'lt', 'lmo', 'dsb', 'lb', 'mk', 'mai', 'mg', 'ms', 'ml', 'mt', 'mr', 'mwr', 'mfe', 'min', 'mn-Cyrl', 'mn-Mong', 'my', 'mi', 'ne', 'nb', 'nno', 'nya', 'oc', 'or', 'pap', 'ps', 'fa', 'pl', 'pt', 'pt-PT', 'pa', 'pnb', 'otq', 'ro', 'run', 'ru', 'sm', 'sa', 'srd', 'sr-Cyrl', 'sr-Latn', 'st', 'nso', 'tn', 'crs', 'sn', 'scn', 'sd', 'si', 'sk', 'sl', 'so', 'es', 'su', 'sw', 'sv', 'ty', 'tgk', 'ta', 'tt', 'te', 'tet', 'th', 'bo', 'ti', 'tpi', 'to', 'tr', 'tk', 'uk', 'hsb', 'ur', 'ug', 'uz', 'vec', 'vi', 'war', 'cy', 'xh', 'ydd', 'yo', 'yua', 'zu'
  ],

  // Yandex Translate - based on provided list
  yandex: [
    'ace', 'af', 'sq', 'am', 'ar', 'an', 'hy', 'as', 'ay', 'az', 'ba', 'eu', 'be', 'bn', 'bho', 'bs', 'br', 'bg', 'my', 'yue', 'ca', 'ceb', 'zh-cn', 'hr', 'cs', 'da', 'prs', 'nl', 'en', 'eo', 'et', 'fi', 'fr', 'gl', 'gd', 'ka', 'de', 'el', 'gn', 'gu', 'ht', 'ha', 'he', 'hi', 'hu', 'is', 'ig', 'id', 'ga', 'it', 'ja', 'jv', 'pam', 'kk', 'gom', 'ko',
    'ru', 'fa', 'ne'
  ],

  // Browser API - uses Chrome's built-in translation (from BrowserAPI.js langNameToCodeMap)
  // Using canonical codes for matching
  // Note: Provider might be 'browser', 'browserapi', or 'BrowserAPI' depending on context
  browserapi: [
    'af', 'sq', 'ar', 'az', 'be', 'bn', 'bg', 'ca', 'zh-cn', 'hr', 'cs', 'da', 'nl',
    'en', 'et', 'fa', 'fil', 'fi', 'fr', 'de', 'el', 'he', 'hi', 'hu', 'id', 'it',
    'ja', 'ko', 'lv', 'lt', 'ms', 'no', 'pl', 'pt', 'ro', 'ru', 'sr', 'sk', 'sl',
    'es', 'sv', 'th', 'tr', 'uk', 'vi'
  ],

  // Alias for 'browser' (in case provider name is different)
  browser: [
    'af', 'sq', 'ar', 'az', 'be', 'bn', 'bg', 'ca', 'zh-cn', 'hr', 'cs', 'da', 'nl',
    'en', 'et', 'fa', 'fil', 'fi', 'fr', 'de', 'el', 'he', 'hi', 'hu', 'id', 'it',
    'ja', 'ko', 'lv', 'lt', 'ms', 'no', 'pl', 'pt', 'ro', 'ru', 'sr', 'sk', 'sl',
    'es', 'sv', 'th', 'tr', 'uk', 'vi'
  ],

  // DeepL's static language list is retained for Options compatibility.
  deepl: [
    'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'hu', 'id', 'it',
    'ja', 'ko', 'lt', 'lv', 'nb', 'nl', 'pl', 'pt', 'pt-br', 'ro', 'ru', 'sk', 'sl',
    'sv', 'tr', 'uk', 'zh', 'zh-cn', 'zh-tw'
  ],

    // Vajehyab - Persian dictionary service
    vajehyab: ['fa', 'en', 'ar', 'tr'],

    // AI Providers (Gemini, OpenAI, OpenRouter, Requesty, Cheaper Inference, DeepSeek, WebAI, Custom)
    // These support virtually all languages through LLM capabilities
    gemini: null, // null = supports all languages
  openai: null,
  openrouter: null,
  requesty: null,
  cheaperinference: null,
  deepseek: null,
  webai: null,
  custom: null
};

// Utility function to normalize language names
export function normalizeLanguageName(lang) {
  if (!lang || typeof lang !== "string") return "";
  return lang.toLowerCase().trim();
}

// Utility function to get provider-specific language code
export function getProviderLanguageCode(lang, provider = 'GOOGLE') {
  const normalized = normalizeLanguageName(lang);

  // Check provider-specific mapping first
  if (PROVIDER_LANGUAGE_MAPPINGS[provider]?.[normalized]) {
    return PROVIDER_LANGUAGE_MAPPINGS[provider][normalized];
  }

  // Fall back to standard mapping
  if (LANGUAGE_NAME_TO_CODE_MAP[normalized]) {
    const standardCode = LANGUAGE_NAME_TO_CODE_MAP[normalized];
    // Check if provider has a different code for this standard code
    if (PROVIDER_LANGUAGE_MAPPINGS[provider]?.[standardCode]) {
      return PROVIDER_LANGUAGE_MAPPINGS[provider][standardCode];
    }
    return standardCode;
  }

  return normalized; // Return as-is if not found
}

// Enhanced language mappings for AI providers that need more specific names
const AI_ENHANCED_LANGUAGE_MAPPINGS = {
  'ar': 'Arabic (Modern Standard)',
  'zh': 'Chinese (Simplified)',
  'zh-cn': 'Chinese (Simplified)',
  'zh-tw': 'Chinese (Traditional)',
  'lzh': 'Chinese (Literary / Classical)',
  'yue': 'Cantonese (Traditional Script)',
  'he': 'Hebrew (Modern)',
  'fa': 'Persian (Farsi)',
};

// Utility function to convert language code to language name (for AI providers)
export function getLanguageNameFromCode(code) {
  if (!code || typeof code !== "string") return "";

  // Handle special cases
  if (code.toLowerCase() === AUTO_DETECT_VALUE) return AUTO_DETECT_VALUE;

  const normalizedCode = code.toLowerCase().trim();

  // Check AI-enhanced mappings first (for better AI provider compatibility)
  if (AI_ENHANCED_LANGUAGE_MAPPINGS[normalizedCode]) {
    return AI_ENHANCED_LANGUAGE_MAPPINGS[normalizedCode];
  }

  // Check reverse mapping
  if (LANGUAGE_CODE_TO_NAME_MAP[normalizedCode]) {
    return LANGUAGE_CODE_TO_NAME_MAP[normalizedCode];
  }

  // If it's already a full name (not in code format), return as-is
  if (normalizedCode.length > 3 && !LANGUAGE_NAME_TO_CODE_MAP[normalizedCode]) {
    return code;
  }

  // Fallback: try to find in original mapping by checking values
  for (const [name, langCode] of Object.entries(LANGUAGE_NAME_TO_CODE_MAP)) {
    if (langCode === normalizedCode) {
      return name;
    }
  }

  return code; // Return as-is if not found
}
