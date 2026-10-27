/**
 * Shared Text Analysis Utilities
 * Common text processing functions used across multiple features
 */

/**
 * Check if text is a single word or short phrase
 * @param {string} text - Text to check
 * @returns {boolean} True if text is single word or short phrase
 */
export function isSingleWordOrShortPhrase(text) {
  if (!text || typeof text !== 'string') {
    return false;
  }
  const trimmedText = text.trim();
  if (trimmedText.length === 0) {
    return false;
  }

  // Define thresholds
  const MAX_WORDS = 3;
  const MAX_CHARS = 30;

  const words = trimmedText.split(/\s+/); // Split by one or more whitespace characters

  return words.length <= MAX_WORDS && trimmedText.length <= MAX_CHARS;
}

/**
 * Arabic script language codes for centralized management
 * Includes major languages using the Arabic script family
 */
export const ARABIC_SCRIPT_LANGUAGES = ['fa', 'ar', 'ur', 'ps', 'sd', 'ku', 'ckb', 'ug'];

/**
 * Chinese script language codes for centralized management
 */
export const CHINESE_SCRIPT_LANGUAGES = ['zh-cn', 'zh-tw', 'lzh', 'yue'];

/**
 * Devanagari script language codes for centralized management
 */
export const DEVANAGARI_SCRIPT_LANGUAGES = ['hi', 'mr', 'ne'];

/**
 * Latin script priority language codes for centralized management
 * Used for validating user-selected priority in ambiguous short Latin strings.
 */
export const LATIN_SCRIPT_PRIORITY_LANGUAGES = ['en', 'fr', 'es', 'de', 'it', 'pt', 'tr', 'nl'];

/**
 * Internal helper to calculate script density percentage.
 * 
 * @param {string} text - Text to analyze
 * @param {RegExp} regex - Global regex for the script range
 * @returns {number} Percentage of characters matching the script (0-100)
 * @private
 */
const getScriptDensity = (text, regex) => {
  if (!text || typeof text !== 'string' || text.length === 0) return 0;
  const matches = text.match(regex);
  return matches ? (matches.length / text.length) * 100 : 0;
};

/**
 * Internal helper to check if script density meets adaptive thresholds.
 * High density (50%+) for short strings to avoid false positives in mixed text.
 * Slightly lower density (40%+) for longer strings to account for punctuation/numbers.
 * 
 * @param {string} text - Text to analyze
 * @param {RegExp} regex - Global regex for the script range
 * @returns {boolean} True if density meets the threshold
 * @private
 */
const meetsDensityThreshold = (text, regex) => {
  const length = text.length;
  if (length === 0) return false;
  const density = getScriptDensity(text, regex);
  return length < 50 ? density >= 50 : density >= 40;
};

/**
 * Check if text contains Persian characters (distinguishes from Arabic)
 * @param {string} text - Text to check
 * @returns {boolean} True if text contains Persian characters
 */
export const isPersianText = (text) => {
  if (!text || typeof text !== 'string') return false;

  // Persian-specific characters (not present in standard Arabic):
  // پ (U+067E), چ (U+0686), ژ (U+0698), گ (U+06AF), ک (U+06A9), ی (U+06CC)
  const persianExclusiveChars = /[پچژگکی]/;
  return persianExclusiveChars.test(text);
};

/**
 * Check if text contains Arabic script (both Arabic and Persian)
 * Uses adaptive density thresholds to prevent false positives in mixed text.
 * 
 * @param {string} text - Text to check
 * @returns {boolean} True if text contains Arabic script characters
 */
export const isArabicScriptText = (text) => {
  if (!text || typeof text !== 'string') return false;

  // 1. High-Confidence markers for very short strings
  // If it has Persian unique markers, we trust it even at lower total density
  if (text.length < 20 && isPersianText(text)) {
    return true;
  }

  // 2. Strict density for common short words (e.g., "سلام" needs high density if short)
  // Unicode range (U+0600 to U+06FF)
  if (text.length < 20) {
    return getScriptDensity(text, /[؀-ۿ]/g) >= 70;
  }

  // 3. Adaptive threshold for medium/long strings
  return meetsDensityThreshold(text, /[؀-ۿ]/g);
};

/**
 * Detect language for Arabic script text with user preferences
 * @param {string} text - Text to analyze
 * @param {Object} preferences - User language detection preferences
 * @param {Object} options - Detection options
 * @param {boolean} options.useDefaults - Whether to return a default language if no unique markers found
 * @returns {string|null} Language code ('fa', 'ar', 'ur', 'ps') or null if not Arabic script
 */
export const detectArabicScriptLanguage = (text, preferences = {}, options = { useDefaults: true }) => {
  if (!text || typeof text !== 'string') return null;

  // Check if it's Arabic script (using density-aware check)
  if (!isArabicScriptText(text)) {
    return null;
  }

  // 1. Language-specific unique characters

  // Urdu-specific (U+0621, U+0624, U+0626, U+0679, U+0686, U+0688, U+0691, U+06AF, U+06BA, U+06BE, U+06C1, U+06D2)
  const urduExclusiveChars = /[ٹڈڑںھہے]/;
  if (urduExclusiveChars.test(text)) return 'ur';

  // Pashto-specific (U+0672, U+0675, U+0681, U+0685, U+0692, U+069A, U+06BC, U+06CD, U+06D0)
  const pashtoExclusiveChars = /[ٲٵځڅڒښڼۍې]/;
  if (pashtoExclusiveChars.test(text)) return 'ps';

  // Persian-specific (پ، چ، ژ، گ، ک فارسی، ی فارسی)
  const persianExclusiveChars = /[پچژگکی]/;
  if (persianExclusiveChars.test(text)) return 'fa';

  // Arabic-specific (ة، ي عربی، ك عربی، ى)
  const arabicExclusiveChars = /[ةيكى]/;
  if (arabicExclusiveChars.test(text)) return 'ar';

  // If no unique markers found and we don't want defaults, return null to allow other layers to decide
  if (!options.useDefaults) {
    return null;
  }

  // 2. Use user preference for ambiguous text (like "سلام")
  const userPreference = preferences['arabic-script'];
  if (userPreference && ARABIC_SCRIPT_LANGUAGES.includes(userPreference)) {
    return userPreference;
  }

  // 3. Final Default
  return 'fa';
};

/**
 * Checks if a character code belongs to an RTL strong directional category.
 * Includes: Hebrew, Arabic, Syriac, Thaana, NKo, etc.
 * @param {number} code - Unicode character code
 * @returns {boolean}
 */
export function isRTLStrongCharacter(code) {
  return (
    (code >= 0x0590 && code <= 0x05FF) ||  // Hebrew
    (code >= 0x0600 && code <= 0x06FF) ||  // Arabic
    (code >= 0x0700 && code <= 0x074F) ||  // Syriac
    (code >= 0x0750 && code <= 0x077F) ||  // Arabic Supplement
    (code >= 0x0780 && code <= 0x07BF) ||  // Thaana
    (code >= 0x07C0 && code <= 0x07FF) ||  // NKo
    (code >= 0x08A0 && code <= 0x08FF) ||  // Arabic Extended
    (code >= 0xFB1D && code <= 0xFB4F) ||  // Hebrew Presentation Forms
    (code >= 0xFB50 && code <= 0xFDFF) ||  // Arabic Presentation Forms
    (code >= 0xFE70 && code <= 0xFEFF) ||  // Arabic Presentation Forms-B
    (code === 0x200F)                      // Right-to-Left Mark
  );
}

/**
 * Checks if a character code belongs to an LTR strong directional category.
 * Includes: Latin, Greek, Cyrillic, etc.
 * @param {number} code - Unicode character code
 * @param {boolean} includeUnicodeLetters - Also recognize Han, Hiragana, Katakana, and Devanagari letters
 * @returns {boolean}
 */
export function isLTRStrongCharacter(code, includeUnicodeLetters = false) {
  if (isRTLStrongCharacter(code)) return false;

  const isKnownLTR = (
    (code >= 0x0041 && code <= 0x005A) ||  // Basic Latin uppercase
    (code >= 0x0061 && code <= 0x007A) ||  // Basic Latin lowercase
    (code >= 0x00C0 && code <= 0x00D6) ||  // Latin-1 Supplement letters
    (code >= 0x00D8 && code <= 0x00F6) ||  // Latin-1 Supplement letters
    (code >= 0x00F8 && code <= 0x00FF) ||  // Latin-1 Supplement letters
    (code >= 0x0100 && code <= 0x017F) ||  // Latin Extended-A
    (code >= 0x0180 && code <= 0x024F) ||  // Latin Extended-B
    (code >= 0x0250 && code <= 0x02AF) ||  // IPA Extensions
    (code >= 0x0370 && code <= 0x03FF) ||  // Greek and Coptic
    (code >= 0x0400 && code <= 0x04FF) ||  // Cyrillic
    (code >= 0x0500 && code <= 0x052F) ||  // Cyrillic Supplement
    (code >= 0x1E00 && code <= 0x1EFF) ||  // Latin Extended Additional
    (code === 0x200E)                      // Left-to-Right Mark
  );

  if (isKnownLTR || !includeUnicodeLetters) return isKnownLTR;

  const character = String.fromCodePoint(code);
  return /\p{L}/u.test(character) && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Devanagari}]/u.test(character);
}

/**
 * Check if RTL (Right-to-Left) should be applied to text based on content.
 * Uses a majority-voting algorithm with strong directional character detection.
 * @param {string} text - Text to check
 * @param {number} rtlThreshold - RTL ratio must be strictly greater than this value
 * @param {boolean} includeUnicodeLetters - Count Han, Hiragana, Katakana, and Devanagari letters as LTR strong
 * @returns {boolean} True if RTL should be applied
 */
export const shouldApplyRtl = (text, rtlThreshold = 0.4, includeUnicodeLetters = false) => {
  if (!text || typeof text !== 'string') return false;
  const trimmedText = text.trim();
  if (trimmedText.length === 0) return false;

  let rtlStrongCount = 0;
  let ltrStrongCount = 0;

  for (let i = 0; i < trimmedText.length; i++) {
    const code = trimmedText.codePointAt(i);
    if (code > 0xFFFF) i++; // Handle surrogate pairs

    if (isRTLStrongCharacter(code)) rtlStrongCount++;
    else if (isLTRStrongCharacter(code, includeUnicodeLetters)) ltrStrongCount++;
  }

  // If no strong characters found, default to LTR
  if (rtlStrongCount === 0 && ltrStrongCount === 0) return false;

  // The default threshold preserves the existing RTL bias for mixed strings.
  return (rtlStrongCount / (rtlStrongCount + ltrStrongCount)) > rtlThreshold;
};

/**
 * Apply text direction to an element
 * @param {HTMLElement} element - Target element
 * @param {boolean} rtl_direction - Whether to apply RTL direction
 */
export const applyElementDirection = (element, rtl_direction = false) => {
  if (!element || !element.style) return;

  element.style.direction = rtl_direction ? "rtl" : "ltr";
  element.style.textAlign = rtl_direction ? "right" : "left";
};

/**
 * Correct text direction of an element based on content
 * @param {HTMLElement} element - Target element
 * @param {string} text - Text content to check
 */
export const correctTextDirection = (element, text) => {
  if (!element) return;

  const isRtl = shouldApplyRtl(text);
  applyElementDirection(element, isRtl);
};

/**
 * Check if text contains CJK characters (Chinese, Japanese, or Korean)
 * Uses adaptive density thresholds to prevent false positives in mixed text.
 * 
 * @param {string} text - Text to check
 * @returns {boolean} True if text contains CJK script characters
 */
export const isCjkScriptText = (text) => {
  if (!text || typeof text !== 'string') return false;
  // Ranges: CJK Unified Ideographs, Hiragana, Katakana, Hangul Syllables
  return meetsDensityThreshold(text, /[一-鿿぀-ゟ゠-ヿ가-힯]/g);
};

/**
 * Check if text contains Latin characters
 * Uses adaptive density thresholds to prevent false positives in mixed text.
 * 
 * @param {string} text - Text to check
 * @returns {boolean} True if text contains Latin characters
 */
export const isLatinScriptText = (text) => {
  if (!text || typeof text !== 'string') return false;
  return meetsDensityThreshold(text, /[a-zA-Z]/g);
};

/**
 * Check if text contains Chinese characters (CJK Unified Ideographs)
 * Uses adaptive density thresholds to prevent false positives in mixed text.
 * 
 * @param {string} text - Text to check
 * @returns {boolean} True if text contains Chinese characters
 */
export const isChineseScriptText = (text) => {
  if (!text || typeof text !== 'string') return false;
  // CJK Unified Ideographs range
  return meetsDensityThreshold(text, /[一-鿿]/g);
};

/**
 * Detect specific Chinese variant with user preferences
 * @param {string} text - Text to analyze
 * @param {Object} preferences - User language detection preferences
 * @param {Object} options - Detection options
 * @param {boolean} options.useDefaults - Whether to return a default language if no unique markers found
 * @returns {string|null} Language code ('zh-cn', 'zh-tw', 'lzh', 'yue') or null
 */
export const detectChineseScriptLanguage = (text, preferences = {}, options = { useDefaults: true }) => {
  if (!text || !isChineseScriptText(text)) return null;

  // 1. Heuristic: Unique Markers for Traditional vs Simplified

  // Traditional Chinese unique markers
  const traditionalMarkers = /[們國學會這]/;
  if (traditionalMarkers.test(text)) return 'zh-tw';

  // Simplified Chinese unique markers
  const simplifiedMarkers = /[们国学会这]/;
  if (simplifiedMarkers.test(text)) return 'zh-cn';

  // If no unique markers found and we don't want defaults, return null
  if (!options.useDefaults) return null;

  // 2. Use user preference for ambiguous text
  const userPreference = preferences['chinese-script'];
  if (userPreference && CHINESE_SCRIPT_LANGUAGES.includes(userPreference)) {
    return userPreference;
  }

  // 3. Final Default
  return 'zh-cn';
};
/**
 * Check if text contains Devanagari characters (Hindi, Marathi, Nepali)
 * Uses adaptive density thresholds to prevent false positives in mixed text.
 * 
 * @param {string} text - Text to check
 * @returns {boolean} True if text contains Devanagari characters
 */
export const isDevanagariScriptText = (text) => {
  if (!text || typeof text !== 'string') return false;
  // Devanagari Unicode range (U+0900 to U+097F)
  return meetsDensityThreshold(text, /[ऀ-ॿ]/g);
};

/**
 * Detect language for Devanagari script text with user preferences
 * @param {string} text - Text to analyze
 * @param {Object} preferences - User language detection preferences
 * @param {Object} options - Detection options
 * @param {boolean} options.useDefaults - Whether to return a default language if no unique markers found
 * @returns {string|null} Language code ('hi', 'mr', 'ne') or null
 */
export const detectDevanagariScriptLanguage = (text, preferences = {}, options = { useDefaults: true }) => {
  if (!text || !isDevanagariScriptText(text)) return null;

  // 1. Language-specific unique markers

  // Marathi unique characters: ळ (U+0933)
  const marathiMarkers = /[ळ]/;
  if (marathiMarkers.test(text)) return 'mr';

  // If no unique markers found and we don't want defaults, return null
  if (!options.useDefaults) return null;

  // 2. Use user preference for ambiguous text
  const userPreference = preferences['devanagari-script'];
  if (userPreference && DEVANAGARI_SCRIPT_LANGUAGES.includes(userPreference)) {
    return userPreference;
  }

  // 3. Final Default
  return 'hi';
};

/**
 * Detect language for Latin script text using unique character markers (Diacritics)
 * or user preferences for ambiguous strings.
 *
 * @param {string} text - Text to analyze
 * @param {Object} preferences - User language detection preferences
 * @param {Object} options - Detection options
 * @param {boolean} options.useDefaults - Whether to return a default language if no unique markers found
 * @returns {string|null} Language code or null
 */
export const detectLatinScriptLanguage = (text, preferences = {}, options = { useDefaults: false }) => {
  if (!text || typeof text !== 'string') return null;
  const sample = text.trim();

  // 1. Deterministic Layer: Language-specific unique characters
  // German: ä, ö, ü, ß
  if (/[ßäöüÄÖÜ]/.test(sample)) return 'de';

  // Spanish: ñ, inverted punctuation (¿, ¡)
  if (/[ñ¿¡]/.test(sample)) return 'es';

  // Portuguese specific (tilde)
  if (/[ãõÃÕ]/.test(sample)) return 'pt';

  // Italian specific (grave accents on vowels are common, especially at end)
  if (/[èìòùÈÌÒÙ]/.test(sample)) return 'it';

  // French / Standard Latin variants
  // Only use highly unique markers for deterministic French
  if (/[êëîïûùôçÊËÎÏÛÙÔÇ]/.test(sample)) {
    // Turkish overlap check
    if (/[ığşİ]/.test(sample)) return 'tr';
    // Vietnamese overlap check
    if (/[đĐ₫]/.test(sample)) return 'vi';
    return 'fr';
  }

  // Nordic languages
  if (/[åøæÅØÆ]/.test(sample)) return 'no';

  // Cyrillic (Ukrainian/Russian)
  // Check Ukrainian specific markers first
  if (/[ґєії]/.test(sample)) return 'uk';
  // Fallback to Russian for general Cyrillic
  if (/[а-яё]/i.test(sample)) return 'ru';

  // --- New Logic for Layer 3 (Heuristic) ---
  // If no unique markers found and we don't want defaults (Layer 1), return null
  if (!options.useDefaults) return null;

  // 2. Use user preference for ambiguous text (e.g., "articles")
  const userPreference = preferences['latin-script'];

  // If user explicitly chose 'none', return null to let the translation provider decide (auto)
  if (userPreference === 'none') return null;

  if (userPreference && LATIN_SCRIPT_PRIORITY_LANGUAGES.includes(userPreference)) {
    return userPreference;
  }

  // 3. Final Default fallback (null means let the provider decide via 'auto')
  return null;
};
