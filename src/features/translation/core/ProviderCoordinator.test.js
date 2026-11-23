import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock extension polyfill before anything else
vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: { getBrowserInfo: vi.fn(), getManifest: () => ({ version: '1.0.0' }) },
    storage: { local: { get: vi.fn(), set: vi.fn() } }
  }
}));

// Mock ErrorMatcher
vi.mock("@/shared/error-management/ErrorMatcher.js");

import { providerCoordinator } from './ProviderCoordinator.js';
import { streamingManager } from './StreamingManager.js';
import { queueManager } from './QueueManager.js';
import { PROVIDER_CONFIGURATIONS } from './ProviderConfigurations.js';
import { ResponseFormat } from "@/shared/config/translationConstants.js";
import { AUTO_DETECT_VALUE } from "@/shared/constants/core.js";
import { ErrorTypes } from "@/shared/error-management/ErrorTypes.js";
import { isFatalError, isTransientError, matchErrorToType } from "@/shared/error-management/ErrorMatcher.js";
import { TranslationCallPurpose } from '@/features/translation/providers/ProviderConstants.js';
import { createTranslationOperation } from '@/features/translation/ir/TranslationOperation.js';

// Mock dependencies
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

vi.mock("@/features/translation/providers/LanguageSwappingService.js", () => ({
  LanguageSwappingService: {
    applyLanguageSwapping: vi.fn((text, src, tgt) => Promise.resolve([src, tgt]))
  }
}));

vi.mock("@/shared/services/LanguageDetectionService.js", () => ({
  LanguageDetectionService: {
    detect: vi.fn(() => Promise.resolve('en')),
    registerDetectionResult: vi.fn()
  }
}));

vi.mock("@/features/translation/providers/utils/AIResponseParser.js", () => ({
  AIResponseParser: {
    cleanAIResponse: vi.fn((res) => res)
  }
}));

vi.mock("./QueueManager.js", () => ({
  queueManager: {
    enqueue: vi.fn((name, task) => task())
  }
}));

describe('ProviderCoordinator', () => {
  let mockProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Default mock behavior for ErrorMatcher
    matchErrorToType.mockReturnValue('API_ERROR');
    isFatalError.mockImplementation((err) => err?.message === 'FATAL');
    isTransientError.mockReturnValue(false);

    // Reset AIResponseParser to default identity function
    const { AIResponseParser } = await import("@/features/translation/providers/utils/AIResponseParser.js");
    AIResponseParser.cleanAIResponse.mockImplementation(res => res);

    mockProvider = {
      providerName: 'TestAI',
      constructor: { isAI: true, supportsStreaming: false },
      translate: vi.fn().mockResolvedValue('Translated Text'),
      convertLanguage: vi.fn(lang => lang)
    };
  });

  describe('Language Resolution', () => {
    it('should detect language when source is set to auto', async () => {
      const { LanguageDetectionService } = await import("@/shared/services/LanguageDetectionService.js");
      LanguageDetectionService.detect.mockResolvedValue('fr');

      const result = await providerCoordinator.execute(
        mockProvider, 'Bonjour', AUTO_DETECT_VALUE, 'en'
      );

      expect(LanguageDetectionService.detect).toHaveBeenCalled();
      expect(result.sourceLanguage).toBe('fr');
      expect(mockProvider.translate).toHaveBeenCalledWith(
        expect.anything(), 'fr', 'en', expect.anything()
      );
    });

    it('should preserve an authoritative operation-level language pair', async () => {
      const { LanguageDetectionService } = await import("@/shared/services/LanguageDetectionService.js");
      const { LanguageSwappingService } = await import("@/features/translation/providers/LanguageSwappingService.js");

      const results = await Promise.all([
        providerCoordinator.execute(mockProvider, 'Batch 1', 'en', 'fa', { languagePairResolved: true }),
        providerCoordinator.execute(mockProvider, 'Batch 2', 'en', 'fa', { languagePairResolved: true }),
        providerCoordinator.execute(mockProvider, 'Batch 3', 'en', 'fa', { languagePairResolved: true }),
        providerCoordinator.execute(mockProvider, 'Batch 4', 'en', 'fa', { languagePairResolved: true }),
      ]);

      expect(results).toHaveLength(4);
      expect(results.every(({ sourceLanguage, targetLanguage }) => sourceLanguage === 'en' && targetLanguage === 'fa')).toBe(true);
      expect(LanguageDetectionService.detect).not.toHaveBeenCalled();
      expect(LanguageSwappingService.applyLanguageSwapping).not.toHaveBeenCalled();
    });

    it('should retain explicit-source bilingual resolution without the authoritative flag', async () => {
      const { LanguageSwappingService } = await import("@/features/translation/providers/LanguageSwappingService.js");
      LanguageSwappingService.applyLanguageSwapping.mockResolvedValueOnce(['fa', 'de']);

      const result = await providerCoordinator.execute(mockProvider, 'Persian text', 'de', 'fa');

      expect(LanguageSwappingService.applyLanguageSwapping).toHaveBeenCalledTimes(1);
      expect(result.sourceLanguage).toBe('fa');
      expect(result.targetLanguage).toBe('de');
    });

    it('should not feed provider metadata into language detection caches', async () => {
      const { LanguageDetectionService } = await import("@/shared/services/LanguageDetectionService.js");
      LanguageDetectionService.detect.mockResolvedValue('en');

      const result = await providerCoordinator.execute(
        mockProvider, 'Guten Tag', AUTO_DETECT_VALUE, 'en'
      );

      expect(result.detectedLanguage).toBe('en');
      expect(LanguageDetectionService.registerDetectionResult).not.toHaveBeenCalled();
    });

    it('keeps provider metadata out of the public coordinator result', async () => {
      const operation = createTranslationOperation('coordinator-internal-metadata');
      mockProvider.translate.mockImplementation(async (_text, _source, _target, options) => {
        options.executionContext.operation.recordProviderExecutionMetadata({ detectedLanguage: 'en' });
        return 'Translated Text';
      });

      const result = await providerCoordinator.execute(
        mockProvider,
        'Hello',
        'en',
        'fa',
        { executionContext: { operation }, languagePairResolved: true },
      );

      expect(operation.snapshotAggregatedProviderMetadata()).toEqual({ detectedLanguage: 'en' });
      expect(result).not.toHaveProperty('providerMetadata');
      expect(result).not.toHaveProperty('metadata.provider');
    });

    it('does not leak stale detection state into explicit-source metadata', async () => {
      const result = await providerCoordinator.execute(
        mockProvider,
        'Guten Tag',
        'de',
        'en',
        { languagePairResolved: true },
      );

      expect(result.sourceLanguage).toBe('de');
      expect(result.detectedLanguage).toBe('de');
    });

    it('keeps concurrent response metadata request-local', async () => {
      const sharedProvider = {
        ...mockProvider,
        translate: vi.fn(async (text) => {
          if (text === 'request-a') {
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          return `translated-${text}`;
        }),
      };

      const [requestA, requestB] = await Promise.all([
        providerCoordinator.execute(sharedProvider, 'request-a', 'ja', 'en', {
          languagePairResolved: true,
          parallelExecution: true,
        }),
        providerCoordinator.execute(sharedProvider, 'request-b', 'ko', 'en', {
          languagePairResolved: true,
          parallelExecution: true,
        }),
      ]);

      expect(requestA.detectedLanguage).toBe('ja');
      expect(requestB.detectedLanguage).toBe('ko');
    });

    it('should not register feedback for Vajehyab auto lookups without verified detection', async () => {
      const { LanguageDetectionService } = await import("@/shared/services/LanguageDetectionService.js");

      mockProvider.providerName = 'Vajehyab';
      LanguageDetectionService.detect.mockResolvedValue('en');

      const result = await providerCoordinator.execute(
        mockProvider, 'test', AUTO_DETECT_VALUE, 'fa'
      );

      expect(LanguageDetectionService.registerDetectionResult).not.toHaveBeenCalled();
      expect(mockProvider.translate).toHaveBeenCalledWith(
        expect.anything(), 'en', 'fa', expect.anything()
      );
      expect(result.sourceLanguage).toBe('en');
    });

    it('should correctly extract sample text from V3 objects for language swapping', async () => {
      const { LanguageSwappingService } = await import("@/features/translation/providers/LanguageSwappingService.js");
      
      const v3Text = [
        { t: 'سلام دنیا', i: 'n1' },
        { t: 'چطوری؟', i: 'n2' }
      ];

      // Setup swap to happen if it detects 'fa' (Persian)
      LanguageSwappingService.applyLanguageSwapping.mockImplementation(async (sample) => {
        if (sample.includes('سلام')) {
          return ['fa', 'en']; // Swap to English
        }
        return ['en', 'fa'];
      });

      await providerCoordinator.execute(
        mockProvider, v3Text, 'en', 'fa'
      );

      // Verify that extracted text was passed to swapping service, not [object Object]
      expect(LanguageSwappingService.applyLanguageSwapping).toHaveBeenCalledWith(
        expect.stringContaining('سلام دنیا چطوری؟'),
        'en',
        'fa',
        'en',
        expect.anything()
      );
    });
  });

  describe('Queue retry policy snapshot', () => {
    it.each([
      ['GoogleTranslate', 3],
      ['GoogleTranslateV2', 3],
      ['MicrosoftEdge', 3],
    ])('passes configured RATE_LIMIT_REACHED budget for %s', async (providerName, maxExecutions) => {
      mockProvider.providerName = providerName;

      await providerCoordinator.execute(mockProvider, 'hello', 'en', 'fa');

      const options = queueManager.enqueue.mock.calls.at(-1)[4];
      expect(options.queueRetryPolicy).toEqual({
        maxExecutions: { RATE_LIMIT_REACHED: maxExecutions },
      });
    });

    it('does not pass Google policy to unrelated providers', async () => {
      mockProvider.providerName = 'OpenAI';

      await providerCoordinator.execute(mockProvider, 'hello', 'en', 'fa');

      const options = queueManager.enqueue.mock.calls.at(-1)[4];
      expect(options.queueRetryPolicy).toBeUndefined();
    });

    it('snapshots policy instead of retaining provider configuration reference', async () => {
      mockProvider.providerName = 'GoogleTranslate';
      const original = PROVIDER_CONFIGURATIONS.GoogleTranslate.queueRetryPolicy.maxExecutions.RATE_LIMIT_REACHED;

      try {
        await providerCoordinator.execute(mockProvider, 'hello', 'en', 'fa');
        const options = queueManager.enqueue.mock.calls.at(-1)[4];
        PROVIDER_CONFIGURATIONS.GoogleTranslate.queueRetryPolicy.maxExecutions.RATE_LIMIT_REACHED = 5;

        expect(options.queueRetryPolicy.maxExecutions.RATE_LIMIT_REACHED).toBe(3);
        expect(options.queueRetryPolicy).not.toBe(PROVIDER_CONFIGURATIONS.GoogleTranslate.queueRetryPolicy);
        expect(options.queueRetryPolicy.maxExecutions)
          .not.toBe(PROVIDER_CONFIGURATIONS.GoogleTranslate.queueRetryPolicy.maxExecutions);
      } finally {
        PROVIDER_CONFIGURATIONS.GoogleTranslate.queueRetryPolicy.maxExecutions.RATE_LIMIT_REACHED = original;
      }
    });
  });

  describe('Streaming initialization', () => {
    it('registers sender and initializes streaming for long AI requests', async () => {
      const messageId = 'streaming-message';
      const sender = { tab: { id: 123 }, frameId: 2 };
      const engine = { registerStreamingSender: vi.fn() };
      const initializeStream = vi.spyOn(streamingManager, 'initializeStream').mockImplementation(() => undefined);
      const longText = 'a'.repeat(501);

      await providerCoordinator.execute(
        {
          ...mockProvider,
          constructor: { isAI: true, supportsStreaming: true },
        },
        longText,
        'en',
        'fa',
        { messageId, engine, sender, languagePairResolved: true },
      );

      expect(engine.registerStreamingSender).toHaveBeenCalledWith(messageId, sender);
      expect(initializeStream).toHaveBeenCalledWith(
        messageId,
        sender,
        expect.objectContaining({ providerName: 'TestAI' }),
        [longText],
        undefined,
      );

      initializeStream.mockRestore();
    });
  });

  describe('Result Normalization', () => {
    it('should clean AI response using AIResponseParser', async () => {
      const { AIResponseParser } = await import("@/features/translation/providers/utils/AIResponseParser.js");
      AIResponseParser.cleanAIResponse.mockReturnValue('Cleaned Result');
      mockProvider.translate.mockResolvedValue('Dirty Result with AI Chatter');

      const result = await providerCoordinator.execute(
        mockProvider, 'Input Text', 'en', 'fa'
      );

      expect(AIResponseParser.cleanAIResponse).toHaveBeenCalledWith(
        'Dirty Result with AI Chatter', expect.anything()
      );
      expect(result.translatedText).toBe('Cleaned Result');
    });

    it('should ensure the final result is a string even if provider returns an object', async () => {
      mockProvider.translate.mockResolvedValue({ t: 'Extracted Text' });

      const result = await providerCoordinator.execute(
        mockProvider, 'Input', 'en', 'fa'
      );

      expect(result.translatedText).toBe('Extracted Text');
    });

    it('accepts same-cardinality traditional arrays positionally without provenance checks', async () => {
      mockProvider.constructor.isAI = false;
      mockProvider.providerName = 'GoogleTranslate';
      mockProvider.translate.mockResolvedValue(['TA', 'TC', 'TB']);

      const result = await providerCoordinator.execute(
        mockProvider, ['A', 'B', 'C'], 'en', 'fa'
      );

      expect(result.translatedText).toEqual(['TA', 'TC', 'TB']);
    });

    it('accepts deterministic structural reconstruction for traditional multi-input strings', async () => {
      mockProvider.constructor.isAI = false;
      mockProvider.providerName = 'GoogleTranslate';
      mockProvider.translate.mockResolvedValue('TA\n[[---]]\nTB');

      const result = await providerCoordinator.execute(
        mockProvider, ['A', 'B'], 'en', 'fa'
      );

      expect(result.translatedText).toEqual(['TA', 'TB']);
    });

    it.each([
      ['ambiguous mapping', 'TA TB', ['A', 'B']],
      ['incomplete structural mapping', 'TA\n[[---]]\nTB', ['A', 'B', 'C']],
    ])('converts %s to API_RESPONSE_INVALID', async (_label, translatedText, source) => {
      mockProvider.constructor.isAI = false;
      mockProvider.providerName = 'GoogleTranslate';
      mockProvider.translate.mockResolvedValue(translatedText);

      await expect(providerCoordinator.execute(
        mockProvider, source, 'en', 'fa'
      )).rejects.toMatchObject({ type: ErrorTypes.API_RESPONSE_INVALID });
    });

    it('does not classify ambiguous mapping as UNKNOWN transient failure', async () => {
      mockProvider.constructor.isAI = false;
      mockProvider.providerName = 'GoogleTranslate';
      mockProvider.translate.mockResolvedValue('TA TB');
      isTransientError.mockReturnValue(true);

      await expect(providerCoordinator.execute(
        mockProvider, ['A', 'B'], 'en', 'fa'
      )).rejects.toMatchObject({ type: ErrorTypes.API_RESPONSE_INVALID });
      expect(matchErrorToType).not.toHaveBeenCalled();
    });

    it('keeps single-input multi-part array normalization', async () => {
      mockProvider.constructor.isAI = false;
      mockProvider.providerName = 'GoogleTranslate';
      mockProvider.translate.mockResolvedValue(['Part 1', 'Part 2']);

      const result = await providerCoordinator.execute(
        mockProvider, 'Input', 'en', 'fa'
      );

      expect(result.translatedText).toBe('Part 1\nPart 2');
    });

    it('should handle array results by joining them if expected format is STRING', async () => {
      mockProvider.translate.mockResolvedValue(['Part 1', 'Part 2']);
      
      const result = await providerCoordinator.execute(
        mockProvider, 'Input', 'en', 'fa', { expectedFormat: ResponseFormat.STRING }
      );

      expect(result.translatedText).toBe('Part 1\nPart 2');
    });

    it('should pass recovery-shaped array through JSON_OBJECT cleaning without collapsing to empty string', async () => {
      mockProvider.translate.mockResolvedValue(['Bonjour']);

      const result = await providerCoordinator.execute(
        mockProvider, 'Input', 'en', 'fa', { expectedFormat: ResponseFormat.JSON_OBJECT }
      );

      expect(result.translatedText).toEqual(['Bonjour']);
      expect(result.translatedText).not.toBe('');
    });

    describe('JSON-wrapped output validation', () => {
      const executeWrapped = (source, providerResult) => {
        mockProvider.translate.mockResolvedValue(providerResult);
        return providerCoordinator._executeJsonWrapped(
          mockProvider,
          source,
          'en',
          'fa',
          'selection',
          {},
        );
      };

      it('reconstructs valid results while preserving metadata', async () => {
        const source = [
          { i: 'a', t: 'A', blockId: 'x' },
          { i: 'b', t: 'B', blockId: 'y' },
        ];

        const result = await executeWrapped(source, ['A2', 'B2']);

        expect(JSON.parse(result)).toEqual([
          { i: 'a', t: 'A2', blockId: 'x' },
          { i: 'b', t: 'B2', blockId: 'y' },
        ]);
      });

      it('accepts identity translation', async () => {
        const result = await executeWrapped([{ t: 'URL' }], ['URL']);

        expect(JSON.parse(result)).toEqual([{ t: 'URL' }]);
      });

      it.each(['', '   ', null, undefined, 0, 42, false, true, {}, []])(
        'rejects invalid nonblank result %p',
        async (value) => {
          await expect(executeWrapped([{ t: 'SOURCE' }], [value]))
            .rejects.toMatchObject({ type: ErrorTypes.API_RESPONSE_INVALID });
        },
      );

      it('rejects a sparse result slot', async () => {
        const results = [];
        results.length = 1;

        await expect(executeWrapped([{ t: 'SOURCE' }], results))
          .rejects.toMatchObject({ type: ErrorTypes.API_RESPONSE_INVALID });
      });

      it('preserves blank-source blank-output compatibility', async () => {
        const result = await executeWrapped([{ t: '' }], ['']);

        expect(JSON.parse(result)).toEqual([{ t: '' }]);
      });

      it.each([
        [[{ t: 'A' }, { t: 'B' }, { t: 'C' }], ['A2', 'B2']],
        [[{ t: 'A' }, { t: 'B' }], ['A2', 'B2', 'C2']],
      ])('rejects cardinality mismatch', async (source, providerResult) => {
        await expect(executeWrapped(source, providerResult))
          .rejects.toMatchObject({ type: ErrorTypes.API_RESPONSE_INVALID });
      });

      it('keeps rawJsonPayload calls on standard execution path', async () => {
        const jsonInput = JSON.stringify([{ t: 'SOURCE' }]);
        mockProvider.translate.mockResolvedValue('TRANSLATED');

        const result = await providerCoordinator.execute(
          mockProvider,
          jsonInput,
          'en',
          'fa',
          { rawJsonPayload: true },
        );

        expect(mockProvider.translate).toHaveBeenCalledWith(
          jsonInput,
          'en',
          'fa',
          expect.objectContaining({ rawJsonPayload: true }),
        );
        expect(result.translatedText).toBe('TRANSLATED');
      });
    });
  });

  describe('Error Resilience', () => {
    it('propagates operation abort without matcher classification', async () => {
      const operationAbort = Object.assign(new Error('operation stopped'), {
        name: 'AbortError',
        operationAborted: true,
        cancellationReason: 'operation-abort',
      });
      mockProvider.translate.mockRejectedValue(operationAbort);

      await expect(providerCoordinator.execute(
        mockProvider, 'Original Text', 'en', 'fa'
      )).rejects.toBe(operationAbort);

      expect(matchErrorToType).not.toHaveBeenCalled();
      expect(isTransientError).not.toHaveBeenCalled();
      expect(isFatalError).not.toHaveBeenCalled();
      expect(operationAbort).toMatchObject({
        operationAborted: true,
        cancellationReason: 'operation-abort',
      });
      expect(operationAbort.type).not.toBe(ErrorTypes.USER_CANCELLED);
    });

    it('preserves typed timeout AbortError without matcher classification', async () => {
      const timeoutError = Object.assign(new Error('timed out'), {
        name: 'AbortError',
        type: ErrorTypes.TRANSLATION_TIMEOUT,
      });
      mockProvider.translate.mockRejectedValue(timeoutError);

      await expect(providerCoordinator.execute(
        mockProvider, 'Original Text', 'en', 'fa'
      )).rejects.toBe(timeoutError);

      expect(matchErrorToType).not.toHaveBeenCalled();
      expect(timeoutError.type).toBe(ErrorTypes.TRANSLATION_TIMEOUT);
      expect(timeoutError.operationAborted).not.toBe(true);
      expect(isTransientError).toHaveBeenCalledWith(expect.objectContaining({
        type: ErrorTypes.TRANSLATION_TIMEOUT,
      }));
      expect(isFatalError).toHaveBeenCalledWith(expect.objectContaining({
        type: ErrorTypes.TRANSLATION_TIMEOUT,
      }));
    });

    it('continues matching ordinary untyped provider errors', async () => {
      const ordinaryError = new Error('Temporary API Error');
      mockProvider.translate.mockRejectedValue(ordinaryError);

      await expect(providerCoordinator.execute(
        mockProvider, 'Original Text', 'en', 'fa'
      )).rejects.toBe(ordinaryError);

      expect(matchErrorToType).toHaveBeenCalledWith(ordinaryError);
    });

    it('propagates explicit USER_CANCELLED without matcher classification', async () => {
      const userError = Object.assign(new Error('cancelled'), {
        type: ErrorTypes.USER_CANCELLED,
      });
      mockProvider.translate.mockRejectedValue(userError);

      await expect(providerCoordinator.execute(
        mockProvider, 'Original Text', 'en', 'fa'
      )).rejects.toBe(userError);

      expect(matchErrorToType).not.toHaveBeenCalled();
    });

    it('should throw if provider fails with a non-fatal non-transient error instead of fabricating success', async () => {
      mockProvider.translate.mockRejectedValue(new Error('Temporary API Error'));

      await expect(providerCoordinator.execute(
        mockProvider, 'Original Text', 'en', 'fa'
      )).rejects.toThrow('Temporary API Error');
    });

    it('should throw immediately if provider fails with a fatal error', async () => {
      const fatalError = new Error('FATAL');
      mockProvider.translate.mockRejectedValue(fatalError);

      await expect(providerCoordinator.execute(
        mockProvider, 'Original Text', 'en', 'fa'
      )).rejects.toThrow('FATAL');
    });
  });

  describe('Queue routing', () => {
    it('preserves explicit parent recovery purpose through queue/provider execution', async () => {
      await providerCoordinator.execute(mockProvider, 'Input Text', 'en', 'fa', {
        mode: 'select_element',
        callPurpose: TranslationCallPurpose.PARENT_RECOVERY,
        messageId: 'parent-recovery'
      });

      expect(mockProvider.translate).toHaveBeenCalledWith(
        'Input Text',
        'en',
        'fa',
        expect.objectContaining({ callPurpose: TranslationCallPurpose.PARENT_RECOVERY })
      );
    });

    it('should route parallel Select Element work through the parallel queue key', async () => {
      const result = await providerCoordinator.execute(
        mockProvider,
        'Input Text',
        'en',
        'fa',
        {
          mode: 'select_element',
          parallelExecution: true,
          messageId: 'msg-1'
        }
      );

      const { queueManager } = await import('./QueueManager.js');
      expect(queueManager.enqueue).toHaveBeenCalledWith(
        'TestAI::parallel',
        expect.any(Function),
        expect.any(Number),
        'select_element',
        expect.objectContaining({
          messageId: 'msg-1',
          parallelExecution: true
        })
      );
      expect(result.translatedText).toBe('Translated Text');
    });

    it('should keep the default provider queue key unchanged when parallelExecution is disabled', async () => {
      await providerCoordinator.execute(
        mockProvider,
        'Input Text',
        'en',
        'fa',
        {
          mode: 'page',
          messageId: 'msg-2'
        }
      );

      const { queueManager } = await import('./QueueManager.js');
      expect(queueManager.enqueue).toHaveBeenCalledWith(
        'TestAI',
        expect.any(Function),
        expect.any(Number),
        'page',
        expect.objectContaining({
          messageId: 'msg-2',
          parallelExecution: false
        })
      );
    });
  });
});
