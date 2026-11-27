import { describe, it, expect, vi, beforeEach } from 'vitest';
import browser from 'webextension-polyfill';

vi.mock('webextension-polyfill', () => ({
  default: {
    tabs: {
      query: vi.fn(),
      sendMessage: vi.fn(),
      onRemoved: { addListener: vi.fn() },
      onActivated: { addListener: vi.fn() },
    },
    webNavigation: {
      getAllFrames: vi.fn(),
      onCommitted: { addListener: vi.fn() },
    },
    runtime: {
      sendMessage: vi.fn(() => Promise.resolve()),
    },
  },
}));

vi.mock('@/core/tabPermissions.js', () => ({
  tabPermissionChecker: {
    checkTabAccess: vi.fn(),
  },
}));

vi.mock('@/core/extensionContext.js', () => ({
  default: {
    isContextError: vi.fn(() => false),
    handleContextError: vi.fn(),
  },
}));

vi.mock('@/shared/error-management/ErrorHandler.js');

vi.mock('../utils/activationError.js', () => ({
  getSelectElementActivationErrorMessage: vi.fn(() => Promise.resolve('Could not activate Select Element mode.')),
}));

vi.mock('@/core/background/handlers/page-translation/handlePageTranslation.js', () => ({
  revokeManualPageAuthority: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('@/shared/messaging/core/MessageActions.js', () => ({
  MessageActions: {
    ACTIVATE_SELECT_ELEMENT_MODE: 'activateSelectElementMode',
    DEACTIVATE_SELECT_ELEMENT_MODE: 'deactivateSelectElementMode',
    SELECT_ELEMENT_STATE_CHANGED: 'selectElementStateChanged',
  },
}));

vi.mock('@/shared/messaging/core/MessagingCore.js', () => ({
  MessagingContexts: {
    CONTENT: 'CONTENT',
    BACKGROUND: 'BACKGROUND',
  },
  MessageFormat: {
    create: vi.fn((action, data, context) => ({ action, data, context })),
  },
}));

import { handleActivateSelectElementMode } from './handleActivateSelectElementMode.js';
import { setStateForTab, getStateForTab, clearStateForTab } from './selectElementStateManager.js';
import { tabPermissionChecker } from '@/core/tabPermissions.js';

describe('handleActivateSelectElementMode state publication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearStateForTab(701);
    tabPermissionChecker.checkTabAccess.mockResolvedValue({
      isAccessible: true,
      isRestricted: false,
      fullUrl: 'https://example.com',
    });
    browser.webNavigation.getAllFrames.mockResolvedValue([{ frameId: 0 }]);
  });

  it('publishes current-version activation once after response confirmation', async () => {
    browser.tabs.sendMessage.mockImplementationOnce(async () => {
      setStateForTab(701, true);
      return { success: true, activated: true, activationGeneration: 1 };
    });

    const response = await handleActivateSelectElementMode(
      { data: { tabId: 701, active: true } },
      {},
    );

    expect(response.success).toBe(true);
    expect(getStateForTab(701).active).toBe(true);
    expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'selectElementStateChanged',
      data: { tabId: 701, active: true },
    }));
  });

  it('does not publish authoritative state for legacy response fallback', async () => {
    browser.tabs.sendMessage.mockResolvedValueOnce(true);

    const response = await handleActivateSelectElementMode(
      { data: { tabId: 701, active: true } },
      {},
    );

    expect(response.success).toBe(true);
    expect(getStateForTab(701).active).toBe(false);
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
