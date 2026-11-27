import { describe, it, expect, vi, beforeEach } from 'vitest';
import browser from 'webextension-polyfill';

vi.mock('webextension-polyfill', () => ({
  default: {
    tabs: {
      sendMessage: vi.fn(),
      query: vi.fn(() => Promise.resolve([])),
      onRemoved: { addListener: vi.fn() },
      onActivated: { addListener: vi.fn() },
    },
    webNavigation: {
      getAllFrames: vi.fn(() => Promise.resolve([])),
      onCommitted: { addListener: vi.fn() },
    },
    scripting: { executeScript: vi.fn() },
    runtime: { sendMessage: vi.fn(() => Promise.resolve()), getURL: vi.fn(() => 'chrome-extension://test/'), id: 'test' },
    storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
  },
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), operation: vi.fn(), init: vi.fn() }),
}));

vi.mock('@/shared/messaging/core/MessagingCore.js', () => ({
  MessagingContexts: { CONTENT: 'CONTENT', BACKGROUND: 'BACKGROUND' },
  MessageFormat: { create: vi.fn((action, data, ctx) => ({ action, data, context: ctx })) },
}));

vi.mock('@/shared/messaging/core/MessageActions.js', () => ({
  MessageActions: {
    ACTIVATE_SELECT_ELEMENT_MODE: 'activateSelectElementMode',
    DEACTIVATE_SELECT_ELEMENT_MODE: 'deactivateSelectElementMode',
    GET_SELECT_ELEMENT_FRAME_STATE: 'getSelectElementFrameState',
    SELECT_ELEMENT_STATE_CHANGED: 'selectElementStateChanged',
  },
}));

vi.mock('@/core/tabPermissions.js', () => ({
  tabPermissionChecker: { checkTabAccess: vi.fn(() => Promise.resolve({ isAccessible: true, fullUrl: 'https://example.com', isRestricted: false })) },
}));

vi.mock('@/core/extensionContext.js', () => ({
  default: { isContextError: vi.fn(() => false), handleContextError: vi.fn(), isValidSync: vi.fn(() => true) },
}));

vi.mock('@/shared/error-management/ErrorHandler.js', () => ({ ErrorHandler: class { handle() {} } }));
vi.mock('../utils/activationError.js', () => ({
  getSelectElementActivationErrorMessage: vi.fn(() => Promise.resolve('Could not activate')),
}));
vi.mock('@/features/exclusion/utils/exclusion-utils.js', () => ({
  checkUrlExclusionAsync: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('@/core/background/handlers/page-translation/handlePageTranslation.js', () => ({
  revokeManualPageAuthority: vi.fn(() => Promise.resolve(true)),
}));

import {
  setStateForTab,
  getStateForTab,
  clearStateForTab,
  clearTabParticipants,
  createActivationGeneration,
  getCurrentGeneration,
  getParticipants,
  getProvisionalCleanupFrames,
  isDeactivationPending,
  markDeactivationPending,
  clearDeactivationPending,
  reconcileNewFrameIfActive,
  getActivationEpoch,
} from './selectElementStateManager.js';
import { handleDeactivateSelectElementMode } from './handleDeactivateSelectElementMode.js';
import { handleActivateSelectElementMode } from './handleActivateSelectElementMode.js';

describe('Background deactivation barrier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const tabId of [201, 202, 203, 204, 205, 206, 207, 208]) {
      clearStateForTab(tabId);
      clearTabParticipants(tabId);
      clearDeactivationPending(tabId);
    }
    browser.webNavigation.getAllFrames.mockResolvedValue([]);
    browser.tabs.sendMessage.mockReset();
    browser.runtime.sendMessage.mockResolvedValue(undefined);
  });

  it('Test 1 — Failed deactivation retains barrier and blocks FRAME_READY', async () => {
    const tabId = 201;
    // Establish active with top + iframe participants
    const gen = createActivationGeneration(tabId);
    const token = (await import('./selectElementStateManager.js')).getActivationAttemptToken(tabId);
    // Register participants via real API
    const { registerParticipant: reg, getParticipants: getP } = await import('./selectElementStateManager.js');
    // Need to use the same generation attempt: registerParticipant checks attempt current
    expect(reg(tabId, 0, gen, 'doc-top')).toBe(true);
    expect(reg(tabId, 5, gen, 'doc-iframe')).toBe(true);
    const { completeActivationAttempt } = await import('./selectElementStateManager.js');
    expect(completeActivationAttempt(tabId, gen, token)).toBe(true);
    setStateForTab(tabId, true);
    expect(getStateForTab(tabId).active).toBe(true);
    expect(getP(tabId).size).toBe(2);

    // Mock deactivation: top succeeds, iframe remains unresolved while live
    browser.tabs.sendMessage.mockImplementation(async (_tid, msg, target) => {
      if (msg.action === 'deactivateSelectElementMode') {
        if (target.frameId === 0) return { success: true, cleanupCompleted: true, activated: false };
        if (target.frameId === 5) return { success: false, cleanupCompleted: false, activated: true };
      }
      return undefined;
    });
    browser.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 0, documentId: 'doc-top' },
      { frameId: 5, documentId: 'doc-iframe' },
    ]);

    const result = await handleDeactivateSelectElementMode({ data: { tabId } }, {});
    expect(result.success).toBe(false);
    expect(isDeactivationPending(tabId)).toBe(true);
    expect(getStateForTab(tabId).active).toBe(true);
    expect(getParticipants(tabId).has(5)).toBe(true);

    // Now FRAME_READY from new frame should be blocked
    browser.tabs.sendMessage.mockClear();
    const reconciled = await reconcileNewFrameIfActive(tabId, 9, 'doc-new');
    expect(reconciled).toBe(false);
    expect(browser.tabs.sendMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'activateSelectElementMode' }),
      expect.anything()
    );
    expect(getParticipants(tabId).has(9)).toBe(false);
    expect(getProvisionalCleanupFrames(tabId).some(f => f.frameId === 9)).toBe(false);
  });

  it('Test 2 — Retry success clears barrier', async () => {
    const tabId = 202;
    const gen = createActivationGeneration(tabId);
    const { getActivationAttemptToken, completeActivationAttempt, registerParticipant } = await import('./selectElementStateManager.js');
    const token = getActivationAttemptToken(tabId);
    expect(registerParticipant(tabId, 0, gen, 'doc-top')).toBe(true);
    expect(registerParticipant(tabId, 5, gen, 'doc-iframe')).toBe(true);
    expect(completeActivationAttempt(tabId, gen, token)).toBe(true);
    setStateForTab(tabId, true);

    // First deactivation fails for iframe
    browser.tabs.sendMessage.mockImplementation(async (_tid, msg, target) => {
      if (msg.action === 'deactivateSelectElementMode' && target.frameId === 5) {
        return { success: false, cleanupCompleted: false, activated: true };
      }
      return { success: true, cleanupCompleted: true, activated: false };
    });
    browser.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 0, documentId: 'doc-top' },
      { frameId: 5, documentId: 'doc-iframe' },
    ]);
    const first = await handleDeactivateSelectElementMode({ data: { tabId } }, {});
    expect(first.success).toBe(false);
    expect(isDeactivationPending(tabId)).toBe(true);

    // Second retry: both succeed
    browser.tabs.sendMessage.mockImplementation(async () => ({ success: true, cleanupCompleted: true, activated: false }));
    browser.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 0, documentId: 'doc-top' },
      { frameId: 5, documentId: 'doc-iframe' },
    ]);
    const second = await handleDeactivateSelectElementMode({ data: { tabId } }, {});
    expect(second.success).toBe(true);
    expect(getStateForTab(tabId).active).toBe(false);
    expect(isDeactivationPending(tabId)).toBe(false);
    expect(getParticipants(tabId).size).toBe(0);

    // FRAME_READY must not activate because canonical inactive
    browser.tabs.sendMessage.mockClear();
    const rec = await reconcileNewFrameIfActive(tabId, 9, 'doc-new');
    expect(rec).toBe(false);
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('Test 3 — Fresh activation while pending: cleanup failure blocks new generation', async () => {
    const tabId = 203;
    const gen = createActivationGeneration(tabId);
    const { getActivationAttemptToken, completeActivationAttempt, registerParticipant } = await import('./selectElementStateManager.js');
    const token = getActivationAttemptToken(tabId);
    expect(registerParticipant(tabId, 0, gen, 'doc-top')).toBe(true);
    expect(completeActivationAttempt(tabId, gen, token)).toBe(true);
    setStateForTab(tabId, true);

    // Make deactivation fail to establish pending
    browser.tabs.sendMessage.mockResolvedValue({ success: false, cleanupCompleted: false, activated: true });
    browser.webNavigation.getAllFrames.mockResolvedValue([{ frameId: 0, documentId: 'doc-top' }]);
    const fail = await handleDeactivateSelectElementMode({ data: { tabId } }, {});
    expect(fail.success).toBe(false);
    expect(isDeactivationPending(tabId)).toBe(true);
    const genBefore = getCurrentGeneration(tabId);

    // Now attempt fresh activation — old cleanup will be retried and fail again
    browser.tabs.sendMessage.mockResolvedValue({ success: false, cleanupCompleted: false, activated: true });
    browser.webNavigation.getAllFrames.mockResolvedValue([{ frameId: 0, documentId: 'doc-top' }]);
    // need tabPermissions mock success already
    const activateResult = await handleActivateSelectElementMode({ data: { tabId, active: true } }, { tab: { id: tabId } });
    expect(activateResult.success).toBe(false);
    expect(activateResult.activated).toBe(false);
    expect(isDeactivationPending(tabId)).toBe(true);
    // No new generation committed
    expect(getCurrentGeneration(tabId)).toBe(genBefore);
    expect(browser.tabs.sendMessage).not.toHaveBeenCalledWith(
      tabId,
      expect.objectContaining({ action: 'activateSelectElementMode' }),
      expect.anything()
    );
  });

  it('Test 4 — Fresh activation while pending: cleanup success allows new session', async () => {
    const tabId = 204;
    const gen = createActivationGeneration(tabId);
    const { getActivationAttemptToken, completeActivationAttempt, registerParticipant } = await import('./selectElementStateManager.js');
    const token = getActivationAttemptToken(tabId);
    expect(registerParticipant(tabId, 0, gen, 'doc-top')).toBe(true);
    expect(completeActivationAttempt(tabId, gen, token)).toBe(true);
    setStateForTab(tabId, true);

    // Establish pending via failed deactivation
    browser.tabs.sendMessage.mockResolvedValue({ success: false, cleanupCompleted: false, activated: true });
    browser.webNavigation.getAllFrames.mockResolvedValue([{ frameId: 0, documentId: 'doc-top' }]);
    const fail = await handleDeactivateSelectElementMode({ data: { tabId } }, {});
    expect(fail.success).toBe(false);
    expect(isDeactivationPending(tabId)).toBe(true);
    const oldGen = getCurrentGeneration(tabId);

    // Now fresh activation: first cleanup succeeds, then activation succeeds
    // For handleActivate, it will first call handleDeactivate which needs to succeed
    // Then it will do getAllFrames and send ACTIVATE
    let deactivateCallCount = 0;
    browser.tabs.sendMessage.mockImplementation(async (_tid, msg) => {
      if (msg.action === 'deactivateSelectElementMode') {
        deactivateCallCount++;
        return { success: true, cleanupCompleted: true, activated: false };
      }
      if (msg.action === 'activateSelectElementMode') {
        return { success: true, activated: true, activationGeneration: oldGen + 1, activationEpoch: getActivationEpoch() };
      }
      return undefined;
    });
    browser.webNavigation.getAllFrames.mockResolvedValue([{ frameId: 0, documentId: 'doc-top' }]);
    const result = await handleActivateSelectElementMode({ data: { tabId, active: true } }, { tab: { id: tabId } });
    expect(result.success).toBe(true);
    expect(result.activated).toBe(true);
    expect(isDeactivationPending(tabId)).toBe(false);
    expect(getStateForTab(tabId).active).toBe(true);
    expect(deactivateCallCount).toBeGreaterThan(0);
    const newGen = getCurrentGeneration(tabId);
    expect(newGen).toBeGreaterThan(oldGen);
    expect(getParticipants(tabId).has(0)).toBe(true);
    // Ensure old generation not retained
    expect(getParticipants(tabId).get(0)).toBe(newGen);
  });

  it('Test 5 — Tab retirement clears barrier', async () => {
    const tabId = 205;
    markDeactivationPending(tabId);
    expect(isDeactivationPending(tabId)).toBe(true);
    clearStateForTab(tabId);
    expect(isDeactivationPending(tabId)).toBe(false);
    // Also via clearTabParticipants
    markDeactivationPending(tabId);
    expect(isDeactivationPending(tabId)).toBe(true);
    clearTabParticipants(tabId);
    expect(isDeactivationPending(tabId)).toBe(false);
  });
});
