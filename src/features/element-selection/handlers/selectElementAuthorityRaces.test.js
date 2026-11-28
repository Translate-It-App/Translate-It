import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import browser from 'webextension-polyfill';

vi.mock('webextension-polyfill', () => ({
  default: {
    tabs: {
      sendMessage: vi.fn(), query: vi.fn(() => Promise.resolve([])),
      onRemoved: { addListener: vi.fn() },
    },
    webNavigation: { getAllFrames: vi.fn(() => Promise.resolve([])), onCommitted: { addListener: vi.fn() } },
    scripting: { executeScript: vi.fn() },
    runtime: { sendMessage: vi.fn(() => Promise.resolve()), getURL: vi.fn(() => 'chrome-extension://test/'), id: 'test' },
    storage: {
      session: { get: vi.fn(() => Promise.resolve({})), set: vi.fn(() => Promise.resolve()) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    contextMenus: { create: vi.fn(), update: vi.fn(), remove: vi.fn(), removeAll: vi.fn(), onClicked: { addListener: vi.fn() } },
  },
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), operation: vi.fn(), init: vi.fn() }),
}));

vi.mock('@/shared/messaging/core/MessagingCore.js', () => ({
  MessagingContexts: { CONTENT: 'CONTENT', BACKGROUND: 'BACKGROUND' },
  MessageFormat: { create: vi.fn((action, data) => ({ action, data })), serializeTranslationError: vi.fn() },
}));

vi.mock('@/shared/messaging/core/MessageActions.js', () => ({
  MessageActions: {
    ACTIVATE_SELECT_ELEMENT_MODE: 'activateSelectElementMode',
    DEACTIVATE_SELECT_ELEMENT_MODE: 'deactivateSelectElementMode',
    GET_SELECT_ELEMENT_FRAME_STATE: 'getSelectElementFrameState',
    SELECT_ELEMENT_FRAME_READY: 'selectElementFrameReady',
    SELECT_ELEMENT_STATE_CHANGED: 'selectElementStateChanged',
    IFRAME_SELECT_ELEMENT_FINISHED: 'IFRAME_SELECT_ELEMENT_FINISHED',
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
  revokeManualPageAuthority: vi.fn(),
}));

import {
  clearStateForTab,
  clearTabParticipants,
  completeActivationAttempt,
  createActivationGeneration,
  getActivationAttemptToken,
  getActivationEpoch,
  getCompatibilityFrames,
  getCurrentGeneration,
  getParticipantInfo,
  getParticipants,
  getParticipantsWithDocuments,
  getProvisionalCleanupFrames,
  getStateForTab,
  invalidateJoinAuthority,
  isFrameDocumentLive,
  recordActivationAttemptFrames,
  registerParticipant,
  reconcileNewFrameIfActive,
  setStateForTab,
  settleActivationAttemptFrame,
} from './selectElementStateManager.js';
import { handleDeactivateSelectElementMode } from './handleDeactivateSelectElementMode.js';
import { handleActivateSelectElementMode } from './handleActivateSelectElementMode.js';
import { handleSelectElementFrameReady } from './handleSelectElementFrameReady.js';
import { checkUrlExclusionAsync } from '@/features/exclusion/utils/exclusion-utils.js';
import { revokeManualPageAuthority } from '@/core/background/handlers/page-translation/handlePageTranslation.js';

function establishActiveSession(tabId, frameId, documentId) {
  const generation = createActivationGeneration(tabId);
  const token = getActivationAttemptToken(tabId);
  recordActivationAttemptFrames(tabId, generation, [{ frameId, documentId }]);
  expect(registerParticipant(tabId, frameId, generation, documentId)).toBe(true);
  settleActivationAttemptFrame(tabId, generation, frameId);
  expect(completeActivationAttempt(tabId, generation, token)).toBe(true);
  setStateForTab(tabId, true);
  return generation;
}

function establishProvisionalDebt(tabId, frameId, documentId) {
  const generation = createActivationGeneration(tabId);
  const token = getActivationAttemptToken(tabId);
  recordActivationAttemptFrames(tabId, generation, [{ frameId, documentId }]);
  expect(completeActivationAttempt(tabId, generation, token)).toBe(true);
  return generation;
}

describe('Select Element authority races', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    revokeManualPageAuthority.mockResolvedValue(true);
    for (const tabId of [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119]) {
      clearStateForTab(tabId);
      clearTabParticipants(tabId);
    }
    browser.webNavigation.getAllFrames = vi.fn(() => Promise.resolve([]));
    browser.tabs.sendMessage.mockReset();
    browser.runtime.sendMessage.mockReset();
    browser.runtime.sendMessage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reconciles retained active state before publishing inactive', async () => {
    const tabId = 101;
    browser.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 0, documentId: 'doc-101', url: 'https://example.com' },
    ]);
    browser.tabs.sendMessage.mockImplementation(async (_tabId, message) => {
      if (message.action === 'getSelectElementFrameState') {
        return { active: true, activationEpoch: 'epoch-E1', activationGeneration: 1 };
      }
      return { success: true, cleanupCompleted: true, activated: false };
    });

    const result = await handleDeactivateSelectElementMode({ data: { tabId } }, {});

    expect(result).toMatchObject({ success: true, active: false });
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(
      tabId,
      expect.objectContaining({
        action: 'deactivateSelectElementMode',
        data: expect.objectContaining({ activationEpoch: 'epoch-E1', activationGeneration: 1 }),
      }),
      { frameId: 0, documentId: 'doc-101' },
    );
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'selectElementStateChanged',
        data: expect.objectContaining({ tabId, active: false }),
      }),
    );
  });

  it('fails closed when frame enumeration rejects without publishing inactive', async () => {
    const tabId = 102;
    browser.webNavigation.getAllFrames.mockRejectedValue(new Error('navigation unavailable'));

    const result = await handleDeactivateSelectElementMode({ data: { tabId } }, {});

    expect(result).toMatchObject({ success: false });
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('fails closed when frame enumeration is unavailable', async () => {
    const tabId = 103;
    browser.webNavigation.getAllFrames = undefined;

    const result = await handleDeactivateSelectElementMode({ data: { tabId } }, {});

    expect(result).toMatchObject({ success: false });
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('treats current-document no-receiver as unknown', async () => {
    const tabId = 104;
    browser.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 0, documentId: 'doc-104', url: 'https://example.com' },
    ]);
    browser.tabs.sendMessage.mockRejectedValue(new Error('Receiving end does not exist'));

    const result = await handleDeactivateSelectElementMode({ data: { tabId } }, {});

    expect(result).toMatchObject({ success: false });
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('skips structurally non-injectable frames during reconciliation', async () => {
    const tabId = 105;
    browser.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 0, documentId: 'doc-105', url: 'chrome://settings' },
    ]);

    const result = await handleDeactivateSelectElementMode({ data: { tabId } }, {});

    expect(result).toMatchObject({ success: true, active: false });
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'selectElementStateChanged',
      data: { tabId, active: false },
    });
  });

  it('accepts no-receiver only after proving the frame is too small to host Content', async () => {
    const tabId = 106;
    browser.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 5, documentId: 'doc-106', url: 'https://ads.example/frame' },
    ]);
    browser.tabs.sendMessage.mockRejectedValue(new Error('Receiving end does not exist'));
    browser.scripting.executeScript.mockResolvedValue([
      { frameId: 5, result: { width: 40, height: 100 } },
    ]);

    const result = await handleDeactivateSelectElementMode({ data: { tabId } }, {});

    expect(result).toMatchObject({ success: true, active: false });
    expect(browser.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId, frameIds: [5] },
    }));
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'selectElementStateChanged',
      data: { tabId, active: false },
    });
  });

  it('keeps top-frame NO_RECEIVER as UNKNOWN even when viewport is <80', async () => {
    const tabId = 113;
    browser.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 0, documentId: 'doc-113', url: 'https://example.com' },
    ]);
    browser.tabs.sendMessage.mockRejectedValue(new Error('Receiving end does not exist'));
    browser.scripting.executeScript.mockResolvedValue([
      { frameId: 0, result: { width: 40, height: 30 } },
    ]);

    const result = await handleDeactivateSelectElementMode({ data: { tabId } }, {});

    expect(result).toMatchObject({ success: false });
    expect(browser.scripting.executeScript).not.toHaveBeenCalled();
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('ignores payload documentId and trusts sender plus webNavigation', async () => {
    const tabId = 114;
    const generation = establishActiveSession(tabId, 0, 'doc-top-114');
    browser.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 0, documentId: 'doc-top-114', url: 'https://example.com' },
      { frameId: 5, documentId: 'doc-real-114', url: 'https://example.com/frame' },
    ]);
    browser.tabs.sendMessage.mockImplementation(async (_tabId, message, target) => {
      expect(target).toEqual({ frameId: 5, documentId: 'doc-real-114' });
      expect(message.data.activationGeneration).toBe(generation);
      return {
        success: true,
        activated: true,
        activationGeneration: generation,
        activationEpoch: getActivationEpoch(),
      };
    });

    const result = await handleSelectElementFrameReady(
      { data: { documentId: 'doc-evil-114' } },
      { tab: { id: tabId }, frameId: 5 },
    );

    expect(result).toMatchObject({ success: true, joined: true, documentId: 'doc-real-114' });
    expect(getParticipantsWithDocuments(tabId).get(5)).toEqual({
      generation,
      documentId: 'doc-real-114',
    });
  });

  it('joins a ready iframe once using current generation and records participant ownership', async () => {
    const tabId = 107;
    const generation = establishActiveSession(tabId, 0, 'doc-top-106');
    browser.tabs.sendMessage.mockImplementation(async (_tabId, message, target) => {
      expect(message.action).toBe('activateSelectElementMode');
      expect(target).toEqual({ frameId: 5, documentId: 'doc-5-106' });
      expect(message.data.activationGeneration).toBe(generation);
      expect(message.data.activationEpoch).toBe(getActivationEpoch());
      return {
        success: true,
        activated: true,
        activationGeneration: generation,
        activationEpoch: getActivationEpoch(),
      };
    });

    const result = await handleSelectElementFrameReady(
      {},
      { tab: { id: tabId }, frameId: 5, documentId: 'doc-5-106' },
    );

    expect(result).toMatchObject({ success: true, joined: true });
    expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(getCurrentGeneration(tabId)).toBe(generation);
    expect(getParticipants(tabId).get(5)).toBe(generation);
    expect(getParticipantsWithDocuments(tabId).get(5)).toEqual({
      generation,
      documentId: 'doc-5-106',
    });
  });

  it('rejects a late iframe ACK after canonical join invalidation', async () => {
    const tabId = 108;
    const generation = establishActiveSession(tabId, 0, 'doc-top-107');
    let resolveActivation;
    let activationSent = false;
    browser.tabs.sendMessage.mockImplementation(async (_tabId, message) => {
      if (message.action === 'activateSelectElementMode') {
        activationSent = true;
        return new Promise(resolve => { resolveActivation = resolve; });
      }
      return { success: true, cleanupCompleted: true, activated: false };
    });

    const joinPromise = reconcileNewFrameIfActive(tabId, 5, 'doc-5-107');
    await vi.waitFor(() => expect(activationSent).toBe(true));
    expect(activationSent).toBe(true);

    invalidateJoinAuthority(tabId);
    setStateForTab(tabId, false);
    resolveActivation({
      success: true,
      activated: true,
      activationGeneration: generation,
      activationEpoch: getActivationEpoch(),
    });

    expect(await joinPromise).toBe(false);
    expect(getParticipants(tabId).has(5)).toBe(false);
    expect(getStateForTab(tabId).active).toBe(false);
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(
      tabId,
      expect.objectContaining({
        action: 'deactivateSelectElementMode',
        data: expect.objectContaining({
          fromBackground: true,
          activationGeneration: generation,
          activationEpoch: getActivationEpoch(),
        }),
      }),
      { frameId: 5, documentId: 'doc-5-107' },
    );
    expect(getProvisionalCleanupFrames(tabId)).toEqual([]);
  });

  it('clears join cleanup debt only after a strict ACK becomes a participant', async () => {
    const tabId = 119;
    const generation = establishActiveSession(tabId, 0, 'doc-top-119');
    let resolveActivation;
    browser.tabs.sendMessage.mockImplementation((_tabId, message) => {
      if (message.action === 'activateSelectElementMode') {
        return new Promise(resolve => { resolveActivation = resolve; });
      }
      return { success: true, cleanupCompleted: true, activated: false };
    });

    const joinPromise = reconcileNewFrameIfActive(tabId, 5, 'doc-5-119');
    await vi.waitFor(() => expect(getProvisionalCleanupFrames(tabId)).toEqual([
      { frameId: 5, generation, documentId: 'doc-5-119' },
    ]));
    resolveActivation({
      success: true,
      activated: true,
      activationGeneration: generation,
      activationEpoch: getActivationEpoch(),
    });

    await expect(joinPromise).resolves.toBe(true);
    expect(getParticipants(tabId).get(5)).toBe(generation);
    expect(getProvisionalCleanupFrames(tabId)).toEqual([]);
    expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('removes D1 cleanup debt while preserving live D2 participant ownership', async () => {
    const tabId = 109;
    const d1Generation = establishProvisionalDebt(tabId, 5, 'doc-D1');
    const d2Generation = createActivationGeneration(tabId);
    const d2Token = getActivationAttemptToken(tabId);
    recordActivationAttemptFrames(tabId, d2Generation, [{ frameId: 5, documentId: 'doc-D2' }]);
    expect(registerParticipant(tabId, 5, d2Generation, 'doc-D2')).toBe(true);
    settleActivationAttemptFrame(tabId, d2Generation, 5);
    expect(completeActivationAttempt(tabId, d2Generation, d2Token)).toBe(true);
    setStateForTab(tabId, true);
    expect(getProvisionalCleanupFrames(tabId)).toEqual([
      { frameId: 5, generation: d1Generation, documentId: 'doc-D1' },
    ]);

    browser.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 5, documentId: 'doc-D2', url: 'https://example.com/frame' },
    ]);
    let resolveD2Cleanup;
    let d1CleanupObserved;
    browser.tabs.sendMessage.mockImplementation(async (_tabId, message, target) => {
      if (message.action !== 'deactivateSelectElementMode') return undefined;
      if (target.documentId === 'doc-D1') {
        d1CleanupObserved = getParticipantInfo(tabId, 5);
        throw new Error('D1 cleanup transport failure');
      }
      if (target.documentId === 'doc-D2') {
        return new Promise(resolve => { resolveD2Cleanup = resolve; });
      }
      throw new Error('Unexpected target');
    });

    const deactivation = handleDeactivateSelectElementMode({ data: { tabId } }, {});
    await vi.waitFor(() => expect(d1CleanupObserved).toEqual({
      generation: d2Generation,
      documentId: 'doc-D2',
    }));
    expect(getParticipantInfo(tabId, 5)).toEqual({
      generation: d2Generation,
      documentId: 'doc-D2',
    });
    expect(await isFrameDocumentLive(tabId, 5, 'doc-D1')).toBe(false);

    resolveD2Cleanup({ success: true, cleanupCompleted: true, activated: false });
    expect(await deactivation).toMatchObject({ success: true, active: false });
    expect(getParticipantsWithDocuments(tabId).size).toBe(0);
    expect(getProvisionalCleanupFrames(tabId)).toEqual([]);
  });

  it('keeps epoch-less activation in compatibility ownership instead of strict participants', async () => {
    const tabId = 110;
    let activationGeneration;
    browser.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 0, documentId: 'doc-109', url: 'https://example.com' },
    ]);
    browser.tabs.sendMessage.mockImplementation(async (_tabId, message) => {
      activationGeneration = message.data.activationGeneration;
      return { success: true, activated: true, activationGeneration };
    });

    const result = await handleActivateSelectElementMode({ data: { tabId, active: true } }, {});

    expect(result).toMatchObject({ success: true, activated: true });
    expect(getParticipants(tabId).size).toBe(0);
    expect(getCompatibilityFrames(tabId)).toEqual(new Map([[0, activationGeneration]]));
  });

  it('waits for tab authority revocation before dispatching Select activation', async () => {
    const tabId = 120;
    let finishRevocation;
    revokeManualPageAuthority.mockImplementation(() => new Promise(resolve => { finishRevocation = resolve; }));
    browser.tabs.sendMessage.mockImplementation(async (_id, message) => ({
      success: true,
      activated: true,
      activationGeneration: message.data.activationGeneration,
      activationEpoch: message.data.activationEpoch,
    }));
    const activation = handleActivateSelectElementMode({ data: { tabId, active: true } }, {});
    await vi.waitFor(() => expect(finishRevocation).toBeTypeOf('function'));
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
    finishRevocation(true);
    await expect(activation).resolves.toMatchObject({ success: true, activated: true });
    expect(revokeManualPageAuthority).toHaveBeenCalledWith(tabId);
    expect(browser.tabs.sendMessage).toHaveBeenCalled();
  });

  it('does not dispatch Select activation when tab authority revocation fails', async () => {
    const tabId = 121;
    revokeManualPageAuthority.mockResolvedValue(false);
    const result = await handleActivateSelectElementMode({ data: { tabId, active: true } }, {});
    expect(result).toMatchObject({ success: false, activated: false });
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('reuses authoritative generation for ready iframe without allocating another generation', async () => {
    const tabId = 111;
    const generation = establishActiveSession(tabId, 0, 'doc-top-110');
    browser.tabs.sendMessage.mockImplementation(async (_tabId, message) => ({
      success: true,
      activated: true,
      activationGeneration: message.data.activationGeneration,
      activationEpoch: message.data.activationEpoch,
    }));

    const result = await handleSelectElementFrameReady(
      {},
      { tab: { id: tabId }, frameId: 5, documentId: 'doc-5-110' },
    );
    const nextGeneration = createActivationGeneration(tabId);

    expect(result).toMatchObject({ success: true, joined: true });
    expect(getCurrentGeneration(tabId)).toBe(generation);
    expect(getParticipants(tabId).get(5)).toBe(generation);
    expect(nextGeneration).toBe(generation + 1);
  });

  it('ignores frame-ready events for inactive tabs', async () => {
    const tabId = 112;

    const result = await handleSelectElementFrameReady(
      {},
      { tab: { id: tabId }, frameId: 5, documentId: 'doc-5-111' },
    );

    expect(result).toMatchObject({ success: true, joined: false });
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
    expect(getParticipants(tabId).size).toBe(0);
  });

  it('large child excluded NO_RECEIVER is safe', async () => {
    const tabId = 115;
    browser.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 5, documentId: 'doc-115', url: 'https://example.com/frame' },
    ]);
    browser.tabs.sendMessage.mockRejectedValue(new Error('Receiving end does not exist'));
    vi.mocked(checkUrlExclusionAsync).mockResolvedValue(true);
    browser.scripting.executeScript.mockResolvedValue([{ result: { width: 500, height: 500 } }]);

    const result = await handleDeactivateSelectElementMode({ data: { tabId } }, {});

    expect(result).toMatchObject({ success: true, active: false });
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'selectElementStateChanged',
      data: { tabId, active: false },
    });
  });

  it('top excluded NO_RECEIVER is safe', async () => {
    const tabId = 116;
    browser.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 0, documentId: 'doc-116', url: 'https://example.com' },
    ]);
    browser.tabs.sendMessage.mockRejectedValue(new Error('Receiving end does not exist'));
    vi.mocked(checkUrlExclusionAsync).mockResolvedValue(true);

    const result = await handleDeactivateSelectElementMode({ data: { tabId } }, {});

    expect(result).toMatchObject({ success: true, active: false });
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'selectElementStateChanged',
      data: { tabId, active: false },
    });
  });

  it('large non-excluded NO_RECEIVER remains UNKNOWN', async () => {
    const tabId = 117;
    browser.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 5, documentId: 'doc-117', url: 'https://example.com/frame' },
    ]);
    browser.tabs.sendMessage.mockRejectedValue(new Error('Receiving end does not exist'));
    vi.mocked(checkUrlExclusionAsync).mockResolvedValue(false);
    browser.scripting.executeScript.mockResolvedValue([{ result: { width: 500, height: 500 } }]);

    const result = await handleDeactivateSelectElementMode({ data: { tabId } }, {});

    expect(result).toMatchObject({ success: false });
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('exclusion check failure keeps NO_RECEIVER UNKNOWN', async () => {
    const tabId = 118;
    browser.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 5, documentId: 'doc-118', url: 'https://example.com/frame' },
    ]);
    browser.tabs.sendMessage.mockRejectedValue(new Error('Receiving end does not exist'));
    vi.mocked(checkUrlExclusionAsync).mockRejectedValue(new Error('exclusion boom'));
    browser.scripting.executeScript.mockResolvedValue([{ result: { width: 500, height: 500 } }]);

    const result = await handleDeactivateSelectElementMode({ data: { tabId } }, {});

    expect(result).toMatchObject({ success: false });
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
