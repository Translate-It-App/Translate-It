import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  getStateForTab,
  isDeactivationPending,
} from './selectElementStateManager.js';
import { handleActivateSelectElementMode } from './handleActivateSelectElementMode.js';
import { handleDeactivateSelectElementMode } from './handleDeactivateSelectElementMode.js';

const DEF_REFUSAL = { success: false, activated: false, error: 'Feature blocked on this page' };

const tabIds = [4101, 4102, 4103, 4104, 4105];

const twoFrames = [
  { frameId: 0, documentId: 'doc-top' },
  { frameId: 7, documentId: 'doc-iframe' },
];

const strictTopActivate = msg => ({
  success: true,
  activated: true,
  activationGeneration: msg.data.activationGeneration,
  activationEpoch: msg.data.activationEpoch,
});

const topDeactivateAck = () => ({ success: true, cleanupCompleted: true, activated: false });
const unavailableFrameDeactivateAck = () => ({
  success: false,
  cleanupCompleted: false,
  activated: false,
  error: 'Select Element manager unavailable',
});

describe('definitive activation refusal discharges provisional cleanup debt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const tabId of tabIds) {
      clearStateForTab(tabId);
      clearTabParticipants(tabId);
      clearDeactivationPending(tabId);
    }
    browser.webNavigation.getAllFrames.mockResolvedValue(twoFrames);
    browser.runtime.sendMessage.mockResolvedValue(undefined);
  });

  it('does not create provisional cleanup debt for an explicit refusal from a non-top frame', async () => {
    const tabId = 4101;
    browser.tabs.sendMessage.mockImplementation(async (_tabId, msg, target) => {
      if (msg.action === 'activateSelectElementMode') {
        if (target.frameId === 0) return strictTopActivate(msg);
        return { ...DEF_REFUSAL };
      }
      return undefined;
    });

    const activation = await handleActivateSelectElementMode({ data: { tabId, active: true } }, { tab: { id: tabId } });

    expect(activation.success).toBe(true);
    expect(getProvisionalCleanupFrames(tabId)).toEqual([]);
  });

  it('deactivates and re-activates cleanly when only the top frame activates and others refuse', async () => {
    const tabId = 4102;
    browser.tabs.sendMessage.mockImplementation(async (_tabId, msg, target) => {
      if (msg.action === 'activateSelectElementMode') {
        if (target.frameId === 0) return strictTopActivate(msg);
        return { ...DEF_REFUSAL };
      }
      if (msg.action === 'deactivateSelectElementMode') {
        if (target.frameId === 0) return topDeactivateAck();
        return { ...DEF_REFUSAL };
      }
      return undefined;
    });

    const activation = await handleActivateSelectElementMode({ data: { tabId, active: true } }, { tab: { id: tabId } });
    expect(activation.success).toBe(true);
    expect(getStateForTab(tabId).active).toBe(true);

    const deactivation = await handleDeactivateSelectElementMode({ data: { tabId } }, { tab: { id: tabId } });
    expect(deactivation.success).toBe(true);
    expect(isDeactivationPending(tabId)).toBe(false);

    const reactivation = await handleActivateSelectElementMode({ data: { tabId, active: true } }, { tab: { id: tabId } });
    expect(reactivation.success).toBe(true);
    expect(isDeactivationPending(tabId)).toBe(false);
  });

  it('keeps provisional cleanup debt for a refusal that reports a still-active manager', async () => {
    const tabId = 4105;
    browser.tabs.sendMessage.mockImplementation(async (_tabId, msg, target) => {
      if (msg.action === 'activateSelectElementMode') {
        if (target.frameId === 0) return strictTopActivate(msg);
        // Exclusion changed mid-session: the frame still holds an active manager
        // (ContentMessageHandler reports getSelectElementActiveState(manager)).
        return { success: false, activated: true, error: 'Feature blocked on this page' };
      }
      return undefined;
    });

    await handleActivateSelectElementMode({ data: { tabId, active: true } }, { tab: { id: tabId } });

    expect(getProvisionalCleanupFrames(tabId).map(frame => frame.frameId)).toEqual([7]);
  });

  it('keeps provisional cleanup debt for a frame that never answers', async () => {
    const tabId = 4103;
    browser.tabs.sendMessage.mockImplementation(async (_tabId, msg, target) => {
      if (msg.action === 'activateSelectElementMode') {
        if (target.frameId === 0) return strictTopActivate(msg);
        return undefined;
      }
      return undefined;
    });

    await handleActivateSelectElementMode({ data: { tabId, active: true } }, { tab: { id: tabId } });

    expect(getProvisionalCleanupFrames(tabId).map(frame => frame.frameId)).toEqual([7]);
  });

  it('keeps provisional cleanup debt for a frame sent to a non-no-receiver transport failure', async () => {
    const tabId = 4104;
    browser.tabs.sendMessage.mockImplementation(async (_tabId, msg, target) => {
      if (msg.action === 'activateSelectElementMode') {
        if (target.frameId === 0) return strictTopActivate(msg);
        throw new Error('Connection closed');
      }
      return undefined;
    });

    await handleActivateSelectElementMode({ data: { tabId, active: true } }, { tab: { id: tabId } });

    expect(getProvisionalCleanupFrames(tabId).map(frame => frame.frameId)).toEqual([7]);
  });

  it('keeps the deactivation barrier while a live debt frame cannot be cleaned up', async () => {
    const tabId = 4103;
    browser.tabs.sendMessage.mockImplementation(async (_tabId, msg, target) => {
      if (msg.action === 'activateSelectElementMode') {
        if (target.frameId === 0) return strictTopActivate(msg);
        return undefined; // ambiguous: frame owns provisional cleanup debt
      }
      if (msg.action === 'deactivateSelectElementMode') {
        if (target.frameId === 0) return topDeactivateAck();
        return unavailableFrameDeactivateAck(); // live frame, cleanup impossible
      }
      return undefined;
    });

    const activation = await handleActivateSelectElementMode({ data: { tabId, active: true } }, { tab: { id: tabId } });
    expect(activation.success).toBe(true);
    expect(getProvisionalCleanupFrames(tabId).map(frame => frame.frameId)).toEqual([7]);

    const deactivation = await handleDeactivateSelectElementMode({ data: { tabId } }, { tab: { id: tabId } });
    expect(deactivation.success).toBe(false);
    expect(isDeactivationPending(tabId)).toBe(true);

    const reactivation = await handleActivateSelectElementMode({ data: { tabId, active: true } }, { tab: { id: tabId } });
    expect(reactivation.success).toBe(false);
    expect(reactivation.message).toBe('Select Element previous session cleanup pending');
  });
});
