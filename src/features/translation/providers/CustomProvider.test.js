import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CustomProvider, clearCustomResponseFormatSupportCache } from './CustomProvider.js';
import { proxyManager } from '@/shared/proxy/ProxyManager.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { getCustomApiKeysAsync, getCustomApiUrlAsync, getCustomApiModelAsync } from '@/shared/config/config.js';
import { TranslationCallPurpose } from './ProviderConstants.js';
import { AIConversationHelper } from './utils/AIConversationHelper.js';
import { CompletionTermination } from '@/features/translation/ir/CompletionContract.js';
import { createTranslationOperation } from '@/features/translation/ir/TranslationOperation.js';
import { ResponseFormat } from '@/shared/config/translationConstants.js';
import { AIResponseParser } from './utils/AIResponseParser.js';
import { mapCanonicalTranslationError } from '@/shared/error-management/PublicTranslationErrorPolicy.js';
import { PublicTranslationErrorTypes } from '@/shared/error-management/PublicTranslationError.js';

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
    getCustomApiKeysAsync: vi.fn().mockResolvedValue(['test-key']),
    getCustomApiUrlAsync: vi.fn().mockResolvedValue('https://custom-api.com/v1/chat/completions'),
    getCustomApiModelAsync: vi.fn().mockResolvedValue('custom-model'),
  };
});

vi.mock('@/shared/proxy/ProxySettings.js', () => ({
  getProxySettingsAsync: vi.fn().mockResolvedValue({}),
  resolveProxyConfig: vi.fn().mockResolvedValue({})
}));

const CUSTOM_RAW_RESPONSE_FIXTURES = Object.freeze({
  contentOnly: Object.freeze({
    choices: [{ message: { content: 'Custom AI Result' } }],
  }),
  metadataRich: Object.freeze({
    id: 'custom-completion-1',
    model: 'custom-model',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'Custom translated text' },
    }],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 10,
      total_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 4 },
    },
  }),
  truncated: Object.freeze({
    choices: [{ finish_reason: 'length', message: { content: 'Custom truncated' } }],
  }),
  policy: Object.freeze({
    choices: [{ finish_reason: 'content_filter', message: { content: 'Custom filtered' } }],
  }),
  unknownTermination: Object.freeze({
    choices: [{ finish_reason: 'custom_nonstandard_reason', message: { content: 'Custom unknown' } }],
  }),
  partialUsage: Object.freeze({
    choices: [{ finish_reason: 'stop', message: { content: 'Custom partial' } }],
    usage: { prompt_tokens: 5 },
  }),
  customMetadata: Object.freeze({
    choices: [{ finish_reason: 'stop', message: { content: 'Custom ignored metadata' } }],
    token_count: 99,
    metadata: { reasoning_tokens: 88 },
  }),
  modelAbsent: Object.freeze({
    id: 'custom-no-model',
    choices: [{ finish_reason: 'stop', message: { content: 'Custom no model' } }],
  }),
  idAbsent: Object.freeze({
    model: 'custom-model-2',
    choices: [{ finish_reason: 'stop', message: { content: 'Custom no id' } }],
  }),
  idAndRequestId: Object.freeze({
    id: 'custom-id',
    request_id: 'custom-req-id',
    choices: [{ finish_reason: 'stop', message: { content: 'Custom req id test' } }],
  }),
  emptyChoices: Object.freeze({
    choices: [],
  }),
  errorEnvelope: Object.freeze({
    error: { message: 'Internal Model Error', code: 'model_error' },
  }),
});

describe('CustomProvider Error Handling', () => {
  let provider;

  beforeEach(() => {
    vi.clearAllMocks();
    clearCustomResponseFormatSupportCache();
    vi.mocked(getCustomApiUrlAsync).mockResolvedValue('https://custom-api.com/v1/chat/completions');
    vi.mocked(getCustomApiModelAsync).mockResolvedValue('custom-model');
    provider = new CustomProvider();
  });

  const runHttpError = async (body, status = 404) => {
    proxyManager.fetch.mockResolvedValue({
      ok: false,
      status,
      statusText: status === 404 ? 'Not Found' : 'Bad Request',
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(body),
      clone: function() { return this; }
    });

    return provider._callAI('system', 'Hello World').catch(error => error);
  };

  it('should handle successful translation', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(CUSTOM_RAW_RESPONSE_FIXTURES.contentOnly),
      clone: function() { return this; }
    });

    const result = await provider._callAI('system', 'Hello World');
    expect(result).toBe('Custom AI Result');
  });

  it('uses the supplied original source length instead of transformed userText length', async () => {
    const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');
    const transformedText = '<compatibility-wrapper>source</compatibility-wrapper>';

    await provider._callAI('system', transformedText, { originalCharCount: 6 });

    expect(executeRequest.mock.calls[0][0].originalCharCount).toBe(6);
  });

  it.each([
    { label: 'top-level', body: { code: 'model_not_found' } },
    { label: 'nested', body: { error: { code: 'model_not_found' } } },
  ])('classifies proven $label model code as MODEL_MISSING', async ({ body }) => {
    const error = await runHttpError(body);

    expect(error).toMatchObject({
      type: ErrorTypes.MODEL_MISSING,
      statusCode: 404,
      });
  });

  it('preserves insufficient-balance identity for HTTP 402', async () => {
    const error = await runHttpError({ error: { code: 'billing_required' } }, 402);

    expect(error).toMatchObject({
      type: ErrorTypes.INSUFFICIENT_BALANCE,
      statusCode: 402,
      providerName: 'Custom',
    });
  });

  it.each([
    { label: 'route-not-found', body: { code: 'route_not_found' } },
    { label: 'endpoint-not-found', body: { code: 'endpoint_not_found' } },
    { label: 'generic not-found', body: { code: 'not_found' } },
    { label: 'generic invalid-request type', body: { error: { type: 'invalid_request_error' } } },
    { label: 'empty body', body: {} },
    { label: 'malformed fields', body: { code: { value: 'model_not_found' }, error: { code: ['model_not_found'], type: 404 } } },
  ])('keeps $label 404 as HTTP_ERROR', async ({ body }) => {
    const error = await runHttpError(body);

    expect(error).toMatchObject({
      type: ErrorTypes.HTTP_ERROR,
      statusCode: 404,
    });
  });

  it('maps confirmed model failure to public model unavailable', async () => {
    const error = await runHttpError({ error: { code: 'model_not_found' } });

    expect(mapCanonicalTranslationError(error).type)
      .toBe(PublicTranslationErrorTypes.MODEL_UNAVAILABLE);
  });

  it('does not restore MODEL_MISSING through global fallback for ambiguous 404', async () => {
    const error = await runHttpError({ code: 'not_found' });

    expect(error.type).toBe(ErrorTypes.HTTP_ERROR);
    expect(error.originalType).toBeUndefined();
    expect(mapCanonicalTranslationError(error).type)
      .not.toBe(PublicTranslationErrorTypes.MODEL_UNAVAILABLE);
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
          callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
        }
      );
       expect(claim).not.toHaveBeenCalled();
       expect(messages).toHaveBeenCalledWith(
         'session-1', provider.providerName, 'current recovery segment', 'system prompt', 'select-element',
         expect.objectContaining({ callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY, conversationParticipates: false })
       );
       expect(update).not.toHaveBeenCalled();
      const request = execute.mock.calls[0][0];
      expect(request).toMatchObject({ callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY });
      expect(request.fetchOptions.headers).not.toHaveProperty('callPurpose');
      expect(JSON.parse(request.fetchOptions.body)).not.toHaveProperty('callPurpose');
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

  it('should allow anonymous OpenAI-compatible requests without an API key', async () => {
    vi.mocked(getCustomApiKeysAsync).mockResolvedValueOnce([]);

    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve({
        choices: [{ message: { content: 'Anonymous Custom AI Result' } }]
      }),
      clone: function() { return this; }
    });

    const result = await provider._callAI('system', 'Hello World');
    const fetchOptions = proxyManager.fetch.mock.calls[0][1];

    expect(result).toBe('Anonymous Custom AI Result');
    expect(fetchOptions.headers.Authorization).toBeUndefined();
  });

  it.each([ResponseFormat.JSON_OBJECT, ResponseFormat.JSON_ARRAY])(
    'sends json_object response format for %s anonymous calls',
    async (expectedFormat) => {
    vi.mocked(getCustomApiKeysAsync).mockResolvedValueOnce([]);
    const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

    await provider._callAI('system', 'source', { expectedFormat });

    const request = executeRequest.mock.calls[0][0];
    expect(request.fetchOptions.headers.Authorization).toBeUndefined();
    expect(JSON.parse(request.fetchOptions.body)).toMatchObject({
      model: 'custom-model',
      messages: expect.any(Array),
      max_tokens: 4096,
      response_format: { type: 'json_object' }
    });
    },
  );

  it('omits response format for STRING calls', async () => {
    const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

    await provider._callAI('system', 'source', { expectedFormat: ResponseFormat.STRING });

    const payload = JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body);
    expect(payload).not.toHaveProperty('response_format');
  });

  it.each([400, 422])(
    'falls back once when HTTP %s explicitly rejects response_format',
    async (statusCode) => {
      const unsupported = Object.assign(new Error('Unknown parameter `response_format`'), {
        statusCode,
        type: ErrorTypes.HTTP_ERROR,
      });
      const executeRequest = vi.spyOn(provider, '_executeRequest')
        .mockRejectedValueOnce(unsupported)
        .mockResolvedValueOnce('translated');

      await expect(provider._callAI('system', 'source', { expectedFormat: ResponseFormat.JSON_OBJECT }))
        .resolves.toBe('translated');

      expect(executeRequest).toHaveBeenCalledTimes(2);
      const firstRequest = executeRequest.mock.calls[0][0];
      const fallbackRequest = executeRequest.mock.calls[1][0];
      const firstPayload = JSON.parse(firstRequest.fetchOptions.body);
      const fallbackPayload = JSON.parse(fallbackRequest.fetchOptions.body);

      expect(firstPayload.response_format).toEqual({ type: 'json_object' });
      expect(fallbackPayload).not.toHaveProperty('response_format');
      expect(fallbackRequest.url).toBe(firstRequest.url);
      expect(fallbackRequest.charCount).toBe(firstRequest.charCount);
      expect(fallbackRequest.originalCharCount).toBe(firstRequest.originalCharCount);
      expect(fallbackRequest.callPurpose).toBe(firstRequest.callPurpose);
      expect(fallbackRequest.executionContext).toBe(firstRequest.executionContext);
      expect(fallbackRequest.fetchOptions.headers).toBe(firstRequest.fetchOptions.headers);
      expect(fallbackPayload).toMatchObject({
        model: firstPayload.model,
        messages: firstPayload.messages,
        max_tokens: firstPayload.max_tokens,
      });
    },
  );

  it('reuses learned response_format capability across internal retries', async () => {
    const unsupported = Object.assign(new Error('Unknown parameter `response_format`'), {
      statusCode: 400,
      type: ErrorTypes.HTTP_ERROR,
    });
    const capabilityRef = { responseFormatUnsupported: false };
    const executeRequest = vi.spyOn(provider, '_executeRequest')
      .mockRejectedValueOnce(unsupported)
      .mockResolvedValue('translated');

    await expect(provider._callAI('system', 'source', {
      expectedFormat: ResponseFormat.JSON_OBJECT,
      customResponseFormatCapabilityRef: capabilityRef,
    })).resolves.toBe('translated');
    await expect(provider._callAI('system', 'retry', {
      expectedFormat: ResponseFormat.JSON_OBJECT,
      customResponseFormatCapabilityRef: capabilityRef,
    })).resolves.toBe('translated');

    expect(capabilityRef.responseFormatUnsupported).toBe(true);
    expect(executeRequest).toHaveBeenCalledTimes(3);
    expect(JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body)).toHaveProperty('response_format');
    expect(JSON.parse(executeRequest.mock.calls[1][0].fetchOptions.body)).not.toHaveProperty('response_format');
    expect(JSON.parse(executeRequest.mock.calls[2][0].fetchOptions.body)).not.toHaveProperty('response_format');
  });

  it('reuses cached unsupported capability for a fresh ref with the same endpoint', async () => {
    const unsupported = Object.assign(new Error('Unknown parameter `response_format`'), {
      statusCode: 400,
      type: ErrorTypes.HTTP_ERROR,
    });
    const firstCapabilityRef = { responseFormatUnsupported: false };
    const secondCapabilityRef = { responseFormatUnsupported: false };
    const executeRequest = vi.spyOn(provider, '_executeRequest')
      .mockRejectedValueOnce(unsupported)
      .mockResolvedValueOnce('first')
      .mockResolvedValueOnce('second');

    await provider._callAI('system', 'first', {
      expectedFormat: ResponseFormat.JSON_OBJECT,
      customResponseFormatCapabilityRef: firstCapabilityRef,
    });
    await provider._callAI('system', 'second', {
      expectedFormat: ResponseFormat.JSON_OBJECT,
      customResponseFormatCapabilityRef: secondCapabilityRef,
    });

    expect(executeRequest).toHaveBeenCalledTimes(3);
    expect(JSON.parse(executeRequest.mock.calls[2][0].fetchOptions.body)).not.toHaveProperty('response_format');
    expect(secondCapabilityRef.responseFormatUnsupported).toBe(true);
  });

  it('reuses capability state across the actual BaseAI rate-limit retry boundary', async () => {
    const unsupported = Object.assign(new Error('Unknown parameter `response_format`'), {
      statusCode: 400,
      type: ErrorTypes.HTTP_ERROR,
    });
    const transientFailure = Object.assign(new Error('Temporary failure'), {
      statusCode: 503,
      type: ErrorTypes.SERVER_ERROR,
    });
    const executeRequest = vi.spyOn(provider, '_executeRequest')
      .mockRejectedValueOnce(unsupported)
      .mockRejectedValueOnce(transientFailure)
      .mockResolvedValueOnce('translated');
    const executeWithRateLimit = vi.spyOn(provider, '_executeWithRateLimit')
      .mockImplementation(async (task) => {
        await task({ attempt: 1 }).catch(() => {});
        return task({ attempt: 2 });
      });
    const parseBatchResult = vi.spyOn(AIResponseParser, 'parseBatchResult')
      .mockReturnValue({ results: ['translated'], contractViolation: false });

    try {
      await expect(provider._translateBatch(
        [{ id: 'unit-1', text: 'source' }],
        'en',
        'fa',
        'selection',
        null,
        null,
        null,
        null,
        null,
        ResponseFormat.JSON_OBJECT,
      )).resolves.toEqual(['translated']);

      expect(executeWithRateLimit).toHaveBeenCalledTimes(1);
      expect(executeRequest).toHaveBeenCalledTimes(3);
      expect(JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body)).toHaveProperty('response_format');
      expect(JSON.parse(executeRequest.mock.calls[1][0].fetchOptions.body)).not.toHaveProperty('response_format');
      expect(JSON.parse(executeRequest.mock.calls[2][0].fetchOptions.body)).not.toHaveProperty('response_format');
    } finally {
      parseBatchResult.mockRestore();
      executeWithRateLimit.mockRestore();
    }
  });

  it('reuses cached unsupported capability across BaseAI structured executions', async () => {
    const unsupported = Object.assign(new Error('Unsupported parameter: response_format'), {
      statusCode: 422,
      type: ErrorTypes.HTTP_ERROR,
    });
    const executeRequest = vi.spyOn(provider, '_executeRequest')
      .mockRejectedValueOnce(unsupported)
      .mockResolvedValue('translated');
    const executeWithRateLimit = vi.spyOn(provider, '_executeWithRateLimit')
      .mockImplementation(async (task) => task({}));
    const parseBatchResult = vi.spyOn(AIResponseParser, 'parseBatchResult')
      .mockReturnValue({ results: ['translated'], contractViolation: false });

    try {
      const args = [
        [{ id: 'unit-1', text: 'source' }],
        'en',
        'fa',
        'selection',
        null,
        null,
        null,
        null,
        null,
        ResponseFormat.JSON_OBJECT,
      ];
      await provider._translateBatch(...args);
      await provider._translateBatch(...args);

      expect(executeRequest).toHaveBeenCalledTimes(3);
      expect(JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body)).toHaveProperty('response_format');
      expect(JSON.parse(executeRequest.mock.calls[1][0].fetchOptions.body)).not.toHaveProperty('response_format');
      expect(JSON.parse(executeRequest.mock.calls[2][0].fetchOptions.body)).not.toHaveProperty('response_format');
    } finally {
      parseBatchResult.mockRestore();
      executeWithRateLimit.mockRestore();
    }
  });

  it('reuses cached unsupported capability across sequential items', async () => {
    const unsupported = Object.assign(new Error('Unknown parameter `response_format`'), {
      statusCode: 400,
      type: ErrorTypes.HTTP_ERROR,
    });
    const executeRequest = vi.spyOn(provider, '_executeRequest')
      .mockRejectedValueOnce(unsupported)
      .mockResolvedValue('translated');
    const executeWithRateLimit = vi.spyOn(provider, '_executeWithRateLimit')
      .mockImplementation(async (task) => task({}));

    try {
      await expect(provider._traditionalBatchTranslate(
        ['first', 'second'],
        'en',
        'fa',
        'selection',
        null,
        null,
        null,
        null,
        null,
        ResponseFormat.JSON_OBJECT,
      )).resolves.toBeDefined();

      expect(executeRequest).toHaveBeenCalledTimes(3);
      expect(JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body)).toHaveProperty('response_format');
      expect(JSON.parse(executeRequest.mock.calls[1][0].fetchOptions.body)).not.toHaveProperty('response_format');
      expect(JSON.parse(executeRequest.mock.calls[2][0].fetchOptions.body)).not.toHaveProperty('response_format');
    } finally {
      executeWithRateLimit.mockRestore();
    }
  });

  it.each([
    [400, 'Bad request'],
    [422, 'Invalid request'],
    [404, 'Unknown parameter `response_format`'],
    [401, 'Unknown parameter `response_format`'],
    [429, 'Unknown parameter `response_format`'],
    [500, 'Unknown parameter `response_format`'],
    [400, 'Unsupported parameter `temperature`'],
  ])('does not fallback for HTTP %s: %s', async (statusCode, message) => {
    const error = Object.assign(new Error(message), {
      statusCode,
      type: ErrorTypes.HTTP_ERROR,
    });
    const executeRequest = vi.spyOn(provider, '_executeRequest').mockRejectedValue(error);

    await expect(provider._callAI('system', 'source', { expectedFormat: ResponseFormat.JSON_OBJECT }))
      .rejects.toBe(error);

    expect(executeRequest).toHaveBeenCalledTimes(1);
  });

  it('does not fallback for STRING even when response_format appears in the error', async () => {
    const error = Object.assign(new Error('Unknown parameter `response_format`'), {
      statusCode: 400,
      type: ErrorTypes.HTTP_ERROR,
    });
    const executeRequest = vi.spyOn(provider, '_executeRequest').mockRejectedValue(error);

    await expect(provider._callAI('system', 'source', { expectedFormat: ResponseFormat.STRING }))
      .rejects.toBe(error);

    expect(executeRequest).toHaveBeenCalledTimes(1);
    expect(JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body)).not.toHaveProperty('response_format');
  });

  it('propagates fallback failure without a third capability attempt', async () => {
    const unsupported = Object.assign(new Error('Unsupported parameter: response_format'), {
      statusCode: 400,
      type: ErrorTypes.HTTP_ERROR,
    });
    const fallbackFailure = Object.assign(new Error('Server unavailable'), {
      statusCode: 503,
      type: ErrorTypes.SERVER_ERROR,
    });
    const executeRequest = vi.spyOn(provider, '_executeRequest')
      .mockRejectedValueOnce(unsupported)
      .mockRejectedValueOnce(fallbackFailure);

    await expect(provider._callAI('system', 'source', { expectedFormat: ResponseFormat.JSON_ARRAY }))
      .rejects.toBe(fallbackFailure);

    expect(executeRequest).toHaveBeenCalledTimes(2);
  });

  it('passes fallback output through structured parser validation', async () => {
    const unsupported = Object.assign(new Error('`response_format` is not supported'), {
      statusCode: 400,
      type: ErrorTypes.HTTP_ERROR,
    });
    const parseBatchResult = vi.spyOn(AIResponseParser, 'parseBatchResult');
    vi.spyOn(provider, '_executeRequest')
      .mockRejectedValueOnce(unsupported)
      .mockResolvedValue('plain text');

    try {
      const operation = createTranslationOperation('custom-response-format-fallback-parser');
      const originalBatch = [{ id: 'unit-1', text: 'source' }];
      await expect(provider._translateBatch(
        originalBatch,
        'en',
        'fa',
        'selection',
        null,
        null,
        null,
        null,
        { executionContext: { operation } },
        ResponseFormat.JSON_OBJECT,
      )).rejects.toThrow();

      expect(parseBatchResult).toHaveBeenCalledWith(
        'plain text',
        1,
        originalBatch,
        provider.providerName,
        ResponseFormat.JSON_OBJECT,
        expect.any(Object),
        undefined,
        null,
      );
    } finally {
      parseBatchResult.mockRestore();
    }
  });

  it('should detect API_ERROR wrapped in 200 OK response', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(CUSTOM_RAW_RESPONSE_FIXTURES.errorEnvelope),
      clone: function() { return this; }
    });

    await expect(provider._callAI('system', 'text'))
      .rejects.toThrow('API_ERROR: Internal Model Error');
  });

  it('should handle generic HTTP 503 Service Unavailable as SERVER_ERROR', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve({
        error: { message: 'Server is overloaded' }
      }),
      clone: function() { return this; }
    });

    try {
      await provider._callAI('system', 'text');
    } catch (error) {
       expect(error.type).toBe(ErrorTypes.SERVER_ERROR);
    }
  });

  it('records completion with null metadata for content-only responses', async () => {
    const operation = createTranslationOperation('custom-content-only');
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(CUSTOM_RAW_RESPONSE_FIXTURES.contentOnly),
      clone: function() { return this; }
    });

    const result = await provider._callAI('system', 'text', { executionContext: { operation } });
    const [record] = operation.snapshotCompletions();

    expect(result).toBe('Custom AI Result');
    expect(record).toEqual({
      provider: 'Custom',
      model: null,
      termination: CompletionTermination.UNKNOWN,
      responseId: null,
      usage: null,
    });
  });

  it('records normalized metadata from OpenAI-compatible response', async () => {
    const operation = createTranslationOperation('custom-metadata-rich');
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(CUSTOM_RAW_RESPONSE_FIXTURES.metadataRich),
      clone: function() { return this; }
    });

    const result = await provider._callAI('system', 'text', { executionContext: { operation } });
    const [record] = operation.snapshotCompletions();

    expect(result).toBe('Custom translated text');
    expect(record).toEqual({
      provider: 'Custom',
      model: 'custom-model',
      termination: CompletionTermination.NORMAL,
      responseId: 'custom-completion-1',
      usage: {
        inputTokens: 20,
        outputTokens: 10,
        reasoningTokens: 4,
        totalTokens: 30,
      },
    });
    expect(record).not.toHaveProperty('choices');
    expect(record).not.toHaveProperty('message');
    expect(record).not.toHaveProperty('content');
    expect(record).not.toHaveProperty('finish_reason');
    expect(record).not.toHaveProperty('token_count');
    expect(record).not.toHaveProperty('metadata');
  });

  it.each([
    ['TRUNCATED', CUSTOM_RAW_RESPONSE_FIXTURES.truncated, CompletionTermination.TRUNCATED],
    ['POLICY', CUSTOM_RAW_RESPONSE_FIXTURES.policy, CompletionTermination.POLICY],
    ['unknown termination', CUSTOM_RAW_RESPONSE_FIXTURES.unknownTermination, CompletionTermination.UNKNOWN],
  ])('normalizes %s termination without changing text', async (_label, fixture, termination) => {
    const operation = createTranslationOperation(`custom-${_label}`);
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

  it('preserves partial usage without deriving values', async () => {
    const operation = createTranslationOperation('custom-partial-usage');
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(CUSTOM_RAW_RESPONSE_FIXTURES.partialUsage),
      clone: function() { return this; }
    });

    await provider._callAI('system', 'text', { executionContext: { operation } });
    expect(operation.snapshotCompletions()[0].usage).toEqual({
      inputTokens: 5,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
    });
  });

  it('ignores non-standard custom metadata fields', async () => {
    const operation = createTranslationOperation('custom-ignored-metadata');
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(CUSTOM_RAW_RESPONSE_FIXTURES.customMetadata),
      clone: function() { return this; }
    });

    await provider._callAI('system', 'text', { executionContext: { operation } });
    const record = operation.snapshotCompletions()[0];

    expect(record).not.toHaveProperty('token_count');
    expect(record).not.toHaveProperty('metadata');
    expect(record.usage).toBe(null);
    expect(record.termination).toBe(CompletionTermination.NORMAL);
  });

  it('keeps missing model absent', async () => {
    const operation = createTranslationOperation('custom-model-absent');
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(CUSTOM_RAW_RESPONSE_FIXTURES.modelAbsent),
      clone: function() { return this; }
    });

    await provider._callAI('system', 'text', { executionContext: { operation } });
    expect(operation.snapshotCompletions()[0]).toMatchObject({ model: null });
  });

  it('keeps null responseId when absent', async () => {
    const operation = createTranslationOperation('custom-id-absent');
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(CUSTOM_RAW_RESPONSE_FIXTURES.idAbsent),
      clone: function() { return this; }
    });

    await provider._callAI('system', 'text', { executionContext: { operation } });
    expect(operation.snapshotCompletions()[0].responseId).toBe(null);
  });

  it('uses data.id and not request_id for responseId', async () => {
    const operation = createTranslationOperation('custom-request-id');
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(CUSTOM_RAW_RESPONSE_FIXTURES.idAndRequestId),
      clone: function() { return this; }
    });

    await provider._callAI('system', 'text', { executionContext: { operation } });
    expect(operation.snapshotCompletions()[0].responseId).toBe('custom-id');
    expect(operation.snapshotCompletions()[0]).not.toHaveProperty('request_id');
  });

  it('returns translation normally without executionContext', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(CUSTOM_RAW_RESPONSE_FIXTURES.metadataRich),
      clone: function() { return this; }
    });

    const result = await provider._callAI('system', 'text');
    expect(result).toBe('Custom translated text');
  });

  it('records two physical responses in order', async () => {
    const operation = createTranslationOperation('custom-multiple');
    proxyManager.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve({ ...CUSTOM_RAW_RESPONSE_FIXTURES.truncated, id: 'custom-1' }),
        clone: function() { return this; }
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve({ ...CUSTOM_RAW_RESPONSE_FIXTURES.metadataRich, id: 'custom-2' }),
        clone: function() { return this; }
      });

    await provider._callAI('system', 'first', { executionContext: { operation } });
    await provider._callAI('system', 'second', { executionContext: { operation } });

    expect(operation.snapshotCompletions().map(({ responseId, termination }) => ({ responseId, termination }))).toEqual([
      { responseId: 'custom-1', termination: CompletionTermination.TRUNCATED },
      { responseId: 'custom-2', termination: CompletionTermination.NORMAL },
    ]);
  });

  it('does not create a completion record for an error envelope', async () => {
    const operation = createTranslationOperation('custom-error');
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(CUSTOM_RAW_RESPONSE_FIXTURES.errorEnvelope),
      clone: function() { return this; }
    });

    await expect(provider._callAI('system', 'text', { executionContext: { operation } }))
      .rejects.toThrow('API_ERROR: Internal Model Error');
    expect(operation.snapshotCompletions()).toEqual([]);
  });

  it('does not create a completion record for a choice-less response', async () => {
    const operation = createTranslationOperation('custom-empty-choices');
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(CUSTOM_RAW_RESPONSE_FIXTURES.emptyChoices),
      clone: function() { return this; }
    });

    await expect(provider._callAI('system', 'text', { executionContext: { operation } }))
      .rejects.toThrow();
    expect(operation.snapshotCompletions()).toEqual([]);
  });

  it('does not leak raw provider fields into the completion record', async () => {
    const operation = createTranslationOperation('custom-privacy');
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(CUSTOM_RAW_RESPONSE_FIXTURES.customMetadata),
      clone: function() { return this; }
    });

    await provider._callAI('system', 'text', { executionContext: { operation } });
    const record = operation.snapshotCompletions()[0];

    expect(record).not.toHaveProperty('choices');
    expect(record).not.toHaveProperty('message');
    expect(record).not.toHaveProperty('content');
    expect(record).not.toHaveProperty('finish_reason');
    expect(record).not.toHaveProperty('token_count');
    expect(record).not.toHaveProperty('metadata');
    expect(record).not.toHaveProperty('request_id');
  });
});
