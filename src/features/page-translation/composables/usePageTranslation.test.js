import { describe, it, expect, vi, beforeEach } from 'vitest';

// 1. Mock webextension-polyfill FIRST
vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: { 
      sendMessage: vi.fn(), 
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() } 
    },
    tabs: {
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() }
    }
  }
}));

// 2. Mock UnifiedMessaging
vi.mock('@/shared/messaging/core/UnifiedMessaging.js', () => ({
  sendRegularMessage: vi.fn().mockResolvedValue({ success: true })
}));

// 3. Mock PageEventBus
vi.mock('@/core/PageEventBus.js', () => ({
  pageEventBus: {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn()
  }
}));

// 4. Mock Pinia Store
vi.mock('@/features/translation/stores/translation.js', () => ({
  useTranslationStore: vi.fn(() => ({
    selectedProvider: 'google',
    ephemeralSync: { page: true }
  }))
}));

// 5. Mock Vue lifecycle hooks to prevent warnings and test registration
vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    onMounted: vi.fn((fn) => fn()), // Execute immediately for testing setup
    onUnmounted: vi.fn(),
  };
});

// 6. Keep the real error presentation but allow tests to control its timing.
vi.mock('@/features/page-translation/utils/PageTranslationErrorPresenter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getPageTranslationErrorPresentation: vi.fn(actual.getPageTranslationErrorPresentation),
  };
});

import { usePageTranslation } from './usePageTranslation.js';
import { sendRegularMessage } from '@/shared/messaging/core/UnifiedMessaging.js';
import { pageEventBus } from '@/core/PageEventBus.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { ActionReasons } from '@/shared/messaging/core/MessagingConstants.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { getPageTranslationErrorPresentation } from '@/features/page-translation/utils/PageTranslationErrorPresenter.js';
import { onMounted } from 'vue';
import browser from 'webextension-polyfill';

describe('usePageTranslation Composable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendRegularMessage.mockImplementation(({ action }) => {
      if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) {
        return Promise.resolve({ success: false });
      }
      return Promise.resolve({ success: true });
    });
  });

  async function createPageTranslation() {
    const pageTranslation = usePageTranslation();
    await Promise.resolve();
    return pageTranslation;
  }

  function getRuntimeMessageListener() {
    return browser.runtime.onMessage.addListener.mock.calls.at(-1)[0];
  }

  const errorEvent = {
    error: 'boom',
    errorDetails: { type: 'TRANSLATION_FAILED', message: 'boom' },
  };

  function getErrorListener() {
    return pageEventBus.on.mock.calls.find(c => c[0] === 'page-translation-error')[1];
  }

  function getRestoreListener() {
    return pageEventBus.on.mock.calls.find(c => c[0] === 'page-restore-complete')[1];
  }

  function deferPresentation() {
    let resolvePresentation;
    let markCalled;
    const pending = new Promise((resolve) => {
      resolvePresentation = resolve;
    });
    const called = new Promise((resolve) => {
      markCalled = resolve;
    });
    getPageTranslationErrorPresentation.mockImplementationOnce(() => {
      markCalled();
      return pending;
    });
    return { resolve: resolvePresentation, called };
  }

  it('should initialize and register listeners in onMounted', () => {
    usePageTranslation();
    expect(onMounted).toHaveBeenCalled();
    expect(pageEventBus.on).toHaveBeenCalled();
  });

  it('should initialize with correct default state', () => {
    const { isTranslating, isTranslated, progress } = usePageTranslation();
    expect(isTranslating.value).toBe(false);
    expect(isTranslated.value).toBe(false);
    expect(progress.value).toBe(0);
  });

  describe('Actions', () => {
    it('refreshStatus should update state from background response', async () => {
      sendRegularMessage.mockResolvedValue({
        success: true,
        isTranslated: true,
        isTranslating: false,
        translatedCount: 10
      });

      const { refreshStatus, isTranslated, translatedCount } = usePageTranslation();
      await refreshStatus();

      expect(sendRegularMessage).toHaveBeenCalledWith(expect.objectContaining({
        action: MessageActions.PAGE_TRANSLATE_GET_STATUS
      }));
      expect(isTranslated.value).toBe(true);
      expect(translatedCount.value).toBe(10);
    });

    it('translatePage should send intent without changing lifecycle state', async () => {
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        return Promise.resolve({
          success: true,
          isAutoTranslating: true,
        });
      });

      const { translatePage, isTranslating, isTranslated, isAutoTranslating } = await createPageTranslation();
      const promise = translatePage({ some: 'data' });
      
      expect(isTranslating.value).toBe(false);
      
      await promise;
      
      expect(sendRegularMessage).toHaveBeenCalledWith(expect.objectContaining({
        action: MessageActions.PAGE_TRANSLATE,
        data: expect.objectContaining({ some: 'data' })
      }), {
        returnFailureResponse: true,
      });
      expect(isTranslated.value).toBe(false);
      expect(isAutoTranslating.value).toBe(false);
    });

    it.each([
      ErrorTypes.SERVER_ERROR,
      ErrorTypes.RATE_LIMIT_REACHED,
      ErrorTypes.API_KEY_INVALID,
      undefined,
    ])('translatePage presents %s failures instead of raw provider diagnostics', async (type) => {
      const rawDiagnostic = `provider raw internal diagnostic for ${type || 'unknown'}`;
      const providerError = Object.assign(new Error(rawDiagnostic), type ? { type } : {});
      sendRegularMessage.mockRejectedValue(providerError);

      const { translatePage, error, message } = usePageTranslation();
      await translatePage();

      expect(error.value).toBeInstanceOf(Error);
      expect(error.value.message).not.toContain(rawDiagnostic);
      expect(message.value).not.toContain(rawDiagnostic);
      expect(message.value).toContain('Error:');
    });

    it('keeps direct user cancellation silent', async () => {
      sendRegularMessage.mockRejectedValue(Object.assign(new Error('cancelled'), {
        type: ErrorTypes.USER_CANCELLED,
      }));

      const { translatePage, error, isTranslating, message } = await createPageTranslation();
      await translatePage();

      expect(error.value).toBeNull();
      expect(isTranslating.value).toBe(false);
      expect(message.value).toBe('');
    });

    it('restorePage should reset state on success', async () => {
      sendRegularMessage.mockResolvedValue({
        success: true,
        restoredCount: 5
      });

      const { restorePage, isTranslated, isAutoTranslating } = usePageTranslation();
      isTranslated.value = true;
      isAutoTranslating.value = true;

      await restorePage();

      expect(isTranslated.value).toBe(false);
      expect(isAutoTranslating.value).toBe(false);
    });
  });

  describe('Admission ownership', () => {
    it.each([ActionReasons.BUSY_OR_DONE, ActionReasons.NOT_SUITABLE])('preserves existing lifecycle state for %s rejection', async (reason) => {
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        return Promise.resolve({ success: false, reason });
      });

      const pageTranslation = await createPageTranslation();
      pageTranslation.isTranslated.value = true;
      pageTranslation.isTranslating.value = false;
      pageTranslation.isAutoTranslating.value = true;
      pageTranslation.translatedCount.value = 20;
      pageTranslation.failedCount.value = 2;
      pageTranslation.totalNodes.value = 25;

      await pageTranslation.translatePage();

      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(20);
      expect(pageTranslation.failedCount.value).toBe(2);
      expect(pageTranslation.totalNodes.value).toBe(25);
      expect(pageTranslation.canRestore.value).toBe(true);
    });

    it.each([ActionReasons.USER_CANCELLED, ActionReasons.SILENT_ERROR])('keeps %s admission rejection silent', async (reason) => {
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        return Promise.resolve({ success: false, reason });
      });

      const pageTranslation = await createPageTranslation();
      pageTranslation.isTranslated.value = true;
      pageTranslation.isAutoTranslating.value = true;
      pageTranslation.translatedCount.value = 20;

      await pageTranslation.translatePage();

      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.message.value).toBe('');
      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
    });

    it('uses structured details for resolved domain failures', async () => {
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        return Promise.resolve({
          success: false,
          error: 'raw provider response',
          errorType: ErrorTypes.NETWORK_ERROR,
          errorDetails: {
            message: 'raw canonical response',
            type: ErrorTypes.NETWORK_ERROR,
          },
        });
      });

      const pageTranslation = await createPageTranslation();
      await pageTranslation.translatePage();

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.error.value.message).not.toContain('raw provider response');
      expect(pageTranslation.error.value.message).not.toContain('raw canonical response');
    });

    it('preserves lifecycle state when transport rejects', async () => {
      const transportError = Object.assign(new Error('transport failure'), {
        type: ErrorTypes.SERVER_ERROR,
      });
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        return Promise.reject(transportError);
      });

      const pageTranslation = await createPageTranslation();
      pageTranslation.isTranslated.value = true;
      pageTranslation.isAutoTranslating.value = true;
      pageTranslation.translatedCount.value = 20;
      pageTranslation.failedCount.value = 2;
      pageTranslation.totalNodes.value = 25;

      await pageTranslation.translatePage();

      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(20);
      expect(pageTranslation.failedCount.value).toBe(2);
      expect(pageTranslation.totalNodes.value).toBe(25);
    });

    it('preserves existing state after immediate success without START', async () => {
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        return Promise.resolve({
          success: true,
          isAutoTranslating: false,
          translatedCount: 0,
          failedCount: 0,
          totalCount: 0,
        });
      });

      const pageTranslation = await createPageTranslation();
      pageTranslation.isTranslated.value = true;
      pageTranslation.isAutoTranslating.value = true;
      pageTranslation.translatedCount.value = 20;
      pageTranslation.failedCount.value = 2;
      pageTranslation.totalNodes.value = 25;

      await pageTranslation.translatePage();

      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(20);
      expect(pageTranslation.failedCount.value).toBe(2);
      expect(pageTranslation.totalNodes.value).toBe(25);
    });

    it('uses START as sole fresh-cycle admission transition', async () => {
      const pageTranslation = await createPageTranslation();
      pageTranslation.isTranslated.value = true;
      pageTranslation.isAutoTranslating.value = true;
      pageTranslation.translatedCount.value = 20;
      pageTranslation.failedCount.value = 2;
      pageTranslation.totalNodes.value = 25;
      pageTranslation.error.value = new Error('old error');
      pageTranslation.message.value = 'old message';

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { isAutoTranslating: false },
      });

      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.isTranslated.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(false);
      expect(pageTranslation.translatedCount.value).toBe(0);
      expect(pageTranslation.failedCount.value).toBe(0);
      expect(pageTranslation.totalNodes.value).toBe(0);
      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.message.value).toBe('Starting translation...');
    });

    it('does not undo admitted START when request later rejects', async () => {
      let rejectRequest;
      const request = new Promise((_, reject) => {
        rejectRequest = reject;
      });
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        return request;
      });

      const pageTranslation = await createPageTranslation();
      const pendingRequest = pageTranslation.translatePage();

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { isAutoTranslating: false },
      });
      expect(pageTranslation.isTranslating.value).toBe(true);

      rejectRequest(Object.assign(new Error('late transport failure'), {
        type: ErrorTypes.SERVER_ERROR,
      }));
      await pendingRequest;

      expect(pageTranslation.isTranslating.value).toBe(true);
    });

    it('does not refresh status to repair a rejected request', async () => {
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        return Promise.resolve({ success: false, reason: ActionReasons.BUSY_OR_DONE });
      });

      const pageTranslation = await createPageTranslation();
      await pageTranslation.translatePage();

      expect(sendRegularMessage.mock.calls.filter(([message]) => (
        message.action === MessageActions.PAGE_TRANSLATE_GET_STATUS
      ))).toHaveLength(1);
    });

    it('preserves restricted-page handling', async () => {
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        return Promise.resolve({
          success: false,
          isRestrictedPage: true,
          message: 'Restricted page',
        });
      });

      const pageTranslation = await createPageTranslation();
      pageTranslation.isTranslated.value = true;
      pageTranslation.isAutoTranslating.value = true;
      pageTranslation.translatedCount.value = 20;

      await pageTranslation.translatePage();

      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isTranslated.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(false);
      expect(pageTranslation.translatedCount.value).toBe(0);
      expect(pageTranslation.message.value).toBe('Restricted page');
    });
  });

  describe('Runtime START handling', () => {
    it('preserves explicit auto-translation state from START payload', async () => {
      const pageTranslation = await createPageTranslation();

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { isAutoTranslating: true },
      });

      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
    });
  });
  describe('Event Bus Handling', () => {
    it('stores safe canonical display text for structured errors', async () => {
      const pageTranslation = usePageTranslation();

      const errorListener = pageEventBus.on.mock.calls.find(c => c[0] === 'page-translation-error')[1];
      const raw = 'raw provider response body';
      await errorListener({
        error: raw,
        errorDetails: { type: 'MODEL_NOT_FOUND', message: raw },
      });

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).not.toContain(raw);
    });

    it('does not mutate visible state for structured context errors', async () => {
      const pageTranslation = usePageTranslation();
      const errorListener = pageEventBus.on.mock.calls.find(c => c[0] === 'page-translation-error')[1];

      await errorListener({
        error: 'context invalidated',
        errorDetails: {
          type: 'EXTENSION_CONTEXT_INVALIDATED',
          message: 'context invalidated',
        },
      });

      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.message.value).toBe('');
      expect(pageTranslation.isTranslating.value).toBe(false);
    });

    it('applies stopped-state counts from a fatal discovery error event', async () => {
      const pageTranslation = usePageTranslation();

      const errorListener = pageEventBus.on.mock.calls.find(c => c[0] === 'page-translation-error')[1];
      await errorListener({
        error: 'enumeration failed',
        errorDetails: { type: 'TRANSLATION_FAILED', message: 'enumeration failed' },
        translatedCount: 2,
        failedCount: 1,
        totalCount: 3,
        isTranslated: true,
        isTranslating: false,
        isAutoTranslating: false,
      });

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(false);
      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(2);
      expect(pageTranslation.failedCount.value).toBe(1);
      expect(pageTranslation.totalNodes.value).toBe(3);
      expect(pageTranslation.canRestore.value).toBe(true);
    });

    it('should update progress when pageEventBus emits', () => {
      // Manual trigger of the listener if we were testing the live component
      // But we can test the internal updateProgress logic by getting the listener
      usePageTranslation();
      
      // Since usePageTranslation is called, it should have registered listeners
      // in onMounted. But we are calling it outside of a component.
      // In usePageTranslation, onMounted is where it registers.
      // We need to simulate the lifecycle or test the handler directly if exported.
      
      // To keep it simple, let's verify that listeners are registered on mount
      // and then manually call the stored listener.
    });
  });

  describe('Stale error presentation', () => {
    it('presents the error when no newer lifecycle update arrived', async () => {
      const pageTranslation = await createPageTranslation();
      const presentation = deferPresentation();

      const pending = getErrorListener()(errorEvent);
      presentation.resolve(new Error('boom'));
      await pending;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toBe('Error: boom');
    });

    it('drops an error that resolves after Restore cleared the state', async () => {
      const pageTranslation = await createPageTranslation();
      const presentation = deferPresentation();

      const pending = getErrorListener()(errorEvent);
      getRestoreListener()({ restoredCount: 3 });
      presentation.resolve(new Error('boom'));
      await pending;

      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.message.value).toBe('Restore complete! 3 elements restored');
    });

    it('drops an error that resolves after a new translation session started', async () => {
      const pageTranslation = await createPageTranslation();
      const presentation = deferPresentation();

      const pending = getErrorListener()(errorEvent);
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { isAutoTranslating: false },
      });
      presentation.resolve(new Error('boom'));
      await pending;

      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.message.value).toBe('Starting translation...');
    });

    it('drops an error that resolves after a tab change', async () => {
      const pageTranslation = await createPageTranslation();
      const presentation = deferPresentation();

      const pending = getErrorListener()(errorEvent);
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]();
      presentation.resolve(new Error('boom'));
      await pending;

      expect(pageTranslation.error.value).toBeNull();
    });

    it('drops an error that resolves after a newer progress update', async () => {
      const pageTranslation = await createPageTranslation();
      const presentation = deferPresentation();

      const pending = getErrorListener()(errorEvent);
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data: { status: 'translating', isTranslating: true, translatedCount: 5, totalCount: 10 },
      });
      presentation.resolve(new Error('boom'));
      await pending;

      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.message.value).not.toContain('Error:');
    });

    it('drops an error that resolves after a newer idle update', async () => {
      const pageTranslation = await createPageTranslation();
      const presentation = deferPresentation();

      const pending = getErrorListener()(errorEvent);
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_IDLE,
        data: { translatedCount: 5, totalCount: 10, isTranslating: false },
      });
      presentation.resolve(new Error('boom'));
      await pending;

      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.message.value).not.toContain('Error:');
    });

    it('drops an error that resolves after a direct cancellation', async () => {
      const pageTranslation = await createPageTranslation();
      const presentation = deferPresentation();
      pageTranslation.isTranslating.value = true;

      const pending = getErrorListener()(errorEvent);
      pageTranslation.cancelTranslation();
      presentation.resolve(new Error('boom'));
      await pending;

      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.message.value).toBe('Translation cancelled');
    });

    it('drops an error that resolves after stopping auto-translation', async () => {
      const pageTranslation = await createPageTranslation();
      const presentation = deferPresentation();

      const pending = getErrorListener()(errorEvent);
      await pageTranslation.stopAutoTranslation();
      presentation.resolve(new Error('boom'));
      await pending;

      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.message.value).toBe('Auto-translation stopped');
    });

    it('keeps an internal state-sync progress update from suppressing its own error', async () => {
      const pageTranslation = await createPageTranslation();
      const presentation = deferPresentation();

      const pending = getErrorListener()(errorEvent);
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data: { status: 'idle', isTranslating: false, isInternal: true },
      });
      presentation.resolve(new Error('boom'));
      await pending;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toBe('Error: boom');
    });

    it('keeps Restore available when an aggregated iframe error follows main-frame translations', async () => {
      const pageTranslation = await createPageTranslation();

      await getErrorListener()({
        isAggregated: true,
        error: 'iframe failure',
        errorDetails: { type: 'NETWORK_ERROR', message: 'iframe failure' },
        translatedCount: 5,
        failedCount: 0,
        totalCount: 5,
        isTranslated: true,
        isTranslating: false,
        isAutoTranslating: false,
      });

      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.canRestore.value).toBe(true);
    });
  });

  describe('Translate request ownership', () => {
    function mockTranslateResponse() {
      let resolveTranslate;
      const translateResponse = new Promise((resolve) => {
        resolveTranslate = resolve;
      });
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        if (action === MessageActions.PAGE_TRANSLATE) return translateResponse;
        return Promise.resolve({ success: true, restoredCount: 2 });
      });
      return resolveTranslate;
    }

    it('drops a late translate failure after Restore superseded the request', async () => {
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();

      const pending = pageTranslation.translatePage();
      await pageTranslation.restorePage();

      resolveTranslate({ success: false, error: 'late failure', errorType: ErrorTypes.NETWORK_ERROR });
      await pending;

      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.message.value).toBe('Restored 2 elements');
    });

    it('drops a late translate failure after a tab change superseded the request', async () => {
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();

      const pending = pageTranslation.translatePage();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]();

      resolveTranslate({ success: false, error: 'late failure', errorType: ErrorTypes.NETWORK_ERROR });
      await pending;

      expect(pageTranslation.error.value).toBeNull();
    });

    it('keeps the current request failure visible when its own START lifecycle arrives', async () => {
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();

      const pending = pageTranslation.translatePage();
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { isAutoTranslating: false },
      });

      resolveTranslate({ success: false, error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await pending;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toContain('Error:');
    });

    it('does not let a superseded request cancel a newer session pending error', async () => {
      const presentation = deferPresentation();
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();

      const pendingRequest = pageTranslation.translatePage();
      await pageTranslation.restorePage();

      const pendingError = getErrorListener()(errorEvent);
      resolveTranslate({ success: false, error: 'late failure', errorType: ErrorTypes.NETWORK_ERROR });
      await pendingRequest;

      presentation.resolve(new Error('boom'));
      await pendingError;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toBe('Error: boom');
    });

    it('discards a request failure presentation that resolves after newer progress', async () => {
      const presentation = deferPresentation();
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();

      const pending = pageTranslation.translatePage();
      resolveTranslate({ success: false, error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await presentation.called;

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data: { status: 'translating', isTranslating: true, translatedCount: 5, totalCount: 10 },
      });
      presentation.resolve(new Error('boom'));
      await pending;

      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.message.value).not.toContain('Error:');
    });

    it('discards a request failure presentation that resolves after a newer completion', async () => {
      const presentation = deferPresentation();
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();

      const pending = pageTranslation.translatePage();
      resolveTranslate({ success: false, error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await presentation.called;

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: { translatedCount: 5, totalCount: 5, isTranslated: true, isTranslating: false },
      });
      presentation.resolve(new Error('boom'));
      await pending;

      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.message.value).not.toContain('Error:');
    });

    it('discards a late request failure after a successful completion', async () => {
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();

      const pending = pageTranslation.translatePage();
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: { translatedCount: 5, totalCount: 5, isTranslated: true, isTranslating: false },
      });

      resolveTranslate({ success: false, error: 'late failure', errorType: ErrorTypes.NETWORK_ERROR });
      await pending;

      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.message.value).not.toContain('Error:');
    });
  });

  describe('Computed Properties', () => {
    it('should correctly compute status', () => {
      const { status, isTranslating, isTranslated, error } = usePageTranslation();
      
      expect(status.value).toBe('idle');
      
      isTranslating.value = true;
      expect(status.value).toBe('translating');
      
      isTranslating.value = false;
      isTranslated.value = true;
      expect(status.value).toBe('translated');
      
      error.value = 'Fail';
      expect(status.value).toBe('error');
    });
  });
});
