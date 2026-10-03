import { describe, it, expect, vi, beforeEach } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debugLazy: vi.fn(),
  init: vi.fn(),
  operation: vi.fn(),
  performance: vi.fn(),
}));

// 1. Mock minimal dependencies
vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: { getBrowserInfo: vi.fn(), getManifest: () => ({ version: '1.0.0' }) },
    storage: { local: { get: vi.fn(), set: vi.fn() } }
  }
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => loggerMock
}));

// Mock StatsManager early
vi.mock('../core/TranslationStatsManager.js', () => ({
  statsManager: { recordError: vi.fn() }
}));

// Mock ErrorMatcher
vi.mock('@/shared/error-management/ErrorMatcher.js', () => ({
  matchErrorToType: vi.fn(),
  isFatalError: vi.fn(),
  isTransientError: vi.fn(),
  isCancellationError: vi.fn()
}));

import { BaseAIProvider } from './BaseAIProvider.js';
import { ResponseFormat } from '@/shared/config/translationConstants.js';
import { TranslationMode } from '@/shared/config/config.js';
import { isCancellationError, isFatalError, isTransientError, matchErrorToType } from '@/shared/error-management/ErrorMatcher.js';
import { createTranslationOperation, recordProviderCompletion } from '../ir/TranslationOperation.js';
import { createCompletionRecord, CompletionTermination } from '../ir/CompletionContract.js';
import { TranslationCallPurpose } from './ProviderConstants.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { translationSessionManager } from '../core/TranslationSessionManager.js';
import { AIResponseParser } from './utils/AIResponseParser.js';
import { AIStreamManager } from './utils/AIStreamManager.js';

// Mock AIResponseParser
vi.mock("./utils/AIResponseParser.js", () => ({
  AIResponseParser: {
    parseBatchResult: vi.fn((res) => ({ results: res, contractViolation: false })),
    cleanAIResponse: vi.fn((res) => res)
  }
}));

// 4. Concrete implementation for testing
class MockAIProvider extends BaseAIProvider {
  constructor() {
    super('MockAI');
  }
  
  // Override abstract or problematic methods
  async getSupportsStreaming() { return false; }
  async getBatchStrategy() { return 'smart'; }
  async _executeWithRateLimit(task) { return await task({}); }
  async _callAI() { return "Mock Response"; }
  
  // Manual override for prompt preparation to avoid helper dependency
  async _preparePromptAndText(texts) {
    return { systemPrompt: 'Sys', userText: JSON.stringify(texts) };
  }
}

function createGate() {
  const holders = [];
  return {
    defer() {
      return new Promise((resolve) => holders.push(resolve));
    },
    release() {
      holders.splice(0).forEach((resolve) => resolve());
    },
  };
}

describe('BaseAIProvider', () => {
  let provider;

beforeEach(() => {
  vi.clearAllMocks();
  AIResponseParser.parseBatchResult.mockReset().mockImplementation((res) => ({ results: res, contractViolation: false }));
  provider = new MockAIProvider();
    vi.mocked(isFatalError).mockReturnValue(false);
    vi.mocked(isTransientError).mockReturnValue(false);
    vi.mocked(matchErrorToType).mockReturnValue('UNKNOWN');
    vi.mocked(isCancellationError).mockReturnValue(false);
    translationSessionManager.sessions.clear();
  });

  describe('explicit batch execution APIs', () => {
    it('gives concurrent physical AI calls distinct metadata slots', async () => {
      const operation = createTranslationOperation('ai-slots');
      const refs = [];
      provider._callAI = vi.fn().mockImplementation(async (_system, userText, options) => {
        refs.push(options.providerMetadataRef);
        options.providerMetadataRef.metadata.detectedLanguage = userText.includes('first') ? 'en' : 'de';
        await Promise.resolve();
        return userText;
      });

      await Promise.all([
        provider._translateBatch(['first'], 'en', 'fa', 'selection', null, null, null, null, { executionContext: { operation } }),
        provider._translateBatch(['second'], 'en', 'fa', 'selection', null, null, null, null, { executionContext: { operation } }),
      ]);

      expect(refs[0]).not.toBe(refs[1]);
      expect(operation.snapshotProviderExecutionMetadata().map(({ metadata }) => metadata.detectedLanguage).sort())
        .toEqual(['de', 'en']);
    });

    it('does not publish metadata from failed physical AI calls', async () => {
      const operation = createTranslationOperation('ai-failure');
      provider._callAI = vi.fn().mockImplementation(async (_system, _text, options) => {
        options.providerMetadataRef.metadata.request = 'failed';
        throw new Error('physical failure');
      });

      await expect(provider._translateBatch(['source'], 'en', 'fa', 'selection', null, null, null, null, { executionContext: { operation } }))
        .rejects.toThrow('physical failure');

      expect(operation.snapshotProviderExecutionMetadata()).toEqual([]);
    });

    it('discards failed attempt metadata before a successful AI retry', async () => {
      const operation = createTranslationOperation('ai-retry-isolation');
      const refs = [];
      let attempt = 0;
      provider._callAI = vi.fn().mockImplementation(async (_system, _text, options) => {
        refs.push(options.providerMetadataRef);
        attempt++;
        if (attempt === 1) {
          options.providerMetadataRef.metadata.detectedLanguage = 'de';
          throw new Error('first attempt failed');
        }
        return 'response';
      });
      provider._executeWithRateLimit = vi.fn(async (task) => {
        await task({ attempt: 1 }).catch(() => {});
        return task({ attempt: 2 });
      });

      await provider._translateBatch(['source'], 'en', 'fa', 'selection', null, null, null, null, {
        executionContext: { operation },
      });

      expect(refs[0]).toBe(refs[1]);
      expect(operation.snapshotProviderExecutionMetadata()).toEqual([]);
      expect(operation.snapshotAggregatedProviderMetadata()).toEqual({});
    });

    it('does not publish metadata when structured parsing fails after provider success', async () => {
      const operation = createTranslationOperation('ai-parse-failure');
      provider._callAI = vi.fn().mockImplementation(async (_system, _text, options) => {
        options.providerMetadataRef.metadata.detectedLanguage = 'en';
        return 'response';
      });
      AIResponseParser.parseBatchResult.mockImplementationOnce(() => {
        throw new Error('parse failure');
      });

      await expect(provider._translateBatch(['source'], 'en', 'fa', 'selection', null, null, null, null, {
        executionContext: { operation },
      })).rejects.toThrow('parse failure');

      expect(operation.snapshotProviderExecutionMetadata()).toEqual([]);
    });

    it('publishes one metadata record after successful AI validation', async () => {
      const operation = createTranslationOperation('ai-success');
      provider._callAI = vi.fn().mockImplementation(async (_system, _text, options) => {
        options.providerMetadataRef.metadata.detectedLanguage = ' EN ';
        return 'response';
      });

      await provider._translateBatch(['source'], 'en', 'fa', 'selection', null, null, null, null, {
        executionContext: { operation },
      });

      expect(operation.snapshotProviderExecutionMetadata()).toEqual([
        { callPurpose: TranslationCallPurpose.PRIMARY_TRANSLATION, metadata: { detectedLanguage: ' EN ' } },
      ]);
    });

    it('keeps recovery metadata separate from primary metadata', async () => {
      const operation = createTranslationOperation('ai-recovery-slots');
      provider._callAI = vi.fn().mockImplementation(async (_system, _text, options) => {
        options.providerMetadataRef.metadata.request = options.callPurpose;
        return 'response';
      });

      await provider._translateBatch(['primary'], 'en', 'fa', 'selection', null, null, null, null, {
        executionContext: { operation },
        callPurpose: TranslationCallPurpose.PRIMARY_TRANSLATION,
      });
      await provider._translateBatch(['recovery'], 'en', 'fa', 'selection', null, null, null, null, {
        executionContext: { operation },
        callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
      });

      expect(operation.snapshotProviderExecutionMetadata()).toEqual([
        { callPurpose: TranslationCallPurpose.PRIMARY_TRANSLATION, metadata: { request: TranslationCallPurpose.PRIMARY_TRANSLATION } },
        { callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY, metadata: { request: TranslationCallPurpose.STRUCTURED_RECOVERY } },
      ]);
    });

    it('executeStructuredBatch returns raw primary response unchanged', async () => {
      provider._callAI = vi.fn().mockResolvedValue('raw structured response');

      const result = await provider.executeStructuredBatch(['source'], 'en', 'fa', {
        translateMode: 'selection',
        expectedFormat: ResponseFormat.JSON_ARRAY,
      });

      expect(result).toBe('raw structured response');
      expect(provider._callAI).toHaveBeenCalledWith('Sys', expect.any(String), expect.objectContaining({
        callPurpose: TranslationCallPurpose.PRIMARY_TRANSLATION,
      }));
    });

    it.each(['short', 'a much longer source string'])('uses the pre-transformation source length for non-batch accounting (%s)', async (source) => {
      provider._preparePromptAndText = vi.fn().mockResolvedValue({
        systemPrompt: 'Sys',
        userText: `<compatibility-wrapper>${source}</compatibility-wrapper>`,
      });
      provider._callAI = vi.fn().mockResolvedValue('translated');

      await provider.executeSequentialBatch([source], 'en', 'fa', {
        translateMode: 'selection',
        expectedFormat: ResponseFormat.STRING,
      });

      expect(provider._callAI.mock.calls[0][2].originalCharCount).toBe(source.length);
      expect(provider._callAI.mock.calls[0][1].length).toBeGreaterThan(source.length);
    });

    it.each([
      ['customized Popup', TranslationMode.Popup_Translate, 'getPromptPopupTranslateAsync', '<popup>$_{TEXT}</popup>'],
      ['customized Field', TranslationMode.Field, 'getPromptBASEFieldAsync', '<field>$_{TEXT}</field>'],
      ['customized Selection', TranslationMode.Selection, 'getPromptBASEFieldAsync', '<selection>$_{TEXT}</selection>'],
      ['customized Dictionary', TranslationMode.Dictionary_Translation, 'getPromptDictionaryAsync', '<dictionary>$_{TEXT}</dictionary>'],
      ['scalar structured recovery using Field', TranslationMode.Select_Element, 'getPromptBASEFieldAsync', '<field>$_{TEXT}</field>', true],
      ['default Popup', TranslationMode.Popup_Translate, 'getPromptPopupTranslateAsync', null],
    ])('forwards preparation-owned source length through JSON-strategy %s', async (_label, mode, getterName, template, isRecovery = false) => {
      const config = await import('@/shared/config/config.js');
      const source = 'the exact original source';
      const getterSpy = vi.spyOn(config, getterName).mockResolvedValue(
        template || config.CONFIG.PROMPT_BASE_POPUP_TRANSLATE,
      );
      const dictionarySpy = vi.spyOn(config, 'getEnableDictionaryAsync').mockResolvedValue(true);
      provider._preparePromptAndText = BaseAIProvider.prototype._preparePromptAndText.bind(provider);
      provider._callAI = vi.fn().mockResolvedValue('translated');

      try {
        await provider._translateBatch([source], 'en', 'fa', mode, null, null, null, null,
          isRecovery ? { callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY } : {},
          isRecovery ? ResponseFormat.STRING : undefined);

        const [, userText, options] = provider._callAI.mock.calls[0];
        expect(options).toMatchObject({ isBatch: true, originalCharCount: source.length });
        if (template) {
          expect(userText).not.toBe(source);
          expect(userText.length).not.toBe(source.length);
        } else {
          expect(userText).toBe(source);
        }
      } finally {
        getterSpy.mockRestore();
        dictionarySpy.mockRestore();
      }
    });

    it('leaves structured Select Element batch accounting on the existing payload path', async () => {
      const config = await import('@/shared/config/config.js');
      const batchPrompt = vi.spyOn(config, 'getPromptBASEAIBatchAsync')
        .mockResolvedValue('structured $_{PROMPT_INSTRUCTIONS} $_{TEXT}');
      provider._preparePromptAndText = BaseAIProvider.prototype._preparePromptAndText.bind(provider);
      provider._callAI = vi.fn().mockResolvedValue('structured');

      try {
        await provider._translateBatch(['source', 'another source'], 'en', 'fa', TranslationMode.Select_Element);

        const [, , options] = provider._callAI.mock.calls[0];
        expect(options.isBatch).toBe(true);
        expect(options).not.toHaveProperty('originalCharCount');
      } finally {
        batchPrompt.mockRestore();
      }
    });

    it('executeSequentialBatch preserves scalar and array transport results with supplied purpose', async () => {
      provider._callAI = vi.fn()
        .mockResolvedValueOnce('one')
        .mockResolvedValueOnce('two')
        .mockResolvedValueOnce('three');

      await expect(provider.executeSequentialBatch(['one'], 'en', 'fa', {
        translateMode: 'selection',
        callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
      })).resolves.toBe('one');
      await expect(provider.executeSequentialBatch(['two', 'three'], 'en', 'fa', {
        translateMode: 'selection',
        callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
      })).resolves.toEqual(['two', 'three']);
      expect(provider._callAI.mock.calls.map(([, , options]) => options.callPurpose)).toEqual([
        TranslationCallPurpose.STRUCTURED_RECOVERY,
        TranslationCallPurpose.STRUCTURED_RECOVERY,
        TranslationCallPurpose.STRUCTURED_RECOVERY,
      ]);
    });

    describe('STRING output contract', () => {
      const runSequential = (source, response, options = {}) => {
        provider._callAI = vi.fn().mockResolvedValue(response);
        return provider.executeSequentialBatch([source], 'en', 'fa', {
          translateMode: 'selection',
          expectedFormat: ResponseFormat.STRING,
          ...options,
        });
      };

      it.each([null, undefined, 0, 42, false, true, {}, { text: 'translation' }, [], ['translation']])(
        'rejects native non-string response %p',
        async (response) => {
          await expect(runSequential('source', response))
            .rejects.toMatchObject({ type: ErrorTypes.API_RESPONSE_INVALID });
        },
      );

      it.each(['', '   ', '\n\t'])('rejects blank response %j for nonblank source', async (response) => {
        await expect(runSequential('source', response))
          .rejects.toMatchObject({ type: ErrorTypes.API_RESPONSE_INVALID });
      });

      it.each(['42', 'true', 'null', 'translation'])('accepts valid STRING response %j', async (response) => {
        await expect(runSequential('source', response)).resolves.toBe(response);
      });

      it('accepts identity translation', async () => {
        await expect(runSequential('URL', 'URL')).resolves.toBe('URL');
      });

      it('preserves blank-source blank-output compatibility', async () => {
        await expect(runSequential('', '')).resolves.toBe('');
      });

      it('rejects malformed sequential strategy output before coordinator normalization', async () => {
        provider.getBatchStrategy = vi.fn().mockResolvedValue('sequential');
        provider._callAI = vi.fn().mockResolvedValue(42);

        await expect(provider._batchTranslate(
          ['source'],
          'en',
          'fa',
          'selection',
          null,
          null,
          null,
          null,
          null,
          ResponseFormat.STRING,
        )).rejects.toMatchObject({ type: ErrorTypes.API_RESPONSE_INVALID });
      });

      it('rejects malformed scalar structured recovery output at the same boundary', async () => {
        await expect(runSequential('source', { text: 'translation' }, {
          callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
        })).rejects.toMatchObject({ type: ErrorTypes.API_RESPONSE_INVALID });
      });
    });

    it('unwraps object sources before structured recovery sequential translation', async () => {
      const sequential = vi.spyOn(provider, '_traditionalBatchTranslate').mockResolvedValue(['The']);

      await provider.executeSequentialBatch([{ i: 'parent-1-0', text: 'The' }], 'en', 'fa', {
        translateMode: 'select-element',
        expectedFormat: ResponseFormat.STRING,
        callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
      });

      expect(sequential).toHaveBeenCalledWith(
        ['The'],
        'en', 'fa', 'select-element', undefined, undefined, undefined, undefined, undefined,
        ResponseFormat.STRING,
        expect.objectContaining({ callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY }),
      );
    });

    it('passes scalar userText to _callAI through the real structured recovery prompt path', async () => {
      provider._preparePromptAndText = BaseAIProvider.prototype._preparePromptAndText.bind(provider);
      provider._callAI = vi.fn().mockResolvedValue('The');

      await provider.executeSequentialBatch(['The'], 'en', 'fa', {
        translateMode: 'select-element',
        expectedFormat: ResponseFormat.STRING,
        callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
      });

      const [, userText, options] = provider._callAI.mock.calls[0];
      expect(userText).toContain('The');
      expect(userText).not.toContain('translations');
      expect(userText).not.toContain('"id":"0"');
      expect(options).toMatchObject({
        expectedFormat: ResponseFormat.STRING,
        callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
        conversationParticipates: false,
        useParentConversationLifecycle: false,
      });
    });

    it('overrides inherited parent metadata for the nested physical recovery call', async () => {
      provider._preparePromptAndText = BaseAIProvider.prototype._preparePromptAndText.bind(provider);
      provider._callAI = vi.fn().mockResolvedValue('The');
      const promptSpy = vi.spyOn(provider, '_preparePromptAndText');

      await provider.executeSequentialBatch(['The'], 'en', 'fa', {
        translateMode: 'select-element',
        expectedFormat: ResponseFormat.STRING,
        contextMetadata: {
          callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
          expectedFormat: ResponseFormat.STRING,
          contextMetadata: {
            callPurpose: TranslationCallPurpose.PARENT_RECOVERY,
            expectedFormat: ResponseFormat.JSON_OBJECT,
            conversationParticipates: false,
            useParentConversationLifecycle: false,
            semanticHint: { role: 'content' },
          },
        },
        callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
      });

      const [, userText, options] = provider._callAI.mock.calls[0];
      const promptMetadata = promptSpy.mock.calls[0][4];
      expect(userText).toBe('The');
      expect(promptMetadata).toMatchObject({
        callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
        expectedFormat: ResponseFormat.STRING,
        conversationParticipates: false,
        useParentConversationLifecycle: false,
      });
      expect(promptMetadata.semanticHint).toEqual({ role: 'content' });
      expect(promptMetadata.contextMetadata).toBeUndefined();
      expect(options).toMatchObject({
        callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
        expectedFormat: ResponseFormat.STRING,
        conversationParticipates: false,
        useParentConversationLifecycle: false,
      });
      expect(options.callPurpose).not.toBe(TranslationCallPurpose.PARENT_RECOVERY);
      expect(options.expectedFormat).not.toBe(ResponseFormat.JSON_OBJECT);
    });
  });

  describe('streaming terminal errors', () => {
    it('leaves terminal error publication to the service after a provider batch failure', async () => {
      const messageId = 'ai-stream-failure';
      const engine = { isCancelled: vi.fn().mockReturnValue(false) };
      const error = Object.assign(new Error('Provider failed'), {
        type: 'PROVIDER_ERROR',
      });
      const activeSpy = vi.spyOn(AIStreamManager, 'isStreamActive').mockReturnValue(true);
      const updateSpy = vi.spyOn(AIStreamManager, 'streamErrorResults').mockResolvedValue(undefined);
      const batchingSpy = vi.spyOn(provider, 'getBatchingConfig').mockResolvedValue({
        strategy: 'single',
        optimalSize: 10,
        maxComplexity: 100,
      });
      const batchSpy = vi.spyOn(provider, '_translateBatch').mockRejectedValue(error);

      try {
        await expect(provider._streamingBatchTranslate(
          ['source'], 'en', 'fa', 'selection', engine, messageId,
          null, null, null, ResponseFormat.JSON_OBJECT
        )).rejects.toBe(error);

        expect(updateSpy).toHaveBeenCalledWith('MockAI', error, 0, messageId, engine);
        expect(batchSpy).toHaveBeenCalledTimes(1);
      } finally {
        activeSpy.mockRestore();
        updateSpy.mockRestore();
        batchingSpy.mockRestore();
        batchSpy.mockRestore();
      }
    });

    it.each([
      ['cancellation', Object.assign(new Error('cancelled'), { type: ErrorTypes.USER_CANCELLED }), true],
      ['timeout', Object.assign(new Error('timed out'), { type: ErrorTypes.TRANSLATION_TIMEOUT }), false],
    ])('does not emit a provider terminal error for %s', async (_name, error, isCancellation) => {
      const messageId = `ai-stream-${_name}`;
      const engine = { isCancelled: vi.fn().mockReturnValue(false) };
      const activeSpy = vi.spyOn(AIStreamManager, 'isStreamActive').mockReturnValue(true);
      const updateSpy = vi.spyOn(AIStreamManager, 'streamErrorResults').mockResolvedValue(undefined);
      const batchingSpy = vi.spyOn(provider, 'getBatchingConfig').mockResolvedValue({
        strategy: 'single',
        optimalSize: 10,
        maxComplexity: 100,
      });
      const batchSpy = vi.spyOn(provider, '_translateBatch').mockRejectedValue(error);
      vi.mocked(isCancellationError).mockReturnValue(isCancellation);

      try {
        await expect(provider._streamingBatchTranslate(
          ['source'], 'en', 'fa', 'selection', engine, messageId,
          null, null, null, ResponseFormat.JSON_OBJECT
        )).rejects.toBe(error);

        expect(updateSpy).toHaveBeenCalledTimes(1);
        expect(batchSpy).toHaveBeenCalledTimes(1);
      } finally {
        activeSpy.mockRestore();
        updateSpy.mockRestore();
        batchingSpy.mockRestore();
        batchSpy.mockRestore();
      }
    });

    it('does not classify an internally aborted streaming batch as USER_CANCELLED', async () => {
      const abortController = new AbortController();
      abortController.abort();
      const engine = { isCancelled: vi.fn().mockReturnValue(false) };
      const activeSpy = vi.spyOn(AIStreamManager, 'isStreamActive').mockReturnValue(true);
      const batchingSpy = vi.spyOn(provider, 'getBatchingConfig').mockResolvedValue({
        characterLimit: 5000,
        optimalSize: 10,
      });

      try {
        await expect(provider._streamingBatchTranslate(
          ['source'], 'en', 'fa', 'selection', engine, 'internal-stream-abort',
          abortController, null, null, ResponseFormat.JSON_OBJECT
        )).rejects.toMatchObject({ operationAborted: true, cancellationReason: 'operation-abort' });
      } finally {
        activeSpy.mockRestore();
        batchingSpy.mockRestore();
      }
    });

    it('treats a cancellation tombstone without signal abort as internal operation abort', async () => {
      const abortController = new AbortController();
      const engine = { isCancelled: vi.fn().mockReturnValue(true) };
      const activeSpy = vi.spyOn(AIStreamManager, 'isStreamActive').mockReturnValue(true);
      const batchingSpy = vi.spyOn(provider, 'getBatchingConfig').mockResolvedValue({
        characterLimit: 5000,
        optimalSize: 10,
      });

      try {
        const error = await provider._streamingBatchTranslate(
          ['source'], 'en', 'fa', 'selection', engine, 'tombstone-stream-stop',
          abortController, null, null, ResponseFormat.JSON_OBJECT
        ).catch((caughtError) => caughtError);
        expect(error).toMatchObject({
          operationAborted: true,
          cancellationReason: 'operation-abort',
        });
        expect(error.type).not.toBe(ErrorTypes.USER_CANCELLED);
        expect(abortController.signal.aborted).toBe(false);
      } finally {
        activeSpy.mockRestore();
        batchingSpy.mockRestore();
      }
    });
  });

  describe('_translateBatch', () => {
    it('accepts the normalized WebAI structured response without recovery', async () => {
      const { AIResponseParser: realParser } = await vi.importActual('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult.mockImplementation(realParser.parseBatchResult.bind(realParser));
      provider._callAI = vi.fn().mockResolvedValue(
        JSON.parse('{"response":"{\\"translations\\":[{\\"id\\":\\"0\\",\\"text\\":\\"AA\\"},{\\"id\\":\\"1\\",\\"text\\":\\"BB\\"}]}"}').response
      );
      const recovery = vi.spyOn(provider, 'executeSequentialBatch');

      const result = await provider._translateBatch(
        ['A', 'B'], 'en', 'fa', 'select-element', null, null, null, null, null, ResponseFormat.JSON_OBJECT
      );

      expect(result).toEqual(['AA', 'BB']);
      expect(recovery).not.toHaveBeenCalled();
    });

    it('does not recover for harmless complete surplus output', async () => {
      const { AIResponseParser: realParser } = await vi.importActual('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult.mockImplementation(realParser.parseBatchResult.bind(realParser));
      provider._callAI = vi.fn().mockResolvedValue(
        '[{"id":"0","text":"AA"},{"id":"1","text":"BB"},{"id":"99","text":"unused"}]'
      );
      const recovery = vi.spyOn(provider, 'executeSequentialBatch');

      const result = await provider._translateBatch(
        ['A', 'B'], 'en', 'fa', 'select-element', null, null, null, null, null, ResponseFormat.JSON_OBJECT
      );

      expect(result).toEqual(['AA', 'BB']);
      expect(recovery).not.toHaveBeenCalled();
    });

    it('should throw on non-fatal AND non-transient error instead of returning original text', async () => {
      provider._callAI = vi.fn().mockRejectedValue(new Error('Non-Fatal-Non-Transient'));
      vi.mocked(isFatalError).mockReturnValue(false);
      vi.mocked(isTransientError).mockReturnValue(false);

      const texts = ['Original 1', 'Original 2'];
      await expect(provider._translateBatch(texts, 'en', 'fa', 'selection', null, null, null, 'session-123'))
        .rejects.toThrow('Non-Fatal-Non-Transient');
    });

    it('should throw and NOT fallback if error is transient', async () => {
      provider._callAI = vi.fn().mockRejectedValue(new Error('Transient Error'));
      vi.mocked(isFatalError).mockReturnValue(false);
      vi.mocked(isTransientError).mockReturnValue(true);

      const texts = ['Original 1'];
      await expect(provider._translateBatch(texts, 'en', 'fa', 'selection'))
        .rejects.toThrow('Transient Error');
    });

    it('should throw immediately if error is fatal', async () => {
      provider._callAI = vi.fn().mockRejectedValue(new Error('FATAL 401'));
      vi.mocked(isFatalError).mockReturnValue(true);

      await expect(provider._translateBatch(['test'], 'en', 'fa', 'selection'))
        .rejects.toThrow('FATAL 401');
    });

    it('should not record a TranslationStatsManager error from the batch boundary (ownership: transport only)', async () => {
      const { statsManager } = await import('../core/TranslationStatsManager.js');
      provider._callAI = vi.fn().mockRejectedValue(new Error('Transport Failure'));

      await expect(provider._translateBatch(['seg1'], 'en', 'fa', 'selection', null, null, null, 'session-1'))
        .rejects.toThrow('Transport Failure');

      await new Promise(resolve => setTimeout(resolve, 0));
      expect(statsManager.recordError).not.toHaveBeenCalled();
    });

    it('should call _callAI with correct parameters', async () => {
      const spy = vi.spyOn(provider, '_callAI');
      const texts = ['Hello'];
      
      await provider._translateBatch(texts, 'en', 'fa', 'selection');

      expect(spy).toHaveBeenCalled();
      const userText = spy.mock.calls[0][1];
      expect(userText).toContain('Hello');
    });

    it('should return parsed results without recovery when contract is honored', async () => {
      const { AIResponseParser } = await import("./utils/AIResponseParser.js");
      AIResponseParser.parseBatchResult.mockReturnValue({ results: ['R1', 'R2'], contractViolation: false });
      const fallbackSpy = vi.spyOn(provider, '_traditionalBatchTranslate').mockResolvedValue(['F1', 'F2']);

      const texts = ['seg1', 'seg2'];
      const result = await provider._translateBatch(texts, 'en', 'fa', 'selection', null, null, null, 'session-1');

      expect(result).toEqual(['R1', 'R2']);
      expect(fallbackSpy).not.toHaveBeenCalled();
    });

    it('should mark structured calls as primary translation', async () => {
      const { AIResponseParser } = await import("./utils/AIResponseParser.js");
      AIResponseParser.parseBatchResult.mockReturnValue({ results: ['R1'], contractViolation: false });
      const callSpy = vi.spyOn(provider, '_callAI');

      await provider._translateBatch(['seg1'], 'en', 'fa', 'selection');

      expect(callSpy.mock.calls[0][2].callPurpose).toBe(TranslationCallPurpose.PRIMARY_TRANSLATION);
    });

    it('forces parent recovery to remain non-conversational despite caller metadata', async () => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult.mockReturnValue({ results: ['R1'], contractViolation: false });
      const callSpy = vi.spyOn(provider, '_callAI');
      const history = vi.spyOn((await import('./utils/AIConversationHelper.js')).AIConversationHelper, 'getConversationHistory');
      const session = translationSessionManager.getOrCreateSession('parent-recovery-session', 'MockAI');

      await provider._translateBatch(['source'], 'en', 'fa', 'select-element', null, null, 'm', session.id, {
        callPurpose: TranslationCallPurpose.PARENT_RECOVERY,
        conversationParticipates: true,
      }, ResponseFormat.JSON_ARRAY);

      expect(callSpy.mock.calls[0][2]).toMatchObject({
        callPurpose: TranslationCallPurpose.PARENT_RECOVERY,
        conversationParticipates: false,
        useParentConversationLifecycle: false,
      });
      expect(callSpy.mock.calls[0][2].conversationCommitCandidate).toBeNull();
      expect(history).not.toHaveBeenCalled();
      history.mockRestore();
    });

    it('sanitizes parent recovery metadata through traditional sequential execution', async () => {
      const { AIConversationHelper } = await import('./utils/AIConversationHelper.js');
      const callSpy = vi.spyOn(provider, '_callAI').mockResolvedValue('translated');
      const claimSpy = vi.spyOn(AIConversationHelper, 'claimNextTurn');
      const historySpy = vi.spyOn(AIConversationHelper, 'getConversationHistory');
      const writeSpy = vi.spyOn(AIConversationHelper, 'updateSessionHistory');
      provider.getSupportsStreaming = vi.fn().mockResolvedValue(false);
      provider.getBatchStrategy = vi.fn().mockResolvedValue('sequential');

      try {
        await provider._batchTranslate(['source'], 'en', 'fa', 'select-element', null, null, 'm', null, 'traditional-parent', 'text', {
          callPurpose: TranslationCallPurpose.PARENT_RECOVERY,
          conversationParticipates: true,
          useParentConversationLifecycle: true,
        });

        expect(callSpy.mock.calls[0][2]).toMatchObject({
          callPurpose: TranslationCallPurpose.PARENT_RECOVERY,
          conversationParticipates: false,
          useParentConversationLifecycle: false,
        });
        expect(claimSpy).not.toHaveBeenCalled();
        expect(historySpy).not.toHaveBeenCalled();
        expect(writeSpy).not.toHaveBeenCalled();
      } finally {
        claimSpy.mockRestore();
        historySpy.mockRestore();
        writeSpy.mockRestore();
      }
    });

    it('keeps nested structured recovery purpose distinct from parent recovery', async () => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult
        .mockReturnValueOnce({ results: ['bad'], contractViolation: true })
        .mockReturnValueOnce({ results: ['recovered'], contractViolation: false });
      const callSpy = vi.spyOn(provider, 'executeStructuredBatch');

      await provider._translateBatch(['source'], 'en', 'fa', 'select-element', null, null, 'm', 'nested-parent', {
        callPurpose: TranslationCallPurpose.PARENT_RECOVERY,
        conversationParticipates: true,
      }, ResponseFormat.JSON_ARRAY);

      expect(callSpy.mock.calls[0][3].callPurpose).toBe(TranslationCallPurpose.PARENT_RECOVERY);
      expect(callSpy.mock.calls[0][3].contextMetadata).toMatchObject({
        conversationParticipates: false,
        useParentConversationLifecycle: false,
      });
      expect(callSpy.mock.calls[0][3].conversationCommitCandidate).toBeNull();
      expect(callSpy).toHaveBeenCalledTimes(2);
      expect(callSpy.mock.calls[1][3]).toMatchObject({
        callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
        contextMetadata: expect.objectContaining({
          conversationParticipates: false,
          useParentConversationLifecycle: false,
        }),
      });
    });

    it('accepts explicit parent recovery interval identity and unchanged text', async () => {
      const { AIResponseParser: realParser } = await vi.importActual('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult.mockImplementation(realParser.parseBatchResult.bind(realParser));
      provider._callAI = vi.fn().mockResolvedValue('{"translations":[{"id":"parent-1-0","text":"The"}]}');

      await expect(provider._translateBatch(
        [{ i: 'parent-1-0', text: 'The' }], 'en', 'fa', 'select-element', null, null, null, null,
        { callPurpose: TranslationCallPurpose.PARENT_RECOVERY }, ResponseFormat.JSON_OBJECT
      )).resolves.toEqual(['The']);
      expect(provider._callAI).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['scalar', 'The', ['The', 'valid']],
      ['empty scalar', '', ErrorTypes.API_RESPONSE_INVALID],
      ['id/text object', { id: 'parent-1-0', text: 'The' }, ErrorTypes.API_RESPONSE_INVALID],
      ['WebAI JSON wrapper', '{"translations":[{"id":"parent-1-0","text":"The"}]}', ['{"translations":[{"id":"parent-1-0","text":"The"}]}', 'valid']],
    ])('records selective recovery result contract for %s', async (_label, selectiveResult, expected) => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult.mockReturnValue({
        results: ['invalid', 'valid'],
        contractViolation: true,
        invalidUnits: [{ requestIndex: 0, responseId: 'parent-1-0', violationCodes: ['EMPTY_TRANSLATED_TEXT'] }],
        mappingFacts: { identityReliable: true, complete: true, ambiguous: false },
      });
      provider.executeSequentialBatch = vi.fn().mockResolvedValue(selectiveResult);

      const operation = createTranslationOperation(`selective-shape-${_label}`);
      const action = provider._translateBatch(
        [{ i: 'parent-1-0', text: 'The' }, { i: 'parent-1-1', text: 'Other' }], 'en', 'fa', 'select-element', null, null, null, null,
        { callPurpose: TranslationCallPurpose.PARENT_RECOVERY, executionContext: { operation } }, ResponseFormat.JSON_OBJECT
      );

      if (typeof expected === 'string') {
        await expect(action).rejects.toMatchObject({ type: expected });
      } else {
        await expect(action).resolves.toEqual(expected);
      }
      expect(provider.executeSequentialBatch).toHaveBeenCalledWith(
        ['The'],
        'en', 'fa',
        expect.objectContaining({ callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY })
      );
      const inputLog = loggerMock.debug.mock.calls.find(([message]) => message.includes('Selective structured recovery input'));
      const resultLog = loggerMock.debug.mock.calls.find(([message]) => message.includes('Selective structured recovery result'));
      expect(inputLog?.[1]).toMatchObject({
        event: 'STRUCTURED_RECOVERY_INPUT',
        outerCallPurpose: TranslationCallPurpose.PARENT_RECOVERY,
        strategy: 'SELECTIVE',
        unitCount: 2,
        selectedUnits: [{ requestIndex: 0, sourceIdentity: 'parent-1-0', sourceLength: 3 }],
        expectedFormat: ResponseFormat.STRING,
      });
      expect(inputLog?.[1]).not.toHaveProperty('sourcePreview');
      expect(resultLog?.[1]).toMatchObject({ event: 'STRUCTURED_RECOVERY_RESULT' });
      expect(JSON.stringify(resultLog?.[1])).not.toContain('The');
    });

    it('forces structured recovery to disable inherited conversation lifecycle metadata', async () => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult.mockReturnValue({ results: ['R1'], contractViolation: false });
      const callSpy = vi.spyOn(provider, '_callAI');

      await provider._translateBatch(['source'], 'en', 'fa', 'select-element', null, null, 'm', 'structured-recovery', {
        callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
        conversationParticipates: true,
        useParentConversationLifecycle: true,
      }, ResponseFormat.JSON_ARRAY);

      expect(callSpy.mock.calls[0][2]).toMatchObject({
        callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
        conversationParticipates: false,
        useParentConversationLifecycle: false,
        conversationCommitCandidate: null,
      });
    });

    it('commits one staged valid structured primary response after parser acceptance', async () => {
      const { AIResponseParser } = await import("./utils/AIResponseParser.js");
      const response = '{"translations":["translated"]}';
      const session = translationSessionManager.getOrCreateSession('accepted-session', 'MockAI');
      const writeSpy = vi.spyOn((await import('./utils/AIConversationHelper.js')).AIConversationHelper, 'updateSessionHistory');
      provider._callAI = vi.fn(async (_system, userText, options) => {
        options.conversationCommitCandidate.stage({ sessionId: options.sessionId, userContent: userText, assistantContent: response });
        return response;
      });
      AIResponseParser.parseBatchResult.mockReturnValue({ results: ['translated'], contractViolation: false });

      try {
         await expect(provider._translateBatch(['source'], 'en', 'fa', 'select-element', null, null, 'm', 'accepted-session', { conversationParticipates: true }, ResponseFormat.JSON_ARRAY))
          .resolves.toEqual(['translated']);
        expect(writeSpy).toHaveBeenCalledTimes(1);
        expect(session.batchCount).toBe(1);
        expect(session.history).toHaveLength(2);
      } finally {
        writeSpy.mockRestore();
      }
    });

    it('preserves primary conversation lifecycle metadata and candidate creation', async () => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult.mockReturnValue({ results: ['translated'], contractViolation: false });
      const callSpy = vi.spyOn(provider, '_callAI').mockResolvedValue('raw');

      await provider._translateBatch(['source'], 'en', 'fa', 'select-element', null, null, 'm', 'primary-lifecycle', {
        callPurpose: TranslationCallPurpose.PRIMARY_TRANSLATION,
        conversationParticipates: true,
        useParentConversationLifecycle: true,
      }, ResponseFormat.JSON_ARRAY);

      expect(callSpy.mock.calls[0][2]).toMatchObject({
        callPurpose: TranslationCallPurpose.PRIMARY_TRANSLATION,
        conversationParticipates: true,
        useParentConversationLifecycle: true,
      });
      expect(callSpy.mock.calls[0][2].conversationCommitCandidate).not.toBeNull();
    });

    it('suppresses legacy commit while parent conversation lifecycle is active', async () => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      const update = vi.spyOn((await import('./utils/AIConversationHelper.js')).AIConversationHelper, 'updateSessionHistory');
      provider._callAI = vi.fn(async (_system, userText, options) => {
        options.conversationCommitCandidate.stage({ sessionId: options.sessionId, userContent: userText, assistantContent: 'raw' });
        return 'raw';
      });
      AIResponseParser.parseBatchResult.mockReturnValue({ results: ['translated'], contractViolation: false });
      try {
        await expect(provider._translateBatch(['source'], 'en', 'fa', 'select-element', null, null, 'm', 'parent-session', {
          conversationParticipates: true,
          useParentConversationLifecycle: true,
        }, ResponseFormat.JSON_ARRAY)).resolves.toEqual(['translated']);
        expect(update).not.toHaveBeenCalled();
      } finally {
        update.mockRestore();
      }
    });

    it('discards a staged malformed structured primary response before recovery', async () => {
      const { AIResponseParser } = await import("./utils/AIResponseParser.js");
      const session = translationSessionManager.getOrCreateSession('rejected-session', 'MockAI');
      const before = structuredClone(session);
      const writeSpy = vi.spyOn((await import('./utils/AIConversationHelper.js')).AIConversationHelper, 'updateSessionHistory');
      provider._callAI = vi.fn(async (_system, userText, options) => {
        options.conversationCommitCandidate?.stage({ sessionId: options.sessionId, userContent: userText, assistantContent: 'malformed' });
        return 'malformed';
      });
      const recoverySpy = vi.spyOn(provider, '_traditionalBatchTranslate');
      AIResponseParser.parseBatchResult
        .mockReturnValueOnce({ results: ['source'], contractViolation: true })
        .mockReturnValueOnce({ results: ['translated'], contractViolation: false });

      try {
         await expect(provider._translateBatch(['source'], 'en', 'fa', 'select-element', null, null, 'm', 'rejected-session', { conversationParticipates: true }, ResponseFormat.JSON_ARRAY))
          .resolves.toEqual(['translated']);
         expect(recoverySpy).not.toHaveBeenCalled();
        expect(writeSpy).not.toHaveBeenCalled();
        expect(session).toEqual(before);
      } finally {
        writeSpy.mockRestore();
      }
    });

    it.each([
      ['transport failure', Object.assign(new Error('network'), { type: 'NETWORK_ERROR' })],
      ['cancellation', Object.assign(new Error('cancelled'), { type: 'USER_CANCELLED' })],
    ])('discards a staged structured primary response after %s', async (_label, error) => {
      const session = translationSessionManager.getOrCreateSession(`failed-${_label}`, 'MockAI');
      const before = structuredClone(session);
      const writeSpy = vi.spyOn((await import('./utils/AIConversationHelper.js')).AIConversationHelper, 'updateSessionHistory');
      provider._callAI = vi.fn(async (_system, userText, options) => {
        options.conversationCommitCandidate?.stage({ sessionId: options.sessionId, userContent: userText, assistantContent: 'raw' });
        throw error;
      });

      try {
           await expect(provider._translateBatch(['source'], 'en', 'fa', 'select-element', null, null, 'm', session.id, { conversationParticipates: true }, ResponseFormat.JSON_ARRAY))
          .rejects.toBe(error);
        expect(writeSpy).not.toHaveBeenCalled();
        expect(session).toEqual(before);
      } finally {
        writeSpy.mockRestore();
      }
    });

    it('keeps staged candidate state local to each structured batch execution', async () => {
      const { AIResponseParser } = await import("./utils/AIResponseParser.js");
      const session = translationSessionManager.getOrCreateSession('local-candidates', 'MockAI');
      const writeSpy = vi.spyOn((await import('./utils/AIConversationHelper.js')).AIConversationHelper, 'updateSessionHistory');
      provider._callAI = vi.fn(async (_system, userText, options) => {
        options.conversationCommitCandidate?.stage({ sessionId: options.sessionId, userContent: userText, assistantContent: userText });
        return userText;
      });
      const recoverySpy = vi.spyOn(provider, '_traditionalBatchTranslate').mockResolvedValue(['recovered']);
      AIResponseParser.parseBatchResult
        .mockReturnValueOnce({ results: ['source'], contractViolation: true })
        .mockReturnValueOnce({ results: ['accepted'], contractViolation: false });

      try {
         await provider._translateBatch(['discarded'], 'en', 'fa', 'select-element', null, null, 'm1', session.id, { conversationParticipates: true }, ResponseFormat.JSON_ARRAY);
         await provider._translateBatch(['accepted'], 'en', 'fa', 'select-element', null, null, 'm2', session.id, { conversationParticipates: true }, ResponseFormat.JSON_ARRAY);
         expect(recoverySpy).not.toHaveBeenCalled();
        expect(writeSpy).toHaveBeenCalledTimes(1);
        expect(session.history).toHaveLength(2);
      } finally {
        writeSpy.mockRestore();
      }
    });

    it('discards the staged candidate and rejects with USER_CANCELLED for explicit user cancellation', async () => {
      const { AIResponseParser } = await import("./utils/AIResponseParser.js");
      const abortController = new AbortController();
      const session = translationSessionManager.getOrCreateSession('late-abort-session', 'MockAI');
      const writeSpy = vi.spyOn((await import('./utils/AIConversationHelper.js')).AIConversationHelper, 'updateSessionHistory');
      let commitSpy;
      let discardSpy;
      provider._callAI = vi.fn(async (_system, userText, options) => {
        const candidate = options.conversationCommitCandidate;
        commitSpy = vi.spyOn(candidate, 'commit');
        discardSpy = vi.spyOn(candidate, 'discard');
        candidate.stage({ sessionId: options.sessionId, userContent: userText, assistantContent: 'raw' });
        abortController.abort('user-cancelled');
        return 'raw';
      });
      AIResponseParser.parseBatchResult.mockReturnValue({ results: ['translated'], contractViolation: false });

      try {
        await expect(
           provider._translateBatch(['source'], 'en', 'fa', 'select-element', abortController, null, 'm', 'late-abort-session', { conversationParticipates: true }, ResponseFormat.JSON_ARRAY)
        ).rejects.toMatchObject({ type: ErrorTypes.USER_CANCELLED });
        expect(commitSpy).not.toHaveBeenCalled();
        expect(discardSpy).toHaveBeenCalledTimes(1);
        expect(writeSpy).not.toHaveBeenCalled();
        expect(session.history).toHaveLength(0);
      } finally {
        writeSpy.mockRestore();
      }
    });

    it('discards the staged candidate without fabricating USER_CANCELLED for internal abort', async () => {
      const { AIResponseParser } = await import("./utils/AIResponseParser.js");
      const abortController = new AbortController();
      const session = translationSessionManager.getOrCreateSession('late-internal-abort-session', 'MockAI');
      const writeSpy = vi.spyOn((await import('./utils/AIConversationHelper.js')).AIConversationHelper, 'updateSessionHistory');
      let discardSpy;
      provider._callAI = vi.fn(async (_system, userText, options) => {
        const candidate = options.conversationCommitCandidate;
        discardSpy = vi.spyOn(candidate, 'discard');
        candidate.stage({ sessionId: options.sessionId, userContent: userText, assistantContent: 'raw' });
        abortController.abort();
        return 'raw';
      });
      AIResponseParser.parseBatchResult.mockReturnValue({ results: ['translated'], contractViolation: false });

      try {
        await expect(
          provider._translateBatch(['source'], 'en', 'fa', 'select-element', abortController, null, 'm', 'late-internal-abort-session', { conversationParticipates: true }, ResponseFormat.JSON_ARRAY)
        ).rejects.toMatchObject({ operationAborted: true, cancellationReason: 'operation-abort' });
        expect(discardSpy).toHaveBeenCalledTimes(1);
        expect(writeSpy).not.toHaveBeenCalled();
        expect(session.history).toHaveLength(0);
      } finally {
        writeSpy.mockRestore();
      }
    });

    it('commits once without discard when the signal is not aborted and the result is accepted', async () => {
      const { AIResponseParser } = await import("./utils/AIResponseParser.js");
      const abortController = new AbortController();
      const session = translationSessionManager.getOrCreateSession('normal-accept-session', 'MockAI');
      const writeSpy = vi.spyOn((await import('./utils/AIConversationHelper.js')).AIConversationHelper, 'updateSessionHistory');
      let commitSpy;
      let discardSpy;
      AIResponseParser.parseBatchResult.mockReturnValue({ results: ['translated'], contractViolation: false });
      provider._callAI = vi.fn(async (_system, userText, options) => {
        const candidate = options.conversationCommitCandidate;
        commitSpy = vi.spyOn(candidate, 'commit');
        discardSpy = vi.spyOn(candidate, 'discard');
        candidate.stage({ sessionId: options.sessionId, userContent: userText, assistantContent: 'raw' });
        return 'raw';
      });

      try {
         const result = await provider._translateBatch(['source'], 'en', 'fa', 'select-element', abortController, null, 'm', 'normal-accept-session', { conversationParticipates: true }, ResponseFormat.JSON_ARRAY);
        expect(result).toEqual(['translated']);
        expect(commitSpy).toHaveBeenCalledTimes(1);
        expect(discardSpy).not.toHaveBeenCalled();
        expect(writeSpy).toHaveBeenCalledTimes(1);
        expect(session.history).toHaveLength(2);
      } finally {
        writeSpy.mockRestore();
      }
    });

    it('throws an internal operation abort when the signal has no user reason in the sequential pass', async () => {
      const abortController = new AbortController();
      abortController.abort();

      await expect(
        provider._traditionalBatchTranslate(['seg'], 'en', 'fa', 'selection', null, null, abortController, null, 'recovery-session', null, {})
      ).rejects.toMatchObject({ operationAborted: true, cancellationReason: 'operation-abort' });
    });

    it('aborting during sequential recovery retains no conversation write without USER_CANCELLED', async () => {
      const { AIResponseParser } = await import("./utils/AIResponseParser.js");
      const abortController = new AbortController();
      const session = translationSessionManager.getOrCreateSession('recovery-abort-session', 'MockAI');
      const writeSpy = vi.spyOn((await import('./utils/AIConversationHelper.js')).AIConversationHelper, 'updateSessionHistory');
      let commitSpy;
      provider._callAI = vi.fn(async (_system, userText, options) => {
        if (options.conversationCommitCandidate) {
          commitSpy = vi.spyOn(options.conversationCommitCandidate, 'commit');
        }
        abortController.abort();
        return 'raw';
      });
      AIResponseParser.parseBatchResult.mockReturnValue({ results: ['source'], contractViolation: true });

      try {
        await expect(
          provider._translateBatch(['source'], 'en', 'fa', 'select-element', abortController, null, 'm', 'recovery-abort-session', { conversationParticipates: true }, ResponseFormat.JSON_ARRAY)
        ).rejects.toMatchObject({ operationAborted: true, cancellationReason: 'operation-abort' });
        expect(commitSpy).toBeDefined();
        expect(commitSpy).not.toHaveBeenCalled();
        expect(writeSpy).not.toHaveBeenCalled();
        expect(session.history).toHaveLength(0);
      } finally {
        writeSpy.mockRestore();
      }
    });

    it('uses one bounded structured retry for full parse failure', async () => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      const texts = Array.from({ length: 31 }, (_, index) => ({ id: String(index), text: `source-${index}` }));
      AIResponseParser.parseBatchResult
        .mockReturnValueOnce({ results: [], contractViolation: true, parseFailed: true, invalidUnits: [], mappingFacts: { identityReliable: false } })
        .mockReturnValueOnce({ results: texts.map((_, index) => `translated-${index}`), contractViolation: false });
      const sequentialSpy = vi.spyOn(provider, 'executeSequentialBatch');
      const callSpy = vi.spyOn(provider, '_callAI').mockResolvedValue('structured');

      const result = await provider._translateBatch(
        texts, 'en', 'fa', 'selection', null, null, 'full-retry', 'session-1',
        { callPurpose: TranslationCallPurpose.PARENT_RECOVERY }, ResponseFormat.JSON_OBJECT
      );

      expect(result).toHaveLength(31);
      expect(callSpy).toHaveBeenCalledTimes(2);
      expect(sequentialSpy).not.toHaveBeenCalled();
      expect(callSpy.mock.calls[1][1]).toContain('source-30');
      expect(callSpy.mock.calls.map(([, , options]) => options.callPurpose)).toEqual([
        TranslationCallPurpose.PARENT_RECOVERY,
        TranslationCallPurpose.STRUCTURED_RECOVERY,
      ]);
      expect(callSpy.mock.calls[1][2]).toMatchObject({
        expectedFormat: ResponseFormat.JSON_OBJECT,
        conversationParticipates: false,
        useParentConversationLifecycle: false,
      });
    });

    it('keeps three reliable invalid units on scalar selective recovery', async () => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult.mockReturnValue({
        results: ['A', 'bad-b', 'C', 'bad-d', 'E', 'bad-f'],
        contractViolation: true,
        invalidUnits: [1, 3, 5].map((requestIndex) => ({ requestIndex, responseId: String(requestIndex), violationCodes: ['EMPTY_TRANSLATED_TEXT'] })),
        mappingFacts: { identityReliable: true, complete: true, ambiguous: false },
      });
      const sequentialSpy = vi.spyOn(provider, 'executeSequentialBatch').mockResolvedValue(['B', 'D', 'F']);

      const result = await provider._translateBatch(['a', 'b', 'c', 'd', 'e', 'f'], 'en', 'fa', 'select-element');

      expect(sequentialSpy).toHaveBeenCalledWith(['b', 'd', 'f'], 'en', 'fa', expect.objectContaining({
        callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
        expectedFormat: ResponseFormat.STRING,
      }));
      expect(result).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    });

    it('uses one structured subset retry for four reliable invalid units', async () => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult
        .mockReturnValueOnce({
          results: ['A', 'bad-b', 'C', 'bad-d', 'bad-e', 'bad-f'],
          contractViolation: true,
          invalidUnits: [1, 3, 4, 5].map((requestIndex) => ({ requestIndex, responseId: `unit-${requestIndex}`, violationCodes: ['EMPTY_TRANSLATED_TEXT'] })),
          mappingFacts: { identityReliable: true, complete: true, ambiguous: false },
        })
        .mockReturnValueOnce({ results: ['B', 'D', 'E', 'F'], contractViolation: false });
      const sequentialSpy = vi.spyOn(provider, 'executeSequentialBatch');
      const callSpy = vi.spyOn(provider, '_callAI').mockResolvedValue('structured');
      const texts = [1, 2, 3, 4, 5, 6].map((id) => ({ i: `unit-${id}`, text: `source-${id}` }));
      const operation = createTranslationOperation('subset-purpose-success');

      const result = await provider._translateBatch(texts, 'en', 'fa', 'select-element', null, null, 'subset', 'session-1', {
        callPurpose: TranslationCallPurpose.PARENT_RECOVERY,
        executionContext: { operation },
      }, ResponseFormat.JSON_OBJECT);

      expect(result).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
      expect(callSpy).toHaveBeenCalledTimes(2);
      expect(callSpy.mock.calls[1][2]).toMatchObject({
        callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
        expectedFormat: ResponseFormat.JSON_OBJECT,
        conversationParticipates: false,
        useParentConversationLifecycle: false,
      });
      expect(callSpy.mock.calls[1][1]).toContain('unit-2');
      expect(callSpy.mock.calls[1][1]).toContain('unit-6');
      expect(sequentialSpy).not.toHaveBeenCalled();
      expect(loggerMock.debug.mock.calls.some(([message, data]) => message.includes('Structured recovery triggered') && data.strategy === 'STRUCTURED_SUBSET_RETRY' && data.invalidUnitCount === 4)).toBe(true);
      expect(operation.finalize().entries).toContainEqual(expect.objectContaining({
        type: 'RECOVERY_SUCCEEDED',
        strategy: 'STRUCTURED_SUBSET_RETRY',
        callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
        outerCallPurpose: TranslationCallPurpose.PARENT_RECOVERY,
      }));
    });

    it('finalizes bounded structured subset recovery diagnostics', async () => {
      const { appendTranslationDiagnostic } = await import('../ir/TranslationOperation.js');
      const operation = createTranslationOperation('subset-diagnostic');
      appendTranslationDiagnostic({ operation }, {
        type: 'RECOVERY_SUCCEEDED',
        stage: 'recovery',
        provider: 'MockAI',
        strategy: 'STRUCTURED_SUBSET_RETRY',
        unitCount: 6,
        invalidCount: 6,
        originalUnitCount: 13,
        attempt: 1,
        expectedFormat: ResponseFormat.JSON_OBJECT,
        callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
        outerCallPurpose: TranslationCallPurpose.PARENT_RECOVERY,
      });

      const diagnostic = operation.finalize().entries[0];
      expect(diagnostic).toMatchObject({
        strategy: 'STRUCTURED_SUBSET_RETRY',
        unitCount: 6,
        invalidCount: 6,
        originalUnitCount: 13,
        attempt: 1,
        expectedFormat: ResponseFormat.JSON_OBJECT,
        callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
        outerCallPurpose: TranslationCallPurpose.PARENT_RECOVERY,
      });
    });

    it('merges reordered structured subset responses by parser identity', async () => {
      const { AIResponseParser: realParser } = await vi.importActual('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult
        .mockReturnValueOnce({
          results: ['bad-1', 'valid-2', 'bad-3', 'bad-4', 'bad-5', 'valid-6'],
          contractViolation: true,
          invalidUnits: [0, 2, 3, 4].map((requestIndex) => ({ requestIndex, responseId: `unit-${requestIndex + 1}`, violationCodes: ['EMPTY_TRANSLATED_TEXT'] })),
          mappingFacts: { identityReliable: true, complete: true, ambiguous: false },
        })
        .mockImplementationOnce(realParser.parseBatchResult.bind(realParser));
      const callSpy = vi.spyOn(provider, '_callAI')
        .mockResolvedValueOnce('primary')
        .mockResolvedValueOnce(JSON.stringify({
          translations: [
            { id: 'unit-5', text: 'translated-5' },
            { id: 'unit-1', text: 'translated-1' },
            { id: 'unit-4', text: 'translated-4' },
            { id: 'unit-3', text: 'translated-3' },
          ],
        }));
      const sequentialSpy = vi.spyOn(provider, 'executeSequentialBatch');
      const texts = [1, 2, 3, 4, 5, 6].map((id) => ({ i: `unit-${id}`, text: `source-${id}` }));

      const result = await provider._translateBatch(texts, 'en', 'fa', 'select-element', null, null, 'reordered-subset', 'session-1', null, ResponseFormat.JSON_OBJECT);

      expect(result).toEqual(['translated-1', 'valid-2', 'translated-3', 'translated-4', 'translated-5', 'valid-6']);
      expect(callSpy).toHaveBeenCalledTimes(2);
      expect(sequentialSpy).not.toHaveBeenCalled();
    });

    it.each(['missing identity', 'duplicate identity', 'malformed response'])('fails subset recovery atomically for %s', async () => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult
        .mockReturnValueOnce({
          results: ['bad-a', 'bad-b', 'bad-c', 'bad-d', 'valid'],
          contractViolation: true,
          invalidUnits: [0, 1, 2, 3].map((requestIndex) => ({ requestIndex, responseId: String(requestIndex), violationCodes: ['EMPTY_TRANSLATED_TEXT'] })),
          mappingFacts: { identityReliable: true, complete: true, ambiguous: false },
        })
        .mockReturnValueOnce({ results: ['bad-a', 'bad-b', 'bad-c', 'bad-d'], contractViolation: true });
      const callSpy = vi.spyOn(provider, '_callAI').mockResolvedValue('structured');
      const sequentialSpy = vi.spyOn(provider, 'executeSequentialBatch');

      await expect(provider._translateBatch(['a', 'b', 'c', 'd', 'e'], 'en', 'fa', 'select-element', null, null, null, 'subset-failure', null, ResponseFormat.JSON_OBJECT))
        .rejects.toMatchObject({ type: ErrorTypes.API_RESPONSE_INVALID });
      expect(callSpy).toHaveBeenCalledTimes(2);
      expect(sequentialSpy).not.toHaveBeenCalled();
    });

    it('propagates subset provider failure without scalar fallback', async () => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      const providerError = Object.assign(new Error('subset network failure'), { type: ErrorTypes.NETWORK_ERROR });
      AIResponseParser.parseBatchResult.mockReturnValueOnce({
        results: ['bad-a', 'bad-b', 'bad-c', 'bad-d', 'valid'],
        contractViolation: true,
        invalidUnits: [0, 1, 2, 3].map((requestIndex) => ({ requestIndex, responseId: String(requestIndex), violationCodes: ['EMPTY_TRANSLATED_TEXT'] })),
        mappingFacts: { identityReliable: true, complete: true, ambiguous: false },
      });
      const callSpy = vi.spyOn(provider, '_callAI')
        .mockResolvedValueOnce('structured')
        .mockRejectedValueOnce(providerError);
      const sequentialSpy = vi.spyOn(provider, 'executeSequentialBatch');
      const operation = createTranslationOperation('subset-purpose-failure');

      await expect(provider._translateBatch(['a', 'b', 'c', 'd', 'e'], 'en', 'fa', 'select-element', null, null, null, 'subset-provider-failure', {
        callPurpose: TranslationCallPurpose.PARENT_RECOVERY,
        executionContext: { operation },
      }, ResponseFormat.JSON_OBJECT))
        .rejects.toBe(providerError);
      expect(callSpy).toHaveBeenCalledTimes(2);
      expect(sequentialSpy).not.toHaveBeenCalled();
      expect(operation.finalize().entries).toContainEqual(expect.objectContaining({
        type: 'RECOVERY_FAILED',
        strategy: 'STRUCTURED_SUBSET_RETRY',
        callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
        outerCallPurpose: TranslationCallPurpose.PARENT_RECOVERY,
      }));
    });

    it('fails atomically when bounded structured retry is invalid', async () => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult
        .mockReturnValueOnce({ results: [], contractViolation: true, parseFailed: true, invalidUnits: [], mappingFacts: { identityReliable: false } })
        .mockReturnValueOnce({ results: [], contractViolation: true, parseFailed: true, invalidUnits: [], mappingFacts: { identityReliable: false } });
      const sequentialSpy = vi.spyOn(provider, 'executeSequentialBatch');
      const callSpy = vi.spyOn(provider, '_callAI').mockResolvedValue('structured');

      await expect(provider._translateBatch(['a', 'b'], 'en', 'fa', 'selection', null, null, null, 'session-1', null, ResponseFormat.JSON_OBJECT))
        .rejects.toMatchObject({ type: ErrorTypes.API_RESPONSE_INVALID });
      expect(callSpy).toHaveBeenCalledTimes(2);
      expect(sequentialSpy).not.toHaveBeenCalled();
    });

    it('keeps each outer retry bounded to two structured calls', async () => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult
        .mockReturnValueOnce({ results: [], contractViolation: true, parseFailed: true, invalidUnits: [], mappingFacts: { identityReliable: false } })
        .mockReturnValueOnce({ results: ['recovered'], contractViolation: false })
        .mockReturnValueOnce({ results: [], contractViolation: true, parseFailed: true, invalidUnits: [], mappingFacts: { identityReliable: false } })
        .mockReturnValueOnce({ results: ['recovered'], contractViolation: false });
      const callSpy = vi.spyOn(provider, '_callAI').mockResolvedValue('structured');

      await provider._translateBatch(['source'], 'en', 'fa', 'selection');
      await provider._translateBatch(['source'], 'en', 'fa', 'selection');

      expect(callSpy).toHaveBeenCalledTimes(4);
    });

    it('does not selectively recover an unreliable bounded retry', async () => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult
        .mockReturnValueOnce({ results: [], contractViolation: true, parseFailed: true, invalidUnits: [], mappingFacts: { identityReliable: false } })
        .mockReturnValueOnce({ results: ['bad'], contractViolation: true, invalidUnits: [{ requestIndex: 0 }], mappingFacts: { identityReliable: true, complete: true, ambiguous: false } });
      const sequentialSpy = vi.spyOn(provider, 'executeSequentialBatch');
      const callSpy = vi.spyOn(provider, '_callAI').mockResolvedValue('structured');

      await expect(provider._translateBatch(['a'], 'en', 'fa', 'selection'))
        .rejects.toMatchObject({ type: ErrorTypes.API_RESPONSE_INVALID });
      expect(callSpy).toHaveBeenCalledTimes(2);
      expect(sequentialSpy).not.toHaveBeenCalled();
    });

    it('preserves full retry diagnostics and conversation isolation', async () => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      const operation = createTranslationOperation('full-retry-diagnostics');
      AIResponseParser.parseBatchResult
        .mockReturnValueOnce({ results: [], contractViolation: true, parseFailed: true, invalidUnits: [], mappingFacts: { identityReliable: false }, repairContext: { reason: 'parse failure' } })
        .mockReturnValueOnce({ results: ['translated'], contractViolation: false });
      const callSpy = vi.spyOn(provider, '_callAI').mockResolvedValue('structured');

      await provider._translateBatch(['source'], 'en', 'fa', 'selection', null, null, 'diagnostics', 'session-1', {
        callPurpose: TranslationCallPurpose.PARENT_RECOVERY,
        conversationParticipates: true,
        useParentConversationLifecycle: true,
        executionContext: { operation },
      }, ResponseFormat.JSON_OBJECT);

      expect(callSpy.mock.calls[1][2]).toMatchObject({
        callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
        conversationParticipates: false,
        useParentConversationLifecycle: false,
      });
      expect(loggerMock.debug.mock.calls.some(([message, data]) => message.includes('Structured recovery triggered') && data.strategy === 'FULL_STRUCTURED_RETRY' && data.reason === 'PARSE_FAILURE' && data.attempt === 1)).toBe(true);
      expect(operation.finalize().entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'RECOVERY_TRIGGERED' }),
      ]));
    });

    it('stops before retry when cancellation occurs after primary response', async () => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      const abortController = new AbortController();
      AIResponseParser.parseBatchResult.mockReturnValue({ results: [], contractViolation: true, parseFailed: true, invalidUnits: [], mappingFacts: { identityReliable: false } });
      provider._callAI = vi.fn().mockImplementationOnce(async (_system, _text, options) => {
        options.abortController.abort();
        return 'structured';
      });

      await expect(provider._translateBatch(['source'], 'en', 'fa', 'selection', abortController))
        .rejects.toMatchObject({ operationAborted: true, cancellationReason: 'operation-abort' });
      expect(provider._callAI).toHaveBeenCalledTimes(1);
    });

    it('completes recovery when recovered V3 intervals pass semantic validation', async () => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      const source = 'A@@TI_SEG_e1_s1_n1@@B@@TI_SEG_e1_s1_n2@@C';
      AIResponseParser.parseBatchResult
        .mockReturnValueOnce({ results: ['invalid'], contractViolation: true, parseFailed: true, invalidUnits: [], mappingFacts: { identityReliable: false } })
        .mockReturnValueOnce({ results: ['TA@@TI_SEG_e1_s1_n1@@TB@@TI_SEG_e1_s1_n2@@TC'], contractViolation: false });

      const result = await provider._translateBatch(
        [source], 'en', 'fa', 'select-element', null, null, null, 'recovery-valid', null, ResponseFormat.JSON_OBJECT
      );

      expect(result).toEqual(['TA@@TI_SEG_e1_s1_n1@@TB@@TI_SEG_e1_s1_n2@@TC']);
      expect(loggerMock.debug.mock.calls.some(([message]) => message.includes('Structured recovery completed'))).toBe(true);
    });

    it('rejects shape-valid recovery with an empty V3 interval before completion', async () => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      const source = 'A@@TI_SEG_e1_s1_n1@@B@@TI_SEG_e1_s1_n2@@C';
      AIResponseParser.parseBatchResult
        .mockReturnValueOnce({ results: ['invalid'], contractViolation: true, parseFailed: true, invalidUnits: [], mappingFacts: { identityReliable: false } })
        .mockReturnValueOnce({ results: ['TA@@TI_SEG_e1_s1_n1@@@@TI_SEG_e1_s1_n2@@TC'], contractViolation: true, parseFailed: false, invalidUnits: [], mappingFacts: { identityReliable: false } });

      await expect(provider._translateBatch(
        [source], 'en', 'fa', 'select-element', null, null, null, 'recovery-invalid', null, ResponseFormat.JSON_OBJECT
      )).rejects.toMatchObject({ type: ErrorTypes.API_RESPONSE_INVALID });
      expect(loggerMock.debug.mock.calls.some(([message]) => message.includes('Structured recovery completed'))).toBe(false);
    });

    it('rejects duplicate primary candidate without scalar fan-out', async () => {
      const { AIResponseParser: realParser } = await vi.importActual("./utils/AIResponseParser.js");
      AIResponseParser.parseBatchResult.mockImplementation(realParser.parseBatchResult.bind(realParser));

      provider._callAI = vi.fn().mockResolvedValue('[{"i":"n1","t":"TA"},{"i":"n1","t":"TB"}]');
      const recoverySpy = vi.spyOn(provider, '_traditionalBatchTranslate');

      await expect(provider._translateBatch(
        [{ i: 'n1', t: 'A' }, { i: 'n2', t: 'B' }], 'en', 'fa', 'select-element', null, null, 'rec-real', 'session-1', null, ResponseFormat.JSON_ARRAY
      )).rejects.toMatchObject({ type: ErrorTypes.API_RESPONSE_INVALID });

      expect(AIResponseParser.parseBatchResult).toHaveBeenCalledTimes(2);
      expect(AIResponseParser.parseBatchResult.mock.results[0].value.contractViolation).toBe(true);
      expect(recoverySpy).not.toHaveBeenCalled();
    });

    it('propagates recovery failure error without returning source-filled parser results', async () => {
      const { AIResponseParser: realParser } = await vi.importActual("./utils/AIResponseParser.js");
      AIResponseParser.parseBatchResult.mockImplementation(realParser.parseBatchResult.bind(realParser));

      const error = Object.assign(new Error('Recovery network failure'), { type: 'NETWORK_ERROR' });
      provider._callAI = vi.fn().mockResolvedValue('[{"i":"n1","t":"TA"},{"i":"n1","t":"TB"}]');
      const recoverySpy = vi.spyOn(provider, '_traditionalBatchTranslate').mockRejectedValue(error);

      await expect(provider._translateBatch(
        [{ i: 'n1', t: 'A' }, { i: 'n2', t: 'B' }], 'en', 'fa', 'select-element', null, null, 'rec-fail', 'session-1', null, ResponseFormat.JSON_ARRAY
      )).rejects.toMatchObject({ type: ErrorTypes.API_RESPONSE_INVALID });
      expect(recoverySpy).not.toHaveBeenCalled();
    });

    it('selectively recovers one reliable invalid middle item and preserves valid results', async () => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult.mockReturnValue({
        results: ['A', 'invalid', 'C'],
        contractViolation: true,
        invalidUnits: [{ requestIndex: 1, responseId: '1', violationCodes: ['V3_EMPTY_TRANSLATED_INTERVAL'] }],
        mappingFacts: { identityReliable: true, complete: true, ambiguous: false },
        repairContext: {
          reason: 'V3_EMPTY_TRANSLATED_INTERVAL',
          affectedUnits: [{ requestIndex: 1, responseId: '1', markerId: 'n13', sourceText: 'video game publisher' }],
        },
      });
      const recoverySpy = vi.spyOn(provider, '_traditionalBatchTranslate').mockResolvedValue(['B']);

      const result = await provider._translateBatch(['a', 'b', 'c'], 'en', 'fa', 'select-element');

      expect(recoverySpy.mock.calls[0][0]).toEqual(['b']);
      expect(recoverySpy.mock.calls[0][10]).toMatchObject({
        repairContext: expect.objectContaining({ reason: 'V3_EMPTY_TRANSLATED_INTERVAL' }),
      });
      expect(result).toEqual(['A', 'B', 'C']);
    });

    it('selectively recovers multiple indexes in sorted original order', async () => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult.mockReturnValue({
        results: ['A', 'bad-1', 'C', 'bad-2', 'E'],
        contractViolation: true,
        invalidUnits: [
          { requestIndex: 3, responseId: '3', violationCodes: ['EMPTY_TRANSLATED_TEXT'] },
          { requestIndex: 1, responseId: '1', violationCodes: ['INVALID_TRANSLATED_TEXT'] },
        ],
        mappingFacts: { identityReliable: true, complete: true, ambiguous: false },
      });
      const recoverySpy = vi.spyOn(provider, '_traditionalBatchTranslate').mockResolvedValue(['B', 'D']);

      const result = await provider._translateBatch(['a', 'b', 'c', 'd', 'e'], 'en', 'fa', 'select-element');

      expect(recoverySpy.mock.calls[0][0]).toEqual(['b', 'd']);
      expect(result).toEqual(['A', 'B', 'C', 'D', 'E']);
    });

    it.each([
      ['first', ['bad', 'B', 'C'], [0], ['A']],
      ['last', ['A', 'B', 'bad'], [2], ['C']],
    ])('selectively recovers the %s invalid item', async (_label, primary, invalidIndexes, recovered) => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult.mockReturnValue({
        results: primary,
        contractViolation: true,
        invalidUnits: invalidIndexes.map((requestIndex) => ({ requestIndex, responseId: String(requestIndex), violationCodes: ['EMPTY_TRANSLATED_TEXT'] })),
        mappingFacts: { identityReliable: true, complete: true, ambiguous: false },
      });
      const recoverySpy = vi.spyOn(provider, '_traditionalBatchTranslate').mockResolvedValue(recovered);

      const result = await provider._translateBatch(['A', 'B', 'C'], 'en', 'fa', 'select-element');

      expect(recoverySpy.mock.calls[0][0]).toEqual(invalidIndexes.map((index) => ['A', 'B', 'C'][index]));
      expect(result).toEqual(['A', 'B', 'C']);
    });

    it.each([
      ['missing facts', { results: ['A', 'bad', 'C'], contractViolation: true }],
      ['ambiguous mapping', {
        results: ['A', 'bad', 'C'],
        contractViolation: true,
        invalidUnits: [{ requestIndex: 1, responseId: '1', violationCodes: ['DUPLICATE_MAPPED_SLOT'] }],
        mappingFacts: { identityReliable: false, complete: false, ambiguous: true },
      }],
      ['invalid request index', {
        results: ['A', 'bad', 'C'],
        contractViolation: true,
        invalidUnits: [{ requestIndex: null, responseId: '1', violationCodes: ['V3_EMPTY_TRANSLATED_INTERVAL'] }],
        mappingFacts: { identityReliable: true, complete: true, ambiguous: false },
      }],
    ])('keeps full-batch recovery for %s', async (_label, parsed) => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult
        .mockReturnValueOnce(parsed)
        .mockReturnValueOnce({ results: ['A', 'B', 'C'], contractViolation: false });
      const recoverySpy = vi.spyOn(provider, '_traditionalBatchTranslate');

      await provider._translateBatch(['a', 'b', 'c'], 'en', 'fa', 'select-element');

      expect(recoverySpy).not.toHaveBeenCalled();
    });

    it('fails selective recovery on result length mismatch without source fallback', async () => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult.mockReturnValue({
        results: ['A', 'source-value', 'C'],
        contractViolation: true,
        invalidUnits: [
          { requestIndex: 1, responseId: '1', violationCodes: ['V3_EMPTY_TRANSLATED_INTERVAL'] },
          { requestIndex: 2, responseId: '2', violationCodes: ['EMPTY_TRANSLATED_TEXT'] },
        ],
        mappingFacts: { identityReliable: true, complete: true, ambiguous: false },
      });
      vi.spyOn(provider, '_traditionalBatchTranslate').mockResolvedValue(['B']);

      await expect(provider._translateBatch(['a', 'b', 'c'], 'en', 'fa', 'select-element'))
        .rejects.toMatchObject({ type: ErrorTypes.API_RESPONSE_INVALID });
    });

    it('fails selective recovery when the recovery request throws', async () => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      const error = Object.assign(new Error('subset failed'), { type: 'NETWORK_ERROR' });
      AIResponseParser.parseBatchResult.mockReturnValue({
        results: ['A', 'bad', 'C'],
        contractViolation: true,
        invalidUnits: [{ requestIndex: 1, responseId: '1', violationCodes: ['EMPTY_TRANSLATED_TEXT'] }],
        mappingFacts: { identityReliable: true, complete: true, ambiguous: false },
      });
      vi.spyOn(provider, '_traditionalBatchTranslate').mockRejectedValue(error);

      await expect(provider._translateBatch(['a', 'b', 'c'], 'en', 'fa', 'select-element'))
        .rejects.toBe(error);
    });

    it('keeps full-batch recovery when every item is invalid', async () => {
      const { AIResponseParser } = await import('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult
        .mockReturnValueOnce({
          results: ['bad-a', 'bad-b', 'bad-c'],
          contractViolation: true,
          invalidUnits: [0, 1, 2].map((requestIndex) => ({ requestIndex, responseId: String(requestIndex), violationCodes: ['INVALID_TRANSLATED_TEXT'] })),
          mappingFacts: { identityReliable: true, complete: true, ambiguous: false },
        })
        .mockReturnValueOnce({ results: ['A', 'B', 'C'], contractViolation: false });
      const recoverySpy = vi.spyOn(provider, '_traditionalBatchTranslate');

      await provider._translateBatch(['a', 'b', 'c'], 'en', 'fa', 'select-element');

      expect(recoverySpy).not.toHaveBeenCalled();
    });
  });

  describe('_translateBatch completion correlation (ADR-016 P3)', () => {
    it('passes the NORMAL completion recorded by the adapter to the parser', async () => {
      const { AIResponseParser: realParser } = await vi.importActual('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult.mockImplementation(realParser.parseBatchResult.bind(realParser));
      const operation = createTranslationOperation('p3-stop');
      const record = createCompletionRecord({ provider: 'MockAI', termination: CompletionTermination.NORMAL, responseId: 'resp-1' });
      let stored = null;
      provider._callAI = vi.fn().mockImplementation(async (_sys, _text, options) => {
        stored = recordProviderCompletion(options.executionContext, record);
        return '[{"id":"0","text":"AA"},{"id":"1","text":"BB"}]';
      });

      const result = await provider._translateBatch(
        ['A', 'B'], 'en', 'fa', 'select-element', null, null, 'p3-stop', 'session-1',
        { executionContext: { operation } }
      );

      expect(result).toEqual(['AA', 'BB']);
      expect(AIResponseParser.parseBatchResult.mock.calls.at(-1)[7]).toBe(stored);
      expect(AIResponseParser.parseBatchResult.mock.calls.at(-1)[7]).not.toBe(record);
      expect(operation.snapshotCompletions()).toEqual([stored]);
    });

    it('attaches TRUNCATED classification while preserving full recovery behavior', async () => {
      const { AIResponseParser: realParser } = await vi.importActual('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult.mockImplementation(realParser.parseBatchResult.bind(realParser));
      const operation = createTranslationOperation('p4-truncated-parse');
      const record = createCompletionRecord({
        provider: 'MockAI',
        termination: CompletionTermination.TRUNCATED,
        responseId: 'resp-truncated',
      });
      let calls = 0;
      provider._callAI = vi.fn().mockImplementation(async (_sys, _text, options) => {
        calls += 1;
        if (calls === 1) {
          recordProviderCompletion(options.executionContext, record);
          return '{"translations":';
        }
         return '{"translations":[{"id":"0","text":"recovered"}]}';
      });

      const result = await provider._translateBatch(
        ['source'], 'en', 'fa', 'select-element', null, null, 'p4-truncated-parse', 'session-1',
        { executionContext: { operation } }, ResponseFormat.JSON_OBJECT
      );
      const trigger = operation.finalize().entries.find(({ type }) => type === 'RECOVERY_TRIGGERED');

      expect(result).toEqual(['recovered']);
      expect(provider._callAI).toHaveBeenCalledTimes(2);
      expect(trigger).toMatchObject({ classification: 'TRUNCATED_RESPONSE' });
    });

    it('passes a TRUNCATED completion through with identical behavior to NORMAL', async () => {
      const { AIResponseParser: realParser } = await vi.importActual('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult.mockImplementation(realParser.parseBatchResult.bind(realParser));
      const operation = createTranslationOperation('p3-truncated');
      const truncRecord = createCompletionRecord({ provider: 'MockAI', termination: CompletionTermination.TRUNCATED, responseId: 'resp-t' });
      const normRecord = createCompletionRecord({ provider: 'MockAI', termination: CompletionTermination.NORMAL, responseId: 'resp-n' });
      const completions = [];
      provider._callAI = vi.fn().mockImplementation(async (_sys, _text, options) => {
        const stored = recordProviderCompletion(options.executionContext, completions.length ? normRecord : truncRecord);
        completions.push(stored);
        return '[{"id":"0","text":"X"}]';
      });

      const truncatedResult = await provider._translateBatch(
        ['a'], 'en', 'fa', 'select-element', null, null, 'p3-trunc', 'session-1',
        { executionContext: { operation } }
      );
      const normalResult = await provider._translateBatch(
        ['a'], 'en', 'fa', 'select-element', null, null, 'p3-trunc', 'session-1',
        { executionContext: { operation } }
      );

      expect(truncatedResult).toEqual(normalResult);
      expect(AIResponseParser.parseBatchResult.mock.calls.at(-2)[7]).toBe(completions[0]);
      expect(AIResponseParser.parseBatchResult.mock.calls.at(-1)[7]).toBe(completions[1]);
      expect(completions[0].termination).toBe(CompletionTermination.TRUNCATED);
      expect(completions[1].termination).toBe(CompletionTermination.NORMAL);
    });

    it('correlates each parallel batch with its own per-call completion slot', async () => {
      const { AIResponseParser: realParser } = await vi.importActual('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult.mockImplementation(realParser.parseBatchResult.bind(realParser));
      const operation = createTranslationOperation('p3-parallel');
      const recordA = createCompletionRecord({ provider: 'MockAI', termination: CompletionTermination.NORMAL, responseId: 'resp-a' });
      const recordB = createCompletionRecord({ provider: 'MockAI', termination: CompletionTermination.TRUNCATED, responseId: 'resp-b' });
      const stored = [];
      const gate = createGate();
      provider._callAI = vi.fn().mockImplementation(async (_sys, text, options) => {
        const record = text.includes('resp-a-target') ? recordA : recordB;
        stored.push(recordProviderCompletion(options.executionContext, record));
        await gate.defer();
        return `[{"id":"0","text":"${record.responseId}"}]`;
      });

      const promiseA = provider._translateBatch(['resp-a-target'], 'en', 'fa', 'select-element', null, null, 'p3-par', 'session-1', { executionContext: { operation } });
      const promiseB = provider._translateBatch(['resp-b-target'], 'en', 'fa', 'select-element', null, null, 'p3-par', 'session-1', { executionContext: { operation } });
      await vi.waitFor(() => expect(provider._callAI).toHaveBeenCalledTimes(2));
      gate.release();
      const [resultA, resultB] = await Promise.all([promiseA, promiseB]);

      expect(resultA).toEqual(['resp-a']);
      expect(resultB).toEqual(['resp-b']);
      expect(AIResponseParser.parseBatchResult.mock.calls.at(-2)[7]).toBe(stored.find(({ responseId }) => responseId === 'resp-a'));
      expect(AIResponseParser.parseBatchResult.mock.calls.at(-1)[7]).toBe(stored.find(({ responseId }) => responseId === 'resp-b'));
      expect(operation.snapshotCompletions()).toHaveLength(2);
    });

    it('records the primary completion on the primary slot and the recovery completion on the operation', async () => {
      const operation = createTranslationOperation('p3-primary-recovery');
      const primary = createCompletionRecord({ provider: 'MockAI', termination: CompletionTermination.TRUNCATED, responseId: 'resp-primary' });
      const recovery = createCompletionRecord({ provider: 'MockAI', termination: CompletionTermination.NORMAL, responseId: 'resp-recovery' });
      const primaryStored = [];
      const recoveryStored = [];
       AIResponseParser.parseBatchResult
         .mockReturnValueOnce({
           results: ['bad-a'],
           contractViolation: true,
           invalidUnits: [{ requestIndex: 0, responseId: '0', violationCodes: ['EMPTY_TRANSLATED_TEXT'] }],
           mappingFacts: { identityReliable: true, complete: true, ambiguous: false },
         })
         .mockReturnValueOnce({ results: ['recovered-A'], contractViolation: false });
      provider._callAI = vi.fn().mockImplementation(async (_sys, _text, options) => {
        if (options.callPurpose === TranslationCallPurpose.STRUCTURED_RECOVERY) {
          recoveryStored.push(recordProviderCompletion(options.executionContext, recovery));
           return '[{"id":"0","text":"recovered-A"}]';
        }
        primaryStored.push(recordProviderCompletion(options.executionContext, primary));
        return '[{"id":"0","text":"bad-a"}]';
      });

      const result = await provider._translateBatch(
        ['A'], 'en', 'fa', 'select-element', null, null, 'p3-prim', 'session-1',
        { executionContext: { operation } }, ResponseFormat.JSON_ARRAY
      );

      expect(result).toEqual(['recovered-A']);
       expect(AIResponseParser.parseBatchResult.mock.calls.at(-1)[7]).toBe(recoveryStored[0]);
      expect(operation.snapshotCompletions()).toHaveLength(2);
      expect(operation.snapshotCompletions().map(({ responseId }) => responseId)).toEqual(['resp-primary', 'resp-recovery']);
    });
  });

  describe('P5 truncation recovery invariants', () => {
    it('logs PARSE_FAILURE for NORMAL completion with unparseable structured output', async () => {
      const operation = createTranslationOperation('p7-normal-parse-failure');
      const completion = createCompletionRecord({
        provider: 'MockAI',
        termination: CompletionTermination.NORMAL,
        responseId: 'p7-normal',
      });
       AIResponseParser.parseBatchResult.mockReturnValue({
         results: ['', ''],
         contractViolation: true,
         parseFailed: true,
         invalidUnits: [],
         mappingFacts: { identityReliable: false, complete: false, ambiguous: true },
       });
      provider._callAI = vi.fn().mockImplementation(async (_system, _text, options) => {
        recordProviderCompletion(options.executionContext, completion);
        return 'primary';
      });
       await expect(provider._translateBatch(
         ['a', 'b'], 'en', 'fa', 'select-element', null, null, 'p7-normal-parse-failure', 'session-1',
         { executionContext: { operation } }, ResponseFormat.JSON_OBJECT
       )).rejects.toMatchObject({ type: ErrorTypes.API_RESPONSE_INVALID });

      const recoveryLog = loggerMock.debug.mock.calls.find(([message]) => message.includes('Structured recovery triggered'));
      expect(recoveryLog?.[1]).toMatchObject({
        classification: 'PARSE_FAILURE',
        termination: CompletionTermination.NORMAL,
        parseFailed: true,
         strategy: 'FULL_STRUCTURED_RETRY',
      });
    });

    it('uses full recovery for TRUNCATED plus unparseable structured output', async () => {
      const { AIResponseParser: realParser } = await vi.importActual('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult.mockImplementation(realParser.parseBatchResult.bind(realParser));
      const operation = createTranslationOperation('p5-truncated-parse');
      const completion = createCompletionRecord({
        provider: 'MockAI',
        termination: CompletionTermination.TRUNCATED,
        responseId: 'p5-primary',
      });
      let callCount = 0;
      provider._callAI = vi.fn().mockImplementation(async (_sys, _text, options) => {
        callCount += 1;
        if (callCount === 1) {
          recordProviderCompletion(options.executionContext, completion);
          return '{"translations":';
        }
         return '{"translations":[{"id":"0","text":"recovered-1"},{"id":"1","text":"recovered-2"}]}';
      });

      const result = await provider._translateBatch(
        ['a', 'b'], 'en', 'fa', 'select-element', null, null, 'p5-truncated-parse', 'session-1',
        { executionContext: { operation } }, ResponseFormat.JSON_OBJECT
      );
      const report = operation.finalize();

       expect(result).toEqual(['recovered-1', 'recovered-2']);
       expect(callCount).toBe(2);
      expect(report.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'RECOVERY_TRIGGERED', classification: 'TRUNCATED_RESPONSE' }),
        expect.objectContaining({ type: 'RECOVERY_SUCCEEDED' }),
      ]));
      const recoveryLog = loggerMock.debug.mock.calls.find(([message]) => message.includes('Structured recovery triggered'));
      expect(recoveryLog?.[1]).toMatchObject({
        classification: 'TRUNCATED_RESPONSE',
        termination: CompletionTermination.TRUNCATED,
        parseFailed: true,
         strategy: 'FULL_STRUCTURED_RETRY',
      });
      const completionLog = loggerMock.debug.mock.calls.find(([message]) => message.includes('Provider completion record'));
      expect(completionLog?.[1]).toMatchObject({
        provider: 'MockAI',
        model: null,
        termination: CompletionTermination.TRUNCATED,
        responseId: 'p5-primary',
        usage: null,
      });
      expect(JSON.stringify(loggerMock.debug.mock.calls)).not.toContain('SECRET_SOURCE_TEXT');
      expect(JSON.stringify(loggerMock.debug.mock.calls)).not.toContain('SECRET_TRANSLATED_TEXT');
      expect(JSON.stringify(loggerMock.debug.mock.calls)).not.toContain('finish_reason');
      expect(JSON.stringify(loggerMock.debug.mock.calls)).not.toContain('choices');
      const completedLog = loggerMock.debug.mock.calls.find(([message]) => message.includes('Structured recovery completed'));
      expect(completedLog?.[1]).toMatchObject({
        classification: 'TRUNCATED_RESPONSE',
         strategy: 'FULL_STRUCTURED_RETRY',
        recoveredUnitCount: 2,
      });
    });

    it('keeps selective recovery for TRUNCATED plus reliably mapped invalid subset', async () => {
      const operation = createTranslationOperation('p5-truncated-selective');
      const completion = createCompletionRecord({
        provider: 'MockAI',
        termination: CompletionTermination.TRUNCATED,
        responseId: 'p5-selective-primary',
      });
      AIResponseParser.parseBatchResult.mockReturnValue({
        results: ['primary-a', 'invalid-b', 'primary-c'],
        contractViolation: true,
        invalidUnits: [{ requestIndex: 1, responseId: '1', violationCodes: ['EMPTY_TRANSLATED_TEXT'] }],
        mappingFacts: { identityReliable: true, complete: true, ambiguous: false },
      });
      provider._callAI = vi.fn().mockImplementation(async (_sys, _text, options) => {
        if (options.callPurpose === TranslationCallPurpose.PRIMARY_TRANSLATION) {
          recordProviderCompletion(options.executionContext, completion);
          return 'structured-primary';
        }
        return 'recovered-b';
      });

      const result = await provider._translateBatch(
        ['a', 'b', 'c'], 'en', 'fa', 'select-element', null, null, 'p5-truncated-selective', 'session-1',
        { executionContext: { operation } }, ResponseFormat.JSON_OBJECT
      );
      const recoveryCall = provider._callAI.mock.calls[1];
      const trigger = operation.finalize().entries.find(({ type }) => type === 'RECOVERY_TRIGGERED');

      expect(result).toEqual(['primary-a', 'recovered-b', 'primary-c']);
      expect(provider._callAI).toHaveBeenCalledTimes(2);
      expect(provider._callAI.mock.calls.map(([, , options]) => options.callPurpose)).toEqual([
        TranslationCallPurpose.PRIMARY_TRANSLATION,
        TranslationCallPurpose.STRUCTURED_RECOVERY,
      ]);
      expect(recoveryCall[1]).toContain('b');
      expect(trigger).toMatchObject({ classification: 'TRUNCATED_RESPONSE' });
      const recoveryLog = loggerMock.debug.mock.calls.find(([message]) => message.includes('Structured recovery triggered'));
      expect(recoveryLog?.[1]).toMatchObject({
        classification: 'TRUNCATED_RESPONSE',
        strategy: 'SELECTIVE',
        invalidUnitCount: 1,
        mappingFacts: { identityReliable: true, complete: true, ambiguous: false },
      });
      const completedLog = loggerMock.debug.mock.calls.find(([message]) => message.includes('Structured recovery completed'));
      expect(completedLog?.[1]).toMatchObject({
        classification: 'TRUNCATED_RESPONSE',
        strategy: 'SELECTIVE',
        recoveredUnitCount: 1,
      });
    });

    it('accepts TRUNCATED plus contract-valid structured output without recovery', async () => {
      const { AIResponseParser: realParser } = await vi.importActual('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult.mockImplementation(realParser.parseBatchResult.bind(realParser));
      const operation = createTranslationOperation('p5-truncated-valid');
      const completion = createCompletionRecord({
        provider: 'MockAI',
        termination: CompletionTermination.TRUNCATED,
        responseId: 'p5-valid-primary',
      });
      provider._callAI = vi.fn().mockImplementation(async (_sys, _text, options) => {
        recordProviderCompletion(options.executionContext, completion);
        return '[{"id":"0","text":"TA"},{"id":"1","text":"TB"}]';
      });

      const result = await provider._translateBatch(
        ['a', 'b'], 'en', 'fa', 'select-element', null, null, 'p5-truncated-valid', 'session-1',
        { executionContext: { operation } }, ResponseFormat.JSON_OBJECT
      );

      expect(result).toEqual(['TA', 'TB']);
      expect(provider._callAI).toHaveBeenCalledTimes(1);
      expect(operation.snapshotCompletions()).toEqual([
        expect.objectContaining({ termination: CompletionTermination.TRUNCATED }),
      ]);
      expect(operation.finalize().entries.some(({ type }) => type === 'RECOVERY_TRIGGERED')).toBe(false);
    });

    it('propagates TRUNCATED recovery failure without a second recovery pass', async () => {
      const { AIResponseParser: realParser } = await vi.importActual('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult.mockImplementation(realParser.parseBatchResult.bind(realParser));
      const operation = createTranslationOperation('p5-truncated-recovery-failure');
      const completion = createCompletionRecord({
        provider: 'MockAI',
        termination: CompletionTermination.TRUNCATED,
        responseId: 'p5-failed-primary',
      });
      const error = Object.assign(new Error('recovery transport failure'), { type: 'NETWORK_ERROR' });
      const sequentialSpy = vi.spyOn(provider, 'executeSequentialBatch');
      let callCount = 0;
      provider._callAI = vi.fn().mockImplementation(async (_sys, _text, options) => {
        callCount += 1;
        if (callCount === 1) {
          recordProviderCompletion(options.executionContext, completion);
          return '{"translations":';
        }
        throw error;
      });

      await expect(provider._translateBatch(
        ['a', 'b'], 'en', 'fa', 'select-element', null, null, 'p5-truncated-recovery-failure', 'session-1',
        { executionContext: { operation } }, ResponseFormat.JSON_OBJECT
      )).rejects.toBe(error);

      const entries = operation.finalize().entries;
      expect(callCount).toBe(2);
      expect(sequentialSpy).not.toHaveBeenCalled();
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'RECOVERY_TRIGGERED', classification: 'TRUNCATED_RESPONSE' }),
        expect.objectContaining({ type: 'RECOVERY_FAILED', code: 'NETWORK_ERROR' }),
      ]));
      expect(entries.some(({ type }) => type === 'RECOVERY_SUCCEEDED')).toBe(false);
    });

    it('keeps NORMAL plus equivalent parse failure on existing full recovery path', async () => {
      const { AIResponseParser: realParser } = await vi.importActual('./utils/AIResponseParser.js');
      AIResponseParser.parseBatchResult.mockImplementation(realParser.parseBatchResult.bind(realParser));
      const operation = createTranslationOperation('p5-normal-parse-failure');
      const completion = createCompletionRecord({
        provider: 'MockAI',
        termination: CompletionTermination.NORMAL,
        responseId: 'p5-normal-primary',
      });
      let callCount = 0;
      provider._callAI = vi.fn().mockImplementation(async (_sys, _text, options) => {
        callCount += 1;
        if (callCount === 1) {
          recordProviderCompletion(options.executionContext, completion);
          return '{"translations":';
        }
         return '{"translations":[{"id":"0","text":"normal-recovered-1"},{"id":"1","text":"normal-recovered-2"}]}';
      });

      const result = await provider._translateBatch(
        ['a', 'b'], 'en', 'fa', 'select-element', null, null, 'p5-normal-parse-failure', 'session-1',
        { executionContext: { operation } }, ResponseFormat.JSON_OBJECT
      );
      const trigger = operation.finalize().entries.find(({ type }) => type === 'RECOVERY_TRIGGERED');

      expect(result).toEqual(['normal-recovered-1', 'normal-recovered-2']);
       expect(callCount).toBe(2);
      expect(trigger).toMatchObject({ classification: 'PARSE_FAILURE' });
    });

    it('keeps unmigrated-provider recovery behavior without fabricating completion', async () => {
      const operation = createTranslationOperation('p5-absent-completion');
      AIResponseParser.parseBatchResult.mockReturnValue({
        results: ['primary-a', 'invalid-b'],
        contractViolation: true,
        invalidUnits: [{ requestIndex: 1, responseId: '1', violationCodes: ['EMPTY_TRANSLATED_TEXT'] }],
        mappingFacts: { identityReliable: true, complete: true, ambiguous: false },
      });
      provider._callAI = vi.fn()
        .mockResolvedValueOnce('structured-primary')
        .mockResolvedValueOnce('recovered-b');

      const result = await provider._translateBatch(
        ['a', 'b'], 'en', 'fa', 'select-element', null, null, 'p5-absent-completion', 'session-1',
        { executionContext: { operation } }, ResponseFormat.JSON_OBJECT
      );
      const trigger = operation.finalize().entries.find(({ type }) => type === 'RECOVERY_TRIGGERED');

      expect(result).toEqual(['primary-a', 'recovered-b']);
      expect(provider._callAI).toHaveBeenCalledTimes(2);
      expect(operation.snapshotCompletions()).toEqual([]);
      expect(trigger).toMatchObject({ classification: 'CONTRACT_VIOLATION' });
    });
  });

  describe('P7 bounded completion diagnostics', () => {
    it.each([
      ['short', 'resp-123', 'resp-123'],
      ['long', '1234567890123456789012345678901234567890', '12345678901234567890123456789012…'],
      ['absent', null, null],
    ])('formats %s responseId without changing stored completion', async (_label, responseId, loggedId) => {
      const operation = createTranslationOperation(`p7-response-id-${_label}`);
      const completion = createCompletionRecord({
        provider: 'MockAI',
        termination: CompletionTermination.NORMAL,
        responseId,
      });
      AIResponseParser.parseBatchResult.mockReturnValue({ results: ['translated'], contractViolation: false });
      provider._callAI = vi.fn().mockImplementation(async (_system, _text, options) => {
        recordProviderCompletion(options.executionContext, completion);
        return 'translated';
      });

      await provider._translateBatch(
        ['source'], 'en', 'fa', 'select-element', null, null, `p7-${_label}`, 'session-1',
        { executionContext: { operation } }, ResponseFormat.JSON_ARRAY
      );

      const relevantLogs = loggerMock.debug.mock.calls.filter(([message]) => message.includes('Provider completion record'));
      expect(relevantLogs).toHaveLength(1);
      expect(relevantLogs[0][1].responseId).toBe(loggedId);
      expect(operation.snapshotCompletions()[0].responseId).toBe(responseId);
      if (typeof responseId === 'string' && responseId.length > 32) {
        expect(JSON.stringify(relevantLogs[0])).not.toContain(responseId);
      }
    });

    it('does not retain logger calls from previous tests', async () => {
      const operation = createTranslationOperation('p7-logger-isolation');
      const completion = createCompletionRecord({
        provider: 'MockAI',
        termination: CompletionTermination.NORMAL,
        responseId: 'isolated-response',
      });
      AIResponseParser.parseBatchResult.mockReturnValue({ results: ['translated'], contractViolation: false });
      provider._callAI = vi.fn().mockImplementation(async (_system, _text, options) => {
        recordProviderCompletion(options.executionContext, completion);
        return 'translated';
      });

      await provider._translateBatch(
        ['source'], 'en', 'fa', 'select-element', null, null, 'p7-isolation', 'session-1',
        { executionContext: { operation } }, ResponseFormat.JSON_ARRAY
      );

      expect(loggerMock.debug.mock.calls.filter(([message]) => message.includes('Provider completion record'))).toHaveLength(1);
      expect(loggerMock.warn.mock.calls).toHaveLength(0);
    });
  });

  describe('_shouldUseStreaming', () => {
    it('should not use streaming for PDF mode', async () => {
      const shouldStream = await provider._shouldUseStreaming(['a', 'b'], 'msg-1', { name: 'engine' }, 'pdf-translation');
      expect(shouldStream).toBe(false);
    });
  });

  describe('_traditionalBatchTranslate', () => {
    it('should process segments sequentially', async () => {
      const texts = ['seg1', 'seg2'];
      const spy = vi.spyOn(provider, '_callAI');
      
      await provider._traditionalBatchTranslate(texts, 'en', 'fa', 'selection');

      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls.every(([, , options]) => options.callPurpose === TranslationCallPurpose.PRIMARY_TRANSLATION)).toBe(true);
    });
  });

  describe('_batchTranslate streaming ownership', () => {
    it('Select_Element with active outer stream does NOT use provider streaming', async () => {
      const { TranslationMode } = await import('@/shared/config/config.js');
      const streamingSpy = vi.spyOn(provider, '_streamingBatchTranslate').mockResolvedValue(['streamed']);
      const batchSpy = vi.spyOn(provider, '_translateBatch').mockResolvedValue(['batched']);
      const supportsSpy = vi.spyOn(provider, 'getSupportsStreaming').mockResolvedValue(true);
      const shouldSpy = vi.spyOn(provider, '_shouldUseStreaming').mockResolvedValue(false);
      const activeSpy = vi.spyOn(AIStreamManager, 'isStreamActive').mockReturnValue(true);
      const engine = {};

      try {
        const result = await provider._batchTranslate(['a','b'], 'en', 'fa', TranslationMode.Select_Element, engine, 'msg-select', null, null, null, null, {});
        expect(streamingSpy).not.toHaveBeenCalled();
        expect(batchSpy).toHaveBeenCalled();
        expect(result).toEqual(['batched']);
      } finally {
        streamingSpy.mockRestore();
        batchSpy.mockRestore();
        supportsSpy.mockRestore();
        shouldSpy.mockRestore();
        activeSpy.mockRestore();
      }
    });

    it('Page with active outer stream does NOT use provider streaming', async () => {
      const { TranslationMode } = await import('@/shared/config/config.js');
      const streamingSpy = vi.spyOn(provider, '_streamingBatchTranslate').mockResolvedValue(['streamed']);
      const batchSpy = vi.spyOn(provider, '_translateBatch').mockResolvedValue(['batched']);
      const supportsSpy = vi.spyOn(provider, 'getSupportsStreaming').mockResolvedValue(true);
      const shouldSpy = vi.spyOn(provider, '_shouldUseStreaming').mockResolvedValue(false);
      const activeSpy = vi.spyOn(AIStreamManager, 'isStreamActive').mockReturnValue(true);

      try {
        const result = await provider._batchTranslate(['a','b'], 'en', 'fa', TranslationMode.Page, {}, 'msg-page', null, null, null, null, {});
        expect(streamingSpy).not.toHaveBeenCalled();
        expect(batchSpy).toHaveBeenCalled();
        expect(result).toEqual(['batched']);
      } finally {
        streamingSpy.mockRestore();
        batchSpy.mockRestore();
        supportsSpy.mockRestore();
        shouldSpy.mockRestore();
        activeSpy.mockRestore();
      }
    });

    it('PDF with active outer stream does NOT use provider streaming', async () => {
      const { TranslationMode } = await import('@/shared/config/config.js');
      const streamingSpy = vi.spyOn(provider, '_streamingBatchTranslate').mockResolvedValue(['streamed']);
      const batchSpy = vi.spyOn(provider, '_translateBatch').mockResolvedValue(['batched']);
      const supportsSpy = vi.spyOn(provider, 'getSupportsStreaming').mockResolvedValue(true);
      const shouldSpy = vi.spyOn(provider, '_shouldUseStreaming').mockResolvedValue(false);
      const activeSpy = vi.spyOn(AIStreamManager, 'isStreamActive').mockReturnValue(true);

      try {
        const result = await provider._batchTranslate(['a','b'], 'en', 'fa', TranslationMode.PDF, {}, 'msg-pdf', null, null, null, null, {});
        expect(streamingSpy).not.toHaveBeenCalled();
        expect(batchSpy).toHaveBeenCalled();
        expect(result).toEqual(['batched']);
      } finally {
        streamingSpy.mockRestore();
        batchSpy.mockRestore();
        supportsSpy.mockRestore();
        shouldSpy.mockRestore();
        activeSpy.mockRestore();
      }
    });

    it('normal mode with already active stream and shouldUseStreaming false DOES use provider streaming', async () => {
      const streamingSpy = vi.spyOn(provider, '_streamingBatchTranslate').mockResolvedValue(['streamed']);
      const supportsSpy = vi.spyOn(provider, 'getSupportsStreaming').mockResolvedValue(true);
      const shouldSpy = vi.spyOn(provider, '_shouldUseStreaming').mockResolvedValue(false);
      const activeSpy = vi.spyOn(AIStreamManager, 'isStreamActive').mockReturnValue(true);

      try {
        const result = await provider._batchTranslate(['a','b'], 'en', 'fa', 'selection', {}, 'msg-normal', null, null, null, null, {});
        expect(streamingSpy).toHaveBeenCalled();
        expect(result).toEqual(['streamed']);
      } finally {
        streamingSpy.mockRestore();
        supportsSpy.mockRestore();
        shouldSpy.mockRestore();
        activeSpy.mockRestore();
      }
    });

    it('normal threshold streaming still enters', async () => {
      const streamingSpy = vi.spyOn(provider, '_streamingBatchTranslate').mockResolvedValue(['streamed']);
      const supportsSpy = vi.spyOn(provider, 'getSupportsStreaming').mockResolvedValue(true);
      const shouldSpy = vi.spyOn(provider, '_shouldUseStreaming').mockResolvedValue(true);
      const activeSpy = vi.spyOn(AIStreamManager, 'isStreamActive').mockReturnValue(false);

      try {
        const result = await provider._batchTranslate(['a','b','c'], 'en', 'fa', 'selection', {}, 'msg-threshold', null, null, null, null, {});
        expect(streamingSpy).toHaveBeenCalled();
        expect(result).toEqual(['streamed']);
      } finally {
        streamingSpy.mockRestore();
        supportsSpy.mockRestore();
        shouldSpy.mockRestore();
        activeSpy.mockRestore();
      }
    });

    it('returns OJH-owned results without intermediate AIStreamManager publication', async () => {
      const engine = {};
      const streamSpy = vi.spyOn(AIStreamManager, 'streamBatchResults').mockResolvedValue(undefined);
      const activeSpy = vi.spyOn(AIStreamManager, 'isStreamActive').mockReturnValue(true);
      const batchingSpy = vi.spyOn(provider, 'getBatchingConfig').mockResolvedValue({
        strategy: 'single',
        characterLimit: 5000,
      });
      const batchSpy = vi.spyOn(provider, '_translateBatch').mockResolvedValue(['private-result']);

      try {
        const result = await provider._streamingBatchTranslate(
          ['source'],
          'en',
          'fa',
          'selection',
          engine,
          'msg-ojh-owner',
          null,
          null,
          null,
          ResponseFormat.JSON_OBJECT,
          { executionContext: { resultPublicationOwner: 'optimized-json-handler' } },
        );

        expect(result).toEqual(['private-result']);
        expect(batchSpy).toHaveBeenCalledTimes(1);
        expect(streamSpy).not.toHaveBeenCalled();
      } finally {
        streamSpy.mockRestore();
        activeSpy.mockRestore();
        batchingSpy.mockRestore();
        batchSpy.mockRestore();
      }
    });

    it('publishes provider-owned streaming results through AIStreamManager', async () => {
      const engine = {};
      const streamSpy = vi.spyOn(AIStreamManager, 'streamBatchResults').mockResolvedValue(undefined);
      const activeSpy = vi.spyOn(AIStreamManager, 'isStreamActive').mockReturnValue(true);
      const batchingSpy = vi.spyOn(provider, 'getBatchingConfig').mockResolvedValue({
        strategy: 'single',
        characterLimit: 5000,
      });
      const batchSpy = vi.spyOn(provider, '_translateBatch').mockResolvedValue(['provider-result']);

      try {
        const result = await provider._streamingBatchTranslate(
          ['source'],
          'en',
          'fa',
          'selection',
          engine,
          'msg-provider-owner',
          null,
          null,
          null,
          ResponseFormat.JSON_OBJECT,
          {},
        );

        expect(result).toEqual(['provider-result']);
        expect(batchSpy).toHaveBeenCalledTimes(1);
        expect(streamSpy).toHaveBeenCalledWith(
          'MockAI',
          ['provider-result'],
          ['source'],
          0,
          'msg-provider-owner',
          engine,
          'en',
          'fa',
        );
      } finally {
        streamSpy.mockRestore();
        activeSpy.mockRestore();
        batchingSpy.mockRestore();
        batchSpy.mockRestore();
      }
    });
  });
});
