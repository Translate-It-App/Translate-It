import { beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { ActionReasons } from '@/shared/messaging/core/MessagingConstants.js';
import { tabPermissionChecker } from '@/core/tabPermissions.js';
import { handlePageTranslation } from './handlePageTranslation.js';
import { PageNavigationTracker, pageNavigationTracker } from '@/core/background/PageNavigationTracker.js';
import { unifiedTranslationService } from '@/core/services/translation/UnifiedTranslationService.js';

const navigationStore = vi.hoisted(() => ({ saved: {} }));

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: { session: {
      get: vi.fn(async () => structuredClone(navigationStore.saved)),
      set: vi.fn(async value => { navigationStore.saved = structuredClone(value); }),
    } },
    runtime: {
      sendMessage: vi.fn(),
    },
    tabs: {
      query: vi.fn(),
      sendMessage: vi.fn(),
      onRemoved: { addListener: vi.fn() },
    },
    webNavigation: {
      getAllFrames: vi.fn(),
      getFrame: vi.fn(),
      onCommitted: { addListener: vi.fn() },
    },
  },
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('@/core/extensionContext.js', () => ({
  default: {
    isContextError: vi.fn(() => false),
    handleContextError: vi.fn(),
  },
}));

vi.mock('@/core/services/translation/UnifiedTranslationService.js', () => ({
  unifiedTranslationService: {
    handleTranslationRequest: vi.fn(),
    clearPageSourceSession: vi.fn(),
  },
}));

vi.mock('@/features/translation/core/TranslationStatsManager.js', () => ({
  statsManager: {
    printSummary: vi.fn(),
    clearSession: vi.fn(),
  },
}));

vi.mock('@/core/tabPermissions.js', () => ({
  tabPermissionChecker: {
    checkTabAccess: vi.fn(),
  },
}));

const sender = { tab: { id: 42 } };
const PRE_FANOUT_TIMEOUT_MS = 1500;
const PRE_FANOUT_TIMEOUT_REASON = 'pre_fanout_command_timeout';
const onCommittedListener = browser.webNavigation.onCommitted.addListener.mock.calls[0][0];

function setupFrames(frameResults, { activeTabId = 42 } = {}) {
  browser.tabs.query.mockResolvedValue([{ id: activeTabId }]);
  tabPermissionChecker.checkTabAccess.mockResolvedValue({
    isAccessible: true,
  });
  browser.webNavigation.getAllFrames.mockResolvedValue(
    frameResults.map(({ frameId }) => ({
      frameId,
      url: frameId === 0 ? 'https://example.com' : `https://frame-${frameId}.example`,
    }))
  );
  browser.webNavigation.getFrame.mockImplementation(async ({ frameId }) => ({
    url: frameId === 0 ? 'https://example.com' : `https://frame-${frameId}.example`,
  }));
  browser.tabs.sendMessage.mockImplementation((_tabId, _message, { frameId }) => {
    const frame = frameResults.find(candidate => candidate.frameId === frameId);
    if (frame?.error) return Promise.reject(frame.error);
    return Promise.resolve(frame?.response);
  });
}

async function expectPreFanoutTimeout(resultPromise) {
  await vi.advanceTimersByTimeAsync(PRE_FANOUT_TIMEOUT_MS);
  await expect(resultPromise).resolves.toEqual({
    success: false,
    reason: PRE_FANOUT_TIMEOUT_REASON,
    isTransportFailure: true,
  });
  expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
}

beforeEach(() => {
  navigationStore.saved = {};
  pageNavigationTracker.state = null;
  pageNavigationTracker.durableState = null;
  pageNavigationTracker.dirty = false;
  pageNavigationTracker.pending = Promise.resolve();
  pageNavigationTracker.restartFences.clear();
  pageNavigationTracker.blockedManualContinuity.clear();
  pageNavigationTracker.manualContinuityRevision.clear();
});

describe('PAGE_TRANSLATE producer cursor admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigationStore.saved = {};
    pageNavigationTracker.state = null;
    pageNavigationTracker.restartFences.clear();
    pageNavigationTracker.dirty = false;
    pageNavigationTracker.pending = Promise.resolve();
    browser.storage.session.set.mockImplementation(async value => { navigationStore.saved = structuredClone(value); });
  });

  it('seeds participating frames and attaches a distinct current document cursor to each command', async () => {
    setupFrames([{ frameId: 0, response: { success: true } }, { frameId: 7, response: { success: true } }]);
    await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: { isAuto: true } }, sender);
    const commands = browser.tabs.sendMessage.mock.calls;
    expect(commands[0][1].data).toMatchObject({ isAuto: true, navigationCursor: { routeRevision: 0, url: 'https://example.com' } });
    expect(commands[1][1].data.navigationCursor.url).toBe('https://frame-7.example');
    expect(commands[1][1].data.navigationCursor.documentEpoch).toBeGreaterThan(commands[0][1].data.navigationCursor.documentEpoch);
    expect(browser.storage.session.set.mock.invocationCallOrder[0]).toBeLessThan(browser.tabs.sendMessage.mock.invocationCallOrder[0]);
  });

  it('requires the live top cursor and current fence for bound navigation fan-out', async () => {
    setupFrames([{ frameId: 0, response: { success: true } }, { frameId: 7, response: { success: true } }]);
    await pageNavigationTracker.seed(42, [
      { frameId: 0, url: 'https://example.com' },
      { frameId: 7, url: 'https://frame-7.example' },
    ]);
    const topCursor = await pageNavigationTracker.getCursor(42, 0);
    const restartFence = pageNavigationTracker.mintRestartFence(42);
    await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE,
      data: { isAuto: true, preserveAcceptedTranslations: true, navigationCursor: topCursor, restartFence },
    }, sender);
    expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(browser.tabs.sendMessage.mock.calls[0][1].data).toMatchObject({
      navigationCursor: topCursor, topNavigationCursor: topCursor, restartFence,
    });
    expect(browser.tabs.sendMessage.mock.calls[1][1].data.navigationCursor.url).toBe('https://frame-7.example');

    browser.tabs.sendMessage.mockClear();
    const staleFence = restartFence;
    pageNavigationTracker.revokeRestartFence(42);
    const rejected = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE,
      data: { isAuto: true, preserveAcceptedTranslations: true, navigationCursor: topCursor, restartFence: staleFence },
    }, sender);
    expect(rejected).toMatchObject({ success: false, reason: 'obsolete_navigation' });
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects a bound restart when top identity changes during frame preparation', async () => {
    setupFrames([{ frameId: 0, response: { success: true } }]);
    await pageNavigationTracker.seed(42, [{ frameId: 0, url: 'https://example.com' }]);
    const navigationCursor = await pageNavigationTracker.getCursor(42, 0);
    const restartFence = pageNavigationTracker.mintRestartFence(42);
    browser.webNavigation.getAllFrames.mockImplementationOnce(async () => {
      await pageNavigationTracker.capture(42, 0, 'https://example.com/new-route');
      return [{ frameId: 0, url: 'https://example.com/new-route' }];
    });

    const result = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE,
      data: { isAuto: true, navigationCursor, restartFence },
    }, sender);

    expect(result).toMatchObject({ success: false, reason: 'obsolete_navigation' });
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('revalidates the trusted top and actual sender-frame cursors before Page START', async () => {
    setupFrames([{ frameId: 0, response: { success: true } }, { frameId: 7, response: { success: true } }]);
    await pageNavigationTracker.seed(42, [
      { frameId: 0, url: 'https://example.com' },
      { frameId: 7, url: 'https://frame-7.example' },
    ]);
    const topNavigationCursor = await pageNavigationTracker.getCursor(42, 0);
    const navigationCursor = await pageNavigationTracker.getCursor(42, 7);
    const restartFence = pageNavigationTracker.mintRestartFence(42);
    const admission = {
      action: MessageActions.PAGE_TRANSLATE_ADMIT,
      data: { topNavigationCursor, navigationCursor, restartFence },
    };

    await expect(handlePageTranslation(admission, { ...sender, frameId: 7 })).resolves.toEqual({ success: true });
    await pageNavigationTracker.capture(42, 0, 'https://example.com/another-route');
    await expect(handlePageTranslation(admission, { ...sender, frameId: 7 })).resolves.toEqual({
      success: false, reason: 'obsolete_navigation',
    });
  });

  it.each([null, '', 'unknown-fence'])(
    'rejects Page START admission with missing or unknown fence %o', async restartFence => {
      setupFrames([{ frameId: 0, response: { success: true } }]);
      await pageNavigationTracker.seed(42, [{ frameId: 0, url: 'https://example.com' }]);
      const cursor = await pageNavigationTracker.getCursor(42, 0);
      const validFence = pageNavigationTracker.mintRestartFence(42);
      const result = await handlePageTranslation({
        action: MessageActions.PAGE_TRANSLATE_ADMIT,
        data: { topNavigationCursor: cursor, navigationCursor: cursor, restartFence },
      }, { ...sender, frameId: 0 });

      expect(validFence).not.toBe(restartFence);
      expect(result).toEqual({ success: false, reason: 'obsolete_navigation' });
    }
  );

  it('revokes the restart fence for the explicit Cancel payload form', async () => {
    const previous = pageNavigationTracker.mintRestartFence(42);
    await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE,
      data: { cancel: true },
    }, sender);

    expect(pageNavigationTracker.getRestartFence(42)).not.toBe(previous);
  });

  it('revokes queued navigation restarts when a manual start is dispatched', async () => {
    setupFrames([{ frameId: 0, response: { success: true } }]);
    await pageNavigationTracker.seed(42, [{ frameId: 0, url: 'https://example.com' }]);
    const navigationCursor = await pageNavigationTracker.getCursor(42, 0);
    const restartFence = pageNavigationTracker.mintRestartFence(42);

    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE,
      data: {},
    }, sender)).resolves.toMatchObject({ success: true });

    browser.tabs.sendMessage.mockClear();
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE,
      data: {
        isAuto: true,
        preserveAcceptedTranslations: true,
        navigationCursor,
        restartFence,
      },
    }, sender)).resolves.toMatchObject({ success: false, reason: 'obsolete_navigation' });
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['history', 'commit'])('refreshes first enrollment after an untracked %s races a stale discovery snapshot', async event => {
    setupFrames([{ frameId: 0, response: { success: true } }]);
    browser.webNavigation.getAllFrames.mockImplementationOnce(async () => {
      if (event === 'history') await pageNavigationTracker.capture(42, 0, 'https://example.com/new');
      else await pageNavigationTracker.committed(42, 0, 'https://example.com/new');
      return [{ frameId: 0, url: 'https://example.com' }];
    });
    browser.webNavigation.getFrame.mockResolvedValue({ url: 'https://example.com/new' });
    await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
    expect(browser.tabs.sendMessage.mock.calls[0][1].data.navigationCursor.url).toBe('https://example.com/new');
    expect(browser.webNavigation.getFrame).toHaveBeenCalledWith({ tabId: 42, frameId: 0 });
  });

  it('does not overwrite native evidence with an older getAllFrames snapshot', async () => {
    setupFrames([{ frameId: 0, response: { success: true } }]);
    await pageNavigationTracker.seed(42, [{ frameId: 0, url: 'https://example.com' }]);
    browser.webNavigation.getAllFrames.mockImplementationOnce(async () => {
      await pageNavigationTracker.capture(42, 0, 'https://example.com/new');
      return [{ frameId: 0, url: 'https://example.com' }];
    });
    browser.webNavigation.getFrame.mockResolvedValue({ url: 'https://example.com/new' });
    await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
    expect(browser.tabs.sendMessage.mock.calls[0][1].data.navigationCursor).toMatchObject({ routeRevision: 1, url: 'https://example.com/new' });
  });

  it('reads the current cursor at frame dispatch after a route changes during preparation', async () => {
    setupFrames([{ frameId: 0, response: { success: true } }]);
    const getCursor = pageNavigationTracker.getCursor.bind(pageNavigationTracker);
    const spy = vi.spyOn(pageNavigationTracker, 'getCursor').mockImplementationOnce(async (tabId, frameId) => {
      await pageNavigationTracker.capture(tabId, frameId, 'https://example.com/later');
      return getCursor(tabId, frameId);
    });
    browser.webNavigation.getFrame.mockResolvedValue({ url: 'https://example.com/later' });
    try {
      await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
      expect(browser.tabs.sendMessage.mock.calls[0][1].data.navigationCursor).toMatchObject({ routeRevision: 1, url: 'https://example.com/later' });
    } finally { spy.mockRestore(); }
  });

  it('sends unavailable admission rather than an undurable cursor after persistence failure', async () => {
    setupFrames([{ frameId: 0, response: { success: false, reason: ActionReasons.SILENT_ERROR } }]);
    browser.storage.session.set.mockRejectedValueOnce(new Error('session unavailable'));
    await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
    expect(browser.tabs.sendMessage.mock.calls[0][1].data).toEqual({ navigationUnavailable: true });
  });

  it('keeps active child navigation tracking when later Page frame discovery fails', async () => {
    setupFrames([{ frameId: 0, response: { success: true } }, { frameId: 7, response: { success: true } }]);
    await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
    const initial = structuredClone(navigationStore.saved);
    const child = await pageNavigationTracker.getCursor(42, 7);
    browser.storage.session.set.mockClear();
    browser.tabs.sendMessage.mockClear();
    browser.webNavigation.getAllFrames.mockRejectedValueOnce(new Error('discovery unavailable'));
    browser.tabs.sendMessage.mockResolvedValueOnce({ success: false, reason: ActionReasons.SILENT_ERROR });

    await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);

    expect(browser.tabs.sendMessage).toHaveBeenCalledOnce();
    expect(browser.tabs.sendMessage.mock.calls[0][1].data).toEqual({ navigationUnavailable: true });
    expect(browser.tabs.sendMessage.mock.calls[0][2]).toEqual({ frameId: 0 });
    expect(await pageNavigationTracker.getCursor(42, 7)).toEqual(child);
    expect(navigationStore.saved).toEqual(initial);
    expect(browser.storage.session.set).not.toHaveBeenCalled();
    expect(await pageNavigationTracker.capture(42, 7, 'https://frame-7.example/b')).toMatchObject({ documentEpoch: child.documentEpoch, routeRevision: 1 });
    expect(await pageNavigationTracker.capture(42, 7, child.url)).toEqual({ ...child, routeRevision: 2 });

    browser.webNavigation.getAllFrames.mockResolvedValueOnce([{ frameId: 0, url: 'https://example.com' }]);
    await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
    expect(await pageNavigationTracker.getCursor(42, 7)).toBeNull();
  });

  it.each([null, { url: '' }, 'rejected'])(
    'sends unavailable admission without a stale baseline when the frame API returns %o', async frame => {
      setupFrames([{ frameId: 0, response: { success: false, reason: ActionReasons.SILENT_ERROR } }]);
      if (frame === 'rejected') browser.webNavigation.getFrame.mockRejectedValueOnce(new Error('frame unavailable'));
      else browser.webNavigation.getFrame.mockResolvedValueOnce(frame);
      await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
      expect(browser.tabs.sendMessage.mock.calls[0][1].data).toMatchObject({ navigationUnavailable: true });
    }
  );

  it.each(['transport failure', 'user decline'])('keeps committed-document cursor on the existing persistence retry for %s', async failure => {
    vi.useFakeTimers();
    try {
      setupFrames([{ frameId: 0, response: { success: true } }]);
      await pageNavigationTracker.seed(42, [{ frameId: 0, url: 'https://example.com' }]);
      await handlePageTranslation({
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data: { isAutoTranslating: true, translatedCount: 1 },
      }, sender);
      await pageNavigationTracker.committed(42, 0, 'https://example.com');
      browser.tabs.sendMessage.mockClear();
      if (failure === 'transport failure') browser.tabs.sendMessage.mockRejectedValueOnce(new Error('Content script unavailable'));
      else browser.tabs.sendMessage.mockResolvedValueOnce({ success: false, reason: ActionReasons.USER_CANCELLED });
      onCommittedListener({ tabId: 42, frameId: 0, transitionType: 'link', url: 'https://example.com' });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(failure === 'transport failure' ? 2 : 1);
      expect(browser.tabs.sendMessage.mock.calls.every(([, message]) => message.data.navigationCursor.documentEpoch === 2)).toBe(true);
      await onCommittedListener({ tabId: 42, frameId: 0, transitionType: 'reload' });
    } finally { vi.useRealTimers(); }
  });
});

describe('manual SPA continuity grant and revocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function startManualPage() {
    setupFrames([
      { frameId: 0, response: { success: true } },
      { frameId: 7, response: { success: true } },
    ]);
    const result = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
    expect(result.success).toBe(true);
    return pageNavigationTracker.getManualContinuity(42);
  }

  it('keeps an existing grant when a duplicate manual Start is rejected as busy after child reload', async () => {
    const grant = await startManualPage();
    await pageNavigationTracker.committed(42, 7, 'https://frame-7.example/reloaded');
    setupFrames([
      { frameId: 0, response: { success: false, reason: ActionReasons.BUSY_OR_DONE } },
      { frameId: 7, response: { success: false, reason: ActionReasons.BUSY_OR_DONE } },
    ]);

    const result = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);

    expect(result).toMatchObject({ success: false, reason: ActionReasons.BUSY_OR_DONE });
    expect(await pageNavigationTracker.getManualContinuity(42)).toEqual(grant);
    const cursor = await pageNavigationTracker.getCursor(42, 0);
    expect(await pageNavigationTracker.validateManualContinuityBatch(
      42, 0, grant.generation, grant.topDocumentEpoch, cursor
    )).toBe(true);
    const changedChild = await pageNavigationTracker.getCursor(42, 7);
    expect(await pageNavigationTracker.validateManualContinuityBatch(
      42, 7, grant.generation, grant.topDocumentEpoch, changedChild
    )).toBe(false);
  });

  it('authorizes Stop only through its durable cutoff generation', async () => {
    const oldGrant = await startManualPage();
    const revoke = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_STOP_AUTO,
    }, sender);
    expect(revoke.manualContinuityGeneration).toBe(oldGrant.generation + 1);
    const newGrant = await pageNavigationTracker.grantManualContinuity(42);

    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_ADMIT,
      data: { origin: 'manual-stop', manualContinuityGeneration: oldGrant.generation },
    }, { ...sender, frameId: 0 })).resolves.toEqual({ success: true, authorized: false });
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_ADMIT,
      data: { origin: 'manual-stop', manualContinuityGeneration: newGrant.generation },
    }, { ...sender, frameId: 0 })).resolves.toEqual({ success: true, authorized: true });
  });

  it('blocks a new manual SPA admission immediately when Stop is received, before frame delivery', async () => {
    const grant = await startManualPage();
    const topCursor = await pageNavigationTracker.getCursor(42, 0);
    const previousFence = pageNavigationTracker.getOrMintRestartFence(42);
    let resolveStopDelivery;
    const stopDelivery = new Promise(resolve => { resolveStopDelivery = resolve; });
    const sendMessage = browser.tabs.sendMessage.getMockImplementation();
    browser.tabs.sendMessage.mockImplementation((tabId, message, options) => (
      message.action === MessageActions.PAGE_TRANSLATE_STOP_AUTO
        ? stopDelivery
        : sendMessage(tabId, message, options)
    ));

    const stop = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE_STOP_AUTO }, sender);
    const restartFence = pageNavigationTracker.getRestartFence(42);
    expect(restartFence).not.toBe(previousFence);
    let stopAcknowledged = false;
    void stop.then(() => { stopAcknowledged = true; });
    await vi.waitFor(() => expect(
      browser.tabs.sendMessage.mock.calls.some(([, message]) => message.action === MessageActions.PAGE_TRANSLATE_STOP_AUTO)
    ).toBe(true));
    await Promise.resolve();
    expect(stopAcknowledged).toBe(false);

    const admission = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_ADMIT,
      data: {
        origin: 'manual-spa',
        restartFence,
        manualContinuityGeneration: grant.generation,
        topDocumentEpoch: grant.topDocumentEpoch,
        navigationCursor: topCursor,
      },
    }, { ...sender, frameId: 0 });

    expect(admission).toEqual({ success: false, reason: 'obsolete_navigation' });
    resolveStopDelivery({ success: true });
    expect(await stop).toMatchObject({
      success: true,
      hasManualContinuity: false,
      manualContinuityGeneration: grant.generation + 1,
    });
    expect(await pageNavigationTracker.getManualContinuity(42)).toBeNull();
  });

  it('does not let older delayed preparation override a newer Stop then Manual Start', async () => {
    setupFrames([
      { frameId: 0, response: { success: true } },
      { frameId: 7, response: { success: true } },
    ]);
    await pageNavigationTracker.seed(42, [
      { frameId: 0, url: 'https://example.com' },
      { frameId: 7, url: 'https://frame-7.example' },
    ]);
    let resolveOldPreparation;
    const oldPreparation = new Promise(resolve => { resolveOldPreparation = resolve; });
    browser.webNavigation.getAllFrames.mockImplementationOnce(() => oldPreparation.promise);

    const olderStart = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
    await vi.waitFor(() => expect(browser.webNavigation.getAllFrames).toHaveBeenCalledOnce());
    expect(pageNavigationTracker.manualContinuityRevision.get(42)).toBe(1);

    const stop = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE_STOP_AUTO }, sender);
    expect(stop.success).toBe(true);
    const newerStart = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
    expect(newerStart.success).toBe(true);
    const sendCountAfterNewerStart = browser.tabs.sendMessage.mock.calls.length;

    resolveOldPreparation([
      { frameId: 0, url: 'https://example.com' },
      { frameId: 7, url: 'https://frame-7.example' },
    ]);
    await expect(olderStart).resolves.toMatchObject({ success: false });
    expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(sendCountAfterNewerStart);
    expect((await pageNavigationTracker.getManualContinuity(42)).generation).toBe(2);
  });

  it('best-effort cancels frames and reports uncertainty when Stop revocation storage fails', async () => {
    const grant = await startManualPage();
    browser.tabs.sendMessage.mockClear();
    browser.storage.session.set.mockRejectedValueOnce(new Error('session storage unavailable'));

    const result = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE_STOP_AUTO }, sender);

    expect(result).toMatchObject({
      success: false,
      reason: 'manual_continuity_revocation_uncertain',
      responses: [{ success: true }, { success: true }],
    });
    expect(result).not.toHaveProperty('hasManualContinuity');
    expect(result).not.toHaveProperty('manualContinuityGeneration');
    expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(browser.tabs.sendMessage.mock.calls.every(([, message]) => (
      message.action === MessageActions.PAGE_TRANSLATE_STOP_AUTO
      && message.data.hasManualContinuity === false
      && message.data.manualContinuityGeneration === grant.generation
      && message.data.revocationCommitted === false
    ))).toBe(true);
  });

  it('keeps a revocation-timeout fallback scoped to its original grant generation', async () => {
    vi.useFakeTimers();
    try {
      const grant = await startManualPage();
      browser.tabs.sendMessage.mockClear();
      let releaseWrite;
      browser.storage.session.set.mockImplementationOnce(value => new Promise(resolve => {
        releaseWrite = () => {
          navigationStore.saved = structuredClone(value);
          resolve();
        };
      }));
      setupFrames([
        { frameId: 0, response: { success: true } },
        { frameId: 7, response: { success: true } },
      ]);

      const stopPromise = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE_STOP_AUTO }, sender);
      await vi.waitFor(() => expect(releaseWrite).toBeTypeOf('function'));
      await vi.advanceTimersByTimeAsync(PRE_FANOUT_TIMEOUT_MS);
      const result = await stopPromise;
      expect(result).toMatchObject({
        success: false,
        reason: 'manual_continuity_revocation_uncertain',
      });
      expect(browser.tabs.sendMessage.mock.calls.every(([, message]) => (
        message.action === MessageActions.PAGE_TRANSLATE_STOP_AUTO
        && message.data.manualContinuityGeneration === grant.generation
        && message.data.revocationCommitted === false
      ))).toBe(true);

      releaseWrite();
      await vi.waitFor(async () => {
        expect(await pageNavigationTracker.getManualContinuity(42)).toBeNull();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports committed false after partial Stop delivery and keeps the grant revoked after worker replacement', async () => {
    const grant = await startManualPage();
    setupFrames([
      { frameId: 0, response: { success: true } },
      { frameId: 7, error: new Error('child unavailable') },
    ]);

    const result = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE_STOP_AUTO }, sender);

    expect(result).toMatchObject({
      success: false,
      reason: 'manual_continuity_stop_delivery_uncertain',
      hasManualContinuity: false,
      manualContinuityGeneration: grant.generation + 1,
      frames: [{ frameId: 0, success: true }, { frameId: 7, success: false }],
    });
    const replacementTracker = new PageNavigationTracker(browser.storage.session);
    expect(await replacementTracker.getManualContinuity(42)).toBeNull();
    expect(await replacementTracker.getManualContinuityStatus(42)).toMatchObject({
      hasManualContinuity: false,
      manualContinuityGeneration: grant.generation + 1,
    });
  });

  it('preserves Stop authority uncertainty when another frame acknowledges cancellation', async () => {
    await startManualPage();
    setupFrames([
      { frameId: 0, response: { success: true } },
      { frameId: 7, response: {
        success: false,
        reason: 'manual_continuity_status_unavailable',
        isTransportFailure: true,
      } },
    ]);

    const result = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE_STOP_AUTO }, sender);

    expect(result).toMatchObject({
      success: false,
      reason: 'manual_continuity_stop_authority_uncertain',
      isTransportFailure: true,
      responses: [
        { success: true },
        { success: false, reason: 'manual_continuity_status_unavailable' },
      ],
      frames: [{ frameId: 0, success: true }, { frameId: 7, success: true }],
    });
  });

  it('admits concurrent top and child SPA routes using one fence and the original top epoch', async () => {
    const grant = await startManualPage();
    const restartFence = pageNavigationTracker.getOrMintRestartFence(42);
    await pageNavigationTracker.capture(42, 0, 'https://example.com/route-b');
    browser.webNavigation.getFrame.mockImplementation(({ frameId }) => ({
      url: frameId === 0 ? 'https://example.com/route-b' : 'https://frame-7.example',
    }));
    const [topCursor, childCursor] = await Promise.all([
      pageNavigationTracker.getCursor(42, 0),
      pageNavigationTracker.getCursor(42, 7),
    ]);
    const admission = (frameId, navigationCursor) => handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_ADMIT,
      data: {
        origin: 'manual-spa',
        restartFence,
        manualContinuityGeneration: grant.generation,
        topDocumentEpoch: grant.topDocumentEpoch,
        navigationCursor,
      },
    }, { ...sender, frameId });

    await expect(Promise.all([
      admission(0, topCursor),
      admission(7, childCursor),
    ])).resolves.toEqual([{ success: true }, { success: true }]);
  });

  it('guards translation batches against a revoked manual grant before service dispatch', async () => {
    const grant = await startManualPage();
    const navigationCursor = await pageNavigationTracker.getCursor(42, 0);
    const authorization = {
      generation: grant.generation,
      topDocumentEpoch: grant.topDocumentEpoch,
      navigationCursor,
    };
    const message = {
      action: MessageActions.PAGE_TRANSLATE_BATCH,
      data: { manualContinuity: authorization },
    };
    const contentSender = { ...sender, frameId: 0 };
    const frameReadsBeforeBatch = browser.webNavigation.getFrame.mock.calls.length;
    const storageReadsBeforeBatch = browser.storage.session.get.mock.calls.length;

    await handlePageTranslation(message, contentSender);
    expect(unifiedTranslationService.handleTranslationRequest).toHaveBeenCalledOnce();
    expect(browser.webNavigation.getFrame).toHaveBeenCalledTimes(frameReadsBeforeBatch);
    expect(browser.storage.session.get).toHaveBeenCalledTimes(storageReadsBeforeBatch);

    await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE_STOP_AUTO }, sender);
    unifiedTranslationService.handleTranslationRequest.mockClear();
    expect(await handlePageTranslation(message, contentSender)).toEqual({
      success: false,
      reason: 'manual_continuity_revoked',
    });
    expect(unifiedTranslationService.handleTranslationRequest).not.toHaveBeenCalled();
  });
});

describe('handlePageTranslation response projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ActionReasons.BUSY_OR_DONE,
    ActionReasons.NOT_SUITABLE,
    ActionReasons.USER_CANCELLED,
    ActionReasons.SILENT_ERROR,
  ])('promotes %s from main-frame rejection', async (reason) => {
    const mainResponse = { success: false, reason };
    setupFrames([{ frameId: 0, response: mainResponse }]);

    const result = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);

    expect(result).toEqual({
      success: false,
      reason,
      responses: [mainResponse],
      frames: [{ frameId: 0, success: true }],
      targetTabId: 42,
    });
  });

  it('prefers main-frame rejection over a child-frame rejection', async () => {
    const mainResponse = { success: false, reason: ActionReasons.NOT_SUITABLE };
    const childResponse = { success: false, reason: ActionReasons.BUSY_OR_DONE };
    setupFrames([
      { frameId: 0, response: mainResponse },
      { frameId: 1, response: childResponse },
    ]);

    const result = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);

    expect(result.reason).toBe(ActionReasons.NOT_SUITABLE);
    expect(result.responses).toEqual([mainResponse, childResponse]);
    expect(result.frames).toEqual([
      { frameId: 0, success: true },
      { frameId: 1, success: true },
    ]);
  });

  it('uses first resolved child rejection when main frame transport fails', async () => {
    const childResponse = { success: false, reason: ActionReasons.NOT_SUITABLE };
    setupFrames([
      { frameId: 0, error: new Error('main frame unavailable') },
      { frameId: 1, response: childResponse },
    ]);

    const result = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);

    expect(result).toEqual({
      success: false,
      reason: ActionReasons.NOT_SUITABLE,
      responses: [childResponse],
      frames: [
        { frameId: 0, success: false },
        { frameId: 1, success: true },
      ],
      targetTabId: 42,
    });
    expect(result.isTransportFailure).toBeUndefined();
  });

  it('promotes structured failure fields without mutating nested response', async () => {
    const errorDetails = {
      message: 'Provider failed',
      type: 'NETWORK_ERROR',
      providerId: 'provider-id',
      translationOutcome: { committedParentCount: 0 },
    };
    const mainResponse = {
      success: false,
      error: 'Safe provider failure',
      errorType: 'NETWORK_ERROR',
      errorDetails,
      message: 'Legacy message',
      tabId: 42,
      tabUrl: 'https://example.com',
      internalOnly: 'not-promoted',
    };
    setupFrames([{ frameId: 0, response: mainResponse }]);

    const result = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);

    expect(result).toMatchObject({
      success: false,
      error: 'Safe provider failure',
      errorType: 'NETWORK_ERROR',
      errorDetails,
      message: 'Legacy message',
      tabId: 42,
      tabUrl: 'https://example.com',
      responses: [mainResponse],
    });
    expect(result).not.toHaveProperty('internalOnly');
    expect(result.responses[0]).toBe(mainResponse);
  });

  it('keeps mixed-frame success semantics and nested rejection data', async () => {
    const mainResponse = { success: false, reason: ActionReasons.NOT_SUITABLE };
    const childResponse = { success: true, messageId: 'child-session' };
    setupFrames([
      { frameId: 0, response: mainResponse },
      { frameId: 1, response: childResponse },
    ]);

    const result = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);

    expect(result).toEqual({
      success: true,
      responses: [mainResponse, childResponse],
      frames: [
        { frameId: 0, success: true },
        { frameId: 1, success: true },
      ],
      targetTabId: 42,
    });
    expect(result).not.toHaveProperty('reason');
    expect(result.isTransportFailure).toBeUndefined();
  });

  it('keeps domain rejection when another frame has a transport failure', async () => {
    const childResponse = { success: false, reason: ActionReasons.BUSY_OR_DONE };
    setupFrames([
      { frameId: 0, error: new Error('main frame unavailable') },
      { frameId: 1, response: childResponse },
    ]);

    const result = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);

    expect(result.reason).toBe(ActionReasons.BUSY_OR_DONE);
    expect(result.error).toBeUndefined();
    expect(result.isTransportFailure).toBeUndefined();
  });

  it('returns explicit transport failure when every frame send fails', async () => {
    setupFrames([
      { frameId: 0, error: new Error('main frame unavailable') },
      { frameId: 1, error: new Error('child frame unavailable') },
    ]);

    const result = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);

    expect(result).toEqual({
      success: false,
      error: 'Content script not available',
      isTransportFailure: true,
      responses: [],
      frames: [
        { frameId: 0, success: false },
        { frameId: 1, success: false },
      ],
      targetTabId: 42,
    });
    expect(result.reason).toBeUndefined();
  });

  it('propagates the settled session id of a failed frame response', async () => {
    const mainResponse = { success: false, reason: 'silent_error', messageId: 'page-translate-1700000000000-42' };
    setupFrames([{ frameId: 0, response: mainResponse }]);

    const result = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);

    expect(result).toEqual({
      success: false,
      reason: 'silent_error',
      messageId: 'page-translate-1700000000000-42',
      responses: [mainResponse],
      frames: [{ frameId: 0, success: true }],
      targetTabId: 42,
    });
  });

  it('preserves restricted-page response without frame aggregation', async () => {
    const restrictedResponse = {
      isAccessible: false,
      errorMessage: 'Restricted page',
      fullUrl: 'about:blank',
    };
    tabPermissionChecker.checkTabAccess.mockResolvedValue(restrictedResponse);
    browser.tabs.query.mockResolvedValue([{ id: 42 }]);

    const result = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);

    expect(result).toEqual({
      success: false,
      message: 'Restricted page',
      isRestrictedPage: true,
      tabId: 42,
      tabUrl: 'about:blank',
    });
    expect(browser.webNavigation.getAllFrames).not.toHaveBeenCalled();
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('includes committed continuity revocation state on restore responses', async () => {
    const mainResponse = { success: false, reason: ActionReasons.NOT_SUITABLE };
    setupFrames([{ frameId: 0, response: mainResponse }]);

    const result = await handlePageTranslation({ action: MessageActions.PAGE_RESTORE }, sender);

    expect(result).toEqual({
      success: false,
      hasManualContinuity: false,
      manualContinuityGeneration: 1,
      responses: [mainResponse],
      frames: [{ frameId: 0, success: true }],
      targetTabId: 42,
    });
    expect(result.reason).toBeUndefined();
  });
});

describe('handlePageTranslation target tab ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    MessageActions.PAGE_TRANSLATE,
    MessageActions.PAGE_RESTORE,
    MessageActions.PAGE_TRANSLATE_GET_STATUS,
    MessageActions.PAGE_TRANSLATE_STOP_AUTO,
  ])('uses sender tab for %s instead of active tab', async (action) => {
    setupFrames([
      { frameId: 0, response: { success: true, isAggregated: action === MessageActions.PAGE_TRANSLATE_GET_STATUS } },
      { frameId: 1, response: { success: true } },
    ], { activeTabId: 20 });

    const message = {
      action,
      tabId: 20,
      ...(action === MessageActions.PAGE_TRANSLATE
        ? { data: { cancel: true, tabId: 20 } }
        : {}),
    };
    const result = await handlePageTranslation(message, { tab: { id: 10 } });

    expect(result.success).toBe(true);
    expect(browser.tabs.query).not.toHaveBeenCalled();
    expect(tabPermissionChecker.checkTabAccess).toHaveBeenCalledWith(10);
    if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) {
      expect(browser.webNavigation.getAllFrames).not.toHaveBeenCalled();
      expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(1);
    } else {
      expect(browser.webNavigation.getAllFrames).toHaveBeenCalledWith({ tabId: 10 });
      expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(2);
    }
    expect(browser.tabs.sendMessage.mock.calls.every(([tabId]) => tabId === 10)).toBe(true);
    expect(browser.tabs.sendMessage.mock.calls.some(([tabId]) => tabId === 20)).toBe(false);
  });

  it('keeps Stop as command fan-out when one frame is unavailable', async () => {
    setupFrames([
      { frameId: 0, response: { success: true } },
      { frameId: 1, error: new Error('child frame unavailable') },
      { frameId: 2, response: { success: true } },
    ]);

    const result = await handlePageTranslation(
      { action: MessageActions.PAGE_TRANSLATE_STOP_AUTO },
      sender
    );

    expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(3);
    expect(browser.tabs.sendMessage.mock.calls).toEqual(expect.arrayContaining([
      [42, expect.objectContaining({ action: MessageActions.PAGE_TRANSLATE_STOP_AUTO }), { frameId: 0 }],
      [42, expect.objectContaining({ action: MessageActions.PAGE_TRANSLATE_STOP_AUTO }), { frameId: 1 }],
      [42, expect.objectContaining({ action: MessageActions.PAGE_TRANSLATE_STOP_AUTO }), { frameId: 2 }],
    ]));
    expect(result).toEqual({
      success: false,
      reason: 'manual_continuity_stop_delivery_uncertain',
      isTransportFailure: true,
      revocationGeneration: 1,
      hasManualContinuity: false,
      manualContinuityGeneration: 1,
      responses: [{ success: true }, { success: true }],
      frames: [
        { frameId: 0, success: true },
        { frameId: 1, success: false },
        { frameId: 2, success: true },
      ],
      targetTabId: 42,
    });
  });

  it.each([{}, { tab: null }])('preserves active-tab fallback without sender tab: %o', async (sender) => {
    setupFrames([
      { frameId: 0, response: { success: true } },
      { frameId: 1, response: { success: true } },
    ], { activeTabId: 20 });

    const result = await handlePageTranslation(
      { action: MessageActions.PAGE_TRANSLATE },
      sender
    );

    expect(result.success).toBe(true);
    expect(browser.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(tabPermissionChecker.checkTabAccess).toHaveBeenCalledWith(20);
    expect(browser.webNavigation.getAllFrames).toHaveBeenCalledWith({ tabId: 20 });
    expect(browser.tabs.sendMessage.mock.calls.every(([tabId]) => tabId === 20)).toBe(true);
  });

  it('bounds stalled active-tab lookup before fan-out', async () => {
    vi.useFakeTimers();
    try {
      browser.tabs.query.mockReturnValue(new Promise(() => {}));

      const resultPromise = handlePageTranslation(
        { action: MessageActions.PAGE_TRANSLATE },
        {}
      );

      await expectPreFanoutTimeout(resultPromise);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds stalled tab-access lookup before fan-out', async () => {
    vi.useFakeTimers();
    try {
      tabPermissionChecker.checkTabAccess.mockReturnValue(new Promise(() => {}));

      const resultPromise = handlePageTranslation(
        { action: MessageActions.PAGE_TRANSLATE },
        sender
      );

      await expectPreFanoutTimeout(resultPromise);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds stalled frame discovery before fan-out', async () => {
    vi.useFakeTimers();
    try {
      tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: true });
      browser.webNavigation.getAllFrames.mockReturnValue(new Promise(() => {}));

      const resultPromise = handlePageTranslation(
        { action: MessageActions.PAGE_TRANSLATE },
        sender
      );

      await expectPreFanoutTimeout(resultPromise);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    MessageActions.PAGE_TRANSLATE,
    MessageActions.PAGE_RESTORE,
    MessageActions.PAGE_TRANSLATE_GET_STATUS,
    MessageActions.PAGE_TRANSLATE_STOP_AUTO,
  ])('bounds shared preparation for %s', async (action) => {
    vi.useFakeTimers();
    try {
      tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: true });
      browser.webNavigation.getAllFrames.mockReturnValue(new Promise(() => {}));

      const resultPromise = handlePageTranslation({ action }, sender);

      if (action === MessageActions.PAGE_TRANSLATE_GET_STATUS) {
        await vi.advanceTimersByTimeAsync(PRE_FANOUT_TIMEOUT_MS);
        await expect(resultPromise).resolves.toEqual({
          success: false,
          reason: PRE_FANOUT_TIMEOUT_REASON,
          isTransportFailure: true,
        });
        expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(1);
      } else {
        await expectPreFanoutTimeout(resultPromise);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { tab: {} },
    { tab: { id: null } },
    { tab: { id: '10' } },
    { tab: { id: Number.NaN } },
    { tab: { id: 1.5 } },
  ])('rejects malformed sender tab without active-tab fallback: %o', async (sender) => {
    browser.tabs.query.mockResolvedValue([{ id: 20 }]);

    const result = await handlePageTranslation(
      { action: MessageActions.PAGE_TRANSLATE },
      sender
    );

    expect(result).toEqual({ success: false, error: 'Invalid sender tab' });
    expect(browser.tabs.query).not.toHaveBeenCalled();
    expect(tabPermissionChecker.checkTabAccess).not.toHaveBeenCalled();
    expect(browser.webNavigation.getAllFrames).not.toHaveBeenCalled();
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('reports restricted sender tab metadata without inspecting active tab', async () => {
    setupFrames([{ frameId: 0, response: { success: true } }], { activeTabId: 20 });
    tabPermissionChecker.checkTabAccess.mockResolvedValueOnce({
      isAccessible: false,
      errorMessage: 'Restricted tab',
      fullUrl: 'about:blank',
    });

    const result = await handlePageTranslation(
      { action: MessageActions.PAGE_TRANSLATE },
      { tab: { id: 10 } }
    );

    expect(result).toEqual({
      success: false,
      message: 'Restricted tab',
      isRestrictedPage: true,
      tabId: 10,
      tabUrl: 'about:blank',
    });
    expect(browser.tabs.query).not.toHaveBeenCalled();
    expect(browser.webNavigation.getAllFrames).not.toHaveBeenCalled();
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('preserves status aggregation while targeting sender tab', async () => {
    const aggregatedResponse = {
      success: true,
      isAggregated: true,
      translatedCount: 4,
    };
    setupFrames([
      { frameId: 0, response: aggregatedResponse },
      { frameId: 1, response: { success: true, translatedCount: 2 } },
    ], { activeTabId: 20 });

    const result = await handlePageTranslation(
      { action: MessageActions.PAGE_TRANSLATE_GET_STATUS },
      { tab: { id: 10 } }
    );

    expect(result).toMatchObject({
      ...aggregatedResponse,
      hasManualContinuity: false,
      manualContinuityGeneration: null,
    });
    expect(browser.tabs.query).not.toHaveBeenCalled();
    expect(tabPermissionChecker.checkTabAccess).toHaveBeenCalledWith(10);
    expect(browser.webNavigation.getAllFrames).not.toHaveBeenCalled();
    expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(
      10,
      expect.objectContaining({ action: MessageActions.PAGE_TRANSLATE_GET_STATUS }),
      { frameId: 0 }
    );
  });

  it('broadcasts completions with the authoritative sender tab and drops untrusted payload tab ids', async () => {
    browser.runtime.sendMessage.mockResolvedValue({ success: true });

    const result = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_COMPLETE,
      data: { tabId: 999, translatedCount: 1, totalCount: 1, isTranslated: true, isAutoTranslating: false, aggregateScope: 'opaque-document-scope', aggregateRevision: 17 },
    }, sender);

    expect(result).toEqual({ success: true });
    expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(browser.runtime.sendMessage.mock.calls[0][0].data).toEqual({
      tabId: 42,
      translatedCount: 1,
      totalCount: 1,
      isTranslated: true,
      isAutoTranslating: false,
      aggregateScope: 'opaque-document-scope',
      aggregateRevision: 17,
    });
  });

  it('omits the tab id from broadcasts when sender identity is unavailable', async () => {
    browser.runtime.sendMessage.mockResolvedValue({ success: true });

    const result = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_ERROR,
      data: { tabId: 999, error: 'boom', errorDetails: { type: 'TRANSLATION_FAILED', message: 'boom' } },
    }, { tab: undefined });

    expect(result).toEqual({ success: true });
    expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(browser.runtime.sendMessage.mock.calls[0][0].data).toEqual({
      error: 'boom',
      errorDetails: { type: 'TRANSLATION_FAILED', message: 'boom' },
    });
  });
});

describe('PAGE_TRANSLATE_GET_STATUS aggregated fast path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns top aggregate without discovering or querying child frames', async () => {
    const aggregate = { success: true, isAggregated: true, translatedCount: 4 };
    setupFrames([
      { frameId: 0, response: aggregate },
      { frameId: 7, error: new Error('child must not be queried') },
    ]);

    const result = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE_GET_STATUS }, sender);

    expect(result).toMatchObject({
      ...aggregate,
      hasManualContinuity: false,
      manualContinuityGeneration: null,
    });
    expect(browser.webNavigation.getAllFrames).not.toHaveBeenCalled();
    expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(42, expect.anything(), { frameId: 0 });
  });

  it('uses existing fan-out fallback after top-frame transport failure', async () => {
    const aggregate = { success: true, isAggregated: true, translatedCount: 4 };
    setupFrames([
      { frameId: 0, response: aggregate },
      { frameId: 7, response: { success: true } },
    ]);
    browser.tabs.sendMessage.mockImplementationOnce(() => Promise.reject(new Error('top unavailable')));

    const result = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE_GET_STATUS }, sender);

    expect(result).toMatchObject({
      ...aggregate,
      hasManualContinuity: false,
      manualContinuityGeneration: null,
    });
    expect(browser.webNavigation.getAllFrames).toHaveBeenCalledWith({ tabId: 42 });
    expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(3);
  });

  it('uses existing fan-out fallback for non-aggregated top responses', async () => {
    const aggregate = { success: true, isAggregated: true, translatedCount: 4 };
    setupFrames([
      { frameId: 0, response: aggregate },
      { frameId: 7, response: { success: true } },
    ]);
    browser.tabs.sendMessage.mockImplementationOnce(() => Promise.resolve({ success: true, translatedCount: 1 }));

    const result = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE_GET_STATUS }, sender);

    expect(result).toMatchObject({
      ...aggregate,
      hasManualContinuity: false,
      manualContinuityGeneration: null,
    });
    expect(browser.webNavigation.getAllFrames).toHaveBeenCalledWith({ tabId: 42 });
    expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(3);
  });
});

describe('trusted frame lifecycle relay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browser.tabs.sendMessage.mockResolvedValue({ success: true, aggregated: true });
  });

  it('authenticates sender tab/frame and ignores payload frame identity', async () => {
    const data = {
      translatedCount: 2,
      totalCount: 3,
      frameId: 99,
      frameUrl: 'https://attacker.example',
    };

    const result = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE,
      data: {
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data,
      },
    }, { tab: { id: 42 }, frameId: 7 });

    expect(result).toEqual({ success: true, aggregated: true });
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(42, {
      action: MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE,
      data: {
        frameId: 7,
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data,
      },
      context: 'page-translation-frame-lifecycle-relay',
    }, { frameId: 0 });
  });

  it('relays structured completion details unchanged', async () => {
    const errorDetails = {
      message: 'Rate limited',
      type: 'RATE_LIMIT_REACHED',
      statusCode: 429,
    };
    const data = {
      sessionId: 'session-a',
      translatedCount: 0,
      failedCount: 2,
      totalCount: 2,
      errorDetails,
    };

    const result = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE,
      data: {
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data,
      },
    }, { tab: { id: 42 }, frameId: 7 });

    expect(result).toEqual({ success: true, aggregated: true });
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(42, {
      action: MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE,
      data: {
        frameId: 7,
        action: MessageActions.PAGE_TRANSLATE_COMPLETE,
        data,
      },
      context: 'page-translation-frame-lifecycle-relay',
    }, { frameId: 0 });
  });

  it('relays retirement with sender frame identity and top-frame targeting', async () => {
    const result = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE,
      data: {
        action: MessageActions.PAGE_TRANSLATION_FRAME_RETIRED,
        tabId: 99,
        frameId: 99,
        data: { sessionId: 'child-session', tabId: 98, frameId: 98 },
      },
    }, { tab: { id: 42 }, frameId: 7 });

    expect(result).toEqual({ success: true, aggregated: true });
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(42, {
      action: MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE,
      data: {
        frameId: 7,
        action: MessageActions.PAGE_TRANSLATION_FRAME_RETIRED,
        data: { sessionId: 'child-session', tabId: 98, frameId: 98 },
      },
      context: 'page-translation-frame-lifecycle-relay',
      }, { frameId: 0 });
  });

  it.each([
    {},
    { sessionId: 'session-a' },
    { data: { sessionId: '' } },
    { data: { sessionId: 42 } },
  ])('ignores runtime retirement without valid nested session: %o', async (retirementData) => {
    const result = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE,
      data: {
        action: MessageActions.PAGE_TRANSLATION_FRAME_RETIRED,
        ...retirementData,
      },
    }, { tab: { id: 42 }, frameId: 7 });

    expect(result).toEqual({ success: true, ignored: true, reason: 'missing-session' });
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('relays top-frame lifecycle with sender frame zero', async () => {
    await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE,
      data: {
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { messageId: 'top-session' },
      },
    }, { tab: { id: 42 }, frameId: 0 });

    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ data: expect.objectContaining({ frameId: 0 }) }),
      { frameId: 0 }
    );
  });

  it.each([
    {},
    { tab: null },
    { tab: { id: '42' }, frameId: 7 },
    { tab: { id: 42 }, frameId: undefined },
    { tab: { id: 42 }, frameId: -1 },
  ])('fails closed for malformed lifecycle sender: %o', async (sender) => {
    const result = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE,
      data: { action: MessageActions.PAGE_TRANSLATE_PROGRESS, data: {} },
    }, sender);

    expect(result).toEqual({ success: false, error: 'Invalid lifecycle sender' });
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
    expect(browser.tabs.query).not.toHaveBeenCalled();
  });

  it('rejects lifecycle actions outside allowlist', async () => {
    const result = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE,
      data: { action: 'PAGE_TRANSLATE', data: {} },
    }, { tab: { id: 42 }, frameId: 7 });

    expect(result).toEqual({ success: false, error: 'Unsupported page lifecycle action' });
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('does not classify Stop as frame lifecycle', async () => {
    const result = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE,
      data: { action: MessageActions.PAGE_TRANSLATE_STOP_AUTO, data: {} },
    }, { tab: { id: 42 }, frameId: 7 });

    expect(result).toEqual({ success: false, error: 'Unsupported page lifecycle action' });
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
  });
});

describe('trusted subframe navigation retirement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browser.runtime.sendMessage.mockResolvedValue({ success: true });
    browser.tabs.sendMessage.mockResolvedValue({ success: true, retired: true });
  });

  it('retires subframe state before relaying replacement lifecycle', async () => {
    let resolveRetirement;
    const retirementResponse = new Promise(resolve => {
      resolveRetirement = resolve;
    });

    browser.tabs.sendMessage.mockImplementation((_tabId, message) => {
      if (message.data?.action === MessageActions.PAGE_TRANSLATION_FRAME_RETIRED) {
        return retirementResponse;
      }
      return Promise.resolve({ success: true, aggregated: true });
    });

    const navigation = onCommittedListener({ tabId: 42, frameId: 7, transitionType: 'link' });
    const lifecycle = handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE,
      data: {
        action: MessageActions.PAGE_TRANSLATE_START,
        data: { sessionId: 'replacement-session' },
      },
    }, { tab: { id: 42 }, frameId: 7 });

    await vi.waitFor(() => expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(1));
    expect(browser.tabs.sendMessage).toHaveBeenNthCalledWith(1, 42, {
      action: MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE,
      data: {
        frameId: 7,
        action: MessageActions.PAGE_TRANSLATION_FRAME_RETIRED,
      },
      context: 'page-translation-frame-retirement',
    }, { frameId: 0 });

    resolveRetirement({ success: true, retired: true });
    await expect(navigation).resolves.toEqual({ success: true, retired: true });
    await expect(lifecycle).resolves.toEqual({ success: true, aggregated: true });

    expect(browser.tabs.sendMessage.mock.calls.map(([, message]) => message.data.action)).toEqual([
      MessageActions.PAGE_TRANSLATION_FRAME_RETIRED,
      MessageActions.PAGE_TRANSLATE_START,
    ]);
  });

  it('keeps top-level navigation on existing auto-translation path', async () => {
    await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_COMPLETE,
      data: {
        sessionId: 'auto-session',
        translatedCount: 1,
        totalCount: 1,
        isAutoTranslating: true,
      },
    }, sender);

    await onCommittedListener({ tabId: 42, frameId: 0, transitionType: 'reload' });

    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
  });
});

describe('bounded frame command response deadline', () => {
  const RESPONSE_TIMEOUT_MS = 6000;
  const STATUS_AGGREGATE_PROBE_TIMEOUT_MS = 250;
  const OUTER_STATUS_TIMEOUT_MS = 8000;
  const FALLBACK_PREPARATION_DELAY_MS = 1450;
  const FALLBACK_AGGREGATE_DELAY_MS = 5900;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setupBoundedFrames(frameHandlers, { activeTabId = 42 } = {}) {
    browser.tabs.query.mockResolvedValue([{ id: activeTabId }]);
    tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: true });
    browser.webNavigation.getAllFrames.mockResolvedValue(
      frameHandlers.map((_, index) => ({
        frameId: index === 0 ? 0 : index * 7,
        url: `https://frame-${index}.example`,
      }))
    );
    browser.webNavigation.getFrame.mockImplementation(async ({ frameId }) => ({
      url: `https://frame-${frameId === 0 ? 0 : frameId / 7}.example`,
    }));
    browser.tabs.sendMessage.mockImplementation((_tabId, _message, { frameId }) => {
      const handler = frameHandlers.find(candidate => candidate.frameId === frameId);
      return handler ? handler.run() : Promise.resolve({ success: true });
    });
  }

  const never = () => new Promise(() => {});
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  it.each([
    ['translates', MessageActions.PAGE_TRANSLATE],
    ['restores', MessageActions.PAGE_RESTORE],
    ['stops', MessageActions.PAGE_TRANSLATE_STOP_AUTO],
  ])('settles a hanging child after the inner deadline and preserves successful siblings for %s', async (_name, action) => {
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true, messageId: 'main' }) },
      { frameId: 7, run: never },
      { frameId: 14, run: () => Promise.resolve({ success: true, messageId: 'child' }) },
    ]);

    const resultPromise = handlePageTranslation({ action }, sender);
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS + 100);
    const result = await resultPromise;

    expect(result.success).toBe(action === MessageActions.PAGE_TRANSLATE);
    if (action !== MessageActions.PAGE_TRANSLATE) {
      expect(result.reason).toBe('manual_continuity_stop_delivery_uncertain');
    }
    expect(result.responses).toEqual([
      { success: true, messageId: 'main' },
      { success: true, messageId: 'child' },
    ]);
    expect(result.frames).toEqual([
      { frameId: 0, success: true },
      { frameId: 7, success: false, isResponseTimeout: true, reason: 'frame_command_response_timeout' },
      { frameId: 14, success: true },
    ]);
  });

  it('bounds a disappearing bound child independently from healthy frames', async () => {
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true, messageId: 'main' }) },
      { frameId: 7, run: () => Promise.resolve({ success: true, messageId: 'child' }) },
    ]);
    pageNavigationTracker.state = null;
    pageNavigationTracker.pending = Promise.resolve();
    pageNavigationTracker.restartFences.clear();
    const frames = [{ frameId: 0, url: 'https://frame-0.example' }, { frameId: 7, url: 'https://frame-1.example' }];
    await pageNavigationTracker.seed(42, frames);
    const navigationCursor = await pageNavigationTracker.getCursor(42, 0);
    const restartFence = pageNavigationTracker.mintRestartFence(42);
    browser.webNavigation.getFrame.mockImplementation(({ frameId }) => (
      frameId === 7 ? never() : Promise.resolve({ url: 'https://frame-0.example' })
    ));

    const resultPromise = handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE,
      data: { isAuto: true, navigationCursor, restartFence },
    }, sender);
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS + 100);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.responses).toEqual([{ success: true, messageId: 'main' }]);
    expect(result.frames).toEqual([
      { frameId: 0, success: true },
      { frameId: 7, isResponseTimeout: true, reason: 'frame_command_response_timeout', success: false },
    ]);
  });

  it('classifies immediate transport rejection distinctly from response timeout', async () => {
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true }) },
      { frameId: 7, run: () => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')) },
    ]);

    const result = await handlePageTranslation({ action: MessageActions.PAGE_RESTORE }, sender);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('manual_continuity_stop_delivery_uncertain');
    expect(result.frames).toEqual([
      { frameId: 0, success: true },
      { frameId: 7, success: false },
    ]);
    expect(result.frames.some(frame => frame.isResponseTimeout)).toBe(false);
  });

  it('bounds a stalled dispatch cursor read and does not send the command after its deadline', async () => {
    setupBoundedFrames([{ frameId: 0, run: () => Promise.resolve({ success: true }) }]);
    const cursorRead = deferred();
    const spy = vi.spyOn(pageNavigationTracker, 'getCursor').mockReturnValueOnce(cursorRead.promise);
    try {
      const result = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
      await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS + 100);
      expect(await result).toMatchObject({ success: false, isTransportFailure: true, reason: 'frame_command_response_timeout' });
      expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
      cursorRead.resolve({ documentEpoch: 1, routeRevision: 0, url: 'https://frame-0.example' });
      await vi.advanceTimersByTimeAsync(0);
      expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('bounds a stalled fresh-frame API read without blocking captured navigation or sending late', async () => {
    setupBoundedFrames([{ frameId: 0, run: () => Promise.resolve({ success: true }) }]);
    const frameRead = deferred();
    browser.webNavigation.getFrame.mockReturnValueOnce(frameRead.promise);
    const result = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.webNavigation.getFrame).toHaveBeenCalledOnce();
    expect(await pageNavigationTracker.capture(42, 0, 'https://frame-0.example/new')).toMatchObject({ url: 'https://frame-0.example/new' });
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS + 100);
    expect(await result).toMatchObject({ success: false, reason: 'frame_command_response_timeout', isTransportFailure: true });
    frameRead.resolve({ url: 'https://frame-0.example' });
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
    expect((await pageNavigationTracker.getCursor(42, 0)).url).toBe('https://frame-0.example/new');
  });

  it('returns an uncertainty result when every frame response times out', async () => {
    setupBoundedFrames([
      { frameId: 0, run: never },
      { frameId: 7, run: never },
    ]);

    const resultPromise = handlePageTranslation({ action: MessageActions.PAGE_RESTORE }, sender);
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS + 100);
    const result = await resultPromise;

    expect(result).toMatchObject({
      success: false,
      reason: 'manual_continuity_stop_delivery_uncertain',
      isTransportFailure: true,
      revocationGeneration: 1,
      responses: [],
      frames: [
        { frameId: 0, success: false, isResponseTimeout: true, reason: 'frame_command_response_timeout' },
        { frameId: 7, success: false, isResponseTimeout: true, reason: 'frame_command_response_timeout' },
      ],
      targetTabId: 42,
    });
    // No lifecycle may be synthesized by response timeouts.
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps Translate all-timeout semantics free of deterministic failure classification', async () => {
    setupBoundedFrames([
      { frameId: 0, run: never },
    ]);

    const resultPromise = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS + 100);
    const result = await resultPromise;

    expect(result.reason).toBe('frame_command_response_timeout');
    expect(result.isTransportFailure).toBe(true);
    expect(JSON.stringify(result)).not.toContain('TRANSLATION_TIMEOUT');
    expect(JSON.stringify(result)).not.toContain('TRANSLATION_FAILED');
  });

  it('returns usable top-frame aggregated status without querying a hanging child', async () => {
    const aggregatedResponse = { success: true, isAggregated: true, translatedCount: 4 };
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve(aggregatedResponse) },
      { frameId: 7, run: never },
    ]);

    const result = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE_GET_STATUS }, sender);

    expect(result).toMatchObject({
      ...aggregatedResponse,
      hasManualContinuity: false,
      manualContinuityGeneration: null,
    });
    expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(browser.webNavigation.getAllFrames).not.toHaveBeenCalled();
  });

  it('keeps delayed fallback inside the outer caller budget after the short top-frame status probe times out', async () => {
    const aggregatedResponse = { success: true, isAggregated: true, translatedCount: 4 };
    browser.tabs.query.mockResolvedValue([{ id: 42 }]);
    tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: true });
    browser.webNavigation.getAllFrames.mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve([
        { frameId: 0, url: 'https://example.com' },
        { frameId: 7, url: 'https://frame-7.example' },
      ]), FALLBACK_PREPARATION_DELAY_MS);
    }));
    let topFrameCalls = 0;
    browser.tabs.sendMessage.mockImplementation((_tabId, _message, { frameId }) => {
      if (frameId === 0) {
        topFrameCalls += 1;
        return topFrameCalls === 1
          ? never()
          : new Promise(resolve => setTimeout(() => resolve(aggregatedResponse), FALLBACK_AGGREGATE_DELAY_MS));
      }
      return Promise.resolve({ success: true });
    });

    const resultPromise = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE_GET_STATUS }, sender);
    const outerTimeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('outer status timeout')), OUTER_STATUS_TIMEOUT_MS);
    });
    await vi.advanceTimersByTimeAsync(
      STATUS_AGGREGATE_PROBE_TIMEOUT_MS
      + FALLBACK_PREPARATION_DELAY_MS
      + FALLBACK_AGGREGATE_DELAY_MS
    );

    await expect(Promise.race([resultPromise, outerTimeout])).resolves.toMatchObject({
      ...aggregatedResponse,
      hasManualContinuity: false,
      manualContinuityGeneration: null,
    });
    expect(browser.webNavigation.getAllFrames).toHaveBeenCalledWith({ tabId: 42 });
    expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(3);
  });

  it('reports Status uncertainty instead of no-active-translation when every frame times out', async () => {
    setupBoundedFrames([
      { frameId: 0, run: never },
      { frameId: 7, run: never },
    ]);

    const resultPromise = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE_GET_STATUS }, sender);
    await vi.advanceTimersByTimeAsync((RESPONSE_TIMEOUT_MS * 2) + 100);
    const result = await resultPromise;

    expect(result).toMatchObject({
      success: false,
      reason: 'frame_command_response_timeout',
      isTransportFailure: true,
      hasManualContinuity: false,
      manualContinuityGeneration: null,
    });
    expect(result.error).not.toBe('No active translation found');
  });

  it('keeps Status uncertainty when response timeout mixes with immediate rejection', async () => {
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.reject(new Error('Receiving end does not exist')) },
      { frameId: 7, run: never },
    ]);

    const resultPromise = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE_GET_STATUS }, sender);
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS + 100);
    const result = await resultPromise;

    expect(result).toMatchObject({
      success: false,
      reason: 'frame_command_response_timeout',
      isTransportFailure: true,
      hasManualContinuity: false,
      manualContinuityGeneration: null,
    });
  });

  it('preserves legacy no-active-translation fallback for all-immediate rejections', async () => {
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.reject(new Error('Receiving end does not exist')) },
      { frameId: 7, run: () => Promise.reject(new Error('Frame unavailable')) },
    ]);

    const result = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE_GET_STATUS }, sender);

    expect(result).toMatchObject({
      success: false,
      error: 'No active translation found',
      hasManualContinuity: false,
      manualContinuityGeneration: null,
    });
    expect(result.isResponseTimeout).toBeUndefined();
    expect(result.reason).toBeUndefined();
  });

  it('ignores late responses after the fan-out has settled', async () => {
    const lateChild = deferred();
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true }) },
      { frameId: 7, run: () => lateChild.promise },
    ]);

    const resultPromise = handlePageTranslation({ action: MessageActions.PAGE_RESTORE }, sender);
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS + 100);
    const settledResult = await resultPromise;
    const snapshot = JSON.stringify(settledResult);
    const sendCallCount = browser.tabs.sendMessage.mock.calls.length;

    lateChild.resolve({ success: true, restoredCount: 9 });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);

    expect(JSON.stringify(settledResult)).toBe(snapshot);
    expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(sendCallCount);
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('clears pending timers once frames acknowledge before the deadline', async () => {
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true }) },
      { frameId: 7, run: () => Promise.resolve({ success: true }) },
    ]);

    await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE_STOP_AUTO }, sender);

    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS + 100);
    expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });
});
