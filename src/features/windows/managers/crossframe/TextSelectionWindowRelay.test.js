import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

import { TextSelectionWindowRelay, getTextSelectionWindowRelay, installTextSelectionWindowRelay } from './TextSelectionWindowRelay.js';
import { adjustForDirectChild } from './coordinateUtils.js';
import { WindowsConfig } from '../core/WindowsConfig.js';

const REQUEST = WindowsConfig.CROSS_FRAME.TEXT_SELECTION_WINDOW_REQUEST;

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const requestMessage = (overrides = {}, source = {}) => ({
  data: {
    type: REQUEST,
    selectedText: 'hello',
    position: { x: 100, y: 200 },
    ...overrides
  },
  source
});

const stubIframes = (frames) => {
  const mock = vi.spyOn(document, 'querySelectorAll').mockImplementation((selector) => {
    if (selector === 'iframe') return frames;
    return [];
  });
  return mock;
};

describe('TextSelectionWindowRelay', () => {
  let parentPostMessage;

  beforeEach(() => {
    parentPostMessage = vi.fn();
    vi.stubGlobal('parent', { postMessage: parentPostMessage });
  });

  afterEach(() => {
    getTextSelectionWindowRelay().destroy();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('routing', () => {
    it('delivers the request to the sink in the top frame with the original source', () => {
      const sink = vi.fn();
      const relay = new TextSelectionWindowRelay();
      relay.setSink(sink);

      const data = requestMessage().data;
      const source = { iframe: true };
      relay._handleMessage({ data, source });

      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink).toHaveBeenCalledWith(data, source);
      expect(parentPostMessage).not.toHaveBeenCalled();
      relay.destroy();
    });

    it('buffers a request that arrives before any sink is registered', async () => {
      const relay = new TextSelectionWindowRelay();
      const ensureActive = vi.fn();
      relay.setEnsureActive(ensureActive);

      relay._handleMessage(requestMessage());

      expect(relay._pendingRequest).not.toBeNull();
      expect(parentPostMessage).not.toHaveBeenCalled();

      await flushPromises();
      expect(ensureActive).toHaveBeenCalledTimes(1);
      expect(relay._pendingRequest).toBeNull();
      relay.destroy();
    });

    it('delivers a pre-activation request once the sink is registered (not silently lost)', async () => {
      const sink = vi.fn();
      const relay = new TextSelectionWindowRelay();
      const ensureActive = vi.fn();
      relay.setEnsureActive(ensureActive);

      const data = requestMessage().data;
      const source = { iframe: true };
      relay._handleMessage({ data, source });

      expect(sink).not.toHaveBeenCalled();

      relay.setSink(sink);

      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink).toHaveBeenCalledWith(data, source);
      expect(relay._pendingRequest).toBeNull();

      await flushPromises();
      expect(ensureActive).toHaveBeenCalledTimes(1);
      relay.destroy();
    });

    it('keeps only the latest request while activation is pending', () => {
      const sink = vi.fn();
      const relay = new TextSelectionWindowRelay();
      relay.setEnsureActive(vi.fn());

      relay._handleMessage(requestMessage({ selectedText: 'first' }, { f: 1 }));
      relay._handleMessage(requestMessage({ selectedText: 'second' }, { f: 2 }));

      relay.setSink(sink);

      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink.mock.calls[0][0].selectedText).toBe('second');
      relay.destroy();
    });

    it('forwards a request upward with the child iframe offset added once', () => {
      const relay = new TextSelectionWindowRelay();
      relay._isTopFrame = false;

      const sourceWindow = { iframe: true };
      stubIframes([{
        contentWindow: sourceWindow,
        getBoundingClientRect: () => ({ left: 150, top: 300 })
      }]);

      relay._handleMessage(requestMessage({
        frameId: 'leaf',
        toolbarPosition: { x: 25, y: 35, _isViewportRelative: true }
      }, sourceWindow));

      expect(parentPostMessage).toHaveBeenCalledTimes(1);
      const [forwarded, target] = parentPostMessage.mock.calls[0];
      expect(target).toBe('*');
      expect(forwarded.type).toBe(REQUEST);
      expect(forwarded.selectedText).toBe('hello');
      expect(forwarded.position).toEqual({
        x: 250,
        y: 500,
        _isViewportRelative: true,
        _isAbsolute: false
      });
      expect(forwarded.toolbarPosition).toEqual({
        x: 175,
        y: 335,
        _isViewportRelative: true,
        _isAbsolute: false
      });
      relay.destroy();
    });

    it('drops the request when the sender is not a direct child iframe', () => {
      const relay = new TextSelectionWindowRelay();
      relay._isTopFrame = false;
      stubIframes([{
        contentWindow: { other: true },
        getBoundingClientRect: () => ({ left: 150, top: 300 })
      }]);

      relay._handleMessage(requestMessage());

      expect(parentPostMessage).not.toHaveBeenCalled();
      relay.destroy();
    });

    it('ignores unrelated messages and invalid payloads', () => {
      const relay = new TextSelectionWindowRelay();
      relay._isTopFrame = false;
      stubIframes([]);

      relay._handleMessage({ data: { type: 'OTHER' } });
      relay._handleMessage({ data: { type: REQUEST, selectedText: '', position: { x: 1, y: 1 } } });
      relay._handleMessage({ data: null });

      expect(parentPostMessage).not.toHaveBeenCalled();
      relay.destroy();
    });

    it('accumulates offsets across a two-hop chain into the top frame', () => {
      const intermediate = new TextSelectionWindowRelay();
      intermediate._isTopFrame = false;

      const childB = { iframe: true };
      stubIframes([{
        contentWindow: childB,
        getBoundingClientRect: () => ({ left: 50, top: 80 })
      }]);
      intermediate._handleMessage(requestMessage({
        frameId: 'leaf',
        position: { x: 10, y: 20 },
        toolbarPosition: { x: 15, y: 25, _isViewportRelative: true }
      }, childB));

      const [forwarded] = parentPostMessage.mock.calls[0];

      const top = new TextSelectionWindowRelay();
      const deliveries = [];
      top.setSink((data, source) => {
        deliveries.push({
          data,
          source,
          position: adjustForDirectChild(source, data.position) ?? { ...data.position },
          toolbarPosition: adjustForDirectChild(source, data.toolbarPosition) ?? { ...data.toolbarPosition }
        });
      });

      const childA = { frameA: true };
      document.querySelectorAll.mockImplementation((s) => (
        s === 'iframe' ? [{ contentWindow: childA, getBoundingClientRect: () => ({ left: 200, top: 300 }) }] : []
      ));
      top._handleMessage({ data: forwarded, source: childA });

      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].position).toEqual({
        x: 10 + 50 + 200,
        y: 20 + 80 + 300,
        _isViewportRelative: true,
        _isAbsolute: false
      });
      expect(deliveries[0].toolbarPosition).toEqual({
        x: 15 + 50 + 200,
        y: 25 + 80 + 300,
        _isViewportRelative: true,
        _isAbsolute: false
      });
      intermediate.destroy();
      top.destroy();
    });
  });

  describe('sink ownership', () => {
    it('clears the sink on owner cleanup so no stale delivery reaches the owner', () => {
      const sinkA = vi.fn();
      const relay = new TextSelectionWindowRelay();
      relay.setSink(sinkA);

      relay.clearSink(sinkA);
      expect(relay._sink).toBeNull();

      relay._handleMessage(requestMessage());
      expect(sinkA).not.toHaveBeenCalled();
      relay.destroy();
    });

    it('a replacement sink survives stale previous-owner cleanup', () => {
      const sinkA = vi.fn();
      const sinkB = vi.fn();
      const relay = new TextSelectionWindowRelay();
      relay.setSink(sinkA);
      relay.setSink(sinkB);

      relay.clearSink(sinkA);

      const data = requestMessage().data;
      const source = { iframe: true };
      relay._handleMessage({ data, source });
      expect(sinkB).toHaveBeenCalledTimes(1);
      expect(sinkA).not.toHaveBeenCalled();
      relay.destroy();
    });

    it('clearSink only succeeds for the exact registered sink', () => {
      const sinkA = vi.fn();
      const relay = new TextSelectionWindowRelay();
      relay.setSink(sinkA);

      relay.clearSink();
      relay.clearSink(vi.fn());

      expect(relay._sink).toBe(sinkA);
      relay.destroy();
    });
  });

  describe('single ownership', () => {
    it('installs a single message listener across repeated getInstance calls', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      getTextSelectionWindowRelay();
      getTextSelectionWindowRelay();
      getTextSelectionWindowRelay();

      const messageAdds = addSpy.mock.calls.filter(([type]) => type === 'message');
      expect(messageAdds).toHaveLength(1);
    });

    it('does not add a listener when (re)registering the sink', () => {
      const relay = getTextSelectionWindowRelay();
      const addSpy = vi.spyOn(window, 'addEventListener');

      relay.setSink(vi.fn());
      relay.clearSink();
      relay.setSink(vi.fn());

      const messageAdds = addSpy.mock.calls.filter(([type]) => type === 'message');
      expect(messageAdds).toHaveLength(0);
    });

    it('removes the listener on destroy and re-installs exactly one on re-acquire', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      const removeSpy = vi.spyOn(window, 'removeEventListener');

      getTextSelectionWindowRelay().destroy();
      getTextSelectionWindowRelay();

      const messageAdds = addSpy.mock.calls.filter(([type]) => type === 'message');
      const messageRemoves = removeSpy.mock.calls.filter(([type]) => type === 'message');
      expect(messageAdds.length - messageRemoves.length).toBe(1);
      expect(messageRemoves).toHaveLength(1);
    });
  });

  describe('activation lifecycle', () => {
    it('keeps pending and in-flight state while the activation promise is unresolved', async () => {
      const activation = deferred();
      const relay = new TextSelectionWindowRelay();
      relay.setEnsureActive(() => activation.promise);

      relay._handleMessage(requestMessage({ selectedText: 'deferred' }));

      expect(relay._activationPromise).not.toBeNull();
      expect(relay._pendingRequest).not.toBeNull();
      expect(relay._pendingRequest.data.selectedText).toBe('deferred');

      await flushPromises();
      expect(relay._activationPromise).not.toBeNull();
      expect(relay._pendingRequest).not.toBeNull();

      activation.resolve();
      relay.destroy();
    });

    it('delivers pending exactly once when the sink registers before a deferred activation resolves', async () => {
      const sink = vi.fn();
      const activation = deferred();
      const relay = new TextSelectionWindowRelay();
      relay.setEnsureActive(() => activation.promise);

      relay._handleMessage(requestMessage({ selectedText: 'deferred' }));
      relay.setSink(sink);

      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink.mock.calls[0][0].selectedText).toBe('deferred');

      activation.resolve();
      await flushPromises();

      expect(sink).toHaveBeenCalledTimes(1);
      expect(relay._pendingRequest).toBeNull();
      relay.destroy();
    });

    it('drops pending only after a deferred activation resolves without a sink', async () => {
      const activation = deferred();
      const relay = new TextSelectionWindowRelay();
      relay.setEnsureActive(() => activation.promise);

      relay._handleMessage(requestMessage({ selectedText: 'deferred' }));

      await flushPromises();
      expect(relay._pendingRequest).not.toBeNull();

      activation.resolve();
      await flushPromises();

      expect(relay._pendingRequest).toBeNull();
      expect(relay._activationPromise).toBeNull();
      relay.destroy();
    });

    it('does not drop a request that arrives while an activation is in flight', async () => {
      const sink = vi.fn();
      const relay = new TextSelectionWindowRelay();
      relay.setEnsureActive(() => new Promise(() => {}));
      relay._handleMessage(requestMessage({ selectedText: 'during-activation' }));

      relay.setSink(sink);
      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink.mock.calls[0][0].selectedText).toBe('during-activation');
      relay.destroy();
    });

    it('retries activation after the callback rejects and delivers a later request', async () => {
      const sink = vi.fn();
      const ensureActive = vi.fn()
        .mockRejectedValueOnce(new Error('first attempt failed'))
        .mockResolvedValueOnce();
      const relay = new TextSelectionWindowRelay();
      relay.setEnsureActive(ensureActive);

      relay._handleMessage(requestMessage({ selectedText: 'first' }));
      await flushPromises();

      relay._handleMessage(requestMessage({ selectedText: 'second' }));
      relay.setSink(sink);
      await flushPromises();

      expect(ensureActive).toHaveBeenCalledTimes(2);
      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink.mock.calls[0][0].selectedText).toBe('second');
      relay.destroy();
    });

    it('starts fresh activation on the next request after a failed attempt', async () => {
      const ensureActive = vi.fn().mockRejectedValue(new Error('boom'));
      const relay = new TextSelectionWindowRelay();
      relay.setEnsureActive(ensureActive);

      relay._handleMessage(requestMessage({ selectedText: 'A' }));
      await flushPromises();
      relay._handleMessage(requestMessage({ selectedText: 'B' }));
      await flushPromises();

      expect(ensureActive).toHaveBeenCalledTimes(2);
      expect(relay._pendingRequest).toBeNull();
      relay.destroy();
    });
  });

  describe('installTextSelectionWindowRelay', () => {
    it('activates the windows feature on the content core, not via loadFeatureFromMain', async () => {
      const loadFeature = vi.fn().mockReturnValue(Promise.resolve());
      const loadFeatureFromMain = vi.fn();
      const relay = installTextSelectionWindowRelay({ loadFeature, loadFeatureFromMain });

      relay._handleMessage(requestMessage());
      await flushPromises();

      expect(loadFeature).toHaveBeenCalledWith('windowsManager');
      expect(loadFeatureFromMain).not.toHaveBeenCalled();
      relay.destroy();
    });

    it('governs the relay lifecycle by the returned loadFeature promise', async () => {
      const activation = deferred();
      const loadFeature = vi.fn().mockReturnValue(activation.promise);
      const relay = installTextSelectionWindowRelay({ loadFeature });

      relay._handleMessage(requestMessage({ selectedText: 'deferred' }));
      await flushPromises();

      // Feature still loading: activation stays in-flight, pending retained.
      expect(relay._activationPromise).not.toBeNull();
      expect(relay._pendingRequest).not.toBeNull();

      activation.resolve();
      await flushPromises();

      // Only after the returned promise resolves does the settle-drop run.
      expect(relay._activationPromise).toBeNull();
      expect(relay._pendingRequest).toBeNull();
      relay.destroy();
    });

    it('tolerates a core without loadFeature support', async () => {
      const relay = installTextSelectionWindowRelay({});
      relay._handleMessage(requestMessage());
      await flushPromises();
      expect(relay._pendingRequest).toBeNull();
      relay.destroy();
    });
  });
});
