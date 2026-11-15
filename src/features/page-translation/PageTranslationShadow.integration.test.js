import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  })),
}));

vi.mock('@/features/shared/hover-preview/HoverPreviewLookup.js', () => ({
  hoverPreviewLookup: {
    add: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock('@/utils/dom/DomDirectionManager.js', () => ({
  applyNodeDirection: vi.fn(),
  isRTL: vi.fn(() => false),
  restoreElementDirection: vi.fn(),
  BIDI_MARKS: { RLM: '\u200f', LRM: '\u200e' },
}));

import { PageTranslationBridge } from './PageTranslationBridge.js';
import { UI_HOST_IDS } from '@/shared/constants/ui.js';

const settings = (overrides = {}) => ({
  targetLanguage: 'en',
  lazyLoading: false,
  showOriginalOnHover: false,
  autoTranslateOnDOMChanges: false,
  excludedSelectors: [],
  attributesToTranslate: ['title', 'aria-label'],
  ...overrides,
});

const createShadowHost = (parent = document.body, options = {}) => {
  const host = document.createElement(options.tagName || 'custom-element');
  if (options.className) host.className = options.className;
  if (options.id) host.id = options.id;
  parent.appendChild(host);
  return { host, shadow: host.attachShadow({ mode: 'open' }) };
};

const translate = async (root, options = {}) => {
  const { bridge, onTranslate } = await deferredTranslate(root, options, { autoSettle: true });
  return { bridge, onTranslate };
};

const startTranslation = async (root, options = {}) => {
  const onTranslate = vi.fn((text) => settlement(`Translated ${text}`));
  const bridge = new PageTranslationBridge();
  await bridge.initialize(settings(options), onTranslate);
  bridge.translate(root);
  return { bridge, onTranslate };
};

const deferredTranslate = async (root, options = {}, { autoSettle = false } = {}) => {
  const pending = [];
  const onTranslate = vi.fn((text, context, score, node) => new Promise(resolve => {
    pending.push({ text, node, resolve });
    // Sliced discovery issues provider requests across slices, so the
    // auto-settled path settles every request as soon as it arrives.
    if (autoSettle) resolve(settlement(`Translated ${text}`));
  }));
  const bridge = new PageTranslationBridge();
  await bridge.initialize(settings(options), onTranslate);
  bridge.translate(root);
  await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
  return { bridge, onTranslate, pending };
};

const settlement = (text, onSettle = vi.fn()) => {
  let state = 'pending';
  return {
    __pageTranslationSettlement: true,
    text,
    get state() {
      return state;
    },
    settle(outcome) {
      state = outcome;
      onSettle(outcome);
    },
  };
};

describe('PageTranslationBridge Shadow DOM ownership', () => {
  let bridges = [];

  afterEach(() => {
    bridges.forEach(bridge => bridge.cleanup());
    bridges = [];
    document.body.innerHTML = '';
  });

  const track = (bridge) => {
    bridges.push(bridge);
    return bridge;
  };

  it('translates initial text and configured attributes inside an open ShadowRoot', async () => {
    const { shadow } = createShadowHost();
    const span = document.createElement('span');
    span.title = 'Shadow title';
    span.textContent = 'Shadow text';
    shadow.appendChild(span);

    const { bridge, onTranslate } = await deferredTranslate(document.body, {}, { autoSettle: true });
    track(bridge);

    await vi.waitFor(() => expect(span.textContent).toContain('Translated Shadow text'));
    await vi.waitFor(() => expect(onTranslate.mock.calls.map(([text]) => text)).toEqual(
      expect.arrayContaining(['Shadow text', 'Shadow title'])
    ));
    expect(span.title).toContain('Translated Shadow title');
  });

  it('translates nested open ShadowRoots', async () => {
    const { shadow } = createShadowHost();
    const { shadow: nestedShadow } = createShadowHost(shadow);
    const span = document.createElement('span');
    span.textContent = 'Nested shadow text';
    nestedShadow.appendChild(span);

    const { bridge } = await translate(document.body);
    track(bridge);

    await vi.waitFor(() => expect(span.textContent).toContain('Translated Nested shadow text'));
  });

  it('preserves local light-DOM exclusion semantics for text and attributes', async () => {
    const excludedClass = document.createElement('span');
    excludedClass.className = 'notranslate';
    excludedClass.title = 'Excluded class title';
    excludedClass.textContent = 'Excluded class text';

    const excludedAttribute = document.createElement('span');
    excludedAttribute.setAttribute('translate', 'no');
    excludedAttribute.title = 'Excluded attribute title';
    excludedAttribute.textContent = 'Excluded attribute text';

    const configured = document.createElement('span');
    configured.className = 'custom-excluded';
    configured.title = 'Configured title';
    configured.textContent = 'Configured text';

    const allowed = document.createElement('span');
    allowed.title = 'Allowed title';
    allowed.textContent = 'Allowed text';
    document.body.append(excludedClass, excludedAttribute, configured, allowed);

    const { bridge, onTranslate } = await startTranslation(document.body, {
      excludedSelectors: ['.custom-excluded'],
    });
    track(bridge);

    // The allowed nodes come last in document order, so waiting for them means
    // discovery already passed every excluded node.
    await vi.waitFor(() => expect(onTranslate.mock.calls.map(([text]) => text)).toEqual(
      expect.arrayContaining(['Allowed text', 'Allowed title'])
    ));
    const translatedTexts = onTranslate.mock.calls.map(([text]) => text);
    expect(translatedTexts).not.toEqual(expect.arrayContaining([
      'Excluded class text',
      'Excluded class title',
      'Excluded attribute text',
      'Excluded attribute title',
      'Configured text',
      'Configured title',
    ]));
  });

  it('translates visible BUTTON text while protecting its machine value', async () => {
    const { shadow } = createShadowHost();
    const button = document.createElement('button');
    button.value = 'save';
    button.textContent = 'Save';
    shadow.appendChild(button);

    const { bridge, onTranslate } = await translate(document.body);
    track(bridge);

    await vi.waitFor(() => expect(button.textContent).toContain('Translated Save'));
    expect(button.value).toBe('save');
    expect(onTranslate.mock.calls.map(([text]) => text)).toContain('Save');
  });

  it.each([
    ['excluded host', (host) => host.classList.add('notranslate')],
    ['excluded light-DOM ancestor', (host) => host.parentElement.classList.add('excluded')],
    ['excluded local shadow ancestor', (host) => host.shadowRoot.firstElementChild.classList.add('excluded')],
    ['custom persisted selector', (host) => host.classList.add('custom-excluded')],
  ])('does not schedule content under %s', async (_name, configure) => {
    const wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    const { host, shadow } = createShadowHost(wrapper);
    const local = document.createElement('section');
    const text = document.createElement('span');
    text.textContent = 'Excluded shadow text';
    local.appendChild(text);
    shadow.appendChild(local);
    configure(host);

    const excludedSelectors = _name === 'custom persisted selector'
      ? ['.custom-excluded']
      : _name === 'excluded light-DOM ancestor'
        ? ['.excluded']
        : _name === 'excluded local shadow ancestor'
          ? ['.excluded']
          : [];
    const { bridge, onTranslate } = await startTranslation(document.body, { excludedSelectors });
    track(bridge);

    await Promise.resolve();
    expect(onTranslate).not.toHaveBeenCalled();
    expect(text.textContent).toBe('Excluded shadow text');
  });

  it('protects extension-owned Shadow UI even when host is inside translation root', async () => {
    const { shadow } = createShadowHost(document.body, { id: UI_HOST_IDS.MAIN });
    const text = document.createElement('span');
    text.textContent = 'Extension UI text';
    shadow.appendChild(text);

    const { bridge, onTranslate } = await startTranslation(document.body);
    track(bridge);

    await Promise.resolve();
    expect(onTranslate).not.toHaveBeenCalled();
    expect(text.textContent).toBe('Extension UI text');
  });

  it('propagates an outer host exclusion through nested ShadowRoots', async () => {
    const { host: outerHost, shadow } = createShadowHost();
    outerHost.classList.add('notranslate');
    const { shadow: nestedShadow } = createShadowHost(shadow);
    const text = document.createElement('span');
    text.textContent = 'Nested excluded text';
    nestedShadow.appendChild(text);

    const { bridge, onTranslate } = await startTranslation(document.body);
    track(bridge);

    await Promise.resolve();
    expect(onTranslate).not.toHaveBeenCalled();
    expect(text.textContent).toBe('Nested excluded text');
  });

  it('propagates an intermediate host exclusion through nested ShadowRoots', async () => {
    const { shadow } = createShadowHost();
    const { host: intermediateHost, shadow: nestedShadow } = createShadowHost(shadow);
    intermediateHost.classList.add('notranslate');
    const text = document.createElement('span');
    text.textContent = 'Intermediate excluded text';
    nestedShadow.appendChild(text);

    const { bridge, onTranslate } = await startTranslation(document.body);
    track(bridge);

    await Promise.resolve();
    expect(onTranslate).not.toHaveBeenCalled();
    expect(text.textContent).toBe('Intermediate excluded text');
  });

  it('restores initial ShadowRoot text and attributes', async () => {
    const { shadow } = createShadowHost();
    const span = document.createElement('span');
    span.title = 'Original title';
    span.textContent = 'Original text';
    shadow.appendChild(span);

    const { bridge } = await translate(document.body);
    track(bridge);
    await vi.waitFor(() => expect(span.textContent).toContain('Translated Original text'));

    bridge.restore(document.body);

    expect(span.textContent).toBe('Original text');
    expect(span.title).toBe('Original title');
  });

  it.each([
    ['edited', (node) => { node.nodeValue = 'Edited'; }],
    ['removed host', (node) => { node.getRootNode().host.remove(); }],
    ['replaced host', (node) => {
      const host = node.getRootNode().host;
      host.replaceWith(document.createElement('custom-element'));
    }],
  ])('rejects stale shadow text after %s', async (_name, mutate) => {
    const { shadow } = createShadowHost();
    const span = document.createElement('span');
    span.textContent = 'Original';
    shadow.appendChild(span);
    const text = span.firstChild;
    const { bridge, pending } = await deferredTranslate(document.body);
    track(bridge);
    const stale = vi.fn();

    mutate(text);
    pending[0].resolve(settlement('Translated', stale));

    await Promise.resolve();
    await Promise.resolve();
    expect(text.nodeValue).not.toContain('Translated');
    expect(stale).toHaveBeenCalledWith('stale');
  });

  it('rejects stale nested shadow text after its nested host is replaced', async () => {
    const { shadow } = createShadowHost();
    const { host: nestedHost, shadow: nestedShadow } = createShadowHost(shadow);
    const span = document.createElement('span');
    span.textContent = 'Original';
    nestedShadow.appendChild(span);
    const text = span.firstChild;
    const { bridge, pending } = await deferredTranslate(document.body);
    track(bridge);
    const stale = vi.fn();

    nestedHost.replaceWith(document.createElement('custom-element'));
    pending[0].resolve(settlement('Translated', stale));

    await Promise.resolve();
    await Promise.resolve();
    expect(text.nodeValue).toBe('Original');
    expect(stale).toHaveBeenCalledWith('stale');
  });

  it('rejects stale shadow Attr after removal and recreation', async () => {
    const { shadow } = createShadowHost();
    const element = document.createElement('span');
    element.title = 'Original';
    shadow.appendChild(element);
    const { bridge, pending } = await deferredTranslate(document.body);
    track(bridge);
    const stale = vi.fn();

    element.removeAttribute('title');
    element.setAttribute('title', 'Replacement');
    pending[0].resolve(settlement('Translated', stale));

    await Promise.resolve();
    await Promise.resolve();
    expect(element.title).toBe('Replacement');
    expect(stale).toHaveBeenCalledWith('stale');
  });

  it('rejects older shadow work after an ABA source change', async () => {
    const { shadow } = createShadowHost();
    const span = document.createElement('span');
    span.textContent = 'one';
    shadow.appendChild(span);
    const text = span.firstChild;
    const { bridge, pending } = await deferredTranslate(document.body, { autoTranslateOnDOMChanges: true });
    track(bridge);
    text.nodeValue = 'two';
    bridge.session.domTranslator.update(text);
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(1));
    text.nodeValue = 'one';
    bridge.session.domTranslator.update(text);
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(2));
    const stale = vi.fn();

    pending[0].resolve(settlement('Old translation', stale));

    await Promise.resolve();
    await Promise.resolve();
    expect(text.nodeValue).toBe('one');
    expect(stale).toHaveBeenCalledWith('stale');
  });

  it('does not claim support for roots attached after the initial traversal', async () => {
    const host = document.createElement('custom-element');
    document.body.appendChild(host);
    const { bridge, onTranslate } = await startTranslation(document.body, { autoTranslateOnDOMChanges: true });
    track(bridge);
    const shadow = host.attachShadow({ mode: 'open' });
    const span = document.createElement('span');
    span.textContent = 'Dynamic shadow text';
    shadow.appendChild(span);

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onTranslate).not.toHaveBeenCalled();
    expect(span.textContent).toBe('Dynamic shadow text');
  });

  it('translates later mutations inside an existing ShadowRoot', async () => {
    const { shadow } = createShadowHost();
    const { bridge, onTranslate } = await startTranslation(document.body, { autoTranslateOnDOMChanges: true });
    track(bridge);
    const span = document.createElement('span');
    span.textContent = 'Later shadow text';
    shadow.appendChild(span);

    await vi.waitFor(() => expect(span.textContent).toContain('Translated Later shadow text'));
    expect(onTranslate.mock.calls.map(([text]) => text)).toContain('Later shadow text');
  });
});
