# Language Detection & Direction System

## Overview

The **Language Detection System** is a centralized, high-precision architecture designed to identify both the **language** and **text direction (RTL/LTR)** of any text across the extension. Production translation requests resolve effective source language locally and keep that semantic result separate from provider-reported detection. Provider-reported detection is stored as internal request/operation metadata for deterministic aggregation, but is not currently promoted into public source-language fields or fed back into detection caches.

**Single Source of Truth**: `LanguageDetectionService.js`

The i18n lazy-loading layer is only a consumer of detection results. It does not maintain a separate detection policy or a second heuristic engine.

---

## Architecture & Flow

The system follows a **Hierarchical Priority Flow**. Before invoking internal detection layers, it checks for inherited metadata and handles text direction context.

The system handles two primary responsibilities:
1.  **Language Identification**: Multi-layered detection (Statistical, Deterministic, Heuristic).
2.  **Direction Management**: Determining if text should be rendered as RTL or LTR based on language codes and/or Unicode content analysis.

### Direction Detection Strategy
1.  **Language Match**: If an explicit language code is available (e.g., `fa`, `ar`), it is checked against the master `RTL_LANGUAGES` list in `languageConstants.js`.
2.  **Unicode Analysis**: If the language is `auto` or ambiguous, the system performs a character-by-character analysis using **Strong Directional Characters** (Unicode Bidirectional Algorithm principles).
3.  **Majority Voting**: For mixed content, a majority-voting algorithm (with an RTL bias) determines the final direction.

### Dynamic Flow Diagram
```
           [ Input Text ]
                 │
                 ▼
    ┌──────────────────────────┐
    │ Layer 0: Inherited?      │─── (Yes) ──▶ [ Use Inherited Lang ]
    │ (AuthSource Metadata)    │              [ Resolve Direction  ]
    └────────────┬─────────────┘
                 │
                (No)
                 │
                 ▼
          [ Length Check ] ─── (Threshold: 60 chars) ───┐
                 │                                      │
          ▼ (Short Text)                         ▼ (Long Text)
    ┌──────────────────────────┐           ┌──────────────────────────┐
    │ 1. Deterministic Layer   │           │ 1. Statistical Layer     │
    │    (Unique Markers)      │           │    (Browser i18n API)    │
    └─────────────┬────────────┘           └─────────────┬────────────┘
                  │                                     │
    ┌─────────────▼────────────┐           ┌─────────────▼────────────┐
    │ 2. Statistical Layer     │           │ 2. Deterministic Layer   │
    │    (Browser i18n API)    │           │    (Unique Markers)      │
    └─────────────┬────────────┘           └─────────────┬────────────┘
                  │                                     │
                  └───────────────┬─────────────────────┘
                                  ▼
                    ┌──────────────────────────┐
                    │ 3. Heuristic Layer       │
                    │    (User Prefs / Defaults)│
                    └──────────────────────────┘
                                  │
                                  ▼
                   [ Final Result: Lang + Dir ]
```

### Priority Hierarchy
1.  **Layer 0: Cached Local Detection**: Previously resolved local detection can be reused from `SESSION_CACHE`. Provider feedback registration infrastructure exists, but is inactive in production; provider-reported metadata is not currently written into this cache. The cache is automatically invalidated when translation settings or providers change.
2.  **Layer 1: Deterministic Layer**: Unicode range analysis for unique script markers (e.g., Persian `پ`).
3.  **Layer 1.5: User Priority (Short Latin Strings)**: For Latin strings < 60 chars, the user's "Latin Script Priority" setting is checked *before* statistical detection to prevent common false positives (e.g., English "articles" as Catalan "ca"). Only whitelisted Latin priority codes are accepted.
4.  **Layer 2: Statistical Layer**: Browser `i18n` API (prioritized for texts > 60 chars).
5.  **Layer 3: Heuristic Layer**: Fallbacks based on script-specific defaults (e.g., Arabic defaults to `fa`).

---

## Core Components

### 1. `LanguageDetectionService.js` (The Brain)
The central orchestrator for all detection and direction requests. It manages:
- **`detect(text, options)`**: Main entry point for identifying the language code.
- **`detectDetailed(text, options)`**: Metadata-bearing detection contract for future confidence-aware routing. Returns `language`, `confidence`, `provenance`, `reliable`, and numeric `percentage` only when supplied by browser statistical detection.
- **`isRTL(langCodeOrName)`**: Checks if a language code (or full name) is natively RTL using the master `RTL_LANGUAGES` set.
- **`getDirection(text, langCode)`**: The unified method to determine `rtl` or `ltr`. It intelligently combines language hints and content analysis.
- **Layer 0 Cache**: A dual-mode session cache storing exact text matches (`textHash`) and URL-based script inheritance (`URL + ScriptFamily`).
- **Provider Feedback Infrastructure**: Implements `registerDetectionResult(text, lang, context)` for possible future verified-detection feedback. Current production translation flow does not call it with provider metadata.
- **Cache Invalidation**: Listens to `browser.storage.onChanged` to clear detection history when settings change.

#### Detection Metadata Contract

`detectDetailed()` preserves the existing detection pipeline and returns:

```js
{
  language: 'en' | null,
  confidence: 'high' | 'medium' | 'low' | 'unknown',
  provenance: 'exact-cache' | 'contextual-cache' | 'statistical'
    | 'deterministic-script' | 'user-language' | 'heuristic' | 'unknown',
  reliable: boolean,
  percentage: number | null
}
```

`percentage` is exposed only when browser statistical detection supplies a finite numeric value. Exact verified cache hits are high-confidence; contextual script-family cache inheritance is medium-confidence and not reliable. Accepted statistical results are high-confidence when browser reliability is true or percentage exceeds 85, otherwise medium-confidence. Deterministic unique markers are high-confidence. User-language and heuristic fallbacks are low-confidence. Unknown or rejected results return `language: null` with `confidence` and `provenance` set to `unknown`.

`detect()` remains the legacy single-pass projection and returns `result.language` as `string | null`. Existing callers do not need migration.

### Operation Source Resolution

Detection, operation source resolution, and scheduling are separate concerns.
`src/features/translation/core/OperationSourceLanguageResolver.js` builds one bounded representative sample, reuses one detailed detection result, applies existing swap semantics once, and returns an explicit `canBypassSequentialGate` decision with a stable reason. Stateless structured AUTO requests and the first AUTO batch in a Page session consume this contract: eligible resolutions bypass first-batch translation gating; denied resolutions retain the first-provider-batch fallback. Page samples are drawn only from the first batch, not the entire lazily discovered page, so they do not establish the language of unseen content or guarantee detection of mixed-language pages. A Page session reuses the resolved canonical source/target pair (including any bilingual swap) for sibling batches rather than detecting or swapping again.

Bypass is intentionally stricter than `DetectionResult.reliable`:

- high reliable statistical results can qualify;
- language-specific deterministic results can qualify;
- contextual cache, exact cache, heuristic, user-language, weak statistical, ambiguous deterministic, unknown, and mixed-script operations do not qualify;
- exact cache is not automatically trusted because cached feedback can be stale; provider feedback registration is currently inactive.
- history-enabled operations remain ordered even when local source resolution is strong.

### 2. `textAnalysis.js` (The Engine)
Contains low-level Unicode range analysis and script-specific detection functions.
- **`isRTLStrongCharacter(code)`**: Identifies inherently RTL characters (Arabic, Hebrew, Syriac, etc.).
- **`shouldApplyRtl(text)`**: High-precision content analyzer for mixed-direction strings using majority-voting.
- **Script Detection**: Differentiates between "Definitive Markers" and "Heuristic Guessing".

### 3. `languageConstants.js` (The Validator & SSOT)
Acts as the "Source of Truth" for all language-related metadata.
- **`RTL_LANGUAGES`**: Master list of RTL codes.
- **`LANGUAGE_CODE_TO_NAME_MAP`**: Official language list.
- **`GLOBAL_TRUSTED_LANGUAGES`**: Used by the Trust Filter.

### 4. `useTextDirection.js` (The UI Hook)
A Vue composable providing reactive direction state for components (`direction`, `textAlign`, `textDirectionStyle`).

---

## 🔍 Detection Layers & Supported Markers

### Deterministic Layer (The "Smoking Gun")
Uses specialized Unicode markers to find characters unique to specific languages.

| Script Family | Language Markers | Detected Code |
| :--- | :--- | :--- |
| **Arabic** | `پ چ ژ گ ک ی` (Persian-specific) | `fa` |
| **Arabic** | `ة ي ك ى` (Arabic-specific) | `ar` |
| **Arabic** | `ٹ ڈ ڑ ں ہ ے` (Urdu-specific) | `ur` |
| **Arabic** | `ښ څ ډ ړ ږ ښ ګ` (Pashto-specific) | `ps` |
| **Chinese** | `们 国 学 会 这` (Simplified) | `zh-cn` |
| **Chinese** | `們 國 學 會 這` (Traditional) | `zh-tw` |
| **Devanagari**| `ळ` (Marathi-unique) | `mr` |
| **Latin** | `ß` (German), `ñ` (Spanish), `å ø æ` (Nordic) | `de`, `es`, `no` |
| **Latin** | `è ì ò ù` (Italian) | `it` |
| **Latin** | `ã õ` (Portuguese) | `pt` |
| **Latin** | `êëîïûùôç` (French unique markers) | `fr` |
| **Latin** | `ç` + `ığşİ` (Turkish) | `tr` |
| **Cyrillic** | `а-яё` (Russian), `ґєії` (Ukrainian) | `ru`, `uk` |
| **CJK Range** | Hiragana/Katakana (Japanese), Hangul (Korean) | `ja`, `ko` |

---

## Technical Details

### 1. Statistical Reliability Threshold (60 chars)
- Below **60 chars**, deterministic markers (Layer 1) are prioritized.
- Above **60 chars**, the Browser API is prioritized.

### 2. Arabic Script Detection (Adaptive Thresholds)
The `isArabicScriptText()` function implements an adaptive threshold strategy to minimize false positives:

- **Very Short Texts (< 20 chars)**: Uses `isPersianText()` with Persian exclusive characters (`پ چ ژ گ ک ی`)
  - *Rationale*: For very short texts, percentage-based detection is unreliable
  - *Example*: "سلام" → true (detected as Persian), "Hello [[---]]" → false (only markers)

- **Medium Texts (20-49 chars)**: Uses **50% threshold** for Arabic script percentage
  - *Rationale*: Stricter threshold for mixed English text with few Persian words
  - *Example*: 40-char text with 15 Arabic chars → 37.5% → false (rejected)
  - *Example*: 40-char text with 25 Arabic chars → 62.5% → true (accepted)

- **Long Texts (>= 50 chars)**: Uses **40% threshold** for Arabic script percentage
  - *Rationale*: Relaxed threshold for better detection of real Arabic/Persian content
  - *Example*: 100-char text with 35 Arabic chars → 35% → false (rejected)
  - *Example*: 100-char text with 45 Arabic chars → 45% → true (accepted)

### 3. Trust Filter (Dynamic Context Validation)
To prevent misidentification of short strings (e.g., "hello" as Serbian `sr`), the system implements a **Context-Aware Trust Filter**:
- **Dynamic Trust Set**:
    1. **User's Context**: UI Language + Active Target Language.
    2. **Global Trusted Set**: Managed in `languageConstants.js` as `GLOBAL_TRUSTED_LANGUAGES`.
- **Confidence Bypass**: If a detection has a confidence score **> 80%**, it bypasses the Trust Set restriction.

### 4. Detection vs. Provider Support (Philosophy)
The system separates **Detection** from **Execution**:
- We aim to detect the *actual* language as accurately as possible.
- Fallbacks are handled at the Provider or TTS level if a specific code is not supported.

---

## Development Guide

### How to use Language Detection
```javascript
import { LanguageDetectionService } from '@/shared/services/LanguageDetectionService.js';
const detectedLang = await LanguageDetectionService.detect(someText);
```

### How to use Direction Management
```javascript
import { LanguageDetectionService } from '@/shared/services/LanguageDetectionService.js';

// Check by code/name
const isRtl = LanguageDetectionService.isRTL('fa'); 

// Get smart direction
const dir = LanguageDetectionService.getDirection(text, langCode); 
```

### How to use in Vue Components
```javascript
import { useTextDirection } from '@/composables/shared/useTextDirection.js';
const { textDirectionStyle } = useTextDirection(text, langCode);
```

### How to add a new Language Marker (Internal)
1.  **Engine Update**: Update `src/shared/utils/text/textAnalysis.js` Unicode ranges/regex.
2.  **Service Integration**: Update `getDeterministicResult` in `LanguageDetectionService.js`.

### How to add a new Language (Full Support)
1.  **SSOT Registration**: Add to `LANGUAGE_NAME_TO_CODE_MAP` and `RTL_LANGUAGES` (if applicable) in `src/shared/config/languageConstants.js`.
2.  **Provider Mapping**: Add the code to the relevant provider lists in `PROVIDER_SUPPORTED_LANGUAGES`.
3.  **Trust Expansion**: Add the code to `GLOBAL_TRUSTED_LANGUAGES` in `src/shared/config/languageConstants.js`.

---

## Key Files

-   **`src/shared/services/LanguageDetectionService.js`**: The central orchestrator (Brain).
-   **`src/shared/utils/text/textAnalysis.js`**: Unicode analysis (Engine).
-   **`src/shared/config/languageConstants.js`**: Source of Truth for all language codes & RTL status.
-   **`src/composables/shared/useTextDirection.js`**: Reactive UI direction interface.
-   **`src/features/translation/providers/LanguageSwappingService.js`**: Consumer for bilingual swapping.

---
**Last Updated**: May 2026
