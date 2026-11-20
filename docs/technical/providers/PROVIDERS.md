# Translation Provider Implementation Guide

## Overview

This document provides a comprehensive guide for implementing translation providers within the Translate-It system. The architecture has evolved into a **Coordinator-led model** where providers focus on raw execution while a central orchestrator handles language logic, normalization, and response consistency.

**Core Mandate**: All providers must inherit from `BaseProvider` (or its children) and adhere to the **Unified Response Contract**.

---

## Architecture Overview

The system is built upon a layered execution pipeline:

1.  **ProviderCoordinator** (`src/features/translation/core/ProviderCoordinator.js`): The central orchestration hub for all translation requests. It handles:
    - Language Swapping (Bilingual Logic).
    - Auto-detection fallbacks via `LanguageDetectionService`.
    - Result cleaning and normalization.
    - Coordination with `QueueManager` and `RateLimitManager`.
2.  **OptimizedJsonHandler** (`src/features/translation/core/managers/OptimizedJsonHandler.js`): A specialized orchestrator for complex, high-volume tasks (like Select Element) that manages intelligent batching and real-time streaming.
3.  **BaseProvider / BaseAIProvider / BaseTranslateProvider**: Modular base classes in `src/features/translation/providers/` that implement provider-specific logic (JSON mode, character limits, prompt prep).
4.  **Provider Utilities**: Specialized modules in `src/features/translation/providers/utils/` that handle heavy lifting like API execution (`ProviderRequestEngine`), parsing (`AIResponseParser`), and text processing (`AITextProcessor`).
5.  **ProviderManifest**: The single source of truth for provider metadata, located in `src/features/translation/providers/ProviderManifest.js`.

---

## Unified Response Contract

To prevent runtime crashes (like "split is not a function"), all providers (via the Coordinator) must return a **Unified Response Object**:

```javascript
{
  translatedText: string | array,  // The actual result
  detectedLanguage: string,       // ISO code (e.g., 'en', 'fa')
  provider: string,               // Provider name (e.g., 'GoogleGemini')
  sourceLanguage: string,         // Final source code used
  targetLanguage: string          // Final target code used
}
```

## Markdown Output Contract

Providers that emit dictionary-style or rich formatted output must follow a markdown-first contract:

- emit Markdown or plain text only
- never emit HTML
- use bold-label Markdown for dictionary sections
- use inline code for pronunciation / IPA snippets
- avoid display-specific wrappers or layout-driven formatting
- keep pronunciation metadata in the provider output only when it is part of the source content contract

New provider dictionary shapes must be covered by:

- provider contract tests
- markdown preview rendering tests
- extraction tests when the output affects TTS, copy, or export behavior

---

## Modularized Utilities (`src/features/translation/providers/utils/`)

### 1. Request & Execution
- **ProviderRequestEngine**: Centralizes API call execution, header preparation, proxy handling, and orchestrates the **Multi-API Key Failover** lifecycle.

### 2. AI & Context Logic
- **AIConversationHelper**: Manages session history and context-enriched prompt preparation (Injecting Page Title/Headings).
- **AITextProcessor**: Handles complexity analysis and smart segment splitting.
- **AIResponseParser**: Robustly parses results from AI artifacts (Markdown, JSON blocks) and cleans "AI Chatter." It exposes parser/mapping facts consumed by the provider recovery policy.

### 3. Traditional Provider Helpers
- **TraditionalTextProcessor**: Handles character-limit chunking and network weight calculation.
- **TraditionalStreamManager**: Orchestrates the streaming lifecycle for chunk-based traditional translations.

---

## Provider Implementation Workflow

### 1. Define Constants (`src/features/translation/providers/ProviderConstants.js`)
Add the constant ID and Name:
- `ProviderNames.YOUR_PROVIDER`: The class name (e.g., `'YourTranslate'`)
- `ProviderRegistryIds.YOUR_ID`: The registry ID (e.g., `'yourid'`)

### 2. Implement the Provider Class
Create a new class in `src/features/translation/providers/`:

#### A. AI Providers (Inherit from `BaseAIProvider`)
Implement `_callAI(systemPrompt, userText, options)`.
- Use `_preparePromptAndText` for standard context injection.
- AI providers should favor **JSON Mode** for batch requests.

#### B. Traditional Providers (Inherit from `BaseTranslateProvider`)
Implement `_translateChunk(chunkTexts, source, target, options)`.
- Respect `characterLimit` and `maxChunksPerBatch`.

#### C. Dictionary & Specialized Providers (Inherit from `BaseProvider`)
For providers that require specialized text processing (e.g., Dictionary lookups like Vajehyab):
- Implement the `_batchTranslate` method even for single-word lookups. This ensures the provider stays within the **Golden Chain** (Coordinator -> Queue -> StatsManager).
- Use `_executeApiCall` with explicit `sessionId` and `charCount` reporting to maintain statistical accuracy.
- Ensure the result adheres to the **Unified Response Contract**.

### 3. Register in the Manifest (`src/features/translation/providers/ProviderManifest.js`)
Add to `PROVIDER_MANIFEST`. This handles UI registration, icon mapping, and **Capability Gating**.

#### Provider Features (Capabilities)
The `features` array defines what the UI and Orchestrators allow for this provider. Use these flags to gate functionality:

| Feature | Description | Use Case |
| :--- | :--- | :--- |
| `translation` | Standard text-to-text translation. | Basic requirement for all translation engines. |
| `text` | Supports plain text processing. | Standard for almost all providers. |
| `autoDetect` | Provider can detect the source language natively. | Enables "Auto" source option without using local detection. |
| `bulk` | Supports high-volume, batch translation. | Required for **Page Translation** and **Select Element**. |
| `dictionary` | Provides rich definitions, kind (noun/verb), and pronunciation. | Enables formatted dictionary UI in Popup/Sidepanel. |
| `bilingual` | Enables the **Language Swapping Service**. | Allows auto-swapping Target to Source when input matches Target. |
| `smart` | Advanced AI processing capabilities. | Enables Smart Context and AI-specific UI enhancements. |
| `offline` | Works without an external internet connection. | For Local LLMs or Native Browser APIs. |
| `context` | Supports injecting Page Titles/Headings as context. | Used by AI providers to improve accuracy based on surrounding text. |
| `streaming` | Supports real-time chunked response delivery. | Required for the "Typing Effect" in UI during long translations. |
| `formality` | Supports Formal/Informal tone settings. | Specifically for DeepL and advanced AI prompts. |
| `configurable` | Supports custom API URLs and model selections. | Used for OpenAI-compatible and Custom providers. |
| `autoLanguage` | Specialized dictionary-centric language detection. | Used by Vajehyab to prioritize Persian context. |

---

## Implementation Rules & Best Practices

### 1. Coordination Principle
**NEVER override the `translate()` method.** 
The `BaseProvider.translate()` method delegates to the `ProviderCoordinator`, which orchestrates critical services like Language Detection and Bilingual Swapping. Physical API-call stats are recorded separately by `ProviderRequestEngine` (see [STATS_MANAGER.md](../infrastructure/STATS_MANAGER.md)), not by `ProviderCoordinator`. All custom logic—including specialized dictionary preprocessing—must be implemented within `_batchTranslate` or lower-level utilities.

### 2. Optimization Level AwarenessProviders must be "Optimization-Aware." Use the `getProviderOptimizationLevelAsync` helper to adjust behavior:
- **Level 1 (Economy)**: Large batches, low concurrency.
- **Level 5 (Turbo)**: May increase concurrency according to provider and runtime configuration. For Select Element, physical batching remains pinned at `optimalSize: 25` and `characterLimit: 3500`; optimization levels must not scale these mode overrides. Progressive Select Element updates come from validated batch publication in `OptimizedJsonHandler`. Provider streaming remains capability- and execution-path-specific.

### 3. Language Normalization
Implement `convertLanguage(code)` in your provider class to map standard ISO codes to provider-specific codes (e.g., `fa` -> `farsi` for legacy APIs).

### DeepL language metadata and formality
DeepL language choices are validated using the [v3 languages endpoint](https://developers.deepl.com/docs/languages/using-the-languages-api), requested with `resource=translate_text&include=beta` for either Free or Pro credentials. Its source/target capability flags and status distinguish supported directions and beta languages. In Options, this metadata applies only while DeepL is the global primary provider; unsupported or unverifiable selections are preserved but cannot be saved until metadata verifies them. Translation requests continue to use the [v2 translate endpoint](https://developers.deepl.com/api-reference/translate/request-translation) and do not send the deprecated `enable_beta_languages` parameter.

Formality preference values (`prefer_more` and `prefer_less`) can be sent without a catalog. Strict `more` or `less` values are sent only when fresh metadata verifies formality support for the selected target; otherwise they are omitted from the request, while the saved preference remains unchanged.

### 4. Segment Mapping (The "Split" Safety)
If your provider merges multiple text segments into a single request, you **MUST** ensure they are split back correctly.
- AI: Use `AIResponseParser.parseBatchResult`. `parseBatchResult(...)` also reports whether structured-response recovery is required, while the provider decides whether recovery is performed.
- Traditional: Use `TranslationSegmentMapper.mapTranslationToOriginalSegments`.

### 5. Structured Response Handling

For the logical identity and split-fragment contract that governs how structured results are deduplicated and reassembled, see [TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md](../contracts/TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md).

> **Contracts:** [Provider Contract](../contracts/PROVIDER_CONTRACT.md) covers provider result/error/retry/health/stats contracts; [Conversation Contract](../contracts/CONVERSATION_CONTRACT.md) covers conversation-candidate participation for AI providers.

Structured (JSON) responses can violate their response contract — for example through unmapped or gap-filled slots, or an unparseable response. The system recovers explicitly instead of silently corrupting results.

- **`AIResponseParser`** parses structured responses and provides parser/mapping facts; it does not decide semantic provider validity or recovery policy.
- **`BaseAIProvider`** owns structured recovery: it selectively repairs safely mapped invalid units and merges those repairs into the original indexes, or retries the entire original batch once in the same structured format when mapping is unsafe. A valid full retry replaces the rejected primary; a second contract violation fails the batch. See the [Provider Contract](../contracts/PROVIDER_CONTRACT.md#11-structured-ai-response-contract) for guarantees.
- **Recovery is a provider-local recovery pass**, not a silent result rewrite, and recovery failure remains a provider failure.

A structured contract violation does not unconditionally require recovery of the entire batch. See [`TRANSLATION_PROVIDER_LOGIC.md`](../TRANSLATION_PROVIDER_LOGIC.md) for recovery execution policy and [`PROVIDER_CONTRACT.md`](../contracts/PROVIDER_CONTRACT.md) for provider result/recovery guarantees.

#### Repair-Aware Recovery

Structured recovery may receive transient, failure-specific repair context. Provider authors must not implement independent recovery loops; recovery remains a single provider-local pass driven by parser/mapping facts.

> **V3 provider guidance:** providers must preserve V3 marker count, identity, and order, and keep semantic content for one source interval inside its corresponding translated interval. A meaningful source interval must not translate to a blank interval (`V3_EMPTY_TRANSLATED_INTERVAL`). See [`PROVIDER_CONTRACT.md`](../contracts/PROVIDER_CONTRACT.md) and [ADR-015](../../adr/ADR-015-translation-outcome-semantics.md) for the V3 provider-contract ownership decision.

---

## Stability, Rate Limiting & Failover

### 1. Multi-API Key Failover
The system supports multiple API keys per provider (stored as newline-separated strings).
- **Automatic Rotation**: If a key fails with a "Retryable Error" (Quota Exceeded, Invalid Key, Rate Limit), the `ProviderRequestEngine` automatically switches to the next available key.
- **Key Promotion**: Successfully used keys are "promoted" to the top of the list to ensure the fastest start for subsequent requests.
- **Validation**: The `ApiKeyManager` provides tools to test and reorder keys, ensuring valid keys are always prioritized.

### 2. Priority-Based Scheduling
Requests are queued based on their impact on UX:
- **HIGH**: Interactive UI (Popup, Selection, Sidepanel).
- **NORMAL**: Standard on-demand requests.
- **LOW**: Background tasks (Whole Page Translation).

### 3. Circuit Breaker
If all available keys fail or the provider is consistently unstable, the **RateLimitManager** "opens the circuit," temporarily disabling the provider for **30 seconds** (default `circuitRecoveryTime`) to prevent wasted requests and UI lag. Rate limiting and circuit recovery are owned by `RateLimitManager`; it also exposes adaptive backoff and priority-based admission.

---

## Services & Specialized Components

- **RateLimitManager**: Owns active provider admission, adaptive delay, and circuit behavior.
- **ApiKeyManager**: Manages the lifecycle of API keys, failover logic, and health testing.
- **LanguageDetectionService**: Used by the Coordinator to resolve `auto` source languages.
- **LanguageSwappingService**: Implements Bilingual Logic (swapping based on detected input).
- **StreamingManager**: A global registry that coordinates real-time UI updates from multiple background streams.

---

**Last Updated**: August 2026
