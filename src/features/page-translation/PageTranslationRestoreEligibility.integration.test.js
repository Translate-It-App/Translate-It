import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  })),
}));

vi.mock('@/utils/dom/DomDirectionManager.js', () => ({
  applyNodeDirection: vi.fn(),
  isRTL: vi.fn(() => false),
  restoreElementDirection: vi.fn(),
  BIDI_MARKS: { RLM: '\u200f', LRM: '\u200e' },
}));

vi.mock('@/features/shared/hover-preview/HoverPreviewLookup.js', () => ({
  hoverPreviewLookup: { add: vi.fn(), clear: vi.fn() },
}));

import { PageTranslationBridge } from './PageTranslationBridge.js';

const settings = {
  targetLanguage: 'en',
  lazyLoading: false,
  showOriginalOnHover: false,
  autoTranslateOnDOMChanges: false,
  attributesToTranslate: ['title'],
};

const settlement = (text, state = 'pending') => ({
  __pageTranslationSettlement: true,
  text,
  state,
  settle: vi.fn(),
});

describe('Page Translation restore eligibility integration', () => {
  let bridge;
  let originalUrl;
  let provider;
  let requests;

  beforeEach(() => {
    originalUrl = window.location.href;
    document.body.replaceChildren();
    document.body.removeAttribute('data-page-translated');
    document.body.removeAttribute('data-has-original');
    requests = [];
    // The Bridge hands the provider the node it is translating, so a request
    // can be matched to a specific node instead of to arrival order.
    provider = vi.fn((text, context, score, node) => new Promise((resolve) => {
      requests.push({ text, node, resolve });
    }));
    bridge = new PageTranslationBridge();
  });

  afterEach(() => {
    bridge.cleanup();
    window.history.replaceState(null, '', originalUrl);
    document.body.replaceChildren();
  });

  const start = async (options = {}) => {
    await bridge.initialize({ ...settings, ...options }, provider);
    bridge.translate(document.body);
  };

  const requestFor = (node) => requests.find((request) => request.node === node);

  // Discovery is sliced, so a node's request can arrive several ticks after
  // the first one. Wait for every request the test depends on.
  const waitForRequests = async (nodes) => {
    await vi.waitFor(() => {
      nodes.forEach((node) => expect(requestFor(node)).toBeDefined());
    });
  };

  // Resolve the requests for the given nodes and wait until the translated
  // values are actually applied, so Restore always runs against a fully
  // translated node.
  const settleRequests = async (nodes) => {
    await waitForRequests(nodes);
    nodes.forEach((node) => {
      const request = requestFor(node);
      request.resolve(settlement(`Translated ${request.text}`));
    });
    await vi.waitFor(() => {
      nodes.forEach((node) => expect(node.nodeValue).toContain('Translated'));
    });
  };

  // Counts DOM connectivity reads, which is what the ownership check performs.
  const countConnectivityReads = (run) => {
    const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, 'isConnected');
    let reads = 0;
    Object.defineProperty(Node.prototype, 'isConnected', {
      configurable: true,
      get() {
        reads++;
        return descriptor.get.call(this);
      },
    });
    try {
      run();
    } finally {
      Object.defineProperty(Node.prototype, 'isConnected', descriptor);
    }
    return reads;
  };

  it('checks DOM ownership only for nodes that hold an accepted translation', async () => {
    // Many nodes are visited by the restore traversal but never translated.
    for (let index = 0; index < 60; index++) {
      const filler = document.createElement('p');
      filler.textContent = ' ';
      document.body.appendChild(filler);
    }
    const translated = document.createElement('p');
    translated.textContent = 'Original source';
    document.body.appendChild(translated);
    await start();
    await settleRequests([translated.firstChild]);

    bridge.stopPersistence();
    const storage = bridge.session.nodesTranslator.nodeStorage;
    const reads = countConnectivityReads(() => bridge.restore(document.body));

    expect(translated.textContent).toBe('Original source');
    // The 60 untranslated filler nodes must not pay for a connectivity walk.
    expect(reads).toBeLessThanOrEqual(4);
    expect(storage.has(translated.firstChild)).toBe(false);
  });

  it('restores accepted text and attribute values', async () => {
    const owner = document.createElement('div');
    owner.setAttribute('title', 'Original title');
    owner.textContent = 'Original source';
    document.body.appendChild(owner);
    await start();
    const titleAttribute = owner.getAttributeNode('title');
    await settleRequests([owner.firstChild, titleAttribute]);

    const storage = bridge.session.nodesTranslator.nodeStorage;
    bridge.restore(document.body);

    expect(owner.textContent).toBe('Original source');
    expect(owner.getAttribute('title')).toBe('Original title');
    expect(storage.has(owner.firstChild)).toBe(false);
    expect(storage.has(titleAttribute)).toBe(false);
  });

  it('drops storage for nodes without an accepted translation and leaves them untouched', async () => {
    const failed = document.createElement('p');
    failed.textContent = 'Failed source';
    document.body.appendChild(failed);
    await start();
    const textNode = failed.firstChild;
    await waitForRequests([textNode]);
    requestFor(textNode).resolve(settlement('Failed source', 'failed'));
    // The failed outcome is recorded once the node's restore baseline is set.
    await vi.waitFor(() => {
      const stored = bridge.session.nodesTranslator.nodeStorage.get(textNode);
      expect(stored?.originalText ?? null).not.toBeNull();
    });

    const storage = bridge.session.nodesTranslator.nodeStorage;
    bridge.restore(document.body);

    expect(failed.textContent).toBe('Failed source');
    expect(storage.has(textNode)).toBe(false);
  });

  it('preserves an external edit instead of restoring over it', async () => {
    const owner = document.createElement('div');
    owner.textContent = 'Original source';
    document.body.appendChild(owner);
    await start();
    await settleRequests([owner.firstChild]);
    owner.firstChild.nodeValue = 'Host edit';

    bridge.restore(document.body);

    expect(owner.textContent).toBe('Host edit');
  });

  it('does not restore a detached node after the session was stopped', async () => {
    const owner = document.createElement('div');
    owner.textContent = 'Original source';
    document.body.appendChild(owner);
    await start();
    await settleRequests([owner.firstChild]);
    bridge.stopPersistence();
    owner.remove();

    bridge.restore(document.body);

    // The detached node is no longer owned, so its translated text is kept.
    expect(owner.textContent).toContain('Translated Original source');
  });

  it('restores nested shadow DOM text and attributes', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const nestedHost = document.createElement('div');
    shadow.appendChild(nestedHost);
    const nestedShadow = nestedHost.attachShadow({ mode: 'open' });
    const span = document.createElement('span');
    span.setAttribute('title', 'Original title');
    span.textContent = 'Original source';
    nestedShadow.appendChild(span);
    await start();
    const titleAttribute = span.getAttributeNode('title');
    // Shadow content is discovered in a later slice than the host, so both
    // shadow requests are awaited explicitly before settling them.
    await settleRequests([span.firstChild, titleAttribute]);

    expect(span.textContent).toContain('Translated Original source');
    expect(span.getAttribute('title')).toContain('Translated Original title');

    bridge.restore(document.body);

    expect(span.textContent).toBe('Original source');
    expect(span.getAttribute('title')).toBe('Original title');
  });

  it('restores accepted nodes after the session was stopped', async () => {
    const owner = document.createElement('div');
    owner.textContent = 'Original source';
    document.body.appendChild(owner);
    await start();
    await settleRequests([owner.firstChild]);
    bridge.stopPersistence();

    bridge.restore(document.body);

    expect(owner.textContent).toBe('Original source');
  });

  it('does not apply a pending translation that resolves after restore', async () => {
    const owner = document.createElement('div');
    owner.textContent = 'Original source';
    document.body.appendChild(owner);
    await start();
    await waitForRequests([owner.firstChild]);

    bridge.restore(document.body);
    requestFor(owner.firstChild).resolve(settlement('Late translation'));
    await Promise.resolve();
    await Promise.resolve();

    expect(owner.textContent).toBe('Original source');
  });

  it('does not apply a cancelled translation after restore', async () => {
    const owner = document.createElement('div');
    owner.textContent = 'Original source';
    document.body.appendChild(owner);
    await start();
    await waitForRequests([owner.firstChild]);

    bridge.stopPersistence();
    bridge.restore(document.body);
    const cancelled = vi.fn();
    requestFor(owner.firstChild).resolve({
      __pageTranslationSettlement: true,
      text: 'Cancelled translation',
      state: 'pending',
      settle: cancelled,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(owner.textContent).toBe('Original source');
    expect(cancelled).toHaveBeenCalledWith('cancelled');
  });

  it('restores repeatedly without reviving stale storage', async () => {
    const owner = document.createElement('div');
    owner.textContent = 'Original source';
    document.body.appendChild(owner);
    await start();
    await settleRequests([owner.firstChild]);

    const storage = bridge.session.nodesTranslator.nodeStorage;
    bridge.restore(document.body);
    bridge.restore(document.body);

    expect(owner.textContent).toBe('Original source');
    expect(storage.has(owner.firstChild)).toBe(false);
  });
});
