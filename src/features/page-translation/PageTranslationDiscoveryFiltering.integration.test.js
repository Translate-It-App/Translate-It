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
  attributesToTranslate: ['title'],
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

describe('Page Translation discovery filtering integration', () => {
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

  const start = async (translate = (text) => Promise.resolve(acceptedTranslation(text)), options = {}) => {
    bridge = new PageTranslationBridgeClass();
    await bridge.initialize({ ...settings, ...options.settings }, translate, options.context, options.callbacks);
    bridge.translate(document.body);
  };

  // Discovery completion is reported by the bridge lifecycle callback, so the
  // negative assertions below only run once discovery has actually finished.
  const startTrackingDiscovery = () => {
    const states = [];
    const callbacks = { onDiscoveryStateChange: (pending) => states.push(pending) };
    return { states, callbacks };
  };

  const waitForDiscoveryIdle = async (states) => {
    await vi.waitFor(() => expect(states.at(-1)).toBe(false));
    // A follow-up discovery (dynamic subtree, shadow root) may start right
    // after a drain, so idle is only established when the state is still
    // drained at the end of an event-loop turn.
    await new Promise(resolve => setTimeout(resolve, 0));
    await vi.waitFor(() => expect(states.at(-1)).toBe(false));
  };

  const installIntersectionObserver = () => {
    const observers = [];
    globalThis.IntersectionObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.observe = vi.fn();
        this.unobserve = vi.fn();
        this.disconnect = vi.fn();
        observers.push(this);
      }
    };
    return observers;
  };

  it.each([
    ['translate=no', (element) => element.setAttribute('translate', 'no')],
    ['notranslate class', (element) => element.classList.add('notranslate')],
    ['configured selector', (element) => element.classList.add('custom-excluded')],
    ['editable ancestor', (element) => element.setAttribute('contenteditable', 'true')],
  ])('does not translate a node excluded after discovery but before admission (%s)', async (_name, exclude) => {
    const observers = installIntersectionObserver();
    const paragraph = appendElement(document.createDocumentFragment(), 'p', 'Discovered before exclusion', { id: 'target' });
    document.body.replaceChildren(paragraph);
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    const { states, callbacks } = startTrackingDiscovery();
    await start(translate, {
      settings: { lazyLoading: true, excludedSelectors: ['.custom-excluded'] },
      callbacks,
    });

    await waitForDiscoveryIdle(states);
    // The node was discovered and registered for lazy admission while eligible.
    expect(observers[0].observe).toHaveBeenCalledWith(paragraph);
    expect(translate).not.toHaveBeenCalled();

    exclude(paragraph);
    observers[0].callback([{ target: paragraph, isIntersecting: true }], observers[0]);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(translate).not.toHaveBeenCalled();
    expect(paragraph.textContent).toBe('Discovered before exclusion');
  });

  it('translates a node that stays eligible until admission', async () => {
    const observers = installIntersectionObserver();
    const paragraph = appendElement(document.createDocumentFragment(), 'p', 'Still eligible');
    document.body.replaceChildren(paragraph);
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    const { states, callbacks } = startTrackingDiscovery();
    await start(translate, { settings: { lazyLoading: true }, callbacks });

    await waitForDiscoveryIdle(states);
    expect(observers[0].observe).toHaveBeenCalledWith(paragraph);
    expect(translate).not.toHaveBeenCalled();

    observers[0].callback([{ target: paragraph, isIntersecting: true }], observers[0]);

    await vi.waitFor(() => expect(paragraph.textContent).toContain('Translated Still eligible'));
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['editable ancestor', { region: { contenteditable: 'true' }, own: {} }, 'Editable text', false],
    ['editable element itself', { region: { contenteditable: 'true' }, own: { contenteditable: '' } }, 'Editable text', false],
    ['plaintext-only ancestor', { region: { contenteditable: 'plaintext-only' }, own: {} }, 'Editable text', false],
    ['editable island', { region: { contenteditable: 'true' }, own: { contenteditable: 'false' } }, 'Island text', true],
    ['inherit inside an editable region', { region: { contenteditable: 'true' }, own: { contenteditable: 'inherit' } }, 'Inherited text', false],
    ['inherit without an editable region', { region: {}, own: { contenteditable: 'inherit' } }, 'Inherited text', true],
  ])('keeps editable semantics (%s)', async (_name, shape, text, shouldTranslate) => {
    const region = appendElement(document.createDocumentFragment(), 'div', '', shape.region);
    appendElement(region, 'p', text, shape.own);
    document.body.replaceChildren(region);
    const translate = vi.fn((value) => Promise.resolve(acceptedTranslation(value)));
    const { states, callbacks } = startTrackingDiscovery();
    await start(translate, { callbacks });

    await waitForDiscoveryIdle(states);
    // The provider is called synchronously while the node is processed, so the
    // request list is final once discovery drained.
    expect(translate.mock.calls.some(([value]) => value === text)).toBe(shouldTranslate);
    if (shouldTranslate) {
      await vi.waitFor(() => expect(document.body.textContent).toContain('Translated'));
    } else {
      expect(document.body.textContent).not.toContain('Translated');
    }
  });

  it.each([
    ['notranslate class', { class: 'notranslate' }],
    ['translate=no', { translate: 'no' }],
  ])('keeps notranslate semantics in sliced discovery (%s)', async (_name, attributes) => {
    const paragraph = appendElement(document.createDocumentFragment(), 'p', 'Excluded text', attributes);
    document.body.replaceChildren(paragraph);
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    const { states, callbacks } = startTrackingDiscovery();
    await start(translate, { callbacks });

    await waitForDiscoveryIdle(states);
    expect(translate).not.toHaveBeenCalled();
    expect(paragraph.textContent).toBe('Excluded text');
  });

  it('keeps shadow host exclusions in sliced discovery', async () => {
    const host = appendElement(document.createDocumentFragment(), 'div', '', { class: 'notranslate' });
    document.body.replaceChildren(host);
    const shadow = host.attachShadow({ mode: 'open' });
    appendElement(shadow, 'span', 'Shadow text');
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    const { states, callbacks } = startTrackingDiscovery();
    await start(translate, { callbacks });

    await waitForDiscoveryIdle(states);
    expect(translate).not.toHaveBeenCalled();
    expect(shadow.textContent).toBe('Shadow text');
  });
});
