import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';
import { handlePageTranslation } from './handlePageTranslation.js';
import { UnifiedModeCoordinator } from '@/core/services/translation/UnifiedModeCoordinator.js';
import { statsManager } from '@/features/translation/core/TranslationStatsManager.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { TranslationCallPurpose } from '@/features/translation/providers/ProviderConstants.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';

const dependencies = vi.hoisted(() => ({ coordinator: null }));

vi.mock('webextension-polyfill', () => ({ default: {
  runtime: { sendMessage: vi.fn(async () => ({ success: true })) },
  tabs: { onRemoved: { addListener: vi.fn() }, sendMessage: vi.fn() },
  webNavigation: { onCommitted: { addListener: vi.fn() } },
} }));

vi.mock('@/core/services/translation/UnifiedTranslationService.js', () => ({
  unifiedTranslationService: {
    clearPageSourceSession: sessionId => dependencies.coordinator.clearPageSourceLanguage(sessionId),
  },
}));

vi.mock('@/shared/storage/core/StorageCore.js', () => ({
  storageManager: { getCached: vi.fn(() => false) },
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({ debug: vi.fn(), debugLazy: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describe('Page START notification racing admitted batch execution', () => {
  let coordinator;
  let provider;
  let engine;
  let gate;
  let pending;
  const sender = { tab: { id: 42 } };
  const response = { translatedText: ['Translated'], sourceLanguage: 'en', targetLanguage: 'ja' };
  const lifecycle = (action, sessionId) => handlePageTranslation({
    action, data: { sessionId, translatedCount: 1, totalCount: 1 },
  }, sender);

  beforeEach(() => {
    vi.clearAllMocks();
    statsManager.reset();
    coordinator = new UnifiedModeCoordinator();
    dependencies.coordinator = coordinator;
    pending = [];
    let resolve;
    gate = { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) };
    provider = {
      constructor: { isAI: true },
      translate: vi.fn((items, _source, _target, options) => {
        statsManager.recordRequest('Custom', options.sessionId, items.join('').length, 0, TranslationCallPurpose.PRIMARY_TRANSLATION);
        return provider.translate.mock.calls.length === 1 ? gate.promise : Promise.resolve(response);
      }),
    };
    engine = {
      getProvider: vi.fn(async () => provider),
      lifecycleRegistry: {
        registerRequest: vi.fn(() => new AbortController()),
        unregisterRequest: vi.fn(),
      },
    };
  });

  afterEach(async () => {
    gate.resolve(response);
    for (const sessionId of coordinator.pageSourceResolvers.keys()) coordinator.clearPageSourceLanguage(sessionId);
    await Promise.all(pending);
    statsManager.reset();
  });

  const batch = (sessionId, index) => {
    const execution = coordinator.processPageTranslation({
      messageId: `${sessionId}-batch-${index}`, sessionId,
      data: { provider: 'custom', sourceLanguage: 'auto', targetLanguage: 'ja', text: [{ id: index, text: `Source ${index}` }] },
    }, { translationEngine: engine });
    pending.push(execution);
    return execution;
  };

  it('keeps admitted owner, waiters and physical statistics across delayed repeated START notifications', async () => {
    const sessionId = 'page-fresh-1';
    const executions = [0, 1, 2, 3].map(index => batch(sessionId, index));
    await vi.waitFor(() => expect(provider.translate).toHaveBeenCalledOnce());
    expect(engine.getProvider).toHaveBeenCalledTimes(4);
    const resolver = coordinator.pageSourceResolvers.get(sessionId);
    await lifecycle(MessageActions.PAGE_TRANSLATE_START, sessionId);
    await lifecycle(MessageActions.PAGE_TRANSLATE_START, sessionId);
    const preservedWhilePending = coordinator.pageSourceResolvers.get(sessionId) === resolver;
    const callsWhilePending = statsManager.getSessionSummary(sessionId)?.calls;
    gate.resolve(response);
    const results = await Promise.all(executions);
    expect({ preservedWhilePending, callsWhilePending, successes: results.map(result => result.success) }).toEqual({
      preservedWhilePending: true, callsWhilePending: 1, successes: [true, true, true, true],
    });
    expect(provider.translate.mock.calls.map(([, source]) => source)).toEqual(['auto', 'en', 'en', 'en']);
    expect(statsManager.getSessionSummary(sessionId).calls).toBe(4);
    await lifecycle(MessageActions.PAGE_TRANSLATE_START, sessionId);
    expect(coordinator.pageSourceResolvers.get(sessionId)).toBe(resolver);
    expect(statsManager.getSessionSummary(sessionId).calls).toBe(4);
    expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(3);
  });

  it('leaves initialization lazy when START arrives before any batch', async () => {
    const sessionId = 'page-before-batch';
    await lifecycle(MessageActions.PAGE_TRANSLATE_START, sessionId);
    expect(coordinator.pageSourceResolvers.size).toBe(0);
    expect(statsManager.getSessionSummary(sessionId)).toBeNull();
    const execution = batch(sessionId, 0);
    await vi.waitFor(() => expect(provider.translate).toHaveBeenCalledOnce());
    gate.resolve(response);
    expect((await execution).success).toBe(true);
    expect(coordinator.pageSourceResolvers.get(sessionId).effectiveSourceLanguage).toBe('en');
    expect(statsManager.getSessionSummary(sessionId).calls).toBe(1);
  });

  it.each([
    MessageActions.PAGE_TRANSLATE_CANCELLED, MessageActions.PAGE_RESTORE_COMPLETE,
    MessageActions.PAGE_TRANSLATE_ERROR, MessageActions.PAGE_TRANSLATE_COMPLETE,
  ])('still releases terminal waiters and prevents late owner resurrection for %s', async action => {
    const sessionId = 'page-terminal-1';
    const owner = batch(sessionId, 0);
    const waiter = batch(sessionId, 1);
    await vi.waitFor(() => expect(provider.translate).toHaveBeenCalledOnce());
    await lifecycle(action, sessionId);
    expect(coordinator.pageSourceResolvers.has(sessionId)).toBe(false);
    expect(await waiter).toMatchObject({ success: false, errorType: ErrorTypes.USER_CANCELLED });
    gate.resolve(response);
    await owner;
    expect(coordinator.pageSourceResolvers.has(sessionId)).toBe(false);
    if ([MessageActions.PAGE_TRANSLATE_CANCELLED, MessageActions.PAGE_RESTORE_COMPLETE].includes(action)) {
      expect(statsManager.getSessionSummary(sessionId)).toBeNull();
    }
  });

  it('keeps a fresh manual restart independent of old session terminal notifications', async () => {
    const old = batch('page-old', 0);
    await vi.waitFor(() => expect(provider.translate).toHaveBeenCalledOnce());
    await lifecycle(MessageActions.PAGE_TRANSLATE_CANCELLED, 'page-old');
    const fresh = batch('page-manual-new', 0);
    expect((await fresh).success).toBe(true);
    const current = coordinator.pageSourceResolvers.get('page-manual-new');
    await lifecycle(MessageActions.PAGE_TRANSLATE_START, 'page-manual-new');
    await lifecycle(MessageActions.PAGE_RESTORE_COMPLETE, 'page-old');
    gate.resolve(response);
    await old;
    expect(coordinator.pageSourceResolvers.has('page-old')).toBe(false);
    expect(coordinator.pageSourceResolvers.get('page-manual-new')).toBe(current);
    expect(statsManager.getSessionSummary('page-manual-new').calls).toBe(1);
  });
});
