import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() })),
}));

vi.mock('@/utils/dom/DomDirectionManager.js', () => ({
  applyNodeDirection: vi.fn(),
  isRTL: vi.fn(() => false),
  restoreElementDirection: vi.fn(),
  BIDI_MARKS: { RLM: '\u200f', LRM: '\u200e' },
}));

const settings = {
  targetLanguage: 'en',
  lazyLoading: false,
  showOriginalOnHover: false,
  autoTranslateOnDOMChanges: false,
  attributesToTranslate: ['title', 'alt', 'placeholder'],
};

const loadBridge = async (sliced) => {
  vi.resetModules();
  vi.doMock('./PageTranslationConstants.js', async () => ({
    ...await vi.importActual('./PageTranslationConstants.js'),
    PAGE_TRANSLATION_SLICED_DISCOVERY: sliced,
    PAGE_TRANSLATION_DISCOVERY_SLICE_MAX_STEPS: 1,
    PAGE_TRANSLATION_DISCOVERY_SLICE_BUDGET_MS: 1000,
  }));
  return (await import('./PageTranslationBridge.js')).PageTranslationBridge;
};

const appendElement = (parent, tagName, text = '', attributes = {}) => {
  const element = document.createElement(tagName);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  if (text) element.textContent = text;
  parent.appendChild(element);
  return element;
};

const acceptedTranslation = (text) => ({
  __pageTranslationSettlement: true,
  text: `Translated ${text}`,
  state: 'pending',
  settle(outcome) { this.state = outcome; },
});

describe('Page Translation whitespace discovery integration', () => {
  let bridge;
  let PageTranslationBridgeClass;
  let previousIntersectionObserver;

  beforeEach(async () => {
    PageTranslationBridgeClass = await loadBridge(true);
    previousIntersectionObserver = globalThis.IntersectionObserver;
  });

  afterEach(() => {
    bridge?.cleanup();
    bridge = null;
    vi.restoreAllMocks();
    vi.doUnmock('./PageTranslationConstants.js');
    document.body.replaceChildren();
    if (previousIntersectionObserver) globalThis.IntersectionObserver = previousIntersectionObserver;
    else delete globalThis.IntersectionObserver;
  });

  const start = async (translate, options = {}) => {
    const states = [];
    bridge = new PageTranslationBridgeClass();
    await bridge.initialize({ ...settings, ...options.settings }, translate, options.context, {
      onDiscoveryStateChange: (pending) => {
        states.push(pending);
        options.onState?.(pending);
      },
    });
    bridge.translate(document.body);
    return states;
  };

  const waitForDiscoveryIdle = async (states, timeout = 5000) => {
    await vi.waitFor(() => expect(states.at(-1)).toBe(false), { timeout });
    await new Promise(resolve => setTimeout(resolve, 0));
    await vi.waitFor(() => expect(states.at(-1)).toBe(false), { timeout });
  };

  const installIntersectionObserver = () => {
    const observers = [];
    const observed = new Set();
    globalThis.IntersectionObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.observe = vi.fn((target) => { observed.add(target); });
        this.unobserve = vi.fn();
        this.disconnect = vi.fn();
        observers.push(this);
      }
    };
    return { observers, observed };
  };

  it('skips whitespace-only text nodes when mutation handling is enabled', async () => {
    const { observers, observed } = installIntersectionObserver();
    const whitespace = appendElement(document.createDocumentFragment(), 'p', '   ');
    const real = appendElement(document.createDocumentFragment(), 'p', 'Real text');
    document.body.replaceChildren(whitespace, real);
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    const states = await start(translate, {
      settings: { lazyLoading: true, autoTranslateOnDOMChanges: true },
    });

    await waitForDiscoveryIdle(states);
    expect(observed.has(whitespace)).toBe(false);
    expect(observed.has(real)).toBe(true);
    expect(translate.mock.calls.map(([text]) => text)).not.toContain('   ');

    observers[0].callback([{ target: real, isIntersecting: true }], observers[0]);
    await vi.waitFor(() => expect(real.textContent).toContain('Translated Real text'));
  });

  it('keeps whitespace-only nodes observable when mutation handling is disabled', async () => {
    const { observed } = installIntersectionObserver();
    const whitespace = appendElement(document.createDocumentFragment(), 'p', '   ');
    document.body.replaceChildren(whitespace);
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    const states = await start(translate, { settings: { lazyLoading: true } });

    await waitForDiscoveryIdle(states);
    expect(observed.has(whitespace)).toBe(true);
    expect(translate).not.toHaveBeenCalled();
  });

  it('translates a node that gains text after discovery when mutation handling is enabled', async () => {
    const whitespace = appendElement(document.createDocumentFragment(), 'p', ' ');
    document.body.replaceChildren(whitespace);
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    const states = await start(translate, { settings: { autoTranslateOnDOMChanges: true } });

    await waitForDiscoveryIdle(states);
    whitespace.firstChild.nodeValue = 'Now filled';

    await vi.waitFor(() => expect(whitespace.textContent).toContain('Translated Now filled'));
    expect(translate.mock.calls.filter(([text]) => text === 'Now filled')).toHaveLength(1);
  });

  it('keeps the existing lazy behavior for nodes that gain text without mutation handling', async () => {
    const { observers, observed } = installIntersectionObserver();
    const whitespace = appendElement(document.createDocumentFragment(), 'p', ' ');
    document.body.replaceChildren(whitespace);
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    const states = await start(translate, { settings: { lazyLoading: true } });

    await waitForDiscoveryIdle(states);
    // Without mutation handling the node stays registered for lazy admission.
    expect(observed.has(whitespace)).toBe(true);

    whitespace.firstChild.nodeValue = 'Filled before visibility';
    observers[0].callback([{ target: whitespace, isIntersecting: true }], observers[0]);
    await new Promise(resolve => setTimeout(resolve, 0));

    // The registered source value is stale, so the admission is rejected and
    // the node keeps its text - the behavior that existed before the skip.
    expect(whitespace.textContent).toBe('Filled before visibility');
    expect(translate).not.toHaveBeenCalled();
  });

  it('skips whitespace inside nested shadow roots and still translates shadow text', async () => {
    const host = appendElement(document.createDocumentFragment(), 'div');
    document.body.replaceChildren(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const shadowWhitespace = appendElement(shadow, 'span', ' ');
    const shadowText = appendElement(shadow, 'span', 'Shadow text');
    const nestedHost = appendElement(shadow, 'div');
    const nestedShadow = nestedHost.attachShadow({ mode: 'open' });
    const nestedWhitespace = appendElement(nestedShadow, 'span', '  ');
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    const states = await start(translate, {
      settings: { autoTranslateOnDOMChanges: true },
    });

    await waitForDiscoveryIdle(states);
    // Shadow text is translated directly (it is not lazily observed), while the
    // whitespace-only shadow nodes are skipped and never reach the provider.
    await vi.waitFor(() => expect(shadowText.textContent).toContain('Translated Shadow text'));
    expect(translate.mock.calls.map(([text]) => text)).toEqual(['Shadow text']);
    expect(shadowWhitespace.textContent).toBe(' ');
    expect(nestedWhitespace.textContent).toBe('  ');
  });

  it('translates a shadow node that gains text after discovery', async () => {
    const host = appendElement(document.createDocumentFragment(), 'div');
    document.body.replaceChildren(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const shadowWhitespace = appendElement(shadow, 'span', ' ');
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    const states = await start(translate, { settings: { autoTranslateOnDOMChanges: true } });

    await waitForDiscoveryIdle(states);
    shadowWhitespace.firstChild.nodeValue = 'Shadow filled';

    await vi.waitFor(() => expect(shadowWhitespace.textContent).toContain('Translated Shadow filled'));
  });

  it('rejects a stale result when the node is replaced before the provider answers', async () => {
    const whitespace = appendElement(document.createDocumentFragment(), 'p', ' ');
    document.body.replaceChildren(whitespace);
    const pending = [];
    const translate = vi.fn((text) => new Promise(resolve => pending.push({ text, resolve })));
    const states = await start(translate, { settings: { autoTranslateOnDOMChanges: true } });

    await waitForDiscoveryIdle(states);
    whitespace.firstChild.nodeValue = 'Stale content';
    await vi.waitFor(() => expect(pending).toHaveLength(1));

    const replacement = document.createElement('p');
    replacement.textContent = 'Replacement';
    whitespace.replaceWith(replacement);

    pending[0].resolve(acceptedTranslation('Stale content'));
    await Promise.resolve();
    await Promise.resolve();

    expect(replacement.textContent).toBe('Replacement');
    expect(document.body.textContent).not.toContain('Translated Stale content');
  });

  it('cancels queued discovery of whitespace nodes without translating them', async () => {
    const whitespace = appendElement(document.createDocumentFragment(), 'p', ' ');
    document.body.replaceChildren(whitespace);
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    const states = await start(translate, { settings: { autoTranslateOnDOMChanges: true } });

    bridge.stopPersistence();
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(translate).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe(false);
    expect(whitespace.textContent).toBe(' ');
  });

  it('yields to the event loop while skipping a long run of whitespace nodes', async () => {
    const run = document.createElement('div');
    for (let i = 0; i < 5000; i++) run.appendChild(document.createTextNode(' '));
    const real = appendElement(document.createDocumentFragment(), 'p', 'Real text');
    document.body.replaceChildren(run, real);
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));

    let ticks = 0;
    let counting = true;
    let ticksAtDrain = 0;
    const tick = () => {
      if (!counting) return;
      ticks++;
      setTimeout(tick, 0);
    };
    setTimeout(tick, 0);

    const states = await start(translate, {
      settings: { autoTranslateOnDOMChanges: true },
      onState: (pending) => { if (pending === false) ticksAtDrain = ticks; },
    });

    await waitForDiscoveryIdle(states, 15000);
    counting = false;
    await vi.waitFor(() => expect(real.textContent).toContain('Translated Real text'));
    // The bounded skip must return to the event loop instead of scanning the
    // whole run inside a single slice.
    expect(ticksAtDrain).toBeGreaterThanOrEqual(20);
    expect(translate.mock.calls.map(([text]) => text)).toEqual(['Real text']);
  });

  it('keeps discovery bounded with long runs of whitespace nodes', async () => {
    const run = document.createElement('div');
    for (let i = 0; i < 2000; i++) run.appendChild(document.createTextNode(' '));
    const real = appendElement(document.createDocumentFragment(), 'p', 'Real text');
    document.body.replaceChildren(run, real);
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    const states = await start(translate, { settings: { autoTranslateOnDOMChanges: true } });

    await waitForDiscoveryIdle(states, 15000);
    await vi.waitFor(() => expect(real.textContent).toContain('Translated Real text'));
    expect(translate.mock.calls.map(([text]) => text)).toEqual(['Real text']);
  });
});
