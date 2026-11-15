import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/translation/core/QueueManager.js', () => ({
  queueManager: { cancelByMessageId: vi.fn() },
}));
vi.mock('@/features/translation/core/RateLimitManager.js', () => ({
  rateLimitManager: { clearPendingRequests: vi.fn() },
}));
vi.mock('@/features/translation/ir/TerminalExecutionRouter.js', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    TerminalExecutionRouter: {
      ...actual.TerminalExecutionRouter,
      routeTerminalExecution: vi.fn(actual.TerminalExecutionRouter.routeTerminalExecution),
    },
  };
});

import { translationRequestTracker } from './TranslationRequestTracker.js';
import { unifiedTranslationService } from './UnifiedTranslationService.js';
import { backgroundOperationLease } from './BackgroundOperationLease.js';
import { handleCancelTranslation } from '@/features/translation/handlers/handleCancelTranslation.js';
import * as config from '@/shared/config/config.js';
import * as translationOperations from '@/features/translation/ir/TranslationOperation.js';
import { TranslationMode } from '@/shared/config/config.js';
import { TerminalExecutionRouter } from '@/features/translation/ir/TerminalExecutionRouter.js';
import { streamingManager } from '@/features/translation/core/StreamingManager.js';
import { createRequestUnitManifest } from '@/features/translation/ir/RequestUnitManifest.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('UnifiedTranslationService cancellation admission integration', () => {
  let providerLookup;
  let enteredLookup;
  let providerLookupPending;
  let processRequest;
  let dispatchResult;
  let finalizeOperation;
  let engine;
  let holdFirstProviderLookup;
  let otherContextExecution;
  let otherContextEntered;
  let otherSessionExecution;
  let otherSessionEntered;
  let otherTabExecution;
  let otherTabEntered;
  let terminalCompletion;
  let terminalCompletionEntered;
  let streamInfo;
  let streamComplete;
  let settingsLookup;

  beforeEach(() => {
    vi.clearAllMocks();
    translationRequestTracker.clear();
    translationRequestTracker.startCleanup();
    providerLookup = vi.spyOn(config, 'getModeProvidersAsync');
    enteredLookup = deferred();
    providerLookupPending = deferred();
    holdFirstProviderLookup = true;
    processRequest = vi.spyOn(unifiedTranslationService.modeCoordinator, 'processRequest');
    dispatchResult = vi.spyOn(unifiedTranslationService.resultDispatcher, 'dispatchResult');
    finalizeOperation = vi.spyOn(translationOperations, 'finalizeTranslationOperation');
    otherContextExecution = deferred();
    otherContextEntered = deferred();
    otherSessionExecution = deferred();
    otherSessionEntered = deferred();
    otherTabExecution = deferred();
    otherTabEntered = deferred();
    engine = { cancelTranslation: vi.fn().mockResolvedValue(true) };
    globalThis.backgroundService = { translationEngine: engine };
    unifiedTranslationService.initialize({ translationEngine: engine, backgroundService: globalThis.backgroundService });
    providerLookup.mockImplementation(() => {
      if (holdFirstProviderLookup && translationRequestTracker.getRequest('request-A')) {
        holdFirstProviderLookup = false;
        enteredLookup.resolve();
        return providerLookupPending.promise;
      }
      return Promise.resolve({});
    });
    processRequest.mockImplementation(request => {
      if (request.messageId === 'other-context') {
        otherContextEntered.resolve();
        return otherContextExecution.promise;
      }
      if (request.messageId === 'other-session') {
        otherSessionEntered.resolve();
        return otherSessionExecution.promise;
      }
      if (request.messageId === 'other-tab') {
        otherTabEntered.resolve();
        return otherTabExecution.promise;
      }
      return Promise.resolve({ success: true, translatedText: request.messageId });
    });
    dispatchResult.mockResolvedValue(undefined);
  });

  afterEach(() => {
    providerLookup.mockRestore();
    processRequest.mockRestore();
    dispatchResult.mockRestore();
    finalizeOperation.mockRestore();
    streamInfo?.mockRestore();
    streamComplete?.mockRestore();
    settingsLookup?.mockRestore();
    translationRequestTracker.clear();
    translationRequestTracker.stopCleanup();
    delete globalThis.backgroundService;
  });

  it.each(['resolve', 'reject'])('admits before provider lookup and suppresses late %s after matching cancellation', async outcome => {
    const pageText = JSON.stringify([{ i: 'n1', t: 'hello' }]);
    const start = (messageId, { tabId = 42, context = 'page-translation-batch', sessionId = messageId } = {}) =>
      unifiedTranslationService.handleTranslationRequest({
        action: 'TRANSLATE',
        messageId,
        context,
        data: { text: pageText, mode: TranslationMode.Page, provider: 'google', sessionId },
      }, { tab: { id: tabId }, frameId: 0 });

    const requestA = start('request-A', { sessionId: 'A' });
    await enteredLookup.promise;
    const otherContext = start('other-context', { context: 'content', sessionId: 'A' });
    const otherSession = start('other-session', { sessionId: 'B' });
    const otherTab = start('other-tab', { tabId: 43, sessionId: 'A' });
    await Promise.all([otherContextEntered.promise, otherSessionEntered.promise, otherTabEntered.promise]);

    expect(translationRequestTracker.getTabRequests(42).map(({ messageId }) => messageId)).toContain('request-A');
    expect(backgroundOperationLease.getStatus().activeOperationIds).toContain('request-A');

    const cancellation = await handleCancelTranslation({
      data: { cancelAll: true, context: 'page-translation-batch', sessionId: 'A', reason: 'operation-abort' },
    }, { tab: { id: 42 } });
    expect(cancellation).toMatchObject({ success: true, cancelledCount: 1 });
    expect(translationRequestTracker.getRequest('request-A').status).toBe('cancelled');
    expect(translationRequestTracker.getRequest('other-context').status).toBe('pending');
    expect(translationRequestTracker.getRequest('other-session').status).toBe('pending');
    expect(translationRequestTracker.getRequest('other-tab').status).toBe('pending');
    expect(translationRequestTracker.getTabRequests(42).map(({ messageId }) => messageId)).toContain('other-session');
    expect(translationRequestTracker.getTabRequests(43).map(({ messageId }) => messageId)).toContain('other-tab');
    expect(translationRequestTracker.getTabRequests(42).map(({ messageId }) => messageId)).not.toContain('request-A');
    expect(backgroundOperationLease.getStatus().activeOperationIds).toContain('request-A');
    expect(engine.cancelTranslation).toHaveBeenCalledTimes(1);
    expect(engine.cancelTranslation).toHaveBeenCalledWith('request-A', false, undefined, 'operation-abort');
    expect(finalizeOperation.mock.calls.filter(([context]) => context.operation?.messageId === 'request-A')).toHaveLength(1);

    const requestB = start('request-B', { sessionId: 'B' });
    await expect(requestB).resolves.toMatchObject({ success: true });
    const repeated = await handleCancelTranslation({
      data: { cancelAll: true, context: 'page-translation-batch', sessionId: 'A', reason: 'operation-abort' },
    }, { tab: { id: 42 } });
    expect(repeated).toMatchObject({ success: true, cancelledCount: 0 });
    expect(translationRequestTracker.getRequest('other-context').status).toBe('pending');
    expect(translationRequestTracker.getRequest('other-session').status).toBe('pending');
    expect(translationRequestTracker.getRequest('other-tab').status).toBe('pending');
    expect(engine.cancelTranslation).toHaveBeenCalledTimes(1);

    if (outcome === 'resolve') providerLookupPending.resolve({});
    else providerLookupPending.reject(new Error('late provider lookup failure'));
    await expect(requestA).resolves.toMatchObject({ success: false, cancelled: true });
    expect(translationRequestTracker.getRequest('request-A').status).toBe('cancelled');
    expect(processRequest.mock.calls.filter(([request]) => request.messageId === 'request-A')).toHaveLength(0);
    expect(finalizeOperation.mock.calls.filter(([context]) => context.operation?.messageId === 'request-A')).toHaveLength(1);
    expect(backgroundOperationLease.getStatus().activeOperationIds).not.toContain('request-A');

    otherContextExecution.resolve({ success: true, translatedText: 'other context result' });
    otherSessionExecution.resolve({ success: true, translatedText: 'session B result' });
    otherTabExecution.resolve({ success: true, translatedText: 'other tab result' });
    await Promise.all([otherContext, otherSession, otherTab]);
    expect(processRequest).toHaveBeenCalledTimes(4);
    expect(dispatchResult).toHaveBeenCalledTimes(4);
    expect(finalizeOperation).toHaveBeenCalledTimes(5);
  });

  it.each([
    ['cancel', 'provider', 'resolve'],
    ['cancel', 'provider', 'reject'],
    ['cancel', 'settings', 'resolve'],
    ['cancel', 'settings', 'reject'],
    ['timeout', 'provider', 'resolve'],
    ['timeout', 'provider', 'reject'],
    ['timeout', 'settings', 'resolve'],
    ['timeout', 'settings', 'reject'],
  ])('%s retains operation during pending stream completion after preparation %s/%s', async (terminalKind, stage, outcome) => {
    const messageId = `terminal-race-${terminalKind}-${stage}-${outcome}`;
    const preparation = deferred();
    const preparationEntered = deferred();
    terminalCompletion = deferred();
    terminalCompletionEntered = deferred();

    if (stage === 'provider') {
      providerLookup.mockImplementationOnce(() => {
        preparationEntered.resolve();
        return preparation.promise;
      });
    } else {
      holdFirstProviderLookup = false;
      providerLookup.mockImplementation(() => Promise.resolve({}));
      settingsLookup = vi.spyOn(config, 'getPopupMaxCharsAsync');
      settingsLookup.mockImplementationOnce(() => {
        preparationEntered.resolve();
        return preparation.promise;
      });
    }

    streamInfo = vi.spyOn(streamingManager, 'getStreamInfo').mockReturnValue({
      providerName: 'Google',
      processedSegments: 0,
    });
    streamComplete = vi.spyOn(streamingManager, 'completeStream').mockImplementation(() => {
      terminalCompletionEntered.resolve();
      return terminalCompletion.promise;
    });

    const data = { text: 'hello', mode: 'selection', provider: 'google', sessionId: messageId };
    const requestPromise = unifiedTranslationService.handleTranslationRequest({
      action: 'TRANSLATE',
      messageId,
      context: stage === 'settings' ? 'popup' : 'content',
      data,
    }, { tab: { id: 42 }, frameId: 0 });
    await preparationEntered.promise;

    const request = translationRequestTracker.getRequest(messageId);
    const operation = unifiedTranslationService._getOperation(request);
    expect(operation).toBeTruthy();

    const terminalPromise = terminalKind === 'cancel'
      ? unifiedTranslationService.cancelRequest(messageId, 'race-cancel')
      : unifiedTranslationService.handleTimeout(messageId, 'race-timeout', 'FINAL_TIMEOUT');
    await terminalCompletionEntered.promise;
    expect(request.status).toBe(terminalKind === 'cancel' ? 'cancelled' : 'timeout');

    if (outcome === 'resolve') preparation.resolve({});
    else preparation.reject(new Error('late preparation failure'));
    await expect(requestPromise).resolves.toMatchObject(
      terminalKind === 'cancel'
        ? { success: false, cancelled: true }
        : { success: false, timedOut: true },
    );

    expect(unifiedTranslationService._getOperation(request)).toBe(operation);
    expect(processRequest.mock.calls.filter(([executionRequest]) => executionRequest.messageId === messageId)).toHaveLength(0);
    expect(TerminalExecutionRouter.routeTerminalExecution).not.toHaveBeenCalled();
    expect(finalizeOperation.mock.calls.filter(([context]) => context.operation === operation)).toHaveLength(0);

    terminalCompletion.resolve();
    await expect(terminalPromise).resolves.toMatchObject({ handled: true, success: true });
    expect(TerminalExecutionRouter.routeTerminalExecution).toHaveBeenCalledTimes(1);
    expect(TerminalExecutionRouter.routeTerminalExecution).toHaveBeenCalledWith(operation, {
      status: terminalKind === 'cancel' ? 'cancelled' : 'timeout',
    });
    expect(finalizeOperation.mock.calls.filter(([context]) => context.operation === operation)).toHaveLength(1);
    expect(operation.finalized).toBe(true);
    expect(operation.snapshotCancelled()).toEqual(
      terminalKind === 'cancel'
        ? createRequestUnitManifest(data.text).units.map(({ unitId }) => unitId)
        : [],
    );
    expect(unifiedTranslationService._getOperation(request)).toBeNull();
    expect(translationRequestTracker._getDiagnosticReport(request).entries.at(-1).type)
      .toBe(terminalKind === 'cancel' ? 'OPERATION_CANCELLED' : 'OPERATION_TIMEOUT');
  });
});
