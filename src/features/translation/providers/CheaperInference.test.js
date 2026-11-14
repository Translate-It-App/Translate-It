import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CheaperInferenceProvider } from './CheaperInference.js';
import { proxyManager } from '@/shared/proxy/ProxyManager.js';
import { TranslationCallPurpose } from './ProviderConstants.js';
import { AIConversationHelper } from './utils/AIConversationHelper.js';
import { CompletionTermination } from '@/features/translation/ir/CompletionContract.js';
import { createTranslationOperation } from '@/features/translation/ir/TranslationOperation.js';
import { CONFIG, getCheaperInferenceApiModelAsync } from '@/shared/config/config.js';
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
    getCheaperInferenceApiKeysAsync: vi.fn().mockResolvedValue(['test-key']),
    getCheaperInferenceApiModelAsync: vi.fn().mockResolvedValue('gpt-5.4-mini'),
  };
});

vi.mock('@/shared/proxy/ProxySettings.js', () => ({
  getProxySettingsAsync: vi.fn().mockResolvedValue({}),
  resolveProxyConfig: vi.fn().mockResolvedValue({})
}));

const CHEAPERINFERENCE_RAW_RESPONSE_FIXTURES = Object.freeze({
  metadataRichResponse: Object.freeze({
    id: 'gen-cheaperinference-1',
    model: 'nvidia/test-model',
    provider: 'Nvidia',
    choices: [{
      finish_reason: 'stop',
      native_finish_reason: 'stop',
      message: { content: 'Cheaper Inference Metadata Result' },
    }],
    usage: {
      prompt_tokens: 1017,
      completion_tokens: 318,
      total_tokens: 9195,
      completion_tokens_details: { reasoning_tokens: 7860 },
    },
    system_fingerprint: 'ignored-fingerprint',
    service_tier: 'ignored-tier',
    cost: 0.1,
    cost_details: { ignored: true },
    is_byok: true,
    object: 'chat.completion',
    created: 123,
  }),
  metadataAbsentResponse: Object.freeze({
    choices: [{
      finish_reason: 'stop',
      message: { content: 'Cheaper Inference Minimal Result' },
    }],
  }),
  unknownTerminationResponse: Object.freeze({
    choices: [{
      finish_reason: 'repository_test_unknown',
      message: { content: 'Cheaper Inference Unknown Result' },
    }],
  }),
  objectResponse: Object.freeze({
    choices: [{ message: { content: 'Cheaper Inference Result' } }],
  }),
  stringifiedResponse: JSON.stringify({
    choices: [{ message: { content: 'Cheaper Inference String Result' } }],
  }),
  errorEnvelope: Object.freeze({
    error: { message: 'Provider timeout', metadata: { raw: 'Gateway Timeout' } },
  }),
  singleFieldErrorEnvelope: Object.freeze({
    error: { message: 'Model not found' },
  }),
});

describe('CheaperInferenceProvider Error Handling', () => {
  let provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CheaperInferenceProvider();
  });

  it('should handle successful translation', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(CHEAPERINFERENCE_RAW_RESPONSE_FIXTURES.objectResponse),
      clone: function() { return this; }
    });

    const result = await provider._callAI('system', 'Hello World');
    expect(result).toBe('Cheaper Inference Result');
  });

  it.each(['gpt-5.4-mini', 'claude-haiku-4-5'])('preserves curated model payload for %s', async (model) => {
    getCheaperInferenceApiModelAsync.mockResolvedValue(model);
    const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

    await provider._callAI('system', 'source', { expectedFormat: ResponseFormat.JSON_OBJECT });

    const payload = JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body);
    expect(executeRequest.mock.calls[0][0].url).toBe(CONFIG.CHEAPERINFERENCE_API_URL);
    expect(payload).toMatchObject({
      model,
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'source' }
      ],
      max_tokens: 4096,
      response_format: { type: 'json_object' }
    });
  });

  it('sends json_object response format for JSON_ARRAY', async () => {
    const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

    await provider._callAI('system', 'source', { expectedFormat: ResponseFormat.JSON_ARRAY });

    const payload = JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body);
    expect(payload.response_format).toEqual({ type: 'json_object' });
  });

  it('omits response format for STRING calls', async () => {
    const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

    await provider._callAI('system', 'source', { expectedFormat: ResponseFormat.STRING });

    const payload = JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body);
    expect(payload).not.toHaveProperty('response_format');
  });

  it('uses CONFIG default for missing text model selection', async () => {
    getCheaperInferenceApiModelAsync.mockResolvedValue(undefined);
    const executeRequest = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');

    await provider._callAI('system', 'source');

    const payload = JSON.parse(executeRequest.mock.calls[0][0].fetchOptions.body);
    expect(payload.model).toBe(CONFIG.CHEAPERINFERENCE_API_MODEL);
  });

  it('records normalized completion metadata from the confirmed response shape', async () => {
    const operation = createTranslationOperation('cheaperinference-completion');
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(CHEAPERINFERENCE_RAW_RESPONSE_FIXTURES.metadataRichResponse),
      clone: function() { return this; }
    });

    const result = await provider._callAI('system', 'text', { executionContext: { operation } });
    const [record] = operation.snapshotCompletions();

    expect(result).toBe('Cheaper Inference Metadata Result');
    expect(record).toEqual({
      provider: 'CheaperInference',
      model: 'nvidia/test-model',
      termination: CompletionTermination.NORMAL,
      responseId: 'gen-cheaperinference-1',
      usage: {
        inputTokens: 1017,
        outputTokens: 318,
        reasoningTokens: 7860,
        totalTokens: 9195,
      },
    });
    expect(record).not.toHaveProperty('native_finish_reason');
    expect(record.provider).not.toBe('Nvidia');
    expect(record).not.toHaveProperty('system_fingerprint');
    expect(record).not.toHaveProperty('service_tier');
    expect(record).not.toHaveProperty('cost');
    expect(record).not.toHaveProperty('cost_details');
    expect(record).not.toHaveProperty('is_byok');
    expect(record).not.toHaveProperty('object');
    expect(record).not.toHaveProperty('created');
  });

  it('records absent optional metadata as null without changing text extraction', async () => {
    const operation = createTranslationOperation('cheaperinference-missing-metadata');
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(CHEAPERINFERENCE_RAW_RESPONSE_FIXTURES.metadataAbsentResponse),
      clone: function() { return this; }
    });

    const result = await provider._callAI('system', 'text', { executionContext: { operation } });
    const [record] = operation.snapshotCompletions();

    expect(result).toBe('Cheaper Inference Minimal Result');
    expect(record.model).toBeNull();
    expect(record.responseId).toBeNull();
    expect(record.usage).toBeNull();
    expect(record.termination).toBe(CompletionTermination.NORMAL);
  });

  it('normalizes an unrecognized finish reason to UNKNOWN', async () => {
    const operation = createTranslationOperation('cheaperinference-unknown-termination');
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(CHEAPERINFERENCE_RAW_RESPONSE_FIXTURES.unknownTerminationResponse),
      clone: function() { return this; }
    });

    await expect(provider._callAI('system', 'text', { executionContext: { operation } }))
      .resolves.toBe('Cheaper Inference Unknown Result');
    expect(operation.snapshotCompletions()[0].termination).toBe(CompletionTermination.UNKNOWN);
  });

  it('is safe without execution context', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(CHEAPERINFERENCE_RAW_RESPONSE_FIXTURES.metadataRichResponse),
      clone: function() { return this; }
    });

    await expect(provider._callAI('system', 'text')).resolves.toBe('Cheaper Inference Metadata Result');
  });

  it('records one ordered completion per physical response', async () => {
    const operation = createTranslationOperation('cheaperinference-multiple');
    const first = { ...CHEAPERINFERENCE_RAW_RESPONSE_FIXTURES.metadataRichResponse, id: 'response-1' };
    const second = { ...CHEAPERINFERENCE_RAW_RESPONSE_FIXTURES.metadataRichResponse, id: 'response-2' };
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

    expect(operation.snapshotCompletions().map(({ responseId }) => responseId)).toEqual([
      'response-1',
      'response-2',
    ]);
  });

  it('extracts the currently supported stringified response shape', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(CHEAPERINFERENCE_RAW_RESPONSE_FIXTURES.stringifiedResponse),
      clone: function() { return this; }
    });

    await expect(provider._callAI('system', 'Hello World')).resolves.toBe('Cheaper Inference String Result');
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
    const claim = vi.spyOn(AIConversationHelper, 'claimNextTurn').mockResolvedValue(1);
    const messages = vi.spyOn(AIConversationHelper, 'getConversationMessages').mockResolvedValue({ messages: [{ role: 'system', content: 'system prompt' }, { role: 'user', content: 'current recovery segment' }], session: null });
    const update = vi.spyOn(AIConversationHelper, 'updateSessionHistory').mockResolvedValue();
    const execute = vi.spyOn(provider, '_executeRequest').mockResolvedValue('translated');
    try {
      const result = await provider._callAI('system prompt', 'current recovery segment', { sessionId: 'session-1', mode: 'select-element', callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY });
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
      claim.mockRestore(); messages.mockRestore(); update.mockRestore(); execute.mockRestore();
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
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(CHEAPERINFERENCE_RAW_RESPONSE_FIXTURES.errorEnvelope),
      clone: function() { return this; }
    });

    await expect(provider._callAI('system', 'text'))
      .rejects.toThrow('API_ERROR: Provider timeout');
  });

  it('should detect error when it is the only field', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve(CHEAPERINFERENCE_RAW_RESPONSE_FIXTURES.singleFieldErrorEnvelope),
      clone: function() { return this; }
    });

    await expect(provider._callAI('system', 'text'))
      .rejects.toThrow('API_ERROR: Model not found');
  });
});
