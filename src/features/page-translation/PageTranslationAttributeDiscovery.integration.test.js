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

describe('Page Translation attribute discovery integration', () => {
  let bridge;
  let PageTranslationBridgeClass;

  beforeEach(async () => {
    PageTranslationBridgeClass = await loadBridge(true);
  });

  afterEach(() => {
    bridge?.cleanup();
    bridge = null;
    vi.restoreAllMocks();
    vi.doUnmock('./PageTranslationConstants.js');
    document.body.replaceChildren();
  });

  const start = async (translate, options = {}) => {
    const states = [];
    bridge = new PageTranslationBridgeClass();
    await bridge.initialize({ ...settings, ...options.settings }, translate, options.context, {
      onDiscoveryStateChange: (pending) => states.push(pending),
    });
    bridge.translate(document.body);
    return states;
  };

  // Discovery completion is reported by the bridge lifecycle callback, so the
  // assertions below only run once the walk has actually finished.
  const waitForDiscoveryIdle = async (states) => {
    await vi.waitFor(() => expect(states.at(-1)).toBe(false));
    await new Promise(resolve => setTimeout(resolve, 0));
    await vi.waitFor(() => expect(states.at(-1)).toBe(false));
  };

  it('translates only attributes on the default allow-list', async () => {
    const paragraph = appendElement(document.createDocumentFragment(), 'p', 'Body text', {
      title: 'Title value',
      alt: 'Alt value',
      placeholder: 'Placeholder value',
      'data-note': 'Data value',
      id: 'marker',
    });
    document.body.replaceChildren(paragraph);
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    const states = await start(translate);

    await waitForDiscoveryIdle(states);
    const requested = translate.mock.calls.map(([text]) => text);
    expect(requested).toContain('Title value');
    expect(requested).toContain('Alt value');
    expect(requested).toContain('Placeholder value');
    expect(requested).not.toContain('Data value');
    expect(requested).not.toContain('marker');
    await vi.waitFor(() => expect(paragraph.getAttribute('title')).toContain('Translated Title value'));
  });

  it('honours a custom attribute allow-list', async () => {
    const paragraph = appendElement(document.createDocumentFragment(), 'p', 'Body text', {
      title: 'Title value',
      'data-prefix': 'Prefix value',
    });
    document.body.replaceChildren(paragraph);
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    const states = await start(translate, { settings: { attributesToTranslate: ['data-prefix'] } });

    await waitForDiscoveryIdle(states);
    const requested = translate.mock.calls.map(([text]) => text);
    expect(requested).toContain('Prefix value');
    expect(requested).not.toContain('Title value');
    await vi.waitFor(() => expect(paragraph.getAttribute('data-prefix')).toContain('Translated Prefix value'));
    expect(paragraph.getAttribute('title')).toBe('Title value');
  });

  it('does not request attributes that are absent or outside the allow-list', async () => {
    const withoutAllowed = appendElement(document.createDocumentFragment(), 'p', 'Body text', { 'data-note': 'Data value' });
    const withAllowed = appendElement(document.createDocumentFragment(), 'p', 'Other text', { title: 'Title value' });
    document.body.replaceChildren(withoutAllowed, withAllowed);
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    const states = await start(translate);

    await waitForDiscoveryIdle(states);
    const requested = translate.mock.calls.map(([text]) => text);
    expect(requested).not.toContain('Data value');
    expect(requested).toContain('Title value');
  });

  it('translates the current value when an attribute changes before the walk reaches it', async () => {
    const paragraph = appendElement(document.createDocumentFragment(), 'p', 'Body text', { title: 'Original title' });
    document.body.replaceChildren(paragraph);
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    const states = await start(translate);

    paragraph.setAttribute('title', 'Updated title');

    await waitForDiscoveryIdle(states);
    const requested = translate.mock.calls.map(([text]) => text);
    expect(requested).toContain('Updated title');
    expect(requested).not.toContain('Original title');
  });

  it('does not request an attribute that was removed before the walk reached it', async () => {
    const paragraph = appendElement(document.createDocumentFragment(), 'p', 'Body text', { title: 'Removed title' });
    document.body.replaceChildren(paragraph);
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    const states = await start(translate);

    paragraph.removeAttribute('title');

    await waitForDiscoveryIdle(states);
    expect(translate.mock.calls.map(([text]) => text)).not.toContain('Removed title');
  });

  it('translates an attribute added after discovery completed', async () => {
    const paragraph = appendElement(document.createDocumentFragment(), 'p', 'Body text', { title: 'Title value' });
    document.body.replaceChildren(paragraph);
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    const states = await start(translate, { settings: { autoTranslateOnDOMChanges: true } });

    await waitForDiscoveryIdle(states);
    paragraph.setAttribute('alt', 'Late alt value');

    await vi.waitFor(() => expect(paragraph.getAttribute('alt')).toContain('Translated Late alt value'));
    expect(translate.mock.calls.filter(([text]) => text === 'Late alt value')).toHaveLength(1);
  });

  it('admits each attribute once and keeps stale attribute values out of the provider', async () => {
    const paragraph = appendElement(document.createDocumentFragment(), 'p', 'Body text', { title: 'Title value' });
    document.body.replaceChildren(paragraph);
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    const states = await start(translate, { settings: { autoTranslateOnDOMChanges: true } });

    await waitForDiscoveryIdle(states);
    await vi.waitFor(() => expect(paragraph.getAttribute('title')).toContain('Translated Title value'));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(translate.mock.calls.filter(([text]) => text === 'Title value')).toHaveLength(1);
  });

  it('translates allow-listed attributes inside nested shadow roots', async () => {
    const host = appendElement(document.createDocumentFragment(), 'div');
    document.body.replaceChildren(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const shadowElement = appendElement(shadow, 'span', 'Shadow text', { title: 'Shadow title', 'data-note': 'Shadow data' });
    const nestedHost = appendElement(shadow, 'div');
    const nestedShadow = nestedHost.attachShadow({ mode: 'open' });
    const nestedElement = appendElement(nestedShadow, 'span', 'Nested text', { title: 'Nested title' });
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    const states = await start(translate);

    await waitForDiscoveryIdle(states);
    const requested = translate.mock.calls.map(([text]) => text);
    expect(requested).toContain('Shadow title');
    expect(requested).toContain('Nested title');
    expect(requested).not.toContain('Shadow data');
    await vi.waitFor(() => expect(shadowElement.getAttribute('title')).toContain('Translated Shadow title'));
    await vi.waitFor(() => expect(nestedElement.getAttribute('title')).toContain('Translated Nested title'));
  });
});
