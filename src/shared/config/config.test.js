import { describe, it, expect, vi, beforeEach } from 'vitest';
import { 
  CONFIG, 
  getApiKeyAsync,
  getDebugModeAsync,
  TranslationMode,
  IsDebug,
  getPromptBASESelectAsync,
  getPromptBASEBatchAsync,
  getPromptBASEAIBatchAsync,
  getPromptBASEAIBatchAutoAsync,
  getPromptBASEAIFollowupAsync,
  getPromptBASEAIFollowupAutoAsync,
  getPromptSubtitleBaseAsync,
  getPromptSubtitleBatchAsync,
  getPromptBASEScreenCaptureAsync,
  getPromptAsync,
  getPromptBASEFieldAsync,
  getGeminiThinkingModeAsync,
  getDeepSeekThinkingModeAsync,
  getEffectiveProviderAsync,
  getOpenAIModelSourceAsync,
  getOpenRouterModelSourceAsync,
  getDeepSeekModelSourceAsync
} from './config.js';
import { storageManager } from '../storage/core/StorageCore.js';

// Mock StorageCore
vi.mock('../storage/core/StorageCore.js', () => ({
  storageManager: {
    get: vi.fn(),
    on: vi.fn(),
    hasCached: vi.fn(),
    getCached: vi.fn()
  }
}));

// Mock ExtensionContextManager
vi.mock('@/core/extensionContext.js', () => ({
  default: {
    isContextError: vi.fn().mockReturnValue(false),
    handleContextError: vi.fn()
  }
}));

// Mock logger
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn()
  })
}));

vi.mock('@/features/translation/providers/ApiKeyManager.js', () => ({
  ApiKeyManager: {
    getKeys: vi.fn().mockResolvedValue(['key1', 'key2'])
  }
}));

describe('Config Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Constants', () => {
    it('keeps batch prompts free of redundant source-text references', async () => {
      const normalBatch = await getPromptBASEAIBatchAsync();
      const autoBatch = await getPromptBASEAIBatchAutoAsync();
      const normalFollowup = await getPromptBASEAIFollowupAsync();
      const autoFollowup = await getPromptBASEAIFollowupAutoAsync();

      for (const prompt of [normalBatch, autoBatch, normalFollowup, autoFollowup]) {
        expect(prompt).not.toContain('the following JSON data');
      }
      expect(normalBatch).toContain('from $_{SOURCE} to $_{TARGET}');
      expect(normalFollowup).toContain('from $_{SOURCE} to $_{TARGET}');
      expect(autoBatch).toContain('into $_{TARGET}');
      expect(autoFollowup).toContain('into $_{TARGET}');
    });

    it('preserves editable prompt semantics and structured batch output requirements', async () => {
      expect(CONFIG.PROMPT_TEMPLATE).toContain('$_{SOURCE}');
      expect(CONFIG.PROMPT_TEMPLATE).toContain('$_{TARGET}');
      expect(CONFIG.PROMPT_TEMPLATE).toContain('$_{TEXT}');
      expect(CONFIG.PROMPT_TEMPLATE).toContain('(or any other language)');
      expect(CONFIG.PROMPT_TEMPLATE).toContain('Accurately');
      expect(CONFIG.PROMPT_TEMPLATE).toContain('fluently, naturally, and idiomatically');
      expect(CONFIG.PROMPT_TEMPLATE).toContain('tone, clarity, and readability');
      expect(CONFIG.PROMPT_TEMPLATE_AUTO).toContain('$_{SOURCE}');
      expect(CONFIG.PROMPT_TEMPLATE_AUTO).toContain('$_{TARGET}');
      expect(CONFIG.PROMPT_TEMPLATE_AUTO).toContain('$_{TEXT}');
      expect(CONFIG.PROMPT_TEMPLATE_AUTO).toContain('Accurately');
      expect(CONFIG.PROMPT_TEMPLATE_AUTO).toContain('fluently, naturally, and idiomatically');
      expect(CONFIG.PROMPT_TEMPLATE_AUTO).toContain('entire context suggests a reverse translation');

      for (const prompt of [
        await getPromptBASEAIBatchAsync(),
        await getPromptBASEAIBatchAutoAsync()
      ]) {
        expect(prompt).toContain('valid JSON object');
        expect(prompt).toContain('translations');
        expect(prompt).toContain('exactly $_{COUNT} items');
        expect(prompt).toContain('"id"');
        expect(prompt).toContain('"text"');
        expect(prompt).toContain('line breaks');
        expect(prompt).toContain('formatting');
        expect(prompt).toContain('$_{MARKER_PRESERVATION_INSTRUCTIONS}');
        expect(prompt).toContain('Return only');
      }
    });

    it('keeps batch instructions separate, formatting unconditional, and marker guidance conditional', async () => {
      const prompts = [
        await getPromptBASEAIBatchAsync(),
        await getPromptBASEAIBatchAutoAsync(),
        await getPromptBASEAIFollowupAsync(),
        await getPromptBASEAIFollowupAutoAsync()
      ];

      for (const prompt of prompts) {
        expect(prompt).toContain('\n$_{PROMPT_INSTRUCTIONS}\n');
        expect(prompt).toContain('Preserve all formatting, indentation, and line breaks exactly.');
        expect(prompt).toContain('Preserve every original id exactly.');
        expect(prompt).toContain('$_{MARKER_PRESERVATION_INSTRUCTIONS}');
        expect(prompt).not.toContain('@@TI_SEG_');
      }
    });

    it('should have correct TranslationMode values', () => {
      expect(TranslationMode.Select_Element).toBe('select-element');
      expect(TranslationMode.Page).toBe('page-translation-batch');
      expect(TranslationMode.PDF).toBe('pdf-translation');
    });

    it('should have basic app info in CONFIG', () => {
      expect(CONFIG.APP_NAME).toBe('Translate It');
    });

    it('should point to the current changelog', () => {
      expect(CONFIG.CHANGELOG_URL).toBe(
        'https://raw.githubusercontent.com/Translate-It-App/Translate-It/main/docs/Changelog.md'
      );
    });

    it('should default Live Dubbing to Gemini', () => {
      expect(CONFIG.LIVE_DUBBING_PROVIDER).toBe('gemini');
    });

    it('uses the approved canonical provider and AI model defaults', () => {
      expect(CONFIG.TRANSLATION_API).toBe('edge');
      expect(CONFIG.GEMINI_MODEL).toBe('gemini-3.5-flash-lite');
      expect(CONFIG.OPENAI_API_MODEL).toBe('gpt-6-luna');
      expect(CONFIG.OPENROUTER_API_MODEL).toBe('google/gemini-3.5-flash-lite');
      expect(CONFIG.REQUESTY_API_MODEL).toBe('gemini-3.5-flash-lite');
      expect(CONFIG.DEEPSEEK_API_MODEL).toBe('deepseek-flash');
      expect(CONFIG.WEBAI_API_MODEL).toBe('gemini-auto');
      expect(CONFIG.CUSTOM_API_MODEL).toBe('');
    });

    it('uses CONFIG for missing generic providers but retains the bulk-capability fallback', async () => {
      storageManager.get.mockImplementation(async (defaults) => {
        if (Object.hasOwn(defaults, 'MODE_PROVIDERS')) return { MODE_PROVIDERS: {} };
        return {};
      });
      await expect(getEffectiveProviderAsync(TranslationMode.Selection)).resolves.toBe(CONFIG.TRANSLATION_API);

      storageManager.get.mockImplementation(async (defaults) => ({
        [Object.keys(defaults)[0]]: Object.hasOwn(defaults, 'MODE_PROVIDERS')
          ? {}
          : 'vajehyab'
      }));
      await expect(getEffectiveProviderAsync(TranslationMode.Page)).resolves.toBe('googlev2');
    });

    it('uses CONFIG when effective-provider lookup fails', async () => {
      storageManager.get.mockRejectedValue(new Error('storage unavailable'));
      await expect(getEffectiveProviderAsync(TranslationMode.Selection)).resolves.toBe(CONFIG.TRANSLATION_API);
    });

    it('should default provider-specific Original transcript preferences to disabled', () => {
      expect(CONFIG.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_GEMINI).toBe(false);
      expect(CONFIG.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_OPENAI).toBe(false);
    });

    it('should expose the current Microsoft Edge translation endpoint without auth config', () => {
      expect(CONFIG.MICROSOFT_EDGE_TRANSLATE_URL).toBe(
        'https://edge.microsoft.com/translate/translatetext'
      );
      expect(CONFIG).not.toHaveProperty('MICROSOFT_EDGE_AUTH_URL');
    });

    it('should expose approved WebAI models in order', () => {
      expect(CONFIG.WEBAI_API_MODEL).toBe('gemini-auto');
      expect(CONFIG.WEBAI_API_URL).toBe('');
      expect(CONFIG.WEBAI_MODELS).toEqual([
        { value: 'gemini-auto', name: 'Gemini Auto' },
        { value: 'gemini-3-flash', name: 'Gemini 3 Flash' },
        { value: 'gemini-3-pro', name: 'Gemini 3 Pro' },
        { value: 'custom', name: 'Custom Model', custom: true }
      ]);
    });

    it('should expose approved OpenAI text models in order', () => {
      expect(CONFIG.OPENAI_API_URL).toBe('https://api.openai.com/v1/chat/completions');
      expect(CONFIG.OPENAI_API_MODEL).toBe('gpt-6-luna');
      expect(CONFIG.OPENAI_MODEL_SOURCE).toBe('legacy');
      expect(CONFIG.OPENAI_MODELS.map(model => model.value)).toEqual([
        'gpt-6-luna',
        'gpt-6-sol',
        'custom'
      ]);
      expect(CONFIG.OPENAI_MODELS).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: 'o1' }),
          expect.objectContaining({ value: 'o1-mini' }),
          expect.objectContaining({ value: 'o3-mini' }),
          expect.objectContaining({ value: 'gpt-4.5-preview' }),
          expect.objectContaining({ value: 'gpt-4o' }),
          expect.objectContaining({ value: 'gpt-4o-mini' }),
          expect.objectContaining({ value: 'chatgpt-4o-latest' })
        ])
      );
    });

    it('should expose approved DeepSeek text models in order', () => {
      expect(CONFIG.DEEPSEEK_API_MODEL).toBe('deepseek-flash');
      expect(CONFIG.DEEPSEEK_MODEL_SOURCE).toBe('legacy');
      expect(CONFIG.DEEPSEEK_API_URL).toBe('https://api.deepseek.com/chat/completions');
      expect(CONFIG.DEEPSEEK_THINKING_MODE).toBe('disabled');
      expect(CONFIG.DEEPSEEK_THINKING_MODE_OPTIONS.map(option => option.value)).toEqual([
        'disabled',
        'low',
        'high',
        'max'
      ]);
      expect(CONFIG.DEEPSEEK_MODELS).toEqual([
        {
          value: 'deepseek-flash',
          name: 'DeepSeek Flash',
          supportsThinking: true
        },
        {
          value: 'deepseek-v4-pro',
          name: 'DeepSeek V4 Pro',
          supportsThinking: true
        },
        {
          value: 'custom',
          name: 'Custom Model',
          supportsThinking: false
        }
      ]);
      expect(CONFIG.DEEPSEEK_MODELS).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: 'deepseek-chat' }),
          expect.objectContaining({ value: 'deepseek-reasoner' })
        ])
      );
    });

    it('should expose the curated OpenRouter models in order', () => {
      expect(CONFIG.OPENROUTER_API_MODEL).toBe('google/gemini-3.5-flash-lite');
      expect(CONFIG.OPENROUTER_MODEL_SOURCE).toBe('legacy');
      expect(CONFIG.OPENROUTER_API_URL).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(CONFIG.OPENROUTER_MODELS).toEqual([
        { value: 'openai/gpt-6-luna', name: 'OpenAI GPT-6 Luna' },
        { value: 'google/gemini-3.5-flash-lite', name: 'Google Gemini 3.5 Flash-Lite' },
        { value: 'mistralai/mistral-small-2603', name: 'Mistral Small 4' },
        { value: 'google/gemini-3.8-flash', name: 'Google Gemini 3.8 Flash' },
        { value: 'anthropic/claude-haiku-4.5', name: 'Anthropic Claude Haiku 4.5' },
        { value: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
        { value: 'qwen/qwen3.8-flash', name: 'Qwen 3.8 Flash' },
        { value: 'meta-llama/llama-3.3-70b-instruct', name: 'Meta Llama 3.3 70B' },
        { value: 'anthropic/claude-sonnet-5', name: 'Anthropic Claude Sonnet 5' },
        { value: 'google/gemma-4-26b-a4b-it:free', name: 'Google Gemma 4 26B A4B (Free)' },
        { value: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'NVIDIA Nemotron 3 Super (Free)' },
        { value: 'custom', name: 'Custom Model' }
      ]);
      const curatedModels = CONFIG.OPENROUTER_MODELS.filter(model => model.value !== 'custom');
      const freeModels = curatedModels.filter(model => model.value.endsWith(':free'));

      expect(curatedModels).toHaveLength(11);
      expect(freeModels).toHaveLength(2);
      expect(freeModels.every(model => model.name.includes('(Free)'))).toBe(true);
      expect(CONFIG.OPENROUTER_MODELS.at(-1)).toEqual({ value: 'custom', name: 'Custom Model' });
    });

    it('should expose the curated Requesty models in order', () => {
      expect(CONFIG.REQUESTY_API_MODEL).toBe('gemini-3.5-flash-lite');
      expect(CONFIG.REQUESTY_API_URL).toBe('https://router.requesty.ai/v1/chat/completions');
      expect(CONFIG.REQUESTY_MODELS).toEqual([
        { value: 'openai/gpt-4o-mini', name: 'OpenAI GPT-4o Mini' },
        { value: 'gpt-5.4-mini', name: 'OpenAI GPT-5.4 Mini' },
        { value: 'gemini-3.5-flash-lite', name: 'Google Gemini 3.5 Flash-Lite' },
        { value: 'gemini-3.5-flash', name: 'Google Gemini 3.5 Flash' },
        { value: 'claude-haiku-4-5', name: 'Anthropic Claude Haiku 4.5' },
        { value: 'claude-sonnet-4-6', name: 'Anthropic Claude Sonnet 4.6' },
        { value: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { value: 'mistral-small-2603', name: 'Mistral Small' },
        { value: 'qwen3.8-flash', name: 'Qwen 3.8 Flash' },
        { value: 'custom', name: 'Custom Model' }
      ]);
    });

    it('should expose approved Gemini selector models in order', () => {
      expect(CONFIG.GEMINI_MODEL).toBe('gemini-3.5-flash-lite');
      expect(CONFIG.GEMINI_MODEL_SOURCE).toBe('legacy');
      expect(CONFIG.GEMINI_API_URL).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent'
      );
      expect(CONFIG.GEMINI_MODELS.map(model => model.value)).toEqual([
        'gemini-3.8-flash',
        'gemini-3.5-flash-lite',
        'custom'
      ]);
      expect(CONFIG.GEMINI_MODELS.every(model => !model.value.startsWith('gemini-2.5-'))).toBe(true);
      expect(CONFIG.GEMINI_MODELS.find(model => model.value === CONFIG.GEMINI_MODEL)?.url).toBe(CONFIG.GEMINI_API_URL);
    });

    it('should retain exact Gemini model endpoints and Thinking metadata', () => {
      expect(CONFIG.GEMINI_MODELS).toEqual([
        expect.objectContaining({
          value: 'gemini-3.8-flash',
          name: 'Gemini 3.8 Flash',
          url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
          thinking: { minimal: null }
        }),
        expect.objectContaining({
          value: 'gemini-3.5-flash-lite',
          name: 'Gemini 3.5 Flash-Lite',
          url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
          thinking: { minimal: { type: 'level', value: 'minimal' } }
        }),
        { value: 'custom', name: 'Custom Model', custom: true }
      ]);
    });

    it.each(['PROMPT_BASE_AI_BATCH', 'PROMPT_BASE_AI_BATCH_AUTO', 'PROMPT_BASE_AI_FOLLOWUP', 'PROMPT_BASE_AI_FOLLOWUP_AUTO'])(
      '%s reserves runtime marker protocol instructions',
      (key) => {
        expect(CONFIG[key]).toContain('$_{MARKER_PRESERVATION_INSTRUCTIONS}');
        expect(CONFIG[key]).not.toContain('[--SEG:nN--]');
      }
    );

    it.each(['PROMPT_BASE_AI_FOLLOWUP', 'PROMPT_BASE_AI_FOLLOWUP_AUTO'])(
      '%s keeps newline transport markers unconditionally',
      (key) => {
        expect(CONFIG[key]).toContain('<n1/>');
        expect(CONFIG[key]).toContain('<n2/>');
        expect(CONFIG[key]).toContain('as literal newline markers; preserve them exactly in their original positions.');
        expect(CONFIG[key]).toContain('$_{MARKER_PRESERVATION_INSTRUCTIONS}');
      }
    );
  });

  describe('Async Getters', () => {
    it.each([
      ['OPENAI_MODEL_SOURCE', getOpenAIModelSourceAsync],
      ['OPENROUTER_MODEL_SOURCE', getOpenRouterModelSourceAsync],
      ['DEEPSEEK_MODEL_SOURCE', getDeepSeekModelSourceAsync],
    ])('%s reads the stored source and uses its CONFIG default', async (key, getter) => {
      storageManager.get.mockResolvedValue({ [key]: 'catalog' });
      await expect(getter()).resolves.toBe('catalog');
      expect(storageManager.get).toHaveBeenCalledWith({ [key]: CONFIG[key] });
    });

    it('getDeepSeekThinkingModeAsync reads stored mode and uses CONFIG default', async () => {
      storageManager.get.mockResolvedValue({ DEEPSEEK_THINKING_MODE: 'high' });
      await expect(getDeepSeekThinkingModeAsync()).resolves.toBe('high');
      expect(storageManager.get).toHaveBeenCalledWith({
        DEEPSEEK_THINKING_MODE: CONFIG.DEEPSEEK_THINKING_MODE
      });
    });

    it('getGeminiThinkingModeAsync reads stored mode and uses CONFIG default', async () => {
      storageManager.get.mockResolvedValue({ GEMINI_THINKING_MODE: 'minimal' });
      await expect(getGeminiThinkingModeAsync()).resolves.toBe('minimal');
      expect(storageManager.get).toHaveBeenCalledWith({ GEMINI_THINKING_MODE: CONFIG.GEMINI_THINKING_MODE });

      storageManager.get.mockResolvedValue({ GEMINI_THINKING_MODE: CONFIG.GEMINI_THINKING_MODE });
      await expect(getGeminiThinkingModeAsync()).resolves.toBe('default');
    });

    it('should not expose the removed Gemini thinking toggle', () => {
      expect(CONFIG).not.toHaveProperty('GEMINI_THINKING_ENABLED');
      expect(CONFIG.GEMINI_THINKING_MODE).toBe('default');
    });

    it('should not expose the removed DeepL beta language toggle', () => {
      expect(CONFIG).not.toHaveProperty('DEEPL_BETA_LANGUAGES_ENABLED');
    });

    it('getApiKeyAsync should return value from storage', async () => {
      storageManager.get.mockResolvedValue({ API_KEY: 'secret-key' });
      const apiKey = await getApiKeyAsync();
      expect(apiKey).toBe('secret-key');
    });

    it('getDebugModeAsync should return default if storage fails', async () => {
      storageManager.get.mockRejectedValue(new Error('Storage fail'));
      const debugMode = await getDebugModeAsync();
      expect(debugMode).toBe(CONFIG.DEBUG_MODE);
    });
  });

  describe('Advanced Logic', () => {
    it('IsDebug should use cache if available', async () => {
      storageManager.hasCached.mockReturnValue(true);
      storageManager.getCached.mockReturnValue(true);
      
      const result = await IsDebug();
      
      expect(storageManager.getCached).toHaveBeenCalledWith('DEBUG_MODE', false);
      expect(result).toBe(true);
    });

    it('getOpenAIApiKeysAsync should retrieve keys via ApiKeyManager', async () => {
      // Note: We need to mock the dynamic import result
      const { getOpenAIApiKeysAsync } = await import('./config.js');
      const keys = await getOpenAIApiKeysAsync();

      expect(keys).toEqual(['key1', 'key2']);
    });
  });

  describe('Prompt Getters', () => {
    const NON_EDITABLE_GETTERS = [
      ['PROMPT_BASE_SELECT', getPromptBASESelectAsync],
      ['PROMPT_BASE_BATCH', getPromptBASEBatchAsync],
      ['PROMPT_BASE_AI_BATCH', getPromptBASEAIBatchAsync],
      ['PROMPT_BASE_AI_BATCH_AUTO', getPromptBASEAIBatchAutoAsync],
      ['PROMPT_BASE_AI_FOLLOWUP', getPromptBASEAIFollowupAsync],
      ['PROMPT_BASE_AI_FOLLOWUP_AUTO', getPromptBASEAIFollowupAutoAsync],
      ['PROMPT_SUBTITLE_BASE', getPromptSubtitleBaseAsync],
      ['PROMPT_SUBTITLE_BATCH', getPromptSubtitleBatchAsync],
      ['PROMPT_BASE_SCREEN_CAPTURE', getPromptBASEScreenCaptureAsync]
    ];

    it.each(NON_EDITABLE_GETTERS)(
      'non-editable getter %s returns CONFIG and ignores stale storage',
      async (key, getter) => {
        storageManager.get.mockResolvedValue({ [key]: 'STALE_STORED_VALUE' });

        const result = await getter();

        expect(result).toBe(CONFIG[key]);
        expect(storageManager.get).not.toHaveBeenCalled();
      }
    );

    it('editable getter honors custom stored value', async () => {
      const customPrompt = 'My custom template $_{SOURCE} $_{TARGET} $_{TEXT}';
      storageManager.get.mockResolvedValue({ PROMPT_TEMPLATE: customPrompt });

      const result = await getPromptAsync();

      expect(result).toBe(customPrompt);
      expect(storageManager.get).toHaveBeenCalledWith(
        { PROMPT_TEMPLATE: CONFIG.PROMPT_TEMPLATE }
      );
    });

    it('editable base field getter honors custom stored value', async () => {
      const customPrompt = 'My custom base $_{PROMPT_INSTRUCTIONS} $_{TEXT}';
      storageManager.get.mockResolvedValue({ PROMPT_BASE_FIELD: customPrompt });

      const result = await getPromptBASEFieldAsync();

      expect(result).toBe(customPrompt);
    });
  });
});
