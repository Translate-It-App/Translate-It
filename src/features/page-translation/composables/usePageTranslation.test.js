import { describe, it, expect, vi, beforeEach } from 'vitest';

// 1. Mock webextension-polyfill FIRST
vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: { 
      sendMessage: vi.fn(), 
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() } 
    },
    tabs: {
      query: vi.fn(),
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
    browser.tabs.query.mockResolvedValue([{ id: 1 }]);
    sendRegularMessage.mockImplementation(({ action }) => {
      if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) {
        return Promise.resolve({ success: false });
      }
      return Promise.resolve({ success: true, targetTabId: 1, messageId: 'session-new' });
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
      expect(pageTranslation.isTranslating.value).toBe(false);

      rejectRequest(Object.assign(new Error('late transport failure'), {
        type: ErrorTypes.SERVER_ERROR,
      }));
      await pendingRequest;

      expect(pageTranslation.isTranslating.value).toBe(false);
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
    it('drops a late translate failure after Restore superseded the request', async () => {
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      await pageTranslation.restorePage();

      resolveTranslate({ success: false, error: 'late failure', errorType: ErrorTypes.NETWORK_ERROR, targetTabId: 1, messageId: 'session-new' });
      await pending;

      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.message.value).toBe('Restored 2 elements');
    });

    it('drops a late translate failure after a tab change superseded the request', async () => {
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]();

      resolveTranslate({ success: false, error: 'late failure', errorType: ErrorTypes.NETWORK_ERROR, targetTabId: 1, messageId: 'session-new' });
      await pending;

      expect(pageTranslation.error.value).toBeNull();
    });

    it('keeps the current request failure visible when its own START lifecycle arrives', async () => {
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

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
      resolveTranslate({ success: false, error: 'late failure', errorType: ErrorTypes.NETWORK_ERROR, targetTabId: 1, messageId: 'session-new' });
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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      resolveTranslate({ success: false, targetTabId: 1, messageId: 'session-new', error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await presentation.called;

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data: { tabId: 1, sessionId: 'session-new', status: 'translating', isTranslating: true, translatedCount: 5, totalCount: 10 },
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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      resolveTranslate({ success: false, targetTabId: 1, messageId: 'session-new', error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await presentation.called;

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: { tabId: 1, sessionId: 'session-new', translatedCount: 5, totalCount: 5, isTranslated: true, isTranslating: false },
      });
      presentation.resolve(new Error('boom'));
      await pending;

      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.message.value).not.toContain('Error:');
    });

    it('discards a late request failure after a successful completion', async () => {
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: { tabId: 1, sessionId: 'session-new', translatedCount: 5, totalCount: 5, isTranslated: true, isTranslating: false },
      });

      resolveTranslate({ success: false, error: 'late failure', errorType: ErrorTypes.NETWORK_ERROR, targetTabId: 1, messageId: 'session-new' });
      await pending;

      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.message.value).not.toContain('Error:');
    });
  });

  describe('Tab update ownership', () => {
    function getTabUpdateListener() {
      return browser.tabs.onUpdated.addListener.mock.calls.at(-1)[0];
    }

    it('keeps the active request valid when a background tab completes', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      await getTabUpdateListener()(2, { status: 'complete' });
      resolveTranslate({ success: false, error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await pending;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toContain('Error:');
    });

    it('keeps a pending error presentation after a background tab completes', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const pageTranslation = await createPageTranslation();
      const presentation = deferPresentation();

      const pending = getErrorListener()(errorEvent);
      await getTabUpdateListener()(2, { status: 'complete' });
      presentation.resolve(new Error('boom'));
      await pending;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toBe('Error: boom');
    });

    it('refreshes the state and invalidates the request when the active tab completes', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      await getTabUpdateListener()(1, { status: 'complete' });
      resolveTranslate({ success: false, error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await pending;

      expect(pageTranslation.error.value).toBeNull();
      expect(sendRegularMessage).toHaveBeenCalledWith(expect.objectContaining({
        action: MessageActions.PAGE_TRANSLATE_GET_STATUS,
      }));
    });

    it('does not invalidate a newer request when the active-tab lookup resolves late', async () => {
      const pendingQueries = [];
      browser.tabs.query.mockImplementation(() => new Promise((resolve) => {
        pendingQueries.push(resolve);
      }));
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();

      const pendingOldRequest = pageTranslation.translatePage();
      const pendingTabUpdate = getTabUpdateListener()(1, { status: 'complete' });

      const pendingNewRequest = pageTranslation.translatePage();

      pendingQueries.forEach((resolve) => resolve([{ id: 1 }]));
      await pendingTabUpdate;

      resolveTranslate({ success: false, error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await pendingOldRequest;
      await pendingNewRequest;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toContain('Error:');
    });

    it('keeps an active translation failure visible after unrelated background-tab updates', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      await getTabUpdateListener()(7, { status: 'complete' });
      await getTabUpdateListener()(9, { status: 'complete' });
      resolveTranslate({ success: false, error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await pending;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toContain('Error:');
    });
  });

  describe('Tab identity ownership', () => {
    function getTabUpdateListener() {
      return browser.tabs.onUpdated.addListener.mock.calls.at(-1)[0];
    }

    it('keeps the active request failure visible when a completion arrives from another tab', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      let resolveTranslate;
      const translateResponse = new Promise((resolve) => { resolveTranslate = resolve; });
      let resolveSent;
      const sentGate = new Promise((resolve) => { resolveSent = resolve; });
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        if (action === MessageActions.PAGE_TRANSLATE) { resolveSent(); return translateResponse; }
        return Promise.resolve({ success: true, restoredCount: 2 });
      });
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      await sentGate;
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: { tabId: 2, translatedCount: 5, totalCount: 5, isTranslated: true, isTranslating: false },
      });
      resolveTranslate({ success: false, error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await pending;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toContain('Error:');
    });

    it('rejects a foreign-tab start without mutating the pending request state', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      let resolveTranslate;
      const translateResponse = new Promise((resolve) => { resolveTranslate = resolve; });
      let resolveSent;
      const sentGate = new Promise((resolve) => { resolveSent = resolve; });
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        if (action === MessageActions.PAGE_TRANSLATE) { resolveSent(); return translateResponse; }
        return Promise.resolve({ success: true, restoredCount: 2 });
      });
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      await sentGate;
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { sessionId: 'session-new', isAutoTranslating: false },
      });
      expect(pageTranslation.isTranslating.value).toBe(false);

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { tabId: 2, sessionId: 'session-new', isAutoTranslating: false },
      });
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.error.value).toBeNull();

      resolveTranslate({ success: false, error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await pending;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
    });

    it('rejects a stale-session start from the same tab', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { sessionId: 'session-new', isAutoTranslating: false },
      });
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { tabId: 1, sessionId: 'session-old', isAutoTranslating: false },
      });
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.error.value).toBeNull();

      resolveTranslate({ success: false, error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await pending;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
    });

    it('does not accept a completion with missing identity during a pending request', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      let resolveTranslate;
      const translateResponse = new Promise((resolve) => { resolveTranslate = resolve; });
      let resolveSent;
      const sentGate = new Promise((resolve) => { resolveSent = resolve; });
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        if (action === MessageActions.PAGE_TRANSLATE) { resolveSent(); return translateResponse; }
        return Promise.resolve({ success: true, restoredCount: 2 });
      });
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      await sentGate;
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: { translatedCount: 5, totalCount: 5, isTranslated: true, isTranslating: false },
      });
      resolveTranslate({ success: false, error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await pending;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
    });

    it('drops a pending failure after cancellation following a delayed tab lookup', async () => {
      let resolveActiveTab;
      const activeTabDeferred = new Promise((resolve) => { resolveActiveTab = resolve; });
      browser.tabs.query.mockImplementation(() => activeTabDeferred);
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { sessionId: 'session-new', isAutoTranslating: false },
      });
      resolveActiveTab([{ id: 1 }]);
      await activeTabDeferred;

      pageTranslation.cancelTranslation();
      resolveTranslate({ success: false, error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await pending;

      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.message.value).toBe('Translation cancelled');
    });

    it('does not let an older session completion invalidate a newer pending request', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();

      const pendingNewRequest = pageTranslation.translatePage();
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { sessionId: 'session-new', isAutoTranslating: false },
      });
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: { sessionId: 'session-old', tabId: 1, translatedCount: 5, totalCount: 5, isTranslated: true, isTranslating: false },
      });

      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.error.value).toBeNull();

      resolveTranslate({ success: false, error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await pendingNewRequest;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
    });

    it('invalidates the pending request on a completion that matches tab and session', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { sessionId: 'session-new', isAutoTranslating: false },
      });
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: { sessionId: 'session-new', tabId: 1, translatedCount: 5, totalCount: 5, isTranslated: true, isTranslating: false },
      });

      resolveTranslate({ success: false, error: 'late failure', errorType: ErrorTypes.NETWORK_ERROR, targetTabId: 1, messageId: 'session-new' });
      await pending;

      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.isTranslating.value).toBe(false);
    });

    it('attributes a delayed tab update to the tab that was active when its lookup resolves', async () => {
      const pendingQueries = [];
      browser.tabs.query.mockImplementation(() => new Promise((resolve) => {
        pendingQueries.push(resolve);
      }));
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();

      // Mount resolves displayed-tab identity from authoritative browser context.
      pendingQueries[0]([{ id: 1 }]);
      await Promise.resolve();
      await Promise.resolve();

      const pending = pageTranslation.translatePage();
      const pendingTabUpdate = getTabUpdateListener()(2, { status: 'complete' });

      // Delayed tab-update lookup: active tab is 1, so update for tab 2 must not invalidate.
      pendingQueries[1]([{ id: 1 }]);
      await pendingTabUpdate;

      resolveTranslate({ success: false, error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await pending;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
    });

    it('keeps a pending error presentation when an error arrives from another tab', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_ERROR,
        data: { tabId: 2, error: 'other tab failure', errorDetails: { type: 'TRANSLATION_FAILED', message: 'other tab failure' } },
      });
      expect(pageTranslation.error.value).toBeNull();

      resolveTranslate({ success: false, error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await pending;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
    });
  });

  describe('Regression: remaining lifecycle blockers', () => {
    function getTabUpdateListener() {
      return browser.tabs.onUpdated.addListener.mock.calls.at(-1)[0];
    }

    it('foreign broadcast before initial displayed-tab identity resolution is ignored', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) {
          return Promise.resolve({ success: true, isTranslated: true, translatedCount: 3, failedCount: 0, totalCount: 3, isTranslating: false });
        }
        return Promise.resolve({ success: true });
      });
      const pageTranslation = await createPageTranslation();
      await pageTranslation.refreshStatus();

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { tabId: 2, sessionId: 'session-foreign', isAutoTranslating: false },
      });

      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(3);
      expect(pageTranslation.error.value).toBeNull();
    });

    it('foreign-tab COMPLETE during deferred error presentation cannot suppress error', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const presentation = deferPresentation();
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      resolveTranslate({ success: false, targetTabId: 1, messageId: 'session-new', error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await presentation.called;

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: { tabId: 2, sessionId: 'session-foreign', translatedCount: 9, totalCount: 9, isTranslated: true, isTranslating: false },
      });

      presentation.resolve(new Error('boom'));
      await pending;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toBe('Error: boom');
      expect(pageTranslation.isTranslated.value).toBe(false);
      expect(pageTranslation.translatedCount.value).toBe(0);
    });

    it('deferred active-tab query does not overwrite newer tab activation', async () => {
      let resolveMountQuery;
      browser.tabs.query.mockImplementation(() => new Promise((resolve) => {
        resolveMountQuery = resolve;
      }));
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();

      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 2 });
      resolveMountQuery([{ id: 1 }]);
      await Promise.resolve();
      await Promise.resolve();

      const pending = pageTranslation.translatePage();
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: { tabId: 2, sessionId: 'session-new', translatedCount: 4, totalCount: 4, isTranslated: true, isTranslating: false },
      });
      resolveTranslate({ success: false, targetTabId: 2, messageId: 'session-new', error: 'late failure', errorType: ErrorTypes.NETWORK_ERROR });
      await pending;

      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isTranslated.value).toBe(true);
    });

    it('clears pending state when response-failure error presentation is null', async () => {
      const presentation = deferPresentation();
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        if (action === MessageActions.PAGE_TRANSLATE) {
          return Promise.resolve({ success: false, targetTabId: 1, messageId: 'session-new', error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
        }
        return Promise.resolve({ success: true });
      });
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      await presentation.called;
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: { tabId: 2, sessionId: 'session-foreign', translatedCount: 9, totalCount: 9, isTranslated: true, isTranslating: false },
      });
      presentation.resolve(null);
      await pending;

      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.isTranslated.value).toBe(false);

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: { tabId: 1, sessionId: 'session-new', translatedCount: 7, totalCount: 7, isTranslated: true, isTranslating: false },
      });
      expect(pageTranslation.isTranslated.value).toBe(false);
      expect(pageTranslation.translatedCount.value).toBe(0);
    });

    it('clears pending state when thrown-error presentation is null', async () => {
      const presentation = deferPresentation();
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const transportError = Object.assign(new Error('transport failure'), {
        type: ErrorTypes.SERVER_ERROR,
        targetTabId: 1,
      });
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        if (action === MessageActions.PAGE_TRANSLATE) return Promise.reject(transportError);
        return Promise.resolve({ success: true });
      });
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      await presentation.called;
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: { tabId: 2, sessionId: 'session-foreign', translatedCount: 9, totalCount: 9, isTranslated: true, isTranslating: false },
      });
      presentation.resolve(null);
      await pending;

      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.isTranslated.value).toBe(false);

      // Pending identity/buffers cleared: subsequent passive event for displayed tab is handled normally.
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { tabId: 1, sessionId: 'session-next', isAutoTranslating: true },
      });
      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
    });

    it('ignores late same-tab START and COMPLETE after cancel before command response', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      let resolveTranslate;
      const translateResponse = new Promise((resolve) => { resolveTranslate = resolve; });
      let resolveSent;
      const sentGate = new Promise((resolve) => { resolveSent = resolve; });
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        if (action === MessageActions.PAGE_TRANSLATE) { resolveSent(); return translateResponse; }
        return Promise.resolve({ success: true });
      });
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      await sentGate;
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { tabId: 1, sessionId: 'session-new', isAutoTranslating: false },
      });
      pageTranslation.cancelTranslation();

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { tabId: 1, sessionId: 'session-new', isAutoTranslating: false },
      });
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: { tabId: 1, sessionId: 'session-new', translatedCount: 5, totalCount: 5, isTranslated: true, isTranslating: false },
      });
      expect(pageTranslation.isTranslated.value).toBe(false);
      expect(pageTranslation.message.value).toBe('Translation cancelled');

      resolveTranslate({ success: true, targetTabId: 1, messageId: 'session-new' });
      await pending;

      expect(pageTranslation.isTranslated.value).toBe(false);
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.message.value).toBe('Translation cancelled');
    });

    it('ignores foreign-tab START and ERROR while no UI request is pending', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) {
          return Promise.resolve({ success: true, isTranslated: true, translatedCount: 3, failedCount: 0, totalCount: 3, isTranslating: false });
        }
        return Promise.resolve({ success: true });
      });
      const pageTranslation = await createPageTranslation();
      await pageTranslation.refreshStatus();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { tabId: 2, sessionId: 'session-foreign', isAutoTranslating: false },
      });
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(3);

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_ERROR,
        data: { tabId: 2, sessionId: 'session-foreign', error: 'foreign failure', errorDetails: { type: 'TRANSLATION_FAILED', message: 'foreign failure' } },
      });
      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(3);
    });

    it('foreign-tab PROGRESS during deferred error presentation must not suppress active failure', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const presentation = deferPresentation();
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      resolveTranslate({ success: false, targetTabId: 1, messageId: 'session-new', error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await presentation.called;

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data: { tabId: 2, sessionId: 'session-foreign', translatedCount: 5, totalCount: 10, isTranslating: true },
      });

      presentation.resolve(new Error('boom'));
      await pending;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toBe('Error: boom');
      expect(pageTranslation.translatedCount.value).toBe(0);
    });

    it('foreign-tab IDLE must not clear active request state or session identity', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      resolveTranslate({ success: true, targetTabId: 1, messageId: 'session-new' });
      await pending;
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { tabId: 1, sessionId: 'session-new', isAutoTranslating: false },
      });
      expect(pageTranslation.isTranslating.value).toBe(true);

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_IDLE,
        data: { tabId: 2, sessionId: 'session-foreign', status: 'idle', translatedCount: 0, totalCount: 0 },
      });

      expect(pageTranslation.isTranslating.value).toBe(true);
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: { tabId: 1, sessionId: 'session-new', translatedCount: 3, totalCount: 3, isTranslated: true, isTranslating: false },
      });
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(3);
    });

    it('valid same-tab progress and passive automatic translation continue working', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      resolveTranslate({ success: true, targetTabId: 1, messageId: 'session-new' });
      await pending;
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { tabId: 1, sessionId: 'session-new', isAutoTranslating: false },
      });
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data: { tabId: 1, sessionId: 'session-new', translatedCount: 2, totalCount: 5, isTranslating: true },
      });
      expect(pageTranslation.translatedCount.value).toBe(2);
      expect(pageTranslation.totalNodes.value).toBe(5);
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: { tabId: 1, sessionId: 'session-new', translatedCount: 5, totalCount: 5, isTranslated: true, isTranslating: false },
      });

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { tabId: 1, sessionId: 'session-auto', isAutoTranslating: true },
      });
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data: { tabId: 1, sessionId: 'session-auto', translatedCount: 1, totalCount: 4, isTranslating: true },
      });
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(1);
    });

    it('preserves legitimate passive auto-translation after cancellation/navigation for displayed tab', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      pageTranslation.cancelTranslation();
      resolveTranslate({ success: false, targetTabId: 1, messageId: 'session-cancelled', reason: ActionReasons.USER_CANCELLED });
      await pending;

      await getTabUpdateListener()(1, { status: 'complete' });
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { tabId: 1, sessionId: 'session-auto', isAutoTranslating: true },
      });

      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
      expect(pageTranslation.isTranslated.value).toBe(false);
      expect(pageTranslation.error.value).toBeNull();
    });

    it('applies a passive automatic START after a successful completion', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: { tabId: 1, sessionId: 'session-new', translatedCount: 5, totalCount: 5, isTranslated: true, isTranslating: false },
      });
      resolveTranslate({ success: true, targetTabId: 1, messageId: 'session-new' });
      await pending;

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { tabId: 1, sessionId: 'session-auto', isAutoTranslating: true },
      });

      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(0);
    });

    it('ignores delayed events after cancellation and preserves passive auto START across navigation', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      let resolveTranslate;
      const translateResponse = new Promise((resolve) => { resolveTranslate = resolve; });
      let resolveSent;
      const sentGate = new Promise((resolve) => { resolveSent = resolve; });
      let translateCalls = 0;
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        if (action === MessageActions.PAGE_TRANSLATE) {
          translateCalls += 1;
          if (translateCalls === 1) { resolveSent(); return translateResponse; }
          return Promise.resolve({ success: true, targetTabId: 1, messageId: 'session-next' });
        }
        return Promise.resolve({ success: true });
      });
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      await sentGate;
      pageTranslation.cancelTranslation();
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: { tabId: 1, sessionId: 'session-new', translatedCount: 5, totalCount: 5, isTranslated: true, isTranslating: false },
      });
      resolveTranslate({ success: false, targetTabId: 1, messageId: 'session-new', error: 'late failure', errorType: ErrorTypes.NETWORK_ERROR });
      await pending;

      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.message.value).toBe('Translation cancelled');
      expect(pageTranslation.error.value).toBeNull();

      const next = pageTranslation.translatePage();
      await next;
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: { tabId: 1, sessionId: 'session-next', translatedCount: 3, totalCount: 3, isTranslated: true, isTranslating: false },
      });

      await getTabUpdateListener()(1, { status: 'complete' });
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { tabId: 1, sessionId: 'session-auto', isAutoTranslating: true },
      });

      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
      expect(pageTranslation.error.value).toBeNull();
    });

    it('drops an old request rejection after a newer request begins', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      let resolveFirst;
      const firstResponse = new Promise((resolve) => { resolveFirst = resolve; });
      let firstSent;
      const firstGate = new Promise((resolve) => { firstSent = resolve; });
      let call = 0;
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        if (action === MessageActions.PAGE_TRANSLATE) {
          call += 1;
          if (call === 1) { firstSent(); return firstResponse; }
          return Promise.resolve({ success: true, targetTabId: 1, messageId: 'session-next' });
        }
        return Promise.resolve({ success: true, restoredCount: 2 });
      });
      const pageTranslation = await createPageTranslation();

      const first = pageTranslation.translatePage();
      await firstGate;
      const second = pageTranslation.translatePage();
      await second;

      resolveFirst({ success: false, targetTabId: 1, messageId: 'session-old', error: 'old failure', errorType: ErrorTypes.NETWORK_ERROR });
      await first;

      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.message.value).not.toContain('Error:');
    });

    it('uses authoritative target identity on transport failure for buffered START replay', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const transportError = Object.assign(new Error('transport failure'), {
        type: ErrorTypes.SERVER_ERROR,
        targetTabId: 2,
      });
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        return Promise.reject(transportError);
      });
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { tabId: 2, sessionId: 'session-actual', isAutoTranslating: false },
      });
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { tabId: 3, sessionId: 'session-foreign', isAutoTranslating: false },
      });
      await pending;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.isTranslated.value).toBe(false);
    });
  });

  describe('Regression: cross-tab lifecycle isolation', () => {
    function createDeferredTranslate() {
      let resolveTranslate;
      const translateResponse = new Promise((resolve) => { resolveTranslate = resolve; });
      let resolveSent;
      const sentGate = new Promise((resolve) => { resolveSent = resolve; });
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        if (action === MessageActions.PAGE_TRANSLATE) { resolveSent(); return translateResponse; }
        return Promise.resolve({ success: true, restoredCount: 2 });
      });
      return { resolveTranslate, sentGate };
    }

    it('ignores foreign progress before the command response resolves the request identity', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const { resolveTranslate, sentGate } = createDeferredTranslate();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      await sentGate;
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data: { tabId: 2, sessionId: 'session-foreign', translatedCount: 5, totalCount: 10, isTranslating: true },
      });

      expect(pageTranslation.translatedCount.value).toBe(0);
      expect(pageTranslation.totalNodes.value).toBe(0);
      expect(pageTranslation.isTranslating.value).toBe(false);

      resolveTranslate({ success: true, targetTabId: 1, messageId: 'session-new' });
      await pending;

      expect(pageTranslation.translatedCount.value).toBe(0);
      expect(pageTranslation.totalNodes.value).toBe(0);
      expect(pageTranslation.isTranslating.value).toBe(false);
    });

    it('ignores foreign idle events before the command response resolves the request identity', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const { resolveTranslate, sentGate } = createDeferredTranslate();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      await sentGate;
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { tabId: 1, sessionId: 'session-new', isAutoTranslating: false },
      });
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_IDLE,
        data: { tabId: 2, sessionId: 'session-foreign', status: 'idle', translatedCount: 7, totalCount: 10 },
      });

      expect(pageTranslation.translatedCount.value).toBe(0);

      resolveTranslate({ success: true, targetTabId: 1, messageId: 'session-new' });
      await pending;

      expect(pageTranslation.translatedCount.value).toBe(0);
      expect(pageTranslation.totalNodes.value).toBe(0);
      expect(pageTranslation.isTranslating.value).toBe(true);
    });

    it('ignores a foreign cancellation while a request is active', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const { resolveTranslate, sentGate } = createDeferredTranslate();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      await sentGate;
      resolveTranslate({ success: true, targetTabId: 1, messageId: 'session-new' });
      await pending;

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { tabId: 1, sessionId: 'session-new', isAutoTranslating: false },
      });
      expect(pageTranslation.isTranslating.value).toBe(true);

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_CANCELLED,
        data: { tabId: 2 },
      });

      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.message.value).not.toBe('Translation cancelled');
    });

    it('keeps the pending error presentation when a foreign restore completes', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const presentation = deferPresentation();
      const { resolveTranslate, sentGate } = createDeferredTranslate();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      await sentGate;
      resolveTranslate({ success: false, targetTabId: 1, messageId: 'session-new', error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await presentation.called;

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_RESTORE_COMPLETE,
        data: { tabId: 2, restoredCount: 3 },
      });

      presentation.resolve(new Error('boom'));
      await pending;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toBe('Error: boom');
    });

    it('keeps the pending error presentation when a foreign error reset arrives', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const presentation = deferPresentation();
      const { resolveTranslate, sentGate } = createDeferredTranslate();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      await sentGate;
      resolveTranslate({ success: false, targetTabId: 1, messageId: 'session-new', error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await presentation.called;

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_RESET_ERROR,
        data: { tabId: 2, isInternal: true },
      });

      presentation.resolve(new Error('boom'));
      await pending;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toBe('Error: boom');
    });

    it('applies same-tab lifecycle events of the pending request', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const { resolveTranslate, sentGate } = createDeferredTranslate();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      await sentGate;
      resolveTranslate({ success: true, targetTabId: 1, messageId: 'session-new' });
      await pending;

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { tabId: 1, sessionId: 'session-new', isAutoTranslating: false },
      });
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data: { tabId: 1, sessionId: 'session-new', translatedCount: 2, totalCount: 5, isTranslating: true },
      });

      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(2);
      expect(pageTranslation.totalNodes.value).toBe(5);

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_RESET_ERROR,
        data: { tabId: 1, isInternal: true },
      });
      expect(pageTranslation.error.value).toBeNull();

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_CANCELLED,
        data: { tabId: 1, sessionId: 'session-new' },
      });
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.message.value).toBe('Translation cancelled');
    });

    it('applies a same-tab restore completion for the displayed tab', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_RESTORE_COMPLETE,
        data: { tabId: 1, restoredCount: 4 },
      });

      expect(pageTranslation.isTranslated.value).toBe(false);
      expect(pageTranslation.message.value).toBe('Restore complete! 4 elements restored');
    });

    it('ignores a delayed start for a different session of the same tab', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const { resolveTranslate, sentGate } = createDeferredTranslate();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      await sentGate;
      resolveTranslate({ success: true, targetTabId: 1, messageId: 'session-a' });
      await pending;

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { tabId: 1, sessionId: 'session-b', isAutoTranslating: false },
      });

      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.message.value).not.toBe('Starting translation...');
      expect(pageTranslation.error.value).toBeNull();
    });

    it('keeps the active failure when a stale start arrives during deferred error presentation', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const presentation = deferPresentation();
      const { resolveTranslate, sentGate } = createDeferredTranslate();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      await sentGate;
      resolveTranslate({ success: false, targetTabId: 1, messageId: 'session-a', error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await presentation.called;

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { tabId: 1, sessionId: 'session-b', isAutoTranslating: false },
      });

      presentation.resolve(new Error('boom'));
      await pending;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toBe('Error: boom');
    });

    it('applies a matching start for the pending session', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const { resolveTranslate, sentGate } = createDeferredTranslate();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      await sentGate;
      resolveTranslate({ success: true, targetTabId: 1, messageId: 'session-a' });
      await pending;

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { tabId: 1, sessionId: 'session-a', isAutoTranslating: false },
      });

      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.message.value).toBe('Starting translation...');
      expect(pageTranslation.error.value).toBeNull();
    });

    it('keeps an unattributed command failure when a foreign completion arrives', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const presentation = deferPresentation();
      const { resolveTranslate, sentGate } = createDeferredTranslate();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1 });

      const pending = pageTranslation.translatePage();
      await sentGate;
      // A pre-fanout failure carries no authoritative tab or session identity.
      resolveTranslate({ success: false, reason: 'pre_fanout_command_timeout', isTransportFailure: true, error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await presentation.called;

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: { tabId: 2, sessionId: 'session-foreign', translatedCount: 5, totalCount: 5, isTranslated: true, isTranslating: false },
      });

      presentation.resolve(new Error('boom'));
      await pending;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toBe('Error: boom');
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
