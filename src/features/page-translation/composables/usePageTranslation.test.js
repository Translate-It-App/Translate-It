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
    },
    windows: { getCurrent: vi.fn() }
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
    browser.windows.getCurrent.mockResolvedValue({ id: 10 });
    sendRegularMessage.mockImplementation(({ action }) => {
      if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) {
        return Promise.resolve({ success: false });
      }
      return Promise.resolve({ success: true, targetTabId: 1, messageId: 'session-new' });
    });
  });

  async function createPageTranslation() {
    const pageTranslation = usePageTranslation();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    return pageTranslation;
  }

  function getRuntimeMessageListener() {
    return browser.runtime.onMessage.addListener.mock.calls.at(-1)[0];
  }

  function getTabUpdateListener() {
    return browser.tabs.onUpdated.addListener.mock.calls.at(-1)[0];
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

  // A translate command whose response is resolved by the test, plus a gate
  // that resolves once the command has actually been dispatched.
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
    it('retains per-frame translation state when Stop returns a fanout response', async () => {
      sendRegularMessage.mockImplementation(({ action }) => action === MessageActions.PAGE_TRANSLATE_GET_STATUS
        ? Promise.resolve({ success: false })
        : Promise.resolve({ success: true, responses: [
          { success: true, isTranslated: true, translatedCount: 3, failedCount: 1 },
          { success: true, isTranslated: true, translatedCount: 2, failedCount: 0 },
        ] }));
      const pageTranslation = await createPageTranslation();

      await pageTranslation.stopAutoTranslation();

      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(5);
      expect(pageTranslation.failedCount.value).toBe(1);
      expect(pageTranslation.message.value).toBe('Auto-translation stopped');
    });

    it('preserves known translation state when Stop fanout delivery is incomplete', async () => {
      sendRegularMessage.mockImplementation(({ action }) => action === MessageActions.PAGE_TRANSLATE_GET_STATUS
        ? Promise.resolve({ success: false })
        : Promise.resolve({ success: true, responses: [
          { success: true, isTranslated: false, translatedCount: 0 },
        ], frames: [
          { frameId: 0, success: true },
          { frameId: 1, success: false, isResponseTimeout: true },
        ] }));
      const pageTranslation = await createPageTranslation();
      pageTranslation.isTranslated.value = true;
      pageTranslation.translatedCount.value = 7;

      await pageTranslation.stopAutoTranslation();

      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(7);
    });

    it('does not let an older Stop response overwrite a newer lifecycle update', async () => {
      let resolveStop;
      sendRegularMessage.mockImplementation(({ action }) => action === MessageActions.PAGE_TRANSLATE_GET_STATUS
        ? Promise.resolve({ success: false })
        : new Promise((resolve) => { resolveStop = resolve; }));
      const pageTranslation = await createPageTranslation();
      const pending = pageTranslation.stopAutoTranslation();
      pageEventBus.on.mock.calls.find(([event]) => event === MessageActions.PAGE_AUTO_RESTORE_COMPLETE)[1](
        { isAggregated: true, tabId: 1, aggregateScope: 'doc', aggregateRevision: 1,
          isTranslated: true, translatedCount: 7, failedCount: 2 },
      );
      resolveStop({ success: true, responses: [{ success: true, isTranslated: false, translatedCount: 0 }] });
      await pending;

      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(7);
      expect(pageTranslation.failedCount.value).toBe(2);
    });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
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

    it('rejects stale same-session lifecycle events after a manual Auto stop', async () => {
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      await pageTranslation.translatePage();
      pageTranslation.isTranslating.value = true;
      pageTranslation.isAutoTranslating.value = true;
      pageTranslation.translatedCount.value = 2;
      pageTranslation.totalNodes.value = 5;

      await pageTranslation.stopAutoTranslation();
      expect(pageTranslation.message.value).toBe('Auto-translation stopped');
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(false);

      const listener = getRuntimeMessageListener();
      listener({
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data: {
          tabId: 1,
          sessionId: 'session-new',
          isTranslating: true,
          isAutoTranslating: true,
          translatedCount: 4,
          totalCount: 5,
        },
      });
      listener({
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: {
          tabId: 1,
          sessionId: 'session-new',
          isTranslating: false,
          isAutoTranslating: false,
          isTranslated: true,
          translatedCount: 5,
          totalCount: 5,
        },
      });

      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(false);
      expect(pageTranslation.translatedCount.value).toBe(2);
      expect(pageTranslation.totalNodes.value).toBe(5);
      expect(pageTranslation.message.value).toBe('Auto-translation stopped');
      expect(pageTranslation.error.value).toBeNull();
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
        aggregateScope: 'document-a',
        aggregateRevision: 1,
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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

      const pending = pageTranslation.translatePage();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

      resolveTranslate({ success: false, error: 'late failure', errorType: ErrorTypes.NETWORK_ERROR, targetTabId: 1, messageId: 'session-new' });
      await pending;

      expect(pageTranslation.error.value).toBeNull();
    });

    it('keeps the current request failure visible when its own START lifecycle arrives', async () => {
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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

    it('accepts only higher-revision same-scope lazy progress after completion and accepts its Restore', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      let call = 0;
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        call++;
        return Promise.resolve({ success: true, targetTabId: 1, messageId: call === 1 ? 'session-done' : 'session-next' });
      });
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      await pageTranslation.translatePage();

      const listener = getRuntimeMessageListener();
      listener({ action: MessageActions.PAGE_TRANSLATE_COMPLETE, data: {
        tabId: 1, sessionId: 'session-done', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 1,
        translatedCount: 1, totalCount: 2, isTranslated: false, isTranslating: false,
      } });
      listener({ action: MessageActions.PAGE_TRANSLATE_PROGRESS, data: {
        tabId: 1, sessionId: 'session-done', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 2,
        translatedCount: 2, totalCount: 2, isTranslated: true, isTranslating: false,
      } });
      expect(pageTranslation.translatedCount.value).toBe(2);
      expect(pageTranslation.isTranslated.value).toBe(true);

      listener({ action: MessageActions.PAGE_TRANSLATE_START, data: {
        tabId: 1, sessionId: 'session-done', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 3,
        isTranslating: true,
      } });
      expect(pageTranslation.isTranslating.value).toBe(false);
      listener({ action: MessageActions.PAGE_TRANSLATE_PROGRESS, data: {
        tabId: 1, sessionId: 'session-done', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 2,
        translatedCount: 0, totalCount: 2, isTranslated: false, isTranslating: true,
      } });
      listener({ action: MessageActions.PAGE_TRANSLATE_PROGRESS, data: {
        tabId: 1, sessionId: 'session-done', isAggregated: true, aggregateScope: 'other-doc', aggregateRevision: 3,
        translatedCount: 0, totalCount: 2, isTranslated: false, isTranslating: true,
      } });
      expect(pageTranslation.translatedCount.value).toBe(2);
      listener({ action: MessageActions.PAGE_TRANSLATE_PROGRESS, data: {
        tabId: 1, sessionId: 'session-done', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 3,
        translatedCount: 3, totalCount: 3, isTranslated: true, isTranslating: false,
      } });
      expect(pageTranslation.translatedCount.value).toBe(3);

      listener({ action: MessageActions.PAGE_RESTORE_COMPLETE, data: {
        tabId: 1, sessionId: 'session-done', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 4,
        restoredCount: 2,
      } });
      expect(pageTranslation.isTranslated.value).toBe(false);
      expect(pageTranslation.message.value).toContain('Restore complete!');
    });

    it('suppresses a completed session only after a newer request completes', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      let call = 0;
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        call++;
        return Promise.resolve({ success: true, targetTabId: 1, messageId: call === 1 ? 'session-old' : 'session-new' });
      });
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      await pageTranslation.translatePage();
      const listener = getRuntimeMessageListener();
      listener({ action: MessageActions.PAGE_TRANSLATE_COMPLETE, data: {
        tabId: 1, sessionId: 'session-old', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 1,
        translatedCount: 1, totalCount: 2, isTranslated: false, isTranslating: false,
      } });
      await pageTranslation.translatePage();
      listener({ action: MessageActions.PAGE_TRANSLATE_COMPLETE, data: {
        tabId: 1, sessionId: 'session-new', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 2,
        translatedCount: 1, totalCount: 2, isTranslated: false, isTranslating: false,
      } });
      listener({ action: MessageActions.PAGE_TRANSLATE_PROGRESS, data: {
        tabId: 1, sessionId: 'session-old', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 3,
        translatedCount: 0, totalCount: 2, isTranslated: false, isTranslating: true,
      } });
      expect(pageTranslation.translatedCount.value).toBe(1);
      expect(pageTranslation.isTranslated.value).toBe(false);
    });

    it('suppresses completed sessions after Stop', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      await pageTranslation.translatePage();
      const listener = getRuntimeMessageListener();
      listener({ action: MessageActions.PAGE_TRANSLATE_COMPLETE, data: {
        tabId: 1, sessionId: 'session-new', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 1,
        translatedCount: 2, totalCount: 2, isTranslated: true, isTranslating: false,
      } });
      await pageTranslation.stopAutoTranslation();
      listener({ action: MessageActions.PAGE_TRANSLATE_PROGRESS, data: {
        tabId: 1, sessionId: 'session-new', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 2,
        translatedCount: 0, totalCount: 2, isTranslated: false, isTranslating: true,
      } });
      expect(pageTranslation.translatedCount.value).toBe(2);
      expect(pageTranslation.isTranslated.value).toBe(true);
    });

    it('suppresses a completed frame session after cancellation', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      const pending = pageTranslation.translatePage();
      getRuntimeMessageListener()({ action: MessageActions.PAGE_TRANSLATE_START, data: {
        tabId: 1, sessionId: 'frame-a', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 1,
        isTranslating: true,
      } });
      await pending;
      const listener = getRuntimeMessageListener();
      listener({ action: MessageActions.PAGE_TRANSLATE_COMPLETE, data: {
        tabId: 1, sessionId: 'frame-a', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 2,
        translatedCount: 1, totalCount: 2, isTranslated: false, isTranslating: true,
      } });
      pageTranslation.cancelTranslation();
      listener({ action: MessageActions.PAGE_TRANSLATE_PROGRESS, data: {
        tabId: 1, sessionId: 'frame-a', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 3,
        translatedCount: 2, totalCount: 2, isTranslated: true, isTranslating: true,
      } });
      expect(pageTranslation.message.value).toBe('Translation cancelled');
      expect(pageTranslation.translatedCount.value).toBe(0);
      expect(pageTranslation.isTranslated.value).toBe(false);
    });

    it('suppresses completed sessions after owned-tab navigation', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      await pageTranslation.translatePage();
      const listener = getRuntimeMessageListener();
      listener({ action: MessageActions.PAGE_TRANSLATE_COMPLETE, data: {
        tabId: 1, sessionId: 'session-new', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 1,
        translatedCount: 2, totalCount: 2, isTranslated: true, isTranslating: false,
      } });
      await getTabUpdateListener()(1, { status: 'complete' });
      for (let i = 0; i < 3; i++) await Promise.resolve();
      pageTranslation.translatedCount.value = 2;
      pageTranslation.isTranslated.value = true;
      listener({ action: MessageActions.PAGE_TRANSLATE_PROGRESS, data: {
        tabId: 1, sessionId: 'session-new', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 2,
        translatedCount: 0, totalCount: 2, isTranslated: false, isTranslating: true,
      } });
      expect(pageTranslation.translatedCount.value).toBe(2);
      expect(pageTranslation.isTranslated.value).toBe(true);
    });

    it('keeps the fatal ERROR eligible after its completed session auto-restores', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const pageTranslation = await createPageTranslation();
      const presentation = deferPresentation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      await pageTranslation.translatePage();
      const listener = getRuntimeMessageListener();
      listener({ action: MessageActions.PAGE_TRANSLATE_COMPLETE, data: {
        tabId: 1, sessionId: 'session-new', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 1,
        translatedCount: 2, totalCount: 3, isTranslated: true, isTranslating: false,
      } });
      listener({ action: MessageActions.PAGE_AUTO_RESTORE_COMPLETE, data: {
        tabId: 1, sessionId: 'session-new', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 2,
        fatalErrorAutoRestore: true, isTranslated: true, isTranslating: false, isAutoTranslating: false,
      } });
      listener({ action: MessageActions.PAGE_TRANSLATE_ERROR, data: {
        tabId: 1, sessionId: 'session-new', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 3,
        ...errorEvent, isFatal: true, isTranslated: true, isTranslating: false, isAutoTranslating: false,
      } });

      await presentation.called;
      presentation.resolve(new Error('fatal failure'));
      for (let i = 0; i < 3; i++) await Promise.resolve();
      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toBe('Error: fatal failure');
    });

    it('accepts lazy progress after a completed frame while sibling frames remain active', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      const pending = pageTranslation.translatePage();
      getRuntimeMessageListener()({ action: MessageActions.PAGE_TRANSLATE_START, data: {
        tabId: 1, sessionId: 'frame-a', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 1,
        isTranslating: true,
      } });
      await pending;
      const listener = getRuntimeMessageListener();
      listener({ action: MessageActions.PAGE_TRANSLATE_COMPLETE, data: {
        tabId: 1, sessionId: 'frame-a', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 2,
        translatedCount: 1, totalCount: 2, isTranslated: false, isTranslating: true,
      } });
      listener({ action: MessageActions.PAGE_TRANSLATE_PROGRESS, data: {
        tabId: 1, sessionId: 'frame-a', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 3,
        translatedCount: 2, totalCount: 2, isTranslated: true, isTranslating: true,
      } });

      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(2);
      expect(pageTranslation.isTranslated.value).toBe(true);
    });

    it('does not let foreign-window activation supersede the request or displayed tab', async () => {
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = await createPageTranslation();
      const pending = pageTranslation.translatePage();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 7, windowId: 99 });
      resolveTranslate({ success: false, targetTabId: 1, messageId: 'session-new', error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await pending;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toContain('Error:');
    });

    it('does not replay an activation queued before a newer request', async () => {
      let resolveWindow;
      browser.windows.getCurrent.mockImplementation(() => new Promise((resolve) => { resolveWindow = resolve; }));
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = usePageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 2, windowId: 10 });
      const pending = pageTranslation.translatePage();
      resolveWindow({ id: 10 });
      resolveTranslate({ success: false, targetTabId: 1, messageId: 'session-new', error: 'request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await pending;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toContain('Error:');
    });

    it('reconciles a stale queued activation without superseding the newer request', async () => {
      let resolveWindow;
      browser.windows.getCurrent.mockImplementation(() => new Promise((resolve) => { resolveWindow = resolve; }));
      const resolveTranslate = mockTranslateResponse();
      const pageTranslation = usePageTranslation();
      const listener = getRuntimeMessageListener();

      listener({ action: MessageActions.PAGE_TRANSLATE_START, data: { tabId: 1, sessionId: 'old-tab' } });
      for (let i = 0; i < 5; i++) await Promise.resolve();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 2, windowId: 10 });
      const pending = pageTranslation.translatePage();

      resolveWindow({ id: 10 });
      for (let i = 0; i < 5; i++) await Promise.resolve();
      resolveTranslate({ success: true, targetTabId: 2, messageId: 'session-new' });
      await pending;

      listener({ action: MessageActions.PAGE_TRANSLATE_START, data: {
        tabId: 1, sessionId: 'session-new',
      } });
      expect(pageTranslation.isTranslating.value).toBe(false);
      listener({ action: MessageActions.PAGE_TRANSLATE_START, data: {
        tabId: 2, sessionId: 'session-new',
      } });
      expect(pageTranslation.isTranslating.value).toBe(true);
      listener({ action: MessageActions.PAGE_TRANSLATE_PROGRESS, data: {
        tabId: 1, sessionId: 'session-new', translated: 8, total: 10,
      } });
      expect(pageTranslation.translatedCount.value).toBe(0);
      listener({ action: MessageActions.PAGE_TRANSLATE_PROGRESS, data: {
        tabId: 2, sessionId: 'session-new', translated: 3, total: 10,
      } });
      expect(pageTranslation.translatedCount.value).toBe(3);
    });

    it('uses the latest queued same-window activation despite a foreign activation', async () => {
      let resolveWindow;
      browser.windows.getCurrent.mockImplementation(() => new Promise((resolve) => { resolveWindow = resolve; }));
      const pageTranslation = usePageTranslation();
      const getActivation = () => browser.tabs.onActivated.addListener.mock.calls.at(-1)[0];
      getActivation()({ tabId: 2, windowId: 10 });
      getActivation()({ tabId: 8, windowId: 99 });
      getActivation()({ tabId: 3, windowId: 10 });
      resolveWindow({ id: 10 });
      for (let i = 0; i < 5; i++) await Promise.resolve();

      const listener = getRuntimeMessageListener();
      listener({ action: MessageActions.PAGE_TRANSLATE_START, data: { tabId: 2, sessionId: 'old-tab' } });
      expect(pageTranslation.isTranslating.value).toBe(false);
      listener({ action: MessageActions.PAGE_TRANSLATE_START, data: { tabId: 3, sessionId: 'current-tab' } });
      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.error.value).toBeNull();
    });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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

      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 2, windowId: 10 });
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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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

    it('does not apply buffered START alone on transport failure', async () => {
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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isTranslated.value).toBe(false);
    });

    it('replays correlated terminal events on transport failure without losing fatal auto-restore correlation', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      getPageTranslationErrorPresentation.mockResolvedValueOnce(new Error('fatal translation failure'));
      let rejectTranslate;
      let markSent;
      const sentGate = new Promise((resolve) => { markSent = resolve; });
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        if (action === MessageActions.PAGE_TRANSLATE) {
          markSent();
          return new Promise((_, reject) => { rejectTranslate = reject; });
        }
        return Promise.resolve({ success: true });
      });
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      const pending = pageTranslation.translatePage();
      await sentGate;
      const listener = getRuntimeMessageListener();
      listener({ action: MessageActions.PAGE_TRANSLATE_START, data: {
        tabId: 2, sessionId: 'fatal-session', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 1,
      } });
      listener({ action: MessageActions.PAGE_AUTO_RESTORE_COMPLETE, data: {
        tabId: 2, sessionId: 'fatal-session', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 2,
        fatalErrorAutoRestore: true, isTranslated: true, isTranslating: false, isAutoTranslating: false,
        translatedCount: 4,
      } });
      listener({ action: MessageActions.PAGE_TRANSLATE_ERROR, data: {
        tabId: 2, sessionId: 'fatal-session', isAggregated: true, aggregateScope: 'doc', aggregateRevision: 3,
        isFatal: true, isTranslated: true, translatedCount: 4, error: 'fatal translation failure',
        errorDetails: { type: 'TRANSLATION_FAILED', message: 'fatal translation failure' },
      } });
      listener({ action: MessageActions.PAGE_TRANSLATE_ERROR, data: {
        tabId: 3, sessionId: 'foreign-session', isFatal: true, error: 'foreign failure',
      } });

      rejectTranslate(Object.assign(new Error('transport failure'), { targetTabId: 2 }));
      await pending;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toContain('fatal translation failure');
      expect(pageTranslation.message.value).not.toContain('foreign failure');
      expect(pageTranslation.translatedCount.value).toBe(4);
    });

    it('stops replaying buffered transport-failure events when Stop supersedes deferred presentation', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const presentation = deferPresentation();
      let rejectTranslate;
      let markSent;
      const sentGate = new Promise((resolve) => { markSent = resolve; });
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        if (action === MessageActions.PAGE_TRANSLATE_STOP_AUTO) return Promise.resolve({ success: true });
        if (action === MessageActions.PAGE_TRANSLATE) {
          markSent();
          return new Promise((_, reject) => { rejectTranslate = reject; });
        }
        return Promise.resolve({ success: true });
      });
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      const pending = pageTranslation.translatePage();
      await sentGate;
      const listener = getRuntimeMessageListener();
      listener({ action: MessageActions.PAGE_TRANSLATE_START, data: {
        tabId: 2, sessionId: 'replay-session', isAggregated: true,
        aggregateScope: 'doc', aggregateRevision: 1,
      } });
      listener({ action: MessageActions.PAGE_TRANSLATE_ERROR, data: {
        tabId: 2, sessionId: 'replay-session', isAggregated: true,
        aggregateScope: 'doc', aggregateRevision: 2, isFatal: true, error: 'old failure',
      } });
      listener({ action: MessageActions.PAGE_TRANSLATE_PROGRESS, data: {
        tabId: 2, sessionId: 'replay-session', isAggregated: true,
        aggregateScope: 'doc', aggregateRevision: 3, translatedCount: 99,
      } });
      rejectTranslate(Object.assign(new Error('transport failure'), { targetTabId: 2 }));
      await presentation.called;

      await pageTranslation.stopAutoTranslation();
      presentation.resolve(new Error('old failure'));
      await pending;

      expect(pageTranslation.message.value).toBe('Auto-translation stopped');
      expect(pageTranslation.translatedCount.value).toBe(0);
      expect(pageTranslation.error.value).toBeNull();
    });

    it('keeps successful buffered fatal auto-restore and error correlated when active tab is unresolved', async () => {
      browser.tabs.query.mockReturnValue(new Promise(() => {}));
      getPageTranslationErrorPresentation.mockResolvedValueOnce(new Error('fatal translation failure'));
      const { resolveTranslate, sentGate } = createDeferredTranslate();
      const pageTranslation = await createPageTranslation();
      const pending = pageTranslation.translatePage();
      await sentGate;
      const listener = getRuntimeMessageListener();
      listener({ action: MessageActions.PAGE_TRANSLATE_START, data: {
        tabId: 2, sessionId: 'fatal-success-session', isAggregated: true,
        aggregateScope: 'doc', aggregateRevision: 1,
      } });
      listener({ action: MessageActions.PAGE_AUTO_RESTORE_COMPLETE, data: {
        tabId: 2, sessionId: 'fatal-success-session', isAggregated: true,
        aggregateScope: 'doc', aggregateRevision: 2, fatalErrorAutoRestore: true,
        isTranslated: true, isTranslating: false, isAutoTranslating: false, translatedCount: 4,
      } });
      listener({ action: MessageActions.PAGE_TRANSLATE_ERROR, data: {
        tabId: 2, sessionId: 'unrelated-session', error: 'foreign same-tab failure',
      } });
      listener({ action: MessageActions.PAGE_TRANSLATE_ERROR, data: {
        tabId: 2, sessionId: 'fatal-success-session', isAggregated: true,
        aggregateScope: 'doc', aggregateRevision: 3, isFatal: true,
        error: 'fatal translation failure', isTranslated: true, translatedCount: 4,
      } });

      resolveTranslate({ success: true, targetTabId: 2, messageId: 'fatal-success-session' });
      await pending;

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toContain('fatal translation failure');
      expect(pageTranslation.message.value).not.toContain('foreign same-tab failure');
      expect(pageTranslation.translatedCount.value).toBe(4);
    });

    it('keeps a replayed fatal lifecycle error authoritative over a failed command response', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const presentation = deferPresentation();
      const { resolveTranslate, sentGate } = createDeferredTranslate();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      const pending = pageTranslation.translatePage();
      await sentGate;
      const listener = getRuntimeMessageListener();
      listener({ action: MessageActions.PAGE_TRANSLATE_START, data: {
        tabId: 2, sessionId: 'fatal-failed-response-session', isAggregated: true,
        aggregateScope: 'doc', aggregateRevision: 1,
      } });
      listener({ action: MessageActions.PAGE_AUTO_RESTORE_COMPLETE, data: {
        tabId: 2, sessionId: 'fatal-failed-response-session', isAggregated: true,
        aggregateScope: 'doc', aggregateRevision: 2, fatalErrorAutoRestore: true,
        isTranslated: true, isTranslating: false, isAutoTranslating: false,
        translatedCount: 4, failedCount: 2, totalCount: 6,
      } });
      listener({ action: MessageActions.PAGE_TRANSLATE_ERROR, data: {
        tabId: 2, sessionId: 'fatal-failed-response-session', isAggregated: true,
        aggregateScope: 'doc', aggregateRevision: 3, isFatal: true,
        error: 'fatal lifecycle failure', isTranslated: true,
        translatedCount: 4, failedCount: 2, totalCount: 6,
      } });

      resolveTranslate({
        success: false, targetTabId: 2, messageId: 'fatal-failed-response-session',
        error: 'distinct command failure',
      });
      await pending;
      await presentation.called;

      expect(getPageTranslationErrorPresentation).toHaveBeenCalledTimes(1);
      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.message.value).not.toContain('distinct command failure');
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(false);
      expect(pageTranslation.translatedCount.value).toBe(4);
      expect(pageTranslation.failedCount.value).toBe(2);

      presentation.resolve(new Error('fatal lifecycle failure'));
      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toBe('Error: fatal lifecycle failure');
      expect(pageTranslation.message.value).not.toContain('distinct command failure');
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(false);
      expect(pageTranslation.translatedCount.value).toBe(4);
      expect(pageTranslation.failedCount.value).toBe(2);
    });
  });

  describe('Regression: cross-tab lifecycle isolation', () => {
    it('ignores foreign progress before the command response resolves the request identity', async () => {
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
      const { resolveTranslate, sentGate } = createDeferredTranslate();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

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

  describe('Regression: silent error lifecycle', () => {
    // Production session id shape: page-translate-<timestamp>-<random>.
    const SESSION_ID = 'page-translate-1700000000000-42';
    const CHILD_SESSION_ID = 'page-translate-1700000000000-7';
    const NEXT_SESSION_ID = 'page-translate-1700000000001-7';
    const TAB_ID = 1;
    let aggregateRevision = 0;

    // Aggregated START as published by MainFrameAggregator and broadcast by
    // the background with the authoritative sender tab id.
    function startEvent(sessionId = SESSION_ID) {
      return {
        action: MessageActions.PAGE_TRANSLATE_START,
        data: {
          isAggregated: true,
          url: 'https://example.com/article',
          topLevelUrl: 'https://example.com/article',
          messageId: sessionId,
          sessionId,
          isAutoTranslating: false,
          translatedCount: 0,
          failedCount: 0,
          totalCount: 0,
          isTranslating: true,
          status: 'translating',
          tabId: TAB_ID,
          aggregateScope: 'document-a',
          aggregateRevision: ++aggregateRevision,
        },
      };
    }

    // Aggregated IDLE as published for a silent settlement.
    function idleEvent(sessionId = SESSION_ID, overrides = {}) {
      return {
        action: MessageActions.PAGE_TRANSLATE_IDLE,
        data: {
          isAggregated: true,
          url: 'https://example.com/article',
          topLevelUrl: 'https://example.com/article',
          messageId: sessionId,
          sessionId,
          translatedCount: 0,
          failedCount: 0,
          totalCount: 0,
          isTranslated: false,
          isTranslating: false,
          isAutoTranslating: false,
          status: 'idle',
          tabId: TAB_ID,
          aggregateScope: 'document-a',
          aggregateRevision: ++aggregateRevision,
          ...overrides,
        },
      };
    }

    // Background response for a silent failure after the request was admitted:
    // it carries the authoritative target tab and the settled session id.
    function silentErrorResponse(sessionId = SESSION_ID) {
      return {
        success: false,
        reason: 'silent_error',
        messageId: sessionId,
        responses: [{ success: false, reason: 'silent_error', messageId: sessionId }],
        frames: [{ frameId: 0, success: true }],
        targetTabId: TAB_ID,
      };
    }

    async function createSilentScenario() {
      browser.tabs.query.mockResolvedValue([{ id: TAB_ID }]);
      const deferred = createDeferredTranslate();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: TAB_ID, windowId: 10 });
      return { ...deferred, pageTranslation };
    }

    it('settles a silent error when the IDLE is buffered before the command response', async () => {
      const { resolveTranslate, sentGate, pageTranslation } = await createSilentScenario();

      const pending = pageTranslation.translatePage();
      await sentGate;
      getRuntimeMessageListener()(startEvent());
      getRuntimeMessageListener()(idleEvent());
      resolveTranslate(silentErrorResponse());
      await pending;

      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isTranslated.value).toBe(false);
      expect(pageTranslation.translatedCount.value).toBe(0);
      expect(pageTranslation.failedCount.value).toBe(0);
      expect(pageTranslation.totalNodes.value).toBe(0);
      expect(pageTranslation.error.value).toBeNull();
    });

    it('settles a silent error when the IDLE arrives after the command response', async () => {
      const { resolveTranslate, sentGate, pageTranslation } = await createSilentScenario();

      const pending = pageTranslation.translatePage();
      await sentGate;
      getRuntimeMessageListener()(startEvent());
      resolveTranslate(silentErrorResponse());
      await pending;

      // The silent response settles the Translating state itself, so the IDLE
      // is no longer required to leave it.
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.message.value).toBe('');

      getRuntimeMessageListener()(idleEvent());

      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isTranslated.value).toBe(false);
      expect(pageTranslation.translatedCount.value).toBe(0);
      expect(pageTranslation.error.value).toBeNull();
    });

    it('keeps retained translated content through a silent settlement', async () => {
      const { resolveTranslate, sentGate, pageTranslation } = await createSilentScenario();

      const pending = pageTranslation.translatePage();
      await sentGate;
      getRuntimeMessageListener()(startEvent());
      getRuntimeMessageListener()(idleEvent(SESSION_ID, {
        translatedCount: 3,
        totalCount: 3,
        isTranslated: true,
      }));
      resolveTranslate(silentErrorResponse());
      await pending;

      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(3);
      expect(pageTranslation.failedCount.value).toBe(0);
      expect(pageTranslation.totalNodes.value).toBe(3);
      expect(pageTranslation.error.value).toBeNull();
    });

    it('returns to idle when the silent error response arrives without an IDLE', async () => {
      const { resolveTranslate, sentGate, pageTranslation } = await createSilentScenario();

      // The command response ends the request silently. Nothing else may reset
      // the translating state, because the IDLE that normally follows can be
      // lost with the frame-lifecycle relay.
      const pending = pageTranslation.translatePage();
      await sentGate;
      getRuntimeMessageListener()(startEvent());
      resolveTranslate(silentErrorResponse());
      await pending;

      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.error.value).toBeNull();
    });

    it('ignores a stale same-tab IDLE after a newer session started', async () => {
      const { pageTranslation } = await createSilentScenario();
      const earlierStart = startEvent(SESSION_ID);
      const earlierIdle = idleEvent(SESSION_ID);
      const newerStart = startEvent(NEXT_SESSION_ID);

      // A passive session starts and is superseded by a newer session in the
      // same tab. No UI request is pending, so both events take the passive
      // (displayed tab) path.
      getRuntimeMessageListener()(earlierStart);
      expect(pageTranslation.isTranslating.value).toBe(true);

      getRuntimeMessageListener()(newerStart);
      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.message.value).toBe('Starting translation...');

      // The IDLE of the superseded session arrives late: it must not stop the
      // newer session.
      getRuntimeMessageListener()(earlierIdle);

      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.message.value).toBe('Starting translation...');
    });

    it('ignores stale PROGRESS delivered after a newer START', async () => {
      const { pageTranslation } = await createSilentScenario();
      const staleProgress = {
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data: { ...idleEvent(SESSION_ID).data, status: 'translating', isTranslating: true, translatedCount: 1 },
      };
      getRuntimeMessageListener()(startEvent(NEXT_SESSION_ID));
      getRuntimeMessageListener()(staleProgress);

      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.message.value).toBe('Starting translation...');
    });

    it.each([
      ['older successful non-aggregated status', { success: true, isTranslated: false, isTranslating: false }],
      ['restricted-page status', { success: false, isRestrictedPage: true, message: 'restricted' }],
      ['unsuccessful status', { success: false }],
      ['thrown status request', new Error('offline')],
    ])('does not let %s overwrite a newer lifecycle event', async (_label, response) => {
      const { pageTranslation } = await createSilentScenario();
      let resolveStatus;
      let rejectStatus;
      sendRegularMessage.mockImplementation(({ action }) => action === MessageActions.PAGE_TRANSLATE_GET_STATUS
        ? new Promise((resolve, reject) => { resolveStatus = resolve; rejectStatus = reject; })
        : Promise.resolve({ success: true }));
      const refresh = pageTranslation.refreshStatus();
      await Promise.resolve();
      const latest = startEvent(SESSION_ID);
      latest.data.isAggregated = false;
      getRuntimeMessageListener()(latest);
      if (response instanceof Error) rejectStatus(response);
      else resolveStatus(response);
      await refresh;

      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.message.value).toBe('Starting translation...');
    });

    it.each(['cancel', 'restore', 'new translation'])('ignores a status response started before %s', async (operation) => {
      const { pageTranslation } = await createSilentScenario();
      let resolveStatus;
      let resolveOperation;
      sendRegularMessage.mockImplementation(({ action, data }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) {
          return new Promise(resolve => { resolveStatus = resolve; });
        }
        if (action === MessageActions.PAGE_RESTORE || (action === MessageActions.PAGE_TRANSLATE && !data?.cancel)) {
          return new Promise(resolve => { resolveOperation = resolve; });
        }
        return Promise.resolve({ success: true });
      });

      pageTranslation.isTranslated.value = true;
      if (operation === 'cancel') pageTranslation.isTranslating.value = true;
      const refresh = pageTranslation.refreshStatus();
      const action = operation === 'cancel'
        ? pageTranslation.cancelTranslation()
        : operation === 'restore'
          ? pageTranslation.restorePage()
          : pageTranslation.translatePage();

      resolveStatus({ success: true, isTranslated: false, isTranslating: true, translatedCount: 0 });
      await refresh;

      if (operation === 'cancel') {
        expect(pageTranslation.isTranslating.value).toBe(false);
        expect(pageTranslation.message.value).toBe('Translation cancelled');
      } else if (operation === 'restore') {
        expect(pageTranslation.message.value).toBe('Restoring original content...');
      } else {
        expect(pageTranslation.isTranslated.value).toBe(true);
      }

      if (operation !== 'cancel') {
        resolveOperation({ success: true, restoredCount: 1, targetTabId: TAB_ID, messageId: 'new-session' });
        await action;
      }
    });

    it('accepts different frame session ids within one aggregate stream', async () => {
      const { pageTranslation } = await createSilentScenario();
      const first = startEvent(SESSION_ID);
      const second = startEvent(CHILD_SESSION_ID);
      second.data.aggregateRevision = first.data.aggregateRevision + 1;
      getRuntimeMessageListener()(first);
      getRuntimeMessageListener()(second);

      expect(pageTranslation.isTranslating.value).toBe(true);
    });

    it('applies only current-document sessionless aggregate progress for the active tab', async () => {
      const { pageTranslation } = await createSilentScenario();
      const baseline = startEvent();
      getRuntimeMessageListener()(baseline);
      const progress = {
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data: {
          isAggregated: true,
          tabId: TAB_ID,
          aggregateScope: 'document-a',
          aggregateRevision: baseline.data.aggregateRevision + 1,
          topLevelUrl: baseline.data.topLevelUrl,
          translatedCount: 4,
          failedCount: 2,
          totalCount: 9,
        },
      };

      getRuntimeMessageListener()({ ...progress, data: { ...progress.data, tabId: TAB_ID + 1, aggregateRevision: progress.data.aggregateRevision + 1 } });
      getRuntimeMessageListener()({ ...progress, data: { ...progress.data, aggregateRevision: baseline.data.aggregateRevision } });
      getRuntimeMessageListener()({ ...progress, data: { ...progress.data, aggregateScope: 'other-document', aggregateRevision: progress.data.aggregateRevision + 1 } });
      expect(pageTranslation.translatedCount.value).toBe(0);

      getRuntimeMessageListener()(progress);
      expect(pageTranslation.translatedCount.value).toBe(4);
      expect(pageTranslation.failedCount.value).toBe(2);
      expect(pageTranslation.totalNodes.value).toBe(9);
    });

    it('replays buffered sessionless aggregate progress only for the resolved request tab', async () => {
      const { resolveTranslate, sentGate, pageTranslation } = await createSilentScenario();
      const pending = pageTranslation.translatePage();
      await sentGate;
      const progress = (tabId, translatedCount) => ({
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data: {
          isAggregated: true,
          tabId,
          aggregateScope: 'document-a',
          aggregateRevision: translatedCount,
          topLevelUrl: 'https://example.com/article',
          translatedCount,
          failedCount: 0,
          totalCount: 8,
        },
      });
      getRuntimeMessageListener()(progress(TAB_ID, 3));
      getRuntimeMessageListener()(progress(TAB_ID + 1, 7));

      resolveTranslate({ success: true, targetTabId: TAB_ID, messageId: SESSION_ID });
      await pending;

      expect(pageTranslation.translatedCount.value).toBe(3);
      expect(pageTranslation.totalNodes.value).toBe(8);
    });

    it('continues rejecting sessionless non-aggregated progress for a pending request', async () => {
      const { resolveTranslate, pageTranslation } = await createSilentScenario();
      const pending = pageTranslation.translatePage();
      resolveTranslate({ success: true, targetTabId: TAB_ID, messageId: SESSION_ID });
      await pending;

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data: { tabId: TAB_ID, translatedCount: 7, totalCount: 8, isTranslating: true },
      });

      expect(pageTranslation.translatedCount.value).toBe(0);
      expect(pageTranslation.isTranslating.value).toBe(false);
    });

    it('does not associate an unresolved-tab status with an unknown tab', async () => {
      let resolveTabs;
      browser.tabs.query.mockReturnValue(new Promise(resolve => { resolveTabs = resolve; }));
      let statusCalls = 0;
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action !== MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: true });
        statusCalls++;
        return Promise.resolve({
          success: true,
          isAggregated: true,
          aggregateScope: 'document-a',
          aggregateRevision: 5,
          isTranslated: false,
          isTranslating: false,
        });
      });

      const pageTranslation = usePageTranslation();
      await Promise.resolve();
      await Promise.resolve();
      expect(statusCalls).toBe(1);
      resolveTabs([{ id: TAB_ID }]);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const nextStart = startEvent(SESSION_ID);
      nextStart.data.aggregateRevision = 6;
      getRuntimeMessageListener()(nextStart);
      expect(pageTranslation.isTranslating.value).toBe(true);
    });

    it('uses refreshed document identity to reject delayed events from the old document', async () => {
      const { pageTranslation } = await createSilentScenario();
      getRuntimeMessageListener()(startEvent(NEXT_SESSION_ID));
      sendRegularMessage.mockImplementation(({ action }) => action === MessageActions.PAGE_TRANSLATE_GET_STATUS
        ? Promise.resolve({ success: true, isAggregated: true, aggregateScope: 'document-b', aggregateRevision: 0 })
        : Promise.resolve({ success: true }));
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 2, windowId: 10 });
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: TAB_ID, windowId: 10 });
      await Promise.resolve();
      await Promise.resolve();
      getRuntimeMessageListener()(startEvent(SESSION_ID));
      expect(pageTranslation.isTranslating.value).toBe(false);

      const newDocumentStart = startEvent(SESSION_ID);
      newDocumentStart.data.aggregateScope = 'document-b';
      newDocumentStart.data.aggregateRevision = 1;
      getRuntimeMessageListener()(newDocumentStart);

      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.message.value).toBe('Starting translation...');
    });

    it('admits a child START for a verified navigation after stale status and failed refresh', async () => {
      const { pageTranslation } = await createSilentScenario();
      getRuntimeMessageListener()(startEvent(SESSION_ID));
      let statusCalls = 0;
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action !== MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: true });
        statusCalls++;
        return Promise.resolve(statusCalls === 1
          ? { success: true, isAggregated: true, aggregateScope: 'document-a', aggregateRevision: 100,
            currentUrl: 'https://example.com/article', isTranslated: false, isTranslating: true }
          : { success: false });
      });

      await getTabUpdateListener()(TAB_ID, { status: 'complete' }, { id: TAB_ID, url: 'https://example.com/next' });
      await pageTranslation.refreshStatus();
      const oldDocumentIdle = idleEvent(SESSION_ID);
      oldDocumentIdle.data.url = 'https://example.com/article';
      oldDocumentIdle.data.topLevelUrl = 'https://example.com/article';
      getRuntimeMessageListener()(oldDocumentIdle);
      expect(pageTranslation.isTranslating.value).toBe(false);

      const childStart = startEvent(CHILD_SESSION_ID);
      childStart.data.aggregateScope = 'document-b';
      childStart.data.url = 'https://example.com/iframe';
      childStart.data.topLevelUrl = 'https://example.com/next';
      childStart.data.aggregateRevision = 1;
      getRuntimeMessageListener()(childStart);
      expect(pageTranslation.isTranslating.value).toBe(true);

      const staleOldStart = startEvent(SESSION_ID);
      staleOldStart.data.url = 'https://example.com/article';
      staleOldStart.data.topLevelUrl = 'https://example.com/article';
      staleOldStart.data.aggregateRevision = 100;
      getRuntimeMessageListener()(staleOldStart);
      expect(pageTranslation.isTranslating.value).toBe(true);

      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 2, windowId: 10 });
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: TAB_ID, windowId: 10 });
      await Promise.resolve();
      const anotherNewStart = startEvent(NEXT_SESSION_ID);
      anotherNewStart.data.aggregateScope = 'document-b';
      anotherNewStart.data.aggregateRevision = 2;
      getRuntimeMessageListener()(anotherNewStart);
      expect(pageTranslation.isTranslating.value).toBe(true);
    });

    it('accepts a new document scope after a same-URL reload when status refresh fails', async () => {
      const { pageTranslation } = await createSilentScenario();
      const oldStart = startEvent(SESSION_ID);
      getRuntimeMessageListener()(oldStart);
      sendRegularMessage.mockImplementation(({ action }) => action === MessageActions.PAGE_TRANSLATE_GET_STATUS
        ? Promise.resolve({ success: false })
        : Promise.resolve({ success: true }));

      await getTabUpdateListener()(TAB_ID, { status: 'complete' }, {
        id: TAB_ID,
        url: 'https://example.com/article',
      });

      pageTranslation.message.value = 'navigation status failed';
      const staleOldStart = startEvent(NEXT_SESSION_ID);
      staleOldStart.data.aggregateRevision = 100;
      getRuntimeMessageListener()(staleOldStart);
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.message.value).not.toBe('Starting translation...');
      const staleOldIdle = idleEvent(SESSION_ID, { isTranslated: true, translatedCount: 4 });
      getRuntimeMessageListener()(staleOldIdle);
      expect(pageTranslation.isTranslated.value).toBe(false);

      const newStart = startEvent(NEXT_SESSION_ID);
      newStart.data.aggregateScope = 'document-b';
      newStart.data.aggregateRevision = 1;
      newStart.data.url = 'https://example.com/article';
      newStart.data.topLevelUrl = 'https://example.com/article';
      const newProgress = {
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data: { ...newStart.data, aggregateRevision: 2, translatedCount: 1 },
      };
      getRuntimeMessageListener()(newProgress);
      expect(pageTranslation.isTranslating.value).toBe(false);

      getRuntimeMessageListener()(newStart);
      expect(pageTranslation.isTranslating.value).toBe(true);
      getRuntimeMessageListener()(newProgress);
      expect(pageTranslation.translatedCount.value).toBe(1);

      const delayedOldIdle = idleEvent(SESSION_ID);
      getRuntimeMessageListener()(delayedOldIdle);
      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.message.value).toBe('Starting translation...');
    });

    it('preserves a background same-URL reload transition across return activation and stale verification', async () => {
      const { resolveTranslate, pageTranslation } = await createSilentScenario();
      getRuntimeMessageListener()(startEvent());
      getRuntimeMessageListener()(idleEvent());

      const originalSend = sendRegularMessage.getMockImplementation();
      let resolveTabs;
      browser.tabs.query.mockReturnValue(new Promise((resolve) => { resolveTabs = resolve; }));
      sendRegularMessage.mockImplementation((message) => message.action === MessageActions.PAGE_TRANSLATE_GET_STATUS
        ? Promise.resolve({ success: false })
        : originalSend(message));

      const pendingTabUpdate = getTabUpdateListener()(TAB_ID, { status: 'complete' }, {
        id: TAB_ID,
        url: 'https://example.com/article',
      });

      const earlyStart = startEvent('early-new-document');
      earlyStart.data.aggregateScope = 'document-b';
      earlyStart.data.aggregateRevision = 1;
      getRuntimeMessageListener()(earlyStart);
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data: { ...earlyStart.data, aggregateRevision: 2, translatedCount: 2, totalCount: 5 },
      });
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.translatedCount.value).toBe(0);

      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 2, windowId: 10 });
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.translatedCount.value).toBe(0);
      browser.tabs.query.mockResolvedValue([{ id: 2 }]);
      const pendingRequest = pageTranslation.translatePage();
      await getTabUpdateListener()(9, { status: 'complete' }, { id: 9, url: 'https://example.com/other' });
      resolveTranslate({ success: false, error: 'active request failed', errorType: ErrorTypes.NETWORK_ERROR });
      await pendingRequest;
      expect(pageTranslation.error.value).toBeInstanceOf(Error);

      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: TAB_ID, windowId: 10 });
      resolveTabs([{ id: 2 }]);
      await pendingTabUpdate;
      await Promise.resolve();

      const newStart = startEvent(NEXT_SESSION_ID);
      newStart.data.aggregateScope = 'document-b';
      newStart.data.aggregateRevision = 1;
      getRuntimeMessageListener()(newStart);
      expect(pageTranslation.isTranslating.value).toBe(true);
      const newProgress = {
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data: { ...newStart.data, aggregateRevision: 2, translatedCount: 3, totalCount: 5 },
      };
      getRuntimeMessageListener()(newProgress);
      expect(pageTranslation.translatedCount.value).toBe(3);
      const newComplete = {
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: { ...newStart.data, aggregateRevision: 3, translatedCount: 4, totalCount: 5, isTranslated: true, isTranslating: false },
      };
      getRuntimeMessageListener()(newComplete);
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(4);

      const staleOldStart = startEvent('old-document-late-start');
      staleOldStart.data.aggregateRevision = 101;
      getRuntimeMessageListener()(staleOldStart);
      getRuntimeMessageListener()(idleEvent(SESSION_ID, { aggregateRevision: 102 }));
      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(4);
    });

    it('replays a START received before the navigation callback after verification and failed refresh', async () => {
      const { pageTranslation } = await createSilentScenario();
      const oldStart = startEvent(SESSION_ID);
      getRuntimeMessageListener()(oldStart);
      getRuntimeMessageListener()(idleEvent(SESSION_ID));
      expect(pageTranslation.isTranslating.value).toBe(false);
      let resolveTabs;
      browser.tabs.query.mockReturnValue(new Promise((resolve) => { resolveTabs = resolve; }));
      let statusCalls = 0;
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action !== MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: true });
        statusCalls++;
        return Promise.resolve({ success: false });
      });

      const newStart = startEvent(NEXT_SESSION_ID);
      newStart.data.aggregateScope = 'document-b';
      newStart.data.aggregateRevision = 1;
      getRuntimeMessageListener()(newStart);
      const earlyProgress = {
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data: { ...newStart.data, aggregateRevision: 2, translatedCount: 3, totalCount: 5 },
      };
      getRuntimeMessageListener()(earlyProgress);
      expect(pageTranslation.isTranslating.value).toBe(false);

      const navigation = getTabUpdateListener()(TAB_ID, { status: 'complete' }, {
        id: TAB_ID,
        url: 'https://example.com/article',
      });
      expect(pageTranslation.isTranslating.value).toBe(false);

      resolveTabs([{ id: TAB_ID }]);
      await navigation;
      await Promise.resolve();
      await Promise.resolve();

      expect(statusCalls).toBe(1);
      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(3);
      expect(pageTranslation.totalNodes.value).toBe(5);

      const delayedOldScope = idleEvent(SESSION_ID, {
        aggregateScope: 'document-a', aggregateRevision: 100,
        topLevelUrl: 'https://example.com/article',
      });
      getRuntimeMessageListener()(delayedOldScope);
      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(3);

      const sameUrlPreviousScope = startEvent(NEXT_SESSION_ID);
      sameUrlPreviousScope.data.aggregateScope = 'document-a';
      sameUrlPreviousScope.data.aggregateRevision = 101;
      getRuntimeMessageListener()(sameUrlPreviousScope);
      expect(pageTranslation.translatedCount.value).toBe(3);
      expect(pageTranslation.message.value).toBe('Starting translation...');
    });

    it('keeps revision 10 authoritative over a delayed revision 8 before navigation verification', async () => {
      const { pageTranslation } = await createSilentScenario();
      getRuntimeMessageListener()(startEvent(SESSION_ID));
      getRuntimeMessageListener()(idleEvent(SESSION_ID));
      let resolveTabs;
      browser.tabs.query.mockReturnValue(new Promise((resolve) => { resolveTabs = resolve; }));
      sendRegularMessage.mockImplementation(({ action }) => action === MessageActions.PAGE_TRANSLATE_GET_STATUS
        ? Promise.resolve({ success: false })
        : Promise.resolve({ success: true }));

      const newStart = startEvent(NEXT_SESSION_ID);
      Object.assign(newStart.data, { aggregateScope: 'document-b', aggregateRevision: 1 });
      getRuntimeMessageListener()(newStart);
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data: { ...newStart.data, aggregateRevision: 10, translatedCount: 10, totalCount: 12 },
      });
      const interveningStart = {
        ...newStart,
        data: { ...newStart.data, aggregateRevision: 9 },
      };
      getRuntimeMessageListener()(interveningStart);
      for (let index = 0; index < 17; index++) getRuntimeMessageListener()(interveningStart);
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_IDLE,
        data: { ...newStart.data, aggregateRevision: 8, translatedCount: 8, totalCount: 12, isTranslating: false },
      });

      const navigation = getTabUpdateListener()(TAB_ID, { status: 'complete' }, {
        id: TAB_ID,
        url: 'https://example.com/article',
      });
      resolveTabs([{ id: TAB_ID }]);
      await navigation;
      await Promise.resolve();
      await Promise.resolve();

      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(10);
      expect(pageTranslation.totalNodes.value).toBe(12);
    });

    it('uses newer terminal revisions as high-water marks after capacity pruning removes progress', async () => {
      const { pageTranslation } = await createSilentScenario();
      getRuntimeMessageListener()(startEvent(SESSION_ID));
      getRuntimeMessageListener()(idleEvent(SESSION_ID));
      let resolveTabs;
      browser.tabs.query.mockReturnValue(new Promise((resolve) => { resolveTabs = resolve; }));
      sendRegularMessage.mockImplementation(({ action }) => action === MessageActions.PAGE_TRANSLATE_GET_STATUS
        ? Promise.resolve({ success: false })
        : Promise.resolve({ success: true }));

      const newStart = startEvent(NEXT_SESSION_ID);
      Object.assign(newStart.data, { aggregateScope: 'document-b', aggregateRevision: 1 });
      getRuntimeMessageListener()(newStart);
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data: { ...newStart.data, aggregateRevision: 10, translatedCount: 10, totalCount: 12 },
      });
      const terminal = {
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: {
          ...newStart.data,
          aggregateRevision: 11,
          translatedCount: 10,
          totalCount: 12,
          isTranslated: true,
          isTranslating: false,
        },
      };
      for (let index = 0; index < 19; index++) getRuntimeMessageListener()(terminal);
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_IDLE,
        data: { ...newStart.data, aggregateRevision: 8, translatedCount: 8, totalCount: 12, isTranslating: false },
      });

      const navigation = getTabUpdateListener()(TAB_ID, { status: 'complete' }, {
        id: TAB_ID,
        url: 'https://example.com/article',
      });
      resolveTabs([{ id: TAB_ID }]);
      await navigation;
      await Promise.resolve();
      await Promise.resolve();

      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.translatedCount.value).toBe(10);
      expect(pageTranslation.totalNodes.value).toBe(12);
    });

    it.each([
      [MessageActions.PAGE_TRANSLATE_PROGRESS, MessageActions.PAGE_TRANSLATE_IDLE, true],
      [MessageActions.PAGE_TRANSLATE_IDLE, MessageActions.PAGE_TRANSLATE_PROGRESS, false],
    ])('coalesces %s/%s snapshots by revision, preserving newer action semantics', async (newerAction, staleAction, expectedTranslating) => {
      const { pageTranslation } = await createSilentScenario();
      getRuntimeMessageListener()(startEvent(SESSION_ID));
      getRuntimeMessageListener()(idleEvent(SESSION_ID));
      let resolveTabs;
      browser.tabs.query.mockReturnValue(new Promise((resolve) => { resolveTabs = resolve; }));
      sendRegularMessage.mockImplementation(({ action }) => action === MessageActions.PAGE_TRANSLATE_GET_STATUS
        ? Promise.resolve({ success: false })
        : Promise.resolve({ success: true }));

      const newStart = startEvent(NEXT_SESSION_ID);
      Object.assign(newStart.data, { aggregateScope: 'document-b', aggregateRevision: 1 });
      getRuntimeMessageListener()(newStart);
      for (const [action, revision, count] of [[newerAction, 10, 10], [staleAction, 8, 8]]) {
        getRuntimeMessageListener()({
          action,
          data: {
            ...newStart.data,
            aggregateRevision: revision,
            translatedCount: count,
            totalCount: 12,
            isTranslating: action === MessageActions.PAGE_TRANSLATE_PROGRESS,
          },
        });
      }

      const navigation = getTabUpdateListener()(TAB_ID, { status: 'complete' }, {
        id: TAB_ID,
        url: 'https://example.com/article',
      });
      resolveTabs([{ id: TAB_ID }]);
      await navigation;
      await Promise.resolve();
      await Promise.resolve();

      expect(pageTranslation.isTranslating.value).toBe(expectedTranslating);
      expect(pageTranslation.translatedCount.value).toBe(10);
      expect(pageTranslation.totalNodes.value).toBe(12);
    });

    it('coalesces early progress snapshots without losing START or COMPLETE on a failed refresh', async () => {
      const { pageTranslation } = await createSilentScenario();
      getRuntimeMessageListener()(startEvent(SESSION_ID));
      getRuntimeMessageListener()(idleEvent(SESSION_ID));
      let resolveTabs;
      browser.tabs.query.mockReturnValue(new Promise((resolve) => { resolveTabs = resolve; }));
      sendRegularMessage.mockImplementation(({ action }) => action === MessageActions.PAGE_TRANSLATE_GET_STATUS
        ? Promise.resolve({ success: false })
        : Promise.resolve({ success: true }));

      const newStart = startEvent(NEXT_SESSION_ID);
      newStart.data.aggregateScope = 'document-b';
      newStart.data.aggregateRevision = 1;
      getRuntimeMessageListener()(newStart);
      let revision = 2;
      while (revision <= 27) {
        getRuntimeMessageListener()({
          action: MessageActions.PAGE_TRANSLATE_PROGRESS,
          data: {
            ...newStart.data,
            aggregateRevision: revision,
            translatedCount: revision,
            failedCount: 0,
            totalCount: 30,
          },
        });
        revision++;
        if (revision <= 27) {
          getRuntimeMessageListener()({
            action: MessageActions.PAGE_TRANSLATE_START,
            data: {
              ...newStart.data,
              aggregateRevision: revision++,
              translatedCount: 0,
              failedCount: 0,
              totalCount: 30,
              isTranslating: true,
              isAutoTranslating: false,
            },
          });
        }
      }
      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: {
          ...newStart.data,
          aggregateRevision: revision,
          translatedCount: 27,
          failedCount: 0,
          totalCount: 30,
          isTranslated: true,
          isTranslating: false,
        },
      });
      expect(pageTranslation.isTranslated.value).toBe(false);

      const navigation = getTabUpdateListener()(TAB_ID, { status: 'complete' }, {
        id: TAB_ID,
        url: 'https://example.com/article',
      });
      resolveTabs([{ id: TAB_ID }]);
      await navigation;
      await Promise.resolve();
      await Promise.resolve();

      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.translatedCount.value).toBe(27);
      expect(pageTranslation.totalNodes.value).toBe(30);

      const staleOldDocument = idleEvent(SESSION_ID, {
        aggregateScope: 'document-a',
        aggregateRevision: 1000,
        isTranslated: false,
        translatedCount: 1,
        totalCount: 1,
      });
      getRuntimeMessageListener()(staleOldDocument);
      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.translatedCount.value).toBe(27);
      expect(pageTranslation.totalNodes.value).toBe(30);
    });

    it('buffers a changed-scope START that arrives while navigation tab verification is pending', async () => {
      const { pageTranslation } = await createSilentScenario();
      getRuntimeMessageListener()(startEvent(SESSION_ID));
      let resolveTabs;
      browser.tabs.query.mockReturnValue(new Promise((resolve) => { resolveTabs = resolve; }));
      sendRegularMessage.mockImplementation(({ action }) => action === MessageActions.PAGE_TRANSLATE_GET_STATUS
        ? Promise.resolve({ success: false })
        : Promise.resolve({ success: true }));

      const navigation = getTabUpdateListener()(TAB_ID, { status: 'complete' }, {
        id: TAB_ID,
        url: 'https://example.com/article',
      });
      const duringQueryStart = startEvent(NEXT_SESSION_ID);
      duringQueryStart.data.aggregateScope = 'document-b';
      duringQueryStart.data.aggregateRevision = 1;
      getRuntimeMessageListener()(duringQueryStart);
      expect(pageTranslation.isTranslating.value).toBe(true);

      resolveTabs([{ id: TAB_ID }]);
      await navigation;
      await Promise.resolve();
      await Promise.resolve();
      expect(pageTranslation.message.value).toBe('Starting translation...');
      expect(pageTranslation.isTranslating.value).toBe(true);
    });

    it('does not replay a request-owned START as a passive navigation candidate', async () => {
      const { pageTranslation } = await createSilentScenario();
      getRuntimeMessageListener()(startEvent(SESSION_ID));
      getRuntimeMessageListener()(idleEvent(SESSION_ID));
      pageTranslation.message.value = 'Idle before request';
      let resolveTranslate;
      let resolveTabs;
      const translateResponse = new Promise((resolve) => { resolveTranslate = resolve; });
      browser.tabs.query.mockReturnValue(new Promise((resolve) => { resolveTabs = resolve; }));
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: false });
        if (action === MessageActions.PAGE_TRANSLATE) return translateResponse;
        return Promise.resolve({ success: true });
      });
      const pendingRequest = pageTranslation.translatePage();
      const navigation = getTabUpdateListener()(TAB_ID, { status: 'complete' }, {
        id: TAB_ID,
        url: 'https://example.com/article',
      });
      const requestStart = startEvent(NEXT_SESSION_ID);
      requestStart.data.aggregateScope = 'document-b';
      requestStart.data.aggregateRevision = 1;
      getRuntimeMessageListener()(requestStart);

      resolveTabs([{ id: TAB_ID }]);
      await navigation;
      await Promise.resolve();
      await Promise.resolve();
      resolveTranslate({ success: true, targetTabId: TAB_ID, messageId: NEXT_SESSION_ID });
      await pendingRequest;

      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.message.value).not.toBe('Starting translation...');
    });

    it('does not let an older overlapping tab query confirm a newer navigation transition', async () => {
      const { pageTranslation } = await createSilentScenario();
      getRuntimeMessageListener()(startEvent(SESSION_ID));
      let resolveFirst;
      let resolveSecond;
      let queryCount = 0;
      browser.tabs.query.mockImplementation(() => new Promise((resolve) => {
        queryCount++;
        if (queryCount === 1) resolveFirst = resolve;
        else resolveSecond = resolve;
      }));
      let statusCalls = 0;
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) {
          statusCalls++;
          return Promise.resolve({ success: false });
        }
        return Promise.resolve({ success: true });
      });

      const firstNavigation = getTabUpdateListener()(TAB_ID, { status: 'complete' }, {
        id: TAB_ID, url: 'https://example.com/article',
      });
      const secondNavigation = getTabUpdateListener()(TAB_ID, { status: 'complete' }, {
        id: TAB_ID, url: 'https://example.com/article',
      });
      resolveFirst([{ id: TAB_ID }]);
      await firstNavigation;
      expect(statusCalls).toBe(0);
      resolveSecond([{ id: TAB_ID }]);
      await secondNavigation;
      await Promise.resolve();
      expect(statusCalls).toBe(1);
      expect(pageTranslation.isTranslating.value).toBe(false);
    });

    it('preserves same-scope lifecycle continuity for a verified SPA URL change', async () => {
      const { pageTranslation } = await createSilentScenario();
      const initial = startEvent(SESSION_ID);
      getRuntimeMessageListener()(initial);
      sendRegularMessage.mockImplementation(({ action }) => action === MessageActions.PAGE_TRANSLATE_GET_STATUS
        ? Promise.resolve({ success: false })
        : Promise.resolve({ success: true }));

      await getTabUpdateListener()(TAB_ID, { status: 'complete' }, {
        id: TAB_ID,
        url: 'https://example.com/next',
      });
      const spaProgress = {
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data: {
          ...initial.data,
          url: 'https://example.com/iframe',
          topLevelUrl: 'https://example.com/next',
          aggregateRevision: initial.data.aggregateRevision + 1,
          translatedCount: 3,
          totalCount: 5,
        },
      };
      getRuntimeMessageListener()(spaProgress);

      expect(pageTranslation.translatedCount.value).toBe(3);
      expect(pageTranslation.totalNodes.value).toBe(5);
    });

    it('ignores an older status refresh after a newer tab refresh establishes state', async () => {
      const { pageTranslation } = await createSilentScenario();
      let resolveOldStatus;
      let statusRequests = 0;
      sendRegularMessage.mockImplementation(({ action }) => {
        if (action !== MessageActions.PAGE_TRANSLATE_GET_STATUS) return Promise.resolve({ success: true });
        statusRequests++;
        if (statusRequests === 1) return new Promise(resolve => { resolveOldStatus = resolve; });
        return Promise.resolve({
          success: true,
          isAggregated: true,
          aggregateScope: 'document-b',
          aggregateRevision: 3,
          isTranslated: true,
          isTranslating: false,
          translatedCount: 4,
          totalCount: 4,
        });
      });

      const oldRefresh = pageTranslation.refreshStatus();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 2, windowId: 10 });
      await Promise.resolve();
      resolveOldStatus({
        success: true,
        isAggregated: true,
        aggregateScope: 'document-a',
        aggregateRevision: 99,
        isTranslated: false,
        isTranslating: true,
        translatedCount: 0,
        totalCount: 10,
      });
      await oldRefresh;

      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.translatedCount.value).toBe(4);

      const oldDocumentStart = startEvent(NEXT_SESSION_ID);
      oldDocumentStart.data.tabId = 2;
      oldDocumentStart.data.aggregateScope = 'document-a';
      oldDocumentStart.data.aggregateRevision = 100;
      getRuntimeMessageListener()(oldDocumentStart);
      expect(pageTranslation.isTranslating.value).toBe(false);
    });

    it('does not apply a status snapshot older than an accepted lifecycle revision', async () => {
      const { pageTranslation } = await createSilentScenario();
      const latest = startEvent(SESSION_ID);
      latest.data.aggregateRevision = 10;
      getRuntimeMessageListener()(latest);
      const progress = {
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data: {
          ...latest.data,
          aggregateRevision: 11,
          translatedCount: 5,
          totalCount: 8,
          isTranslating: true,
        },
      };
      getRuntimeMessageListener()(progress);

      let resolveStatus;
      sendRegularMessage.mockImplementation(({ action }) => action === MessageActions.PAGE_TRANSLATE_GET_STATUS
        ? new Promise(resolve => { resolveStatus = resolve; })
        : Promise.resolve({ success: true }));
      const refresh = pageTranslation.refreshStatus();
      resolveStatus({
        success: true,
        isAggregated: true,
        aggregateScope: 'document-a',
        aggregateRevision: 10,
        isTranslated: false,
        isTranslating: false,
        translatedCount: 0,
        totalCount: 8,
      });
      await refresh;

      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(5);
      expect(pageTranslation.totalNodes.value).toBe(8);
    });

    it('rejects aggregate lifecycle events with invalid scope or revision metadata', async () => {
      const { pageTranslation } = await createSilentScenario();
      const initial = startEvent(SESSION_ID);
      initial.data.aggregateRevision = 1;
      getRuntimeMessageListener()(initial);

      for (const [aggregateScope, aggregateRevision] of [
        ['', 2],
        ['   ', 2],
        ['document-a', -1],
        ['document-a', Number.MAX_SAFE_INTEGER + 1],
        ['document-a', 1.5],
      ]) {
        const invalidIdle = idleEvent(SESSION_ID);
        Object.assign(invalidIdle.data, { aggregateScope, aggregateRevision });
        getRuntimeMessageListener()(invalidIdle);
      }

      expect(pageTranslation.isTranslating.value).toBe(true);
    });

    it('does not seed aggregate ordering from invalid status metadata', async () => {
      const { pageTranslation } = await createSilentScenario();
      sendRegularMessage.mockImplementation(({ action }) => action === MessageActions.PAGE_TRANSLATE_GET_STATUS
        ? Promise.resolve({ success: true, isAggregated: true, aggregateScope: '', aggregateRevision: -1 })
        : Promise.resolve({ success: true }));
      await pageTranslation.refreshStatus();

      const validStart = startEvent(SESSION_ID);
      validStart.data.aggregateRevision = 0;
      getRuntimeMessageListener()(validStart);

      expect(pageTranslation.isTranslating.value).toBe(true);
    });

    it('rejects a buffered aggregate event when its revision is stale at replay', async () => {
      const { pageTranslation } = await createSilentScenario();
      const baselineStart = startEvent(SESSION_ID);
      getRuntimeMessageListener()(baselineStart);
      const baselineIdle = idleEvent(SESSION_ID, { message: 'Settled' });
      getRuntimeMessageListener()(baselineIdle);

      const deferred = createDeferredTranslate();
      const pending = pageTranslation.translatePage();
      await deferred.sentGate;
      const staleStart = startEvent(SESSION_ID);
      staleStart.data.aggregateRevision = baselineStart.data.aggregateRevision;
      getRuntimeMessageListener()(staleStart);
      deferred.resolveTranslate({ success: true, targetTabId: TAB_ID, messageId: SESSION_ID });
      await pending;

      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.message.value).toBe('Settled');
    });

    it('ignores a delayed start for a session that settled silently', async () => {
      const { resolveTranslate, sentGate, pageTranslation } = await createSilentScenario();

      const pending = pageTranslation.translatePage();
      await sentGate;
      resolveTranslate(silentErrorResponse());
      await pending;

      // The START of the settled session arrives after the response and the
      // IDLE never follows.
      getRuntimeMessageListener()(startEvent());

      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isTranslated.value).toBe(false);
      expect(pageTranslation.translatedCount.value).toBe(0);
      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.message.value).toBe('');
    });

    it('applies a late idle with retained content after a silent settlement', async () => {
      const { resolveTranslate, sentGate, pageTranslation } = await createSilentScenario();

      const pending = pageTranslation.translatePage();
      await sentGate;
      resolveTranslate(silentErrorResponse());
      await pending;

      getRuntimeMessageListener()(startEvent());
      expect(pageTranslation.isTranslating.value).toBe(false);

      // The IDLE of the settled session still reports the final state.
      getRuntimeMessageListener()(idleEvent(SESSION_ID, {
        translatedCount: 3,
        totalCount: 3,
        isTranslated: true,
      }));

      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(3);
      expect(pageTranslation.failedCount.value).toBe(0);
      expect(pageTranslation.totalNodes.value).toBe(3);
      expect(pageTranslation.error.value).toBeNull();
    });

    it('accepts a start of a newer session after a silent settlement', async () => {
      const { resolveTranslate, sentGate, pageTranslation } = await createSilentScenario();

      const pending = pageTranslation.translatePage();
      await sentGate;
      resolveTranslate(silentErrorResponse());
      await pending;

      getRuntimeMessageListener()(startEvent(NEXT_SESSION_ID));

      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.message.value).toBe('Starting translation...');
    });

    it('ignores a delayed start for a child frame that settled silently', async () => {
      const { resolveTranslate, sentGate, pageTranslation } = await createSilentScenario();

      const pending = pageTranslation.translatePage();
      await sentGate;
      // The main frame failed before its START was admitted, the child frame
      // settled silently after its START.
      resolveTranslate({
        success: false,
        reason: 'silent_error',
        responses: [
          { success: false, reason: 'silent_error' },
          { success: false, reason: 'silent_error', messageId: CHILD_SESSION_ID },
        ],
        frames: [{ frameId: 0, success: true }, { frameId: 1, success: true }],
        targetTabId: TAB_ID,
      });
      await pending;

      getRuntimeMessageListener()(startEvent(CHILD_SESSION_ID));

      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.message.value).toBe('');
      expect(pageTranslation.error.value).toBeNull();
    });

    it('ignores a delayed start for every frame session that settled silently', async () => {
      const { resolveTranslate, sentGate, pageTranslation } = await createSilentScenario();

      const pending = pageTranslation.translatePage();
      await sentGate;
      resolveTranslate({
        success: false,
        reason: 'silent_error',
        responses: [
          { success: false, reason: 'silent_error', messageId: SESSION_ID },
          { success: false, reason: 'silent_error', messageId: CHILD_SESSION_ID },
        ],
        frames: [{ frameId: 0, success: true }, { frameId: 1, success: true }],
        targetTabId: TAB_ID,
      });
      await pending;

      getRuntimeMessageListener()(startEvent(SESSION_ID));
      expect(pageTranslation.isTranslating.value).toBe(false);

      getRuntimeMessageListener()(startEvent(CHILD_SESSION_ID));
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.message.value).toBe('');
    });

    it('applies a late idle with retained content after a multi-frame silent settlement', async () => {
      const { resolveTranslate, sentGate, pageTranslation } = await createSilentScenario();

      const pending = pageTranslation.translatePage();
      await sentGate;
      resolveTranslate({
        success: false,
        reason: 'silent_error',
        responses: [
          { success: false, reason: 'silent_error' },
          { success: false, reason: 'silent_error', messageId: CHILD_SESSION_ID },
        ],
        frames: [{ frameId: 0, success: true }, { frameId: 1, success: true }],
        targetTabId: TAB_ID,
      });
      await pending;

      getRuntimeMessageListener()(idleEvent(CHILD_SESSION_ID, {
        translatedCount: 2,
        totalCount: 4,
        isTranslated: true,
      }));

      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(2);
      expect(pageTranslation.totalNodes.value).toBe(4);
      expect(pageTranslation.error.value).toBeNull();
    });

    it('accepts a start of a newer session after a multi-frame silent settlement', async () => {
      const { resolveTranslate, sentGate, pageTranslation } = await createSilentScenario();

      const pending = pageTranslation.translatePage();
      await sentGate;
      resolveTranslate({
        success: false,
        reason: 'silent_error',
        responses: [
          { success: false, reason: 'silent_error' },
          { success: false, reason: 'silent_error', messageId: CHILD_SESSION_ID },
        ],
        frames: [{ frameId: 0, success: true }, { frameId: 1, success: true }],
        targetTabId: TAB_ID,
      });
      await pending;

      getRuntimeMessageListener()(startEvent(NEXT_SESSION_ID));

      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.message.value).toBe('Starting translation...');
    });
  });

  describe('Aggregated multi-frame lifecycle ownership', () => {
    let aggregateRevision;

    function emitAggregate(action, sessionId, state = {}) {
      getRuntimeMessageListener()({
        action,
        data: {
          isAggregated: true,
          aggregateScope: 'document-a',
          aggregateRevision: ++aggregateRevision,
          tabId: 1,
          sessionId,
          ...state,
        },
      });
    }

    beforeEach(() => {
      aggregateRevision = 0;
      browser.tabs.query.mockResolvedValue([{ id: 1 }]);
    });

    it('applies page-wide state from a direct aggregate START', async () => {
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });

      emitAggregate(MessageActions.PAGE_TRANSLATE_START, 'command-session', {
        isTranslated: true,
        isAutoTranslating: true,
        translatedCount: 3,
        failedCount: 1,
        totalCount: 7,
      });

      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(3);
      expect(pageTranslation.failedCount.value).toBe(1);
      expect(pageTranslation.totalNodes.value).toBe(7);
    });

    it('applies page-wide state from an aggregate START buffered before the response', async () => {
      const { resolveTranslate, sentGate } = createDeferredTranslate();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      const pending = pageTranslation.translatePage();
      await sentGate;
      emitAggregate(MessageActions.PAGE_TRANSLATE_START, 'frame-other-tab', {
        tabId: 2,
        translatedCount: 99,
        totalCount: 99,
      });
      emitAggregate(MessageActions.PAGE_TRANSLATE_START, 'frame-b-session', {
        isTranslated: true,
        isAutoTranslating: true,
        translatedCount: 3,
        failedCount: 1,
        totalCount: 7,
      });
      resolveTranslate({ success: true, targetTabId: 1, messageId: 'command-session' });
      await pending;

      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(3);
      expect(pageTranslation.failedCount.value).toBe(1);
      expect(pageTranslation.totalNodes.value).toBe(7);
    });

    it('continues resetting page state for a non-aggregated START', async () => {
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      emitAggregate(MessageActions.PAGE_TRANSLATE_PROGRESS, 'frame-a', {
        isTranslating: false,
        translatedCount: 3,
        failedCount: 1,
        totalCount: 7,
      });

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { tabId: 1, sessionId: 'non-aggregate-session' },
      });

      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.isTranslated.value).toBe(false);
      expect(pageTranslation.translatedCount.value).toBe(0);
      expect(pageTranslation.failedCount.value).toBe(0);
      expect(pageTranslation.totalNodes.value).toBe(0);
    });

    it('keeps request and cancellation ownership through frame completion until page settlement', async () => {
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      const pending = pageTranslation.translatePage();
      await pending;

      emitAggregate(MessageActions.PAGE_TRANSLATE_COMPLETE, 'frame-a', {
        isTranslating: true,
        isAutoTranslating: true,
        isTranslated: true,
        translatedCount: 4,
        failedCount: 1,
        totalCount: 9,
      });
      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
      expect(pageTranslation.canCancel.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(4);
      expect(pageTranslation.failedCount.value).toBe(1);
      expect(pageTranslation.totalNodes.value).toBe(9);
      expect(pageTranslation.isTranslated.value).toBe(true);

      emitAggregate(MessageActions.PAGE_TRANSLATE_PROGRESS, 'frame-b', {
        status: 'translating',
        isTranslating: true,
        isAutoTranslating: true,
        translatedCount: 6,
        failedCount: 1,
        totalCount: 9,
      });
      expect(pageTranslation.translatedCount.value).toBe(6);
      expect(pageTranslation.canCancel.value).toBe(true);

      pageTranslation.cancelTranslation();
      expect(sendRegularMessage).toHaveBeenCalledWith(expect.objectContaining({
        action: MessageActions.PAGE_TRANSLATE,
        data: { cancel: true },
      }));

      emitAggregate(MessageActions.PAGE_TRANSLATE_COMPLETE, 'frame-b', {
        isTranslating: false,
        isAutoTranslating: false,
        isTranslated: true,
        translatedCount: 8,
        failedCount: 1,
        totalCount: 9,
      });
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(false);
      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(8);
      expect(pageTranslation.failedCount.value).toBe(1);
    });

    it('keeps a fatal frame error visible without ending another active frame', async () => {
      const pageTranslation = await createPageTranslation();
      const presentation = deferPresentation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      await pageTranslation.translatePage();

      emitAggregate(MessageActions.PAGE_TRANSLATE_ERROR, 'frame-a', {
        ...errorEvent,
        isFatal: true,
        isTranslating: true,
        isAutoTranslating: true,
        isTranslated: true,
        translatedCount: 3,
        failedCount: 2,
        totalCount: 8,
      });
      await presentation.called;
      presentation.resolve(new Error('frame failed'));
      await Promise.resolve();

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
      expect(pageTranslation.canCancel.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(3);
      expect(pageTranslation.failedCount.value).toBe(2);
      expect(pageTranslation.totalNodes.value).toBe(8);

      emitAggregate(MessageActions.PAGE_TRANSLATE_PROGRESS, 'frame-b', {
        isTranslating: true,
        translatedCount: 4,
        failedCount: 2,
        totalCount: 8,
      });
      expect(pageTranslation.translatedCount.value).toBe(4);
    });

    it('keeps auto request ownership after a fatal frame error while another frame remains in Auto mode', async () => {
      const pageTranslation = await createPageTranslation();
      const presentation = deferPresentation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      await pageTranslation.translatePage();

      emitAggregate(MessageActions.PAGE_TRANSLATE_ERROR, 'frame-a', {
        ...errorEvent,
        isFatal: true,
        isTranslating: false,
        isAutoTranslating: true,
        isTranslated: true,
        translatedCount: 2,
        failedCount: 1,
        totalCount: 6,
      });
      await presentation.called;
      presentation.resolve(new Error('frame failed'));
      await Promise.resolve();

      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
      expect(pageTranslation.canStopAuto.value).toBe(true);

      emitAggregate(MessageActions.PAGE_AUTO_RESTORE_COMPLETE, 'frame-a', {
        isTranslating: false,
        isAutoTranslating: true,
        isTranslated: true,
        translatedCount: 2,
        failedCount: 1,
        totalCount: 6,
      });
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
      expect(pageTranslation.canStopAuto.value).toBe(true);

      emitAggregate(MessageActions.PAGE_TRANSLATE_PROGRESS, 'frame-b', {
        isTranslating: false,
        isAutoTranslating: true,
        translatedCount: 3,
        failedCount: 1,
        totalCount: 6,
      });
      expect(pageTranslation.translatedCount.value).toBe(3);
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(true);

      emitAggregate(MessageActions.PAGE_TRANSLATE_COMPLETE, 'frame-b', {
        isTranslating: false,
        isAutoTranslating: false,
        isTranslated: true,
        translatedCount: 5,
        failedCount: 1,
        totalCount: 6,
      });
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(false);
      expect(pageTranslation.translatedCount.value).toBe(5);
    });

    it('accepts a fatal error after its marked auto-restore while another frame remains active', async () => {
      const pageTranslation = await createPageTranslation();
      const presentation = deferPresentation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      await pageTranslation.translatePage();

      emitAggregate(MessageActions.PAGE_AUTO_RESTORE_COMPLETE, 'frame-a', {
        fatalErrorAutoRestore: true,
        isTranslating: false,
        isAutoTranslating: true,
        isTranslated: true,
        translatedCount: 2,
        failedCount: 1,
        totalCount: 6,
      });
      expect(pageTranslation.message.value).not.toBe('Auto-translation stopped');

      emitAggregate(MessageActions.PAGE_TRANSLATE_ERROR, 'frame-a', {
        ...errorEvent,
        isFatal: true,
        isTranslating: false,
        isAutoTranslating: true,
        isTranslated: true,
        translatedCount: 2,
        failedCount: 2,
        totalCount: 6,
      });
      await presentation.called;
      presentation.resolve(new Error('fatal frame failure'));
      await Promise.resolve();

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toBe('Error: fatal frame failure');
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
      emitAggregate(MessageActions.PAGE_TRANSLATE_PROGRESS, 'frame-b', {
        isTranslating: false,
        isAutoTranslating: true,
        translatedCount: 3,
        failedCount: 2,
        totalCount: 6,
      });
      expect(pageTranslation.translatedCount.value).toBe(3);
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
    });

    it('accepts a fatal error after its marked terminal auto-restore', async () => {
      const pageTranslation = await createPageTranslation();
      const presentation = deferPresentation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      await pageTranslation.translatePage();

      emitAggregate(MessageActions.PAGE_AUTO_RESTORE_COMPLETE, 'frame-a', {
        fatalErrorAutoRestore: true,
        isTranslating: false,
        isAutoTranslating: false,
        isTranslated: true,
        translatedCount: 2,
        failedCount: 1,
        totalCount: 6,
      });
      emitAggregate(MessageActions.PAGE_TRANSLATE_ERROR, 'frame-a', {
        ...errorEvent,
        isFatal: true,
        isTranslating: false,
        isAutoTranslating: false,
        isTranslated: true,
        translatedCount: 2,
        failedCount: 2,
        totalCount: 6,
      });

      await presentation.called;
      presentation.resolve(new Error('terminal fatal failure'));
      await Promise.resolve();
      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toBe('Error: terminal fatal failure');
      expect(pageTranslation.canCancel.value).toBe(false);
    });

    it('does not let a reverse-delivered fatal auto-restore erase the error presentation', async () => {
      const pageTranslation = await createPageTranslation();
      const presentation = deferPresentation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      await pageTranslation.translatePage();

      emitAggregate(MessageActions.PAGE_TRANSLATE_ERROR, 'frame-a', {
        ...errorEvent,
        isFatal: true,
        isTranslating: false,
        isAutoTranslating: true,
      });
      await presentation.called;
      emitAggregate(MessageActions.PAGE_AUTO_RESTORE_COMPLETE, 'frame-a', {
        fatalErrorAutoRestore: true,
        isTranslating: false,
        isAutoTranslating: true,
      });
      presentation.resolve(new Error('reverse fatal failure'));
      await Promise.resolve();

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.message.value).toBe('Error: reverse fatal failure');
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
    });

    it('preserves Auto ownership after a frame completes while another frame remains in Auto mode', async () => {
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      await pageTranslation.translatePage();

      emitAggregate(MessageActions.PAGE_TRANSLATE_COMPLETE, 'frame-a', {
        isTranslating: false,
        isAutoTranslating: true,
        isTranslated: true,
        translatedCount: 2,
        failedCount: 1,
        totalCount: 6,
      });
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
      expect(pageTranslation.canStopAuto.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(2);

      emitAggregate(MessageActions.PAGE_TRANSLATE_PROGRESS, 'frame-b', {
        isTranslating: false,
        isAutoTranslating: true,
        translatedCount: 4,
        failedCount: 1,
        totalCount: 6,
      });
      expect(pageTranslation.translatedCount.value).toBe(4);
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(true);

      emitAggregate(MessageActions.PAGE_TRANSLATE_COMPLETE, 'frame-b', {
        isTranslating: false,
        isAutoTranslating: false,
        isTranslated: true,
        translatedCount: 5,
        failedCount: 1,
        totalCount: 6,
      });
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(false);
      expect(pageTranslation.canStopAuto.value).toBe(false);
      expect(pageTranslation.translatedCount.value).toBe(5);
    });

    it('preserves Auto ownership and aggregate state when one frame stops Auto', async () => {
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      await pageTranslation.translatePage();

      emitAggregate(MessageActions.PAGE_AUTO_RESTORE_COMPLETE, 'frame-a', {
        isTranslating: false,
        isAutoTranslating: true,
        isTranslated: true,
        translatedCount: 3,
        failedCount: 1,
        totalCount: 7,
      });
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(3);
      expect(pageTranslation.failedCount.value).toBe(1);
      expect(pageTranslation.totalNodes.value).toBe(7);
      expect(pageTranslation.canStopAuto.value).toBe(true);
      expect(pageTranslation.message.value).not.toBe('Auto-translation stopped');

      emitAggregate(MessageActions.PAGE_TRANSLATE_PROGRESS, 'frame-b', {
        isTranslating: false,
        isAutoTranslating: true,
        translatedCount: 4,
        failedCount: 1,
        totalCount: 7,
      });
      expect(pageTranslation.translatedCount.value).toBe(4);
      expect(pageTranslation.canStopAuto.value).toBe(true);
    });

    it('preserves translation ownership when one frame stops while another is translating', async () => {
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      await pageTranslation.translatePage();

      emitAggregate(MessageActions.PAGE_AUTO_RESTORE_COMPLETE, 'frame-a', {
        isTranslating: true,
        isAutoTranslating: false,
        isTranslated: true,
        translatedCount: 2,
        failedCount: 1,
        totalCount: 6,
      });

      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.isAutoTranslating.value).toBe(false);
      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.canCancel.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(2);

      emitAggregate(MessageActions.PAGE_TRANSLATE_PROGRESS, 'frame-b', {
        isTranslating: true,
        isAutoTranslating: false,
        translatedCount: 3,
        totalCount: 6,
      });
      expect(pageTranslation.translatedCount.value).toBe(3);
      expect(pageTranslation.canCancel.value).toBe(true);
    });

    it('settles ownership when the aggregate reports that both Auto and translation stopped', async () => {
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      await pageTranslation.translatePage();

      emitAggregate(MessageActions.PAGE_AUTO_RESTORE_COMPLETE, 'frame-a', {
        isTranslating: false,
        isAutoTranslating: false,
        isTranslated: true,
        translatedCount: 5,
        failedCount: 1,
        totalCount: 6,
      });

      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(false);
      expect(pageTranslation.canCancel.value).toBe(false);
      expect(pageTranslation.canStopAuto.value).toBe(false);
      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(5);
      expect(pageTranslation.failedCount.value).toBe(1);
      expect(pageTranslation.totalNodes.value).toBe(6);
    });

    it('keeps non-aggregated Auto restore completion behavior', async () => {
      const pageTranslation = await createPageTranslation();
      pageTranslation.isTranslating.value = true;
      pageTranslation.isAutoTranslating.value = true;

      getRuntimeMessageListener()({
        action: MessageActions.PAGE_AUTO_RESTORE_COMPLETE,
        data: { tabId: 1, sessionId: 'single-frame', isTranslating: true, isAutoTranslating: true },
      });

      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(false);
    });

    it('does not suppress a nonfatal frame session that continues with progress and completion', async () => {
      const pageTranslation = await createPageTranslation();
      const presentation = deferPresentation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      await pageTranslation.translatePage();

      emitAggregate(MessageActions.PAGE_TRANSLATE_ERROR, 'frame-a', {
        ...errorEvent,
        isFatal: false,
        isTranslating: false,
        isAutoTranslating: true,
        isTranslated: true,
        translatedCount: 1,
        failedCount: 1,
        totalCount: 5,
      });
      await presentation.called;
      presentation.resolve(new Error('nonfatal frame error'));
      await Promise.resolve();
      emitAggregate(MessageActions.PAGE_TRANSLATE_PROGRESS, 'frame-a', {
        isTranslating: false,
        isAutoTranslating: true,
        translatedCount: 2,
        failedCount: 1,
        totalCount: 5,
      });

      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
      expect(pageTranslation.canStopAuto.value).toBe(true);
      expect(pageTranslation.isTranslated.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(2);
      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      emitAggregate(MessageActions.PAGE_TRANSLATE_COMPLETE, 'frame-b', {
        isTranslating: false,
        isAutoTranslating: false,
        isTranslated: true,
        translatedCount: 4,
        failedCount: 1,
        totalCount: 5,
      });
      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(false);
    });

    it('fences deferred aggregate error presentation behind newer progress', async () => {
      const pageTranslation = await createPageTranslation();
      const presentation = deferPresentation();
      emitAggregate(MessageActions.PAGE_TRANSLATE_ERROR, 'frame-a', {
        ...errorEvent,
        isFatal: false,
        isTranslating: true,
        isAutoTranslating: true,
        translatedCount: 1,
        totalCount: 5,
      });
      await presentation.called;
      emitAggregate(MessageActions.PAGE_TRANSLATE_PROGRESS, 'frame-b', {
        isTranslating: true,
        isAutoTranslating: true,
        translatedCount: 2,
        totalCount: 5,
      });
      presentation.resolve(new Error('stale aggregate error'));
      await Promise.resolve();
      await Promise.resolve();

      expect(pageTranslation.error.value).toBeNull();
      expect(pageTranslation.translatedCount.value).toBe(2);
      expect(pageTranslation.isTranslating.value).toBe(true);
    });

    it('replays an active frame completion buffered before the command response', async () => {
      const { resolveTranslate, sentGate } = createDeferredTranslate();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      const pending = pageTranslation.translatePage();
      await sentGate;
      emitAggregate(MessageActions.PAGE_TRANSLATE_COMPLETE, 'frame-a', {
        isTranslating: true,
        isAutoTranslating: true,
        isTranslated: true,
        translatedCount: 2,
        failedCount: 1,
        totalCount: 5,
      });
      resolveTranslate({ success: true, targetTabId: 1, messageId: 'command-session' });
      await pending;

      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
      expect(pageTranslation.canCancel.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(2);
      emitAggregate(MessageActions.PAGE_TRANSLATE_PROGRESS, 'frame-b', {
        isTranslating: true,
        isAutoTranslating: true,
        translatedCount: 3,
        totalCount: 5,
      });
      expect(pageTranslation.translatedCount.value).toBe(3);
    });

    it('replays an active frame error buffered before the command response without settling ownership', async () => {
      const presentation = deferPresentation();
      const { resolveTranslate, sentGate } = createDeferredTranslate();
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      const pending = pageTranslation.translatePage();
      await sentGate;
      emitAggregate(MessageActions.PAGE_TRANSLATE_ERROR, 'frame-a', {
        ...errorEvent,
        isFatal: false,
        isTranslating: true,
        isAutoTranslating: true,
        translatedCount: 2,
        failedCount: 1,
        totalCount: 5,
      });
      resolveTranslate({ success: true, targetTabId: 1, messageId: 'command-session' });
      await pending;
      await presentation.called;
      presentation.resolve(new Error('frame continuation'));
      await Promise.resolve();

      expect(pageTranslation.error.value).toBeInstanceOf(Error);
      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.isAutoTranslating.value).toBe(true);
      expect(pageTranslation.canCancel.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(2);
    });

    it('clears request ownership only on the page-wide terminal aggregate event', async () => {
      const pageTranslation = await createPageTranslation();
      browser.tabs.onActivated.addListener.mock.calls.at(-1)[0]({ tabId: 1, windowId: 10 });
      await pageTranslation.translatePage();
      emitAggregate(MessageActions.PAGE_TRANSLATE_COMPLETE, 'frame-a', {
        isTranslating: true,
        isAutoTranslating: true,
        translatedCount: 2,
        totalCount: 5,
      });
      emitAggregate(MessageActions.PAGE_TRANSLATE_COMPLETE, 'frame-b', {
        isTranslating: false,
        isAutoTranslating: false,
        isTranslated: true,
        translatedCount: 5,
        totalCount: 5,
      });

      expect(pageTranslation.isTranslating.value).toBe(false);
      expect(pageTranslation.isAutoTranslating.value).toBe(false);
      expect(pageTranslation.translatedCount.value).toBe(5);
      // Once the global request is settled, unrelated passive events are still
      // correlated by the displayed tab rather than stale command ownership.
      emitAggregate(MessageActions.PAGE_TRANSLATE_PROGRESS, 'frame-c', {
        isTranslating: true,
        translatedCount: 1,
        totalCount: 3,
      });
      expect(pageTranslation.isTranslating.value).toBe(true);
      expect(pageTranslation.translatedCount.value).toBe(1);
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
