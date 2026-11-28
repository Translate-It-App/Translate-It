import { beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { MessageContexts } from '@/shared/messaging/core/MessagingCore.js';
import { ActionReasons } from '@/shared/messaging/core/MessagingConstants.js';
import { tabPermissionChecker } from '@/core/tabPermissions.js';
import { handlePageTranslation, revokeManualPageAuthority } from './handlePageTranslation.js';
import { PageNavigationTracker, pageNavigationTracker } from '@/core/background/PageNavigationTracker.js';
import { unifiedTranslationService } from '@/core/services/translation/UnifiedTranslationService.js';

const navigationStore = vi.hoisted(() => ({ saved: {} }));
const exclusionState = vi.hoisted(() => ({ check: null }));

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

vi.mock('@/features/exclusion/utils/exclusion-utils.js', () => ({
  checkUrlExclusionAsync: (...args) => exclusionState.check?.(...args) ?? Promise.resolve(false),
}));

const sender = { tab: { id: 42 } };
const PRE_FANOUT_TIMEOUT_MS = 1500;
const PRE_FANOUT_TIMEOUT_REASON = 'pre_fanout_command_timeout';
const onCommittedListener = browser.webNavigation.onCommitted.addListener.mock.calls[0][0];
const onRemovedListener = browser.tabs.onRemoved.addListener.mock.calls[0][0];

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
    if (_message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE) {
      return Promise.resolve({ documentToken: frameId === 0 ? 'top-document-token' : `frame-${frameId}-document-token` });
    }
    const frame = frameResults.find(candidate => candidate.frameId === frameId);
    if (frame?.error) return Promise.reject(frame.error);
    if (_message.action === MessageActions.PAGE_TRANSLATE
        && _message.data?.hasManualContinuity === true && frame?.response?.success === true) {
      const documentToken = frameId === 0 ? 'top-document-token' : `frame-${frameId}-document-token`;
      return handlePageTranslation({
        action: MessageActions.PAGE_TRANSLATE_ADMIT,
        data: {
          ..._message.data,
          origin: _message.data.origin || 'manual-start',
          ...(frame.response.success === true && { admissionPhase: 'accept' }),
          documentToken,
        },
      }, { tab: { id: _tabId }, frameId }).then(admission => (
        admission.success ? {
          ...frame.response,
          ...(frame.response.success === true && {
            documentToken: frameId === 0 ? 'top-document-token' : `frame-${frameId}-document-token`,
          }),
        } : admission
      ));
    }
    return Promise.resolve(frame?.response);
  });
}

function acceptManualPageCommand(tabId, message, frameId = 0) {
  const documentToken = frameId === 0 ? 'top-document-token' : `frame-${frameId}-document-token`;
  return handlePageTranslation({
    action: MessageActions.PAGE_TRANSLATE_ADMIT,
    data: {
      ...message.data,
      origin: message.data?.origin || 'manual-start',
      admissionPhase: 'accept',
      documentToken,
    },
  }, { tab: { id: tabId }, frameId });
}

async function recordTopManualAcceptance(grant) {
  const cursor = await pageNavigationTracker.getAdmissionCursor(42, 0);
  await pageNavigationTracker.recordManualFrameAcceptance(
    42, grant.generation, grant.attemptId, grant.attemptRevision,
    0, grant.topDocumentToken, cursor, grant.attemptId,
  );
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
  onRemovedListener(42);
  exclusionState.check = null;
  navigationStore.saved = {};
  pageNavigationTracker.state = null;
  pageNavigationTracker.durableState = null;
  pageNavigationTracker.dirty = false;
  pageNavigationTracker.pending = Promise.resolve();
  pageNavigationTracker.restartFences.clear();
  pageNavigationTracker.blockedManualContinuity.clear();
  pageNavigationTracker.manualRevocationIntents.clear();
  pageNavigationTracker.manualStartSnapshots.clear();
  pageNavigationTracker.manualContinuityRevision.clear();
  pageNavigationTracker.manualContinuityHighWater.clear();
  pageNavigationTracker.manualStartOperations.clear();
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

  it('admits a permitted file top document only for the initial manual start', async () => {
    tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: true });
    await pageNavigationTracker.seed(42, [{ frameId: 0, url: 'file:///tmp/page.html' }]);
    const grant = await pageNavigationTracker.grantManualContinuity(42, undefined, {
      topDocumentToken: 'top-document-token',
    });
    browser.webNavigation.getFrame.mockResolvedValue({ url: 'file:///tmp/page.html' });
    browser.tabs.sendMessage.mockResolvedValue({ documentToken: 'top-document-token' });
    const navigationCursor = await pageNavigationTracker.getAdmissionCursor(42, 0);
    const admission = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_ADMIT,
      data: {
        origin: 'manual-start',
        manualContinuityGeneration: grant.generation,
        manualContinuityAttemptRevision: grant.attemptRevision,
        manualContinuityAttemptId: grant.attemptId,
        topDocumentEpoch: grant.topDocumentEpoch,
        topDocumentToken: grant.topDocumentToken,
        documentToken: 'top-document-token',
        navigationCursor,
      },
    }, { ...sender, frameId: 0 });
    expect(admission).toEqual({ success: true });

    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_ADMIT,
      data: {
        origin: 'manual-spa',
        restartFence: pageNavigationTracker.getOrMintRestartFence(42),
        manualContinuityGeneration: grant.generation,
        manualContinuityAttemptRevision: grant.attemptRevision,
        manualContinuityAttemptId: grant.attemptId,
        topDocumentEpoch: grant.topDocumentEpoch,
        topDocumentToken: grant.topDocumentToken,
        documentToken: 'top-document-token',
        navigationCursor,
      },
    }, { ...sender, frameId: 0 })).resolves.toMatchObject({ success: false, reason: 'obsolete_navigation' });
  });

  it('admits an initial manual start in an existing child and records child-only accepted ownership', async () => {
    const frameTokens = { 0: 'top-document-token', 7: 'child-document-token' };
    setupFrames([
      { frameId: 0, response: { success: false, reason: ActionReasons.BUSY_OR_DONE } },
      { frameId: 7, response: { success: true } },
    ]);
    browser.tabs.sendMessage.mockImplementation(async (_tabId, message, options = {}) => {
      const frameId = options.frameId ?? 0;
      if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE) {
        return { documentToken: frameTokens[frameId] };
      }
      if (message.action === MessageActions.PAGE_TRANSLATE) {
        const admission = await handlePageTranslation({
          action: MessageActions.PAGE_TRANSLATE_ADMIT,
          data: {
            ...message.data,
            origin: 'manual-start',
            ...(frameId === 7 && { admissionPhase: 'accept' }),
            documentToken: frameTokens[frameId],
          },
        }, { ...sender, frameId });
        if (!admission.success) return admission;
        const response = frameId === 0
          ? { success: false, reason: ActionReasons.BUSY_OR_DONE }
          : { success: true, documentToken: frameTokens[frameId] };
        return response;
      }
      return { success: true };
    });

    const result = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
    expect(result).toMatchObject({ success: true });
    const grant = await pageNavigationTracker.getManualContinuity(42);
    expect(grant).toMatchObject({
      armed: true,
      acceptedDocuments: { 7: 'child-document-token' },
      acceptedAttemptIds: { 7: grant.attemptId },
    });
    expect(grant.acceptedDocuments).not.toHaveProperty('0');

    const fence = pageNavigationTracker.getRestartFence(42);
    const invalidation = {
      action: MessageActions.PAGE_TRANSLATE_STOP_AUTO,
      data: {
        settingsInvalidation: true,
        expectedManualContinuityGeneration: grant.generation,
        manualContinuityAttemptRevision: grant.attemptRevision,
        manualContinuityAttemptId: grant.attemptId,
        topDocumentEpoch: grant.topDocumentEpoch,
        documentToken: frameTokens[7],
      },
    };
    await expect(handlePageTranslation(invalidation, { ...sender, frameId: 0 }))
      .resolves.toMatchObject({ success: false, reason: 'manual_continuity_stop_superseded' });
    expect(pageNavigationTracker.getRestartFence(42)).toBe(fence);
    await expect(handlePageTranslation(invalidation, { ...sender, frameId: 7 }))
      .resolves.toMatchObject({ success: true });
  });

  it('keeps a cold-worker Manual Start valid while promoting its revision', async () => {
    setupFrames([{ frameId: 0, response: { success: true } }]);
    await pageNavigationTracker.seed(42, [{ frameId: 0, url: 'https://example.com' }]);
    let persistedRevision;
    for (let index = 0; index < 8; index += 1) {
      persistedRevision = pageNavigationTracker.reserveManualContinuityStart(42);
    }
    const previous = await pageNavigationTracker.grantManualContinuity(42, persistedRevision, {
      topDocumentToken: 'top-document-token',
      attemptId: 'persisted-attempt',
    });
    await pageNavigationTracker.armManualContinuity(42, previous.generation, persistedRevision);

    pageNavigationTracker.state = null;
    pageNavigationTracker.durableState = null;
    pageNavigationTracker.dirty = false;
    pageNavigationTracker.pending = Promise.resolve();
    pageNavigationTracker.manualContinuityRevision.clear();
    pageNavigationTracker.manualContinuityHighWater.clear();
    pageNavigationTracker.manualStartOperations.clear();
    const result = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE,
      data: {},
    }, sender);

    expect(result).toMatchObject({ success: true });
    expect(pageNavigationTracker.manualContinuityRevision.get(42)).toBe(persistedRevision + 1);
    const dispatch = browser.tabs.sendMessage.mock.calls.find(([, message]) => (
      message.action === MessageActions.PAGE_TRANSLATE && message.data?.hasManualContinuity === true
    ));
    expect(dispatch[1].data.manualContinuityAttemptRevision).toBe(persistedRevision + 1);
    expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({
      generation: previous.generation, armed: true,
    });
  });

  it('revokes a successful Manual Start response when acceptance promotion fails', async () => {
    setupFrames([{ frameId: 0, response: { success: true } }]);
    const promotion = vi.spyOn(pageNavigationTracker, 'promoteManualFrameAcceptance')
      .mockResolvedValue(false);
    const arm = vi.spyOn(pageNavigationTracker, 'armManualContinuity');
    try {
      const result = await handlePageTranslation({
        action: MessageActions.PAGE_TRANSLATE,
        data: {},
      }, sender);

      expect(result).toMatchObject({ success: true });
      expect(promotion).toHaveBeenCalledOnce();
      expect(arm).not.toHaveBeenCalled();
      await expect(pageNavigationTracker.getManualContinuity(42)).resolves.toBeNull();
      await expect(pageNavigationTracker.getManualContinuityForRevocation(42))
        .resolves.toMatchObject({ revoked: true });
    } finally {
      promotion.mockRestore();
      arm.mockRestore();
    }
  });

  it.each(['ftp://example.com/page', 'chrome://settings'])('rejects unsupported manual URL %s', async url => {
    tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: true });
    await pageNavigationTracker.seed(42, [{ frameId: 0, url }]);
    const grant = await pageNavigationTracker.grantManualContinuity(42, undefined, {
      topDocumentToken: 'top-document-token',
    });
    browser.webNavigation.getFrame.mockResolvedValue({ url });
    const navigationCursor = await pageNavigationTracker.getAdmissionCursor(42, 0);
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_ADMIT,
      data: {
        origin: 'manual-start',
        manualContinuityGeneration: grant.generation,
        topDocumentEpoch: grant.topDocumentEpoch,
        topDocumentToken: grant.topDocumentToken,
        navigationCursor,
      },
    }, { ...sender, frameId: 0 })).resolves.toMatchObject({ success: false, reason: 'obsolete_navigation' });
  });

  it('rejects file admission when tab permission is restricted or the cursor is obsolete', async () => {
    tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: true });
    await pageNavigationTracker.seed(42, [{ frameId: 0, url: 'file:///tmp/page.html' }]);
    const grant = await pageNavigationTracker.grantManualContinuity(42, undefined, {
      topDocumentToken: 'top-document-token',
    });
    const navigationCursor = await pageNavigationTracker.getCursor(42, 0);
    const request = {
      action: MessageActions.PAGE_TRANSLATE_ADMIT,
      data: {
        origin: 'manual-start', manualContinuityGeneration: grant.generation,
        manualContinuityAttemptRevision: grant.attemptRevision,
        manualContinuityAttemptId: grant.attemptId,
        topDocumentEpoch: grant.topDocumentEpoch, topDocumentToken: grant.topDocumentToken,
        navigationCursor,
      },
    };
    tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: false });
    await expect(handlePageTranslation(request, { ...sender, frameId: 0 }))
      .resolves.toMatchObject({ success: false, reason: 'ineligible_frame' });
    tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: true });
    browser.webNavigation.getFrame.mockResolvedValue({ url: 'file:///tmp/obsolete.html' });
    await expect(handlePageTranslation(request, { ...sender, frameId: 0 }))
      .resolves.toMatchObject({ success: false, reason: 'obsolete_navigation' });
  });

  it('requires the exact accepted child document and current manual attempt for settings invalidation', async () => {
    tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: true });
    await pageNavigationTracker.seed(42, [
      { frameId: 0, url: 'https://example.com' },
      { frameId: 7, url: 'https://frame.example' },
    ]);
    const startRevision = pageNavigationTracker.reserveManualContinuityStart(42);
    const grant = await pageNavigationTracker.grantManualContinuity(42, startRevision, {
      topDocumentToken: 'top-document-token',
    });
    await pageNavigationTracker.armManualContinuity(42, grant.generation, startRevision);
    const frameAdmission = await pageNavigationTracker.admitManualFrame(
      42, 7, grant.generation, grant.topDocumentEpoch, grant.topDocumentToken,
      'https://frame.example', 'child-probe-token',
    );
    const topCursor = await pageNavigationTracker.getCursor(42, 0);
    await pageNavigationTracker.recordManualFrameAcceptance(
      42, grant.generation, grant.attemptId, grant.attemptRevision, 0, grant.topDocumentToken, topCursor,
    );
    expect(await pageNavigationTracker.claimManualFrameStart(
      42, 7, grant.generation, grant.topDocumentEpoch, grant.topDocumentToken,
      frameAdmission.cursor, 'child-probe-token', grant.attemptId, grant.attemptRevision,
    )).toBe(true);
    await pageNavigationTracker.completeManualFrameStart(
      42, 7, grant.generation, grant.topDocumentEpoch, grant.topDocumentToken,
      frameAdmission.cursor, 'child-probe-token', true, grant.attemptId, grant.attemptRevision,
    );
    browser.webNavigation.getFrame.mockImplementation(async ({ frameId }) => ({
      url: frameId === 0 ? 'https://example.com' : 'https://frame.example',
    }));
    browser.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 0, url: 'https://example.com' },
      { frameId: 7, url: 'https://frame.example' },
    ]);
    browser.tabs.sendMessage.mockImplementation((_tabId, message, options) => (
      message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE
        ? Promise.resolve({
          documentToken: options.frameId === 0 ? 'top-document-token' : 'child-probe-token',
        })
        : Promise.resolve({ success: true })
    ));
    const fence = pageNavigationTracker.mintRestartFence(42);
    const invalidation = {
      action: MessageActions.PAGE_TRANSLATE_STOP_AUTO,
      data: {
        settingsInvalidation: true,
        expectedManualContinuityGeneration: grant.generation,
        manualContinuityAttemptRevision: grant.attemptRevision,
        manualContinuityAttemptId: grant.attemptId,
        topDocumentEpoch: grant.topDocumentEpoch,
        documentToken: 'child-probe-token',
      },
    };
    await expect(handlePageTranslation({
      ...invalidation, data: { ...invalidation.data, documentToken: 'another-child-document' },
    }, {
      ...sender, frameId: 7,
    })).resolves.toMatchObject({ success: false, reason: 'manual_continuity_stop_superseded' });
    await expect(handlePageTranslation(invalidation, {
      ...sender, frameId: 0,
    })).resolves.toMatchObject({ success: false, reason: 'manual_continuity_stop_superseded' });
    expect(pageNavigationTracker.getRestartFence(42)).toBe(fence);
    expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({
      generation: grant.generation,
      attemptRevision: grant.attemptRevision,
    });

    pageNavigationTracker.state = null;
    pageNavigationTracker.durableState = null;
    pageNavigationTracker.dirty = false;
    pageNavigationTracker.pending = Promise.resolve();
    pageNavigationTracker.restartFences.clear();
    pageNavigationTracker.blockedManualContinuity.clear();
    pageNavigationTracker.manualContinuityRevision.clear();
    pageNavigationTracker.manualContinuityHighWater.clear();
    pageNavigationTracker.manualStartOperations.clear();
    const restartedFence = pageNavigationTracker.mintRestartFence(42);
    const newerRevision = pageNavigationTracker.reserveManualContinuityStart(42);
    const newerAttempt = await pageNavigationTracker.grantManualContinuity(42, newerRevision, {
      topDocumentToken: grant.topDocumentToken,
    });
    expect(newerAttempt.generation).toBe(grant.generation);
    expect(newerAttempt.attemptRevision).toBeGreaterThan(grant.attemptRevision);
    expect(newerRevision).toBeLessThan(newerAttempt.attemptRevision);
    expect(await pageNavigationTracker.recordManualFrameAcceptance(
      42, newerAttempt.generation, newerAttempt.attemptId, newerAttempt.attemptRevision,
      7, 'child-probe-token', frameAdmission.cursor, grant.attemptId,
    )).toBe(true);
    await expect(handlePageTranslation(invalidation, {
      ...sender, frameId: 7,
    })).resolves.toMatchObject({ success: false, reason: 'manual_continuity_stop_superseded' });
    expect(pageNavigationTracker.getRestartFence(42)).toBe(restartedFence);
    invalidation.data.manualContinuityAttemptRevision = newerAttempt.attemptRevision;
    invalidation.data.manualContinuityAttemptId = newerAttempt.attemptId;
    const acceptedInvalidation = await handlePageTranslation(invalidation, {
      ...sender, frameId: 7,
    });
    expect(acceptedInvalidation).toMatchObject({ success: true });
    expect(await pageNavigationTracker.getManualContinuity(42)).toBeNull();
    expect(browser.tabs.sendMessage.mock.calls.some(([, forwarded]) => (
      forwarded.action === MessageActions.PAGE_TRANSLATE_STOP_AUTO
        && forwarded.data.internalSettingsInvalidation === true
        && forwarded.data.cancellationReason === 'operation-abort'
    ))).toBe(true);
    await expect(handlePageTranslation(invalidation, {
      ...sender, frameId: 7,
    })).resolves.toMatchObject({ success: true });
  });

  it('admits and starts a ready replacement child once under the same armed manual grant', async () => {
    tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: true });
    await pageNavigationTracker.seed(42, [{ frameId: 0, url: 'https://example.com' }]);
    const grant = await pageNavigationTracker.grantManualContinuity(42, undefined, {
      topDocumentToken: 'top-document-token',
      provider: 'deepL', targetLanguage: 'fr', isExplicitProvider: true,
    });
    await recordTopManualAcceptance(grant);
    browser.webNavigation.getFrame.mockImplementation(async ({ frameId }) => ({
      url: frameId === 0 ? 'https://example.com' : 'https://child.example/',
    }));
    browser.tabs.sendMessage.mockImplementation(async (_tabId, message, { frameId }) => (
      message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE
        ? { documentToken: frameId === 0 ? 'top-document-token' : 'child-document-token' }
        : { success: true }
    ));

    const child = { ...sender, frameId: 7 };
    const ticket = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'child-document-token' },
    }, child);
    expect(ticket).toMatchObject({
      success: true, start: true, manualContinuityGeneration: grant.generation,
      provider: 'deepL', targetLanguage: 'fr', isExplicitProvider: true,
      navigationCursor: { url: 'https://child.example/' },
    });

    const duplicate = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'child-document-token' },
    }, child);
    expect(duplicate).toMatchObject({ success: true, start: true });
    await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_START,
      data: { ...ticket, documentToken: 'child-document-token' },
    }, child);
    await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_START,
      data: { ...ticket, documentToken: 'child-document-token' },
    }, child);
    const initialFrameStarts = browser.tabs.sendMessage.mock.calls.filter(([, message]) => message.action === MessageActions.PAGE_TRANSLATE);
    expect(initialFrameStarts).toHaveLength(1);
    expect(initialFrameStarts[0][1].data).toMatchObject({ provider: 'deepL', targetLanguage: 'fr' });
    expect((await pageNavigationTracker.getManualContinuity(42)).generation).toBe(grant.generation);

    const previousEpoch = ticket.navigationCursor.documentEpoch;
    await pageNavigationTracker.committed(42, 7, 'https://child.example/');
    browser.tabs.sendMessage.mockImplementation(async (_tabId, message, { frameId }) => (
      message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE
        ? { documentToken: frameId === 0 ? 'top-document-token' : 'replacement-document-token' }
        : { success: true }
    ));
    const replacement = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'replacement-document-token' },
    }, child);
    expect(replacement).toMatchObject({
      success: true, start: true,
      manualContinuityGeneration: grant.generation,
      provider: 'deepL', targetLanguage: 'fr',
    });
    expect(replacement.navigationCursor.documentEpoch).toBeGreaterThan(previousEpoch);
    await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_START,
      data: { ...replacement, documentToken: 'replacement-document-token' },
    }, child);
    const allFrameStarts = browser.tabs.sendMessage.mock.calls.filter(([, message]) => message.action === MessageActions.PAGE_TRANSLATE);
    expect(allFrameStarts).toHaveLength(2);
    expect(allFrameStarts[1][1].data).toMatchObject({ provider: 'deepL', targetLanguage: 'fr' });
  });

  it('persists accepted starts only after a positive response and releases rejected claims for retry', async () => {
    tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: true });
    await pageNavigationTracker.seed(42, [
      { frameId: 0, url: 'https://example.com' },
      { frameId: 7, url: 'https://frame-7.example' },
    ]);
    const grant = await pageNavigationTracker.grantManualContinuity(42, undefined, {
      topDocumentToken: 'top-document-token',
    });
    await recordTopManualAcceptance(grant);
    browser.webNavigation.getFrame.mockImplementation(async ({ frameId }) => ({
      url: frameId === 0 ? 'https://example.com' : 'https://frame-7.example',
    }));
    let rejectFirst = true;
    browser.tabs.sendMessage.mockImplementation(async (_tabId, message, { frameId }) => {
      if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE) {
        return { documentToken: frameId === 0 ? 'top-document-token' : 'child-document-token' };
      }
      if (message.action === MessageActions.PAGE_TRANSLATE && rejectFirst) {
        rejectFirst = false;
        throw new Error('receiver unavailable');
      }
      return { success: true };
    });
    const child = { ...sender, frameId: 7 };
    const ready = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'child-document-token' },
    }, child);
    expect(ready).toMatchObject({ success: true, start: true });
    const request = {
      action: MessageActions.PAGE_TRANSLATE_FRAME_START,
      data: { ...ready, documentToken: 'child-document-token' },
    };

    await expect(handlePageTranslation(request, child)).resolves.toMatchObject({ success: false, error: 'receiver unavailable' });
    expect((await pageNavigationTracker.getManualContinuity(42)).startedDocuments).toBeUndefined();
    expect(await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'child-document-token' },
    }, child)).toMatchObject({ success: true, start: true });
    await expect(handlePageTranslation(request, child)).resolves.toMatchObject({ success: true });
    expect((await pageNavigationTracker.getManualContinuity(42)).startedDocuments).toEqual({ 7: 'child-document-token' });
    expect(await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'child-document-token' },
    }, child)).toMatchObject({ success: true, start: false });
    await expect(handlePageTranslation(request, child)).resolves.toMatchObject({ success: true, skipped: true });
    expect(browser.tabs.sendMessage.mock.calls.filter(([, message]) => message.action === MessageActions.PAGE_TRANSLATE))
      .toHaveLength(2);
  });

  it('coalesces concurrent child START deliveries while the first receiver response is pending', async () => {
    tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: true });
    await pageNavigationTracker.seed(42, [
      { frameId: 0, url: 'https://example.com' },
      { frameId: 7, url: 'https://frame-7.example' },
    ]);
    const grant = await pageNavigationTracker.grantManualContinuity(42, undefined, {
      topDocumentToken: 'top-document-token',
    });
    await recordTopManualAcceptance(grant);
    const admission = await pageNavigationTracker.admitManualFrame(
      42, 7, grant.generation, grant.topDocumentEpoch, grant.topDocumentToken,
      'https://frame-7.example', 'child-document-token',
    );
    browser.webNavigation.getFrame.mockImplementation(async ({ frameId }) => ({
      url: frameId === 0 ? 'https://example.com' : 'https://frame-7.example',
    }));
    let releaseStart;
    browser.tabs.sendMessage.mockImplementation(async (_tabId, message, { frameId }) => {
      if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE) {
        return { documentToken: frameId === 0 ? 'top-document-token' : 'child-document-token' };
      }
      return new Promise(resolve => { releaseStart = resolve; });
    });
    const child = { ...sender, frameId: 7 };
    const request = {
      action: MessageActions.PAGE_TRANSLATE_FRAME_START,
      data: {
        documentToken: 'child-document-token',
        manualContinuityGeneration: grant.generation,
        manualContinuityAttemptRevision: grant.attemptRevision,
        manualContinuityAttemptId: grant.attemptId,
        topDocumentEpoch: grant.topDocumentEpoch,
        navigationCursor: admission.cursor,
      },
    };
    const first = handlePageTranslation(request, child);
    await vi.waitFor(() => expect(releaseStart).toBeTypeOf('function'));
    await expect(handlePageTranslation(request, child)).resolves.toMatchObject({ success: true, skipped: true });
    releaseStart({ success: true });
    await expect(first).resolves.toMatchObject({ success: true });
    expect(browser.tabs.sendMessage.mock.calls.filter(([, message]) => message.action === MessageActions.PAGE_TRANSLATE))
      .toHaveLength(1);
  });

  it('uses confirmed source authority for dynamic READY/START after its accepted frame retires', async () => {
    tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: true });
    await pageNavigationTracker.seed(42, [
      { frameId: 0, url: 'https://example.com' },
      { frameId: 7, url: 'https://frame-7.example' },
    ]);
    const grant = await pageNavigationTracker.grantManualContinuity(42, undefined, {
      topDocumentToken: 'top-document-token',
    });
    const acceptedCursor = await pageNavigationTracker.getCursor(42, 7);
    expect(await pageNavigationTracker.recordManualFrameAcceptance(
      42, grant.generation, grant.attemptId, grant.attemptRevision,
      7, 'frame-7-document-token', acceptedCursor, grant.attemptId,
    )).toBe(true);
    await pageNavigationTracker.armManualContinuity(42, grant.generation);
    await pageNavigationTracker.seed(42, [{ frameId: 0, url: 'https://example.com' }]);
    const retired = await pageNavigationTracker.getManualContinuity(42);
    expect(Object.keys(retired.acceptedAttemptIds || {})).toEqual([]);
    expect(pageNavigationTracker.hasConfirmedManualAttempt(
      42, grant.generation, grant.attemptId, grant.attemptRevision,
    )).toBe(true);

    browser.webNavigation.getFrame.mockImplementation(async ({ frameId }) => ({
      url: frameId === 0 ? 'https://example.com' : 'https://late-child.example/',
    }));
    let provisionalAtAdmission;
    browser.tabs.sendMessage.mockImplementation(async (_tabId, message, { frameId }) => {
      if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE) {
        return { documentToken: frameId === 0 ? 'top-document-token' : 'late-child-document-token' };
      }
      if (message.action === MessageActions.PAGE_TRANSLATE && message.data?.hasManualContinuity) {
        const admission = await handlePageTranslation({
          action: MessageActions.PAGE_TRANSLATE_ADMIT,
          data: {
            ...message.data,
            origin: 'manual-frame',
            admissionPhase: 'accept',
            documentToken: 'late-child-document-token',
          },
        }, { ...sender, frameId });
        provisionalAtAdmission = await pageNavigationTracker.getManualContinuity(42);
        return admission.success
          ? { success: true, documentToken: 'late-child-document-token' }
          : admission;
      }
      return { success: true };
    });
    const ready = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'late-child-document-token' },
    }, { ...sender, frameId: 8 });
    expect(ready).toMatchObject({
      success: true,
      start: true,
      manualContinuityAttemptId: grant.attemptId,
      manualContinuityAttemptRevision: grant.attemptRevision,
    });

    const childSender = { ...sender, frameId: 8 };
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_START,
      data: {
        ...ready,
        manualContinuityGeneration: grant.generation,
        manualContinuityAttemptId: grant.attemptId,
        manualContinuityAttemptRevision: grant.attemptRevision,
        topDocumentEpoch: grant.topDocumentEpoch,
        topDocumentToken: grant.topDocumentToken,
      },
    }, childSender)).resolves.toMatchObject({ success: true });
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(42, expect.objectContaining({
      action: MessageActions.PAGE_TRANSLATE,
      data: expect.objectContaining({ origin: 'manual-frame', manualContinuityAttemptId: grant.attemptId }),
    }), { frameId: 8 });
    expect(provisionalAtAdmission).toMatchObject({
      provisionalAttemptIds: { 8: grant.attemptId },
      provisionalAttemptRevisions: { 8: String(grant.attemptRevision) },
      provisionalDocuments: { 8: 'late-child-document-token' },
    });
    const startedGrant = await pageNavigationTracker.getManualContinuity(42);
    expect(startedGrant.acceptedAttemptIds[8]).toBe(grant.attemptId);

    const navigationCursor = await pageNavigationTracker.getAdmissionCursor(42, 8);
    await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_BATCH,
      data: { manualContinuity: {
        generation: grant.generation,
        attemptRevision: grant.attemptRevision,
        attemptId: grant.attemptId,
        topDocumentEpoch: grant.topDocumentEpoch,
        navigationCursor,
        documentToken: 'late-child-document-token',
      } },
    }, childSender);
    expect(unifiedTranslationService.handleTranslationRequest).toHaveBeenCalledOnce();
  });

  it('defers READY during the provisional start and admits the child only after original START acceptance', async () => {
    tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: true });
    await pageNavigationTracker.seed(42, [{ frameId: 0, url: 'https://example.com' }]);
    setupFrames([{ frameId: 0, response: { success: true } }]);
    let releaseTopProbe;
    const topProbe = new Promise(resolve => { releaseTopProbe = resolve; });
    const sendMessage = browser.tabs.sendMessage.getMockImplementation();
    let heldTopProbe = true;
    browser.tabs.sendMessage.mockImplementation((...args) => {
      if (heldTopProbe && args[1].action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE && args[2]?.frameId === 0) {
        heldTopProbe = false;
        return topProbe;
      }
      return sendMessage(...args);
    });
    browser.webNavigation.getFrame.mockImplementation(async ({ frameId }) => ({
      url: frameId === 0 ? 'https://example.com' : 'https://late-child.example/',
    }));
    const child = { ...sender, frameId: 7 };

    const start = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(heldTopProbe).toBe(false));
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-7-document-token' },
    }, child)).resolves.toMatchObject({ success: true, pending: true });
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-7-document-token' },
    }, child)).resolves.toMatchObject({ success: true, pending: true });
    expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options?.frameId === 7
    ))).toBe(false);
    expect(await pageNavigationTracker.getManualContinuity(42)).toBeNull();

    releaseTopProbe({ documentToken: 'top-document-token' });
    await expect(start).resolves.toMatchObject({ success: true });
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options?.frameId === 7
    ))).toBe(true));
    const acceptedGrant = await pageNavigationTracker.getManualContinuity(42);
    expect(acceptedGrant.armed).toBe(true);
  });

  it('rejects a replaced child document queued before grant creation', async () => {
    tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: true });
    setupFrames([{ frameId: 0, response: { success: true } }]);
    let childToken = 'child-before';
    let releaseTopProbe;
    const topProbe = new Promise(resolve => { releaseTopProbe = resolve; });
    const sendMessage = browser.tabs.sendMessage.getMockImplementation();
    let heldTopProbe = true;
    browser.tabs.sendMessage.mockImplementation((...args) => {
      if (args[1].action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE && args[2]?.frameId === 7) {
        return Promise.resolve({ documentToken: childToken });
      }
      if (heldTopProbe && args[1].action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE
          && args[2]?.frameId === 0) {
        heldTopProbe = false;
        return topProbe;
      }
      return sendMessage(...args);
    });
    browser.webNavigation.getFrame.mockImplementation(async ({ frameId }) => ({
      url: frameId === 0 ? 'https://example.com' : 'https://child.example/',
    }));
    const child = { ...sender, frameId: 7 };
    const start = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(heldTopProbe).toBe(false));
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'child-before' },
    }, child)).resolves.toMatchObject({ success: true, pending: true });
    childToken = 'child-after';
    releaseTopProbe({ documentToken: 'top-document-token' });
    await expect(start).resolves.toMatchObject({ success: true });
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.filter(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE && options?.frameId === 7
    )).length).toBeGreaterThan(1));
    expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options?.frameId === 7
    ))).toBe(false);
  });

  it('rechecks an early READY after grant arming and owner release races registration', async () => {
    setupFrames([{ frameId: 0, response: { success: true } }]);
    let releaseStartProbe;
    const startProbe = new Promise(resolve => { releaseStartProbe = resolve; });
    let releaseChildProbe;
    const childProbe = new Promise(resolve => { releaseChildProbe = resolve; });
    const send = browser.tabs.sendMessage.getMockImplementation();
    let topProbeCount = 0;
    let heldChildProbe = false;
    browser.tabs.sendMessage.mockImplementation((...args) => {
      const action = args[1].action;
      const frameId = args[2]?.frameId;
      if (action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE && frameId === 0) {
        topProbeCount += 1;
        if (topProbeCount === 1) return startProbe;
      }
      if (action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE && frameId === 7 && !heldChildProbe) {
        heldChildProbe = true;
        return childProbe;
      }
      return send(...args);
    });
    const start = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(topProbeCount).toBe(1));
    const childSender = { ...sender, frameId: 7 };
    const readiness = handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-7-document-token' },
    }, childSender);
    await vi.waitFor(() => expect(heldChildProbe).toBe(true));

    releaseStartProbe({ documentToken: 'top-document-token' });
    await expect(start).resolves.toMatchObject({ success: true });
    expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({ armed: true });
    releaseChildProbe({ documentToken: 'frame-7-document-token' });
    await expect(readiness).resolves.toMatchObject({ success: true, pending: true });
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options?.frameId === 7
    ))).toBe(true));
    expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({
      documents: { 7: 'frame-7-document-token' },
    });
  });

  it('replays B READY for the same document when A registration is still dispatching', async () => {
    setupFrames([{ frameId: 0, response: { success: true } }]);
    const originalGetGrant = pageNavigationTracker.getManualContinuity.bind(pageNavigationTracker);
    let releaseARegistration;
    let grantReads = 0;
    const getGrantSpy = vi.spyOn(pageNavigationTracker, 'getManualContinuity').mockImplementation(tabId => {
      grantReads += 1;
      if (grantReads === 2) return new Promise(resolve => { releaseARegistration = resolve; });
      return originalGetGrant(tabId);
    });
    let releaseProbeA;
    let releaseProbeB;
    let topProbeCount = 0;
    const send = browser.tabs.sendMessage.getMockImplementation();
    browser.tabs.sendMessage.mockImplementation((...args) => {
      if (args[1].action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE && args[2]?.frameId === 0) {
        topProbeCount += 1;
        if (topProbeCount === 1) return new Promise(resolve => { releaseProbeA = resolve; });
        if (topProbeCount === 3) return new Promise(resolve => { releaseProbeB = resolve; });
      }
      return send(...args);
    });

    const startA = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(topProbeCount).toBe(1));
    const child = { ...sender, frameId: 7 };
    const readyA = handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-7-document-token' },
    }, child);
    await vi.waitFor(() => expect(releaseARegistration).toBeTypeOf('function'));

    await expect(revokeManualPageAuthority(42)).resolves.toBe(true);
    const startB = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(topProbeCount).toBe(3));
    const readyB = handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-7-document-token' },
    }, child);
    await expect(readyB).resolves.toMatchObject({ success: true, pending: true });
    releaseProbeB({ documentToken: 'top-document-token' });
    await expect(startB).resolves.toMatchObject({ success: true });

    releaseARegistration(null);
    await expect(readyA).resolves.toMatchObject({ success: false, reason: 'obsolete_navigation' });
    releaseProbeA({ documentToken: 'top-document-token' });
    await expect(startA).resolves.toMatchObject({ success: false });
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options?.frameId === 7
    ))).toBe(true));
    expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({ armed: true });
    getGrantSpy.mockRestore();
  });

  it('rejects an A deferred replay if B supersedes its grant during READY revalidation', async () => {
    tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: true });
    browser.webNavigation.getFrame.mockImplementation(async ({ frameId }) => ({
      url: frameId === 0 ? 'https://example.com' : 'https://child.example/',
    }));
    browser.tabs.sendMessage.mockImplementation(async (_tabId, message, { frameId }) => (
      message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE
        ? { documentToken: frameId === 0 ? 'top-document-token' : 'child-document-token' }
        : { success: true }
    ));
    await pageNavigationTracker.seed(42, [{ frameId: 0, url: 'https://example.com' }]);
    const grantA = await pageNavigationTracker.grantManualContinuity(42, undefined, {
      topDocumentToken: 'top-document-token',
    });
    await recordTopManualAcceptance(grantA);

    const originalGetGrant = pageNavigationTracker.getManualContinuity.bind(pageNavigationTracker);
    let releaseARead;
    const getGrantSpy = vi.spyOn(pageNavigationTracker, 'getManualContinuity')
      .mockImplementationOnce(() => new Promise(resolve => { releaseARead = resolve; }))
      .mockImplementation(originalGetGrant);
    const readyA = handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: {
        documentToken: 'child-document-token',
        deferredManualAttemptId: grantA.attemptId,
        deferredManualAttemptRevision: grantA.attemptRevision,
        deferredManualGeneration: grantA.generation,
      },
    }, { ...sender, frameId: 7 });
    await vi.waitFor(() => expect(releaseARead).toBeTypeOf('function'));

    const stopIntent = pageNavigationTracker.blockManualContinuity(42, grantA.generation);
    await pageNavigationTracker.revokeManualContinuity(42, grantA.generation, stopIntent);
    const revisionB = pageNavigationTracker.reserveManualContinuityStart(42);
    const grantB = await pageNavigationTracker.grantManualContinuity(42, revisionB, {
      topDocumentToken: 'top-document-token',
      attemptId: 'attempt-b',
    });
    await recordTopManualAcceptance(grantB);
    releaseARead(await originalGetGrant(42));
    await expect(readyA).resolves.toMatchObject({ success: false, reason: 'obsolete_navigation' });

    const readyB = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'child-document-token' },
    }, { ...sender, frameId: 7 });
    expect(readyB).toMatchObject({
      success: true, start: true, manualContinuityGeneration: grantB.generation,
      manualContinuityAttemptId: grantB.attemptId,
      manualContinuityAttemptRevision: grantB.attemptRevision,
    });
    getGrantSpy.mockRestore();
  });

  it.each(['cancellation', 'top navigation'])('invalidates a held top probe during %s without touching a newer start', async event => {
    setupFrames([{ frameId: 0, response: { success: true } }]);
    let releaseTopProbe;
    const topProbe = new Promise(resolve => { releaseTopProbe = resolve; });
    const sendMessage = browser.tabs.sendMessage.getMockImplementation();
    let holdFirstTopProbe = true;
    browser.tabs.sendMessage.mockImplementation((...args) => {
      if (holdFirstTopProbe && args[1].action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE
          && args[2]?.frameId === 0) {
        holdFirstTopProbe = false;
        return topProbe;
      }
      return sendMessage(...args);
    });
    const staleStart = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(holdFirstTopProbe).toBe(false));
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-7-document-token' },
    }, { ...sender, frameId: 7 })).resolves.toMatchObject({ success: true, pending: true });

    if (event === 'cancellation') {
      await revokeManualPageAuthority(42);
    } else {
      await onCommittedListener({ tabId: 42, frameId: 0, url: 'https://example.com/next', transitionType: 'link' });
    }
    await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender))
      .resolves.toMatchObject({ success: true });
    const newerGrant = await pageNavigationTracker.getManualContinuity(42);
    expect(newerGrant?.armed).toBe(true);

    releaseTopProbe({ documentToken: 'top-document-token' });
    await expect(staleStart).resolves.toMatchObject({ success: false });
    expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({
      generation: newerGrant.generation, armed: true,
    });
    expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options?.frameId === 7
    ))).toBe(false);
  });

  it('rejects a stale document challenge and excluded ad frames before admission', async () => {
    tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: true });
    await pageNavigationTracker.seed(42, [{ frameId: 0, url: 'https://example.com' }]);
    const grant = await pageNavigationTracker.grantManualContinuity(42, undefined, { topDocumentToken: 'top-document-token' });
    await recordTopManualAcceptance(grant);
    browser.webNavigation.getFrame.mockImplementation(async ({ frameId }) => ({
      url: frameId === 7 ? 'https://child.example/' : 'https://example.com',
    }));
    browser.tabs.sendMessage.mockResolvedValue({ documentToken: 'different-document' });
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'stale-document' },
    }, { ...sender, frameId: 7 })).resolves.toMatchObject({ success: false, reason: 'obsolete_navigation' });
    browser.webNavigation.getFrame.mockResolvedValue({ url: 'https://googleads.example/frame' });
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'different-document' },
    }, { ...sender, frameId: 8 })).resolves.toMatchObject({ success: false, reason: 'ineligible_frame' });
    expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({ generation: grant.generation });
  });

  it('rejects readiness when a top-document replacement wins the challenge race', async () => {
    tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: true });
    await pageNavigationTracker.seed(42, [{ frameId: 0, url: 'https://example.com' }]);
    const grant = await pageNavigationTracker.grantManualContinuity(42, undefined, { topDocumentToken: 'top-document-token' });
    await pageNavigationTracker.armManualContinuity(42, grant.generation);
    await recordTopManualAcceptance(grant);
    browser.webNavigation.getFrame.mockImplementation(async ({ frameId }) => ({
      url: frameId === 0 ? 'https://example.com' : 'https://child.example/',
    }));
    let releaseTopProbe;
    browser.tabs.sendMessage.mockImplementation((_tabId, _message, { frameId }) => (
      frameId === 0
        ? new Promise(resolve => { releaseTopProbe = resolve; })
        : Promise.resolve({ documentToken: 'child-document' })
    ));
    const ready = handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'child-document' },
    }, { ...sender, frameId: 7 });
    await vi.waitFor(() => expect(releaseTopProbe).toBeTypeOf('function'));
    await pageNavigationTracker.committed(42, 0, 'https://example.com/replaced');
    releaseTopProbe({ documentToken: 'top-document-token' });
    await expect(ready).resolves.toMatchObject({ success: false, reason: 'obsolete_navigation' });
  });

  it('rechecks an overlapping READY after arming and coalesces duplicate starts', async () => {
    tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: true });
    await pageNavigationTracker.seed(42, [{ frameId: 0, url: 'https://example.com' }]);
    const grant = await pageNavigationTracker.grantManualContinuity(42, undefined, {
      topDocumentToken: 'top-document-token',
    });
    setupFrames([{ frameId: 0, response: { success: true } }]);
    browser.webNavigation.getFrame.mockImplementation(async ({ frameId }) => ({
      url: frameId === 0 ? 'https://example.com' : 'https://child.example/',
    }));
    let releaseExclusion;
    exclusionState.check = () => new Promise(resolve => { releaseExclusion = resolve; });
    const child = { ...sender, frameId: 7 };
    const ready = handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-7-document-token' },
    }, child);
    await vi.waitFor(() => expect(releaseExclusion).toBeTypeOf('function'));

    await pageNavigationTracker.armManualContinuity(42, grant.generation);
    await recordTopManualAcceptance(grant);
    releaseExclusion(false);
    exclusionState.check = null;
    const [ticket, duplicate] = await Promise.all([ready, handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-7-document-token' },
    }, child)]);
    expect(ticket).toMatchObject({ success: true, start: true, manualContinuityGeneration: grant.generation });
    expect(duplicate).toMatchObject({ success: true, start: true });
    await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_START,
      data: { ...ticket, documentToken: 'frame-7-document-token' },
    }, child);
    expect(browser.tabs.sendMessage.mock.calls.filter(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options?.frameId === 7
    ))).toHaveLength(1);
  });

  it('carries the latest accepted attempt through dynamic iframe READY, START, batch and completion', async () => {
    tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: true });
    unifiedTranslationService.handleTranslationRequest.mockResolvedValue({ success: true });
    browser.webNavigation.getFrame.mockImplementation(async ({ frameId }) => ({
      url: frameId === 0 ? 'https://example.com' : 'https://child.example/',
    }));
    await pageNavigationTracker.seed(42, [{ frameId: 0, url: 'https://example.com' }]);
    const original = await pageNavigationTracker.grantManualContinuity(42, undefined, {
      topDocumentToken: 'top-document-token',
    });
    await pageNavigationTracker.armManualContinuity(42, original.generation);
    await recordTopManualAcceptance(original);

    const newerRevision = pageNavigationTracker.reserveManualContinuityStart(42);
    const newer = await pageNavigationTracker.grantManualContinuity(42, newerRevision, {
      topDocumentToken: 'top-document-token',
    });
    const topCursor = await pageNavigationTracker.getAdmissionCursor(42, 0);
    expect(await pageNavigationTracker.stageManualFrameAcceptance(
      42, newer.generation, newer.attemptId, newer.attemptRevision, 0,
      'top-document-token', topCursor, original.attemptId, true,
    )).toBe(true);
    expect(await pageNavigationTracker.promoteManualFrameAcceptance(
      42, newer.generation, newer.attemptId, newer.attemptRevision, 0,
      'top-document-token', topCursor, 'top-document-token', topCursor,
    )).toBe(true);
    expect(newer).toMatchObject({ reused: true, attemptRevision: newerRevision });
    expect((await pageNavigationTracker.getManualContinuity(42)).attemptId).toBe(original.attemptId);

    browser.webNavigation.getFrame.mockImplementation(async ({ frameId }) => ({
      url: frameId === 0 ? 'https://example.com' : 'https://child.example/',
    }));
    browser.tabs.sendMessage.mockImplementation(async (_tabId, message, { frameId }) => {
      if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE) {
        return { documentToken: frameId === 0 ? 'top-document-token' : 'child-document-token' };
      }
      if (message.action === MessageActions.PAGE_TRANSLATE && message.data?.origin === 'manual-frame') {
        const { manualContinuityAttemptId: attemptId, manualContinuityAttemptRevision: attemptRevision } = message.data;
        const admission = await handlePageTranslation({
          action: MessageActions.PAGE_TRANSLATE_ADMIT,
          data: { ...message.data, admissionPhase: 'accept', documentToken: 'child-document-token' },
        }, { ...sender, frameId });
        if (!admission.success) return admission;
        const batch = await handlePageTranslation({
          action: MessageActions.PAGE_TRANSLATE_BATCH,
          data: { manualContinuity: {
            generation: message.data.manualContinuityGeneration,
            topDocumentEpoch: message.data.topDocumentEpoch,
            navigationCursor: message.data.navigationCursor,
            attemptId, attemptRevision, documentToken: 'child-document-token',
          } },
        }, { ...sender, frameId });
        expect(batch.success).toBe(true);
        return { success: true, documentToken: 'child-document-token' };
      }
      return { success: true };
    });

    const child = { ...sender, frameId: 7 };
    const ticket = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'child-document-token' },
    }, child);
    expect(ticket).toMatchObject({
      success: true, start: true, manualContinuityAttemptId: newer.attemptId,
      manualContinuityAttemptRevision: newer.attemptRevision,
    });
    const started = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_START, data: ticket,
    }, child);
    expect(started).toMatchObject({ success: true });
    const grant = await pageNavigationTracker.getManualContinuity(42);
    expect(grant.acceptedAttemptIds[7]).toBe(newer.attemptId);
    expect(grant.acceptedAttemptRevisions[7]).toBe(String(newer.attemptRevision));
    expect(grant.startedDocuments[7]).toBe('child-document-token');

    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_START, data: ticket,
    }, child)).resolves.toMatchObject({ success: true, skipped: true });
    expect(browser.tabs.sendMessage.mock.calls.filter(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options?.frameId === 7
    ))).toHaveLength(1);
  });

  it('fails the initial manual start closed when the top document cannot answer its identity probe', async () => {
    setupFrames([{ frameId: 0, response: { success: true } }]);
    browser.tabs.sendMessage.mockImplementation(async (_tabId, message) => (
      message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE ? undefined : { success: true }
    ));

    await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender))
      .resolves.toMatchObject({ success: false, reason: 'manual_continuity_top_identity_unavailable' });
    expect((await pageNavigationTracker.getManualContinuity(42))).toBeNull();
  });

  it('rejects READY and START after worker restart when a same-URL top document has a different nonce', async () => {
    tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: true });
    await pageNavigationTracker.seed(42, [{ frameId: 0, url: 'https://example.com' }]);
    const grant = await pageNavigationTracker.grantManualContinuity(42, undefined, {
      topDocumentToken: 'original-top-document',
    });
    await pageNavigationTracker.armManualContinuity(42, grant.generation);
    const admission = await pageNavigationTracker.admitManualFrame(
      42, 7, grant.generation, grant.topDocumentEpoch, grant.topDocumentToken,
      'https://child.example/', 'child-document',
    );
    pageNavigationTracker.state = null;
    pageNavigationTracker.durableState = null;
    pageNavigationTracker.pending = Promise.resolve();
    browser.webNavigation.getFrame.mockImplementation(async ({ frameId }) => ({
      url: frameId === 0 ? 'https://example.com' : 'https://child.example/',
    }));
    browser.tabs.sendMessage.mockImplementation(async (_tabId, _message, { frameId }) => ({
      documentToken: frameId === 0 ? 'replacement-top-document' : 'child-document',
    }));
    const child = { ...sender, frameId: 7 };

    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'child-document' },
    }, child)).resolves.toMatchObject({ success: false, reason: 'obsolete_navigation' });
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_START,
      data: {
        documentToken: 'child-document',
        manualContinuityGeneration: grant.generation,
        manualContinuityAttemptRevision: grant.attemptRevision,
        manualContinuityAttemptId: grant.attemptId,
        topDocumentEpoch: grant.topDocumentEpoch,
        navigationCursor: admission.cursor,
      },
    }, child)).resolves.toMatchObject({ success: false, reason: 'obsolete_navigation' });
    expect(browser.tabs.sendMessage.mock.calls.filter(([, message]) => message.action === MessageActions.PAGE_TRANSLATE))
      .toHaveLength(0);
  });

  it.each([MessageActions.PAGE_RESTORE, MessageActions.PAGE_TRANSLATE_STOP_AUTO])(
    'does not send a child START when %s invalidates during the final identity probe', async invalidationAction => {
      setupFrames([
        { frameId: 0, response: { success: true } },
        { frameId: 7, response: { success: true } },
      ]);
      await pageNavigationTracker.seed(42, [
        { frameId: 0, url: 'https://example.com' },
        { frameId: 7, url: 'https://frame-7.example' },
      ]);
      const grant = await pageNavigationTracker.grantManualContinuity(42, undefined, {
        topDocumentToken: 'top-document-token',
      });
      await pageNavigationTracker.armManualContinuity(42, grant.generation);
      await recordTopManualAcceptance(grant);
      const admission = await pageNavigationTracker.admitManualFrame(
        42, 7, grant.generation, grant.topDocumentEpoch, grant.topDocumentToken,
        'https://frame-7.example', 'child-document-token',
      );
      let topProbeCount = 0;
      let releaseFinalProbe;
      browser.tabs.sendMessage.mockImplementation(async (_tabId, message, { frameId }) => {
        if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE) {
          if (frameId === 0 && ++topProbeCount === 2) {
            return new Promise(resolve => { releaseFinalProbe = resolve; });
          }
          return { documentToken: frameId === 0 ? 'top-document-token' : 'child-document-token' };
        }
        return { success: true };
      });
      const child = { ...sender, frameId: 7 };
      const start = handlePageTranslation({
        action: MessageActions.PAGE_TRANSLATE_FRAME_START,
        data: {
          documentToken: 'child-document-token',
          manualContinuityGeneration: grant.generation,
          manualContinuityAttemptRevision: grant.attemptRevision,
          manualContinuityAttemptId: grant.attemptId,
          topDocumentEpoch: grant.topDocumentEpoch,
          navigationCursor: admission.cursor,
        },
      }, child);
      await vi.waitFor(() => expect(releaseFinalProbe).toBeTypeOf('function'));
      await handlePageTranslation({ action: invalidationAction, data: {} }, sender);
      releaseFinalProbe({ documentToken: 'top-document-token' });

      await expect(start).resolves.toMatchObject({ success: false, reason: 'obsolete_navigation' });
      expect(browser.tabs.sendMessage.mock.calls.some(([, message]) => message.action === MessageActions.PAGE_TRANSLATE))
        .toBe(false);
    }
  );

  it('rejects a READY ticket when the child SPA route advances during its identity challenge', async () => {
    tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: true });
    const oldUrl = 'https://child.example/route-a';
    let childUrl = oldUrl;
    await pageNavigationTracker.seed(42, [
      { frameId: 0, url: 'https://example.com' },
      { frameId: 7, url: oldUrl },
    ]);
    const grant = await pageNavigationTracker.grantManualContinuity(42, undefined, {
      topDocumentToken: 'top-document-token',
    });
    await recordTopManualAcceptance(grant);
    browser.webNavigation.getFrame.mockImplementation(async ({ frameId }) => ({
      url: frameId === 0 ? 'https://example.com' : childUrl,
    }));
    let releaseChildProbe;
    browser.tabs.sendMessage.mockImplementation(async (_tabId, _message, { frameId }) => (
      frameId === 7
        ? new Promise(resolve => { releaseChildProbe = resolve; })
        : { documentToken: 'top-document-token' }
    ));
    const ready = handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'child-document-token' },
    }, { ...sender, frameId: 7 });
    await vi.waitFor(() => expect(releaseChildProbe).toBeTypeOf('function'));
    childUrl = 'https://child.example/route-b';
    await pageNavigationTracker.capture(42, 7, childUrl);
    releaseChildProbe({ documentToken: 'child-document-token' });

    await expect(ready).resolves.toMatchObject({ success: false, reason: 'obsolete_navigation' });
    expect((await pageNavigationTracker.getCursor(42, 7)).url).toBe(childUrl);
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
    expect(browser.tabs.sendMessage.mock.calls.some(([, message]) => message.action === MessageActions.PAGE_TRANSLATE)).toBe(false);
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
    expect(browser.tabs.sendMessage.mock.calls.find(([, message]) => message.action === MessageActions.PAGE_TRANSLATE)[1].data.navigationCursor.url)
      .toBe('https://example.com/new');
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
    expect(browser.tabs.sendMessage.mock.calls.find(([, message]) => message.action === MessageActions.PAGE_TRANSLATE)[1].data.navigationCursor)
      .toMatchObject({ routeRevision: 1, url: 'https://example.com/new' });
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
      expect(browser.tabs.sendMessage.mock.calls.find(([, message]) => message.action === MessageActions.PAGE_TRANSLATE)[1].data.navigationCursor)
        .toMatchObject({ routeRevision: 1, url: 'https://example.com/later' });
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
      expect(browser.tabs.sendMessage.mock.calls.find(([, message]) => message.action === MessageActions.PAGE_TRANSLATE)[1].data)
        .toMatchObject({ navigationUnavailable: true });
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

  it('keeps the active attempt through a BUSY reused start and rejects its delayed invalidation after replacement acceptance', async () => {
    setupFrames([{ frameId: 0, response: { success: true } }]);
    await pageNavigationTracker.seed(42, [{ frameId: 0, url: 'https://example.com' }]);
    const firstRevision = pageNavigationTracker.reserveManualContinuityStart(42);
    const active = await pageNavigationTracker.grantManualContinuity(42, firstRevision, {
      topDocumentToken: 'top-document-token',
    });
    await pageNavigationTracker.armManualContinuity(42, active.generation, firstRevision);
    const cursor = await pageNavigationTracker.getAdmissionCursor(42, 0);
    await pageNavigationTracker.recordManualFrameAcceptance(
      42, active.generation, active.attemptId, active.attemptRevision,
      0, 'top-document-token', cursor, active.attemptId,
    );
    const previousAttemptId = active.attemptId;
    let releaseBusy;
    let translateCount = 0;
    browser.tabs.sendMessage.mockImplementation((_tabId, message, options = {}) => {
      const frameId = options.frameId ?? 0;
      if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE) {
        return Promise.resolve({ documentToken: frameId === 0 ? 'top-document-token' : 'frame-7-document-token' });
      }
      if (message.action === MessageActions.PAGE_TRANSLATE && ++translateCount === 1) {
        return new Promise(resolve => { releaseBusy = resolve; });
      }
      if (message.action === MessageActions.PAGE_TRANSLATE) {
        return handlePageTranslation({
          action: MessageActions.PAGE_TRANSLATE_ADMIT,
          data: {
            ...message.data,
            origin: 'manual-start',
            admissionPhase: 'accept',
            documentToken: frameId === 0 ? 'top-document-token' : 'frame-7-document-token',
          },
        }, { ...sender, frameId }).then(admission => (
          admission.success ? {
            success: true,
            documentToken: frameId === 0 ? 'top-document-token' : 'frame-7-document-token',
          } : admission
        ));
      }
      return Promise.resolve({ success: true });
    });
    const busyStart = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
    await vi.waitFor(() => expect(releaseBusy).toBeTypeOf('function'));
    const staged = await pageNavigationTracker.getManualContinuity(42);
    const pendingStartMessage = browser.tabs.sendMessage.mock.calls
      .find(([, sent]) => sent.action === MessageActions.PAGE_TRANSLATE)[1];
    expect(staged.attemptId).toBe(previousAttemptId);
    expect(pendingStartMessage.data.manualContinuityAttemptId).not.toBe(previousAttemptId);
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_ADMIT,
      data: {
        ...pendingStartMessage.data,
        origin: 'manual-start',
        documentToken: 'top-document-token',
      },
    }, { ...sender, frameId: 0 })).resolves.toMatchObject({ success: true });
    const oldReport = {
      action: MessageActions.PAGE_TRANSLATE_STOP_AUTO,
      data: {
        settingsInvalidation: true,
        expectedManualContinuityGeneration: active.generation,
        manualContinuityAttemptRevision: active.attemptRevision,
        manualContinuityAttemptId: active.attemptId,
        topDocumentEpoch: active.topDocumentEpoch,
        documentToken: 'top-document-token',
      },
    };
    await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender))
      .resolves.toMatchObject({ reason: 'manual_start_pending' });
    releaseBusy({ success: false, reason: 'BUSY_OR_DONE' });
    await expect(busyStart).resolves.toMatchObject({ success: false });
    const stillActive = await pageNavigationTracker.getManualContinuity(42);
    expect(stillActive.attemptId).toBe(previousAttemptId);
    expect(stillActive.acceptedAttemptIds[0]).toBe(previousAttemptId);
    expect(await pageNavigationTracker.validateManualContinuityBatch(
      42, 0, active.generation, active.topDocumentEpoch, cursor,
      active.attemptRevision, active.attemptId,
    )).toBe(true);

    await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender))
      .resolves.toMatchObject({ success: true });
    const replacement = await pageNavigationTracker.getManualContinuity(42);
    expect(replacement.generation).toBe(active.generation);
    const acceptedAttemptId = replacement.acceptedAttemptIds[0];
    const acceptedAttemptRevision = Number(replacement.acceptedAttemptRevisions[0]);
    expect(acceptedAttemptId).not.toBe(previousAttemptId);
    const fence = pageNavigationTracker.getRestartFence(42);
    await expect(handlePageTranslation(oldReport, { ...sender, frameId: 0 }))
      .resolves.toMatchObject({ success: false, reason: 'manual_continuity_stop_superseded' });
    expect(pageNavigationTracker.getRestartFence(42)).toBe(fence);
    const currentReport = {
      ...oldReport,
      data: {
        ...oldReport.data,
        manualContinuityAttemptRevision: acceptedAttemptRevision,
        manualContinuityAttemptId: acceptedAttemptId,
      },
    };
    await expect(handlePageTranslation(currentReport, { ...sender, frameId: 0 }))
      .resolves.toMatchObject({ success: true });
  });

  it('allows an accepted same-frame invalidation during replacement provisional admission', async () => {
    const grant = await startManualPage();
    const childCursor = await pageNavigationTracker.getAdmissionCursor(42, 7);
    await pageNavigationTracker.recordManualFrameAcceptance(
      42, grant.generation, grant.attemptId, grant.attemptRevision,
      7, 'frame-7-document-token', childCursor, grant.attemptId,
    );
    let resolveOldTopProbe;
    let holdOldTopProbe = true;
    const pendingStarts = [];
    browser.webNavigation.getFrame.mockImplementation(async ({ frameId }) => ({
      url: frameId === 0 ? 'https://example.com' : 'https://frame-7.example',
    }));
    browser.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 0, url: 'https://example.com' },
      { frameId: 7, url: 'https://frame-7.example' },
    ]);
    browser.tabs.sendMessage.mockImplementation((_tabId, message, options = {}) => {
      const frameId = options.frameId ?? 0;
      if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE) {
        if (frameId === 0 && holdOldTopProbe) {
          holdOldTopProbe = false;
          return new Promise(resolve => { resolveOldTopProbe = resolve; });
        }
        return Promise.resolve({
          documentToken: frameId === 0 ? 'top-document-token' : 'frame-7-document-token',
        });
      }
      if (message.action === MessageActions.PAGE_TRANSLATE) {
        return new Promise(resolve => pendingStarts.push({ frameId, message, resolve }));
      }
      return Promise.resolve({ success: true });
    });
    const invalidation = {
      action: MessageActions.PAGE_TRANSLATE_STOP_AUTO,
      data: {
        settingsInvalidation: true,
        expectedManualContinuityGeneration: grant.generation,
        manualContinuityAttemptRevision: grant.attemptRevision,
        manualContinuityAttemptId: grant.attemptId,
        topDocumentEpoch: grant.topDocumentEpoch,
        documentToken: 'frame-7-document-token',
      },
    };
    const delayedInvalidation = handlePageTranslation(invalidation, { ...sender, frameId: 7 });
    await vi.waitFor(() => expect(resolveOldTopProbe).toBeTypeOf('function'));

    const replacementStart = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
    await vi.waitFor(() => expect(pendingStarts).toHaveLength(2));
    const candidate = pendingStarts[0].message.data;
    const pendingGrant = await pageNavigationTracker.getManualContinuity(42);
    expect(pendingGrant).toMatchObject({
      generation: grant.generation,
      attemptId: grant.attemptId,
    });
    expect(candidate.manualContinuityAttemptId).not.toBe(grant.attemptId);
    const childStart = pendingStarts.find(({ frameId }) => frameId === 7);
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_ADMIT,
      data: {
        ...childStart.message.data,
        origin: 'manual-start',
        admissionPhase: 'accept',
        documentToken: 'frame-7-document-token',
      },
    }, { ...sender, frameId: 7 })).resolves.toMatchObject({ success: true });
    resolveOldTopProbe({ documentToken: 'top-document-token' });
    await expect(delayedInvalidation).resolves.toMatchObject({ success: true });
    expect(await pageNavigationTracker.getManualContinuity(42)).toBeNull();

    for (const pending of pendingStarts) {
      pending.resolve({
        success: true,
        documentToken: pending.frameId === 0 ? 'top-document-token' : 'frame-7-document-token',
      });
    }
    await expect(replacementStart).resolves.toMatchObject({ success: true });
    expect(await pageNavigationTracker.getManualContinuity(42)).toBeNull();
    expect(candidate.manualContinuityAttemptId).not.toBe(grant.attemptId);
  });

  it('retains the accepted same-frame tuple when a provisionally admitted replacement returns BUSY', async () => {
    const original = await startManualPage();
    browser.webNavigation.getAllFrames.mockResolvedValue([{ frameId: 0, url: 'https://example.com' }]);
    let releaseBusy;
    let replacementId;
    let replacementRevision;
    browser.tabs.sendMessage.mockImplementation(async (_tabId, message, { frameId }) => {
      if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE) {
        return { documentToken: 'top-document-token' };
      }
      if (message.action === MessageActions.PAGE_TRANSLATE) {
        replacementId = message.data.manualContinuityAttemptId;
        replacementRevision = message.data.manualContinuityAttemptRevision;
        const admission = await handlePageTranslation({
          action: MessageActions.PAGE_TRANSLATE_ADMIT,
          data: {
            ...message.data,
            origin: 'manual-start',
            admissionPhase: 'accept',
            documentToken: 'top-document-token',
          },
        }, { ...sender, frameId });
        expect(admission).toEqual({ success: true });
        return new Promise(resolve => { releaseBusy = resolve; });
      }
      return { success: true };
    });

    const replacementStart = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
    await vi.waitFor(() => expect(releaseBusy).toBeTypeOf('function'));
    const provisional = await pageNavigationTracker.getManualContinuity(42);
    expect(provisional.acceptedAttemptIds[0]).toBe(original.attemptId);
    expect(provisional.provisionalAttemptIds[0]).toBe(replacementId);
    const cursor = await pageNavigationTracker.getAdmissionCursor(42, 0);
    expect(await pageNavigationTracker.validateManualContinuityBatch(
      42, 0, original.generation, original.topDocumentEpoch, cursor,
      replacementRevision, replacementId, 'top-document-token',
    )).toBe(true);

    releaseBusy({
      success: false,
      reason: ActionReasons.BUSY_OR_DONE,
      documentToken: 'top-document-token',
    });
    await expect(replacementStart).resolves.toMatchObject({ success: false, reason: ActionReasons.BUSY_OR_DONE });
    const afterBusy = await pageNavigationTracker.getManualContinuity(42);
    expect(afterBusy.acceptedAttemptIds[0]).toBe(original.attemptId);
    expect(afterBusy.provisionalAttemptIds).toBeUndefined();
    expect(await pageNavigationTracker.validateManualContinuityBatch(
      42, 0, original.generation, original.topDocumentEpoch, cursor,
      original.attemptRevision, original.attemptId, 'top-document-token',
    )).toBe(true);
  });

  it('authorizes invalidation only from the frame whose start was accepted', async () => {
    setupFrames([
      { frameId: 0, response: { success: false } },
      { frameId: 7, response: { success: true } },
    ]);
    browser.tabs.sendMessage.mockImplementation((_tabId, message, options) => {
      if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE) {
        return Promise.resolve({
          documentToken: options.frameId === 0 ? 'top-document-token' : 'child-document-token',
        });
      }
      if (message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7) {
        return handlePageTranslation({
          action: MessageActions.PAGE_TRANSLATE_ADMIT,
          data: {
            ...message.data,
            origin: 'manual-start',
            admissionPhase: 'accept',
            documentToken: 'child-document-token',
          },
        }, { ...sender, frameId: 7 }).then(admission => (
          admission.success ? { success: true, documentToken: 'child-document-token' } : admission
        ));
      }
      if (message.action === MessageActions.PAGE_TRANSLATE) return Promise.resolve({ success: false });
      return Promise.resolve({ success: true });
    });
    const start = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
    expect(start.success).toBe(true);
    const grant = await pageNavigationTracker.getManualContinuity(42);
    expect(grant.acceptedAttemptIds).toEqual({ 7: grant.attemptId });
    expect(grant.acceptedAttemptRevisions).toEqual({ 7: String(grant.attemptRevision) });
    const baseData = {
      settingsInvalidation: true,
      expectedManualContinuityGeneration: grant.generation,
      manualContinuityAttemptRevision: grant.attemptRevision,
      manualContinuityAttemptId: grant.attemptId,
      topDocumentEpoch: grant.topDocumentEpoch,
    };
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_STOP_AUTO,
      data: { ...baseData, documentToken: 'top-document-token' },
    }, { ...sender, frameId: 0 })).resolves.toMatchObject({
      success: false, reason: 'manual_continuity_stop_superseded',
    });
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_STOP_AUTO,
      data: { ...baseData, documentToken: 'child-document-token' },
    }, { ...sender, frameId: 7 })).resolves.toMatchObject({ success: true });
  });

  it('does not reserve a late active-tab owner after pre-fanout timeout', async () => {
    vi.useFakeTimers();
    try {
      let resolveQuery;
      browser.tabs.query.mockImplementationOnce(() => new Promise(resolve => { resolveQuery = resolve; }));
      const expired = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, {});
      await vi.waitFor(() => expect(resolveQuery).toBeTypeOf('function'));
      await vi.advanceTimersByTimeAsync(PRE_FANOUT_TIMEOUT_MS);
      await expect(expired).resolves.toMatchObject({ reason: PRE_FANOUT_TIMEOUT_REASON });
      resolveQuery([{ id: 42 }]);
      await Promise.resolve();
      await Promise.resolve();
      setupFrames([{ frameId: 0, response: { success: true } }]);
      await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, {}))
        .resolves.toMatchObject({ success: true });
      expect(browser.tabs.sendMessage.mock.calls.some(([, message]) => message.action === MessageActions.PAGE_TRANSLATE)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a timed-out manual owner after an internal batch abort without late promotion', async () => {
    vi.useFakeTimers();
    try {
      setupFrames([{ frameId: 0, response: { success: true } }]);
      let resolveStart;
      let startMessage;
      browser.tabs.sendMessage.mockImplementation((_tabId, message) => (
        message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE
          ? { documentToken: 'top-document-token' }
          : message.action === MessageActions.PAGE_TRANSLATE
            ? (startMessage = message, new Promise(resolve => { resolveStart = resolve; }))
            : { success: true }
      ));
      const start = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
      await vi.waitFor(() => expect(resolveStart).toBeTypeOf('function'));
      const revision = pageNavigationTracker.manualContinuityRevision.get(42);
      await handlePageTranslation({
        action: MessageActions.CANCEL_TRANSLATION,
        data: { context: MessageContexts.PAGE_TRANSLATION_BATCH, reason: 'operation-abort' },
      }, sender);
      expect(pageNavigationTracker.manualContinuityRevision.get(42)).toBe(revision);
      await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender))
        .resolves.toMatchObject({ reason: 'manual_start_pending' });
      await expect(acceptManualPageCommand(42, startMessage)).resolves.toMatchObject({ success: true });
      resolveStart({ success: true, documentToken: 'top-document-token' });
      await expect(start).resolves.toMatchObject({ success: true });
      expect((await pageNavigationTracker.getManualContinuity(42))?.armed).toBe(true);
      expect(startMessage.data.manualContinuityAttemptId).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    MessageActions.PAGE_TRANSLATE_STOP_AUTO,
    MessageActions.PAGE_RESTORE,
    MessageActions.CANCEL_TRANSLATION,
  ])('does not release a live owner for stale %s generation', async action => {
    vi.useFakeTimers();
    try {
      setupFrames([
        { frameId: 0, response: { success: true } },
        { frameId: 7, response: { success: true } },
      ]);
      let resolveStart;
      let startMessage;
      browser.tabs.sendMessage.mockImplementation((_tabId, message, options) => {
        if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE) {
          return { documentToken: options.frameId === 7 ? 'frame-7-document-token' : 'top-document-token' };
        }
        if (message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 0) {
          startMessage = message;
          return new Promise(resolve => { resolveStart = resolve; });
        }
        return { success: true };
      });
      const start = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
      await vi.waitFor(() => expect(resolveStart).toBeTypeOf('function'));
      const grant = await pageNavigationTracker.getManualContinuity(42);
      const revision = pageNavigationTracker.manualContinuityRevision.get(42);
      await expect(handlePageTranslation({
        action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
        data: { documentToken: 'frame-7-document-token' },
      }, { ...sender, frameId: 7, documentId: 'frame-7-browser-document' }))
        .resolves.toMatchObject({ success: true, pending: true });
      const restartFence = pageNavigationTracker.mintRestartFence(42);
      await handlePageTranslation({
        action,
        data: { expectedManualContinuityGeneration: grant.generation + 1 },
      }, sender);
      expect(pageNavigationTracker.getRestartFence(42)).toBe(restartFence);
      expect(pageNavigationTracker.manualContinuityRevision.get(42)).toBe(revision);
      await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender))
        .resolves.toMatchObject({ reason: 'manual_start_pending' });
      await expect(acceptManualPageCommand(42, startMessage)).resolves.toMatchObject({ success: true });
      resolveStart({ success: true, documentToken: 'top-document-token' });
      await vi.waitFor(async () => expect((await pageNavigationTracker.getManualContinuity(42))?.armed).toBe(true));
      await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message, target]) => (
        message.action === MessageActions.PAGE_TRANSLATE && target.frameId === 7
      ))).toBe(true));
      await start;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not arm a timed-out start after authoritative Stop replaces its owner', async () => {
    vi.useFakeTimers();
    try {
      setupFrames([{ frameId: 0, response: { success: true } }]);
      let resolveStart;
      browser.tabs.sendMessage.mockImplementation((_tabId, message) => {
        if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE) return { documentToken: 'top-document-token' };
        if (message.action === MessageActions.PAGE_TRANSLATE) return new Promise(resolve => { resolveStart = resolve; });
        return { success: true };
      });
      const start = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
      await vi.waitFor(() => expect(resolveStart).toBeTypeOf('function'));
      await vi.advanceTimersByTimeAsync(6000);
      await expect(start).resolves.toMatchObject({ reason: 'frame_command_response_timeout' });
      const stopped = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE_STOP_AUTO }, sender);
      expect(stopped).toMatchObject({ success: true, hasManualContinuity: false });
      resolveStart({ success: true });
      await Promise.resolve();
      await Promise.resolve();
      expect(await pageNavigationTracker.getManualContinuity(42)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not arm a late accepted manual start after Select takeover revoked its pending owner', async () => {
    setupFrames([{ frameId: 0, response: null }]);
    let resolveStart;
    browser.tabs.sendMessage.mockImplementation((_tabId, message) => {
      if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE) {
        return Promise.resolve({ documentToken: 'top-document-token' });
      }
      if (message.action === MessageActions.PAGE_TRANSLATE) {
        return new Promise(resolve => { resolveStart = resolve; });
      }
      return Promise.resolve({ success: true });
    });
    const start = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
    await vi.waitFor(() => expect(resolveStart).toBeTypeOf('function'));
    expect(await revokeManualPageAuthority(42)).toBe(true);
    resolveStart({ success: true });
    await start;
    expect(await pageNavigationTracker.getManualContinuity(42)).toBeNull();
  });

  it('invalidates a pending Select takeover owner before a provisional grant exists', async () => {
    setupFrames([{ frameId: 0, response: { success: true } }]);
    let releaseTopProbe;
    browser.tabs.sendMessage.mockImplementation((_tabId, message) => {
      if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE) {
        return new Promise(resolve => { releaseTopProbe = () => resolve({ documentToken: 'top-document-token' }); });
      }
      return Promise.resolve({ success: true });
    });
    const start = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
    await vi.waitFor(() => expect(releaseTopProbe).toBeTypeOf('function'));
    expect(await revokeManualPageAuthority(42)).toBe(true);
    releaseTopProbe();
    await expect(start).resolves.toMatchObject({ success: false, reason: 'manual_continuity_top_identity_unavailable' });
    expect(await pageNavigationTracker.getManualContinuity(42)).toBeNull();
  });

  it('serializes Select takeover behind a grant write already in flight', async () => {
    setupFrames([{ frameId: 0, response: { success: true } }]);
    let finishGrantWrite;
    browser.storage.session.set.mockImplementation(value => {
      const grant = value.pageTranslationNavigation?.manualContinuity?.[42];
      if (grant && !grant.revoked) {
        return new Promise(resolve => {
          finishGrantWrite = () => {
            navigationStore.saved = structuredClone(value);
            resolve();
          };
        });
      }
      navigationStore.saved = structuredClone(value);
      return Promise.resolve();
    });
    browser.tabs.sendMessage.mockImplementation((_tabId, message) => (
      message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE
        ? Promise.resolve({ documentToken: 'top-document-token' })
        : Promise.resolve({ success: true })
    ));
    const start = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
    await vi.waitFor(() => expect(finishGrantWrite).toBeTypeOf('function'));
    let takeoverSettled = false;
    const takeover = revokeManualPageAuthority(42).then(result => {
      takeoverSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(takeoverSettled).toBe(false);
    finishGrantWrite();
    browser.storage.session.set.mockImplementation(async value => {
      navigationStore.saved = structuredClone(value);
    });
    expect(await takeover).toBe(true);
    await start;
    expect(await pageNavigationTracker.getManualContinuity(42)).toBeNull();
    expect(navigationStore.saved.pageTranslationNavigation.manualContinuity[42]).toMatchObject({
      revoked: true,
    });
  });

  it.each([
    MessageActions.PAGE_TRANSLATE_STOP_AUTO,
    MessageActions.PAGE_RESTORE,
    MessageActions.CANCEL_TRANSLATION,
  ])('releases only the matching owner for %s and ignores its late acceptance', async action => {
    vi.useFakeTimers();
    try {
      setupFrames([{ frameId: 0, response: { success: true } }]);
      let resolveFirstStart;
      let translateCount = 0;
      browser.tabs.sendMessage.mockImplementation((_tabId, message, options = {}) => {
        if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE) return { documentToken: 'top-document-token' };
        if (message.action === MessageActions.PAGE_TRANSLATE) {
          translateCount += 1;
        return translateCount === 1
          ? new Promise(resolve => { resolveFirstStart = resolve; })
          : acceptManualPageCommand(42, message, options.frameId ?? 0)
              .then(admission => admission.success
                ? { success: true, documentToken: 'top-document-token' } : admission);
        }
        return { success: true };
      });
      const firstStart = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);
      await vi.waitFor(() => expect(resolveFirstStart).toBeTypeOf('function'));
      const grant = await pageNavigationTracker.getManualContinuity(42);
      await handlePageTranslation({ action, data: { expectedManualContinuityGeneration: grant.generation } }, sender);
      await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender))
        .resolves.toMatchObject({ success: true });
      const replacement = await pageNavigationTracker.getManualContinuity(42);
      expect(replacement.generation).toBeGreaterThan(grant.generation);
      resolveFirstStart({ success: true });
      await Promise.resolve();
      await Promise.resolve();
      expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({
        generation: replacement.generation,
        armed: true,
      });
      await firstStart;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an existing grant when a duplicate manual Start is rejected as busy after child reload', async () => {
    const grant = await startManualPage();
    await pageNavigationTracker.committed(42, 7, 'https://frame-7.example/reloaded');
    setupFrames([
      { frameId: 0, response: { success: false, reason: ActionReasons.BUSY_OR_DONE } },
      { frameId: 7, response: { success: false, reason: ActionReasons.BUSY_OR_DONE } },
    ]);

    const result = await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE }, sender);

    expect(result).toMatchObject({ success: false, reason: ActionReasons.BUSY_OR_DONE });
    expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({
      generation: grant.generation, armed: true, frames: { 0: grant.frames[0] },
    });
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
    const newGrant = await pageNavigationTracker.grantManualContinuity(42, undefined, { topDocumentToken: 'top-document-token' });

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
        manualContinuityAttemptRevision: grant.attemptRevision,
        manualContinuityAttemptId: grant.attemptId,
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
        manualContinuityAttemptRevision: grant.attemptRevision,
        manualContinuityAttemptId: grant.attemptId,
        topDocumentEpoch: grant.topDocumentEpoch,
        topDocumentToken: grant.topDocumentToken,
        documentToken: frameId === 0 ? 'top-document-token' : 'frame-7-document-token',
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
      attemptRevision: grant.acceptedAttemptRevisions[0] ? Number(grant.acceptedAttemptRevisions[0]) : grant.attemptRevision,
      attemptId: grant.acceptedAttemptIds[0],
      topDocumentEpoch: grant.topDocumentEpoch,
      navigationCursor,
      documentToken: grant.acceptedDocuments[0],
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

    unifiedTranslationService.handleTranslationRequest.mockClear();
    await expect(handlePageTranslation({
      ...message,
      data: { manualContinuity: { ...authorization, attemptId: 'unaccepted-attempt' } },
    }, contentSender)).resolves.toEqual({ success: false, reason: 'manual_continuity_revoked' });
    expect(unifiedTranslationService.handleTranslationRequest).not.toHaveBeenCalled();

    const replacementRevision = pageNavigationTracker.reserveManualContinuityStart(42);
    const replacement = await pageNavigationTracker.grantManualContinuity(42, replacementRevision, {
      topDocumentToken: grant.topDocumentToken,
    });
    expect(await pageNavigationTracker.stageManualFrameAcceptance(
      42, grant.generation, replacement.attemptId, replacement.attemptRevision,
      0, 'top-document-token', navigationCursor, grant.attemptId, true,
    )).toBe(true);
    unifiedTranslationService.handleTranslationRequest.mockClear();
    await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_BATCH,
      data: { manualContinuity: {
        ...authorization,
        attemptRevision: replacement.attemptRevision,
        attemptId: replacement.attemptId,
        documentToken: 'top-document-token',
      } },
    }, contentSender);
    expect(unifiedTranslationService.handleTranslationRequest).toHaveBeenCalledOnce();

    unifiedTranslationService.handleTranslationRequest.mockClear();
    await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE_STOP_AUTO }, sender);
    expect(await handlePageTranslation(message, contentSender)).toEqual({
      success: false,
      reason: 'manual_continuity_revoked',
    });
    expect(unifiedTranslationService.handleTranslationRequest).not.toHaveBeenCalled();
  });

  it('replays exact provisional settings-report proof from a revoked tombstone', async () => {
    const accepted = await startManualPage();
    const replacementRevision = pageNavigationTracker.reserveManualContinuityStart(42);
    const replacement = await pageNavigationTracker.grantManualContinuity(42, replacementRevision, {
      topDocumentToken: accepted.topDocumentToken,
    });
    const cursor = await pageNavigationTracker.getAdmissionCursor(42, 0);
    expect(await pageNavigationTracker.stageManualFrameAcceptance(
      42, accepted.generation, replacement.attemptId, replacement.attemptRevision,
      0, accepted.topDocumentToken, cursor, accepted.attemptId, true,
    )).toBe(true);
    const report = {
      action: MessageActions.PAGE_TRANSLATE_STOP_AUTO,
      data: {
        settingsInvalidation: true,
        expectedManualContinuityGeneration: accepted.generation,
        manualContinuityAttemptRevision: replacement.attemptRevision,
        manualContinuityAttemptId: replacement.attemptId,
        topDocumentEpoch: accepted.topDocumentEpoch,
        documentToken: accepted.topDocumentToken,
      },
    };

    setupFrames([
      { frameId: 0, error: new Error('first stop delivery unavailable') },
      { frameId: 7, response: { success: true } },
    ]);
    await expect(handlePageTranslation(report, { ...sender, frameId: 0 }))
      .resolves.toMatchObject({ success: false, reason: 'manual_continuity_stop_delivery_uncertain' });
    expect(await pageNavigationTracker.getManualContinuity(42)).toBeNull();
    expect((await pageNavigationTracker.getManualContinuityForRevocation(42)).revokedProvisionalAttemptIds)
      .toMatchObject({ 0: replacement.attemptId });

    setupFrames([
      { frameId: 0, response: { success: true } },
      { frameId: 7, response: { success: true } },
    ]);
    await expect(handlePageTranslation(report, { ...sender, frameId: 0 }))
      .resolves.toMatchObject({ success: true });
    expect(await pageNavigationTracker.getManualContinuity(42)).toBeNull();
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
      responses: [mainResponse, { ...childResponse, documentToken: 'frame-1-document-token' }],
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

  it('bounds a stalled top-document probe and allows a fresh start afterward', async () => {
    vi.useFakeTimers();
    try {
      setupFrames([{ frameId: 0, response: { success: true } }]);
      let releaseProbe;
      let firstProbe = true;
      const send = browser.tabs.sendMessage.getMockImplementation();
      browser.tabs.sendMessage.mockImplementation((...args) => {
        if (firstProbe && args[1].action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE
            && args[2]?.frameId === 0) {
          firstProbe = false;
          return new Promise(resolve => { releaseProbe = resolve; });
        }
        return send(...args);
      });
      const timedOut = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
      await vi.advanceTimersByTimeAsync(PRE_FANOUT_TIMEOUT_MS);
      await expect(timedOut).resolves.toMatchObject({
        success: false, reason: PRE_FANOUT_TIMEOUT_REASON, isTransportFailure: true,
      });
      releaseProbe({ documentToken: 'top-document-token' });
      await Promise.resolve();
      await expect(pageNavigationTracker.getManualContinuity(42)).resolves.toBeNull();
      await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender))
        .resolves.toMatchObject({ success: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves an existing armed grant when replacement preparation times out', async () => {
    vi.useFakeTimers();
    try {
      setupFrames([{ frameId: 0, response: { success: true } }]);
      await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender))
        .resolves.toMatchObject({ success: true });
      const existingGrant = await pageNavigationTracker.getManualContinuity(42);
      let releaseProbe;
      const topProbe = new Promise(resolve => { releaseProbe = resolve; });
      const send = browser.tabs.sendMessage.getMockImplementation();
      let holdProbe = true;
      browser.tabs.sendMessage.mockImplementation((...args) => {
        if (holdProbe && args[1].action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE
            && args[2]?.frameId === 0) {
          holdProbe = false;
          return topProbe;
        }
        return send(...args);
      });
      const replacement = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
      await vi.waitFor(() => expect(holdProbe).toBe(false));
      await vi.advanceTimersByTimeAsync(PRE_FANOUT_TIMEOUT_MS);
      await expect(replacement).resolves.toMatchObject({ reason: PRE_FANOUT_TIMEOUT_REASON });
      expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({
        generation: existingGrant.generation, armed: true,
      });
      releaseProbe({ documentToken: 'top-document-token' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the promoted cold-worker start across stalled persistence and late completion', async () => {
    vi.useFakeTimers();
    let releaseWrite;
    let originalSet;
    let cancelStart;
    let cursorRead;
    try {
      setupFrames([
        { frameId: 0, response: { success: true } },
        { frameId: 7, response: { success: true } },
      ]);
      const liveFrames = [
        { frameId: 0, url: 'https://example.com' },
        { frameId: 7, url: 'https://frame-7.example' },
      ];
      await pageNavigationTracker.seed(42, liveFrames);
      const topCursor = await pageNavigationTracker.getAdmissionCursor(42, 0);
      let persistedRevision;
      for (let index = 0; index < 8; index += 1) {
        persistedRevision = pageNavigationTracker.reserveManualContinuityStart(42);
      }
      const previous = await pageNavigationTracker.grantManualContinuity(42, persistedRevision, {
        topDocumentToken: 'top-document-token',
        attemptId: 'persisted-attempt',
      });
      await pageNavigationTracker.armManualContinuity(42, previous.generation, persistedRevision);
      const active = pageNavigationTracker.state.manualContinuity[42];
      Object.assign(active, {
        acceptedDocuments: { 7: 'accepted-document' },
        acceptedAttemptIds: { 7: 'accepted-attempt' },
        acceptedAttemptRevisions: { 7: '40' },
        provisionalDocuments: { 7: 'provisional-document' },
        provisionalAttemptIds: { 7: 'provisional-attempt' },
        provisionalAttemptRevisions: { 7: '45' },
        confirmedAttemptId: 'confirmed-attempt',
        confirmedAttemptRevision: '42',
      });
      pageNavigationTracker.durableState = structuredClone(pageNavigationTracker.state);
      await browser.storage.session.set({ pageTranslationNavigation: pageNavigationTracker.state });
      const stopIntent = pageNavigationTracker.blockManualContinuity(42, previous.generation);
      await pageNavigationTracker.revokeManualContinuity(42, previous.generation, stopIntent);
      const tombstone = structuredClone(navigationStore.saved.pageTranslationNavigation.manualContinuity[42]);

      pageNavigationTracker.state = null;
      pageNavigationTracker.durableState = null;
      pageNavigationTracker.dirty = false;
      pageNavigationTracker.pending = Promise.resolve();
      pageNavigationTracker.manualContinuityRevision.clear();
      pageNavigationTracker.manualContinuityHighWater.clear();
      pageNavigationTracker.manualStartOperations.clear();
      cursorRead = vi.spyOn(pageNavigationTracker, 'getAdmissionCursor').mockResolvedValue(topCursor);

      let stalledFirstWrite = false;
      originalSet = browser.storage.session.set.getMockImplementation();
      browser.storage.session.set.mockImplementation(value => {
        if (stalledFirstWrite) return originalSet(value);
        stalledFirstWrite = true;
        return new Promise(resolve => {
          releaseWrite = () => { originalSet(value).then(resolve); };
        });
      });
      cancelStart = vi.spyOn(pageNavigationTracker, 'cancelManualContinuityStart');
      const timedOut = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
      await vi.waitFor(() => expect(releaseWrite).toBeTypeOf('function'));
      const operationId = pageNavigationTracker.manualStartOperations.get(42)?.id;
      expect(operationId).toEqual(expect.any(String));
      const promotedRevision = pageNavigationTracker.manualContinuityRevision.get(42);
      expect(promotedRevision).toBeGreaterThan(45);
      const ready = {
        action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
        data: { documentToken: 'frame-7-document-token' },
      };
      await expect(Promise.all([
        handlePageTranslation(ready, { ...sender, frameId: 7 }),
        handlePageTranslation(ready, { ...sender, frameId: 7 }),
      ])).resolves.toEqual([
        { success: true, pending: true },
        { success: true, pending: true },
      ]);
      await vi.advanceTimersByTimeAsync(PRE_FANOUT_TIMEOUT_MS);
      await expect(timedOut).resolves.toMatchObject({
        success: false, reason: PRE_FANOUT_TIMEOUT_REASON, isTransportFailure: true,
      });
      expect(cancelStart).toHaveBeenCalledWith(42, operationId);
      expect(cancelStart.mock.calls.every(([, cancelledId]) => cancelledId === operationId)).toBe(true);
      releaseWrite();
      releaseWrite = null;
      await pageNavigationTracker.pending;
      await Promise.resolve();
      await pageNavigationTracker.pending;
      await expect(pageNavigationTracker.getManualContinuity(42)).resolves.toBeNull();
      expect(navigationStore.saved.pageTranslationNavigation.manualContinuity[42]).toEqual(tombstone);
      expect(browser.tabs.sendMessage.mock.calls.some(([, message]) => (
        message.action === MessageActions.PAGE_TRANSLATE_FRAME_START
      ))).toBe(false);
      await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender))
        .resolves.toMatchObject({ success: true });
      await expect(pageNavigationTracker.getManualContinuity(42)).resolves.toMatchObject({ armed: true });
    } finally {
      releaseWrite?.();
      cursorRead?.mockRestore();
      cancelStart?.mockRestore();
      if (originalSet) browser.storage.session.set.mockImplementation(originalSet);
      vi.useRealTimers();
    }
  });

  it('rolls back a rejected grant write before later tracker work can flush it', async () => {
    setupFrames([{ frameId: 0, response: { success: true } }]);
    await pageNavigationTracker.seed(42, [{ frameId: 0, url: 'https://example.com' }]);
    browser.storage.session.set.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender))
      .resolves.toMatchObject({ success: false, reason: 'manual_continuity_not_durable' });
    await pageNavigationTracker.capture(42, 0, 'https://example.com/next');
    await pageNavigationTracker.pending;
    expect(navigationStore.saved.pageTranslationNavigation.manualContinuity?.['42']).toBeUndefined();
    await expect(pageNavigationTracker.getManualContinuity(42)).resolves.toBeNull();

    browser.storage.session.set.mockImplementation(async value => {
      navigationStore.saved = structuredClone(value);
    });
    await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender))
      .resolves.toMatchObject({ success: true });
    await expect(pageNavigationTracker.getManualContinuity(42)).resolves.toMatchObject({ armed: true });
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
      frameHandlers.map((frame, index) => {
        const frameId = frame.frameId ?? (index === 0 ? 0 : index * 7);
        return {
          frameId,
          url: frame.url || `https://frame-${index}.example`,
          ...((frame.identity?.documentId || frame.documentId)
            && { documentId: frame.identity?.documentId || frame.documentId }),
        };
      })
    );
    const getFrameHandler = frameId => frameHandlers.find(candidate => candidate.frameId === frameId)
      || frameHandlers[(frameId === 0 ? 0 : frameId / 7)];
    const identityFor = frameId => {
      const frame = getFrameHandler(frameId);
      return {
        documentToken: frame?.identity?.documentToken || (frameId === 0 ? 'top-document-token' : `frame-${frameId}-token`),
        documentId: frame?.identity?.documentId || frame?.documentId,
        url: frame?.identity?.url || frame?.url || `https://frame-${frameId === 0 ? 0 : frameId / 7}.example`,
      };
    };
    browser.webNavigation.getFrame.mockImplementation(async ({ frameId }) => identityFor(frameId));
    browser.tabs.sendMessage.mockImplementation(async (_tabId, message, { frameId }) => {
      if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE) {
        const probe = getFrameHandler(frameId)?.probeDeferred;
        const probeError = getFrameHandler(frameId)?.probeError;
        if (probeError) throw probeError;
        if (probe) {
          await probe.promise;
        }
        return identityFor(frameId);
      }
       const handler = getFrameHandler(frameId);
       if (message.action === MessageActions.PAGE_TRANSLATE
           && message.data?.hasManualContinuity === true) {
         const documentToken = identityFor(frameId).documentToken;
         const admission = await handlePageTranslation({
           action: MessageActions.PAGE_TRANSLATE_ADMIT,
           data: {
             ...message.data,
             origin: message.data.origin || 'manual-start',
             admissionPhase: 'accept',
             documentToken,
           },
         }, { tab: { id: _tabId }, frameId });
         if (!admission.success) return admission;
         const result = await (handler ? handler.run() : Promise.resolve({ success: true }));
         return result?.success === true ? { ...result, documentToken } : result;
       }
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

  async function beginUnconfirmedManualStart(responsePromise) {
    setupBoundedFrames([{ frameId: 0, run: () => responsePromise }]);
    const result = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message]) => (
      message.action === MessageActions.PAGE_TRANSLATE
    ))).toBe(true));
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS + 1);
    await expect(result).resolves.toMatchObject({
      success: false, reason: 'frame_command_response_timeout', isTransportFailure: true,
    });
    return pageNavigationTracker.getManualContinuity(42);
  }

  it('reconciles a successful late response after the transport deadline', async () => {
    const pendingResponse = deferred();
    const grant = await beginUnconfirmedManualStart(pendingResponse.promise);
    expect(grant).toMatchObject({ armed: false, revoked: false });

    pendingResponse.resolve({ success: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({
      generation: grant.generation, armed: true, revoked: false,
    });
    expect((await pageNavigationTracker.getManualContinuity(42)).acceptedAttemptIds).toEqual({ 0: grant.attemptId });
  });

  it('durably accepts the main frame before a pending sibling settles and survives SPA route navigation', async () => {
    const siblingResponse = deferred();
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true }) },
      { frameId: 7, run: () => siblingResponse.promise },
    ]);
    const result = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    const accepted = await vi.waitFor(async () => {
      const grant = await pageNavigationTracker.getManualContinuity(42);
      if (!grant?.acceptedAttemptIds?.[0]) throw new Error('main-frame ACK not durable yet');
      return grant;
    });
    expect(accepted).toMatchObject({ armed: true, acceptedAttemptIds: { 0: accepted.attemptId } });

    await pageNavigationTracker.capture(42, 0, 'https://frame-0.example/spa-route');
    expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({
      generation: accepted.generation, acceptedAttemptIds: { 0: accepted.attemptId },
    });

    siblingResponse.resolve({ success: true });
    await expect(result).resolves.toMatchObject({ success: true });
  });

  it('resumes provisional iframe readiness only after main ACK persistence and before its sibling settles', async () => {
    const mainResponse = deferred();
    const siblingResponse = deferred();
    const promotionWrite = deferred();
    setupBoundedFrames([
      { frameId: 0, run: () => mainResponse.promise },
      { frameId: 7, run: () => siblingResponse.promise },
    ]);
    const originalSet = browser.storage.session.set.getMockImplementation();
    let holdPromotion = false;
    browser.storage.session.set.mockImplementation(async value => {
      const grant = Object.values(value)[0]?.manualContinuity?.['42'];
      if (holdPromotion && grant?.acceptedAttemptIds?.['0']) {
        holdPromotion = false;
        await promotionWrite.promise;
      }
      return originalSet(value);
    });
    const result = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    const admit = vi.spyOn(pageNavigationTracker, 'admitManualFrame');
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message]) => (
      message.action === MessageActions.PAGE_TRANSLATE && message.data?.hasManualContinuity
        && message.data.manualContinuityGeneration != null
    ))).toBe(true));
    holdPromotion = true;
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-14-token' },
    }, { ...sender, frameId: 14 })).resolves.toMatchObject({ success: true, pending: true });

    mainResponse.resolve({ success: true });
    await vi.waitFor(() => expect(holdPromotion).toBe(false));
    await Promise.resolve();
    expect(admit).not.toHaveBeenCalled();
    expect((await pageNavigationTracker.getManualContinuity(42)).acceptedAttemptIds).toBeUndefined();

    promotionWrite.resolve();
    await vi.waitFor(async () => expect(
      (await pageNavigationTracker.getManualContinuity(42))?.acceptedAttemptIds?.[0],
    ).toBeDefined());
    await vi.waitFor(() => expect(admit).toHaveBeenCalledOnce());
    expect(admit).toHaveBeenCalledWith(
      42, 14, expect.any(Number), expect.any(Number), 'top-document-token',
      'https://frame-2.example', 'frame-14-token',
    );
    expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({ armed: true });

    siblingResponse.resolve({ success: true });
    await expect(result).resolves.toMatchObject({ success: true });
  });

  it('queues READY for the initially dispatched iframe until its start response settles', async () => {
    const childResponse = deferred();
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true }) },
      { frameId: 7, run: () => childResponse.promise },
    ]);
    const admit = vi.spyOn(pageNavigationTracker, 'admitManualFrame');
    const initial = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))).toBe(true));

    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-7-token' },
    }, { ...sender, frameId: 7 })).resolves.toMatchObject({ success: true, pending: true });
    expect(admit.mock.calls.some(([, frameId]) => frameId === 7)).toBe(false);
    const grant = await pageNavigationTracker.getManualContinuity(42);
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_START,
      data: {
        documentToken: 'frame-7-token',
        manualContinuityGeneration: grant.generation,
        manualContinuityAttemptId: grant.attemptId,
        manualContinuityAttemptRevision: grant.attemptRevision,
        topDocumentEpoch: grant.topDocumentEpoch,
        navigationCursor: await pageNavigationTracker.getAdmissionCursor(42, 7),
      },
    }, { ...sender, frameId: 7 })).resolves.toMatchObject({ success: true, pending: true });
    expect(browser.tabs.sendMessage.mock.calls.some(([, message]) => (
      message.action === MessageActions.PAGE_TRANSLATE_FRAME_START
    ))).toBe(false);

    childResponse.resolve({ success: true });
    await expect(initial).resolves.toMatchObject({ success: true });
    await vi.waitFor(() => expect(admit.mock.calls.some(([, frameId]) => frameId === 7)).toBe(true));
    expect(browser.tabs.sendMessage.mock.calls.some(([, message]) => (
      message.action === MessageActions.PAGE_TRANSLATE_FRAME_START
    ))).toBe(false);
  });

  it('reserves child documents before asynchronous initial identity probes complete', async () => {
    const childProbe = deferred();
    const childResponse = deferred();
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true }) },
      { frameId: 7, probeDeferred: childProbe, run: () => childResponse.promise },
    ]);
    const initial = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE && options.frameId === 7
    ))).toBe(true));

    const ready = handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-7-token' },
    }, { ...sender, frameId: 7 });
    childProbe.resolve();
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))).toBe(true));
    await expect(ready).resolves.toMatchObject({ success: true, pending: true });

    childResponse.resolve({ success: true });
    await expect(initial).resolves.toMatchObject({ success: true });
    expect(browser.tabs.sendMessage.mock.calls.filter(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))).toHaveLength(1);
  });

  it('isolates a stalled child identity probe while healthy frames start and prevents late dispatch', async () => {
    const childProbe = deferred();
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true }) },
      { frameId: 7, probeDeferred: childProbe, run: () => Promise.resolve({ success: true }) },
      { frameId: 8, run: () => Promise.resolve({ success: true }) },
    ]);
    const initial = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE && options.frameId === 7
    ))).toBe(true));

    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 8
    ))).toBe(true));
    expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 0
    ))).toBe(true);

    await vi.advanceTimersByTimeAsync(PRE_FANOUT_TIMEOUT_MS + 1);
    await expect(initial).resolves.toMatchObject({ success: true });
    expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))).toBe(false);
    const dispatchCount = browser.tabs.sendMessage.mock.calls.length;
    childProbe.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(browser.tabs.sendMessage.mock.calls.length).toBe(dispatchCount);

    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true }) },
      { frameId: 7, run: () => Promise.resolve({ success: true }) },
    ]);
    await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender))
      .resolves.toMatchObject({ success: true });
    expect(browser.tabs.sendMessage.mock.calls.some(([, message]) => (
      message.action === MessageActions.PAGE_TRANSLATE && message.data?.hasManualContinuity
    ))).toBe(true);
  });

  it('releases a rejected identity-probe lease and permits a later manual retry', async () => {
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true }) },
      {
        frameId: 7,
        probeError: new Error('probe transport rejected'),
        run: () => Promise.resolve({ success: true }),
      },
    ]);
    await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender))
      .resolves.toMatchObject({ success: true });
    expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))).toBe(false);

    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true }) },
      { frameId: 7, run: () => Promise.resolve({ success: true }) },
    ]);
    await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender))
      .resolves.toMatchObject({ success: true });
    expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))).toBe(true);
  });

  it('revalidates when a lease settles while READY validation is still in progress', async () => {
    const childResponse = deferred();
    const readyProbe = deferred();
    let childCalls = 0;
    const child = {
      frameId: 7,
      run: () => {
        childCalls += 1;
        return childCalls === 1 ? childResponse.promise : Promise.resolve({ success: true });
      },
    };
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true }) },
      child,
    ]);
    const initial = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))).toBe(true));

    child.probeDeferred = readyProbe;
    const probeCount = browser.tabs.sendMessage.mock.calls.filter(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE && options.frameId === 7
    )).length;
    const ready = handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-7-token' },
    }, { ...sender, frameId: 7 });
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.filter(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE && options.frameId === 7
    ))).toHaveLength(probeCount + 1));

    child.probeDeferred = null;
    childResponse.resolve({ success: false, reason: 'initial_rejected' });
    await expect(initial).resolves.toMatchObject({ success: true });
    readyProbe.resolve();
    const ticket = await ready;
    expect(ticket).toMatchObject({ success: true, start: true });
    expect(ticket).not.toHaveProperty('pending');
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_START,
      data: ticket,
    }, { ...sender, frameId: 7 })).resolves.toMatchObject({ success: true });
    expect(childCalls).toBe(2);
  });

  it.each([
    ['accepted', true, 1],
    ['rejected', false, 2],
  ])('replays deferred READY after an initial iframe response is %s', async (_label, firstSuccess, expectedChildStarts) => {
    const childResponse = deferred();
    let childCalls = 0;
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true }) },
      {
        frameId: 7,
        run: () => {
          childCalls += 1;
          return childCalls === 1 ? childResponse.promise : Promise.resolve({ success: true });
        },
      },
    ]);
    const initial = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))).toBe(true));
    const grant = await pageNavigationTracker.getManualContinuity(42);
    const replay = handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: {
        documentToken: 'frame-7-token',
        deferredManualAttemptId: grant.attemptId,
        deferredManualAttemptRevision: grant.attemptRevision,
        deferredManualGeneration: grant.generation,
      },
    }, { ...sender, frameId: 7 });
    await expect(replay).resolves.toMatchObject({ success: true, pending: true });
    expect(childCalls).toBe(1);

    childResponse.resolve({ success: firstSuccess });
    await expect(initial).resolves.toMatchObject({ success: true });
    await vi.waitFor(() => expect(childCalls).toBe(expectedChildStarts));
    expect(childCalls).toBe(expectedChildStarts);
  });

  it('does not replay queued readiness after an explicit USER_CANCELLED response', async () => {
    const childResponse = deferred();
    let childCalls = 0;
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true }) },
      {
        frameId: 7,
        run: () => {
          childCalls += 1;
          return childCalls === 1 ? childResponse.promise : Promise.resolve({ success: true });
        },
      },
    ]);
    const initial = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))).toBe(true));
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-7-token' },
    }, { ...sender, frameId: 7 })).resolves.toMatchObject({ success: true, pending: true });
    await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_START,
      data: {
        documentToken: 'frame-7-token',
        ...(await pageNavigationTracker.getManualContinuity(42)),
        navigationCursor: await pageNavigationTracker.getAdmissionCursor(42, 7),
      },
    }, { ...sender, frameId: 7 });

    childResponse.resolve({ success: false, reason: ActionReasons.USER_CANCELLED });
    await expect(initial).resolves.toMatchObject({ success: true });
    await Promise.resolve();
    expect(childCalls).toBe(1);
    expect(browser.tabs.sendMessage.mock.calls.filter(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))).toHaveLength(1);
  });

  it('preserves same-document readiness for a newer owner after a late USER_CANCELLED response', async () => {
    const oldChildResponse = deferred();
    const successorTopProbe = deferred();
    const successorTopProbeStarted = deferred();
    let holdSuccessorTopProbe = true;
    let childDispatches = 0;
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true }) },
      {
        frameId: 7,
        documentId: 'frame-7-document',
        identity: { documentToken: 'frame-7-token', documentId: 'frame-7-document' },
        run: () => {
          childDispatches += 1;
          return childDispatches === 1
            ? oldChildResponse.promise
            : Promise.resolve({ success: true, documentToken: 'frame-7-token' });
        },
      },
    ]);
    const admitManualFrame = vi.spyOn(pageNavigationTracker, 'admitManualFrame');
    const child = { ...sender, frameId: 7, documentId: 'frame-7-document' };
    const oldStart = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(childDispatches).toBe(1));
    const oldGrant = await pageNavigationTracker.getManualContinuity(42);

    const originalSend = browser.tabs.sendMessage.getMockImplementation();
    browser.tabs.sendMessage.mockImplementation((tabId, message, options) => (
      message.action === MessageActions.PAGE_TRANSLATE_STOP_AUTO
        ? Promise.resolve({ success: true })
        : originalSend(tabId, message, options)
    ));
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_STOP_AUTO,
      data: { expectedManualContinuityGeneration: oldGrant.generation },
    }, sender)).resolves.toMatchObject({ success: true });
    await expect(pageNavigationTracker.getManualContinuity(42)).resolves.toBeNull();

    browser.tabs.sendMessage.mockImplementation((tabId, message, options) => {
      if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE
          && options.frameId === 0 && holdSuccessorTopProbe) {
        holdSuccessorTopProbe = false;
        successorTopProbeStarted.resolve();
        return successorTopProbe.promise.then(() => originalSend(tabId, message, options));
      }
      return originalSend(tabId, message, options);
    });
    const successorStart = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await successorTopProbeStarted.promise;
    const ready = handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-7-token' },
    }, child);
    await expect(ready).resolves.toMatchObject({ success: true, pending: true });
    expect(admitManualFrame.mock.calls.filter(([, frameId]) => frameId === 7)).toHaveLength(0);

    oldChildResponse.resolve({ success: false, reason: ActionReasons.USER_CANCELLED });
    await expect(oldStart).resolves.toMatchObject({ success: true });
    expect(childDispatches).toBe(1);

    successorTopProbe.resolve();
    await expect(successorStart).resolves.toMatchObject({ success: true });
    const successorGrant = await pageNavigationTracker.getManualContinuity(42);
    expect(successorGrant.armed).toBe(true);
    let admissionCallIndex = -1;
    await vi.waitFor(() => {
      admissionCallIndex = admitManualFrame.mock.calls.findIndex(args => (
        args[0] === 42 && args[1] === 7 && args[2] === successorGrant.generation
          && args[3] === successorGrant.topDocumentEpoch
          && args[4] === successorGrant.topDocumentToken
          && args[5] === 'https://frame-1.example'
          && args[6] === 'frame-7-token'
      ));
      expect(admissionCallIndex).toBeGreaterThanOrEqual(0);
    });
    const admission = await admitManualFrame.mock.results[admissionCallIndex].value;
    expect(admission.cursor).toEqual(await pageNavigationTracker.getAdmissionCursor(42, 7));
    expect(childDispatches).toBe(2);
    admitManualFrame.mockRestore();
  });

  it.each([
    ['accepted', true, 1],
    ['rejected', false, 2],
  ])('replays direct READY and START after an initial iframe response is %s', async (_label, firstSuccess, expectedChildStarts) => {
    const childResponse = deferred();
    let childCalls = 0;
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true }) },
      {
        frameId: 7,
        run: () => {
          childCalls += 1;
          return childCalls === 1 ? childResponse.promise : Promise.resolve({ success: true });
        },
      },
    ]);
    const initial = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))).toBe(true));
    const ready = handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-7-token' },
    }, { ...sender, frameId: 7 });
    await expect(ready).resolves.toMatchObject({ success: true, pending: true });
    const grant = await pageNavigationTracker.getManualContinuity(42);
    const start = handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_START,
      data: {
        documentToken: 'frame-7-token',
        manualContinuityGeneration: grant.generation,
        manualContinuityAttemptId: grant.attemptId,
        manualContinuityAttemptRevision: grant.attemptRevision,
        topDocumentEpoch: grant.topDocumentEpoch,
        navigationCursor: await pageNavigationTracker.getAdmissionCursor(42, 7),
      },
    }, { ...sender, frameId: 7 });
    await expect(start).resolves.toMatchObject({ success: true, pending: true });
    expect(childCalls).toBe(1);

    childResponse.resolve({ success: firstSuccess });
    await expect(initial).resolves.toMatchObject({ success: true });
    await vi.waitFor(() => expect(childCalls).toBe(expectedChildStarts));
    expect(childCalls).toBe(expectedChildStarts);
  });

  it('keeps a dispatched lease through the response timeout and replays only after the late rejection', async () => {
    const childResponse = deferred();
    let childCalls = 0;
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true }) },
      {
        frameId: 7,
        run: () => {
          childCalls += 1;
          return childCalls === 1 ? childResponse.promise : Promise.resolve({ success: true });
        },
      },
    ]);
    const initial = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))).toBe(true));
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-7-token' },
    }, { ...sender, frameId: 7 })).resolves.toMatchObject({ success: true, pending: true });

    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS + 1);
    await expect(initial).resolves.toMatchObject({ success: true });
    expect(childCalls).toBe(1);
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_START,
      data: {
        documentToken: 'frame-7-token',
        manualContinuityGeneration: (await pageNavigationTracker.getManualContinuity(42)).generation,
        manualContinuityAttemptId: (await pageNavigationTracker.getManualContinuity(42)).attemptId,
        manualContinuityAttemptRevision: (await pageNavigationTracker.getManualContinuity(42)).attemptRevision,
        topDocumentEpoch: (await pageNavigationTracker.getManualContinuity(42)).topDocumentEpoch,
        navigationCursor: await pageNavigationTracker.getAdmissionCursor(42, 7),
      },
    }, { ...sender, frameId: 7 })).resolves.toMatchObject({ success: true, pending: true });
    expect(childCalls).toBe(1);

    childResponse.resolve({ success: false, reason: 'initial_rejected' });
    await vi.waitFor(() => expect(childCalls).toBe(2));
    expect(childCalls).toBe(2);
  });

  it('admits an unrelated iframe while an initially dispatched sibling remains pending', async () => {
    const childResponse = deferred();
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true }) },
      { frameId: 7, run: () => childResponse.promise },
    ]);
    const initial = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))).toBe(true));
    const ticket = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-14-token' },
    }, { ...sender, frameId: 14 });
    expect(ticket).toMatchObject({ success: true, start: true });
    const start = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_START,
      data: ticket,
    }, { ...sender, frameId: 14 });
    expect(start).toMatchObject({ success: true });
    expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 14
    ))).toBe(true);
    expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))).toBe(true);

    childResponse.resolve({ success: true });
    await expect(initial).resolves.toMatchObject({ success: true });
  });

  it.each([
    ['worker restart', () => {
      pageNavigationTracker.manualContinuityRevision.clear();
      pageNavigationTracker.manualContinuityHighWater.clear();
      pageNavigationTracker.manualStartOperations.clear();
    }],
    ['rejected replacement', () => {
      pageNavigationTracker.reserveManualContinuityStart(42, 'rejected-replacement');
      pageNavigationTracker.cancelManualContinuityStart(42, 'rejected-replacement');
    }],
  ])('admits a dynamic iframe from durable authority after %s', async (_scenario, invalidateOperationRevision) => {
    let childDispatches = 0;
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true }) },
      { frameId: 7, run: () => {
        childDispatches += 1;
        return Promise.resolve({ success: true, documentToken: 'frame-7-token' });
      } },
    ]);
    await pageNavigationTracker.seed(42, [
      { frameId: 0, url: 'https://frame-0.example' },
      { frameId: 7, url: 'https://frame-1.example' },
    ]);
    const grant = await pageNavigationTracker.grantManualContinuity(42, undefined, {
      topDocumentToken: 'top-document-token',
    });
    await pageNavigationTracker.armManualContinuity(42, grant.generation, grant.attemptRevision);
    await recordTopManualAcceptance(grant);
    const child = { ...sender, frameId: 7 };
    const ticket = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-7-token' },
    }, child);
    expect(ticket).toMatchObject({ success: true, start: true });

    invalidateOperationRevision();
    const start = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_START,
      data: ticket,
    }, child);

    expect(start).toMatchObject({ success: true });
    expect(childDispatches).toBe(1);
    expect(browser.tabs.sendMessage.mock.calls.filter(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE
        && message.data?.hasManualContinuity === true && options.frameId === 7
    ))).toHaveLength(1);
  });

  it('serializes a dynamic START behind an initial lease registered after its first lookup', async () => {
    const dynamicGrantRead = deferred();
    const releaseDynamicGrantRead = deferred();
    const successorTopProbe = deferred();
    const successorTopProbeStarted = deferred();
    const successorChildResponse = deferred();
    let holdSuccessorTopProbe = true;
    let dynamicGrantReads = 0;
    let successorChildDispatches = 0;
    const topFrame = { frameId: 0, run: () => Promise.resolve({ success: true }) };
    setupBoundedFrames([
      topFrame,
      {
        frameId: 7,
        documentId: 'frame-7-document',
        identity: { documentToken: 'frame-7-token', documentId: 'frame-7-document' },
        run: () => {
          successorChildDispatches += 1;
          return successorChildResponse.promise;
        },
      },
    ]);
    await pageNavigationTracker.seed(42, [
      { frameId: 0, url: 'https://frame-0.example' },
      { frameId: 7, url: 'https://frame-1.example' },
    ]);
    const grant = await pageNavigationTracker.grantManualContinuity(42, undefined, {
      topDocumentToken: 'top-document-token',
    });
    await pageNavigationTracker.armManualContinuity(42, grant.generation, grant.attemptRevision);
    await recordTopManualAcceptance(grant);
    const child = { ...sender, frameId: 7, documentId: 'frame-7-document' };
    const ticket = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-7-token' },
    }, child);
    expect(ticket).toMatchObject({ success: true, start: true });

    const originalGetManualContinuity = pageNavigationTracker.getManualContinuity.bind(pageNavigationTracker);
    vi.spyOn(pageNavigationTracker, 'getManualContinuity').mockImplementation(async tabId => {
      if (tabId === 42 && dynamicGrantReads < 3) {
        dynamicGrantReads += 1;
        if (dynamicGrantReads === 3) {
          dynamicGrantRead.resolve();
          await releaseDynamicGrantRead.promise;
        }
      }
      return originalGetManualContinuity(tabId);
    });
    const dynamicStart = handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_START,
      data: ticket,
    }, child);
    await dynamicGrantRead.promise;

    const originalSend = browser.tabs.sendMessage.getMockImplementation();
    browser.tabs.sendMessage.mockImplementation((tabId, message, options) => {
      if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE
          && options.frameId === 0 && holdSuccessorTopProbe) {
        holdSuccessorTopProbe = false;
        successorTopProbeStarted.resolve();
        return successorTopProbe.promise.then(() => originalSend(tabId, message, options));
      }
      return originalSend(tabId, message, options);
    });
    const frameProbeCount = browser.tabs.sendMessage.mock.calls.filter(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE && options.frameId === 7
    )).length;
    const successorStart = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await successorTopProbeStarted.promise;
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.filter(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE && options.frameId === 7
    )).length).toBeGreaterThan(frameProbeCount));

    releaseDynamicGrantRead.resolve();
    await expect(dynamicStart).resolves.toMatchObject({ success: true, pending: true });
    expect(successorChildDispatches).toBe(0);
    successorTopProbe.resolve();
    await vi.waitFor(() => expect(successorChildDispatches).toBe(1));
    expect(browser.tabs.sendMessage.mock.calls.filter(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))).toHaveLength(1);

    successorChildResponse.resolve({ success: true, documentToken: 'frame-7-token' });
    await expect(successorStart).resolves.toMatchObject({ success: true });
    expect(browser.tabs.sendMessage.mock.calls.filter(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))).toHaveLength(1);
    pageNavigationTracker.getManualContinuity.mockRestore();
  });

  it('waits for an in-flight dynamic child start and its reconciliation before an explicit successor', async () => {
    const dynamicResponse = deferred();
    let childDeliveries = 0;
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true }) },
      { frameId: 7, run: () => {
        childDeliveries += 1;
        return childDeliveries === 1 ? dynamicResponse.promise : Promise.resolve({ success: true });
      } },
    ]);
    await pageNavigationTracker.seed(42, [
      { frameId: 0, url: 'https://frame-0.example' },
      { frameId: 7, url: 'https://frame-1.example' },
    ]);
    const grant = await pageNavigationTracker.grantManualContinuity(42, undefined, {
      topDocumentToken: 'top-document-token',
    });
    await recordTopManualAcceptance(grant);
    const child = { ...sender, frameId: 7 };
    const ticket = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-7-token' },
    }, child);
    expect(ticket).toMatchObject({ success: true, start: true });
    const dynamic = handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_START,
      data: ticket,
    }, child);
    await vi.waitFor(() => expect(childDeliveries).toBe(1));

    const successor = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 0
        && message.data?.hasManualContinuity
    ))).toBe(true));
    expect(browser.tabs.sendMessage.mock.calls.filter(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))).toHaveLength(1);

    dynamicResponse.resolve({ success: true, documentToken: 'frame-7-token' });
    await expect(dynamic).resolves.toMatchObject({ success: true });
    await expect(successor).resolves.toMatchObject({ success: true });
    expect(childDeliveries).toBe(2);
    expect(browser.tabs.sendMessage.mock.calls.filter(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))).toHaveLength(2);
  });

  it('releases a dynamic reservation when tracker claim rejects before dispatch', async () => {
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true }) },
      { frameId: 7, run: () => Promise.resolve({ success: true }) },
    ]);
    await pageNavigationTracker.seed(42, [
      { frameId: 0, url: 'https://frame-0.example' },
      { frameId: 7, url: 'https://frame-1.example' },
    ]);
    const grant = await pageNavigationTracker.grantManualContinuity(42, undefined, {
      topDocumentToken: 'top-document-token',
    });
    await recordTopManualAcceptance(grant);
    const child = { ...sender, frameId: 7 };
    const ticket = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-7-token' },
    }, child);
    const claim = vi.spyOn(pageNavigationTracker, 'claimManualFrameStart')
      .mockRejectedValueOnce(new Error('claim storage failed'));
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_START,
      data: ticket,
    }, child)).resolves.toMatchObject({ success: false, error: 'claim storage failed' });
    claim.mockRestore();

    await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender))
      .resolves.toMatchObject({ success: true });
    expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))).toBe(true);
  });

  it('admits a replacement document in the same frame while fencing the old document ACK', async () => {
    const childResponse = deferred();
    const identity = { documentId: 'child-document-1', documentToken: 'child-token-1' };
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true }) },
      { frameId: 7, documentId: identity.documentId, identity, run: () => childResponse.promise },
    ]);
    const admit = vi.spyOn(pageNavigationTracker, 'admitManualFrame');
    const initial = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))).toBe(true));
    expect(browser.tabs.sendMessage.mock.calls.find(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))[2]).toMatchObject({ documentId: 'child-document-1' });

    identity.documentId = 'child-document-2';
    identity.documentToken = 'child-token-2';
    identity.url = 'https://frame-1.example/reloaded';
    await pageNavigationTracker.capture(42, 7, identity.url);
    const replacementTicket = await handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'child-token-2' },
    }, { ...sender, frameId: 7, documentId: 'child-document-2' });
    expect(replacementTicket).toMatchObject({ success: true, start: true });
    expect(admit).toHaveBeenCalledWith(
      42, 7, expect.any(Number), expect.any(Number), 'top-document-token',
      identity.url, 'child-token-2',
    );

    const acceptedBeforeLateAck = (await pageNavigationTracker.getManualContinuity(42)).acceptedDocuments;
    childResponse.resolve({ success: true });
    await expect(initial).resolves.toMatchObject({ success: true });
    expect((await pageNavigationTracker.getManualContinuity(42)).acceptedDocuments)
      .toEqual(acceptedBeforeLateAck);
  });

  it('fences queued READY and a late iframe ACK across Stop and a superseding attempt', async () => {
    const oldChildResponse = deferred();
    let childCalls = 0;
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true }) },
      {
        frameId: 7,
        run: () => {
          childCalls += 1;
          return childCalls === 1 ? oldChildResponse.promise : Promise.resolve({ success: true });
        },
      },
    ]);
    const oldStart = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))).toBe(true));
    const oldGrant = await pageNavigationTracker.getManualContinuity(42);
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-7-token' },
    }, { ...sender, frameId: 7 })).resolves.toMatchObject({ success: true, pending: true });

    const originalSend = browser.tabs.sendMessage.getMockImplementation();
    browser.tabs.sendMessage.mockImplementation((tabId, message, options) => (
      message.action === MessageActions.PAGE_TRANSLATE_STOP_AUTO
        ? Promise.resolve({ success: true })
        : originalSend(tabId, message, options)
    ));
    const stopping = handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_STOP_AUTO,
      data: { expectedManualContinuityGeneration: oldGrant.generation },
    }, sender);
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message]) => (
      message.action === MessageActions.PAGE_TRANSLATE_STOP_AUTO
    ))).toBe(true));
    await expect(stopping).resolves.toMatchObject({ success: true });
    const replacementStart = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.filter(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 0
    ))).toHaveLength(2));
    expect(childCalls).toBe(1);
    const replacementGrant = await pageNavigationTracker.getManualContinuity(42);
    expect(replacementGrant.attemptId).not.toBe(oldGrant.attemptId);

    oldChildResponse.resolve({ success: true });
    await expect(oldStart).resolves.toMatchObject({ success: true });
    await expect(replacementStart).resolves.toMatchObject({ success: true });
    expect(childCalls).toBe(2);
    expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({
      armed: true,
      revoked: false,
      acceptedAttemptIds: { 7: replacementGrant.attemptId },
    });
    expect(browser.tabs.sendMessage.mock.calls.filter(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))).toHaveLength(2);
  });

  it('does not invalidate queued readiness for a newer owner on stale UI Stop generation', async () => {
    const childResponse = deferred();
    let childCalls = 0;
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: true }) },
      {
        frameId: 7,
        run: () => {
          childCalls += 1;
          return childCalls === 1 ? childResponse.promise : Promise.resolve({ success: true });
        },
      },
    ]);
    const initial = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === 7
    ))).toBe(true));
    const grant = await pageNavigationTracker.getManualContinuity(42);
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-7-token' },
    }, { ...sender, frameId: 7 })).resolves.toMatchObject({ success: true, pending: true });

    const originalSend = browser.tabs.sendMessage.getMockImplementation();
    browser.tabs.sendMessage.mockImplementation((tabId, message, options) => (
      message.action === MessageActions.PAGE_TRANSLATE_STOP_AUTO
        ? Promise.resolve({ success: true })
        : originalSend(tabId, message, options)
    ));
    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_STOP_AUTO,
      data: { expectedManualContinuityGeneration: grant.generation + 1 },
    }, {})).resolves.toMatchObject({
      success: false, reason: 'manual_continuity_stop_superseded',
    });

    childResponse.resolve({ success: false, reason: 'initial_rejected' });
    await expect(initial).resolves.toMatchObject({ success: true });
    await vi.waitFor(() => expect(childCalls).toBe(2));
    expect(childCalls).toBe(2);
  });

  it('releases start ownership after provisional cleanup failure so a manual retry can proceed', async () => {
    const rejectedAck = deferred();
    setupBoundedFrames([{ frameId: 0, run: () => rejectedAck.promise }]);
    const firstStart = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message]) => (
      message.action === MessageActions.PAGE_TRANSLATE && message.data?.hasManualContinuity
    ))).toBe(true));
    browser.storage.session.set.mockRejectedValueOnce(new Error('cleanup persistence failed'));
    rejectedAck.resolve({
      success: false, reason: 'token_confirmation_rejected', documentToken: 'top-document-token',
    });
    await expect(firstStart).resolves.toMatchObject({
      success: false,
      reason: 'manual_continuity_acceptance_uncertain',
      isTransportFailure: true,
      continuityUncertainFrames: [0],
    });

    setupBoundedFrames([{ frameId: 0, run: () => Promise.resolve({ success: true }) }]);
    await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender))
      .resolves.toMatchObject({ success: true });
  });

  it.each([
    ['unsuccessful response', () => Promise.resolve({ success: false, reason: 'token_confirmation_rejected' })],
    ['transport rejection', () => Promise.reject(new Error('frame transport failed'))],
  ])('clears staged provisional proof after a settled %s without a document token', async (_kind, run) => {
    setupBoundedFrames([{ frameId: 0, run }]);
    await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    const tombstone = await pageNavigationTracker.getManualContinuityForRevocation(42);
    expect(tombstone).toMatchObject({ revoked: true });
    expect(tombstone.revokedProvisionalAttemptIds || {}).not.toHaveProperty('0');
    expect(tombstone.revokedProvisionalDocuments || {}).not.toHaveProperty('0');

    setupBoundedFrames([{ frameId: 0, run: () => Promise.resolve({ success: true }) }]);
    await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender))
      .resolves.toMatchObject({ success: true });
  });

  it('clears a failed reused-attempt provisional proof without removing prior accepted authority', async () => {
    await pageNavigationTracker.seed(42, [{ frameId: 0, url: 'https://example.com' }]);
    const original = await pageNavigationTracker.grantManualContinuity(42, undefined, {
      topDocumentToken: 'top-document-token',
    });
    await pageNavigationTracker.armManualContinuity(42, original.generation);
    await recordTopManualAcceptance(original);

    setupBoundedFrames([{
      frameId: 0, run: () => Promise.resolve({ success: false, reason: 'token_confirmation_rejected' }),
    }]);
    await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);

    const grant = await pageNavigationTracker.getManualContinuity(42);
    expect(grant).toMatchObject({
      generation: original.generation,
      armed: true,
      acceptedAttemptIds: { 0: original.attemptId },
      acceptedDocuments: { 0: original.topDocumentToken },
    });
    expect(grant.provisionalAttemptIds || {}).not.toHaveProperty('0');
    expect(grant.provisionalDocuments || {}).not.toHaveProperty('0');
  });

  it('replays reused-grant READY with the active owner and rejects an older accepted START ticket', async () => {
    const frameId = 97;
    const childUrl = 'https://frame-97.example';
    const initialChildAck = deferred();
    const retryChildAck = deferred();
    const replacementTopAck = deferred();
    let childCalls = 0;
    setupBoundedFrames([
      { frameId: 0, url: 'https://example.com', run: () => replacementTopAck.promise },
      {
        frameId, url: childUrl,
        identity: { documentToken: 'frame-97-document-token' },
        run: () => {
          childCalls += 1;
          return childCalls === 1 ? initialChildAck.promise : retryChildAck.promise;
        },
      },
    ]);
    await pageNavigationTracker.seed(42, [
      { frameId: 0, url: 'https://example.com' },
      { frameId, url: childUrl },
    ]);
    const original = await pageNavigationTracker.grantManualContinuity(42, undefined, {
      topDocumentToken: 'top-document-token',
    });
    await pageNavigationTracker.armManualContinuity(42, original.generation);
    await recordTopManualAcceptance(original);
    const oldChildCursor = await pageNavigationTracker.getAdmissionCursor(42, frameId);
    const oldAdmission = await pageNavigationTracker.admitManualFrame(
      42, frameId, original.generation, original.topDocumentEpoch,
      original.topDocumentToken, childUrl, 'frame-97-document-token',
    );
    await pageNavigationTracker.recordManualFrameAcceptance(
      42, original.generation, original.attemptId, original.attemptRevision,
      frameId, 'frame-97-document-token', oldAdmission.cursor, original.attemptId,
    );

    browser.tabs.sendMessage.mockClear();
    const replacementStart = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === frameId
    ))).toBe(true));
    const firstChildStart = browser.tabs.sendMessage.mock.calls.find(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === frameId
    ))[1];
    const newAttemptId = firstChildStart.data.manualContinuityAttemptId;
    const newAttemptRevision = firstChildStart.data.manualContinuityAttemptRevision;
    expect(newAttemptId).not.toBe(original.attemptId);

    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_START,
      data: {
        documentToken: 'frame-97-document-token',
        manualContinuityGeneration: original.generation,
        manualContinuityAttemptId: original.attemptId,
        manualContinuityAttemptRevision: original.attemptRevision,
        topDocumentEpoch: original.topDocumentEpoch,
        navigationCursor: oldChildCursor,
      },
    }, { ...sender, frameId })).resolves.toMatchObject({
      success: false, reason: 'obsolete_navigation',
    });
    expect(childCalls).toBe(1);

    await expect(handlePageTranslation({
      action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
      data: { documentToken: 'frame-97-document-token' },
    }, { ...sender, frameId })).resolves.toMatchObject({ success: true, pending: true });

    replacementTopAck.resolve({ success: true });
    await vi.waitFor(async () => expect(
      (await pageNavigationTracker.getManualContinuity(42)).acceptedAttemptIds?.[0],
    ).toBe(newAttemptId));
    initialChildAck.resolve({ success: false, reason: 'initial_rejected' });
    await expect(replacementStart).resolves.toMatchObject({ success: true });
    await vi.waitFor(() => expect(childCalls).toBe(2));
    const beforeRetryAck = await pageNavigationTracker.getManualContinuity(42);
    expect(beforeRetryAck.acceptedAttemptIds?.[frameId]).toBe(original.attemptId);
    expect(beforeRetryAck.acceptedDocuments?.[frameId]).toBe('frame-97-document-token');

    retryChildAck.resolve({ success: false, reason: 'retry_rejected' });
    const afterRetryRejection = await pageNavigationTracker.getManualContinuity(42);
    expect(afterRetryRejection.acceptedAttemptIds?.[frameId]).toBe(original.attemptId);
    expect(afterRetryRejection.acceptedDocuments?.[frameId]).toBe('frame-97-document-token');
    const childStarts = browser.tabs.sendMessage.mock.calls.filter(([, message, options]) => (
      message.action === MessageActions.PAGE_TRANSLATE && options.frameId === frameId
    ));
    expect(childStarts).toHaveLength(2);
    expect(childStarts.map(([, message]) => message.data.manualContinuityAttemptId))
      .toEqual([newAttemptId, newAttemptId]);
    expect(childStarts.map(([, message]) => message.data.manualContinuityAttemptRevision))
      .toEqual([newAttemptRevision, newAttemptRevision]);
  });

  it('updates queued READY revision when a hydrated grant raises the active attempt high-water mark', async () => {
    const frameId = 97;
    const childUrl = 'https://frame-97.example';
    const topAck = deferred();
    const initialChildAck = deferred();
    let retryCalls = 0;
    setupBoundedFrames([
      { frameId: 0, url: 'https://example.com', run: () => topAck.promise },
      {
        frameId, url: childUrl,
        identity: { documentToken: 'frame-97-token' },
        run: () => {
          retryCalls += 1;
          return retryCalls === 1
            ? initialChildAck.promise
            : Promise.resolve({ success: false, reason: 'retry_rejected' });
        },
      },
    ]);
    await pageNavigationTracker.seed(42, [
      { frameId: 0, url: 'https://example.com' },
      { frameId, url: childUrl },
    ]);
    let persistedRevision;
    for (let index = 0; index < 8; index += 1) {
      persistedRevision = pageNavigationTracker.reserveManualContinuityStart(42);
    }
    const original = await pageNavigationTracker.grantManualContinuity(42, persistedRevision, {
      topDocumentToken: 'top-document-token',
      attemptId: 'hydrated-original-attempt',
    });
    await pageNavigationTracker.armManualContinuity(42, original.generation, persistedRevision);
    await recordTopManualAcceptance(original);
    const oldAdmission = await pageNavigationTracker.admitManualFrame(
      42, frameId, original.generation, original.topDocumentEpoch,
      original.topDocumentToken, childUrl, 'frame-97-token',
    );
    await pageNavigationTracker.recordManualFrameAcceptance(
      42, original.generation, original.attemptId, original.attemptRevision,
      frameId, 'frame-97-token', oldAdmission.cursor, original.attemptId,
    );

    pageNavigationTracker.state = null;
    pageNavigationTracker.durableState = null;
    pageNavigationTracker.dirty = false;
    pageNavigationTracker.pending = Promise.resolve();
    pageNavigationTracker.restartFences.clear();
    pageNavigationTracker.blockedManualContinuity.clear();
    pageNavigationTracker.manualRevocationIntents.clear();
    pageNavigationTracker.manualStartSnapshots.clear();
    pageNavigationTracker.manualContinuityRevision.clear();
    pageNavigationTracker.manualContinuityHighWater.clear();
    pageNavigationTracker.manualStartOperations.clear();

    const originalGrant = pageNavigationTracker.grantManualContinuity.bind(pageNavigationTracker);
    const grantEntered = deferred();
    const grantGate = deferred();
    const grantSpy = vi.spyOn(pageNavigationTracker, 'grantManualContinuity').mockImplementation(async (...args) => {
      grantEntered.resolve();
      await grantGate.promise;
      return originalGrant(...args);
    });
    try {
      browser.tabs.sendMessage.mockClear();
      const replacementStart = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
      await grantEntered.promise;
      const reservedRevision = pageNavigationTracker.manualContinuityRevision.get(42);
      const queuedReady = handlePageTranslation({
        action: MessageActions.PAGE_TRANSLATE_FRAME_READY,
        data: { documentToken: 'frame-97-token' },
      }, { ...sender, frameId });
      await expect(queuedReady).resolves.toMatchObject({ success: true, pending: true });

      grantGate.resolve();
      await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message, options]) => (
        message.action === MessageActions.PAGE_TRANSLATE && options.frameId === frameId
      ))).toBe(true));
      const firstChildStart = browser.tabs.sendMessage.mock.calls.find(([, message, options]) => (
        message.action === MessageActions.PAGE_TRANSLATE && options.frameId === frameId
      ))[1];
      const activeAttemptId = firstChildStart.data.manualContinuityAttemptId;
      const activeAttemptRevision = firstChildStart.data.manualContinuityAttemptRevision;
      expect(activeAttemptRevision).toBeGreaterThan(reservedRevision);
      expect(activeAttemptId).not.toBe(original.attemptId);

      topAck.resolve({ success: true });
      await vi.waitFor(async () => {
        const current = await pageNavigationTracker.getManualContinuity(42);
        expect(current.acceptedAttemptIds?.[0]).toBe(activeAttemptId);
        expect(current.acceptedAttemptRevisions?.[0]).toBe(String(activeAttemptRevision));
      });
      initialChildAck.resolve({ success: false, reason: 'initial_rejected' });
      await expect(replacementStart).resolves.toMatchObject({ success: true });
      await vi.waitFor(() => expect(retryCalls).toBe(2));

      const childStarts = browser.tabs.sendMessage.mock.calls.filter(([, message, options]) => (
        message.action === MessageActions.PAGE_TRANSLATE && options.frameId === frameId
      ));
      expect(childStarts).toHaveLength(2);
      expect(childStarts.map(([, message]) => message.data.manualContinuityAttemptId))
        .toEqual([activeAttemptId, activeAttemptId]);
      expect(childStarts.map(([, message]) => message.data.manualContinuityAttemptRevision))
        .toEqual([activeAttemptRevision, activeAttemptRevision]);
      const afterRejectedRetry = await pageNavigationTracker.getManualContinuity(42);
      expect(afterRejectedRetry.acceptedAttemptIds?.[frameId]).toBe(original.attemptId);
      expect(afterRejectedRetry.acceptedDocuments?.[frameId]).toBe('frame-97-token');
    } finally {
      grantGate.resolve();
      grantSpy.mockRestore();
    }
  });

  it('revokes exact provisional settings proof before ACK and ignores the late successful ACK', async () => {
    const pendingResponse = deferred();
    const grant = await beginUnconfirmedManualStart(pendingResponse.promise);
    const provisional = await pageNavigationTracker.getManualContinuity(42);
    expect(provisional).toMatchObject({ armed: false, revoked: false });
    const report = {
      action: MessageActions.PAGE_TRANSLATE_STOP_AUTO,
      data: {
        settingsInvalidation: true,
        expectedManualContinuityGeneration: grant.generation,
        topDocumentEpoch: grant.topDocumentEpoch,
        manualContinuityAttemptId: grant.provisionalAttemptIds[0],
        manualContinuityAttemptRevision: Number(grant.provisionalAttemptRevisions[0]),
        documentToken: grant.provisionalDocuments[0],
      },
    };
    setupBoundedFrames([{ frameId: 0, run: () => Promise.resolve({ success: true }) }]);

    await expect(handlePageTranslation({
      ...report,
      data: { ...report.data, manualContinuityAttemptId: 'mismatched-attempt' },
    }, { ...sender, frameId: 0 })).resolves.toMatchObject({
      success: false, reason: 'manual_continuity_stop_superseded',
    });
    const invalidation = await handlePageTranslation(report, { ...sender, frameId: 0 });
    expect(invalidation).toMatchObject({ success: true });
    expect(await pageNavigationTracker.getManualContinuity(42)).toBeNull();

    pendingResponse.resolve({ success: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(await pageNavigationTracker.getManualContinuity(42)).toBeNull();
    expect(await pageNavigationTracker.getManualContinuityForRevocation(42)).toMatchObject({
      revoked: true, revokedGeneration: grant.generation,
    });
  });

  it('keeps ownership after a dispatched timeout until late confirmation settles', async () => {
    const pendingResponse = deferred();
    const grant = await beginUnconfirmedManualStart(pendingResponse.promise);
    const revision = pageNavigationTracker.manualContinuityRevision.get(42);
    setupBoundedFrames([{ frameId: 0, run: () => Promise.resolve({ success: true }) }]);
    await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender))
      .resolves.toMatchObject({ success: false, reason: 'manual_start_pending' });
    expect(pageNavigationTracker.manualContinuityRevision.get(42)).toBe(revision);

    pendingResponse.resolve({ success: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({
      generation: grant.generation, armed: true, revoked: false,
    });
  });

  it('retains a no-grant start owner after timeout until the underlying send settles', async () => {
    const pendingResponse = deferred();
    setupBoundedFrames([{ frameId: 0, run: () => pendingResponse.promise }]);
    const seed = vi.spyOn(pageNavigationTracker, 'seed').mockRejectedValueOnce(new Error('navigation unavailable'));
    const result = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message]) => (
      message.action === MessageActions.PAGE_TRANSLATE
    ))).toBe(true));
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS + 1);
    await expect(result).resolves.toMatchObject({ success: false, isTransportFailure: true });
    expect(await pageNavigationTracker.getManualContinuity(42)).toBeNull();
    await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender))
      .resolves.toMatchObject({ success: false, reason: 'manual_start_pending' });
    pendingResponse.resolve({ success: true });
    seed.mockRestore();
    await vi.waitFor(async () => {
      setupBoundedFrames([{ frameId: 0, run: () => Promise.resolve({ success: true }) }]);
      expect(await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender))
        .toMatchObject({ success: true });
    });
  });

  it('revokes an unconfirmed timed-out grant when its response is later rejected', async () => {
    const pendingResponse = deferred();
    await beginUnconfirmedManualStart(pendingResponse.promise);

    pendingResponse.resolve({ success: false, reason: 'token_confirmation_rejected' });
    await vi.advanceTimersByTimeAsync(0);
    expect(await pageNavigationTracker.getManualContinuity(42)).toBeNull();
  });

  it('reconciles a successful timed-out frame while another frame rejects', async () => {
    const lateFrame = deferred();
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: false, reason: 'rejected' }) },
      { frameId: 7, run: () => lateFrame.promise },
    ]);
    const result = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS + 1);
    await expect(result).resolves.toMatchObject({ success: false, reason: 'rejected' });
    const provisional = await pageNavigationTracker.getManualContinuity(42);
    expect(provisional).toMatchObject({ armed: false, revoked: false });

    lateFrame.resolve({ success: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({
      generation: provisional.generation, armed: true, revoked: false,
    });
  });

  it('waits for all late ACK reconciliations before revoking after adverse success/rejection order', async () => {
    const lateSuccess = deferred();
    const lateRejection = deferred();
    setupBoundedFrames([
      { frameId: 0, run: () => lateSuccess.promise },
      { frameId: 7, run: () => lateRejection.promise },
    ]);
    const originalPromote = pageNavigationTracker.promoteManualFrameAcceptance.bind(pageNavigationTracker);
    const promotionGate = deferred();
    const promote = vi.spyOn(pageNavigationTracker, 'promoteManualFrameAcceptance')
      .mockImplementation(async (...args) => {
        await promotionGate.promise;
        return originalPromote(...args);
      });
    const clear = vi.spyOn(pageNavigationTracker, 'clearProvisionalManualFrameAcceptance');
    const result = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.filter(([, message]) => (
      message.action === MessageActions.PAGE_TRANSLATE && message.data?.hasManualContinuity
    ))).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS + 1);
    await expect(result).resolves.toMatchObject({ success: false, isTransportFailure: true });
    const provisional = await pageNavigationTracker.getManualContinuity(42);
    expect(provisional).toMatchObject({ armed: false, revoked: false });

    lateSuccess.resolve({ success: true });
    await vi.waitFor(() => expect(promote).toHaveBeenCalledOnce());
    lateRejection.resolve({
      success: false, reason: 'token_confirmation_rejected', documentToken: provisional.provisionalDocuments[7],
    });
    await vi.waitFor(() => expect(clear).toHaveBeenCalled());
    expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({
      generation: provisional.generation, armed: false, revoked: false,
    });
    await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender))
      .resolves.toMatchObject({ success: false, reason: 'manual_start_pending' });

    promotionGate.resolve();
    await vi.waitFor(async () => expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({
      generation: provisional.generation, armed: true, revoked: false,
    }));
    expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({
      generation: provisional.generation, armed: true, revoked: false,
    });
  });

  it('revokes an unconfirmed provisional grant after every timed-out delivery rejects', async () => {
    const lateFrame = deferred();
    setupBoundedFrames([
      { frameId: 0, run: () => Promise.resolve({ success: false, reason: 'rejected' }) },
      { frameId: 7, run: () => lateFrame.promise },
    ]);
    const result = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS + 1);
    await result;
    const provisional = await pageNavigationTracker.getManualContinuity(42);
    expect(provisional).toMatchObject({ armed: false, revoked: false });

    lateFrame.resolve({ success: false, reason: 'rejected' });
    await vi.advanceTimersByTimeAsync(0);
    expect(await pageNavigationTracker.getManualContinuity(42)).toBeNull();
    setupBoundedFrames([{ frameId: 0, run: () => Promise.resolve({ success: true }) }]);
    await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender))
      .resolves.toMatchObject({ success: true });
    const replacement = await pageNavigationTracker.getManualContinuity(42);
    expect(replacement).toMatchObject({ generation: expect.any(Number), armed: true, revoked: false });
    expect(replacement.generation).toBeGreaterThan(provisional.generation);
    await vi.advanceTimersByTimeAsync(0);
    expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({
      generation: replacement.generation, armed: true, revoked: false,
    });
  });

  it('keeps human confirmation pending beyond 30 seconds and arms when accepted', async () => {
    const admissionGate = deferred();
    const pendingResponse = deferred();
    setupBoundedFrames([{ frameId: 0, run: () => pendingResponse.promise }]);
    browser.tabs.sendMessage.mockImplementation(async (tabId, message, { frameId }) => {
      if (message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE) {
        return { documentToken: 'top-document-token' };
      }
      if (message.action === MessageActions.PAGE_TRANSLATE && message.data?.hasManualContinuity) {
        await admissionGate.promise;
        const admission = await handlePageTranslation({
          action: MessageActions.PAGE_TRANSLATE_ADMIT,
          data: {
            ...message.data, origin: 'manual-start', admissionPhase: 'accept',
            documentToken: 'top-document-token',
          },
        }, { tab: { id: tabId }, frameId });
        if (!admission.success) return admission;
        const response = await pendingResponse.promise;
        return response.success ? { ...response, documentToken: 'top-document-token' } : response;
      }
      return { success: true };
    });
    const result = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS + 1);
    await expect(result).resolves.toMatchObject({ success: false, reason: 'frame_command_response_timeout' });
    const grant = await pageNavigationTracker.getManualContinuity(42);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({
      generation: grant.generation, armed: false, revoked: false,
    });
    const revision = pageNavigationTracker.manualContinuityRevision.get(42);
    await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender))
      .resolves.toMatchObject({ success: false, reason: 'manual_start_pending' });
    expect(pageNavigationTracker.manualContinuityRevision.get(42)).toBe(revision);
    admissionGate.resolve();
    await vi.waitFor(() => expect(browser.tabs.sendMessage).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(0);
    const probesBeforeAck = browser.tabs.sendMessage.mock.calls.filter(([, message]) => (
      message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE
    )).length;
    pendingResponse.resolve({ success: true });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(async () => expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({
      generation: grant.generation, armed: true, revoked: false,
    }));
    const confirmed = await pageNavigationTracker.getManualContinuity(42);
    expect(confirmed.acceptedAttemptIds).toEqual({ 0: grant.attemptId });
    expect(confirmed.acceptedAttemptRevisions).toEqual({ 0: String(grant.attemptRevision) });
    expect(browser.tabs.sendMessage.mock.calls.filter(([, message]) => (
      message.action === MessageActions.PAGE_TRANSLATE_FRAME_PROBE
    ))).toHaveLength(probesBeforeAck);
  });

  it.each([MessageActions.PAGE_RESTORE, MessageActions.PAGE_TRANSLATE_STOP_AUTO])(
    'does not arm a late confirmation after concurrent %s', async action => {
      const pendingResponse = deferred();
      await beginUnconfirmedManualStart(pendingResponse.promise);
      setupBoundedFrames([{ frameId: 0, run: () => Promise.resolve({ success: true }) }]);
      await handlePageTranslation({ action }, sender);

      pendingResponse.resolve({ success: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(await pageNavigationTracker.getManualContinuity(42)).toBeNull();
    }
  );

  it('ignores an old late acceptance after Stop releases ownership to a replacement start', async () => {
    const oldResponse = deferred();
    const oldGrant = await beginUnconfirmedManualStart(oldResponse.promise);
    setupBoundedFrames([{ frameId: 0, run: () => Promise.resolve({ success: true }) }]);
    await handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE_STOP_AUTO }, sender);
    await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender))
      .resolves.toMatchObject({ success: true });
    const replacement = await pageNavigationTracker.getManualContinuity(42);
    expect(replacement.generation).toBeGreaterThan(oldGrant.generation);
    expect(replacement).toMatchObject({ armed: true, revoked: false });

    oldResponse.resolve({ success: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({
      generation: replacement.generation, armed: true, revoked: false,
    });
  });

  it('does not arm a late confirmation after superseding navigation/start', async () => {
    const pendingResponse = deferred();
    const grant = await beginUnconfirmedManualStart(pendingResponse.promise);
    await pageNavigationTracker.committed(42, 0, 'https://frame-0.example/new');

    pendingResponse.resolve({ success: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(await pageNavigationTracker.getManualContinuity(42)).not.toMatchObject({
      generation: grant.generation, armed: true,
    });
  });

  it('does not arm a late confirmation after a newer manual start reserves the tab', async () => {
    const pendingResponse = deferred();
    const grant = await beginUnconfirmedManualStart(pendingResponse.promise);
    pageNavigationTracker.reserveManualContinuityStart(42);

    pendingResponse.resolve({ success: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({
      generation: grant.generation, armed: false,
    });
  });

  it('ignores a gated stale ACK across navigation, Stop revocation, and a newer attempt', async () => {
    const oldResponse = deferred();
    const oldGrant = await beginUnconfirmedManualStart(oldResponse.promise);
    const promotionGate = deferred();
    const gatedPromotion = vi.spyOn(pageNavigationTracker, 'promoteManualFrameAcceptance')
      .mockImplementation(async (...args) => {
        if (args[2] === oldGrant.attemptId) await promotionGate.promise;
        return PageNavigationTracker.prototype.promoteManualFrameAcceptance.call(pageNavigationTracker, ...args);
      });

    oldResponse.resolve({ success: true });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(gatedPromotion).toHaveBeenCalledOnce());
    await onCommittedListener({
      tabId: 42, frameId: 0, url: 'https://frame-0.example/navigated', transitionType: 'link',
    });
    expect(await revokeManualPageAuthority(42)).toBe(true);
    setupBoundedFrames([{ frameId: 0, run: () => Promise.resolve({ success: true }) }]);
    await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender))
      .resolves.toMatchObject({ success: true });
    const newer = await pageNavigationTracker.getManualContinuity(42);
    expect(newer.generation).toBeGreaterThan(oldGrant.generation);

    promotionGate.resolve();
    await vi.waitFor(async () => expect(
      await pageNavigationTracker.getManualContinuity(42),
    ).toMatchObject({ generation: newer.generation, armed: true, revoked: false }));
    expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({
      generation: newer.generation,
      attemptId: newer.attemptId,
      acceptedAttemptIds: { 0: newer.attemptId },
      armed: true,
      revoked: false,
    });
    gatedPromotion.mockRestore();
  });

  it('does not allow a duplicate start to supersede an unresolved dispatched delivery', async () => {
    const pendingResponse = deferred();
    const oldGrant = await beginUnconfirmedManualStart(pendingResponse.promise);
    setupBoundedFrames([{ frameId: 0, run: () => Promise.resolve({ success: true }) }]);

    await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender))
      .resolves.toMatchObject({ success: false, reason: 'manual_start_pending' });
    expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({
      generation: oldGrant.generation, armed: false,
    });

    pendingResponse.resolve({ success: false, reason: 'token_confirmation_rejected' });
    await vi.advanceTimersByTimeAsync(0);
    expect(await pageNavigationTracker.getManualContinuity(42)).toBeNull();
  });

  it('does not let a duplicate start supersede an unresolved definitive delivery', async () => {
    const oldResponse = deferred();
    setupBoundedFrames([{ frameId: 0, run: () => oldResponse.promise }]);
    const oldStart = handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender);
    await vi.waitFor(() => expect(browser.tabs.sendMessage.mock.calls.some(([, message]) => (
      message.action === MessageActions.PAGE_TRANSLATE
    ))).toBe(true));
    const oldGrant = await pageNavigationTracker.getManualContinuity(42);

    setupBoundedFrames([{ frameId: 0, run: () => Promise.resolve({ success: true }) }]);
    await expect(handlePageTranslation({ action: MessageActions.PAGE_TRANSLATE, data: {} }, sender))
      .resolves.toMatchObject({ success: false, reason: 'manual_start_pending' });
    expect(await pageNavigationTracker.getManualContinuity(42)).toMatchObject({
      generation: oldGrant.generation, armed: false,
    });

    oldResponse.resolve({ success: false, reason: 'token_confirmation_rejected' });
    await expect(oldStart).resolves.toMatchObject({ success: false });
    expect(await pageNavigationTracker.getManualContinuity(42)).toBeNull();
  });

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
      {
        success: true, messageId: 'main',
        ...(action === MessageActions.PAGE_TRANSLATE && { documentToken: 'top-document-token' }),
      },
      {
        success: true, messageId: 'child',
        ...(action === MessageActions.PAGE_TRANSLATE && { documentToken: 'frame-14-token' }),
      },
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
      expect(browser.tabs.sendMessage.mock.calls.some(([, message]) => message.action === MessageActions.PAGE_TRANSLATE)).toBe(false);
      cursorRead.resolve({ documentEpoch: 1, routeRevision: 0, url: 'https://frame-0.example' });
      await vi.advanceTimersByTimeAsync(0);
      expect(browser.tabs.sendMessage.mock.calls.some(([, message]) => message.action === MessageActions.PAGE_TRANSLATE)).toBe(false);
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
    expect(browser.tabs.sendMessage.mock.calls.some(([, message]) => message.action === MessageActions.PAGE_TRANSLATE)).toBe(false);
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
