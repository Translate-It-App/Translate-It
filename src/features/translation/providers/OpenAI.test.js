import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIProvider } from './OpenAI.js';
import { proxyManager } from '@/shared/proxy/ProxyManager.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { TranslationCallPurpose } from './ProviderConstants.js';
import { AIConversationHelper } from './utils/AIConversationHelper.js';
import { CompletionTermination } from '@/features/translation/ir/CompletionContract.js';
import { createTranslationOperation } from '@/features/translation/ir/TranslationOperation.js';
import { CONFIG, getOpenAIModelAsync } from '@/shared/config/config.js';
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
    getOpenAIApiKeysAsync: vi.fn().mockResolvedValue(['test-key']),
    getOpenAIModelAsync: vi.fn().mockResolvedValue('gpt-6-luna'),
  };
});

vi.mock('@/shared/proxy/ProxySettings.js', () => ({
  getProxySettingsAsync: vi.fn().mockResolvedValue({}),
  resolveProxyConfig: vi.fn().mockResolvedValue({})
}));

const OPENAI_RAW_RESPONSE_FIXTURES = Object.freeze({
  metadataRich: Object.freeze({
    id: 'chatcmpl-test-1',
    model: 'gpt-test-model',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: 'OpenAI translated text',
      },
    }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 30,
      total_tokens: 130,
      completion_tokens_details: {
        reasoning_tokens: 12,
      },
    },
  }),
  metadataAbsent: Object.freeze({
    choices: [{ message: { content: 'سلام دنیا' } }],
  }),
  requestErrorIdSeparation: Object.freeze({
    id: 'chatcmpl-test',
    request_id: 'req-test',
    choices: [{ finish_reason: 'stop', message: { content: 'OpenAI translated text' } }],
  }),
  truncated: Object.freeze({
    choices: [{ finish_reason: 'length', message: { content: 'OpenAI truncated' } }],
  }),
  policy: Object.freeze({
    choices: [{ finish_reason: 'content_filter', message: { content: 'OpenAI filtered' } }],
  }),
  toolCalls: Object.freeze({
    choices: [{ finish_reason: 'tool_calls', message: { content: 'OpenAI tool' } }],
  }),
  functionCall: Object.freeze({
    choices: [{ finish_reason: 'function_call', message: { content: 'OpenAI function' } }],
  }),
  unknownTermination: Object.freeze({
    choices: [{ finish_reason: 'repository_test_unknown', message: { content: 'OpenAI unknown' } }],
  }),
  noUsage: Object.freeze({
    choices: [{ finish_reason: 'stop', message: { content: 'OpenAI no usage' } }],
  }),
  partialUsage: Object.freeze({
    choices: [{ finish_reason: 'stop', message: { content: 'OpenAI partial' } }],
    usage: { prompt_tokens: 10, total_tokens: 12 },
  }),
  emptyChoices: Object.freeze({
    choices: [],
  }),
  errorEnvelope: Object.freeze({
    error: { message: 'Rate limit reached', type: 'insufficient_quota' },
  }),
});

describe('OpenAIProvider Error Handling', () => {
  let provider;

  beforeEach(() => {
    vi.clearAllMocks();
    getOpenAIModelAsync.mockResolvedValue('gpt-6-luna');
    provider = new OpenAIProvider();
  });

  it.each([
    ['gpt-6-luna', 'none'],
    ['gpt-6-sol', 'none'],
    ['gpt-4o-mini', undefined],
    ['custom-model-id', undefined],
  ])('builds modern text request for %s', async (model, reasoningEffort) => {
    getOpenAIModelAsync.mockResolvedValue(model);
    const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

    await provider._callAI('system', 'text', { expectedFormat: ResponseFormat.JSON_OBJECT });

    expect(executeRequest.mock.calls[0][0].url).toBe(CONFIG.OPENAI_API_URL);
    const payload = JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body);
    expect(payload).toMatchObject({
      model,
      max_completion_tokens: 4096,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'text' },
      ],
    });
    expect(payload).not.toHaveProperty('max_tokens');
    // No curated or custom model sends temperature; GPT-6 runs with disabled reasoning.
    expect(payload).not.toHaveProperty('temperature');
    if (reasoningEffort) {
      expect(payload).toHaveProperty('reasoning_effort', reasoningEffort);
    } else {
      expect(payload).not.toHaveProperty('reasoning_effort');
    }
  });

  it('uses CONFIG default for missing text model selection', async () => {
    getOpenAIModelAsync.mockResolvedValue(undefined);
    const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

    await provider._callAI('system', 'text');

    const payload = JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body);
    expect(payload.model).toBe(CONFIG.OPENAI_API_MODEL);
  });

  it('uses the supplied original source length instead of transformed userText length', async () => {
    const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');
    const transformedText = '<compatibility-wrapper>source</compatibility-wrapper>';

    await provider._callAI('system', transformedText, { originalCharCount: 6 });

    expect(executeRequest.mock.calls[0][0].originalCharCount).toBe(6);
  });

  it('should handle successful translation', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(OPENAI_RAW_RESPONSE_FIXTURES.metadataAbsent),
      clone: function() { return this; }
    });

    const result = await provider._callAI('system', 'Hello World');
    expect(result).toBe('سلام دنیا');
  });

  it('records normalized metadata from the confirmed OpenAI Chat Completions shape', async () => {
    const operation = createTranslationOperation('openai-completion');
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(OPENAI_RAW_RESPONSE_FIXTURES.metadataRich),
      clone: function() { return this; }
    });

    const result = await provider._callAI('system', 'text', { executionContext: { operation } });
    const [record] = operation.snapshotCompletions();

    expect(result).toBe('OpenAI translated text');
    expect(record).toEqual({
      provider: 'OpenAI',
      model: 'gpt-test-model',
      termination: CompletionTermination.NORMAL,
      responseId: 'chatcmpl-test-1',
      usage: {
        inputTokens: 100,
        outputTokens: 30,
        reasoningTokens: 12,
        totalTokens: 130,
      },
    });
    expect(record).not.toHaveProperty('choices');
    expect(record).not.toHaveProperty('message');
    expect(record).not.toHaveProperty('content');
    expect(record).not.toHaveProperty('finish_reason');
    expect(record).not.toHaveProperty('request_id');
    expect(record.usage).toEqual({
      inputTokens: 100,
      outputTokens: 30,
      reasoningTokens: 12,
      totalTokens: 130,
    });
  });

  it.each([
    ['TRUNCATED', OPENAI_RAW_RESPONSE_FIXTURES.truncated, CompletionTermination.TRUNCATED],
    ['POLICY', OPENAI_RAW_RESPONSE_FIXTURES.policy, CompletionTermination.POLICY],
    ['tool_calls fallback', OPENAI_RAW_RESPONSE_FIXTURES.toolCalls, CompletionTermination.UNKNOWN],
    ['function_call fallback', OPENAI_RAW_RESPONSE_FIXTURES.functionCall, CompletionTermination.UNKNOWN],
    ['synthetic unknown', OPENAI_RAW_RESPONSE_FIXTURES.unknownTermination, CompletionTermination.UNKNOWN],
  ])('normalizes %s termination without changing text', async (_label, fixture, termination) => {
    const operation = createTranslationOperation(`openai-${_label}`);
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(fixture),
      clone: function() { return this; }
    });

    await expect(provider._callAI('system', 'text', { executionContext: { operation } }))
      .resolves.toBe(fixture.choices[0].message.content);
    expect(operation.snapshotCompletions()[0].termination).toBe(termination);
  });

  it('preserves usage absence and partial usage without deriving values', async () => {
    const operation = createTranslationOperation('openai-usage');
    proxyManager.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve(OPENAI_RAW_RESPONSE_FIXTURES.noUsage),
        clone: function() { return this; }
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve(OPENAI_RAW_RESPONSE_FIXTURES.partialUsage),
        clone: function() { return this; }
      });

    await provider._callAI('system', 'no-usage', { executionContext: { operation } });
    await provider._callAI('system', 'partial', { executionContext: { operation } });

    expect(operation.snapshotCompletions().map(({ usage }) => usage)).toEqual([
      null,
      { inputTokens: 10, outputTokens: null, reasoningTokens: null, totalTokens: 12 },
    ]);
  });

  it('keeps missing model and response ID absent', async () => {
    const operation = createTranslationOperation('openai-absent-identities');
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(OPENAI_RAW_RESPONSE_FIXTURES.metadataAbsent),
      clone: function() { return this; }
    });

    await provider._callAI('system', 'text', { executionContext: { operation } });
    expect(operation.snapshotCompletions()[0]).toMatchObject({ model: null, responseId: null });
  });

  it('uses data.id as responseId and ignores request_id', async () => {
    const operation = createTranslationOperation('openai-request-id');
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(OPENAI_RAW_RESPONSE_FIXTURES.requestErrorIdSeparation),
      clone: function() { return this; }
    });

    await provider._callAI('system', 'text', { executionContext: { operation } });
    expect(operation.snapshotCompletions()[0].responseId).toBe('chatcmpl-test');
    expect(operation.snapshotCompletions()[0]).not.toHaveProperty('request_id');
  });

  it('returns translation normally without executionContext', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(OPENAI_RAW_RESPONSE_FIXTURES.metadataRich),
      clone: function() { return this; }
    });

    const result = await provider._callAI('system', 'text');
    expect(result).toBe('OpenAI translated text');
  });

  it('records two physical responses independently and in order', async () => {
    const operation = createTranslationOperation('openai-multiple');
    proxyManager.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve({ ...OPENAI_RAW_RESPONSE_FIXTURES.truncated, id: 'chatcmpl-1' }),
        clone: function() { return this; }
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve({ ...OPENAI_RAW_RESPONSE_FIXTURES.metadataRich, id: 'chatcmpl-2' }),
        clone: function() { return this; }
      });

    await provider._callAI('system', 'first', { executionContext: { operation } });
    await provider._callAI('system', 'second', { executionContext: { operation } });

    expect(operation.snapshotCompletions().map(({ responseId, termination }) => ({ responseId, termination }))).toEqual([
      { responseId: 'chatcmpl-1', termination: CompletionTermination.TRUNCATED },
      { responseId: 'chatcmpl-2', termination: CompletionTermination.NORMAL },
    ]);
  });

  it('does not create a completion record for an error envelope', async () => {
    const operation = createTranslationOperation('openai-error');
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(OPENAI_RAW_RESPONSE_FIXTURES.errorEnvelope),
      clone: function() { return this; }
    });

    await expect(provider._callAI('system', 'text', { executionContext: { operation } }))
      .rejects.toThrow('API_ERROR: Rate limit reached');
    expect(operation.snapshotCompletions()).toEqual([]);
  });

  it('does not create a completion record for a choice-less response', async () => {
    const operation = createTranslationOperation('openai-empty-choices');
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(OPENAI_RAW_RESPONSE_FIXTURES.emptyChoices),
      clone: function() { return this; }
    });

    await expect(provider._callAI('system', 'text', { executionContext: { operation } }))
      .rejects.toThrow();
    expect(operation.snapshotCompletions()).toEqual([]);
  });

  it('does not leak raw provider fields into the completion record', async () => {
    const operation = createTranslationOperation('openai-privacy');
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(OPENAI_RAW_RESPONSE_FIXTURES.metadataRich),
      clone: function() { return this; }
    });

    await provider._callAI('system', 'text', { executionContext: { operation } });
    const record = operation.snapshotCompletions()[0];

    expect(record).not.toHaveProperty('choices');
    expect(record).not.toHaveProperty('message');
    expect(record).not.toHaveProperty('content');
    expect(record).not.toHaveProperty('finish_reason');
    expect(record).not.toHaveProperty('request_id');
    expect(record).not.toHaveProperty('logprobs');
    expect(record).not.toHaveProperty('system_fingerprint');
    expect(record).not.toHaveProperty('service_tier');
    expect(record).not.toHaveProperty('prompt_tokens_details');
    expect(record).not.toHaveProperty('raw response');
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
          { role: 'user', content: 'current recovery segment' },
        ],
        session: null,
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
      await expect(provider._callAI('system', 'source', {
        sessionId: 'session-1',
        mode: 'select-element',
        callPurpose: TranslationCallPurpose.PRIMARY_TRANSLATION,
        conversationParticipates: true,
        conversationCommitCandidate: candidate
      })).resolves.toBe('translated');
      expect(candidate.stage).toHaveBeenCalledWith({ sessionId: 'session-1', userContent: 'source', assistantContent: 'translated' });
      expect(update).not.toHaveBeenCalled();
    } finally {
      update.mockRestore();
    }
  });

  it('writes history for eligible Select Element primary calls without a candidate', async () => {
    const update = vi.spyOn(AIConversationHelper, 'updateSessionHistory').mockResolvedValue();
    vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');
    try {
      await expect(provider._callAI('system', 'source', { sessionId: 'session-1', mode: 'select-element', callPurpose: TranslationCallPurpose.PRIMARY_TRANSLATION, conversationParticipates: true }))
        .resolves.toBe('translated');
      expect(update).toHaveBeenCalledWith('session-1', 'source', 'translated', expect.objectContaining({ callPurpose: TranslationCallPurpose.PRIMARY_TRANSLATION, conversationParticipates: true }));
    } finally {
      update.mockRestore();
    }
  });

  it('does not use direct history fallback for non-participating primary calls', async () => {
    const update = vi.spyOn(AIConversationHelper, 'updateSessionHistory').mockResolvedValue();
    vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');
    try {
      await provider._callAI('system', 'source', {
        sessionId: 'session-1', mode: 'field', callPurpose: TranslationCallPurpose.PRIMARY_TRANSLATION,
        conversationParticipates: false,
      });
      expect(update).not.toHaveBeenCalled();
    } finally { update.mockRestore(); }
  });

  it('should detect API_ERROR wrapped in 200 OK response', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(OPENAI_RAW_RESPONSE_FIXTURES.errorEnvelope),
      clone: function() { return this; }
    });

    await expect(provider._callAI('system', 'text'))
      .rejects.toThrow('API_ERROR: Rate limit reached');
  });

  it('should handle HTTP 429 Too Many Requests', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve({
        error: { message: 'Rate limit exceeded' }
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

  it('should classify structured insufficient quota as insufficient balance', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve({
        error: {
          message: 'You have no credits remaining.',
          type: 'insufficient_quota',
          code: 'insufficient_quota',
        },
      }),
      clone: function() { return this; }
    });

    await expect(provider._callAI('system', 'text')).rejects.toMatchObject({
      type: ErrorTypes.INSUFFICIENT_BALANCE,
      statusCode: 429,
    });
  });

  it.each([400, 422])('should classify structured request errors as invalid requests for HTTP %s', async (status) => {
    proxyManager.fetch.mockResolvedValue({
      ok: false,
      status,
      statusText: 'Bad Request',
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve({
        error: {
          message: 'Invalid request parameters.',
          type: 'invalid_request_error',
        },
      }),
      clone: function() { return this; }
    });

    await expect(provider._callAI('system', 'text')).rejects.toMatchObject({
      type: ErrorTypes.INVALID_REQUEST,
      statusCode: status,
    });
  });

  it('keeps unmatched structured HTTP 400 errors generic', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve({
        error: {
          message: 'Provider rejected request.',
          type: 'provider_specific_error',
          code: 'request_rejected',
        },
      }),
      clone: function() { return this; }
    });

    await expect(provider._callAI('system', 'text')).rejects.toMatchObject({
      type: ErrorTypes.HTTP_ERROR,
      statusCode: 400,
    });
  });

  it('should handle HTTP 500 Server Error', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve({
        error: { message: 'Something went wrong' }
      }),
      clone: function() { return this; }
    });

    try {
      await provider._callAI('system', 'text');
    } catch (error) {
      expect(error.type).toBe(ErrorTypes.SERVER_ERROR);
    }
  });

  it('should handle malformed JSON response', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
      text: () => Promise.resolve('Invalid JSON'),
      clone: function() { return this; }
    });

    await expect(provider._callAI('system', 'text'))
      .rejects.toThrow();
  });

  it('should handle network timeout/failure', async () => {
    proxyManager.fetch.mockRejectedValue(new TypeError('NetworkError when attempting to fetch resource.'));

    try {
      await provider._callAI('system', 'text');
    } catch (error) {
      expect(error.type).toBe(ErrorTypes.NETWORK_ERROR);
    }
  });

  it('should handle abortion/cancellation', async () => {
    const controller = new AbortController();
    const abortError = new Error('The user aborted a request.');
    abortError.name = 'AbortError';
    controller.abort('user-cancelled');
    
    proxyManager.fetch.mockRejectedValue(abortError);

    try {
      await provider._callAI('system', 'text', { abortController: controller });
    } catch (error) {
      expect(error.type).toBe(ErrorTypes.USER_CANCELLED);
    }
  });

  it('does not classify an ambiguous operation AbortError as user cancellation', async () => {
    const controller = new AbortController();
    const abortError = new Error('The operation was aborted.');
    abortError.name = 'AbortError';

    proxyManager.fetch.mockRejectedValue(abortError);

    try {
      await provider._callAI('system', 'text', { abortController: controller });
    } catch (error) {
      expect(error.type).not.toBe(ErrorTypes.USER_CANCELLED);
      expect(error.operationAborted).toBe(true);
      expect(error.cancellationReason).toBe('operation-abort');
    }
  });
});
