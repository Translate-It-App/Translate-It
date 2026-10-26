import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { handlePendingDisplayInvalidation } from './handlePendingDisplayInvalidation.js';

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: { id: 'extension-id', getURL: vi.fn(() => 'moz-extension://extension-id/') },
    webNavigation: { getFrame: vi.fn() },
    tabs: { sendMessage: vi.fn() },
  },
}));

describe('trusted pending-display invalidation relay', () => {
  const timestamp = 1_700_000_000_000;
  const message = { action: MessageActions.INVALIDATE_PENDING_DISPLAY, data: { timestamp } };
  const sender = (overrides = {}) => ({
    id: 'extension-id',
    tab: { id: 8 },
    frameId: 3,
    url: 'https://example.test/',
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(timestamp + 10);
    browser.webNavigation.getFrame.mockResolvedValue({ frameId: 3, parentFrameId: 2, url: 'https://example.test/' });
    browser.tabs.sendMessage.mockResolvedValue({ success: true });
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['wrong extension id', { id: 'page-id' }],
    ['missing tab id', { tab: {} }],
    ['negative tab id', { tab: { id: -1 } }],
    ['missing frame id', { frameId: undefined }],
    ['negative frame id', { frameId: -1 }],
    ['top frame sender', { frameId: 0 }],
    ['extension page sender', { url: 'moz-extension://extension-id/page.html' }],
  ])('rejects %s', async (_label, overrides) => {
    expect(await handlePendingDisplayInvalidation(message, sender(overrides))).toMatchObject({ success: false });
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['NaN', NaN],
    ['future timestamp', timestamp + 11],
    ['negative timestamp', -1],
  ])('rejects %s', async (_label, value) => {
    expect(await handlePendingDisplayInvalidation({ data: { timestamp: value } }, sender())).toMatchObject({ success: false });
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects missing frame APIs and non-existing frames', async () => {
    browser.webNavigation.getFrame.mockResolvedValueOnce(null);
    expect(await handlePendingDisplayInvalidation(message, sender())).toMatchObject({ success: false });
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();

    const getFrame = browser.webNavigation.getFrame;
    delete browser.webNavigation.getFrame;
    expect(await handlePendingDisplayInvalidation(message, sender())).toMatchObject({ success: false });
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
    browser.webNavigation.getFrame = getFrame;
  });

  it.each([3, 9])('routes verified frame %s (including nested frames) only to the tab top frame', async (frameId) => {
    const source = sender({ frameId });
    browser.webNavigation.getFrame.mockResolvedValue({ frameId, parentFrameId: frameId === 3 ? 0 : 3 });

    expect(await handlePendingDisplayInvalidation(message, source)).toEqual({ success: true });
    expect(browser.webNavigation.getFrame).toHaveBeenCalledWith({ tabId: 8, frameId });
    expect(browser.tabs.sendMessage).toHaveBeenCalledOnce();
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(8, {
      action: MessageActions.INVALIDATE_PENDING_DISPLAY,
      data: { timestamp },
    }, { frameId: 0 });
  });

  it('ignores message-claimed frame and tab identities', async () => {
    await handlePendingDisplayInvalidation({
      ...message,
      data: { timestamp, tabId: 999, frameId: 0 },
    }, sender({ frameId: 6 }));

    expect(browser.webNavigation.getFrame).toHaveBeenCalledWith({ tabId: 8, frameId: 6 });
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(8, expect.any(Object), { frameId: 0 });
  });
});
