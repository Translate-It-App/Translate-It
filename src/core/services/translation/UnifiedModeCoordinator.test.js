import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnifiedModeCoordinator } from './UnifiedModeCoordinator.js';
import { TranslationMode } from '@/shared/config/config.js';
import { RequestStatus } from './TranslationRequestTracker.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { TRANSLATION_BATCH_EXECUTION_TIMEOUT_MS } from '@/shared/constants/translation.js';
import { isFatalError, matchErrorToType } from '@/shared/error-management/ErrorMatcher.js';

// Mock RateLimitManager
vi.mock('@/features/translation/core/RateLimitManager.js', () => ({
  TranslationPriority: {
    HIGH: 10,
    NORMAL: 5,
    LOW: 1
  }
}));

// Mock ErrorMatcher
vi.mock('@/shared/error-management/ErrorMatcher.js');

describe('UnifiedModeCoordinator', () => {
  let coordinator;
  let mockEngine;

  beforeEach(() => {
    coordinator = new UnifiedModeCoordinator();
    mockEngine = {
      getProvider: vi.fn(),
      handleTranslateMessage: vi.fn(),
      lifecycleRegistry: {
        registerRequest: vi.fn(() => new AbortController()),
        unregisterRequest: vi.fn(),
        getCancellationReason: vi.fn(() => null)
      }
    };
  });

  describe('processRequest', () => {
    it('should set status to PROCESSING and assign priority', async () => {
      const request = {
        mode: TranslationMode.Field,
        data: {}
      };

      // Mock processFieldTranslation to avoid further depth in this test
      coordinator.processFieldTranslation = vi.fn().mockResolvedValue({ success: true });

      await coordinator.processRequest(request, { translationEngine: mockEngine });

      expect(request.status).toBe(RequestStatus.PROCESSING);
      expect(request.data.priority).toBe(10); // HIGH for Field mode
    });

    it('should assign LOW priority to Page and Select_Element modes', async () => {
      const request = { mode: TranslationMode.Page, data: {} };
      coordinator.processPageTranslation = vi.fn().mockResolvedValue({ success: true });
      await coordinator.processRequest(request, { translationEngine: mockEngine });
      expect(request.data.priority).toBe(1); // LOW
    });

    it('should assign LOW priority to PDF mode and dispatch through the PDF path', async () => {
      const request = {
        mode: TranslationMode.PDF,
        data: { text: JSON.stringify([{ text: 'hello' }]), provider: 'google' },
        messageId: 'm-pdf',
        context: 'pdf-translation'
      };

      coordinator.processPdfTranslation = vi.fn().mockResolvedValue({ success: true });
      await coordinator.processRequest(request, { translationEngine: mockEngine });

      expect(request.data.priority).toBe(1);
      expect(coordinator.processPdfTranslation).toHaveBeenCalledWith(request, { translationEngine: mockEngine });
    });

    it('should delegate to processFieldTranslation for Field mode', async () => {
      const request = {
        mode: TranslationMode.Field,
        data: {},
        messageId: 'm1',
        sender: { tab: { id: 1 } }
      };
      
      const expectedResult = { success: true, translatedText: 'hi' };
      mockEngine.handleTranslateMessage.mockResolvedValue(expectedResult);

      const result = await coordinator.processRequest(request, { translationEngine: mockEngine });

      expect(mockEngine.handleTranslateMessage).toHaveBeenCalled();
      expect(result).toBe(expectedResult);
    });

    it('should delegate to processPageTranslation for Page mode', async () => {
      const request = {
        mode: TranslationMode.Page,
        data: { text: JSON.stringify([{ text: 'hello' }]), provider: 'google' },
        messageId: 'm1'
      };

      const mockProvider = {
        translate: vi.fn().mockResolvedValue(['bonjour'])
      };
      mockEngine.getProvider.mockResolvedValue(mockProvider);

      const result = await coordinator.processRequest(request, { translationEngine: mockEngine });

      expect(result.success).toBe(true);
      expect(JSON.parse(result.translatedText)[0].text).toBe('bonjour');
    });

    it('should delegate to processStandardTranslation for other modes', async () => {
      const request = { mode: TranslationMode.Selection, data: { text: 'test' }, messageId: 'm1' };
      await coordinator.processRequest(request, { translationEngine: mockEngine });
      expect(mockEngine.handleTranslateMessage).toHaveBeenCalled();
    });
  });

  describe('processPageTranslation', () => {
    it.each([
      ['custom', true], ['openai', true], ['deepl', false], ['google', false],
    ])('opts independent Page batches into the parallel lane only for AI (%s)', async (provider, isAI) => {
      const providerInstance = {
        constructor: { isAI },
        translate: vi.fn().mockResolvedValue({ translatedText: ['translated'], sourceLanguage: 'en', targetLanguage: 'ja' }),
      };
      mockEngine.getProvider.mockResolvedValue(providerInstance);
      const result = await coordinator.processRequest({
        mode: TranslationMode.Page,
        messageId: `page-${provider}`,
        data: { provider, sourceLanguage: 'en', targetLanguage: 'ja', text: JSON.stringify([{ id: 'original-unit', text: 'source' }]) },
      }, { translationEngine: mockEngine });
      const options = providerInstance.translate.mock.calls[0][3];
      if (isAI) expect(options.parallelExecution).toBe(true);
      else expect(options).not.toHaveProperty('parallelExecution');
      expect(JSON.parse(result.translatedText)).toEqual([{ id: 'original-unit', text: 'translated' }]);
    });

    it('retains the ordinary lane for AI Subtitle batches', async () => {
      const providerInstance = { constructor: { isAI: true }, translate: vi.fn().mockResolvedValue(['translated']) };
      mockEngine.getProvider.mockResolvedValue(providerInstance);
      await coordinator.processRequest({
        mode: TranslationMode.Subtitle, messageId: 'subtitle',
        data: { provider: 'custom', sourceLanguage: 'en', targetLanguage: 'ja', items: [{ id: 'cue', text: 'source' }] },
      }, { translationEngine: mockEngine });
      expect(providerInstance.translate.mock.calls[0][3]).not.toHaveProperty('parallelExecution');
    });

    it('returns empty batches without provider or lifecycle work', async () => {
      const request = {
        mode: TranslationMode.Page,
        messageId: 'empty-batch',
        data: { text: JSON.stringify([]), provider: 'google' }
      };

      const result = await coordinator.processRequest(request, { translationEngine: mockEngine });

      expect(result).toMatchObject({ success: true, translatedText: '[]' });
      expect(mockEngine.getProvider).not.toHaveBeenCalled();
      expect(mockEngine.lifecycleRegistry.registerRequest).not.toHaveBeenCalled();
      expect(mockEngine.lifecycleRegistry.unregisterRequest).not.toHaveBeenCalled();
    });

    it('does not dispatch provider work when lifecycle registration was pre-cancelled', async () => {
      const request = {
        mode: TranslationMode.Page,
        messageId: 'pre-cancelled',
        data: { text: JSON.stringify([{ text: 'hello' }]), provider: 'google' }
      };
      const provider = { translate: vi.fn() };
      mockEngine.getProvider.mockResolvedValue(provider);
      mockEngine.lifecycleRegistry.registerRequest.mockReturnValue(null);

      const result = await coordinator.processRequest(request, { translationEngine: mockEngine });

       expect(result).toMatchObject({
         success: false,
         cancelled: true,
         error: { operationAborted: true, cancellationReason: 'operation-abort' },
       });
      expect(mockEngine.getProvider).not.toHaveBeenCalled();
      expect(provider.translate).not.toHaveBeenCalled();
    });

    it.each([
      ['document-replaced', { operationAborted: true, cancellationReason: 'document-replaced' }],
      ['user-cancelled', { type: 'USER_CANCELLED' }],
    ])('preserves %s pre-cancel provenance without dispatching provider work', async (reason, expectedError) => {
      const request = {
        mode: TranslationMode.Page,
        messageId: `pre-cancelled-${reason}`,
        data: { text: JSON.stringify([{ text: 'hello' }]), provider: 'google' }
      };
      const provider = { translate: vi.fn() };
      mockEngine.getProvider.mockResolvedValue(provider);
      mockEngine.lifecycleRegistry.registerRequest.mockReturnValue(null);
      mockEngine.lifecycleRegistry.getCancellationReason.mockReturnValue(reason);

      const result = await coordinator.processRequest(request, { translationEngine: mockEngine });

      expect(result).toMatchObject({ success: false, cancelled: true, error: expectedError });
      expect(mockEngine.getProvider).not.toHaveBeenCalled();
      expect(provider.translate).not.toHaveBeenCalled();
    });

    it('should handle array of segments correctly', async () => {
      const request = {
        mode: TranslationMode.Page,
        data: { 
          text: [{ text: 'p1' }, { text: 'p2' }], 
          provider: 'openai',
          sourceLanguage: 'en',
          targetLanguage: 'fa'
        },
        messageId: 'm-page'
      };

      const mockProvider = {
        translate: vi.fn().mockResolvedValue(['ت۱', 'ت۲'])
      };
      mockEngine.getProvider.mockResolvedValue(mockProvider);

      const result = await coordinator.processPageTranslation(request, { translationEngine: mockEngine });

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.translatedText);
      expect(parsed[0].text).toBe('ت۱');
      expect(parsed[1].text).toBe('ت۲');
      expect(mockProvider.translate).toHaveBeenCalledWith(
        ['p1', 'p2'], 'en', 'fa', expect.any(Object)
      );
    });

    it('should fallback to "auto" for source language in Page mode', async () => {
      const request = {
        mode: TranslationMode.Page,
        data: { text: [{ text: 'p1' }], provider: 'google', targetLanguage: 'fa' },
        messageId: 'm1'
      };
      const mockProvider = { translate: vi.fn().mockResolvedValue(['ت۱']) };
      mockEngine.getProvider.mockResolvedValue(mockProvider);

      await coordinator.processPageTranslation(request, { translationEngine: mockEngine });

      expect(mockProvider.translate).toHaveBeenCalledWith(
        ['p1'], 'auto', 'fa', expect.any(Object)
      );
    });

    it('should handle non-array response from provider', async () => {
      const request = {
        mode: TranslationMode.Page,
        data: { text: [{ text: 'p1' }], provider: 'google' },
        messageId: 'm1'
      };
      mockEngine.getProvider.mockResolvedValue({
        translate: vi.fn().mockResolvedValue({ translatedText: 'single' })
      });

      const result = await coordinator.processPageTranslation(request, { translationEngine: mockEngine });
      expect(JSON.parse(result.translatedText)[0].text).toBe('single');
    });

    it('should throw if no text provided', async () => {
      const request = { mode: TranslationMode.Page, data: {}, messageId: 'm1' };
      await expect(coordinator.processPageTranslation(request, { translationEngine: mockEngine }))
        .rejects.toThrow('No text provided');
    });

    it('should handle provider initialization failure', async () => {
      const request = { mode: TranslationMode.Page, data: { text: '["text"]', provider: 'invalid' }, messageId: 'm1' };
      mockEngine.getProvider.mockResolvedValue(null);
      await expect(coordinator.processPageTranslation(request, { translationEngine: mockEngine }))
        .rejects.toThrow("Provider 'invalid' initialization failed");
    });

    it('should handle provider errors and report failure with fallback content', async () => {
      const request = {
        mode: TranslationMode.Page,
        data: { text: [{ text: 'orig' }], provider: 'google' },
        messageId: 'm-err'
      };

      const providerError = new Error('API Down');
      Object.assign(providerError, {
        type: 'PROVIDER_ERROR',
        originalType: 'HTTP_ERROR',
        statusCode: 503,
        context: 'page-batch',
        providerName: 'Provider',
        providerId: 'provider-id',
        code: 'UPSTREAM_FAILURE',
        errorCode: 'E_UPSTREAM',
        translationOutcome: { partial: true },
        cause: 'private',
        arbitrary: { ignored: true }
      });
      mockEngine.getProvider.mockResolvedValue({
        translate: vi.fn().mockRejectedValue(providerError)
      });

      const result = await coordinator.processPageTranslation(request, { translationEngine: mockEngine });

      expect(result.success).toBe(false); // Failed batch reports failure, not fabricated success
      expect(result.hasError).toBe(true);
      expect(JSON.parse(result.translatedText)[0].text).toBe('orig');
      expect(result.error).toBe('API Down');
      expect(result.errorType).toBeDefined();
      expect(result.errorDetails).toMatchObject({
        message: 'API Down',
        type: 'PROVIDER_ERROR',
        originalType: 'HTTP_ERROR',
        statusCode: 503,
        context: 'page-batch',
        providerName: 'Provider',
        providerId: 'provider-id',
        code: 'UPSTREAM_FAILURE',
        errorCode: 'E_UPSTREAM',
        translationOutcome: { partial: true }
      });
      expect(result.errorDetails).not.toHaveProperty('cause');
      expect(result.errorDetails).not.toHaveProperty('arbitrary');
    });
  });

  describe('processSelectElementTranslation', () => {
    it('should enhance data with forceStreaming', async () => {
      const request = {
        mode: TranslationMode.Select_Element,
        data: { text: 'some text' },
        messageId: 'm-sel',
        sender: { tab: { id: 1 } }
      };

      await coordinator.processSelectElementTranslation(request, { translationEngine: mockEngine });

      expect(mockEngine.handleTranslateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            options: expect.objectContaining({ forceStreaming: true })
          })
        }),
        request.sender
      );
    });
  });

  describe('processFieldTranslation', () => {
    it('should call handleTranslateMessage with Field mode', async () => {
      const request = { mode: TranslationMode.Field, data: { text: 'hi' }, messageId: 'm1' };
      await coordinator.processFieldTranslation(request, { translationEngine: mockEngine });
      expect(mockEngine.handleTranslateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ mode: TranslationMode.Field })
        }),
        undefined
      );
    });
  });

  describe('per-session auto source-language resolution', () => {
    function pageBatchRequest({ sessionId, messageId, sourceLanguage, provider = 'google' }) {
      return {
        mode: TranslationMode.Page,
        messageId,
        sessionId,
        data: {
          text: JSON.stringify([{ text: 'p1' }, { text: 'p2' }]),
          provider,
          targetLanguage: 'fa',
          ...(sourceLanguage ? { sourceLanguage } : {})
        }
      };
    }

    const flush = () => new Promise(resolve => setTimeout(resolve, 5));

    function deferred() {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    }

    // Records each provider source argument and holds its response promise so
    // tests can orchestrate the exact resolution timing of concurrent batches.
    function deferredProvider() {
      return {
        sources: [],
        targets: [],
        options: [],
        pending: [],
        translate() {
          this.sources.push(arguments[1]);
          this.targets.push(arguments[2]);
          this.options.push(arguments[3]);
          const next = deferred();
          this.pending.push(next);
          return next.promise;
        },
        success(detectedLanguage, effectiveSourceLanguage = detectedLanguage, effectiveTargetLanguage = 'fa') {
          return {
            translatedText: ['ت۱', 'ت۲'],
            detectedLanguage,
            sourceLanguage: effectiveSourceLanguage,
            targetLanguage: effectiveTargetLanguage
          };
        }
      };
    }

    // Deterministic concurrency oracle: counts how many batches acquired the
    // per-session resolution slot, guaranteeing waiters are seated before tests
    // force a resolution outcome instead of racing against async startup.
    function spyAcquires(coordinator, sessionIds) {
      const original = coordinator._acquirePageSourceResolution.bind(coordinator);
      const counts = new Map(sessionIds.map(key => [key, 0]));
      coordinator._acquirePageSourceResolution = (...args) => {
        const outcome = original(...args);
        if (counts.has(args[0])) counts.set(args[0], counts.get(args[0]) + 1);
        return outcome;
      };
      return {
        countAt: (key) => counts.get(key) || 0,
        restore: () => { coordinator._acquirePageSourceResolution = original; }
      };
    }

    async function waitForAcquires(spy, key, count) {
      for (let i = 0; i < 400 && spy.countAt(key) < count; i++) {
        await flush();
      }
      expect(spy.countAt(key)).toBe(count);
      await flush();
    }

    describe('Concurrency race', () => {
      it('issues exactly one concurrent "auto" call; waiters resume with the resolved language', async () => {
        const provider = deferredProvider();
        mockEngine.getProvider.mockResolvedValue(provider);
        const spy = spyAcquires(coordinator, ['s1']);

        const raceA = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm1' }), { translationEngine: mockEngine });
        const raceB = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm2' }), { translationEngine: mockEngine });
        const raceC = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm3' }), { translationEngine: mockEngine });

        await waitForAcquires(spy, 's1', 3);
        expect(provider.sources).toEqual(['auto']);
        expect(provider.pending).toHaveLength(1);

        // Owner resolves with request-local detection.
        provider.pending[0].resolve(provider.success('en'));
        await flush();
        await flush();

        expect(provider.sources).toEqual(['auto', 'en', 'en']);
        expect(provider.targets).toEqual(['fa', 'fa', 'fa']);

        // Only the owner resolves the session source; established waiters pass
        // languagePairResolved so ProviderCoordinator skips semantic swap/detect.
        expect(provider.options[0].languagePairResolved).toBeUndefined();
        expect(provider.options[1].languagePairResolved).toBe(true);
        expect(provider.options[2].languagePairResolved).toBe(true);

        provider.pending[1].resolve(provider.success('en'));
        provider.pending[2].resolve(provider.success('en'));
        const results = await Promise.all([raceA, raceB, raceC]);
        results.forEach(r => expect(r.success).toBe(true));

        expect(provider.sources.filter(s => s === 'auto')).toEqual(['auto']);
        spy.restore();
      });

      it('propagates target-changing bilingual pair to Page waiters', async () => {
        const provider = deferredProvider();
        mockEngine.getProvider.mockResolvedValue(provider);
        const spy = spyAcquires(coordinator, ['s1']);

        const owner = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm-owner' }), { translationEngine: mockEngine });
        const waiter = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm-waiter' }), { translationEngine: mockEngine });

        await waitForAcquires(spy, 's1', 2);
        expect(provider.sources).toEqual(['auto']);
        expect(provider.targets).toEqual(['fa']);

        // ProviderCoordinator has already applied bilingual semantics: fa -> en.
        provider.pending[0].resolve(provider.success('fa', 'fa', 'en'));
        await flush();
        await flush();

        expect(provider.sources).toEqual(['auto', 'fa']);
        expect(provider.targets).toEqual(['fa', 'en']);
        expect(provider.options[1].languagePairResolved).toBe(true);

        provider.pending[1].resolve(provider.success('fa', 'fa', 'en'));
        await Promise.all([owner, waiter]);
        spy.restore();
      });
    });

    describe('Ambiguous detection regression', () => {
      it('provides a stable resolved language to sibling batches that would otherwise misdetect', async () => {
        const provider = deferredProvider();
        mockEngine.getProvider.mockResolvedValue(provider);
        const spy = spyAcquires(coordinator, ['s1']);

        // Owner batch is English; the two siblings would naively detect it/sv.
        const owner = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm-owner' }), { translationEngine: mockEngine });
        const itLike = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm-it' }), { translationEngine: mockEngine });
        const svLike = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm-sv' }), { translationEngine: mockEngine });

        await waitForAcquires(spy, 's1', 3);
        expect(provider.sources).toEqual(['auto']);
        provider.pending[0].resolve(provider.success('en'));
        await flush();
        await flush();

        expect(provider.sources).toEqual(['auto', 'en', 'en']);
        expect(provider.sources.includes('it')).toBe(false);
        expect(provider.sources.includes('sv')).toBe(false);

        provider.pending[1].resolve(provider.success('en'));
        provider.pending[2].resolve(provider.success('en'));
        await Promise.all([owner, itLike, svLike]);
        spy.restore();
      });
    });

    describe('Resolution failure', () => {
      it('hands a successful unresolved AUTO batch to one waiting owner without failing siblings', async () => {
        const sources = [];
        const first = deferred();
        const provider = {
          translate: vi.fn(async (_items, source) => {
            sources.push(source);
            if (sources.length === 1) await first.promise;
            return { translatedText: ['first', 'second'], sourceLanguage: sources.length === 1 ? 'auto' : 'en', targetLanguage: 'fa' };
          }),
        };
        mockEngine.getProvider.mockResolvedValue(provider);
        const spy = spyAcquires(coordinator, ['handoff']);
        const pending = Array.from({ length: 4 }, (_, index) => coordinator.processRequest(
          pageBatchRequest({ sessionId: 'handoff', messageId: `handoff-${index}` }), { translationEngine: mockEngine }
        ));
        await waitForAcquires(spy, 'handoff', 4);
        first.resolve();
        const results = await Promise.all(pending);
        expect(results.map(result => result.success)).toEqual([true, true, true, true]);
        expect(sources).toEqual(['auto', 'auto', 'en', 'en']);
        expect(provider.translate).toHaveBeenCalledTimes(4);
        expect(coordinator.pageSourceResolvers.get('handoff').effectiveSourceLanguage).toBe('en');
      });

      it('consumes each successful no-pair batch once with one AUTO owner per handoff', async () => {
        let activeAuto = 0;
        let maximumAuto = 0;
        const provider = {
          translate: vi.fn(async () => {
            maximumAuto = Math.max(maximumAuto, ++activeAuto);
            await Promise.resolve();
            activeAuto--;
            return { translatedText: ['first', 'second'], sourceLanguage: 'auto', targetLanguage: 'fa' };
          }),
        };
        mockEngine.getProvider.mockResolvedValue(provider);
        const results = await Promise.all(Array.from({ length: 8 }, (_, index) => coordinator.processRequest(
          pageBatchRequest({ sessionId: 'all-unresolved', messageId: `unresolved-${index}` }), { translationEngine: mockEngine }
        )));
        expect(results.every(result => result.success)).toBe(true);
        expect(provider.translate).toHaveBeenCalledTimes(8);
        expect(maximumAuto).toBe(1);
        expect(coordinator.pageSourceResolvers.get('all-unresolved').effectiveSourceLanguage).toBeNull();
        coordinator.clearPageSourceLanguage('all-unresolved');
        expect(coordinator.pageSourceResolvers.size).toBe(0);
      });

      it('releases a successful owner before local output transformation can fail', async () => {
        const first = deferred();
        let calls = 0;
        const provider = { translate: vi.fn(async () => {
          if (++calls === 1) await first.promise;
          return { translatedText: ['first', 'second'], sourceLanguage: calls === 1 ? 'auto' : 'en', targetLanguage: 'fa' };
        }) };
        mockEngine.getProvider.mockResolvedValue(provider);
        const spy = spyAcquires(coordinator, ['s1']);
        const owner = coordinator._processGenericBatch(
          pageBatchRequest({ sessionId: 's1', messageId: 'transform-owner' }), { translationEngine: mockEngine },
          { mode: TranslationMode.Page, items: ['p1', 'p2'], transformOutput: () => { throw new Error('local output failure'); } }
        );
        const rejection = expect(owner).rejects.toThrow('local output failure');
        const waiter = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'healthy-waiter' }), { translationEngine: mockEngine });
        await waitForAcquires(spy, 's1', 2);
        first.resolve();
        await rejection;
        await expect(waiter).resolves.toMatchObject({ success: true });
        expect(provider.translate).toHaveBeenCalledTimes(2);
        expect(coordinator.pageSourceResolvers.get('s1').effectiveSourceLanguage).toBe('en');
      });

      it('releases concurrent waiters, clears state, and allows a fresh resolver', async () => {
        const provider = deferredProvider();
        mockEngine.getProvider.mockResolvedValue(provider);
        const spy = spyAcquires(coordinator, ['s1']);

        const owner = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm1' }), { translationEngine: mockEngine });
        const waiter = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm2' }), { translationEngine: mockEngine });

        await waitForAcquires(spy, 's1', 2);
        expect(provider.sources).toEqual(['auto']);
        expect(provider.pending).toHaveLength(1);

        // Owner fails -> its resolution rejects and the waiter is released.
        provider.pending[0].reject(new Error('API Down'));
        const [ownerResult, waiterResult] = await Promise.all([owner, waiter]);

        expect(ownerResult.success).toBe(false);
        expect(waiterResult.success).toBe(false);
        expect(coordinator.pageSourceResolvers.has('s1')).toBe(false);

        // A later attempt may become resolver again.
        const retry = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm3' }), { translationEngine: mockEngine });
        await flush();
        await flush();
        expect(provider.sources).toEqual(['auto', 'auto']);
        provider.pending[1].resolve(provider.success('en'));
        await retry;
        expect(coordinator.pageSourceResolvers.get('s1').effectiveSourceLanguage).toBe('en');
        spy.restore();
      });
    });

    describe('Cancellation', () => {
      it.each(['user-cancelled', 'document-replaced'])('releases only the %s waiter without dispatching or cancelling healthy siblings', async reason => {
        const provider = deferredProvider();
        mockEngine.getProvider.mockResolvedValue(provider);
        const controllers = new Map();
        mockEngine.lifecycleRegistry.registerRequest.mockImplementation(messageId => {
          const controller = new AbortController();
          controllers.set(messageId, controller);
          return controller;
        });
        const spy = spyAcquires(coordinator, ['s1']);
        const pending = Array.from({ length: 4 }, (_, index) => coordinator.processRequest(
          pageBatchRequest({ sessionId: 's1', messageId: `cancel-${index}` }), { translationEngine: mockEngine }
        ));
        await waitForAcquires(spy, 's1', 4);
        const signal = controllers.get('cancel-1').signal;
        const removeListener = vi.spyOn(signal, 'removeEventListener');
        controllers.get('cancel-1').abort(reason);
        const result = await pending[1];
        expect(result.success).toBe(false);
        if (reason === 'document-replaced') expect(result.suppressed).toBe(true);
        else expect(result.errorType).toBe(ErrorTypes.USER_CANCELLED);
        expect(mockEngine.lifecycleRegistry.unregisterRequest).toHaveBeenCalledWith('cancel-1');
        expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
        expect(provider.sources).toEqual(['auto']);
        provider.pending[0].resolve(provider.success('en'));
        await flush(); await flush();
        expect(provider.sources).toEqual(['auto', 'en', 'en']);
        provider.pending[1].resolve(provider.success('en'));
        provider.pending[2].resolve(provider.success('en'));
        const results = await Promise.all(pending);
        expect(results.map(item => item.success)).toEqual([true, false, true, true]);
      });

      it('times out source-resolution waiting with the same typed batch deadline', async () => {
        vi.useFakeTimers();
        try {
          const owner = coordinator._acquirePageSourceResolution('waiting-timeout');
          const provider = { translate: vi.fn() };
          mockEngine.getProvider.mockResolvedValue(provider);
          const pending = coordinator.processRequest(pageBatchRequest({ sessionId: 'waiting-timeout', messageId: 'waiter-timeout' }), { translationEngine: mockEngine });
          let result;
          pending.then(value => { result = value; });
          await vi.advanceTimersByTimeAsync(TRANSLATION_BATCH_EXECUTION_TIMEOUT_MS - 1);
          expect(result).toBeUndefined();
          await vi.advanceTimersByTimeAsync(1);
          await expect(pending).resolves.toMatchObject({ success: false, errorType: ErrorTypes.TRANSLATION_TIMEOUT });
          expect(provider.translate).not.toHaveBeenCalled();
          expect(mockEngine.lifecycleRegistry.unregisterRequest).toHaveBeenCalledWith('waiter-timeout');
          expect(coordinator.pageSourceResolvers.get('waiting-timeout')).toBe(owner.state);
          coordinator.clearPageSourceLanguage('waiting-timeout');
        } finally { vi.useRealTimers(); }
      });

      it('does not resurrect a cleared session between a successful handoff and reacquisition', async () => {
        const first = deferred();
        const provider = { translate: vi.fn(async () => {
          await first.promise;
          return { translatedText: ['first', 'second'], sourceLanguage: 'auto', targetLanguage: 'fa' };
        }) };
        mockEngine.getProvider.mockResolvedValue(provider);
        const finalize = coordinator._finalizePageSourceResolution.bind(coordinator);
        vi.spyOn(coordinator, '_finalizePageSourceResolution').mockImplementation((...args) => {
          finalize(...args);
          coordinator.clearPageSourceLanguage('s1');
        });
        const spy = spyAcquires(coordinator, ['s1']);
        const pending = Array.from({ length: 4 }, (_, index) => coordinator.processRequest(
          pageBatchRequest({ sessionId: 's1', messageId: `clear-handoff-${index}` }), { translationEngine: mockEngine }
        ));
        await waitForAcquires(spy, 's1', 4);
        first.resolve();
        const results = await Promise.all(pending);
        expect(results.map(result => result.success)).toEqual([true, false, false, false]);
        expect(provider.translate).toHaveBeenCalledTimes(1);
        expect(coordinator.pageSourceResolvers.size).toBe(0);
      });

      it('terminates a waiter, clears state, and ignores a late owner result', async () => {
        const provider = deferredProvider();
        mockEngine.getProvider.mockResolvedValue(provider);
        const spy = spyAcquires(coordinator, ['s1']);

        const owner = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm1' }), { translationEngine: mockEngine });
        const waiter = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm2' }), { translationEngine: mockEngine });

        await waitForAcquires(spy, 's1', 2);
        expect(provider.sources).toEqual(['auto']);

        // Terminal lifecycle fires (cancel/restore): waiters must terminate.
        coordinator.clearPageSourceLanguage('s1');
        expect(coordinator.pageSourceResolvers.has('s1')).toBe(false);

        // Late owner completion must not resurrect the cleared session lock.
        provider.pending[0].resolve(provider.success('en'));
        await flush();
        expect(coordinator.pageSourceResolvers.has('s1')).toBe(false);

        const waiterResult = await waiter;
        expect(waiterResult.success).toBe(false);
        await owner;
        spy.restore();
      });

      it('a waiter resumes with the confirmed language and its own provider call completes after terminal clear', async () => {
        const provider = deferredProvider();
        mockEngine.getProvider.mockResolvedValue(provider);
        const spy = spyAcquires(coordinator, ['s1']);

        const owner = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm1' }), { translationEngine: mockEngine });
        const waiter = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm2' }), { translationEngine: mockEngine });

        await waitForAcquires(spy, 's1', 2);
        expect(provider.sources).toEqual(['auto']);

        // Owner confirms the session language from its request-local detection.
        provider.pending[0].resolve(provider.success('en'));
        await flush();
        await flush();

        // Waiter wakes with 'en' (not 'auto') and issues its own provider call.
        expect(provider.sources).toEqual(['auto', 'en']);
        expect(provider.pending).toHaveLength(2);

        // Terminal lifecycle fires after the waiter's call is already in flight:
        // like any in-flight batch, the call is not retroactively cancelled by the
        // session lock clear; the waiter simply never issues an 'auto' re-issue.
        coordinator.clearPageSourceLanguage('s1');
        expect(coordinator.pageSourceResolvers.has('s1')).toBe(false);

        provider.pending[1].resolve(provider.success('en'));
        const [ownerResult, waiterResult] = await Promise.all([owner, waiter]);
        expect(ownerResult.success).toBe(true);
        expect(waiterResult.success).toBe(true);
        expect(provider.sources.filter(s => s === 'auto')).toEqual(['auto']);
        spy.restore();
      });

      it('never emits an unhandled rejection from a cancelled resolution promise', async () => {
        const provider = deferredProvider();
        mockEngine.getProvider.mockResolvedValue(provider);
        const unhandled = [];
        const onUnhandled = (event) => unhandled.push(event.reason);
        process.on('unhandledRejection', onUnhandled);

        try {
          // Owner acquires the lock but never spawns a waiter to attach to the
          // resolution promise. The promise is rejected by a terminal clear; the
          // defensive `.catch(() => {})` must swallow it.
          const owner = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm1' }), { translationEngine: mockEngine });
          await flush();
          expect(provider.pending).toHaveLength(1);

          coordinator.clearPageSourceLanguage('s1');
          await flush();

          provider.pending[0].resolve(provider.success('en'));
          await owner.catch(() => {});
          await flush();
        } finally {
          process.off('unhandledRejection', onUnhandled);
        }

        expect(unhandled).toHaveLength(0);
      });
    });

    describe('Session isolation', () => {
      it('resolves two page sessions independently', async () => {
        const provider = deferredProvider();
        mockEngine.getProvider.mockResolvedValue(provider);
        const spy = spyAcquires(coordinator, ['s1', 's2']);

        const sessionA = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm1' }), { translationEngine: mockEngine });
        const sessionB = coordinator.processRequest(pageBatchRequest({ sessionId: 's2', messageId: 'm2' }), { translationEngine: mockEngine });

        await waitForAcquires(spy, 's1', 1);
        await waitForAcquires(spy, 's2', 1);
        expect(provider.sources).toEqual(['auto', 'auto']);

        provider.pending[0].resolve(provider.success('en'));
        provider.pending[1].resolve(provider.success('sv'));
        await Promise.all([sessionA, sessionB]);

        expect(coordinator.pageSourceResolvers.get('s1').effectiveSourceLanguage).toBe('en');
        expect(coordinator.pageSourceResolvers.get('s2').effectiveSourceLanguage).toBe('sv');
        spy.restore();
      });
    });

    describe('Explicit source language', () => {
      it('passes "de" for every concurrent batch and creates no resolver state', async () => {
        const provider = deferredProvider();
        mockEngine.getProvider.mockResolvedValue(provider);

        const batch1 = coordinator.processRequest(
          pageBatchRequest({ sessionId: 's1', messageId: 'm1', sourceLanguage: 'de' }),
          { translationEngine: mockEngine }
        );
        const batch2 = coordinator.processRequest(
          pageBatchRequest({ sessionId: 's1', messageId: 'm2', sourceLanguage: 'de' }),
          { translationEngine: mockEngine }
        );

        await vi.waitFor(() => {
          expect(provider.sources).toEqual(['de', 'de']);
        });
        expect(provider.sources).toEqual(['de', 'de']);
        expect(coordinator.pageSourceResolvers.size).toBe(0);
        // Explicit source is not semantic resolution: no languagePairResolved.
        expect(provider.options.every((o) => o.languagePairResolved === undefined)).toBe(true);

        provider.pending[0].resolve(provider.success('de'));
        provider.pending[1].resolve(provider.success('de'));
        await Promise.all([batch1, batch2]);
      });
    });

    describe('Other modes unaffected', () => {
      it('Subtitle batches keep per-batch auto behavior', async () => {
        const provider = deferredProvider();
        mockEngine.getProvider.mockResolvedValue(provider);

        const request = { mode: TranslationMode.Subtitle, messageId: 'm1', data: { provider: 'google', sourceLanguage: 'auto', targetLanguage: 'fa' }, items: [{ id: 'A', text: 'A' }] };
        const request2 = { mode: TranslationMode.Subtitle, messageId: 'm2', data: { provider: 'google', sourceLanguage: 'auto', targetLanguage: 'fa' }, items: [{ id: 'A', text: 'A' }] };
        const workload = (req) => coordinator._processGenericBatch(
          { ...req, data: { ...req.data } },
          { translationEngine: mockEngine },
          { mode: TranslationMode.Subtitle, items: req.items, useRawItems: true, transformOutput: (results) => results }
        );

        const r1 = workload(request);
        const r2 = workload(request2);
        await flush();
        await flush();
        expect(provider.sources).toEqual(['auto', 'auto']);
        // Subtitle keeps per-batch AUTO: never resolved at session level.
        expect(provider.options.every((o) => o.languagePairResolved === undefined)).toBe(true);

        provider.pending[0].resolve(provider.success('de'));
        provider.pending[1].resolve(provider.success('de'));
        await Promise.all([r1, r2]);

        expect(coordinator.pageSourceResolvers.size).toBe(0);
      });

      it('Select Element, Popup, Field and Selection never create resolver state', async () => {
        mockEngine.handleTranslateMessage.mockResolvedValue({ success: true });

        await coordinator.processSelectElementTranslation(
          { mode: TranslationMode.Select_Element, messageId: 'm-sel', data: { text: 'x' } },
          { translationEngine: mockEngine }
        );
        await coordinator.processFieldTranslation(
          { messageId: 'm-field', data: { text: 'x' } },
          { translationEngine: mockEngine }
        );
        await coordinator.processStandardTranslation(
          { messageId: 'm-pop', data: { text: 'x', mode: TranslationMode.Selection } },
          { translationEngine: mockEngine }
        );

        expect(coordinator.pageSourceResolvers.size).toBe(0);
      });
    });

    describe('Lifecycle cleanup', () => {
      it('a complete page session removes its resolution state', async () => {
        const provider = deferredProvider();
        mockEngine.getProvider.mockResolvedValue(provider);

        const first = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm1' }), { translationEngine: mockEngine });
        await flush();
        provider.pending[0].resolve(provider.success('en'));
        await first;
        expect(coordinator.pageSourceResolvers.get('s1').effectiveSourceLanguage).toBe('en');

        // Terminal completion clears the resolved session.
        coordinator.clearPageSourceLanguage('s1');
        expect(coordinator.pageSourceResolvers.has('s1')).toBe(false);

        // Next batch on the same id starts fresh with auto.
        const nextBatch = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm2' }), { translationEngine: mockEngine });
        await flush();
        await flush();
        expect(provider.sources).toEqual(['auto', 'auto']);
        provider.pending[1].resolve(provider.success('fr'));
        await nextBatch;
      });

      it('a cancelled page session removes its resolution state', async () => {
        const provider = deferredProvider();
        mockEngine.getProvider.mockResolvedValue(provider);

        const batch = coordinator.processRequest(pageBatchRequest({ sessionId: 's2', messageId: 'm1' }), { translationEngine: mockEngine });
        await flush();
        expect(coordinator.pageSourceResolvers.has('s2')).toBe(true);

        coordinator.clearPageSourceLanguage('s2');
        expect(coordinator.pageSourceResolvers.has('s2')).toBe(false);

        // Settle the owner call late; it must not recreate the lock.
        provider.pending[0].resolve(provider.success('fr'));
        await batch;
        expect(coordinator.pageSourceResolvers.size).toBe(0);
      });
    });

    it('reuses the first provider-confirmed language for later auto batches', async () => {
      const provider = deferredProvider();
      mockEngine.getProvider.mockResolvedValue(provider);

      const first = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm1' }), { translationEngine: mockEngine });
      await flush();
      provider.pending[0].resolve(provider.success('en'));
      await first;
      expect(coordinator.pageSourceResolvers.get('s1').effectiveSourceLanguage).toBe('en');

      const second = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm2' }), { translationEngine: mockEngine });
      await flush();
      expect(provider.sources).toEqual(['auto', 'en']);
      provider.pending[1].resolve(provider.success('en'));
      await second;
      expect(coordinator.pageSourceResolvers.get('s1').effectiveSourceLanguage).toBe('en');
    });

    it('does not leak the lock across different sessions', async () => {
      const provider = deferredProvider();
      mockEngine.getProvider.mockResolvedValue(provider);

      const s1 = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm1' }), { translationEngine: mockEngine });
      await flush();
      provider.pending[0].resolve(provider.success('en'));
      await s1;

      const s2 = coordinator.processRequest(pageBatchRequest({ sessionId: 's2', messageId: 'm2' }), { translationEngine: mockEngine });
      await flush();
      expect(provider.sources).toEqual(['auto', 'auto']);
      provider.pending[1].resolve(provider.success('sv'));
      await s2;
      expect(coordinator.pageSourceResolvers.get('s2').effectiveSourceLanguage).toBe('sv');
    });

    it('leaves the session unlocked when the owner never confirms a language', async () => {
      const provider = deferredProvider();
      mockEngine.getProvider.mockResolvedValue(provider);

      // The empty session record keeps clear/handoff identity, without a pending owner or cached pair.
      const first = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm1' }), { translationEngine: mockEngine });
      await flush();
      provider.pending[0].resolve({ translatedText: ['ت۱', 'ت۲'] });
      await first;
      expect(coordinator.pageSourceResolvers.get('s1')).toMatchObject({
        effectiveSourceLanguage: null,
        effectiveTargetLanguage: null,
        resolutionPromise: null,
      });

      const second = coordinator.processRequest(pageBatchRequest({ sessionId: 's1', messageId: 'm2' }), { translationEngine: mockEngine });
      await flush();
      expect(provider.sources).toEqual(['auto', 'auto']);
      provider.pending[1].resolve(provider.success('en'));
      await second;
      expect(coordinator.pageSourceResolvers.get('s1').effectiveSourceLanguage).toBe('en');
    });
  });

  describe('_processGenericBatch unresolved-result marker', () => {
    function batchOptions(items) {
      return {
        mode: TranslationMode.Subtitle,
        items,
        useRawItems: true,
        transformOutput: (results) => results
      };
    }

    function batchRequest() {
      return {
        mode: TranslationMode.Subtitle,
        messageId: 'm-sub',
        data: { provider: 'google', sourceLanguage: 'en', targetLanguage: 'fa' }
      };
    }

    it('tags only under-returned items with isSkipped', async () => {
      mockEngine.getProvider.mockResolvedValue({
        translate: vi.fn().mockResolvedValue(['ترجمهٔ A'])
      });

      const items = [{ id: 'A', text: 'A' }, { id: 'B', text: 'B' }];
      const result = await coordinator._processGenericBatch(
        batchRequest(),
        { translationEngine: mockEngine },
        batchOptions(items)
      );

      expect(result[0]).toEqual({ id: 'A', text: 'ترجمهٔ A' });
      expect(result[1]).toEqual({ id: 'B', text: 'B', isSkipped: true });
      expect(result[0].isSkipped).toBeUndefined();
    });

    it('marks missing plain-string results as skipped', async () => {
      mockEngine.getProvider.mockResolvedValue({
        translate: vi.fn().mockResolvedValue(['A2', 'B2'])
      });

      const result = await coordinator._processGenericBatch(
        batchRequest(),
        { translationEngine: mockEngine },
        batchOptions(['A', 'B', 'C'])
      );

      expect(result).toEqual([
        { text: 'A2' },
        { text: 'B2' },
        { text: 'C', isSkipped: true }
      ]);
    });

    it('does not mark complete plain-string results as skipped', async () => {
      mockEngine.getProvider.mockResolvedValue({
        translate: vi.fn().mockResolvedValue(['A2', 'B2'])
      });

      const result = await coordinator._processGenericBatch(
        batchRequest(),
        { translationEngine: mockEngine },
        batchOptions(['A', 'B'])
      );

      expect(result).toEqual([{ text: 'A2' }, { text: 'B2' }]);
      result.forEach(item => expect(item.isSkipped).toBeUndefined());
    });

    it('marks missing mixed string and object results according to item shape', async () => {
      mockEngine.getProvider.mockResolvedValue({
        translate: vi.fn().mockResolvedValue(['A2'])
      });

      const result = await coordinator._processGenericBatch(
        batchRequest(),
        { translationEngine: mockEngine },
        batchOptions(['A', { text: 'B' }, 'C'])
      );

      expect(result).toEqual([
        { text: 'A2' },
        { text: 'B', isSkipped: true },
        { text: 'C', isSkipped: true }
      ]);
    });

    it('fires the generic batch guard exactly at the canonical batch execution budget', async () => {
      vi.useFakeTimers();
      try {
        mockEngine.getProvider.mockResolvedValue({
          translate: vi.fn(() => new Promise(() => {}))
        });

        const promise = coordinator._processGenericBatch(
          batchRequest(),
          { translationEngine: mockEngine },
          batchOptions([{ id: 'A', text: 'A' }])
        );
        let rejected = false;
        promise.catch(() => { rejected = true; });

        await vi.advanceTimersByTimeAsync(TRANSLATION_BATCH_EXECUTION_TIMEOUT_MS - 1);
        expect(rejected).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await expect(promise).rejects.toMatchObject({ type: ErrorTypes.TRANSLATION_TIMEOUT });
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects a batch timeout as TRANSLATION_TIMEOUT, never USER_CANCELLED', async () => {
      vi.useFakeTimers();
      try {
        mockEngine.getProvider.mockResolvedValue({
          translate: vi.fn(() => new Promise(() => {}))
        });

        const items = [{ id: 'A', text: 'A' }];
        const promise = coordinator._processGenericBatch(
          batchRequest(),
          { translationEngine: mockEngine },
          batchOptions(items)
        );

        const assertion = promise.then(
          () => { throw new Error('expected a timeout rejection'); },
          (error) => {
            expect(error.type).toBe(ErrorTypes.TRANSLATION_TIMEOUT);
            expect(error.type).not.toBe(ErrorTypes.USER_CANCELLED);
          }
        );

        await vi.advanceTimersByTimeAsync(301000);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports a pre-execution cancellation as operation abort, never a timeout', async () => {
      mockEngine.lifecycleRegistry.registerRequest.mockReturnValue(undefined);

      const items = [{ id: 'A', text: 'A' }];
      const result = await coordinator._processGenericBatch(
        batchRequest(),
        { translationEngine: mockEngine },
        batchOptions(items)
      );

      expect(result.cancelled).toBe(true);
      expect(result.error.operationAborted).toBe(true);
      expect(result.error.cancellationReason).toBe('operation-abort');
      expect(result.error.type).not.toBe(ErrorTypes.USER_CANCELLED);
      expect(result.error.type).not.toBe(ErrorTypes.TRANSLATION_TIMEOUT);
    });

    it('never adds isSkipped when every item resolves', async () => {
      mockEngine.getProvider.mockResolvedValue({
        translate: vi.fn().mockResolvedValue(['ترجمهٔ A', 'ترجمهٔ B'])
      });

      const items = [{ id: 'A', text: 'A' }, { id: 'B', text: 'B' }];
      const result = await coordinator._processGenericBatch(
        batchRequest(),
        { translationEngine: mockEngine },
        batchOptions(items)
      );

      expect(result).toHaveLength(2);
      result.forEach(item => expect(item.isSkipped).toBeUndefined());
      expect(result[0].text).toBe('ترجمهٔ A');
      expect(result[1].text).toBe('ترجمهٔ B');
    });
  });

  describe('generic batch abort ownership', () => {
    const operationAbort = () => Object.assign(new Error('operation stopped'), {
      name: 'AbortError',
      operationAborted: true,
      cancellationReason: 'operation-abort',
    });

    it.each([TranslationMode.Page, TranslationMode.Subtitle])(
      'suppresses operation abort for %s without public cancellation error',
      async (mode) => {
        const provider = { translate: vi.fn().mockRejectedValue(operationAbort()) };
        mockEngine.getProvider.mockResolvedValue(provider);
        matchErrorToType.mockClear();
        isFatalError.mockClear();

        const request = mode === TranslationMode.Page
          ? {
            mode,
            messageId: `abort-${mode}`,
            data: { text: JSON.stringify([{ text: 'source' }]), provider: 'google', sourceLanguage: 'en', targetLanguage: 'fa' },
          }
          : {
            mode,
            messageId: `abort-${mode}`,
            data: { items: [{ id: 'cue-1', text: 'source' }], provider: 'google', sourceLanguage: 'en', targetLanguage: 'fa' },
          };

        const result = await coordinator.processRequest(request, { translationEngine: mockEngine });

        expect(result).toMatchObject({ success: false, suppressed: true });
        expect(result).not.toHaveProperty('error');
        expect(result).not.toHaveProperty('errorDetails');
        expect(result).not.toHaveProperty('cancelled');
        expect(result).not.toHaveProperty('status');
        expect(result).not.toHaveProperty('operationAborted');
        expect(result).not.toHaveProperty('cancellationReason');
        expect(matchErrorToType).not.toHaveBeenCalled();
        expect(isFatalError).not.toHaveBeenCalled();
      },
    );

    it('preserves typed timeout AbortError in Page error details', async () => {
      const timeoutError = Object.assign(new Error('timed out'), {
        name: 'AbortError',
        type: ErrorTypes.TRANSLATION_TIMEOUT,
      });
      mockEngine.getProvider.mockResolvedValue({ translate: vi.fn().mockRejectedValue(timeoutError) });
      matchErrorToType.mockClear();

      const result = await coordinator.processPageTranslation({
        mode: TranslationMode.Page,
        messageId: 'typed-timeout-page',
        data: { text: JSON.stringify([{ text: 'source' }]), provider: 'google', sourceLanguage: 'en', targetLanguage: 'fa' },
      }, { translationEngine: mockEngine });

      expect(result.errorDetails.type).toBe(ErrorTypes.TRANSLATION_TIMEOUT);
      expect(result.errorDetails.type).not.toBe(ErrorTypes.USER_CANCELLED);
      expect(matchErrorToType).not.toHaveBeenCalled();
    });

    it('preserves explicit USER_CANCELLED in Page error details', async () => {
      const userError = Object.assign(new Error('cancelled'), { type: ErrorTypes.USER_CANCELLED });
      mockEngine.getProvider.mockResolvedValue({ translate: vi.fn().mockRejectedValue(userError) });
      matchErrorToType.mockClear();

      const result = await coordinator.processPageTranslation({
        mode: TranslationMode.Page,
        messageId: 'user-cancel-page',
        data: { text: JSON.stringify([{ text: 'source' }]), provider: 'google', sourceLanguage: 'en', targetLanguage: 'fa' },
      }, { translationEngine: mockEngine });

      expect(result.errorDetails.type).toBe(ErrorTypes.USER_CANCELLED);
      expect(matchErrorToType).not.toHaveBeenCalled();
    });

    it('keeps matcher classification for ordinary untyped Page failures', async () => {
      const ordinaryError = new Error('ordinary failure');
      mockEngine.getProvider.mockResolvedValue({ translate: vi.fn().mockRejectedValue(ordinaryError) });
      matchErrorToType.mockReturnValue(ErrorTypes.NETWORK_ERROR);
      matchErrorToType.mockClear();

      const result = await coordinator.processPageTranslation({
        mode: TranslationMode.Page,
        messageId: 'ordinary-page-failure',
        data: { text: JSON.stringify([{ text: 'source' }]), provider: 'google', sourceLanguage: 'en', targetLanguage: 'fa' },
      }, { translationEngine: mockEngine });

      expect(result.errorDetails.type).toBe(ErrorTypes.NETWORK_ERROR);
      expect(matchErrorToType).toHaveBeenCalledWith(ordinaryError);
    });
  });

  describe('Page plain-string batch payloads', () => {
    it('marks under-returned string-array payload items as skipped', async () => {
      mockEngine.getProvider.mockResolvedValue({
        translate: vi.fn().mockResolvedValue(['A2'])
      });

      const result = await coordinator.processPageTranslation({
        mode: TranslationMode.Page,
        messageId: 'm-page-strings',
        data: {
          text: JSON.stringify(['A', 'B']),
          provider: 'google',
          sourceLanguage: 'en',
          targetLanguage: 'fa'
        }
      }, { translationEngine: mockEngine });

      expect(JSON.parse(result.translatedText)).toEqual([
        { text: 'A2' },
        { text: 'B', isSkipped: true }
      ]);
    });
  });
});
