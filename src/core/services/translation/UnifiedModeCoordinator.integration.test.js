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
const settings = vi.hoisted(() => ({ level: 5, keys: ['fixture-key'], deeplKeys: ['fixture-deepl-key'], deeplTier: 'free', deeplFormality: 'default', bilingual: false, bilingualModes: {}, detectionResult: null, responseDelay: null }));
vi.mock('@/shared/config/config.js', async importOriginal => ({
  ...await importOriginal(),
  getCustomApiKeysAsync: vi.fn(async () => settings.keys),
  getCustomApiUrlAsync: vi.fn(async () => 'https://fixture.invalid/v1/chat/completions'),
  getCustomApiModelAsync: vi.fn(async () => 'fixture-model'),
  getDeeplApiKeysAsync: vi.fn(async () => settings.deeplKeys),
  getDeeplApiTierAsync: vi.fn(async () => settings.deeplTier),
  getDeeplFormalityAsync: vi.fn(async () => settings.deeplFormality),
  getDeeplFreeApiUrlAsync: vi.fn(async () => 'https://api-free.deepl.com/v2/translate'),
  getDeeplProApiUrlAsync: vi.fn(async () => 'https://api.deepl.com/v2/translate'),
  getProviderOptimizationLevelAsync: vi.fn(async () => settings.level),
  getGoogleTranslateUrlAsync: vi.fn(async () => 'https://translate.google.com/translate_a/single'),
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
import { GoogleTranslateProvider } from '@/features/translation/providers/GoogleTranslate.js';
import { GoogleTranslateV2Provider } from '@/features/translation/providers/GoogleTranslateV2Provider.js';
import { MicrosoftEdgeProvider } from '@/features/translation/providers/MicrosoftEdgeProvider.js';
import { YandexTranslateProvider } from '@/features/translation/providers/YandexTranslate.js';
import { DeepLTranslateProvider } from '@/features/translation/providers/DeepLTranslate.js';
import { queueManager } from '@/features/translation/core/QueueManager.js';
import { rateLimitManager } from '@/features/translation/core/RateLimitManager.js';
import { TranslationMode } from '@/shared/config/config.js';
import { proxyManager } from '@/shared/proxy/ProxyManager.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { LanguageDetectionService } from '@/shared/services/LanguageDetectionService.js';
import { TRANSLATION_BATCH_EXECUTION_TIMEOUT_MS } from '@/shared/constants/translation.js';

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

  const runSubtitle = index => coordinator.processRequest({
    mode: TranslationMode.Subtitle,
    messageId: `subtitle-${index}`,
    data: {
      provider: 'custom',
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      items: [{ id: `cue-${index}`, text: `Subtitle ${index} source` }],
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
      const responseDelay = typeof settings.responseDelay === 'function'
        ? settings.responseDelay(record, attemptIndex)
        : settings.responseDelay ?? (100 + (4 - attemptIndex % 5) * 10);
      await new Promise(resolve => setTimeout(resolve, responseDelay));
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

  it.each([[3, 3], [5, 4]])('achieves level %s concurrency %s and maps reversed HTTP/items correctly', async (level, cap) => {
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

  it('shares the Level 3 physical limit between Page and Subtitle requests', async () => {
    settings.level = 3;
    settings.responseDelay = (_record, index) => index === 0 ? 100 : 1000;
    installHttp();
    const pages = [runBatch(0), runBatch(1), runBatch(2)];
    const subtitles = [runSubtitle(0), runSubtitle(1)];

    await advance(0);
    expect(state.config.maxConcurrent).toBe(3);
    expect(attempts).toHaveLength(3);
    expect(state.activeRequests).toBe(3);
    await advance(100);

    const subtitleAttempt = attempts.find(attempt => attempt.units.some(unit => unit.text === 'Subtitle 0 source'));
    expect(subtitleAttempt).toBeDefined();
    expect(attempts.slice(0, 3).some(attempt =>
      attempt.units.some(unit => unit.text.startsWith('Source '))
      && attempt.start < subtitleAttempt.start
      && attempt.end === null
    )).toBe(true);

    await advance(5000);
    assertMapped(await Promise.all(pages));
    expect((await Promise.all(subtitles)).map(result => result.results[0])).toEqual([
      { id: 'cue-0', text: '訳 Subtitle 0 source' },
      { id: 'cue-1', text: '訳 Subtitle 1 source' },
    ]);
    expect(maximum).toBe(3);
    expect(state.activeRequests).toBe(0);
    expect(Object.values(state.queues).every(queue => queue.length === 0)).toBe(true);
    expect(queueManager.getQueueStatus('Custom::parallel').total).toBe(0);
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

  it.each([[3, 3], [5, 4]])('shares physical 429 cooldown with queued batches and the bounded queue retry at level %s', async (level, cap) => {
    settings.level = level;
    installHttp((_record, index) => index === 0 ? { status: 429, retryAfter: '5' } : {});
    const pending = Array.from({ length: 8 }, (_, index) => runBatch(index));
    await advance(20000);
    assertMapped(await Promise.all(pending));
    expect(maximum).toBe(cap);
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

  it.each([[3, 3], [5, 4]])('repairs malformed JSON under the level %s physical cap without resending successful siblings', async (level, cap) => {
    settings.level = level;
    installHttp((_record, index) => index === 0 ? { content: 'unparseable output' } : {});
    const pending = Array.from({ length: 8 }, (_, index) => runBatch(index));
    await advance(10000);
    assertMapped(await Promise.all(pending));
    expect(maximum).toBe(cap);
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

describe('Page → Google Classic bounded physical concurrency', () => {
  let coordinator, engine, providerState, active, maximum, requests, controllers;

  beforeEach(async () => {
    vi.clearAllMocks();
    queueManager.cleanup();
    rateLimitManager.providerStates.forEach(state => clearTimeout(state.nextProcessTimer));
    rateLimitManager.providerStates.clear();
    settings.level = 5;
    settings.keys = [];
    settings.bilingual = false;
    settings.bilingualModes = { [TranslationMode.Page]: false };
    settings.detectionResult = null;
    LanguageDetectionService.clearSessionCache();
    await rateLimitManager.reloadConfigurations();
    coordinator = new UnifiedModeCoordinator();
    const provider = new GoogleTranslateProvider();
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
    providerState = rateLimitManager.providerStates.get('GoogleTranslate');
    providerState.isManualConfig = true;
    providerState.config.maxConcurrent = 2;
    active = 0;
    maximum = 0;
    requests = [];
    vi.useFakeTimers();
    proxyManager.fetch.mockImplementation(async (_url, options) => {
      const query = new URLSearchParams(options.body).get('q');
      const request = { query, signal: options.signal, released: false, startedAt: Date.now() };
      requests.push(request);
      active++;
      maximum = Math.max(maximum, active);
      const { status = 200, retryAfter, response = { sentences: [{ trans: `translated:${query}` }], src: 'en' } } = await new Promise(resolve => {
        request.release = fixture => {
          request.released = true;
          active--;
          resolve(fixture || {});
        };
      });
      return {
        ok: status === 200,
        status,
        statusText: status === 200 ? 'OK' : 'Too Many Requests',
        headers: new Map([['content-type', 'application/json'], ...(retryAfter ? [['Retry-After', retryAfter]] : [])]),
        json: async () => response,
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

  const pageRequest = (index, text, sourceLanguage = 'en', targetLanguage = 'fa') => coordinator.processRequest({
    mode: TranslationMode.Page,
    messageId: `classic-page-${index}`,
    data: {
      provider: 'google',
      sessionId: 'classic-page-session',
      sourceLanguage,
      targetLanguage,
      text: JSON.stringify([{ id: `page-${index}`, text }]),
    },
  }, { translationEngine: engine });

  const subtitleRequest = (index = 0, text = 'subtitle source') => coordinator.processRequest({
    mode: TranslationMode.Subtitle,
    messageId: `classic-subtitle-${index}`,
    data: {
      provider: 'google',
      sourceLanguage: 'en',
      targetLanguage: 'fa',
      items: [{ id: `cue-${index}`, text }],
    },
  }, { translationEngine: engine });

  const pumpUntil = async (predicate, message) => {
    for (let turn = 0; turn < 60 && !predicate(); turn++) {
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(predicate(), `${message}; active=${providerState.activeRequests}; queues=${JSON.stringify(providerState.queues)}`).toBe(true);
  };

  it('shares physical capacity with Subtitle and maps out-of-order Page completions by item identity', async () => {
    const pages = [
      pageRequest(0, 'page source zero'),
      pageRequest(1, 'page source one'),
      pageRequest(2, 'page source two'),
    ];
    const subtitle = subtitleRequest();
    await pumpUntil(() => requests.length === 2, 'two requests should occupy the shared Google Classic limit');
    expect(active).toBe(2);
    expect(maximum).toBe(2);

    requests[1].release();
    await pumpUntil(() => requests.length === 3, 'a queued request should start when a provider slot is released');
    requests[2].release();
    await pumpUntil(() => requests.length === 4, 'the final request should start after the next slot release');
    requests[3].release();
    requests[0].release();

    const results = await Promise.all(pages);
    const subtitleResult = await subtitle;
    results.forEach((result, index) => {
      expect(result.success).toBe(true);
      expect(JSON.parse(result.translatedText)).toEqual([
        { id: `page-${index}`, text: `translated:page source ${['zero', 'one', 'two'][index]}` },
      ]);
    });
    expect(subtitleResult.results).toEqual([{ id: 'cue-0', text: 'translated:subtitle source' }]);
    expect(requests.some(request => request.query === 'subtitle source')).toBe(true);
    expect(maximum).toBe(2);
    expect(active).toBe(0);
    expect(providerState.activeRequests).toBe(0);
    expect(queueManager.getQueueStatus('GoogleTranslate::parallel').total).toBe(0);
    expect(queueManager.getQueueStatus('GoogleTranslate').total).toBe(0);
  });

  it('keeps separate Subtitle operations on the existing serial provider queue', async () => {
    const subtitles = [
      subtitleRequest(0, 'first subtitle'),
      subtitleRequest(1, 'second subtitle'),
    ];
    await pumpUntil(() => requests.length === 1, 'the ordinary Google queue should start one Subtitle operation');
    expect(active).toBe(1);
    requests[0].release();
    await pumpUntil(() => requests.length === 2, 'the second Subtitle should start after the first settles');
    requests[1].release();
    expect((await Promise.all(subtitles)).every(result => result.success)).toBe(true);
    expect(maximum).toBe(1);
    expect(providerState.activeRequests).toBe(0);
    expect(queueManager.getQueueStatus('GoogleTranslate').total).toBe(0);
  });

  it('keeps one AUTO owner and serially hands off an unresolved language pair', async () => {
    settings.detectionResult = {
      isReliable: false,
      languages: [{ language: 'en', percentage: 50 }],
    };
    const provider = await engine.getProvider();
    const translate = vi.spyOn(provider, 'translate');
    const pages = [
      pageRequest(0, 'An ambiguous sample.', 'auto'),
      pageRequest(1, 'Another ambiguous sample.', 'auto'),
    ];
    await pumpUntil(() => requests.length === 1, 'only the AUTO owner should call the provider while the pair is unresolved');
    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate.mock.calls[0][1]).toBe('auto');
    requests[0].release();
    await pumpUntil(() => requests.length === 2, 'a waiter should dispatch after the owner response resolves the pair');
    expect(translate.mock.calls[1][1]).toBe('auto');
    requests[1].release();
    expect((await Promise.all(pages)).every(result => result.success)).toBe(true);
    expect(maximum).toBe(1);
    expect(providerState.activeRequests).toBe(0);
  });

  it('locally resolves a concrete AUTO pair before dispatching Page siblings', async () => {
    const provider = await engine.getProvider();
    const translate = vi.spyOn(provider, 'translate');
    const sample = 'متن فارسی برای تشخیص زبان و ترجمه صفحه. '.repeat(8);
    const pages = [
      pageRequest(0, sample, 'auto', 'en'),
      pageRequest(1, sample, 'auto', 'en'),
    ];
    await pumpUntil(() => requests.length === 2, 'both Page batches should dispatch with a locally resolved pair');
    expect(translate.mock.calls.slice(0, 2).map(call => call.slice(1, 3))).toEqual([
      ['fa', 'en'],
      ['fa', 'en'],
    ]);
    requests.forEach(request => request.release());
    expect((await Promise.all(pages)).every(result => result.success)).toBe(true);
    expect(providerState.activeRequests).toBe(0);
  });

  it.each([['with Retry-After', '1'], ['without Retry-After', undefined]])(
    'retries Google Classic HTTP 429 %s within QueueManager bounds',
    async (_label, retryAfter) => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const pending = pageRequest(0, 'rate limited source');
      await pumpUntil(() => requests.length === 1, 'the initial request should reach mocked HTTP');
      const rateLimitedAt = Date.now();
      requests[0].release({
        status: 429,
        retryAfter,
        response: { error: { message: 'Too many requests' } },
      });
      await vi.advanceTimersByTimeAsync(15000);
      await pumpUntil(() => requests.length === 2, 'the bounded QueueManager retry should be sent');
      if (retryAfter) expect(requests[1].startedAt).toBeGreaterThanOrEqual(rateLimitedAt + 1000);
      requests[1].release();
      expect((await pending).success).toBe(true);
      expect(requests).toHaveLength(2);
      expect(providerState.activeRequests).toBe(0);
    }
  );

  it('shares Google Classic Retry-After cooldown with queued Page and Subtitle requests', async () => {
    const limited = pageRequest(0, 'limited source');
    const subtitle = subtitleRequest();
    const queued = pageRequest(2, 'queued source');
    await pumpUntil(() => requests.length === 2, 'Page and Subtitle should fill the provider-global physical limit');
    const limitedRequest = requests.find(request => request.query === 'limited source');
    const cooldownStart = Date.now();
    limitedRequest.release({
      status: 429,
      retryAfter: '1',
      response: { error: { message: 'Too many requests' } },
    });
    requests.find(request => request.query === 'subtitle source').release();
    await vi.advanceTimersByTimeAsync(999);
    expect(requests).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(10000);
    await pumpUntil(() => requests.length === 4, 'both the bounded retry and queued Page request should resume after the shared deadline');
    expect(requests.slice(2).every(request => request.startedAt >= cooldownStart + 1000)).toBe(true);
    requests.slice(2).forEach(request => request.release());
    expect((await Promise.all([limited, subtitle, queued])).every(result => result.success)).toBe(true);
    expect(providerState.activeRequests).toBe(0);
    expect(active).toBe(0);
  });

  it('holds a cancelled HTTP slot until the transport settles, then releases queued capacity', async () => {
    providerState.config.maxConcurrent = 1;
    const first = pageRequest(0, 'cancelled source');
    const second = pageRequest(1, 'queued source');
    let firstSettled = false;
    first.then(() => { firstSettled = true; });
    await pumpUntil(() => requests.length === 1, 'the first request should acquire the only available slot');
    controllers.get('classic-page-0').abort('user-cancelled');
    await pumpUntil(() => firstSettled, 'the coordinator should settle the cancelled operation');
    expect(requests).toHaveLength(1);
    expect(active).toBe(1);

    requests[0].release();
    await pumpUntil(() => requests.length === 2, 'the queued request should start after transport settlement');
    requests[1].release();
    expect((await first).success).toBe(false);
    expect((await second).success).toBe(true);
    expect(providerState.activeRequests).toBe(0);
    expect(active).toBe(0);
  });
});

describe('Page → YandexTranslateProvider bounded physical concurrency', () => {
  let coordinator, engine, providerState, requests, active, maximum, controllers;

  beforeEach(async () => {
    vi.clearAllMocks();
    queueManager.cleanup();
    rateLimitManager.providerStates.forEach(state => clearTimeout(state.nextProcessTimer));
    rateLimitManager.providerStates.clear();
    settings.level = 5;
    settings.keys = [];
    settings.bilingual = false;
    settings.bilingualModes = { [TranslationMode.Page]: false };
    settings.detectionResult = null;
    LanguageDetectionService.clearSessionCache();
    await rateLimitManager.reloadConfigurations();
    coordinator = new UnifiedModeCoordinator();
    const provider = new YandexTranslateProvider();
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
    providerState = rateLimitManager.providerStates.get('YandexTranslate');
    providerState.isManualConfig = true;
    providerState.config.maxConcurrent = 2;
    requests = [];
    active = 0;
    maximum = 0;
    vi.useFakeTimers();
    proxyManager.fetch.mockImplementation(async (_url, options) => {
      const body = new URLSearchParams(options.body);
      const texts = body.getAll('text');
      const request = { lang: body.get('lang'), texts, signal: options.signal, released: false, startedAt: Date.now() };
      requests.push(request);
      active++;
      maximum = Math.max(maximum, active);
      const response = await new Promise(resolve => {
        request.release = (data = {}) => {
          request.released = true;
          active--;
          resolve(data);
        };
      });
      return {
        ok: response.status !== 429,
        status: response.status || 200,
        statusText: response.status === 429 ? 'Too Many Requests' : 'OK',
        headers: new Map([['content-type', 'application/json'], ...(response.retryAfter ? [['Retry-After', response.retryAfter]] : [])]),
        json: async () => response.body || {
          code: 200,
          lang: 'en-fa',
          text: texts.map(text => `translated:${text}`),
        },
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

  const pageRequest = (index, sourceLanguage = 'en') => coordinator.processRequest({
    mode: TranslationMode.Page,
    messageId: `yandex-page-${index}`,
    data: {
      provider: 'yandex',
      sourceLanguage,
      targetLanguage: 'fa',
      sessionId: 'yandex-page-session',
      text: JSON.stringify([{ id: `page-${index}`, text: `page source ${index}` }]),
    },
  }, { translationEngine: engine });

  const subtitleRequest = () => coordinator.processRequest({
    mode: TranslationMode.Subtitle,
    messageId: 'yandex-subtitle-0',
    data: {
      provider: 'yandex',
      sourceLanguage: 'en',
      targetLanguage: 'fa',
      items: [{ id: 'cue-0', text: 'subtitle source' }],
    },
  }, { translationEngine: engine });

  const pumpUntil = async predicate => {
    for (let turn = 0; turn < 60 && !predicate(); turn++) {
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(predicate()).toBe(true);
  };

  it('shares Page and Subtitle capacity and maps out-of-order Page completion by IDs', async () => {
    const pages = [pageRequest(0), pageRequest(1), pageRequest(2)];
    const subtitle = subtitleRequest();
    await pumpUntil(() => requests.length === 2);
    expect(active).toBe(2);
    expect(maximum).toBe(2);

    requests[1].release();
    await pumpUntil(() => requests.length === 3);
    requests[2].release();
    await pumpUntil(() => requests.length === 4);
    requests[3].release();
    requests[0].release();

    const results = await Promise.all(pages);
    expect(results.map(result => JSON.parse(result.translatedText))).toEqual(
      [0, 1, 2].map(index => [{ id: `page-${index}`, text: `translated:page source ${index}` }])
    );
    expect((await subtitle).results).toEqual([{ id: 'cue-0', text: 'translated:subtitle source' }]);
    expect(maximum).toBe(2);
    expect(providerState.activeRequests).toBe(0);
    expect(queueManager.getQueueStatus('YandexTranslate::parallel').total).toBe(0);
  });

  it('serializes unresolved AUTO batches behind the owner and settles waiter after resolution', async () => {
    settings.detectionResult = { isReliable: false, languages: [{ language: 'en', percentage: 50 }] };
    const provider = await engine.getProvider();
    const translate = vi.spyOn(provider, 'translate');
    const pages = [pageRequest(0, 'auto'), pageRequest(1, 'auto')];
    await pumpUntil(() => requests.length === 1);
    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate.mock.calls[0][1]).toBe('auto');
    requests[0].release();
    await pumpUntil(() => requests.length === 2);
    expect(translate.mock.calls[1][1]).toBe('auto');
    requests[1].release();
    expect((await Promise.all(pages)).every(result => result.success)).toBe(true);
    expect(providerState.activeRequests).toBe(0);
  });

  it('uses a local AUTO source resolution for parallel Page batches', async () => {
    const sample = 'متن فارسی برای تشخیص زبان و ترجمه صفحه. '.repeat(8);
    const resolvedPages = [0, 1].map(index => coordinator.processRequest({
      mode: TranslationMode.Page,
      messageId: `yandex-auto-local-${index}`,
      data: {
        provider: 'yandex', sourceLanguage: 'auto', targetLanguage: 'en', sessionId: 'yandex-auto-session',
        text: JSON.stringify([{ id: `auto-${index}`, text: sample }]),
      },
    }, { translationEngine: engine }));
    await pumpUntil(() => requests.length === 2);
    expect(requests.map(request => request.lang)).toEqual(['fa-en', 'fa-en']);
    expect(requests.map(request => request.texts)).toEqual([[sample], [sample]]);
    requests.forEach(request => request.release());
    expect((await Promise.all(resolvedPages)).every(result => result.success)).toBe(true);
  });

  it('does not retry an HTTP-200 JSON API error code as a rate limit', async () => {
    const pending = pageRequest(0);
    await pumpUntil(() => requests.length === 1);
    requests[0].release({ body: { code: 401, text: ['not translated'], lang: 'en-fa' } });
    const result = await pending;
    expect(result.success).toBe(false);
    expect(requests).toHaveLength(1);
    expect(providerState.activeRequests).toBe(0);
  });

  it('characterizes HTTP-200 JSON code 429 separately from physical HTTP 429', async () => {
    const invalidBody = pageRequest(0);
    await pumpUntil(() => requests.length === 1);
    const startedAt = requests[0].startedAt;
    const retryAtBefore = providerState.retryAt;
    requests[0].release({ retryAfter: '10', body: { code: 429, text: [], lang: 'en-fa' } });
    expect(providerState.retryAt).toBe(retryAtBefore);
    await vi.advanceTimersByTimeAsync(30000);
    await pumpUntil(() => requests.length === 2);
    expect(requests[1].startedAt).toBeLessThan(startedAt + 10000);
    requests[1].release({ body: { code: 429, text: [], lang: 'en-fa' } });
    await vi.advanceTimersByTimeAsync(30000);
    const result = await invalidBody;
    expect(result.success).toBe(false);
    expect(requests).toHaveLength(2);
    expect(providerState.activeRequests).toBe(0);
  });

  it('keeps cancelled active transport capacity until settlement, then dispatches queued work', async () => {
    providerState.config.maxConcurrent = 1;
    const first = pageRequest(0);
    const second = pageRequest(1);
    let settled = false;
    first.then(() => { settled = true; });
    await pumpUntil(() => requests.length === 1);
    controllers.get('yandex-page-0').abort('user-cancelled');
    await pumpUntil(() => settled);
    expect(requests).toHaveLength(1);
    expect(active).toBe(1);
    requests[0].release();
    await pumpUntil(() => requests.length === 2);
    requests[1].release();
    expect((await first).success).toBe(false);
    expect((await second).success).toBe(true);
    expect(providerState.activeRequests).toBe(0);
    expect(active).toBe(0);
  });

  it('cancels a queued Page operation without sending HTTP or leaking its queue slot', async () => {
    providerState.config.maxConcurrent = 1;
    const first = pageRequest(0);
    const second = pageRequest(1);
    await pumpUntil(() => requests.length === 1);
    controllers.get('yandex-page-1').abort('user-cancelled');
    expect((await second).success).toBe(false);
    expect(requests).toHaveLength(1);
    expect(providerState.activeRequests).toBe(1);
    expect(queueManager.getQueueStatus('YandexTranslate::parallel').total).toBe(1);
    requests[0].release();
    expect((await first).success).toBe(true);
    expect(requests).toHaveLength(1);
    expect(providerState.activeRequests).toBe(0);
    await pumpUntil(() => queueManager.getQueueStatus('YandexTranslate::parallel').total === 0);
    expect(active).toBe(0);
  });

  it('retains the physical slot until transport settlement, then releases it', async () => {
    providerState.config.maxConcurrent = 1;
    const first = pageRequest(0);
    await pumpUntil(() => requests.length === 1);
    await vi.advanceTimersByTimeAsync(TRANSLATION_BATCH_EXECUTION_TIMEOUT_MS);
    const timedOut = await first;
    expect(timedOut.success).toBe(false);
    expect(requests).toHaveLength(1);
    expect(active).toBe(1);
    expect(providerState.activeRequests).toBe(1);

    requests[0].release();
    await pumpUntil(() => providerState.activeRequests === 0);
    expect((await first).success).toBe(false);
    expect(requests).toHaveLength(1);
    expect(active).toBe(0);
    expect(queueManager.getQueueStatus('YandexTranslate::parallel').total).toBe(0);
  });

  it('cancels an unresolved AUTO waiter while the owner is awaiting transport', async () => {
    settings.detectionResult = { isReliable: false, languages: [{ language: 'en', percentage: 50 }] };
    const owner = pageRequest(0, 'auto');
    const waiter = pageRequest(1, 'auto');
    await pumpUntil(() => requests.length === 1);
    controllers.get('yandex-page-1').abort('user-cancelled');
    expect((await waiter).success).toBe(false);
    expect(requests).toHaveLength(1);
    requests[0].release();
    expect((await owner).success).toBe(true);
    expect(requests).toHaveLength(1);
    expect(providerState.activeRequests).toBe(0);
    await pumpUntil(() => queueManager.getQueueStatus('YandexTranslate::parallel').total === 0);
  });

  it('keeps separate Subtitle operations on the ordinary serial provider queue', async () => {
    const subtitles = [subtitleRequest(), coordinator.processRequest({
      mode: TranslationMode.Subtitle,
      messageId: 'yandex-subtitle-1',
      data: {
        provider: 'yandex', sourceLanguage: 'en', targetLanguage: 'fa',
        items: [{ id: 'cue-1', text: 'second subtitle source' }],
      },
    }, { translationEngine: engine })];
    await pumpUntil(() => requests.length === 1);
    expect(requests[0].texts).toEqual(['subtitle source']);
    requests[0].release();
    await pumpUntil(() => requests.length === 2);
    expect(requests[1].texts).toEqual(['second subtitle source']);
    requests[1].release();
    expect((await Promise.all(subtitles)).every(result => result.success)).toBe(true);
    expect(maximum).toBe(1);
    expect(providerState.activeRequests).toBe(0);
    expect(queueManager.getQueueStatus('YandexTranslate').total).toBe(0);
  });

  it.each([['with Retry-After', '1'], ['without Retry-After', undefined]])(
    'retries a physical HTTP 429 %s within the configured retry bound',
    async (_label, retryAfter) => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const pending = pageRequest(0);
      await pumpUntil(() => requests.length === 1);
      const limitedAt = Date.now();
      requests[0].release({ status: 429, retryAfter, body: { code: 429, text: [] } });
      await vi.advanceTimersByTimeAsync(15000);
      await pumpUntil(() => requests.length === 2);
      if (retryAfter) expect(requests[1].startedAt).toBeGreaterThanOrEqual(limitedAt + 1000);
      requests[1].release();
      expect((await pending).success).toBe(true);
      expect(requests).toHaveLength(2);
      expect(providerState.activeRequests).toBe(0);
    }
  );

  it('shares a Retry-After cooldown across Page and Subtitle work', async () => {
    const limited = pageRequest(0);
    const subtitle = subtitleRequest();
    const queued = pageRequest(2);
    await pumpUntil(() => requests.length === 2);
    const firstRequest = requests.find(request => request.texts[0] === 'page source 0');
    const cooldownStart = Date.now();
    firstRequest.release({ status: 429, retryAfter: '1', body: { code: 429, text: [] } });
    requests.find(request => request.texts[0] === 'subtitle source').release();
    await vi.advanceTimersByTimeAsync(999);
    expect(requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10000);
    await pumpUntil(() => requests.length === 4);
    expect(requests.slice(2).every(request => request.startedAt >= cooldownStart + 1000)).toBe(true);
    requests.slice(2).forEach(request => request.release());
    expect((await Promise.all([limited, subtitle, queued])).every(result => result.success)).toBe(true);
    expect(providerState.activeRequests).toBe(0);
    expect(active).toBe(0);
  });

  it('stops physical RATE_LIMIT_REACHED retries at the configured maxExecutions count', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const pending = pageRequest(0);
    for (let attempt = 0; attempt < 3; attempt++) {
      await pumpUntil(() => requests.length === attempt + 1);
      requests[attempt].release({ status: 429, body: { code: 429, text: [] } });
      await vi.advanceTimersByTimeAsync(30000);
    }
    const result = await pending;
    expect(result.success).toBe(false);
    expect(requests).toHaveLength(3);
    expect(active).toBe(0);
    expect(providerState.activeRequests).toBe(0);
    await pumpUntil(() => queueManager.getQueueStatus('YandexTranslate::parallel').total === 0);
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

describe('Page → DeepLTranslateProvider bounded physical concurrency', () => {
  let coordinator, engine, providerState, controllers, requests, active, maximum;

  beforeEach(async () => {
    vi.clearAllMocks();
    queueManager.cleanup();
    rateLimitManager.providerStates.forEach(state => clearTimeout(state.nextProcessTimer));
    rateLimitManager.providerStates.clear();
    settings.level = 5;
    settings.deeplKeys = ['fixture-deepl-key'];
    settings.deeplTier = 'free';
    settings.deeplFormality = 'default';
    settings.detectionResult = null;
    settings.bilingual = false;
    settings.bilingualModes = { [TranslationMode.Page]: false };
    LanguageDetectionService.clearSessionCache();
    await rateLimitManager.reloadConfigurations();
    coordinator = new UnifiedModeCoordinator();
    const provider = new DeepLTranslateProvider();
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
    providerState = rateLimitManager.providerStates.get('DeepLTranslate');
    providerState.isManualConfig = true;
    providerState.config.maxConcurrent = 2;
    requests = [];
    active = 0;
    maximum = 0;
    vi.useFakeTimers();
    proxyManager.fetch.mockImplementation(async (url, options) => {
      const body = new URLSearchParams(options.body);
      const request = {
        url, body, texts: body.getAll('text'), signal: options.signal, released: false, startedAt: Date.now(),
      };
      requests.push(request);
      active++;
      maximum = Math.max(maximum, active);
      const response = await new Promise(resolve => {
        request.release = (status = 200, retryAfter) => {
          request.released = true;
          active--;
          resolve({ status, retryAfter });
        };
      });
      return {
        ok: response.status === 200,
        status: response.status,
        statusText: response.status === 200 ? 'OK' : response.status === 429 ? 'Too Many Requests' : 'Bad Request',
        headers: new Map([['content-type', 'application/json'], ...(response.retryAfter ? [['Retry-After', response.retryAfter]] : [])]),
        json: async () => response.status === 200
          ? { translations: request.texts.map(text => ({ text: `translated:${text}`, detected_source_language: 'EN' })) }
          : { message: 'request failed' },
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

  const pageRequest = (index, sourceLanguage = 'en', text = `page source ${index}`, sessionId = 'deepl-page-session') => coordinator.processRequest({
    mode: TranslationMode.Page,
    messageId: `deepl-page-${index}`,
    data: {
      provider: 'deepl',
      sessionId,
      sourceLanguage,
      targetLanguage: 'ja',
      text: JSON.stringify([{ id: `page-${index}`, text }]),
    },
  }, { translationEngine: engine });

  const subtitleRequest = (index, text) => coordinator.processRequest({
    mode: TranslationMode.Subtitle,
    messageId: `deepl-subtitle-${index}`,
    data: {
      provider: 'deepl',
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      items: [{ id: `cue-${index}`, text }],
    },
  }, { translationEngine: engine });

  const pumpUntil = async predicate => {
    for (let turn = 0; turn < 60 && !predicate(); turn++) {
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(predicate(), JSON.stringify({
      requests: requests.map(request => ({ texts: request.texts, released: request.released })),
      active, providerActiveRequests: providerState.activeRequests,
    })).toBe(true);
  };

  it('runs Page batches in parallel, maps reverse completion by stable IDs, and shares physical slots with Subtitle', async () => {
    const pages = [pageRequest(0), pageRequest(1), pageRequest(2)];
    await pumpUntil(() => requests.length === 2);
    expect(requests.map(request => request.texts[0])).toEqual(['page source 0', 'page source 1']);
    expect(requests.every(request => request.url === 'https://api-free.deepl.com/v2/translate')).toBe(true);
    expect(requests.every(request => request.body.get('source_lang') === 'EN' && request.body.get('target_lang') === 'JA')).toBe(true);
    expect(active).toBe(2);
    expect(maximum).toBe(2);

    const subtitle = subtitleRequest(0, 'subtitle source');
    await pumpUntil(() => Object.values(providerState.queues).reduce((count, queue) => count + queue.length, 0) >= 2);
    expect(requests).toHaveLength(2);
    requests[1].release();
    await pumpUntil(() => requests.length === 3);
    expect(requests[2].texts).toEqual(['subtitle source']);
    requests[2].release();
    await pumpUntil(() => requests.length === 4);
    expect(requests[3].texts).toEqual(['page source 2']);
    requests[3].release();
    requests[0].release();

    const results = await Promise.all(pages);
    expect(results.map(result => JSON.parse(result.translatedText))).toEqual([0, 1, 2].map(index => [
      { id: `page-${index}`, text: `translated:page source ${index}` },
    ]));
    expect((await subtitle).results).toEqual([{ id: 'cue-0', text: 'translated:subtitle source' }]);
    expect(maximum).toBe(2);
    expect(active).toBe(0);
    expect(providerState.activeRequests).toBe(0);
    expect(queueManager.getQueueStatus('DeepLTranslate::parallel').total).toBe(0);
    expect(queueManager.getQueueStatus('DeepLTranslate').total).toBe(0);
  });

  it('keeps concurrent Subtitle operations on the ordinary serial queue, without Page parallel dispatch', async () => {
    const provider = await engine.getProvider();
    const translate = vi.spyOn(provider, 'translate');
    const subtitles = [subtitleRequest(0, 'first subtitle'), subtitleRequest(1, 'second subtitle')];
    await pumpUntil(() => requests.length === 1);
    expect(requests[0].texts).toEqual(['first subtitle']);
    expect(translate.mock.calls[0][3]).not.toHaveProperty('parallelExecution');
    expect(active).toBe(1);
    requests[0].release();
    await pumpUntil(() => requests.length === 2);
    expect(requests[1].texts).toEqual(['second subtitle']);
    requests[1].release();
    expect((await Promise.all(subtitles)).every(result => result.success)).toBe(true);
    expect(maximum).toBe(1);
    expect(providerState.activeRequests).toBe(0);
  });

  it('locally resolves AUTO for parallel batches and serializes unresolved AUTO owner/waiter work', async () => {
    settings.detectionResult = { isReliable: true, languages: [{ language: 'en', percentage: 100 }] };
    const sample = 'An English sample that is long enough to resolve the AUTO source locally. '.repeat(8);
    const locallyResolved = [pageRequest(0, 'auto', sample), pageRequest(1, 'auto', sample)];
    await pumpUntil(() => requests.length === 2);
    expect(requests.map(request => request.body.get('source_lang'))).toEqual(['EN', 'EN']);
    requests.splice(0).forEach(request => request.release());
    expect((await Promise.all(locallyResolved)).every(result => result.success)).toBe(true);

    settings.detectionResult = { isReliable: false, languages: [{ language: 'en', percentage: 50 }] };
    vi.spyOn(LanguageDetectionService, 'detectDetailed')
      .mockResolvedValue({ language: null, confidence: 'unknown', provenance: 'unknown', reliable: false });
    const provider = await engine.getProvider();
    const translate = vi.spyOn(provider, 'translate');
    const unresolved = [
      pageRequest(2, 'auto', 'ambiguous sample', 'deepl-unresolved-session'),
      pageRequest(3, 'auto', 'another ambiguous sample', 'deepl-unresolved-session'),
    ];
    await pumpUntil(() => requests.length === 1);
    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate.mock.calls[0][1]).toBe('auto');
    requests[0].release();
    await pumpUntil(() => requests.length === 2);
    expect(translate.mock.calls[1][1]).toBe('auto');
    requests[1].release();
    expect((await Promise.all(unresolved)).every(result => result.success)).toBe(true);
    expect(providerState.activeRequests).toBe(0);

    requests.length = 0;
    const owner = pageRequest(4, 'auto', 'unresolved owner sample', 'deepl-cancel-auto-session');
    const waiter = pageRequest(5, 'auto', 'unresolved waiter sample', 'deepl-cancel-auto-session');
    await pumpUntil(() => requests.length === 1);
    controllers.get('deepl-page-5').abort('user-cancelled');
    expect((await waiter).success).toBe(false);
    expect(requests).toHaveLength(1);
    requests[0].release();
    expect((await owner).success).toBe(true);
    expect(providerState.activeRequests).toBe(0);
  });

  it('settles cancellation and timeout without releasing an unsettled transport slot', async () => {
    const first = pageRequest(0);
    const second = pageRequest(1);
    let firstSettled = false;
    first.then(() => { firstSettled = true; });
    await pumpUntil(() => requests.length === 2);
    controllers.get('deepl-page-0').abort('user-cancelled');
    await pumpUntil(() => firstSettled);
    expect(active).toBe(2);
    expect(providerState.activeRequests).toBe(2);
    requests[0].release();
    await pumpUntil(() => providerState.activeRequests === 1);
    requests[1].release();
    expect((await first).success).toBe(false);
    expect((await second).success).toBe(true);
    expect(active).toBe(0);

    providerState.config.maxConcurrent = 1;
    const timedOut = pageRequest(2);
    await pumpUntil(() => requests.length === 3);
    await vi.advanceTimersByTimeAsync(TRANSLATION_BATCH_EXECUTION_TIMEOUT_MS);
    expect((await timedOut).success).toBe(false);
    expect(active).toBe(1);
    expect(providerState.activeRequests).toBe(1);
    requests[2].release();
    await pumpUntil(() => providerState.activeRequests === 0);
    expect(active).toBe(0);
    await pumpUntil(() => queueManager.getQueueStatus('DeepLTranslate::parallel').total === 0);
    expect(queueManager.getQueueStatus('DeepLTranslate::parallel').total).toBe(0);
  });

  it('cancels a queued Page batch before it can start physical HTTP', async () => {
    providerState.config.maxConcurrent = 1;
    const first = pageRequest(0);
    const queued = pageRequest(1);
    await pumpUntil(() => requests.length === 1);
    expect(requests[0].texts).toEqual(['page source 0']);

    controllers.get('deepl-page-1').abort('user-cancelled');
    expect((await queued).success).toBe(false);
    expect(requests).toHaveLength(1);
    expect(providerState.activeRequests).toBe(1);

    requests[0].release();
    expect((await first).success).toBe(true);
    await pumpUntil(() => queueManager.getQueueStatus('DeepLTranslate::parallel').total === 0);
    expect(requests).toHaveLength(1);
    expect(providerState.activeRequests).toBe(0);
  });

  it('honors DeepL Retry-After across queued Page and Subtitle requests', async () => {
    providerState.config.maxConcurrent = 1;
    const limited = pageRequest(0);
    const queuedPage = pageRequest(1);
    const queuedSubtitle = subtitleRequest(0, 'queued subtitle source');
    await pumpUntil(() => requests.length === 1);
    expect(requests[0].texts).toEqual(['page source 0']);
    const limitedAt = Date.now();

    requests[0].release(429, '5');
    await vi.advanceTimersByTimeAsync(4999);
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await pumpUntil(() => requests.length >= 2);
    expect(requests[1].startedAt).toBeGreaterThanOrEqual(limitedAt + 5000);
    requests[1].release();
    await pumpUntil(() => requests.length >= 3);
    expect(requests[2].startedAt).toBeGreaterThanOrEqual(limitedAt + 5000);
    requests[2].release();

    await vi.advanceTimersByTimeAsync(15000);
    await pumpUntil(() => requests.length >= 4);
    expect(requests.slice(1).every(request => request.startedAt >= limitedAt + 5000)).toBe(true);
    expect(requests.slice(1).flatMap(request => request.texts)).toEqual(expect.arrayContaining([
      'page source 1', 'queued subtitle source',
    ]));
    requests.slice(3).forEach(request => request.release());
    await vi.advanceTimersByTimeAsync(15000);
    await pumpUntil(() => providerState.activeRequests === 0);
    expect((await Promise.all([limited, queuedPage, queuedSubtitle])).every(result => result.success)).toBe(true);
    expect(active).toBe(0);
  });
});
