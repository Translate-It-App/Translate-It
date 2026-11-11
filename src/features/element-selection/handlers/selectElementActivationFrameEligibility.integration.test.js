import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    runtime: {
      sendMessage: vi.fn(() => Promise.resolve()),
      getURL: vi.fn(() => 'chrome-extension://test/'),
      id: 'test',
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
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
  tabPermissionChecker: {
    checkTabAccess: vi.fn(() => Promise.resolve({ isAccessible: true, fullUrl: 'https://www.youtube.com/watch', isRestricted: false })),
  },
}));

vi.mock('@/core/extensionContext.js', () => ({
  default: { isContextError: vi.fn(() => false), handleContextError: vi.fn(), isValidSync: vi.fn(() => true) },
}));

vi.mock('@/shared/error-management/ErrorHandler.js', () => ({ ErrorHandler: class { handle() {} } }));

vi.mock('@/features/element-selection/utils/activationError.js', () => ({
  getSelectElementActivationErrorMessage: vi.fn(() => Promise.resolve('Could not activate')),
}));

vi.mock('@/features/exclusion/utils/exclusion-utils.js', () => ({
  checkUrlExclusionAsync: vi.fn(() => Promise.resolve(false)),
}));

import browser from 'webextension-polyfill';
import {
  clearDeactivationPending,
  clearStateForTab,
  clearTabParticipants,
  getParticipants,
  getProvisionalCleanupFrames,
  isDeactivationPending,
} from './selectElementStateManager.js';
import { handleActivateSelectElementMode } from './handleActivateSelectElementMode.js';
import { handleDeactivateSelectElementMode } from './handleDeactivateSelectElementMode.js';

const TAB_ID = 7701;

const TOP_FRAME = { frameId: 0, url: 'https://www.youtube.com/watch?v=abc', documentId: 'doc-top' };
const IFRAME_FRAME = { frameId: 7, url: 'https://www.youtube.com/embed/xyz', documentId: 'doc-iframe' };
// Structurally non-injectable frames: they can never host the Select Element
// content script, so they can never hold Select Element state.
const BLANK_FRAME = { frameId: 138, url: 'about:blank', documentId: 'doc-blank' };
const SRCDOC_FRAME = { frameId: 139, url: 'about:srcdoc', documentId: 'doc-srcdoc' };
const CHROME_FRAME = { frameId: 200, url: 'chrome://extensions', documentId: 'doc-chrome' };

/** A frame that hosts the Select Element content script. */
const eligibleResponder = (msg) => {
  if (msg.action === 'activateSelectElementMode') {
    return {
      success: true,
      activated: true,
      activationGeneration: msg.data.activationGeneration,
      activationEpoch: msg.data.activationEpoch,
    };
  }
  if (msg.action === 'deactivateSelectElementMode') {
    return { success: true, cleanupCompleted: true, activated: false };
  }
  return undefined;
};

/**
 * A frame that has a listener which never answers Select Element actions
 * (for example a content script that only registers runtime.onMessage).
 */
const silentResponder = () => undefined;

function installFrames(frames, respondersByFrameId) {
  browser.webNavigation.getAllFrames.mockImplementation(async () => frames);
  browser.tabs.sendMessage.mockImplementation(async (_tabId, msg, target) => {
    const frameId = target?.frameId ?? 0;
    const responder = respondersByFrameId[frameId];
    return responder ? responder(msg) : undefined;
  });
}

const dispatchedFrameIds = () => browser.tabs.sendMessage.mock.calls.map(([, , target]) => target?.frameId);
const dispatchedTargets = () => browser.tabs.sendMessage.mock.calls.map(([, , target]) => target);

describe('activation dispatch only targets structurally eligible frames', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearStateForTab(TAB_ID);
    clearTabParticipants(TAB_ID);
    clearDeactivationPending(TAB_ID);
  });

  it('excludes structurally non-injectable frames from dispatch and creates no provisional debt', async () => {
    installFrames(
      [TOP_FRAME, IFRAME_FRAME, BLANK_FRAME, SRCDOC_FRAME, CHROME_FRAME],
      { 0: eligibleResponder, 7: eligibleResponder, 138: silentResponder, 139: silentResponder, 200: silentResponder },
    );

    const activation = await handleActivateSelectElementMode({ data: { tabId: TAB_ID, active: true } }, { tab: { id: TAB_ID } });
    expect(activation.success).toBe(true);

    expect(dispatchedFrameIds()).toEqual([0, 7]);
    expect(dispatchedFrameIds()).not.toContain(138);
    expect(dispatchedFrameIds()).not.toContain(139);
    expect(dispatchedFrameIds()).not.toContain(200);

    expect(getProvisionalCleanupFrames(TAB_ID)).toEqual([]);

    const deactivation = await handleDeactivateSelectElementMode({ data: { tabId: TAB_ID } }, { tab: { id: TAB_ID } });
    expect(deactivation.success).toBe(true);

    const reactivation = await handleActivateSelectElementMode({ data: { tabId: TAB_ID, active: true } }, { tab: { id: TAB_ID } });
    expect(reactivation.success).toBe(true);
  });

  it('keeps provisional cleanup ownership for an eligible frame that answers undefined', async () => {
    installFrames(
      [TOP_FRAME, IFRAME_FRAME],
      { 0: eligibleResponder, 7: silentResponder },
    );

    const activation = await handleActivateSelectElementMode({ data: { tabId: TAB_ID, active: true } }, { tab: { id: TAB_ID } });
    expect(activation.success).toBe(true);

    // The eligible frame was dispatched to and stayed silent: ownership is retained.
    expect(dispatchedFrameIds()).toContain(7);
    expect(getProvisionalCleanupFrames(TAB_ID).map(debt => debt.frameId)).toEqual([7]);

    const deactivation = await handleDeactivateSelectElementMode({ data: { tabId: TAB_ID } }, { tab: { id: TAB_ID } });
    expect(deactivation.success).toBe(false);
    expect(isDeactivationPending(TAB_ID)).toBe(true);
  });

  it('activates eligible frames normally alongside filtered frames', async () => {
    installFrames(
      [TOP_FRAME, IFRAME_FRAME, BLANK_FRAME],
      { 0: eligibleResponder, 7: eligibleResponder, 138: silentResponder },
    );

    const activation = await handleActivateSelectElementMode({ data: { tabId: TAB_ID, active: true } }, { tab: { id: TAB_ID } });
    expect(activation.success).toBe(true);
    expect(activation.activated).toBe(true);

    expect([...getParticipants(TAB_ID).keys()].sort()).toEqual([0, 7]);
    expect(getProvisionalCleanupFrames(TAB_ID)).toEqual([]);
  });

  it('preserves document identity for dispatched frames', async () => {
    installFrames(
      [TOP_FRAME, IFRAME_FRAME, BLANK_FRAME],
      { 0: eligibleResponder, 7: eligibleResponder, 138: silentResponder },
    );

    await handleActivateSelectElementMode({ data: { tabId: TAB_ID, active: true } }, { tab: { id: TAB_ID } });

    expect(dispatchedTargets()).toEqual([
      { frameId: 0, documentId: 'doc-top' },
      { frameId: 7, documentId: 'doc-iframe' },
    ]);
  });

  it('releases ownership of an eligible frame that navigated after activation', async () => {
    installFrames(
      [TOP_FRAME, IFRAME_FRAME],
      { 0: eligibleResponder, 7: silentResponder },
    );

    await handleActivateSelectElementMode({ data: { tabId: TAB_ID, active: true } }, { tab: { id: TAB_ID } });
    expect(getProvisionalCleanupFrames(TAB_ID).map(debt => debt.frameId)).toEqual([7]);

    // The frame navigated: same frameId, new document identity.
    browser.webNavigation.getAllFrames.mockImplementation(async () => [
      TOP_FRAME,
      { frameId: 7, url: 'https://www.youtube.com/embed/xyz', documentId: 'doc-iframe-2' },
    ]);

    const deactivation = await handleDeactivateSelectElementMode({ data: { tabId: TAB_ID } }, { tab: { id: TAB_ID } });
    expect(deactivation.success).toBe(true);
    expect(getProvisionalCleanupFrames(TAB_ID)).toEqual([]);
  });

  it('does not leave stale ownership after concurrent activations', async () => {
    installFrames(
      [TOP_FRAME, IFRAME_FRAME, BLANK_FRAME],
      { 0: eligibleResponder, 7: eligibleResponder, 138: silentResponder },
    );

    const [first, second] = await Promise.all([
      handleActivateSelectElementMode({ data: { tabId: TAB_ID, active: true } }, { tab: { id: TAB_ID } }),
      handleActivateSelectElementMode({ data: { tabId: TAB_ID, active: true } }, { tab: { id: TAB_ID } }),
    ]);

    // The superseded attempt reports as superseded; the current one succeeds.
    expect([first.success, second.success].filter(Boolean).length).toBe(1);

    const generations = new Set([...getParticipants(TAB_ID).values()]);
    expect(generations.size).toBe(1);
    expect(getProvisionalCleanupFrames(TAB_ID)).toEqual([]);

    const deactivation = await handleDeactivateSelectElementMode({ data: { tabId: TAB_ID } }, { tab: { id: TAB_ID } });
    expect(deactivation.success).toBe(true);
  });
});
