import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, onMounted: vi.fn((callback) => callback()) };
});

vi.mock('@/utils/browser/compatibility.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    deviceDetector: { ...actual.deviceDetector, isMobile: vi.fn(() => false) },
  };
});

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const getPageTranslationErrorPresentationMock = vi.hoisted(() => vi.fn());

vi.mock('@/features/page-translation/utils/PageTranslationErrorPresenter.js', async (importOriginal) => {
  const actual = await importOriginal();
  getPageTranslationErrorPresentationMock.mockImplementation(actual.getPageTranslationErrorPresentation);
  return { ...actual, getPageTranslationErrorPresentation: getPageTranslationErrorPresentationMock };
});

import { useContentAppPageTranslation } from './useContentAppPageTranslation.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { getPageTranslationErrorPresentation } from '@/features/page-translation/utils/PageTranslationErrorPresenter.js';

const createDeferred = () => {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
};

describe('useContentAppPageTranslation', () => {
  let listeners;
  let mobileStore;

  beforeEach(() => {
    listeners = new Map();
    mobileStore = {
      pageTranslationData: {
        isTranslating: true,
        isAutoTranslating: false,
        isTranslated: false,
        status: 'translating',
        errorMessage: 'stale error',
      },
      setPageTranslation: vi.fn((state) => Object.assign(mobileStore.pageTranslationData, state)),
      resetPageTranslation: vi.fn(),
      closeSheet: vi.fn(),
      openSheet: vi.fn(),
      setView: vi.fn(),
      setSheetState: vi.fn(),
      updateSelectionData: vi.fn(),
      setHasElementTranslations: vi.fn(),
    };
    window.pageEventBus = {};

    useContentAppPageTranslation(mobileStore, {
      addEventListener: vi.fn((_, action, callback) => listeners.set(action, callback)),
    });
  });

  it('stores safe structured error text and preserves fatal state semantics', async () => {
    const raw = 'raw provider response body';
    await listeners.get(MessageActions.PAGE_TRANSLATE_ERROR)({
      error: raw,
      errorDetails: { type: 'MODEL_NOT_FOUND', message: raw },
      isFatal: true,
      isAggregated: true,
      isTranslating: false,
      isAutoTranslating: false,
    });

    const state = mobileStore.setPageTranslation.mock.calls[0][0];
    expect(state.errorMessage).not.toBe(raw);
    expect(state.status).toBe('error');
    expect(state.isTranslating).toBe(false);
  });

  it('preserves translated state after fatal partial output', async () => {
    mobileStore.pageTranslationData.isTranslated = true;
    mobileStore.pageTranslationData.translatedCount = 1;

    await listeners.get(MessageActions.PAGE_TRANSLATE_ERROR)({
      errorDetails: { type: ErrorTypes.NETWORK_ERROR, message: 'network failure' },
      translatedCount: 1,
      isFatal: true,
      isAggregated: true,
    });

    expect(mobileStore.setPageTranslation).toHaveBeenCalledWith(expect.objectContaining({
      isTranslated: true,
      translatedCount: 1,
      status: 'error',
    }));
  });

  it.each([true, false])('clears fatal presentation while preserving translated content when isTranslated=%s', (isTranslated) => {
    mobileStore.pageTranslationData = {
      isTranslating: false,
      isAutoTranslating: false,
      isTranslated,
      translatedCount: 2,
      failedCount: 1,
      totalCount: 3,
      status: 'error',
      errorMessage: 'fatal failure',
    };

    listeners.get(MessageActions.PAGE_TRANSLATE_RESET_ERROR)();

    expect(mobileStore.resetPageTranslation).not.toHaveBeenCalled();
    expect(mobileStore.setPageTranslation).toHaveBeenCalledWith({
      isTranslating: false,
      isAutoTranslating: false,
      isTranslated: true,
      status: 'completed',
      errorMessage: null,
    });
    expect(mobileStore.pageTranslationData).toMatchObject({
      isTranslated: true,
      translatedCount: 2,
      failedCount: 1,
      totalCount: 3,
      status: 'completed',
      errorMessage: null,
    });
  });

  it('keeps fatal zero-commit error presentation without Mobile retry state', async () => {
    await listeners.get(MessageActions.PAGE_TRANSLATE_ERROR)({
      errorDetails: { type: ErrorTypes.NETWORK_ERROR, message: 'network failure' },
      translatedCount: 0,
      isFatal: true,
      isAggregated: true,
    });

    expect(mobileStore.setPageTranslation).toHaveBeenCalledWith(expect.objectContaining({
      isTranslated: false,
      status: 'error',
    }));
    expect(mobileStore.pageTranslationData).not.toHaveProperty('canRetry');
  });

  it('ignores raw main fatal errors until aggregate delivery', async () => {
    const before = { ...mobileStore.pageTranslationData };

    await listeners.get(MessageActions.PAGE_TRANSLATE_ERROR)({
      errorDetails: { type: ErrorTypes.NETWORK_ERROR, message: 'network failure' },
      translatedCount: 0,
      isFatal: true,
    });

    expect(mobileStore.setPageTranslation).not.toHaveBeenCalled();
    expect(mobileStore.pageTranslationData).toEqual(before);
  });

  it('consumes aggregate fatal counts and preserves active sibling state', async () => {
    await listeners.get(MessageActions.PAGE_TRANSLATE_ERROR)({
      errorDetails: { type: ErrorTypes.NETWORK_ERROR, message: 'network failure' },
      translatedCount: 3,
      failedCount: 1,
      totalCount: 4,
      isFatal: true,
      isAggregated: true,
      isTranslating: true,
      isAutoTranslating: true,
    });

    expect(mobileStore.setPageTranslation).toHaveBeenCalledWith(expect.objectContaining({
      translatedCount: 3,
      isTranslated: true,
      isTranslating: true,
      isAutoTranslating: true,
      status: 'error',
    }));
  });

  it('suppresses Retry for aggregate iframe failure with main committed output', async () => {
    await listeners.get(MessageActions.PAGE_TRANSLATE_ERROR)({
      errorDetails: { type: ErrorTypes.NETWORK_ERROR, message: 'iframe failure' },
      translatedCount: 5,
      failedCount: 1,
      totalCount: 6,
      isFatal: true,
      isAggregated: true,
    });

    expect(mobileStore.setPageTranslation).toHaveBeenCalledWith(expect.objectContaining({
      translatedCount: 5,
      isTranslated: true,
      status: 'error',
    }));
  });

  it('does not reset active zero-progress translation on error reset', () => {
    mobileStore.pageTranslationData = {
      isTranslating: true,
      isAutoTranslating: false,
      isTranslated: false,
      translatedCount: 0,
      failedCount: 0,
      totalCount: 4,
      status: 'translating',
      errorMessage: null,
    };
    const before = { ...mobileStore.pageTranslationData };

    listeners.get(MessageActions.PAGE_TRANSLATE_RESET_ERROR)();

    expect(mobileStore.resetPageTranslation).not.toHaveBeenCalled();
    expect(mobileStore.setPageTranslation).not.toHaveBeenCalled();
    expect(mobileStore.pageTranslationData).toEqual(before);
  });

  it('does not complete active partial translation on error reset', () => {
    mobileStore.pageTranslationData = {
      isTranslating: true,
      isAutoTranslating: true,
      isTranslated: true,
      translatedCount: 2,
      failedCount: 1,
      totalCount: 4,
      status: 'translating',
      errorMessage: null,
    };
    const before = { ...mobileStore.pageTranslationData };

    listeners.get(MessageActions.PAGE_TRANSLATE_RESET_ERROR)();

    expect(mobileStore.resetPageTranslation).not.toHaveBeenCalled();
    expect(mobileStore.setPageTranslation).not.toHaveBeenCalled();
    expect(mobileStore.pageTranslationData).toEqual(before);
  });

  it('fully resets zero-commit state when fatal presentation is dismissed', () => {
    mobileStore.pageTranslationData = {
      isTranslating: false,
      isAutoTranslating: false,
      isTranslated: false,
      translatedCount: 0,
      failedCount: 3,
      totalCount: 3,
      status: 'error',
      errorMessage: 'fatal failure',
    };

    listeners.get(MessageActions.PAGE_TRANSLATE_RESET_ERROR)();

    expect(mobileStore.resetPageTranslation).toHaveBeenCalledOnce();
    expect(mobileStore.setPageTranslation).not.toHaveBeenCalled();
  });

  it.each(['error', 'completed'])('fully resets state after restore completion from %s state', (status) => {
    mobileStore.pageTranslationData = {
      isTranslating: false,
      isAutoTranslating: false,
      isTranslated: true,
      translatedCount: 2,
      failedCount: 1,
      totalCount: 3,
      status,
      errorMessage: status === 'error' ? 'fatal failure' : null,
    };

    listeners.get(MessageActions.PAGE_RESTORE_COMPLETE)();

    expect(mobileStore.resetPageTranslation).toHaveBeenCalledOnce();
    expect(mobileStore.setPageTranslation).not.toHaveBeenCalled();
  });

  it('marks partial completion without entering error state', async () => {
    await listeners.get(MessageActions.PAGE_TRANSLATE_COMPLETE)({
      translatedCount: 2,
      failedCount: 1,
      totalCount: 3,
    });

    expect(mobileStore.setPageTranslation).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      isTranslated: true,
      translatedCount: 2,
      failedCount: 1,
      totalCount: 3,
    }));
  });

  it.each([
    [MessageActions.PAGE_TRANSLATE_START, { isAggregated: true }],
    [MessageActions.PAGE_TRANSLATE_IDLE, { isAggregated: true }],
    [MessageActions.PAGE_TRANSLATE_COMPLETE, { isAggregated: true }],
    [MessageActions.PAGE_TRANSLATE_ERROR, {
      isAggregated: true, isFatal: true,
      errorDetails: { type: ErrorTypes.NETWORK_ERROR, message: 'partial failure' },
    }],
    [MessageActions.PAGE_AUTO_RESTORE_COMPLETE, { isAggregated: true }],
  ])('preserves Restore availability for %s with zero progress count', async (action, extra) => {
    await listeners.get(action)({
      ...extra,
      translatedCount: 0,
      failedCount: 0,
      totalCount: 0,
      isTranslated: true,
      isTranslating: false,
      isAutoTranslating: false,
    });

    expect(mobileStore.setPageTranslation).toHaveBeenCalledWith(expect.objectContaining({
      isTranslated: true,
      translatedCount: 0,
    }));
  });

  it('ignores raw main auto-restore state', () => {
    mobileStore.pageTranslationData = {
      ...mobileStore.pageTranslationData,
      isTranslated: true,
      translatedCount: 3,
      status: 'completed',
    };
    const before = { ...mobileStore.pageTranslationData };

    listeners.get(MessageActions.PAGE_AUTO_RESTORE_COMPLETE)({
      translatedCount: 0,
      isTranslated: false,
      isAggregated: false,
    });

    expect(mobileStore.setPageTranslation).not.toHaveBeenCalled();
    expect(mobileStore.pageTranslationData).toEqual(before);
  });

  it('consumes aggregate auto-restore state without losing global counts', () => {
    listeners.get(MessageActions.PAGE_AUTO_RESTORE_COMPLETE)({
      translatedCount: 3,
      failedCount: 1,
      totalCount: 4,
      isTranslated: true,
      isTranslating: true,
      isAutoTranslating: true,
      isAggregated: true,
    });

    expect(mobileStore.setPageTranslation).toHaveBeenCalledWith({
      isTranslating: true,
      isAutoTranslating: true,
      isTranslated: true,
      status: 'translating',
      translatedCount: 3,
      failedCount: 1,
      totalCount: 4,
    });
  });

  it('does not regress aggregate truth when raw fatal events follow aggregate events', async () => {
    await listeners.get(MessageActions.PAGE_AUTO_RESTORE_COMPLETE)({
      translatedCount: 3,
      failedCount: 1,
      totalCount: 4,
      isTranslated: true,
      isTranslating: false,
      isAutoTranslating: false,
      isAggregated: true,
    });
    await listeners.get(MessageActions.PAGE_AUTO_RESTORE_COMPLETE)({
      translatedCount: 0,
      isTranslated: false,
      isAggregated: false,
    });
    await listeners.get(MessageActions.PAGE_TRANSLATE_ERROR)({
      errorDetails: { type: ErrorTypes.NETWORK_ERROR, message: 'main failure' },
      translatedCount: 0,
      isFatal: true,
    });
    await listeners.get(MessageActions.PAGE_TRANSLATE_ERROR)({
      errorDetails: { type: ErrorTypes.NETWORK_ERROR, message: 'main failure' },
      translatedCount: 3,
      failedCount: 1,
      totalCount: 4,
      isFatal: true,
      isAggregated: true,
    });

    expect(mobileStore.pageTranslationData).toMatchObject({
      translatedCount: 3,
      isTranslated: true,
      status: 'error',
    });
  });

  it('discards a pending error presentation after reset', async () => {
    const decision = createDeferred();
    getPageTranslationErrorPresentation.mockReturnValueOnce(decision.promise);
    mobileStore.pageTranslationData = {
      isTranslating: true,
      isAutoTranslating: false,
      isTranslated: false,
      translatedCount: 0,
      failedCount: 0,
      totalCount: 4,
      status: 'translating',
      errorMessage: null,
    };

    const errorPromise = listeners.get(MessageActions.PAGE_TRANSLATE_ERROR)({
      errorDetails: { type: ErrorTypes.NETWORK_ERROR, message: 'stale failure' },
      isFatal: true,
      isAggregated: true,
    });
    listeners.get(MessageActions.PAGE_TRANSLATE_RESET_ERROR)();

    decision.resolve(new Error('stale failure'));
    await errorPromise;

    expect(mobileStore.pageTranslationData).toMatchObject({
      status: 'translating',
      errorMessage: null,
    });
    expect(mobileStore.setPageTranslation).not.toHaveBeenCalled();
  });

  it('keeps a later error presentation authoritative after reset invalidates an earlier one', async () => {
    const firstDecision = createDeferred();
    const secondDecision = createDeferred();
    getPageTranslationErrorPresentation
      .mockReturnValueOnce(firstDecision.promise)
      .mockReturnValueOnce(secondDecision.promise);
    mobileStore.pageTranslationData = {
      isTranslating: true,
      isAutoTranslating: false,
      isTranslated: false,
      translatedCount: 0,
      failedCount: 0,
      totalCount: 4,
      status: 'translating',
      errorMessage: null,
    };

    const firstError = listeners.get(MessageActions.PAGE_TRANSLATE_ERROR)({
      errorDetails: { type: ErrorTypes.NETWORK_ERROR, message: 'error A' },
      isFatal: true,
      isAggregated: true,
    });
    listeners.get(MessageActions.PAGE_TRANSLATE_RESET_ERROR)();
    const secondError = listeners.get(MessageActions.PAGE_TRANSLATE_ERROR)({
      errorDetails: { type: ErrorTypes.NETWORK_ERROR, message: 'error B' },
      isFatal: true,
      isAggregated: true,
    });

    secondDecision.resolve(new Error('error B'));
    await secondError;
    firstDecision.resolve(new Error('error A'));
    await firstError;

    expect(mobileStore.pageTranslationData).toMatchObject({
      status: 'error',
      errorMessage: 'error B',
    });
  });

  it('keeps duplicate zero-output resets deterministic', () => {
    mobileStore.resetPageTranslation.mockImplementation(() => {
      Object.assign(mobileStore.pageTranslationData, {
        isTranslating: false,
        isAutoTranslating: false,
        isTranslated: false,
        translatedCount: 0,
        failedCount: 0,
        totalCount: 0,
        status: 'idle',
        errorMessage: null,
      });
    });
    mobileStore.pageTranslationData = {
      isTranslating: false,
      isAutoTranslating: false,
      isTranslated: false,
      translatedCount: 0,
      failedCount: 2,
      totalCount: 2,
      status: 'error',
      errorMessage: 'fatal failure',
    };

    listeners.get(MessageActions.PAGE_TRANSLATE_RESET_ERROR)();
    listeners.get(MessageActions.PAGE_TRANSLATE_RESET_ERROR)();

    expect(mobileStore.resetPageTranslation).toHaveBeenCalledOnce();
    expect(mobileStore.pageTranslationData).toMatchObject({
      status: 'idle',
      isTranslated: false,
      translatedCount: 0,
      errorMessage: null,
    });
  });

  it('keeps duplicate partial-output resets deterministic', () => {
    mobileStore.pageTranslationData = {
      isTranslating: false,
      isAutoTranslating: false,
      isTranslated: true,
      translatedCount: 2,
      failedCount: 1,
      totalCount: 3,
      status: 'error',
      errorMessage: 'fatal failure',
    };

    listeners.get(MessageActions.PAGE_TRANSLATE_RESET_ERROR)();
    listeners.get(MessageActions.PAGE_TRANSLATE_RESET_ERROR)();

    expect(mobileStore.pageTranslationData).toMatchObject({
      status: 'completed',
      isTranslated: true,
      translatedCount: 2,
      failedCount: 1,
      totalCount: 3,
      errorMessage: null,
    });
  });

  it('ignores non-fatal page errors at presentation-state boundary', async () => {
    const before = { ...mobileStore.pageTranslationData };

    await listeners.get(MessageActions.PAGE_TRANSLATE_ERROR)({
      errorDetails: { type: 'HTTP_ERROR', statusCode: 409, message: 'retryable' },
      isFatal: false,
    });

    expect(mobileStore.setPageTranslation).not.toHaveBeenCalled();
    expect(mobileStore.pageTranslationData).toEqual(before);
  });

  it('clears stale error state when translation starts', () => {
    listeners.get(MessageActions.PAGE_TRANSLATE_START)({});

    expect(mobileStore.setPageTranslation).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: null,
      failedCount: 0,
    }));
  });

  it('clears stale error state after partial completion', async () => {
    await listeners.get(MessageActions.PAGE_TRANSLATE_ERROR)({
      errorDetails: { type: 'HTTP_ERROR', statusCode: 409, message: 'retryable' },
      isFatal: false,
    });
    await listeners.get(MessageActions.PAGE_TRANSLATE_COMPLETE)({
      translatedCount: 2,
      failedCount: 1,
      totalCount: 3,
    });

    expect(mobileStore.setPageTranslation).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'completed',
    }));
  });

  it('marks zero-result completion as terminal failure', async () => {
    await listeners.get(MessageActions.PAGE_TRANSLATE_ERROR)({
      errorDetails: { type: 'HTTP_ERROR', statusCode: 409, message: 'retryable' },
      isFatal: false,
    });
    await listeners.get(MessageActions.PAGE_TRANSLATE_COMPLETE)({
      translatedCount: 0,
      failedCount: 3,
      totalCount: 3,
    });

    expect(mobileStore.setPageTranslation).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      isTranslated: false,
      translatedCount: 0,
      failedCount: 3,
      totalCount: 3,
    }));
    expect(mobileStore.setPageTranslation).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'error',
      errorMessage: null,
    }));
  });

  it('stores localized structured cause for zero-result completion', async () => {
    const errorDetails = {
      message: 'Too Many Requests',
      type: ErrorTypes.RATE_LIMIT_REACHED,
      statusCode: 429,
    };
    getPageTranslationErrorPresentationMock.mockResolvedValueOnce(
      Object.assign(new Error('Localized rate limit'), { type: ErrorTypes.RATE_LIMIT_REACHED })
    );

    await listeners.get(MessageActions.PAGE_TRANSLATE_COMPLETE)({
      isAggregated: true,
      translatedCount: 0,
      failedCount: 3,
      totalCount: 3,
      errorDetails,
    });

    expect(getPageTranslationErrorPresentationMock).toHaveBeenCalledWith(expect.objectContaining({ errorDetails }));
    expect(mobileStore.setPageTranslation).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'error',
      errorMessage: 'Localized rate limit',
      translatedCount: 0,
      failedCount: 3,
      totalCount: 3,
    }));
  });

  it('discards pending zero-result cause after reset', async () => {
    const decision = createDeferred();
    getPageTranslationErrorPresentationMock.mockReturnValueOnce(decision.promise);

    const completion = listeners.get(MessageActions.PAGE_TRANSLATE_COMPLETE)({
      isAggregated: true,
      translatedCount: 0,
      failedCount: 3,
      totalCount: 3,
      errorDetails: { type: ErrorTypes.MODEL_OVERLOADED, message: 'overloaded' },
    });
    listeners.get(MessageActions.PAGE_TRANSLATE_RESET_ERROR)();

    decision.resolve(new Error('stale presentation'));
    await completion;

    expect(mobileStore.setPageTranslation).not.toHaveBeenCalled();
  });

  it('keeps newer partial completion when an older zero-result presentation resolves', async () => {
    const decision = createDeferred();
    getPageTranslationErrorPresentationMock.mockReturnValueOnce(decision.promise);

    const staleCompletion = listeners.get(MessageActions.PAGE_TRANSLATE_COMPLETE)({
      isAggregated: true,
      translatedCount: 0,
      failedCount: 3,
      totalCount: 3,
      errorDetails: { type: ErrorTypes.MODEL_OVERLOADED, message: 'overloaded' },
    });
    await listeners.get(MessageActions.PAGE_TRANSLATE_COMPLETE)({
      isAggregated: true,
      translatedCount: 2,
      failedCount: 1,
      totalCount: 3,
    });

    decision.resolve(new Error('stale presentation'));
    await staleCompletion;

    expect(mobileStore.pageTranslationData).toMatchObject({
      status: 'completed',
      isTranslated: true,
      translatedCount: 2,
      failedCount: 1,
      errorMessage: null,
    });
  });

  it.each([
    [MessageActions.PAGE_TRANSLATE_START, {}, {
      status: 'translating',
      isTranslating: true,
      translatedCount: 0,
    }],
    [MessageActions.PAGE_TRANSLATE_PROGRESS, {
      isAggregated: true,
      translatedCount: 1,
      failedCount: 0,
      totalCount: 2,
      isTranslating: true,
    }, {
      status: 'translating',
      isTranslating: true,
      translatedCount: 1,
    }],
  ])('discards pending zero-result presentation after newer %s', async (action, data, expectedState) => {
    const decision = createDeferred();
    getPageTranslationErrorPresentationMock.mockReturnValueOnce(decision.promise);
    mobileStore.pageTranslationData.errorMessage = null;

    const staleCompletion = listeners.get(MessageActions.PAGE_TRANSLATE_COMPLETE)({
      isAggregated: true,
      translatedCount: 0,
      failedCount: 3,
      totalCount: 3,
      errorDetails: { type: ErrorTypes.MODEL_OVERLOADED, message: 'overloaded' },
    });
    listeners.get(action)(data);

    decision.resolve(new Error('stale presentation'));
    await staleCompletion;

    expect(mobileStore.pageTranslationData).toMatchObject({
      ...expectedState,
      errorMessage: null,
    });
  });

  it('does not surface structured cancellation/context errors', async () => {
    await listeners.get(MessageActions.PAGE_TRANSLATE_ERROR)({
      error: 'cancelled',
      errorDetails: { type: 'TRANSLATION_CANCELLED', message: 'cancelled' },
      isFatal: true,
    });

    expect(mobileStore.setPageTranslation).not.toHaveBeenCalled();
  });

  it('does not mutate visible state for structured context errors', async () => {
    await listeners.get(MessageActions.PAGE_TRANSLATE_ERROR)({
      error: 'context invalidated',
      errorDetails: { type: 'EXTENSION_CONTEXT_INVALIDATED', message: 'context invalidated' },
      isFatal: true,
    });

    expect(mobileStore.setPageTranslation).not.toHaveBeenCalled();
  });

  it.each([
    { type: ErrorTypes.NETWORK_ERROR, message: 'network failure' },
    { type: ErrorTypes.RATE_LIMIT_REACHED, message: 'rate limited' },
    { type: ErrorTypes.API_KEY_INVALID, message: 'invalid key' },
    { type: ErrorTypes.FORBIDDEN_ERROR, message: 'forbidden' },
  ])('does not store Mobile retry state for %s', async (errorDetails) => {
    await listeners.get(MessageActions.PAGE_TRANSLATE_ERROR)({
      errorDetails,
      isFatal: true,
      isAggregated: true,
    });

    const state = mobileStore.setPageTranslation.mock.lastCall[0];
    expect(state).not.toHaveProperty('canRetry');
    expect(mobileStore.pageTranslationData).not.toHaveProperty('canRetry');
  });
});
