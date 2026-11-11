import { beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';
import { createSelectElementFallbackResponders } from '@/core/content-scripts/IFrameContentScriptCore.js';

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
    checkTabAccess: vi.fn(() => Promise.resolve({ isAccessible: true, fullUrl: 'https://example.com', isRestricted: false })),
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

import {
  clearDeactivationPending,
  clearStateForTab,
  clearTabParticipants,
  getProvisionalCleanupFrames,
  isDeactivationPending,
} from './selectElementStateManager.js';
import { handleActivateSelectElementMode } from './handleActivateSelectElementMode.js';
import { handleDeactivateSelectElementMode } from './handleDeactivateSelectElementMode.js';

// The excluded iframe answers through the PRODUCTION fallback responder from
// IFrameContentScriptCore.js (exactly what installSelectElementFallbackHandlers
// registers on the frame's existing message handler).
const iframeResponders = createSelectElementFallbackResponders();

const TAB_ID = 4201;

const FRAMES = [
  { frameId: 0, documentId: 'doc-top' },
  { frameId: 7, documentId: 'doc-iframe' },
];

const respondForFrame = (msg, target) => {
  if (target.frameId === 0) {
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
  }
  if (msg.action === 'activateSelectElementMode') {
    return iframeResponders.handleActivateSelectElementMode(msg);
  }
  if (msg.action === 'deactivateSelectElementMode') {
    return iframeResponders.handleDeactivateSelectElementMode(msg);
  }
  if (msg.action === 'getSelectElementFrameState') {
    return iframeResponders.handleGetSelectElementFrameState(msg);
  }
  return undefined;
};

describe('background activation across an excluded iframe with the production fallback responder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearStateForTab(TAB_ID);
    clearTabParticipants(TAB_ID);
    clearDeactivationPending(TAB_ID);
    delete window.selectElementManagerInstance;
    browser.webNavigation.getAllFrames.mockResolvedValue(FRAMES);
    browser.runtime.sendMessage.mockResolvedValue(undefined);
    browser.tabs.sendMessage.mockImplementation(async (_tabId, msg, target) => respondForFrame(msg, target));
  });

  it('activates, leaves no iframe cleanup debt, deactivates and re-activates immediately', async () => {
    const activation = await handleActivateSelectElementMode({ data: { tabId: TAB_ID, active: true } }, { tab: { id: TAB_ID } });
    expect(activation.success).toBe(true);
    expect(getProvisionalCleanupFrames(TAB_ID)).toEqual([]);

    const deactivation = await handleDeactivateSelectElementMode({ data: { tabId: TAB_ID } }, { tab: { id: TAB_ID } });
    expect(deactivation.success).toBe(true);
    expect(isDeactivationPending(TAB_ID)).toBe(false);

    const reactivation = await handleActivateSelectElementMode({ data: { tabId: TAB_ID, active: true } }, { tab: { id: TAB_ID } });
    expect(reactivation.success).toBe(true);
    expect(getProvisionalCleanupFrames(TAB_ID)).toEqual([]);
    expect(isDeactivationPending(TAB_ID)).toBe(false);
  });

  it('keeps the barrier when the excluded iframe reports an active session (fail-closed)', async () => {
    window.selectElementManagerInstance = { isSelectElementActive: () => true };

    const activation = await handleActivateSelectElementMode({ data: { tabId: TAB_ID, active: true } }, { tab: { id: TAB_ID } });
    expect(activation.success).toBe(true);

    expect(getProvisionalCleanupFrames(TAB_ID).map(frame => frame.frameId)).toEqual([7]);

    const deactivation = await handleDeactivateSelectElementMode({ data: { tabId: TAB_ID } }, { tab: { id: TAB_ID } });
    expect(deactivation.success).toBe(false);
    expect(isDeactivationPending(TAB_ID)).toBe(true);
  });

  it('keeps the barrier when the iframe has a manager whose active flag is already cleared (cleanup pending)', async () => {
    // The manager clears isActive BEFORE cleanup completes, so the frame must
    // not be released from provisional cleanup ownership on this report.
    window.selectElementManagerInstance = { isSelectElementActive: () => false };

    const activation = await handleActivateSelectElementMode({ data: { tabId: TAB_ID, active: true } }, { tab: { id: TAB_ID } });
    expect(activation.success).toBe(true);

    // The fallback refuses activated:false and refuses cleanupCompleted:true.
    const frameActivate = browser.tabs.sendMessage.mock.calls.find(
      ([, msg, target]) => msg.action === 'activateSelectElementMode' && target.frameId === 7,
    );
    expect(frameActivate).toBeTruthy();

    expect(getProvisionalCleanupFrames(TAB_ID).map(frame => frame.frameId)).toEqual([7]);

    const deactivation = await handleDeactivateSelectElementMode({ data: { tabId: TAB_ID } }, { tab: { id: TAB_ID } });
    expect(deactivation.success).toBe(false);
    expect(isDeactivationPending(TAB_ID)).toBe(true);
  });
});
