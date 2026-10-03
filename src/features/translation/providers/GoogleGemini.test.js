import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiProvider } from './GoogleGemini.js';
import { proxyManager } from '@/shared/proxy/ProxyManager.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { TranslationCallPurpose } from './ProviderConstants.js';
import { AIConversationHelper } from './utils/AIConversationHelper.js';
import { createTranslationOperation } from '../ir/TranslationOperation.js';
import { CompletionTermination } from '../ir/CompletionContract.js';
import { ResponseFormat } from '@/shared/config/translationConstants.js';
import { CONFIG, TranslationMode } from '@/shared/config/config.js';

// Mock Dependencies
vi.mock('@/shared/proxy/ProxyManager.js', () => ({
  proxyManager: {
    fetch: vi.fn(),
    setConfig: vi.fn(),
    testConnection: vi.fn()
  }
}));

vi.mock('@/shared/config/config.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getGeminiApiKeysAsync: vi.fn().mockResolvedValue(['test-key']),
    getGeminiModelAsync: vi.fn().mockResolvedValue('gemini-3.8-flash'),
    getGeminiThinkingModeAsync: vi.fn().mockResolvedValue('default'),
    getGeminiApiUrlAsync: vi.fn().mockResolvedValue('https://generativelanguage.googleapis.com/v1beta/models'),
    getPromptAsync: vi.fn().mockResolvedValue('Translate $_{TEXT} from $_{SOURCE} to $_{TARGET}'),
  };
});

vi.mock('@/shared/proxy/ProxySettings.js', () => ({
  getProxySettingsAsync: vi.fn().mockResolvedValue({}),
  resolveProxyConfig: vi.fn().mockResolvedValue({})
}));

describe('GeminiProvider Error Handling', () => {
  let provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GeminiProvider();
  });

  it('should handle successful translation', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: 'سلام دنیا' }] } }]
      }),
      clone: function() { return this; }
    });

    const result = await provider._callAI('system', 'Hello World');
    expect(result).toBe('سلام دنیا');
  });

  it('sends source text from real prompt preparation to the Gemini contents payload', async () => {
    const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');
    const { systemPrompt, userText } = await AIConversationHelper.preparePromptAndText(
      'Who are you?', 'en', 'fa', TranslationMode.Popup_Translate, 'ai'
    );

    await provider._callAI(systemPrompt, userText);

    const payload = JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body);
    expect(payload.contents).toEqual([{ parts: [{ text: 'Who are you?' }] }]);
    expect(payload.contents[0].parts[0].text).not.toBe('');
    expect(payload.systemInstruction.parts[0].text).not.toContain('Who are you?');
  });

  it('sends a customized Popup base as non-empty Gemini user content without duplicating source', async () => {
    const config = await import('@/shared/config/config.js');
    const customBase = vi.spyOn(config, 'getPromptPopupTranslateAsync')
      .mockResolvedValue('<source>$_{TEXT}</source> keep this wrapper');
    const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');
    const source = 'literal $& source';
    const { systemPrompt, userText } = await AIConversationHelper.preparePromptAndText(
      source, 'en', 'fa', TranslationMode.Popup_Translate, 'ai'
    );

    await provider._callAI(systemPrompt, userText);

    const payload = JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body);
    expect(payload.contents).toEqual([{ parts: [{ text: 'Translate the source text according to the system instructions.' }] }]);
    expect(payload.contents[0].parts[0].text).not.toBe('');
    expect(payload.systemInstruction.parts[0].text).toContain(`<source>${source}</source> keep this wrapper`);
    expect(payload.systemInstruction.parts[0].text).toContain(source);
    expect((payload.systemInstruction.parts[0].text.match(/literal \$& source/g) || []).length).toBe(1);
    customBase.mockRestore();
  });

  it('keeps customized Popup wrapping through the provider array prompt-preparation boundary', async () => {
    const config = await import('@/shared/config/config.js');
    const customBase = vi.spyOn(config, 'getPromptPopupTranslateAsync')
      .mockResolvedValue('<source>$_{TEXT}</source> provider boundary');
    const { systemPrompt, userText } = await provider._preparePromptAndText(
      ['literal $& source'], 'en', 'fa', TranslationMode.Popup_Translate, null
    );

    expect(systemPrompt).toBe('<source>literal $& source</source> provider boundary');
    expect(userText).toBe('Translate the source text according to the system instructions.');
    customBase.mockRestore();
  });

  it.each([ResponseFormat.JSON_OBJECT, ResponseFormat.JSON_ARRAY])('uses REST JSON MIME field for %s', async (expectedFormat) => {
    const { getGeminiModelAsync } = await import('@/shared/config/config.js');
    getGeminiModelAsync.mockResolvedValue('gemini-3.5-flash-lite');
    const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

    await provider._callAI('system prompt', 'source text', { expectedFormat });

    const request = executeRequest.mock.calls[0][0];
    const payload = JSON.parse(request.fetchOptions.body);
    expect(request.url).toContain('/models/gemini-3.5-flash-lite:generateContent?key=');
    expect(payload.generationConfig).toMatchObject({
      maxOutputTokens: 8192,
      responseMimeType: 'application/json'
    });
    expect(payload.generationConfig).not.toHaveProperty('temperature');
    expect(payload.generationConfig).not.toHaveProperty('response_mime_type');
    expect(payload.generationConfig).not.toHaveProperty('thinking_config');
    expect(payload.systemInstruction).toEqual({ parts: [{ text: 'system prompt' }] });
    expect(payload.contents).toEqual([{ parts: [{ text: 'source text' }] }]);
  });

  it.each([
    ['gemini-3.8-flash', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent'],
    ['gemini-3.5-flash-lite', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent']
  ])('resolves %s to its configured endpoint', async (model, endpoint) => {
    const { getGeminiModelAsync } = await import('@/shared/config/config.js');
    getGeminiModelAsync.mockResolvedValue(model);
    const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

    await provider._callAI('system prompt', 'source text');

    expect(executeRequest.mock.calls[0][0].url).toBe(`${endpoint}?key=test-key`);
    expect(CONFIG.GEMINI_MODELS.find(configuredModel => configuredModel.value === model).url).toBe(endpoint);
  });

  it.each(['gemini-3.8-flash', 'gemini-3.5-flash-lite'])(
    'omits temperature for curated model %s',
    async (model) => {
      const { getGeminiModelAsync, getGeminiThinkingModeAsync } = await import('@/shared/config/config.js');
      getGeminiModelAsync.mockResolvedValue(model);
      getGeminiThinkingModeAsync.mockResolvedValue('default');
      const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

      await provider._callAI('system prompt', 'source text');

      const payload = JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body);
      expect(payload.generationConfig).not.toHaveProperty('temperature');
      expect(payload.generationConfig).toMatchObject({ maxOutputTokens: 8192 });
    }
  );

  it.each(['custom', 'unknown-model'])(
    'keeps temperature 0.1 for model %s',
    async (model) => {
      const { getGeminiModelAsync, getGeminiThinkingModeAsync } = await import('@/shared/config/config.js');
      getGeminiModelAsync.mockResolvedValue(model);
      getGeminiThinkingModeAsync.mockResolvedValue('default');
      const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

      await provider._callAI('system prompt', 'source text');

      const payload = JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body);
      expect(payload.generationConfig.temperature).toBe(0.1);
    }
  );

  it('omits thinkingConfig in default mode for a verified model', async () => {
    const { getGeminiModelAsync, getGeminiThinkingModeAsync } = await import('@/shared/config/config.js');
    getGeminiModelAsync.mockResolvedValue('gemini-3.5-flash-lite');
    getGeminiThinkingModeAsync.mockResolvedValue('default');
    const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

    await provider._callAI('system prompt', 'source text');

    const payload = JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body);
    expect(payload.generationConfig).not.toHaveProperty('thinkingConfig');
  });

  it.each([
    'gemini-3.5-flash-lite'
  ])('emits minimal thinkingConfig for verified model %s', async (model) => {
    const { getGeminiModelAsync, getGeminiThinkingModeAsync } = await import('@/shared/config/config.js');
    getGeminiModelAsync.mockResolvedValue(model);
    getGeminiThinkingModeAsync.mockResolvedValue('minimal');
    const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

    await provider._callAI('system prompt', 'source text');

    const payload = JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body);
    expect(payload.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
  });

  it.each(['gemini-3.8-flash', 'custom', 'unknown-model'])(
    'omits minimal thinkingConfig for unverified model %s',
    async (model) => {
      const { getGeminiModelAsync, getGeminiThinkingModeAsync } = await import('@/shared/config/config.js');
      getGeminiModelAsync.mockResolvedValue(model);
      getGeminiThinkingModeAsync.mockResolvedValue('minimal');
      const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

      await provider._callAI('system prompt', 'source text');

      const payload = JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body);
      expect(payload.generationConfig).not.toHaveProperty('thinkingConfig');
    }
  );

  it.each([ResponseFormat.JSON_OBJECT, ResponseFormat.JSON_ARRAY])(
    'composes minimal thinking with structured JSON mode for %s',
    async (expectedFormat) => {
      const { getGeminiModelAsync, getGeminiThinkingModeAsync } = await import('@/shared/config/config.js');
      getGeminiModelAsync.mockResolvedValue('gemini-3.5-flash-lite');
      getGeminiThinkingModeAsync.mockResolvedValue('minimal');
      const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

      await provider._callAI('system prompt', 'source text', { expectedFormat });

      const payload = JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body);
      expect(payload.generationConfig).toMatchObject({
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingLevel: 'minimal' }
      });
      expect(payload.generationConfig).not.toHaveProperty('temperature');
    }
  );

  it.each([ResponseFormat.JSON_OBJECT, ResponseFormat.JSON_ARRAY])(
    'composes structured JSON mode without temperature or thinking for gemini-3.8-flash (%s)',
    async (expectedFormat) => {
      const { getGeminiModelAsync, getGeminiThinkingModeAsync } = await import('@/shared/config/config.js');
      getGeminiModelAsync.mockResolvedValue('gemini-3.8-flash');
      getGeminiThinkingModeAsync.mockResolvedValue('minimal');
      const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

      await provider._callAI('system prompt', 'source text', { expectedFormat });

      const payload = JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body);
      expect(payload.generationConfig).toMatchObject({
        maxOutputTokens: 8192,
        responseMimeType: 'application/json'
      });
      expect(payload.generationConfig).not.toHaveProperty('temperature');
      expect(payload.generationConfig).not.toHaveProperty('thinkingConfig');
    }
  );

  it('does not read or write normal history for structured recovery', async () => {
    const { getGeminiThinkingModeAsync } = await import('@/shared/config/config.js');
    getGeminiThinkingModeAsync.mockResolvedValue('default');
    const claim = vi.spyOn(AIConversationHelper, 'claimNextTurn').mockResolvedValue(1);
    const history = vi.spyOn(AIConversationHelper, 'getConversationHistory').mockResolvedValue([]);
    const update = vi.spyOn(AIConversationHelper, 'updateSessionHistory').mockResolvedValue();
    vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');
    await provider._callAI('system', 'current segment', {
      sessionId: 'session-1',
      mode: 'select-element',
      callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
      expectedFormat: ResponseFormat.JSON_ARRAY
    });
    expect(claim).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    const payload = JSON.parse(provider._executeRequest.mock.calls[0][0].fetchOptions.body);
    expect(payload.generationConfig.responseMimeType).toBe('application/json');
    expect(payload.generationConfig).not.toHaveProperty('response_mime_type');
    expect(payload.generationConfig).not.toHaveProperty('thinking_config');
    claim.mockRestore(); history.mockRestore(); update.mockRestore();
  });

  it.each([
    ['default', false],
    ['minimal', true]
  ])('applies %s Thinking mode during structured recovery for verified model', async (thinkingMode, shouldThink) => {
    const { getGeminiModelAsync, getGeminiThinkingModeAsync } = await import('@/shared/config/config.js');
    getGeminiModelAsync.mockResolvedValue('gemini-3.5-flash-lite');
    getGeminiThinkingModeAsync.mockResolvedValue(thinkingMode);
    vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

    await provider._callAI('system', 'current segment', {
      callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
      expectedFormat: ResponseFormat.JSON_ARRAY
    });

    const payload = JSON.parse(provider._executeRequest.mock.calls[0][0].fetchOptions.body);
    expect(payload.generationConfig.responseMimeType).toBe('application/json');
    if (shouldThink) {
      expect(payload.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
    } else {
      expect(payload.generationConfig).not.toHaveProperty('thinkingConfig');
    }
  });

  it('omits Thinking config during structured recovery for unverified model', async () => {
    const { getGeminiModelAsync, getGeminiThinkingModeAsync } = await import('@/shared/config/config.js');
    getGeminiModelAsync.mockResolvedValue('gemini-3.8-flash');
    getGeminiThinkingModeAsync.mockResolvedValue('minimal');
    vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

    await provider._callAI('system', 'current segment', {
      callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
      expectedFormat: ResponseFormat.JSON_ARRAY
    });

    const payload = JSON.parse(provider._executeRequest.mock.calls[0][0].fetchOptions.body);
    expect(payload.generationConfig).not.toHaveProperty('thinkingConfig');
  });

  it('stages a normal primary candidate instead of writing history directly', async () => {
    const candidate = { stage: vi.fn() };
    const update = vi.spyOn(AIConversationHelper, 'updateSessionHistory').mockResolvedValue();
    vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');
    try {
      await provider._callAI('system', 'source', { sessionId: 'session-1', mode: 'select-element', callPurpose: TranslationCallPurpose.PRIMARY_TRANSLATION, conversationParticipates: true, conversationCommitCandidate: candidate });
      expect(candidate.stage).toHaveBeenCalledWith({ sessionId: 'session-1', userContent: 'source', assistantContent: 'translated' });
      expect(update).not.toHaveBeenCalled();
    } finally { update.mockRestore(); }
  });

  it('writes history for eligible Select Element primary calls without a candidate', async () => {
    const update = vi.spyOn(AIConversationHelper, 'updateSessionHistory').mockResolvedValue();
    vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');
    try {
      await provider._callAI('system', 'source', { sessionId: 'session-1', mode: 'select-element', callPurpose: TranslationCallPurpose.PRIMARY_TRANSLATION, conversationParticipates: true });
      expect(update).toHaveBeenCalledWith('session-1', 'source', 'translated', expect.objectContaining({ callPurpose: TranslationCallPurpose.PRIMARY_TRANSLATION, conversationParticipates: true }));
    } finally { update.mockRestore(); }
  });

  it('should detect API_ERROR wrapped in 200 OK response', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve({
        error: { message: 'API Key not valid', status: 'INVALID_ARGUMENT' }
      }),
      clone: function() { return this; }
    });

    await expect(provider._callAI('system', 'text'))
      .rejects.toThrow('API_ERROR: API Key not valid');
  });

  it('should detect SAFETY filter block', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve({
        candidates: [{ finishReason: 'SAFETY' }]
      }),
      clone: function() { return this; }
    });

    await expect(provider._callAI('system', 'text'))
      .rejects.toThrow('API_ERROR: Content blocked by Gemini safety filters');
  });

  it('should handle HTTP 429 Too Many Requests', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve({
        error: { message: 'Quota exceeded' }
      }),
      clone: function() { return this; }
    });

    try {
      await provider._callAI('system', 'text');
    } catch (error) {
      expect(error.type).toBe(ErrorTypes.RATE_LIMIT_REACHED);
      expect(error.statusCode).toBe(429);
    }
  });

});

describe('GeminiProvider Completion Recording (ADR-016 P2)', () => {
  let provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GeminiProvider();
  });

  function mockGeminiResponse(body) {
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(body),
      clone: function() { return this; }
    });
  }

  it('records one normalized completion for a normal STOP response', async () => {
    const operation = createTranslationOperation('p2-normal');
    const executionContext = { operation };

    mockGeminiResponse({
      candidates: [{
        content: { parts: [{ text: 'سلام دنیا' }] },
        finishReason: 'STOP'
      }],
      modelVersion: 'gemini-2.5-flash',
      responseId: 'resp-1',
      usageMetadata: {
        promptTokenCount: 1017,
        candidatesTokenCount: 318,
        thoughtsTokenCount: 7860,
        totalTokenCount: 9195
      }
    });

    const result = await provider._callAI('system', 'Hello World', { executionContext });

    expect(result).toBe('سلام دنیا');
    const completions = operation.snapshotCompletions();
    expect(completions).toHaveLength(1);
    expect(completions[0]).toEqual({
      provider: 'Gemini',
      model: 'gemini-2.5-flash',
      termination: CompletionTermination.NORMAL,
      responseId: 'resp-1',
      usage: {
        inputTokens: 1017,
        outputTokens: 318,
        reasoningTokens: 7860,
        totalTokens: 9195
      }
    });
  });

  it('records TRUNCATED for MAX_TOKENS while leaving translation unchanged', async () => {
    const operation = createTranslationOperation('p2-truncated');
    const executionContext = { operation };

    mockGeminiResponse({
      candidates: [{
        content: { parts: [{ text: 'partial result' }] },
        finishReason: 'MAX_TOKENS'
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
    });

    const result = await provider._callAI('system', 'text', { executionContext });

    expect(result).toBe('partial result');
    const completions = operation.snapshotCompletions();
    expect(completions).toHaveLength(1);
    expect(completions[0].termination).toBe(CompletionTermination.TRUNCATED);
    expect(completions[0].usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: null,
      totalTokens: 15
    });
  });

  it('records POLICY on SAFETY while preserving the existing throw', async () => {
    const operation = createTranslationOperation('p2-safety');
    const executionContext = { operation };

    mockGeminiResponse({
      candidates: [{ finishReason: 'SAFETY' }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 0, totalTokenCount: 4 }
    });

    await expect(provider._callAI('system', 'text', { executionContext }))
      .rejects.toThrow('API_ERROR: Content blocked by Gemini safety filters');

    const completions = operation.snapshotCompletions();
    expect(completions).toHaveLength(1);
    expect(completions[0].termination).toBe(CompletionTermination.POLICY);
  });

  it('records UNKNOWN for an unrecognized finishReason without leaking the raw value', async () => {
    const operation = createTranslationOperation('p2-unknown');
    const executionContext = { operation };

    mockGeminiResponse({
      candidates: [{
        content: { parts: [{ text: 'result text' }] },
        finishReason: 'BLOCKLIST'
      }]
    });

    const result = await provider._callAI('system', 'text', { executionContext });

    expect(result).toBe('result text');
    const completions = operation.snapshotCompletions();
    expect(completions).toHaveLength(1);
    expect(completions[0].termination).toBe(CompletionTermination.UNKNOWN);
    expect(completions[0]).not.toHaveProperty('BLOCKLIST');
  });

  it('records a valid completion with null usage when usageMetadata is absent', async () => {
    const operation = createTranslationOperation('p2-no-usage');
    const executionContext = { operation };

    mockGeminiResponse({
      candidates: [{
        content: { parts: [{ text: 'ok' }] },
        finishReason: 'STOP'
      }]
    });

    const result = await provider._callAI('system', 'text', { executionContext });

    expect(result).toBe('ok');
    const completions = operation.snapshotCompletions();
    expect(completions).toHaveLength(1);
    expect(completions[0].usage).toBeNull();
    expect(completions[0].termination).toBe(CompletionTermination.NORMAL);
  });

  it('records null model and responseId when response metadata is absent', async () => {
    const operation = createTranslationOperation('p2-no-model');
    const executionContext = { operation };

    mockGeminiResponse({
      candidates: [{
        content: { parts: [{ text: 'ok' }] },
        finishReason: 'STOP'
      }]
    });

    await provider._callAI('system', 'text', { executionContext });

    const completions = operation.snapshotCompletions();
    expect(completions).toHaveLength(1);
    expect(completions[0].model).toBeNull();
    expect(completions[0].responseId).toBeNull();
  });

  it('records ordered completions for two physical Gemini responses in one operation', async () => {
    const operation = createTranslationOperation('p2-multi');
    const executionContext = { operation };

    proxyManager.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'first' }] }, finishReason: 'MAX_TOKENS' }]
        }),
        clone: function() { return this; }
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'second' }] }, finishReason: 'STOP' }]
        }),
        clone: function() { return this; }
      });

    const first = await provider._callAI('system', 'a', { executionContext });
    const second = await provider._callAI('system', 'b', { executionContext });

    expect(first).toBe('first');
    expect(second).toBe('second');
    expect(operation.snapshotCompletions().map((c) => c.termination)).toEqual([
      CompletionTermination.TRUNCATED,
      CompletionTermination.NORMAL
    ]);
  });

  it('keeps raw Gemini fields out of the normalized completion record', async () => {
    const operation = createTranslationOperation('p2-privacy');
    const executionContext = { operation };

    mockGeminiResponse({
      candidates: [{
        content: { parts: [{ text: 'سلام دنیا' }] },
        finishReason: 'STOP'
      }],
      modelVersion: 'gemini-2.5-flash',
      responseId: 'resp-1',
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
      apiKey: 'super-secret-key'
    });

    await provider._callAI('system', 'text', { executionContext });

    const [record] = operation.snapshotCompletions();
    for (const forbidden of ['candidates', 'content', 'parts', 'text', 'prompt', 'body', 'usageMetadata', 'finishReason', 'modelVersion', 'apiKey', 'sourceText', 'translatedText']) {
      expect(record).not.toHaveProperty(forbidden);
    }
    expect(Object.keys(record).sort()).toEqual(['model', 'provider', 'responseId', 'termination', 'usage']);
    expect(Object.keys(record.usage).sort()).toEqual(['inputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens']);
  });

  it('records nothing when no candidate exists in the response body', async () => {
    const operation = createTranslationOperation('p2-no-candidate');
    const executionContext = { operation };

    mockGeminiResponse({ error: { message: 'Some API error' } });

    await expect(provider._callAI('system', 'text', { executionContext }))
      .rejects.toThrow('API_ERROR: Some API error');

    expect(operation.snapshotCompletions()).toEqual([]);
  });

  it('records nothing for an empty candidates array and keeps the invalid-response throw', async () => {
    const operation = createTranslationOperation('p2-empty-candidates');
    const executionContext = { operation };

    mockGeminiResponse({ candidates: [] });

    await expect(provider._callAI('system', 'text', { executionContext }))
      .rejects.toMatchObject({ type: ErrorTypes.API_RESPONSE_INVALID });

    expect(operation.snapshotCompletions()).toEqual([]);
  });

  it('records nothing when candidates is missing entirely and keeps the invalid-response throw', async () => {
    const operation = createTranslationOperation('p2-missing-candidates');
    const executionContext = { operation };

    mockGeminiResponse({ usageMetadata: { promptTokenCount: 7 } });

    await expect(provider._callAI('system', 'text', { executionContext }))
      .rejects.toMatchObject({ type: ErrorTypes.API_RESPONSE_INVALID });

    expect(operation.snapshotCompletions()).toEqual([]);
  });

  it('is null-safe when no executionContext is supplied', async () => {
    mockGeminiResponse({
      candidates: [{
        content: { parts: [{ text: 'سلام دنیا' }] },
        finishReason: 'STOP'
      }],
      modelVersion: 'gemini-2.5-flash'
    });

    const result = await provider._callAI('system', 'Hello World');
    expect(result).toBe('سلام دنیا');
  });
});
