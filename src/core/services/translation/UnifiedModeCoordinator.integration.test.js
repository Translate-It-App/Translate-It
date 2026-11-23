import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Keep the coordinator, CustomProvider, parser, retry queue and HTTP limiter real.
// Only browser/settings boundaries and the physical HTTP response are fixtures.
vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: { getBrowserInfo: vi.fn(), getManifest: () => ({ version: '1.0.0' }) },
    storage: { local: { get: vi.fn(), set: vi.fn() } },
    tabs: { sendMessage: vi.fn() },
    i18n: {
      getUILanguage: () => 'en',
      detectLanguage: vi.fn(async text => settings.detectionResult || ({
        isReliable: true,
        languages: [{ language: /[\u3040-\u30ff]/.test(text) ? 'ja' : /[\u0600-\u06ff]/.test(text) ? 'fa' : 'en', percentage: 100 }],
      })),
    },
  },
}));
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({ init: vi.fn(), debug: vi.fn(), debugLazy: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/shared/storage/core/StorageCore.js', () => ({
  storageManager: {
    get: vi.fn(async defaults => ({ ...defaults, CUSTOM_API_KEY: settings.keys.join('\n') })),
    set: vi.fn(),
  },
}));
const settings = vi.hoisted(() => ({ level: 5, keys: ['fixture-key'], bilingual: false, bilingualModes: {}, detectionResult: null, responseDelay: null }));
vi.mock('@/shared/config/config.js', async importOriginal => ({
  ...await importOriginal(),
  getCustomApiKeysAsync: vi.fn(async () => settings.keys),
  getCustomApiUrlAsync: vi.fn(async () => 'https://fixture.invalid/v1/chat/completions'),
  getCustomApiModelAsync: vi.fn(async () => 'fixture-model'),
  getProviderOptimizationLevelAsync: vi.fn(async () => settings.level),
  getGoogleTranslateV2UrlAsync: vi.fn(async () => 'https://translate.google.com/translate_a/single'),
  getBilingualTranslationEnabledAsync: vi.fn(async () => settings.bilingual),
  getBilingualTranslationModesAsync: vi.fn(async () => settings.bilingualModes),
  getAIConversationHistoryEnabledAsync: vi.fn(async () => false),
}));
vi.mock('@/shared/proxy/ProxyManager.js', () => ({
  proxyManager: { fetch: vi.fn(), setConfig: vi.fn() },
}));

import { UnifiedModeCoordinator } from './UnifiedModeCoordinator.js';
import { CustomProvider, clearCustomResponseFormatSupportCache } from '@/features/translation/providers/CustomProvider.js';
import { GoogleTranslateV2Provider } from '@/features/translation/providers/GoogleTranslateV2Provider.js';
import { MicrosoftEdgeProvider } from '@/features/translation/providers/MicrosoftEdgeProvider.js';
import { queueManager } from '@/features/translation/core/QueueManager.js';
import { rateLimitManager } from '@/features/translation/core/RateLimitManager.js';
import { TranslationMode } from '@/shared/config/config.js';
import { proxyManager } from '@/shared/proxy/ProxyManager.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { LanguageDetectionService } from '@/shared/services/LanguageDetectionService.js';

describe('Page → CustomProvider physical concurrency', () => {
  let coordinator, engine, state, active, maximum, attempts, completions, controllers;

  beforeEach(async () => {
    vi.clearAllMocks();
    queueManager.cleanup();
    rateLimitManager.providerStates.forEach(providerState => clearTimeout(providerState.nextProcessTimer));
    rateLimitManager.providerStates.clear();
    settings.level = 5;
    settings.keys = ['fixture-key'];
    settings.bilingual = false;
    settings.bilingualModes = { [TranslationMode.Page]: false };
    settings.detectionResult = null;
    settings.responseDelay = null;
    LanguageDetectionService.clearSessionCache();
    await rateLimitManager.reloadConfigurations();
    state = rateLimitManager.providerStates.get('Custom');
    clearCustomResponseFormatSupportCache();
    coordinator = new UnifiedModeCoordinator();
    const provider = new CustomProvider();
    controllers = new Map();
    engine = {
      getProvider: async () => provider,
      lifecycleRegistry: {
        registerRequest: messageId => {
          const controller = new AbortController();
          controllers.set(messageId, controller);
          return controller;
        },
        unregisterRequest: vi.fn(),
      },
    };
    active = 0; maximum = 0; attempts = []; completions = [];
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    queueManager.cleanup();
    rateLimitManager.providerStates.forEach(providerState => clearTimeout(providerState.nextProcessTimer));
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const runBatch = (index, { sourceLanguage = 'en', targetLanguage = 'ja', alreadyTranslated = false, text, texts } = {}) => coordinator.processRequest({
    mode: TranslationMode.Page,
    messageId: `request-${index}`,
    data: {
      provider: 'custom', sourceLanguage, targetLanguage, sessionId: 'page-session',
      text: JSON.stringify([0, 1].map(unit => ({ id: `unit-${index}-${unit}`, text: alreadyTranslated
        ? `すでに翻訳されたナビゲーション項目 ${index}/${unit}` : texts?.[unit] ?? text ?? `Source ${index}/${unit}` }))),
    },
  }, { translationEngine: engine });

  const installHttp = responseForAttempt => {
    proxyManager.fetch.mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      const content = body.messages.at(-1).content;
      let units;
      try { units = JSON.parse(content).translations; } catch { units = [{ id: '0', text: content }]; }
      const record = { units, start: Date.now(), end: null, aborted: options.signal?.aborted };
      attempts.push(record);
      active++;
      maximum = Math.max(maximum, active);
      const attemptIndex = attempts.length - 1;
      await new Promise(resolve => setTimeout(resolve, settings.responseDelay ?? (100 + (4 - attemptIndex % 5) * 10)));
      active--;
      record.end = Date.now();
      completions.push(attemptIndex);
      const fixture = responseForAttempt?.(record, attemptIndex) || {};
      const responseContent = fixture.content ?? JSON.stringify({ translations: [...units].reverse().map(unit => ({ id: unit.id, text: `訳 ${unit.text}` })) });
      const status = fixture.status || 200;
      const data = status === 200
        ? { choices: [{ finish_reason: 'stop', message: { content: responseContent } }] }
        : { error: { message: fixture.error || 'Rate limit exceeded' } };
      return {
        ok: status === 200, status, statusText: status === 200 ? 'OK' : 'Too Many Requests',
        headers: new Map([['content-type', 'application/json'], ...(fixture.retryAfter ? [['Retry-After', fixture.retryAfter]] : [])]),
        json: async () => data,
        clone() { return this; },
      };
    });
  };

  const assertMapped = results => results.forEach((result, index) => {
    expect(result.success).toBe(true);
    expect(JSON.parse(result.translatedText)).toEqual([0, 1].map(unit => ({ id: `unit-${index}-${unit}`, text: `訳 Source ${index}/${unit}` })));
  });

  const advance = async milliseconds => {
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(milliseconds);
  };

  it.each([[3, 2], [5, 4]])('achieves level %s concurrency %s and maps reversed HTTP/items correctly', async (level, cap) => {
    settings.level = level;
    installHttp();
    const pending = Array.from({ length: 8 }, (_, index) => runBatch(index));
    await advance(5000);
    const results = await Promise.all(pending);
    expect(maximum).toBe(cap);
    expect(attempts).toHaveLength(8);
    expect(completions[0]).not.toBe(0);
    assertMapped(results);
    expect(queueManager.getQueueStatus('Custom::parallel').total).toBe(0);
    expect(state.activeRequests).toBe(0);
  });

  it('respects an explicit concurrency limit of one', async () => {
    state.isManualConfig = true;
    state.config.maxConcurrent = 1;
    installHttp();
    const pending = Array.from({ length: 4 }, (_, index) => runBatch(index));
    await advance(5000);
    assertMapped(await Promise.all(pending));
    expect(maximum).toBe(1);
    expect(attempts).toHaveLength(4);
  });

  it('accepts an already-Japanese first AUTO batch and hands detection to English siblings once', async () => {
    installHttp();
    const provider = await engine.getProvider();
    const calls = vi.spyOn(provider, 'translate');
    const finalized = vi.spyOn(coordinator, '_finalizePageSourceResolution');
    const acquires = vi.spyOn(coordinator, '_acquirePageSourceResolution');
    const pending = Array.from({ length: 4 }, (_, index) => runBatch(index, { sourceLanguage: 'auto', alreadyTranslated: index === 0 }));
    await advance(0);
    expect(acquires).toHaveBeenCalledTimes(4);
    expect(attempts).toHaveLength(1);
    // Let real lazy module loading settle between synthetic HTTP completion steps.
    for (let step = 0; step < 20; step++) await advance(50);
    const results = await Promise.all(pending);
    expect(results.every(result => result.success)).toBe(true);
    expect(attempts).toHaveLength(4);
    expect(finalized.mock.calls[0][2]).toMatchObject({ sourceLanguage: 'auto', targetLanguage: 'ja' });
    expect(finalized.mock.calls[1][2]).toMatchObject({ sourceLanguage: 'en', targetLanguage: 'ja' });
    expect(calls.mock.calls.map(call => call[1])).toEqual(['auto', 'auto', 'en', 'en']);
    results.forEach((result, index) => {
      const original = index === 0 ? `すでに翻訳されたナビゲーション項目 ${index}/0` : `Source ${index}/0`;
      expect(JSON.parse(result.translatedText)[0]).toEqual({ id: `unit-${index}-0`, text: `訳 ${original}` });
    });
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(4);
  });

  it('locally resolves a reliable AUTO pair and fills physical capacity before the first response', async () => {
    settings.responseDelay = 10000;
    installHttp();
    const provider = await engine.getProvider();
    const calls = vi.spyOn(provider, 'translate');
    const detections = vi.spyOn(LanguageDetectionService, 'detectDetailed');
    const representativeText = 'A reliable English source sentence for page translation. '.repeat(8);
    const pending = Array.from({ length: 8 }, (_, index) => runBatch(index, {
      sourceLanguage: 'auto', text: representativeText,
    }));

    for (let step = 0; step < 20 && attempts.length < 4; step++) await advance(0);
    expect(attempts).toHaveLength(4);
    expect(attempts.every(attempt => attempt.end === null)).toBe(true);
    expect(maximum).toBe(4);
    expect(calls.mock.calls.slice(0, 4).map(call => call.slice(1, 3))).toEqual(Array(4).fill(['en', 'ja']));
    expect(await detections.mock.results[0].value).toMatchObject({
      language: 'en', provenance: 'statistical', confidence: 'high', reliable: true,
    });

    await advance(25000);
    expect((await Promise.all(pending)).every(result => result.success)).toBe(true);
    expect(attempts).toHaveLength(8);
    expect(state.activeRequests).toBe(0);
  });

  it.each([
    ['insufficient text', ' '],
    ['unreliable browser detection', 'A reliable English source sentence. '.repeat(8)],
    ['mixed-script text', 'English words mixed with 日本語 markers. '.repeat(8)],
    ['ambiguous browser detection', 'A reliable English source sentence. '.repeat(8)],
  ])('keeps the first provider AUTO gate for %s', async (reason, text) => {
    if (reason === 'unreliable browser detection') {
      settings.detectionResult = { isReliable: false, languages: [{ language: 'en', percentage: 70 }] };
    }
    if (reason === 'ambiguous browser detection') {
      settings.detectionResult = { isReliable: false, languages: [
        { language: 'en', percentage: 51 }, { language: 'fr', percentage: 49 },
      ] };
    }
    installHttp();
    const provider = await engine.getProvider();
    const calls = vi.spyOn(provider, 'translate');
    const texts = reason === 'mixed-script text'
      ? ['English source text for the first unit. '.repeat(8), '日本語の本文です。'.repeat(30)]
      : undefined;
    const detections = vi.spyOn(LanguageDetectionService, 'detectDetailed');
    const pending = Array.from({ length: 4 }, (_, index) => runBatch(index, { sourceLanguage: 'auto', text, texts }));

    await advance(0);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].end).toBeNull();
    expect(calls.mock.calls[0].slice(1, 3)).toEqual(['auto', 'ja']);
    const detection = await detections.mock.results[0].value;
    if (reason === 'unreliable browser detection') {
      expect(detection).toMatchObject({ language: 'en', confidence: 'medium', reliable: false, provenance: 'statistical' });
    } else if (reason === 'ambiguous browser detection') {
      expect(detection).toMatchObject({ language: 'en', confidence: 'medium', reliable: false, provenance: 'statistical' });
    } else if (reason === 'mixed-script text') {
      expect(detection).toMatchObject({ language: 'ja', provenance: 'statistical', confidence: 'high', reliable: true });
    }
    for (let step = 0; step < 20; step++) await advance(50);
    expect((await Promise.all(pending)).every(result => result.success)).toBe(true);
    expect(attempts).toHaveLength(4);
    expect(state.activeRequests).toBe(0);
  });

  it('applies the locally resolved bilingual fa→en swap to the owner and siblings before HTTP', async () => {
    settings.bilingual = true;
    settings.bilingualModes = { [TranslationMode.Page]: true };
    settings.responseDelay = 10000;
    installHttp();
    const provider = await engine.getProvider();
    const calls = vi.spyOn(provider, 'translate');
    const detections = vi.spyOn(LanguageDetectionService, 'detectDetailed');
    const representativeText = 'متن فارسی برای تشخیص زبان و ترجمه صفحه. '.repeat(8);
    const pending = Array.from({ length: 4 }, (_, index) => runBatch(index, {
      sourceLanguage: 'auto', targetLanguage: 'fa', text: representativeText,
    }));

    for (let step = 0; step < 20 && attempts.length < 4; step++) await advance(0);
    expect(attempts).toHaveLength(4);
    expect(attempts.every(attempt => attempt.end === null)).toBe(true);
    expect(calls.mock.calls.slice(0, 4).map(call => call.slice(1, 3))).toEqual(Array(4).fill(['fa', 'en']));
    expect(await detections.mock.results[0].value).toMatchObject({ language: 'fa', provenance: 'statistical', confidence: 'high', reliable: true });
    await advance(15000);
    expect((await Promise.all(pending)).every(result => result.success)).toBe(true);
    expect(attempts).toHaveLength(4);
    expect(state.activeRequests).toBe(0);
  });

  it('bounds repeated successful no-pair AUTO handoffs to one transport per batch', async () => {
    installHttp();
    const provider = await engine.getProvider();
    const calls = vi.spyOn(provider, 'translate');
    const pending = Array.from({ length: 8 }, (_, index) => runBatch(index, { sourceLanguage: 'auto', alreadyTranslated: true }));
    await advance(5000);
    const results = await Promise.all(pending);
    expect(results.every(result => result.success)).toBe(true);
    expect(attempts).toHaveLength(8);
    expect(calls.mock.calls.map(call => call[1])).toEqual(Array(8).fill('auto'));
    expect(maximum).toBe(1);
    results.forEach((result, index) => {
      expect(JSON.parse(result.translatedText)[0]).toEqual({ id: `unit-${index}-0`, text: `訳 すでに翻訳されたナビゲーション項目 ${index}/0` });
    });
    expect(state.activeRequests).toBe(0);
  });

  it('shares physical 429 cooldown with queued batches and the bounded queue retry', async () => {
    installHttp((_record, index) => index === 0 ? { status: 429, retryAfter: '5' } : {});
    const pending = Array.from({ length: 8 }, (_, index) => runBatch(index));
    await advance(20000);
    assertMapped(await Promise.all(pending));
    expect(maximum).toBe(4);
    expect(attempts).toHaveLength(9);
    const deadline = attempts[0].end + 5000;
    attempts.filter(attempt => attempt.start >= attempts[0].end).forEach(attempt => expect(attempt.start).toBeGreaterThanOrEqual(deadline));
    expect(state.activeRequests).toBe(0);
  });

  it('honors shared Retry-After even when API-key failover consumes the 429', async () => {
    settings.keys = ['fixture-first-key', 'fixture-second-key'];
    installHttp((_record, index) => index === 0 ? { status: 429, retryAfter: '5' } : {});
    const pending = Array.from({ length: 8 }, (_, index) => runBatch(index));
    await advance(20000);
    assertMapped(await Promise.all(pending));
    expect(attempts).toHaveLength(9);
    expect(state.performanceStats.failedRequests).toBe(0);
    const deadline = attempts[0].end + 5000;
    attempts.filter(attempt => attempt.start >= attempts[0].end).forEach(attempt => expect(attempt.start).toBeGreaterThanOrEqual(deadline));
    expect(maximum).toBe(4);
  });

  it('retains a cancelled live HTTP slot until an abort-ignoring response settles', async () => {
    state.isManualConfig = true;
    state.config.maxConcurrent = 1;
    installHttp();
    const first = runBatch(0);
    const second = runBatch(1);
    await advance(0);
    expect(attempts).toHaveLength(1);
    controllers.get('request-0').abort('user-cancelled');
    await advance(139);
    expect(attempts).toHaveLength(1);
    expect(state.activeRequests).toBe(1);
    await advance(1000);
    expect(await first).toMatchObject({ success: false });
    const result = await second;
    expect(result.success).toBe(true);
    expect(JSON.parse(result.translatedText)[0]).toEqual({ id: 'unit-1-0', text: '訳 Source 1/0' });
    expect(attempts).toHaveLength(2);
    expect(maximum).toBe(1);
    expect(state.activeRequests).toBe(0);
  });

  it('repairs malformed JSON under the same physical cap without resending successful siblings', async () => {
    installHttp((_record, index) => index === 0 ? { content: 'unparseable output' } : {});
    const pending = Array.from({ length: 8 }, (_, index) => runBatch(index));
    await advance(10000);
    assertMapped(await Promise.all(pending));
    expect(maximum).toBe(4);
    expect(attempts.length).toBeGreaterThan(8);
    expect(attempts.length).toBeLessThanOrEqual(10);
    for (let index = 1; index < 8; index++) {
      expect(attempts.filter(attempt => attempt.units.some(unit => unit.text === `Source ${index}/0`))).toHaveLength(1);
    }
    expect(state.activeRequests).toBe(0);
  });

  it('does not retry a permanent failed batch or lose successful sibling mappings', async () => {
    installHttp((_record, index) => index === 0 ? { status: 400, error: 'Invalid request parameters' } : {});
    const pending = Array.from({ length: 8 }, (_, index) => runBatch(index));
    await advance(10000);
    const results = await Promise.all(pending);
    expect(results[0]).toMatchObject({ success: false, errorType: ErrorTypes.HTTP_ERROR });
    results.slice(1).forEach((result, index) => {
      expect(JSON.parse(result.translatedText)[0]).toEqual({ id: `unit-${index + 1}-0`, text: `訳 Source ${index + 1}/0` });
    });
    expect(attempts).toHaveLength(8);
    expect(maximum).toBe(4);
  });
});

describe('Page and Subtitle → MicrosoftEdgeProvider shared physical concurrency', () => {
  let coordinator, engine, providerState, active, maximum, requests;

  beforeEach(async () => {
    vi.clearAllMocks();
    queueManager.cleanup();
    rateLimitManager.providerStates.forEach(state => clearTimeout(state.nextProcessTimer));
    rateLimitManager.providerStates.clear();
    settings.level = 1;
    settings.keys = [];
    settings.bilingual = false;
    settings.bilingualModes = { [TranslationMode.Page]: false };
    settings.detectionResult = null;
    LanguageDetectionService.clearSessionCache();
    await rateLimitManager.reloadConfigurations();
    coordinator = new UnifiedModeCoordinator();
    const provider = new MicrosoftEdgeProvider();
    const controllers = new Map();
    engine = {
      getProvider: async () => provider,
      lifecycleRegistry: {
        registerRequest: messageId => {
          const controller = new AbortController();
          controllers.set(messageId, controller);
          return controller;
        },
        unregisterRequest: vi.fn(),
      },
    };
    providerState = rateLimitManager.providerStates.get('MicrosoftEdge');
    active = 0;
    maximum = 0;
    requests = [];
    vi.useFakeTimers();
    proxyManager.fetch.mockImplementation(async (_url, options) => {
      const texts = JSON.parse(options.body);
      const request = { texts, released: false };
      requests.push(request);
      active++;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => {
        request.release = () => {
          request.released = true;
          active--;
          resolve();
        };
      });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map([['content-type', 'application/json']]),
        json: async () => texts.map(text => ({ translations: [{ text: `translated:${text}` }] })),
        clone() { return this; },
      };
    });
  });

  afterEach(() => {
    requests.filter(request => !request.released).forEach(request => request.release());
    queueManager.cleanup();
    rateLimitManager.providerStates.forEach(state => clearTimeout(state.nextProcessTimer));
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const pageRequest = index => coordinator.processRequest({
    mode: TranslationMode.Page,
    messageId: `edge-page-${index}`,
    data: {
      provider: 'edge',
      sessionId: 'edge-page-session',
      sourceLanguage: 'en',
      targetLanguage: 'fa',
      text: JSON.stringify([{ id: `page-${index}`, text: `Page ${index} source` }]),
    },
  }, { translationEngine: engine });

  const subtitleRequest = () => coordinator.processRequest({
    mode: TranslationMode.Subtitle,
    messageId: 'edge-subtitle',
    data: {
      provider: 'edge',
      sourceLanguage: 'en',
      targetLanguage: 'fa',
      items: [{ id: 'cue-1', text: 'Subtitle source' }],
    },
  }, { translationEngine: engine });

  const pumpUntil = async (predicate, message) => {
    for (let turn = 0; turn < 60 && !predicate(); turn++) {
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(predicate(), message).toBe(true);
  };

  const release = async texts => {
    const request = requests.find(candidate => candidate.texts[0] === texts);
    expect(request, `missing pending request for ${texts}`).toBeDefined();
    request.release();
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);
  };

  it('shares Edge capacity across concurrent Page and Subtitle work and maps out-of-order completions', async () => {
    const providerLimit = providerState.config.maxConcurrent;
    expect(providerLimit).toBe(2);
    const pages = [0, 1, 2, 3].map(pageRequest);
    await pumpUntil(() => requests.length === 2, 'the first two Page HTTP requests should occupy Edge capacity');

    const subtitle = subtitleRequest();
    await pumpUntil(
      () => Object.values(providerState.queues).reduce((count, queue) => count + queue.length, 0) >= 3,
      'remaining Page and Subtitle physical requests should queue behind the shared Edge limit'
    );
    expect(requests).toHaveLength(2);
    expect(active).toBe(providerLimit);
    expect(maximum).toBe(providerLimit);

    await release('Page 1 source');
    await pumpUntil(() => requests.length === 3, 'a queued request should start after one Edge slot is released');
    expect(requests[2].texts).toEqual(['Subtitle source']);

    await release('Subtitle source');
    await pumpUntil(() => requests.length === 4, 'a queued Page request should start after Subtitle releases its slot');
    await release('Page 2 source');
    await pumpUntil(() => requests.length === 5, 'the final Page request should start after capacity is released');
    await release('Page 3 source');
    await release('Page 0 source');

    const results = await Promise.all(pages);
    const subtitleResult = await subtitle;
    results.forEach((result, index) => {
      expect(result.success).toBe(true);
      expect(JSON.parse(result.translatedText)).toEqual([
        { id: `page-${index}`, text: `translated:Page ${index} source` },
      ]);
    });
    expect(subtitleResult.results).toEqual([
      { id: 'cue-1', text: 'translated:Subtitle source' },
    ]);
    expect(requests.map(request => request.texts[0])).toEqual([
      'Page 0 source', 'Page 1 source', 'Subtitle source', 'Page 2 source', 'Page 3 source',
    ]);
    expect(maximum).toBeLessThanOrEqual(providerLimit);
    expect(active).toBe(0);
    expect(providerState.activeRequests).toBe(0);
    expect(Object.values(providerState.queues).every(queue => queue.length === 0)).toBe(true);
    expect(queueManager.getQueueStatus('MicrosoftEdge::parallel').total).toBe(0);
    expect(queueManager.getQueueStatus('MicrosoftEdge').total).toBe(0);
  });
});

describe('Page → GoogleTranslateV2Provider physical concurrency', () => {
  let coordinator, engine, providerState, active, maximum, attempts, completions, releases, controllers, failureSource;

  beforeEach(async () => {
    vi.clearAllMocks();
    queueManager.cleanup();
    rateLimitManager.providerStates.forEach(providerState => clearTimeout(providerState.nextProcessTimer));
    rateLimitManager.providerStates.clear();
    settings.level = 3;
    settings.keys = ['fixture-key'];
    settings.bilingual = false;
    settings.bilingualModes = { [TranslationMode.Page]: false };
    settings.detectionResult = null;
    settings.responseDelay = null;
    LanguageDetectionService.clearSessionCache();
    await rateLimitManager.reloadConfigurations();
    coordinator = new UnifiedModeCoordinator();
    const provider = new GoogleTranslateV2Provider();
    controllers = new Map();
    failureSource = null;
    engine = {
      getProvider: async () => provider,
      lifecycleRegistry: {
        registerRequest: messageId => {
          const controller = new AbortController();
          controllers.set(messageId, controller);
          return controller;
        },
        unregisterRequest: vi.fn(),
      },
    };
    providerState = rateLimitManager.providerStates.get('GoogleTranslateV2');
    active = 0;
    maximum = 0;
    attempts = [];
    completions = [];
    releases = [];
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    proxyManager.fetch.mockImplementation(async (_url, options) => {
      const source = new URLSearchParams(options.body).get('q');
      const record = { source, start: Date.now(), end: null };
      attempts.push(record);
      active++;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => releases.push(resolve));
      active--;
      record.end = Date.now();
      completions.push(record.source);
      const failed = source === failureSource;
      return {
        ok: !failed,
        status: failed ? 401 : 200,
        statusText: failed ? 'Unauthorized' : 'OK',
        headers: new Map([['content-type', 'application/json']]),
        json: async () => failed
          ? { error: { message: 'Invalid API key' } }
          : [[[`translated:${source}`, source]], null, 'en'],
        clone() { return this; },
      };
    });
  });

  afterEach(() => {
    releases.forEach(release => release());
    queueManager.cleanup();
    rateLimitManager.providerStates.forEach(state => clearTimeout(state.nextProcessTimer));
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const pageRequest = (messageId, { sessionId = 'google-page-session', sourceLanguage = 'en', text = messageId } = {}) => coordinator.processRequest({
    mode: TranslationMode.Page,
    messageId,
    data: {
      provider: 'googlev2',
      sessionId,
      sourceLanguage,
      targetLanguage: 'ja',
      text: JSON.stringify([{ id: messageId, text }]),
    },
  }, { translationEngine: engine });

  const pumpUntil = async predicate => {
    for (let turn = 0; turn < 40 && !predicate(); turn++) {
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(predicate(), JSON.stringify({
      active,
      maximum,
      attempts: attempts.map(attempt => ({ source: attempt.source, end: attempt.end })),
      providerActiveRequests: providerState.activeRequests,
      sourceResolvers: [...coordinator.pageSourceResolvers.entries()].map(([key, state]) => ({
        key, source: state.effectiveSourceLanguage, target: state.effectiveTargetLanguage,
      })),
    })).toBe(true);
  };

  it('overlaps Page batches across sessions, shares provider capacity, and maps reverse completions', async () => {
    const batchRows = [
      ['session-a', 'a-1', 'source-a-1'],
      ['session-a', 'a-2', 'source-a-2'],
      ['session-b', 'b-1', 'source-b-1'],
      ['session-b', 'b-2', 'source-b-2'],
      ['session-a', 'a-3', 'source-a-3'],
      ['session-b', 'b-3', 'source-b-3'],
    ];
    const runBatch = ([sessionId, id, text]) => coordinator.processRequest({
      mode: TranslationMode.Page,
      messageId: id,
      data: {
        provider: 'googlev2',
        sessionId,
        sourceLanguage: 'en',
        targetLanguage: 'ja',
        text: JSON.stringify([{ id, text }]),
      },
    }, { translationEngine: engine });
    const requests = batchRows.slice(0, 4).map(runBatch);

    for (let turn = 0; turn < 40 && attempts.length < 4; turn++) {
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(0);
    }

    const limit = providerState.config.maxConcurrent;
    expect(limit).toBe(4);
    expect(attempts).toHaveLength(4);
    expect(active).toBe(4);
    expect(maximum).toBe(limit);
    expect(providerState.activeRequests).toBe(limit);
    expect(attempts.every(attempt => attempt.end === null)).toBe(true);
    const initiallyInFlightSources = attempts.map(attempt => attempt.source);
    expect(initiallyInFlightSources.filter(source => source.startsWith('source-a-'))).toHaveLength(2);
    expect(initiallyInFlightSources.filter(source => source.startsWith('source-b-'))).toHaveLength(2);
    requests.push(...batchRows.slice(4).map(runBatch));

    releases[0]();
    for (let turn = 0; turn < 40 && attempts.length < 5; turn++) {
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(attempts).toHaveLength(5);
    expect(active).toBe(limit);
    expect(maximum).toBe(limit);
    releases[4]();
    for (let turn = 0; turn < 40 && attempts.length < 6; turn++) {
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(attempts).toHaveLength(6);
    expect(active).toBe(limit);

    for (let index = releases.length - 1; index >= 1; index--) {
      releases[index]();
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(0);
    }
    for (let turn = 0; turn < 40 && providerState.activeRequests !== 0; turn++) {
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(0);
    }

    const results = await Promise.all(requests);
    expect(completions).toEqual([
      attempts[0].source,
      attempts[4].source,
      attempts[5].source,
      ...attempts.slice(1, 4).map(attempt => attempt.source).reverse(),
    ]);
    expect(results.map(result => JSON.parse(result.translatedText))).toEqual([
      [{ id: 'a-1', text: 'translated:source-a-1' }],
      [{ id: 'a-2', text: 'translated:source-a-2' }],
      [{ id: 'b-1', text: 'translated:source-b-1' }],
      [{ id: 'b-2', text: 'translated:source-b-2' }],
      [{ id: 'a-3', text: 'translated:source-a-3' }],
      [{ id: 'b-3', text: 'translated:source-b-3' }],
    ]);
    expect(attempts).toHaveLength(6);
    expect(maximum).toBe(limit);
    expect(active).toBe(0);
    expect(providerState.activeRequests).toBe(0);
    expect(queueManager.getQueueStatus('GoogleTranslateV2::parallel').total).toBe(0);
  });

  it('keeps unresolved AUTO sibling batches behind the first Google V2 provider batch', async () => {
    const detection = vi.spyOn(LanguageDetectionService, 'detectDetailed')
      .mockResolvedValueOnce({ language: null, confidence: 'unknown', provenance: 'unknown', reliable: false })
      .mockResolvedValue({ language: 'en', confidence: 'high', provenance: 'statistical', reliable: true });
    const finalizePair = vi.spyOn(coordinator, '_finalizePageSourceResolution');
    const requests = [
      pageRequest('auto-first', { sourceLanguage: 'auto', text: 'x' }),
      pageRequest('auto-sibling-1', { sourceLanguage: 'auto', text: 'y' }),
      pageRequest('auto-sibling-2', { sourceLanguage: 'auto', text: 'z' }),
    ];

    await pumpUntil(() => attempts.length === 1);
    expect(attempts[0].source).toBe('x');
    expect(providerState.activeRequests).toBe(1);
    releases[0]();
    await pumpUntil(() => attempts.length === 3);
    expect(detection).toHaveBeenCalledTimes(2);
    expect(finalizePair).toHaveBeenCalledWith(expect.any(String), expect.anything(), expect.objectContaining({
      sourceLanguage: 'en', targetLanguage: 'ja',
    }));

    releases.slice(1).forEach(release => release());
    await pumpUntil(() => providerState.activeRequests === 0);
    const results = await Promise.all(requests);
    expect(results.map(result => JSON.parse(result.translatedText))).toEqual([
      [{ id: 'auto-first', text: 'translated:x' }],
      [{ id: 'auto-sibling-1', text: 'translated:y' }],
      [{ id: 'auto-sibling-2', text: 'translated:z' }],
    ]);
  });

  it('cancels queued Google V2 parallel work without taking or leaking a physical slot', async () => {
    const requests = Array.from({ length: 5 }, (_, index) => pageRequest(`cancel-${index}`, {
      sessionId: 'cancel-session', text: `cancel-source-${index}`,
    }));
    await pumpUntil(() => attempts.length === 4);
    expect(providerState.activeRequests).toBe(4);

    controllers.get('cancel-4').abort('user-cancelled');
    const cancelled = await requests[4];
    expect(cancelled.success).toBe(false);
    expect(attempts).toHaveLength(4);
    expect(providerState.activeRequests).toBe(4);

    releases[0]();
    await pumpUntil(() => providerState.activeRequests === 3);
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toHaveLength(4);
    expect(maximum).toBe(4);

    releases.slice(1, 4).forEach(release => release());
    await pumpUntil(() => providerState.activeRequests === 0);
    const completed = await Promise.all(requests.slice(0, 4));
    expect(completed.every(result => result.success)).toBe(true);
    expect(providerState.activeRequests).toBe(0);
    expect(queueManager.getQueueStatus('GoogleTranslateV2::parallel').total).toBe(0);
  });

  it('keeps a Google V2 HTTP failure typed without corrupting successful siblings or limiter cleanup', async () => {
    failureSource = 'failure-source';
    const failedRequest = pageRequest('failure', { sessionId: 'failure-session', text: failureSource });
    const siblingRequest = pageRequest('sibling', { sessionId: 'failure-session', text: 'sibling-source' });
    await pumpUntil(() => attempts.length === 2);
    expect(active).toBe(2);

    releases[1]();
    releases[0]();
    await pumpUntil(() => providerState.activeRequests === 0);
    const [failed, sibling] = await Promise.all([failedRequest, siblingRequest]);
    expect(failed).toMatchObject({ success: false, errorType: ErrorTypes.API_KEY_INVALID });
    expect(sibling).toMatchObject({ success: true });
    expect(JSON.parse(sibling.translatedText)).toEqual([{ id: 'sibling', text: 'translated:sibling-source' }]);
    expect(completions).toEqual(['sibling-source', 'failure-source']);
    expect(active).toBe(0);
    expect(providerState.activeRequests).toBe(0);
    expect(queueManager.getQueueStatus('GoogleTranslateV2::parallel').status).toMatchObject({
      pending: 0, processing: 0, retrying: 0,
    });
  });
});
