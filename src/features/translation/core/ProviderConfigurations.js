/**
 * Provider Configurations - Centralized configuration for all translation providers
 * Defines provider-specific optimizations for rate limiting, batching, streaming, and error handling
 */

import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { ProviderNames } from "@/features/translation/providers/ProviderConstants.js";
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';

const logger = getScopedLogger(LOG_COMPONENTS.TRANSLATION, 'ProviderConfigurations');

/**
 * Expected format of the translation response.
 * Used to enforce strict contracts between orchestrators and providers.
 */
export const ResponseFormat = {
  STRING: 'STRING',           // Plain text (Popup, Selection, single segments)
  JSON_ARRAY: 'JSON_ARRAY',   // Array of strings (Standard AI Batching)
  JSON_OBJECT: 'JSON_OBJECT', // Array of objects with IDs (Select Element, Page Translation)
  AUTO: 'AUTO'                // Heuristic-based fallback (legacy)
};

/**
 * Standard delimiter for separating text segments in batch translation.
 * Using a resilient pattern that traditional providers are less likely to merge.
 */
export const DEFAULT_TEXT_DELIMITER = '\n[[---]]\n';

/**
 * Alternative delimiters for fallback splitting when the standard delimiter fails.
 */
export const ALTERNATIVE_DELIMITERS = [
  '[[---]]',
  '\n\n---\n\n',
  '\n---\n',
  '---',
  '\n\n',
  '\n',
];

/**
 * Thresholds for deciding when to use streaming (in characters)
 */
export const STREAMING_THRESHOLDS = {
  AI: 500,
  TRADITIONAL: 2000,
};

/**
 * Character limits for conversation history to optimize tokens
 */
export const HISTORY_CHARACTER_LIMITS = {
  AI: 300,      // Max characters per history message for AI providers
  DEEPL: 150,   // Max characters for DeepL context snippets
};

/**
 * Baseline Character Limits for traditional providers
 */
export const BASE_CHARACTER_LIMITS = {
  GOOGLE: 5000,
  BING: 4000,
  YANDEX: 10000,
  DEEPL: 10000,
  EDGE: 5000,
  BROWSER: 10000,
  LINGVA: 1500,
};

/**
 * Baseline Max Segments per request (optimization preference)
 */
export const BASE_MAX_CHUNKS_PER_BATCH = {
  GOOGLE: 150,
  BING: 10,
  YANDEX: 100,
  DEEPL: 50,
  EDGE: 100,
  BROWSER: 50,
  LINGVA: 30,
};

/**
 * AI-specific batching limits
 */
export const AI_BATCHING_LIMITS = {
  OPTIMAL_SIZE: 20,
  MAX_COMPLEXITY: 350,
  CHARACTER_LIMIT: 5000,
  // Select Element Overrides (Optimized for balance)
  SELECT_OPTIMAL_SIZE: 25,
  SELECT_MAX_COMPLEXITY: 500,
  SELECT_CHARACTER_LIMIT: 3500,
};

const UNIFIED_AI_BATCHING_CONFIG = {
  strategy: 'json', // Default to JSON for all AI providers
  optimalSize: AI_BATCHING_LIMITS.OPTIMAL_SIZE,
  maxComplexity: AI_BATCHING_LIMITS.MAX_COMPLEXITY,
  characterLimit: AI_BATCHING_LIMITS.CHARACTER_LIMIT,
  modeOverrides: {
    select_element: {
      optimalSize: AI_BATCHING_LIMITS.SELECT_OPTIMAL_SIZE,
      maxComplexity: AI_BATCHING_LIMITS.SELECT_MAX_COMPLEXITY,
      characterLimit: AI_BATCHING_LIMITS.SELECT_CHARACTER_LIMIT,
      balancedBatching: true,
    },
  },
};

/**
 * Provider-specific configurations
 * Each provider has optimized settings based on their API characteristics and limitations
 */
export const PROVIDER_CONFIGURATIONS = {
  // Google Gemini - Optimized settings for Select Element performance
  Gemini: {
    rateLimit: {
      maxConcurrent: 3, // Increased for even better throughput
      delayBetweenRequests: 0, // No delay for first request, adaptive backoff handles errors
      adaptiveBackoff: {
        enabled: true,
        baseMultiplier: 2, // Reduced multiplier for less aggressive backoff
        maxDelay: 30000, // Reduced max delay for faster recovery
        resetAfterSuccess: 3 // Faster recovery after success
      },
      // Mode-specific overrides
      modeOverrides: {
        select_element: {
          maxConcurrent: 3 // Maintain concurrency for Select Element
        }
      }
    },
    batching: UNIFIED_AI_BATCHING_CONFIG,
    streaming: {
      enabled: true,
      chunkSize: 'adaptive', // Adapt chunk size based on complexity
      realTimeUpdates: true
    },
    errorHandling: {
      quotaTypes: [
        'requests_per_minute',
        'tokens_per_minute', 
        'requests_per_day',
        'concurrent_requests',
        'model_overloaded'
      ],
      enableCircuitBreaker: true
    },
    features: {
      supportsTranslation: true,
      supportsBatchRequests: true,
      supportsThinking: true,
      reliableJsonMode: false,
      supportsDictionary: true
    }
  },

  // OpenAI - Moderate settings with good streaming support
  OpenAI: {
    rateLimit: {
      maxConcurrent: 2,
      delayBetweenRequests: 0, // No delay for first request
      adaptiveBackoff: {
        enabled: true,
        baseMultiplier: 1.5,
        maxDelay: 30000, // 30 seconds max delay
        resetAfterSuccess: 2
      },
      // Mode-specific overrides
      modeOverrides: {
        select_element: {
          maxConcurrent: 2 // Maintain concurrency for Select Element
        }
      }
    },
    batching: UNIFIED_AI_BATCHING_CONFIG,
    streaming: {
      enabled: true,
      chunkSize: 'fixed', // Fixed chunk sizes work well
      realTimeUpdates: true
    },
    errorHandling: {
      quotaTypes: [
        'requests_per_minute',
        'tokens_per_minute',
        'requests_per_day'
      ],
      enableCircuitBreaker: true
    },
    features: {
      supportsTranslation: true,
      supportsBatchRequests: true,
      supportsThinking: false,
      reliableJsonMode: true,
      supportsDictionary: true
    }
  },

  // DeepSeek - Optimized settings for better performance
  DeepSeek: {
    rateLimit: {
      maxConcurrent: 2, // Increased from 1 for better throughput
      delayBetweenRequests: 0, // No delay for first request
      adaptiveBackoff: {
        enabled: true,
        baseMultiplier: 2,
        maxDelay: 30000,
        resetAfterSuccess: 2
      },
      // Mode-specific overrides
      modeOverrides: {
        select_element: {
          maxConcurrent: 2 // Maintain concurrency for Select Element
        }
      }
    },
    batching: UNIFIED_AI_BATCHING_CONFIG,
    streaming: {
      enabled: true, // Enable streaming for real-time segment translation
      chunkSize: 'fixed',
      realTimeUpdates: true
    },
    errorHandling: {
      quotaTypes: [
        'requests_per_minute',
        'rate_limit'
      ],
      enableCircuitBreaker: true
    },
    features: {
      supportsTranslation: true,
      supportsBatchRequests: true, // Enable batch requests for streaming
      supportsThinking: true,
      reliableJsonMode: false,
      supportsDictionary: true
    }
  },

  // OpenRouter - Optimized settings for multi-model support
  OpenRouter: {
    rateLimit: {
      maxConcurrent: 2,
      delayBetweenRequests: 0, // No delay for first request
      adaptiveBackoff: {
        enabled: true,
        baseMultiplier: 1.8,
        maxDelay: 45000,
        resetAfterSuccess: 2
      },
      // Mode-specific overrides
      modeOverrides: {
        select_element: {
          maxConcurrent: 3 // Increased from 2 for Select Element
        }
      }
    },
    batching: UNIFIED_AI_BATCHING_CONFIG,
    streaming: {
      enabled: true, // Most models support streaming
      chunkSize: 'adaptive',
      realTimeUpdates: true
    },
    errorHandling: {
      quotaTypes: [
        'requests_per_minute',
        'tokens_per_minute',
        'model_overloaded'
      ],
      enableCircuitBreaker: true
    },
    features: {
      supportsTranslation: true,
      supportsBatchRequests: true,
      supportsThinking: false, // Varies by model
      reliableJsonMode: true,
      supportsDictionary: true
    }
  },

  // Requesty - Optimized settings for multi-model support
  Requesty: {
    rateLimit: {
      maxConcurrent: 2,
      delayBetweenRequests: 0, // No delay for first request
      adaptiveBackoff: {
        enabled: true,
        baseMultiplier: 1.8,
        maxDelay: 45000,
        resetAfterSuccess: 2
      },
      // Mode-specific overrides
      modeOverrides: {
        select_element: {
          maxConcurrent: 3 // Increased from 2 for Select Element
        }
      }
    },
    batching: UNIFIED_AI_BATCHING_CONFIG,
    streaming: {
      enabled: true, // Most models support streaming
      chunkSize: 'adaptive',
      realTimeUpdates: true
    },
    errorHandling: {
      quotaTypes: [
        'requests_per_minute',
        'tokens_per_minute',
        'model_overloaded'
      ],
      enableCircuitBreaker: true
    },
    features: {
      supportsTranslation: true,
      supportsBatchRequests: true,
      supportsThinking: false, // Varies by model
      reliableJsonMode: true,
      supportsDictionary: true
    }
  },

  // Cheaper Inference - Optimized settings for multi-model support
  CheaperInference: {
    rateLimit: {
      maxConcurrent: 2,
      delayBetweenRequests: 0, // No delay for first request
      adaptiveBackoff: {
        enabled: true,
        baseMultiplier: 1.8,
        maxDelay: 45000,
        resetAfterSuccess: 2
      },
      // Mode-specific overrides
      modeOverrides: {
        select_element: {
          maxConcurrent: 3 // Increased from 2 for Select Element
        }
      }
    },
    batching: UNIFIED_AI_BATCHING_CONFIG,
    streaming: {
      enabled: true, // Most models support streaming
      chunkSize: 'adaptive',
      realTimeUpdates: true
    },
    errorHandling: {
      quotaTypes: [
        'requests_per_minute',
        'tokens_per_minute',
        'model_overloaded'
      ],
      enableCircuitBreaker: true
    },
    features: {
      supportsTranslation: true,
      supportsBatchRequests: true,
      supportsThinking: false, // Varies by model
      reliableJsonMode: true,
      supportsDictionary: true
    }
  },

  // WebAI - External API service (similar to other providers)
  WebAI: {
    rateLimit: {
      maxConcurrent: 2, // Standard concurrent requests
      delayBetweenRequests: 0, // No delay for first request
      adaptiveBackoff: {
        enabled: true,
        baseMultiplier: 1.5,
        maxDelay: 30000,
        resetAfterSuccess: 2
      },
      // Mode-specific overrides
      modeOverrides: {
        select_element: {
          maxConcurrent: 2 // Maintain concurrency for Select Element
        }
      }
    },
    batching: UNIFIED_AI_BATCHING_CONFIG,
    streaming: {
      enabled: true, // Enable streaming for real-time segment translation
      chunkSize: 'fixed',
      realTimeUpdates: true
    },
    errorHandling: {
      quotaTypes: [
        'requests_per_minute',
        'rate_limit',
        'server_overload'
      ],
      enableCircuitBreaker: true
    },
    features: {
      supportsTranslation: true,
      supportsBatchRequests: true, // Enable batch requests
      supportsThinking: false,
      reliableJsonMode: false,
      supportsDictionary: true
    }
  },

  // Google Translate - Free translation service settings
  GoogleTranslate: {
    queueRetryPolicy: {
      maxExecutions: {
        [ErrorTypes.RATE_LIMIT_REACHED]: 3,
      },
    },
    rateLimit: {
      maxConcurrent: 4, // Moderate concurrent requests
      delayBetweenRequests: 0, // No delay for first request
      adaptiveBackoff: {
        enabled: true,
        baseMultiplier: 1.5,
        maxDelay: 10000,
        resetAfterSuccess: 2
      }
    },
    batching: {
      strategy: 'character_limit', // Use character-based chunking
      characterLimit: BASE_CHARACTER_LIMITS.GOOGLE,
      optimalSize: 40,
      maxChunksPerBatch: BASE_MAX_CHUNKS_PER_BATCH.GOOGLE,
      delimiter: DEFAULT_TEXT_DELIMITER // Standard resilient delimiter
    },
    streaming: {
      enabled: true, // Enable streaming for real-time chunk translation
      chunkSize: 'character_based',
      realTimeUpdates: true
    },
    errorHandling: {
      quotaTypes: [
        'requests_per_minute',
        'daily_quota',
        'rate_limit'
      ],
      enableCircuitBreaker: true
    },
    features: {
      supportsTranslation: true,
      supportsBatchRequests: true, // Supports batch via chunking
      supportsThinking: false,
      reliableJsonMode: true,
      supportsDictionary: true // Google supports dictionary
    }
  },

  // Google Translate V2 - Robust translation service settings
  GoogleTranslateV2: {
    queueRetryPolicy: {
      maxExecutions: {
        [ErrorTypes.RATE_LIMIT_REACHED]: 3,
      },
    },
    rateLimit: {
      maxConcurrent: 4,
      delayBetweenRequests: 0,
      adaptiveBackoff: {
        enabled: true,
        baseMultiplier: 1.5,
        maxDelay: 20000,
        resetAfterSuccess: 2
      }
    },
    batching: {
      strategy: 'character_limit',
      characterLimit: BASE_CHARACTER_LIMITS.GOOGLE,
      optimalSize: 40, // Base segment limit that scales with optimization level
      maxChunksPerBatch: BASE_MAX_CHUNKS_PER_BATCH.GOOGLE, // Use standardized limit
      delimiter: DEFAULT_TEXT_DELIMITER
    },
    streaming: {
      enabled: true,
      chunkSize: 'character_based',
      realTimeUpdates: true
    },
    errorHandling: {
      quotaTypes: [
        'requests_per_minute',
        'rate_limit',
        'tkk_error'
      ],
      enableCircuitBreaker: true
    },
    features: {
      supportsTranslation: true,
      supportsBatchRequests: true,
      supportsThinking: false,
      reliableJsonMode: false,
      supportsDictionary: true
    }
  },

  // Yandex Translate - Free translation service settings
  YandexTranslate: {
    queueRetryPolicy: {
      maxExecutions: {
        [ErrorTypes.RATE_LIMIT_REACHED]: 3,
      },
    },
    rateLimit: {
      maxConcurrent: 4, // Moderate concurrent requests
      delayBetweenRequests: 0, // No delay for first request
      adaptiveBackoff: {
        enabled: true,
        baseMultiplier: 1.5,
        maxDelay: 15000,
        resetAfterSuccess: 2
      }
    },
    batching: {
      strategy: 'character_limit', // Use character-based chunking
      characterLimit: BASE_CHARACTER_LIMITS.YANDEX,
      optimalSize: 40,
      maxChunksPerBatch: BASE_MAX_CHUNKS_PER_BATCH.YANDEX,
      delimiter: null // Yandex uses array format
    },
    streaming: {
      enabled: true, // Enable streaming for real-time chunk translation
      chunkSize: 'character_based',
      realTimeUpdates: true
    },
    errorHandling: {
      quotaTypes: [
        'requests_per_minute',
        'daily_quota',
        'rate_limit',
        'server_error'
      ],
      enableCircuitBreaker: true
    },
    features: {
      supportsTranslation: true,
      supportsBatchRequests: true, // Supports batch via chunking
      supportsThinking: false,
      reliableJsonMode: true,
      supportsDictionary: false
    }
  },

  // DeepL Translate - Premium translation service settings
  DeepLTranslate: {
    queueRetryPolicy: {
      maxExecutions: {
        [ErrorTypes.RATE_LIMIT_REACHED]: 3,
      },
    },
    rateLimit: {
      maxConcurrent: 5, // Higher for paid API
      delayBetweenRequests: 0, // No delay for first request
      adaptiveBackoff: {
        enabled: true,
        baseMultiplier: 1.5,
        maxDelay: 30000,
        resetAfterSuccess: 2
      }
    },
    batching: {
      strategy: 'character_limit', // Use character-based chunking
      characterLimit: BASE_CHARACTER_LIMITS.DEEPL,
      optimalSize: 50,
      maxChunksPerBatch: BASE_MAX_CHUNKS_PER_BATCH.DEEPL,
      maxSegmentsPerRequest: 50,
      delimiter: null // DeepL uses array format
    },
    streaming: {
      enabled: true, // Enable streaming for real-time chunk translation
      chunkSize: 'character_based',
      realTimeUpdates: true
    },
    errorHandling: {
      quotaTypes: [
        'requests_per_minute',
        'character_limit',
        'daily_quota',
        'invalid_api_key'
      ],
      enableCircuitBreaker: true
    },
    features: {
      supportsTranslation: true,
      supportsBatchRequests: true, // DeepL supports batch requests
      supportsThinking: false,
      reliableJsonMode: false,
      supportsDictionary: false, // DeepL doesn't support dictionary
      supportsFormality: true // DeepL-specific feature
    }
  },

  // Bing Translate - Microsoft translation service settings
  BingTranslate: {
    queueRetryPolicy: {
      maxExecutions: {
        [ErrorTypes.RATE_LIMIT_REACHED]: 3,
      },
    },
    rateLimit: {
      maxConcurrent: 3, // Conservative due to HTML response issues
      delayBetweenRequests: 0, // No delay for first request
      adaptiveBackoff: {
        enabled: true,
        baseMultiplier: 2, // Aggressive backoff for HTML responses
        maxDelay: 30000,
        resetAfterSuccess: 3
      }
    },
    batching: {
      strategy: 'character_limit', // Use character-based chunking
      characterLimit: BASE_CHARACTER_LIMITS.BING,
      optimalSize: 20,
      maxChunksPerBatch: BASE_MAX_CHUNKS_PER_BATCH.BING,
      delimiter: DEFAULT_TEXT_DELIMITER, // Standard resilient delimiter
      adaptiveChunking: true, // Enable adaptive chunking for errors
      minChunkSize: 100, // Minimum chunk size for retry
      maxRetries: 3 // Maximum retry attempts
    },
    streaming: {
      enabled: true, // Enable streaming for real-time chunk translation
      chunkSize: 'character_based',
      realTimeUpdates: true
    },
    errorHandling: {
      quotaTypes: [
        'requests_per_minute',
        'rate_limit',
        'html_response', // Bing-specific error
        'json_parsing_error',
        'server_error'
      ],
      enableCircuitBreaker: true,
      circuitBreakThreshold: 3 // Open circuit after 3 failures (reduced from default 5)
    },
    features: {
      supportsTranslation: true,
      supportsBatchRequests: true, // Supports batch via chunking
      supportsThinking: false,
      reliableJsonMode: true, // Bing usually provides reliable JSON
      supportsDictionary: false // Bing doesn't support dictionary
    }
  },

  // Microsoft Edge - Official Edge Browser translation service
  MicrosoftEdge: {
    queueRetryPolicy: {
      maxExecutions: {
        [ErrorTypes.RATE_LIMIT_REACHED]: 3,
      },
    },
    rateLimit: {
      maxConcurrent: 5, // Increased from 4
      delayBetweenRequests: 0,
      adaptiveBackoff: {
        enabled: true,
        baseMultiplier: 1.5,
        maxDelay: 20000,
        resetAfterSuccess: 2
      }
    },
    batching: {
      strategy: 'character_limit',
      characterLimit: BASE_CHARACTER_LIMITS.EDGE,
      optimalSize: 40, // Base segment limit for Edge
      maxChunksPerBatch: BASE_MAX_CHUNKS_PER_BATCH.EDGE, // Edge API supports large batches
      delimiter: null // Uses JSON array
    },
    streaming: {
      enabled: true,
      chunkSize: 'character_based',
      realTimeUpdates: true
    },
    errorHandling: {
      quotaTypes: [
        'requests_per_minute',
        'rate_limit',
        'auth_error'
      ],
      enableCircuitBreaker: true
    },
    features: {
      supportsTranslation: true,
      supportsBatchRequests: true, // Enable batch requests
      supportsThinking: false,
      reliableJsonMode: true,
      supportsDictionary: false
    }
  },

  // Browser API - Chrome's built-in translation (Local)
  BrowserAPI: {
    rateLimit: {
      maxConcurrent: 5, // High for local processing
      delayBetweenRequests: 0,
    },
    batching: {
      strategy: 'character_limit',
      characterLimit: BASE_CHARACTER_LIMITS.BROWSER,
      optimalSize: 50,
      maxChunksPerBatch: BASE_MAX_CHUNKS_PER_BATCH.BROWSER,
      delimiter: DEFAULT_TEXT_DELIMITER
    },
    streaming: {
      enabled: false, // Local API is atomic
      chunkSize: 'character_based',
      realTimeUpdates: true
    },
    errorHandling: {
      quotaTypes: ['api_unavailable', 'language_not_supported'],
      enableCircuitBreaker: true
    },
    features: {
      supportsTranslation: true,
      supportsBatchRequests: true,
      supportsThinking: false,
      reliableJsonMode: true
    }
  },

  // Vajehyab - Persian dictionary service
  Vajehyab: {
    queueRetryPolicy: {
      maxExecutions: {
        [ErrorTypes.RATE_LIMIT_REACHED]: 3,
      },
    },
    rateLimit: {
      maxConcurrent: 2,
      delayBetweenRequests: 1000,
    },
    batching: {
      strategy: 'character_limit',
      characterLimit: 100, // Small limit for dictionary words
      optimalSize: 1,
      maxChunksPerBatch: 1,
      delimiter: DEFAULT_TEXT_DELIMITER
    },
    streaming: {
      enabled: false,
      chunkSize: 'character_based',
      realTimeUpdates: true
    },
    errorHandling: {
      quotaTypes: ['rate_limit', 'word_not_found'],
      enableCircuitBreaker: true
    },
    features: {
      supportsTranslation: true,
      supportsBatchRequests: false,
      supportsThinking: false,
      reliableJsonMode: true,
      supportsDictionary: true
    }
  },

  // Lingva - Open-source Google Translate front-end settings
  Lingva: {
    queueRetryPolicy: {
      maxExecutions: {
        [ErrorTypes.RATE_LIMIT_REACHED]: 3,
      },
    },
    rateLimit: {
      maxConcurrent: 3, // Conservative for public instances
      delayBetweenRequests: 0,
      adaptiveBackoff: {
        enabled: true,
        baseMultiplier: 2,
        maxDelay: 30000,
        resetAfterSuccess: 2
      }
    },
    batching: {
      strategy: 'character_limit',
      characterLimit: BASE_CHARACTER_LIMITS.LINGVA, // Safe for GET URL lengths
      optimalSize: 15,      // Base segment limit
      maxChunksPerBatch: BASE_MAX_CHUNKS_PER_BATCH.LINGVA,
      delimiter: null // Uses JSON POST in config, but GET in provider (provider overrides)
    },
    streaming: {
      enabled: true,
      chunkSize: 'character_based',
      realTimeUpdates: true
    },
    errorHandling: {
      quotaTypes: [
        'requests_per_minute',
        'rate_limit'
      ],
      enableCircuitBreaker: true
    },
    features: {
      supportsTranslation: true,
      supportsBatchRequests: true, // Supports batch via chunking
      supportsThinking: false,
      reliableJsonMode: true,
      supportsDictionary: false
    }
  },

  // Custom Provider - Flexible/configurable settings
  Custom: {
    rateLimit: {
      maxConcurrent: 2, // Safe default
      delayBetweenRequests: 0, // No delay for first request
      adaptiveBackoff: {
        enabled: true,
        baseMultiplier: 1.5,
        maxDelay: 30000,
        resetAfterSuccess: 2
      },
      // Mode-specific overrides
      modeOverrides: {
        select_element: {
          maxConcurrent: 2 // Maintain concurrency for Select Element
        }
      }
    },
    batching: UNIFIED_AI_BATCHING_CONFIG,
    streaming: {
      enabled: true, // Enable streaming for real-time segment translation
      chunkSize: 'fixed',
      realTimeUpdates: true
    },
    errorHandling: {
      quotaTypes: [
        'requests_per_minute',
        'rate_limit',
        'quota_exceeded'
      ],
      enableCircuitBreaker: true
    },
    features: {
      supportsTranslation: true,
      supportsBatchRequests: true, // Enable batch requests for streaming
      supportsThinking: false,
      reliableJsonMode: false,
      supportsDictionary: true
    }
  },

  // Mock Provider - Used for development and testing
  MockProvider: {
    rateLimit: {
      maxConcurrent: 5, // High for local mock testing
      delayBetweenRequests: 0,
      adaptiveBackoff: {
        enabled: true,
        baseMultiplier: 1.5,
        maxDelay: 5000,
        resetAfterSuccess: 2
      }
    },
    batching: {
      ...UNIFIED_AI_BATCHING_CONFIG,
      characterLimit: 2000,
      optimalSize: 5
    },
    streaming: {
      enabled: true,
      chunkSize: 'fixed',
      realTimeUpdates: true
    },
    errorHandling: {
      quotaTypes: ['rate_limit'],
      enableCircuitBreaker: true
    },
    features: {
      supportsTranslation: true,
      supportsBatchRequests: true,
      supportsThinking: true,
      reliableJsonMode: true,
      supportsDictionary: true
    }
  }
};

const PROVIDER_NAME_MAPPING = {
  'gemini': ProviderNames.GEMINI,
  'google-gemini': ProviderNames.GEMINI,
  'googlegemini': ProviderNames.GEMINI,
  'openai': ProviderNames.OPENAI,
  'gpt': ProviderNames.OPENAI,
  'chatgpt': ProviderNames.OPENAI,
  'deepseek': ProviderNames.DEEPSEEK,
  'openrouter': ProviderNames.OPENROUTER,
  'requesty': ProviderNames.REQUESTY,
  'cheaperinference': ProviderNames.CHEAPERINFERENCE,
  'webai': ProviderNames.WEBAI,
  'googletranslate': ProviderNames.GOOGLE_TRANSLATE,
  'google-translate': ProviderNames.GOOGLE_TRANSLATE,
  'googletranslatev2': ProviderNames.GOOGLE_TRANSLATE_V2,
  'googlev2': ProviderNames.GOOGLE_TRANSLATE_V2,
  'google-v2': ProviderNames.GOOGLE_TRANSLATE_V2,
  'google-robust': ProviderNames.GOOGLE_TRANSLATE_V2,
  'yandextranslate': ProviderNames.YANDEX_TRANSLATE,
  'yandex-translate': ProviderNames.YANDEX_TRANSLATE,
  'yandex': ProviderNames.YANDEX_TRANSLATE,
  'deepl': ProviderNames.DEEPL_TRANSLATE,
  'deepltranslate': ProviderNames.DEEPL_TRANSLATE,
  'deep-l': ProviderNames.DEEPL_TRANSLATE,
  'bingtranslate': ProviderNames.BING_TRANSLATE,
  'bing-translate': ProviderNames.BING_TRANSLATE,
  'bing': ProviderNames.BING_TRANSLATE,
  'edge': ProviderNames.MICROSOFT_EDGE,
  'microsoftedge': ProviderNames.MICROSOFT_EDGE,
  'microsoft-edge': ProviderNames.MICROSOFT_EDGE,
  'lingva': ProviderNames.LINGVA,
  'lingvatranslate': ProviderNames.LINGVA,
  'lingva-translate': ProviderNames.LINGVA,
  // Browser provider name differs from its configuration key.
  'browser': 'BrowserAPI',
  'browserapi': 'BrowserAPI',
  'browsertranslate': 'BrowserAPI',
  'browserranslate': 'BrowserAPI',
  'vajehyab': ProviderNames.VAJEHYAB,
  'mock': ProviderNames.MOCK,
  'mockprovider': ProviderNames.MOCK,
  'custom': ProviderNames.CUSTOM,
  'custom-openai': ProviderNames.CUSTOM
};

/**
 * Normalize provider name only when it matches a known provider alias.
 * @param {string} providerName - Provider name or registry alias
 * @returns {string|null} - Canonical provider name or null when unknown
 */
function normalizeKnownProviderName(providerName) {
  if (!providerName || typeof providerName !== 'string') return null;
  return PROVIDER_NAME_MAPPING[providerName.toLowerCase()] || null;
}

/**
 * Resolve a provider configuration without applying Custom fallback semantics.
 * @param {string} providerName - Provider name or registry alias
 * @returns {object|null} - Known provider configuration or null when unknown
 */
export function resolveKnownProviderConfiguration(providerName) {
  const normalizedName = normalizeKnownProviderName(providerName);
  return normalizedName ? PROVIDER_CONFIGURATIONS[normalizedName] || null : null;
}

/**
 * Get configuration for a specific provider
 * @param {string} providerName - Name of the provider
 * @param {number} level - Optimization level (1-5, default 3)
 * @returns {object} - Provider configuration
 */
export function getProviderConfiguration(providerName, level = 3) {
  // Normalize provider name (handle case variations)
  const baseConfig = resolveKnownProviderConfiguration(providerName);
  if (!baseConfig) {
    logger.warn(`[ProviderConfigurations] No configuration found for provider: ${providerName}, using Custom defaults`);
    return applyOptimizationLevel(PROVIDER_CONFIGURATIONS.Custom, level);
  }

  return applyOptimizationLevel(baseConfig, level);
}

/**
 * Apply optimization level (1-5) to a provider's base configuration
 * Level 1: Stability/Economy (Lower concurrency, larger batches for AI, higher delays for traditional)
 * Level 3: Balanced (Default)
 * Level 5: Turbo (Higher concurrency, smaller batches for faster UX, lower delays)
 * @private
 */
function applyOptimizationLevel(config, level) {
  const safeLevel = Math.max(1, Math.min(5, level));
  if (safeLevel === 3) return config; // Already optimized for level 3

  const result = { ...config, rateLimit: { ...config.rateLimit }, batching: { ...config.batching } };

  // Multipliers for different optimization levels
  const concurrentMultipliers = { 1: 0.4, 2: 0.7, 3: 1, 4: 1.5, 5: 2.0 };
  const delayMultipliers = { 1: 2.5, 2: 1.5, 3: 1, 4: 0.7, 5: 0.4 };
  const aiSizeMultipliers = { 1: 2.5, 2: 1.5, 3: 1, 4: 0.6, 5: 0.3 };
  const sizeMultipliers = { 1: 1.5, 2: 1.2, 3: 1, 4: 0.8, 5: 0.6 };

  // Base-2 providers need a visible step-up at Level 2 so low and medium
  // optimization modes are not concurrency-identical. Larger base values keep
  // the standard multiplier curve.
  const scaleConcurrentLimit = (baseConcurrent, levelValue) => {
    if (baseConcurrent === 2) {
      const baseTwoCurve = { 1: 1, 2: 2, 3: 2, 4: 3, 5: 4 };
      return baseTwoCurve[levelValue];
    }

    if (levelValue < 3) {
      return Math.max(1, Math.floor(baseConcurrent * concurrentMultipliers[levelValue]));
    }

    if (levelValue > 3) {
      return Math.max(baseConcurrent, Math.ceil(baseConcurrent * concurrentMultipliers[levelValue]));
    }

    return baseConcurrent;
  };

  // 1. Scale Rate Limits
  // Concurrent requests multipliers: Level 1 (0.4), Level 2 (0.7), Level 3 (1.0), Level 4 (1.5), Level 5 (2.0)
  // We use floor for levels < 3 to be more conservative and ceil for levels > 3 to be more aggressive.
  // Base-2 providers use a dedicated curve so Level 2 can be distinct from Level 1.
  const baseConcurrent = config.rateLimit.maxConcurrent;
  result.rateLimit.maxConcurrent = scaleConcurrentLimit(baseConcurrent, safeLevel);

  // Guardrails: Scale with safety
  if (result.rateLimit.maxConcurrent > 1) {
    result.rateLimit.maxConcurrent = Math.min(result.rateLimit.maxConcurrent, 12);
  } else if (safeLevel >= 4) {
    result.rateLimit.maxConcurrent = 2;
  }
  
  // Scale Batching Delays if present
  if (result.batching.delayBetweenRequests) {
    result.batching.delayBetweenRequests = Math.round(config.batching.delayBetweenRequests * delayMultipliers[safeLevel]);
  }

  // 2. Scale Batching (Speed vs Cost)
  const isAIStrategy = config.batching.strategy === 'smart' || config.batching.strategy === 'json';

  if (isAIStrategy) {
    // AI Strategy: 
    // Level 1 (Economy): Large batches (multiplier 2.0x-2.5x) -> Minimizes Context/System Prompt overhead (Cost Efficient)
    // Level 5 (Turbo): Small batches (multiplier 0.3x-0.5x) -> Faster streaming/UI updates (Speed Efficient)
    const multiplier = aiSizeMultipliers[safeLevel];

    result.batching.optimalSize = Math.max(5, Math.round(config.batching.optimalSize * multiplier));
    result.batching.maxComplexity = Math.max(100, Math.round(config.batching.maxComplexity * multiplier));
  } else if (config.batching.strategy === 'character_limit') {
    // Traditional: Level 1 (Economy/Stability) -> Large chunks, Level 5 (Turbo) -> Small chunks
    const multiplier = sizeMultipliers[safeLevel];

    result.batching.characterLimit = Math.max(500, Math.round(config.batching.characterLimit * multiplier));
    
    // GUARDRAIL: Only scale down maxChunksPerBatch for levels > 3 if the base value is high.
    // For traditional providers, we want to maintain at least 25 segments per request 
    // to avoid the 'Double Fragmentation' issue with the Scheduler.
    if (config.batching.maxChunksPerBatch) {
      const chunkMultiplier = safeLevel > 3 ? Math.max(0.8, multiplier) : multiplier;
      const minSafeSegments = 25;
      
      const newMaxChunks = Math.round(config.batching.maxChunksPerBatch * chunkMultiplier);
      result.batching.maxChunksPerBatch = Math.max(minSafeSegments, newMaxChunks);
    }
    
    if (config.batching.optimalSize) {
      result.batching.optimalSize = Math.max(15, Math.round(config.batching.optimalSize * multiplier));
    }
  }

  // 3. Scale Mode Overrides (if present) - Ensures Select Element speed scales with optimization level
  // Scale rateLimit.modeOverrides
  if (config.rateLimit.modeOverrides) {
    result.rateLimit.modeOverrides = {};
    for (const mode in config.rateLimit.modeOverrides) {
      const modeConfig = { ...config.rateLimit.modeOverrides[mode] };
      
      if (modeConfig.maxConcurrent) {
        modeConfig.maxConcurrent = Math.min(scaleConcurrentLimit(modeConfig.maxConcurrent, safeLevel), 12);
      }
      
      result.rateLimit.modeOverrides[mode] = modeConfig;
    }
  }

  // Scale batching.modeOverrides
  if (config.batching.modeOverrides) {
    result.batching.modeOverrides = {};
    for (const mode in config.batching.modeOverrides) {
      const modeConfig = { ...config.batching.modeOverrides[mode] };
      
      if (isAIStrategy) {
        const multiplier = aiSizeMultipliers[safeLevel];
        // Select Element uses logical-parent commits; do not manufacture extra
        // physical requests solely from optimization-level selection.
        if (mode !== 'select_element' && modeConfig.optimalSize) {
          modeConfig.optimalSize = Math.max(5, Math.round(modeConfig.optimalSize * multiplier));
        }
        if (modeConfig.maxComplexity) modeConfig.maxComplexity = Math.max(100, Math.round(modeConfig.maxComplexity * multiplier));
        if (modeConfig.maxBatchSizeChars) modeConfig.maxBatchSizeChars = Math.max(500, Math.round(modeConfig.maxBatchSizeChars * multiplier));
        // Select Element parents commit only after all fragments complete. Keep
        // their established split ceiling stable; scale throughput fields above.
        if (mode !== 'select_element' && modeConfig.characterLimit) {
          modeConfig.characterLimit = Math.max(500, Math.round(modeConfig.characterLimit * multiplier));
        }
      } else if (config.batching.strategy === 'character_limit') {
        const multiplier = sizeMultipliers[safeLevel];
        if (modeConfig.characterLimit) modeConfig.characterLimit = Math.max(500, Math.round(modeConfig.characterLimit * multiplier));
        if (modeConfig.optimalSize) modeConfig.optimalSize = Math.max(15, Math.round(modeConfig.optimalSize * multiplier));
        
        if (modeConfig.maxChunksPerBatch) {
          const chunkMultiplier = safeLevel > 3 ? Math.max(0.8, multiplier) : multiplier;
          modeConfig.maxChunksPerBatch = Math.max(25, Math.round(modeConfig.maxChunksPerBatch * chunkMultiplier));
        }
      }
      
      result.batching.modeOverrides[mode] = modeConfig;
    }
  }

  return result;
}

/**
 * Normalize provider name to match configuration keys while preserving the
 * existing Custom fallback for unknown values.
 * @param {string} providerName - Provider name
 * @returns {string} - Normalized provider name
 */
function normalizeProviderName(providerName) {
  return normalizeKnownProviderName(providerName) || ProviderNames.CUSTOM;
}

/**
 * Get rate limit configuration for a provider
 * @param {string} providerName - Provider name
 * @param {number} level - Optimization level
 * @returns {object} - Rate limit configuration
 */
export function getProviderRateLimit(providerName, level = 3) {
  const config = getProviderConfiguration(providerName, level);
  return config.rateLimit;
}

/**
 * Get batching configuration for a provider
 * @param {string} providerName - Provider name
 * @param {string} translateMode - Translation mode (optional)
 * @param {number} level - Optimization level
 * @returns {object} - Batching configuration
 */
export function getProviderBatching(providerName, translateMode = null, level = 3) {
  const config = getProviderConfiguration(providerName, level);

  const batching = !translateMode || !config.batching.modeOverrides || !config.batching.modeOverrides[translateMode]
    ? config.batching
    : {
      ...config.batching,
      ...config.batching.modeOverrides[translateMode]
    };

  return applyBatchingHardLimits(batching);
}

function applyBatchingHardLimits(batching) {
  const { maxChunksPerBatch, maxSegmentsPerRequest } = batching;
  const hasValidValue = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

  if (!hasValidValue(maxChunksPerBatch) || !hasValidValue(maxSegmentsPerRequest)) {
    return batching;
  }

  return {
    ...batching,
    maxChunksPerBatch: Math.min(maxChunksPerBatch, maxSegmentsPerRequest)
  };
}

/**
 * Get streaming configuration for a provider
 * @param {string} providerName - Provider name
 * @param {number} level - Optimization level
 * @returns {object} - Streaming configuration
 */
export function getProviderStreaming(providerName, level = 3) {
  const config = getProviderConfiguration(providerName, level);
  return config.streaming;
}

/**
 * Check if provider supports streaming
 * @param {string} providerName - Provider name
 * @returns {boolean} - Whether provider supports streaming
 */
export function isStreamingSupported(providerName) {
  const config = getProviderConfiguration(providerName);
  return config.streaming.enabled;
}

/**
 * Check if provider supports batch requests
 * @param {string} providerName - Provider name
 * @returns {boolean} - Whether provider supports batch requests
 */
export function isBatchSupported(providerName) {
  const config = getProviderConfiguration(providerName);
  return config.features.supportsBatchRequests;
}

/**
 * Update provider configuration dynamically
 * @param {string} providerName - Provider name
 * @param {object} updates - Configuration updates
 */
export function updateProviderConfiguration(providerName, updates) {
  const normalizedName = normalizeProviderName(providerName);
  
  if (!PROVIDER_CONFIGURATIONS[normalizedName]) {
    logger.warn(`[ProviderConfigurations] Cannot update unknown provider: ${providerName}`);
    return;
  }
  
  // Deep merge the updates
  PROVIDER_CONFIGURATIONS[normalizedName] = deepMerge(
    PROVIDER_CONFIGURATIONS[normalizedName],
    updates
  );
  
  logger.debug(`[ProviderConfigurations] Updated configuration for ${normalizedName}:`, updates);
}

/**
 * Deep merge two objects
 * @param {object} target - Target object
 * @param {object} source - Source object
 * @returns {object} - Merged object
 */
function deepMerge(target, source) {
  const result = { ...target };
  
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  
  return result;
}

/**
 * Get all supported provider names
 * @returns {string[]} - Array of provider names
 */
export function getSupportedProviders() {
  return Object.keys(PROVIDER_CONFIGURATIONS);
}

/**
 * Export configurations for debugging/monitoring
 * @returns {object} - All provider configurations
 */
export function getAllConfigurations() {
  return { ...PROVIDER_CONFIGURATIONS };
}

logger.debug('[ProviderConfigurations] Initialized with providers:', Object.keys(PROVIDER_CONFIGURATIONS));
