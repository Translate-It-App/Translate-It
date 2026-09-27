import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeepSeekProvider } from './DeepSeek.js';
import { proxyManager } from '@/shared/proxy/ProxyManager.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { TranslationCallPurpose } from './ProviderConstants.js';
import { AIConversationHelper } from './utils/AIConversationHelper.js';
import { CompletionTermination } from '@/features/translation/ir/CompletionContract.js';
import { createTranslationOperation } from '@/features/translation/ir/TranslationOperation.js';
import { CONFIG, getDeepSeekApiModelAsync, getDeepSeekThinkingModeAsync } from '@/shared/config/config.js';
import { ResponseFormat } from '@/shared/config/translationConstants.js';

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
    CONFIG: {
      ...actual.CONFIG,
      DEEPSEEK_MODELS: [
        { value: 'deepseek-flash', name: 'DeepSeek Flash', supportsThinking: true },
        { value: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', supportsThinking: true },
        { value: 'deepseek-chat', name: 'DeepSeek Chat', supportsThinking: false },
        { value: 'custom', name: 'Custom Model' },
      ],
    },
    getDeepSeekApiKeysAsync: vi.fn().mockResolvedValue(['test-key']),
    getDeepSeekApiUrlAsync: vi.fn().mockResolvedValue('https://api.deepseek.com/chat/completions'),
    getDeepSeekApiModelAsync: vi.fn().mockResolvedValue('deepseek-flash'),
    getDeepSeekThinkingModeAsync: vi.fn().mockResolvedValue('disabled'),
  };
});

vi.mock('@/shared/proxy/ProxySettings.js', () => ({
  getProxySettingsAsync: vi.fn().mockResolvedValue({}),
  resolveProxyConfig: vi.fn().mockResolvedValue({})
}));

const DEEPSEEK_RAW_RESPONSE_FIXTURES = Object.freeze({
  metadataRich: Object.freeze({
    id: 'deepseek-response-1',
    model: 'deepseek-flash',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: 'DeepSeek translated text',
        reasoning_content: 'ignored reasoning text',
      },
    }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 25,
      total_tokens: 125,
      completion_tokens_details: { reasoning_tokens: 12 },
      prompt_cache_hit_tokens: 3,
      prompt_cache_miss_tokens: 97,
    },
    object: 'chat.completion',
    created: 123,
    system_fingerprint: 'ignored-fingerprint',
  }),
  contentOnly: Object.freeze({
    choices: [{ message: { content: 'DeepSeek Result' } }],
  }),
  minimal: Object.freeze({
    choices: [{ finish_reason: 'stop', message: { content: 'DeepSeek minimal' } }],
  }),
  partialUsage: Object.freeze({
    choices: [{ finish_reason: 'stop', message: { content: 'DeepSeek partial usage' } }],
    usage: { prompt_tokens: 10, total_tokens: 12 },
  }),
  truncated: Object.freeze({
    choices: [{ finish_reason: 'length', message: { content: 'DeepSeek truncated' } }],
  }),
  policy: Object.freeze({
    choices: [{ finish_reason: 'content_filter', message: { content: 'DeepSeek filtered' } }],
  }),
  unknown: Object.freeze({
    choices: [{ finish_reason: 'repository_test_unknown', message: { content: 'DeepSeek unknown' } }],
  }),
  toolCalls: Object.freeze({
    choices: [{ finish_reason: 'tool_calls', message: { content: 'DeepSeek tool call' } }],
  }),
  insufficientResources: Object.freeze({
    choices: [{ finish_reason: 'insufficient_system_resource', message: { content: 'DeepSeek resource limit' } }],
  }),
  errorEnvelope: Object.freeze({
    error: { message: 'Insufficient Balance', code: 'insufficient_balance' },
  }),
});

describe('DeepSeekProvider Error Handling', () => {
  let provider;

  beforeEach(() => {
    vi.clearAllMocks();
    getDeepSeekApiModelAsync.mockResolvedValue('deepseek-flash');
    getDeepSeekThinkingModeAsync.mockResolvedValue('disabled');
    provider = new DeepSeekProvider();
  });

  it('should handle successful translation', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(DEEPSEEK_RAW_RESPONSE_FIXTURES.contentOnly),
      clone: function() { return this; }
    });

    const result = await provider._callAI('system', 'Hello World');
    expect(result).toBe('DeepSeek Result');
  });

  it.each(['deepseek-flash', 'deepseek-v4-pro'])('builds JSON translation payload for thinking-capable model %s', async (model) => {
    getDeepSeekApiModelAsync.mockResolvedValue(model);
    const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

    await provider._callAI('system', 'source', { expectedFormat: ResponseFormat.JSON_OBJECT });

    const request = executeRequest.mock.calls[0][0];
    const payload = JSON.parse(request.fetchOptions.body);
    expect(payload).toMatchObject({
      model,
      temperature: 0.1,
      max_tokens: 4096,
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' }
    });
  });

  it.each([
    ['disabled', { thinking: { type: 'disabled' } }],
    ['low', { thinking: { type: 'enabled' }, reasoning_effort: 'low' }],
    ['high', { thinking: { type: 'enabled' }, reasoning_effort: 'high' }],
    ['max', { thinking: { type: 'enabled' }, reasoning_effort: 'max' }],
  ])('maps thinking mode %s for metadata-capable models', async (mode, expectedThinking) => {
    for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
      getDeepSeekApiModelAsync.mockResolvedValue(model);
      getDeepSeekThinkingModeAsync.mockResolvedValue(mode);
      const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

      await provider._callAI('system', 'source');

      const payload = JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body);
      expect(payload).toMatchObject({ model, ...expectedThinking });
      if (mode === 'disabled') expect(payload).not.toHaveProperty('reasoning_effort');
      executeRequest.mockRestore();
    }
  });

  it('keeps JSON response format alongside enabled thinking', async () => {
    getDeepSeekApiModelAsync.mockResolvedValue('deepseek-v4-pro');
    getDeepSeekThinkingModeAsync.mockResolvedValue('high');
    const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

    await provider._callAI('system', 'source', { expectedFormat: ResponseFormat.JSON_OBJECT });

    const payload = JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body);
    expect(payload).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
      response_format: { type: 'json_object' },
    });
  });

  it('disables thinking conservatively for arbitrary models', async () => {
    getDeepSeekApiModelAsync.mockResolvedValue('custom-deepseek-model');
    getDeepSeekThinkingModeAsync.mockResolvedValue('max');
    const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

    await provider._callAI('system', 'source');

    const payload = JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body);
    expect(payload.thinking).toEqual({ type: 'disabled' });
    expect(payload).not.toHaveProperty('reasoning_effort');
  });

  it('enables thinking only when model metadata explicitly supports it', async () => {
    for (const [model, expectedThinking] of [
      ['deepseek-flash', true],
      ['deepseek-v4-pro', true],
      ['deepseek-chat', false],
    ]) {
      getDeepSeekApiModelAsync.mockResolvedValue(model);
      getDeepSeekThinkingModeAsync.mockResolvedValue('high');
      const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

      await provider._callAI('system', 'source');

      const payload = JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body);
      expect(payload.thinking).toEqual({ type: expectedThinking ? 'enabled' : 'disabled' });
      if (expectedThinking) expect(payload.reasoning_effort).toBe('high');
      else expect(payload).not.toHaveProperty('reasoning_effort');
      executeRequest.mockRestore();
    }
  });

  it('uses CONFIG default for missing text model selection', async () => {
    getDeepSeekApiModelAsync.mockResolvedValue(undefined);
    const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

    await provider._callAI('system', 'source');

    const payload = JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body);
    expect(payload.model).toBe(CONFIG.DEEPSEEK_API_MODEL);
  });

  it('records normalized metadata from the confirmed Chat Completions shape', async () => {
    const operation = createTranslationOperation('deepseek-completion');
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(DEEPSEEK_RAW_RESPONSE_FIXTURES.metadataRich),
      clone: function() { return this; }
    });

    const result = await provider._callAI('system', 'text', { executionContext: { operation } });
    const [record] = operation.snapshotCompletions();

    expect(result).toBe('DeepSeek translated text');
    expect(record).toEqual({
      provider: 'DeepSeek',
      model: 'deepseek-flash',
      termination: CompletionTermination.NORMAL,
      responseId: 'deepseek-response-1',
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        reasoningTokens: 12,
        totalTokens: 125,
      },
    });
    expect(record).not.toHaveProperty('choices');
    expect(record).not.toHaveProperty('message');
    expect(record).not.toHaveProperty('content');
    expect(record).not.toHaveProperty('finish_reason');
    expect(record).not.toHaveProperty('reasoning_content');
    expect(record).not.toHaveProperty('prompt_cache_hit_tokens');
    expect(record).not.toHaveProperty('prompt_cache_miss_tokens');
    expect(record).not.toHaveProperty('object');
    expect(record).not.toHaveProperty('created');
    expect(record).not.toHaveProperty('system_fingerprint');
  });

  it.each([
    ['TRUNCATED', DEEPSEEK_RAW_RESPONSE_FIXTURES.truncated, CompletionTermination.TRUNCATED],
    ['POLICY', DEEPSEEK_RAW_RESPONSE_FIXTURES.policy, CompletionTermination.POLICY],
    ['UNKNOWN', DEEPSEEK_RAW_RESPONSE_FIXTURES.unknown, CompletionTermination.UNKNOWN],
    ['tool_calls fallback', DEEPSEEK_RAW_RESPONSE_FIXTURES.toolCalls, CompletionTermination.UNKNOWN],
    ['insufficient_system_resource fallback', DEEPSEEK_RAW_RESPONSE_FIXTURES.insufficientResources, CompletionTermination.UNKNOWN],
  ])('normalizes %s termination without changing text', async (_label, fixture, termination) => {
    const operation = createTranslationOperation(`deepseek-${_label}`);
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(fixture),
      clone: function() { return this; }
    });

    await expect(provider._callAI('system', 'text', { executionContext: { operation } }))
      .resolves.toEqual(expect.any(String));
    expect(operation.snapshotCompletions()[0].termination).toBe(termination);
  });

  it('preserves usage absence and partial usage without deriving values', async () => {
    const operation = createTranslationOperation('deepseek-usage');
    proxyManager.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve(DEEPSEEK_RAW_RESPONSE_FIXTURES.minimal),
        clone: function() { return this; }
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve(DEEPSEEK_RAW_RESPONSE_FIXTURES.partialUsage),
        clone: function() { return this; }
      });

    await provider._callAI('system', 'minimal', { executionContext: { operation } });
    await provider._callAI('system', 'partial', { executionContext: { operation } });

    expect(operation.snapshotCompletions().map(({ usage }) => usage)).toEqual([
      null,
      { inputTokens: 10, outputTokens: null, reasoningTokens: null, totalTokens: 12 },
    ]);
  });

  it('keeps missing model and response ID absent', async () => {
    const operation = createTranslationOperation('deepseek-identities');
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(DEEPSEEK_RAW_RESPONSE_FIXTURES.minimal),
      clone: function() { return this; }
    });

    await provider._callAI('system', 'text', { executionContext: { operation } });
    expect(operation.snapshotCompletions()[0]).toMatchObject({ model: null, responseId: null });
  });

  it('records two physical responses independently and in order', async () => {
    const operation = createTranslationOperation('deepseek-multiple');
    const first = { ...DEEPSEEK_RAW_RESPONSE_FIXTURES.truncated, id: 'deepseek-1' };
    const second = { ...DEEPSEEK_RAW_RESPONSE_FIXTURES.metadataRich, id: 'deepseek-2' };
    proxyManager.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve(first),
        clone: function() { return this; }
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve(second),
        clone: function() { return this; }
      });

    await provider._callAI('system', 'first', { executionContext: { operation } });
    await provider._callAI('system', 'second', { executionContext: { operation } });

    expect(operation.snapshotCompletions().map(({ responseId, termination }) => ({ responseId, termination }))).toEqual([
      { responseId: 'deepseek-1', termination: CompletionTermination.TRUNCATED },
      { responseId: 'deepseek-2', termination: CompletionTermination.NORMAL },
    ]);
  });

  it('forwards call purpose outside the provider payload', async () => {
    const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');
    await provider._callAI('system', 'text', { callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY });
    const request = executeRequest.mock.calls[0][0];
    expect(request).toMatchObject({ callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY });
    expect(request.fetchOptions.headers).not.toHaveProperty('callPurpose');
    expect(JSON.parse(request.fetchOptions.body)).not.toHaveProperty('callPurpose');
  });

  it('does not read or write normal history for structured recovery', async () => {
    const claim = vi
      .spyOn(AIConversationHelper, 'claimNextTurn')
      .mockResolvedValue(1);
    const messages = vi
      .spyOn(AIConversationHelper, 'getConversationMessages')
      .mockResolvedValue({
        messages: [
          { role: 'system', content: 'system prompt' },
          { role: 'user', content: 'current recovery segment' }
        ],
        session: null
      });
    const update = vi
      .spyOn(AIConversationHelper, 'updateSessionHistory')
      .mockResolvedValue();
    const execute = vi
      .spyOn(provider, '_executeRequest')
      .mockResolvedValue('translated');
    try {
      const result = await provider._callAI(
        'system prompt',
        'current recovery segment',
        {
          sessionId: 'session-1',
          mode: 'select-element',
          callPurpose:
            TranslationCallPurpose.STRUCTURED_RECOVERY,
        }
      );
      expect(claim).not.toHaveBeenCalled();
      expect(messages).toHaveBeenCalledWith(
        'session-1', provider.providerName, 'current recovery segment', 'system prompt', 'select-element',
        expect.objectContaining({ callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY, conversationParticipates: false })
      );
      expect(update).not.toHaveBeenCalled();
      const request = execute.mock.calls[0][0];
      expect(request).toMatchObject({
        callPurpose:
          TranslationCallPurpose.STRUCTURED_RECOVERY,
      });
      expect(request.fetchOptions.headers)
        .not.toHaveProperty('callPurpose');
      expect(JSON.parse(request.fetchOptions.body))
        .not.toHaveProperty('callPurpose');
      expect(JSON.parse(request.fetchOptions.body).thinking).toEqual({ type: 'disabled' });
      expect(result).toBe('translated');
    } finally {
      claim.mockRestore();
      messages.mockRestore();
      update.mockRestore();
      execute.mockRestore();
    }
  });

  it('stages a primary candidate instead of writing history directly', async () => {
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
    const operation = createTranslationOperation('deepseek-error-envelope');
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(DEEPSEEK_RAW_RESPONSE_FIXTURES.errorEnvelope),
      clone: function() { return this; }
    });

    await expect(provider._callAI('system', 'text', { executionContext: { operation } }))
      .rejects.toThrow('API_ERROR: Insufficient Balance');
    expect(operation.snapshotCompletions()).toEqual([]);
  });

  it('should handle HTTP 401 Unauthorized', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve({
        error: { message: 'Invalid API Key' }
      }),
      clone: function() { return this; }
    });

    try {
      await provider._callAI('system', 'text');
    } catch (error) {
      expect(error.type).toBe(ErrorTypes.API_KEY_INVALID);
      expect(error.statusCode).toBe(401);
    }
  });
});
