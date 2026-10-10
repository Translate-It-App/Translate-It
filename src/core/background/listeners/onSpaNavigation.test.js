import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  historyStateAddListener: vi.fn(),
  referenceFragmentAddListener: vi.fn(),
  debug: vi.fn(),
  saved: {},
  set: vi.fn(),
  committedAddListener: vi.fn(),
  removedAddListener: vi.fn(),
}));

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: { session: {
      get: vi.fn(async () => structuredClone(mocks.saved)), set: mocks.set,
    } },
    tabs: { sendMessage: mocks.sendMessage, onRemoved: { addListener: mocks.removedAddListener } },
    webNavigation: {
      onCommitted: { addListener: mocks.committedAddListener },
      onHistoryStateUpdated: { addListener: mocks.historyStateAddListener },
      onReferenceFragmentUpdated: { addListener: mocks.referenceFragmentAddListener },
    },
  },
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({ debug: mocks.debug }),
}));

vi.mock('@/shared/logging/logConstants.js', () => ({
  LOG_COMPONENTS: { BACKGROUND: 'background' },
}));

import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { handleSpaNavigation } from './onSpaNavigation.js';
import { pageNavigationTracker } from '../PageNavigationTracker.js';

describe('SPA navigation listener', () => {
  beforeEach(async () => {
    mocks.saved = {};
    mocks.set.mockReset().mockImplementation(async value => { mocks.saved = structuredClone(value); });
    pageNavigationTracker.state = null;
    pageNavigationTracker.dirty = false;
    pageNavigationTracker.pending = Promise.resolve();
    await pageNavigationTracker.seed(42, [0, 3, 27].map(frameId => ({ frameId, url: 'https://example.com/route-a' })));
    mocks.sendMessage.mockClear();
    mocks.debug.mockClear();
    mocks.sendMessage.mockResolvedValue(undefined);
  });

  it('registers once with webNavigation history updates', () => {
    expect(mocks.historyStateAddListener).toHaveBeenCalledTimes(1);
    expect(mocks.historyStateAddListener).toHaveBeenCalledWith(handleSpaNavigation);
  });

  it('registers the same handler for reference fragment updates', () => {
    expect(mocks.referenceFragmentAddListener).toHaveBeenCalledTimes(1);
    expect(mocks.referenceFragmentAddListener).toHaveBeenCalledWith(handleSpaNavigation);
  });

  it('forwards top-frame browser navigation evidence', async () => {
    await handleSpaNavigation({ tabId: 42, frameId: 0, url: 'https://example.com/route-b', timeStamp: 123.5 });

    expect(mocks.sendMessage).toHaveBeenCalledWith(42, {
      action: MessageActions.SPA_NAVIGATION,
      data: { navigationCursor: { documentEpoch: 1, routeRevision: 1, url: 'https://example.com/route-b' } },
    }, {
      frameId: 0,
    });
  });

  it('forwards child-frame navigation to the exact frame', async () => {
    await handleSpaNavigation({ tabId: 42, frameId: 3, url: 'https://frame.example/child' });

    expect(mocks.sendMessage).toHaveBeenCalledWith(42, {
      action: MessageActions.SPA_NAVIGATION,
      data: { navigationCursor: { documentEpoch: 2, routeRevision: 1, url: 'https://frame.example/child' } },
    }, {
      frameId: 3,
    });
  });

  it('forwards nested-frame navigation without changing frame identity', async () => {
    await handleSpaNavigation({ tabId: 42, frameId: 27, url: 'https://frame.example/nested' });

    expect(mocks.sendMessage).toHaveBeenCalledWith(42, {
      action: MessageActions.SPA_NAVIGATION,
      data: { navigationCursor: { documentEpoch: 3, routeRevision: 1, url: 'https://frame.example/nested' } },
    }, {
      frameId: 27,
    });
  });

  it.each([
    {},
    { tabId: '42', frameId: 0 },
    { tabId: -1, frameId: 0 },
    { tabId: 42, frameId: undefined },
    { tabId: 42, frameId: '3' },
    { tabId: 42, frameId: -1 },
    { tabId: 42, frameId: 1.5 },
  ])('ignores invalid navigation details: %o', async (details) => {
    await handleSpaNavigation(details);

    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('does not forward non-primitive or non-finite navigation evidence', async () => {
    await handleSpaNavigation({ tabId: 42, frameId: 0, url: {}, timeStamp: NaN });
    expect(mocks.sendMessage).toHaveBeenCalledWith(42, {
      action: MessageActions.SPA_NAVIGATION,
      data: { navigationUnavailable: true },
    }, { frameId: 0 });
  });

  it('contains tab message failures', async () => {
    mocks.sendMessage.mockRejectedValue(new Error('tab closed'));

    await expect(handleSpaNavigation({ tabId: 42, frameId: 0 })).resolves.toBeUndefined();
    expect(mocks.debug).toHaveBeenCalled();
  });

  it('captures later transitions without waiting for an earlier receiver acknowledgement', async () => {
    let release;
    mocks.sendMessage.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = handleSpaNavigation({ tabId: 42, frameId: 0, url: 'https://example.com/b', timeStamp: 10 });
    await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledOnce());
    await handleSpaNavigation({ tabId: 42, frameId: 0, url: 'https://example.com/route-a', timeStamp: 10 });
    expect(mocks.sendMessage.mock.calls.map(([, message]) => message.data.navigationCursor.routeRevision)).toEqual([1, 2]);
    release();
    await first;
  });

  it('keeps same-URL state updates at the same captured cursor', async () => {
    await handleSpaNavigation({ tabId: 42, frameId: 0, url: 'https://example.com/b', timeStamp: 10 });
    await handleSpaNavigation({ tabId: 42, frameId: 0, url: 'https://example.com/b', timeStamp: 30 });
    expect(mocks.sendMessage.mock.calls[0][1].data).toEqual(mocks.sendMessage.mock.calls[1][1].data);
  });

  it('reports persistence failure instead of forwarding an undurable cursor', async () => {
    mocks.set.mockRejectedValue(new Error('session unavailable'));
    await handleSpaNavigation({ tabId: 42, frameId: 0, url: 'https://example.com/b' });
    await handleSpaNavigation({ tabId: 42, frameId: 0, url: 'https://example.com/b' });
    expect(mocks.sendMessage.mock.calls.every(([, message]) => message.data.navigationUnavailable === true)).toBe(true);
  });

  it('uses actual URL detection only for unregistered frame notifications', async () => {
    await handleSpaNavigation({ tabId: 42, frameId: 999, url: 'https://frame.example/untracked' });
    expect(mocks.sendMessage.mock.calls[0][1].data).toEqual({});
    expect(await pageNavigationTracker.getCursor(42, 999)).toBeNull();
  });

  it('registers document and tab cleanup on the existing browser lifecycle', async () => {
    expect(mocks.committedAddListener).toHaveBeenCalledOnce();
    expect(mocks.removedAddListener).toHaveBeenCalledOnce();
    mocks.committedAddListener.mock.calls[0][0]({ tabId: 42, frameId: 0, url: 'https://example.com/new-document' });
    await pageNavigationTracker.pending;
    expect((await pageNavigationTracker.getCursor(42, 0)).documentEpoch).toBe(4);
    expect(await pageNavigationTracker.getCursor(42, 3)).toBeNull();
    mocks.removedAddListener.mock.calls[0][0](42);
    await pageNavigationTracker.pending;
    expect(await pageNavigationTracker.getCursor(42, 0)).toBeNull();
  });
});
