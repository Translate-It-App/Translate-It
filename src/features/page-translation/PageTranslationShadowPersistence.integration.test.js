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
import { getTranslationFontTarget } from '@/shared/fonts/TranslationFontPolicy.js';

const nativeGetComputedStyle = window.getComputedStyle.bind(window);
let fontComputedStyleSpy;

const enableFontPolicyStyles = () => {
  if (fontComputedStyleSpy) return;
  fontComputedStyleSpy = vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    if (pseudo) return { content: 'none' };
    return nativeGetComputedStyle(element, pseudo);
  });
};

const settings = (overrides = {}) => ({
  targetLanguage: 'en',
  lazyLoading: false,
  showOriginalOnHover: false,
  autoTranslateOnDOMChanges: true,
  excludedSelectors: [],
  attributesToTranslate: ['title', 'aria-label'],
  ...overrides,
});

const createHost = (parent = document.body) => {
  const host = document.createElement('custom-element');
  parent.appendChild(host);
  return { host, shadow: host.attachShadow({ mode: 'open' }) };
};

const start = async (root = document.body, overrides = {}) => {
  if (overrides.useTranslationFont) enableFontPolicyStyles();
  const onTranslate = vi.fn((text) => settlement(`Translated ${text}`));
  const bridge = new PageTranslationBridge();
  await bridge.initialize(settings(overrides), onTranslate);
  bridge.translate(root);
  return { bridge, onTranslate };
};

const startDeferred = async (root = document.body, overrides = {}) => {
  if (overrides.useTranslationFont) enableFontPolicyStyles();
  const pending = [];
  const onTranslate = vi.fn((text, context, score, node) => new Promise(resolve => {
    pending.push({ text, context, score, node, resolve });
  }));
  const bridge = new PageTranslationBridge();
  await bridge.initialize(settings(overrides), onTranslate);
  bridge.translate(root);
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

describe('PageTranslationBridge persistent ShadowRoot observation', () => {
  const bridges = [];

  afterEach(() => {
    fontComputedStyleSpy?.mockRestore();
    fontComputedStyleSpy = null;
    bridges.forEach(bridge => bridge.cleanup());
    bridges.length = 0;
    document.body.innerHTML = '';
  });

  const track = (bridge) => {
    bridges.push(bridge);
    return bridge;
  };

  it('translates mutations in existing and nested open ShadowRoots', async () => {
    const { shadow } = createHost();
    const initial = document.createElement('span');
    initial.textContent = 'Initial';
    shadow.appendChild(initial);
    const { shadow: nestedShadow } = createHost(shadow);
    const nested = document.createElement('span');
    nested.textContent = 'Nested';
    nestedShadow.appendChild(nested);

    const { bridge, onTranslate } = await start();
    track(bridge);
    await vi.waitFor(() => expect(initial.textContent).toContain('Translated Initial'));
    await vi.waitFor(() => expect(nested.textContent).toContain('Translated Nested'));
    onTranslate.mockClear();

    initial.firstChild.nodeValue = 'Changed';
    nested.firstChild.nodeValue = 'Nested changed';

    await vi.waitFor(() => expect(initial.textContent).toContain('Translated Changed'));
    await vi.waitFor(() => expect(nested.textContent).toContain('Translated Nested changed'));
    expect(onTranslate.mock.calls.map(([text]) => text)).toEqual(
      expect.arrayContaining(['Changed', 'Nested changed'])
    );
  });

  it('routes dynamic configured attributes through existing DOMTranslator state', async () => {
    const { shadow } = createHost();
    const span = document.createElement('span');
    span.textContent = 'Attribute owner';
    shadow.appendChild(span);
    const { bridge, onTranslate } = await start();
    track(bridge);
    await vi.waitFor(() => expect(span.textContent).toContain('Translated Attribute owner'));
    onTranslate.mockClear();

    span.setAttribute('title', 'Dynamic title');

    await vi.waitFor(() => expect(span.title).toContain('Translated Dynamic title'));
    expect(onTranslate.mock.calls.map(([text]) => text)).toContain('Dynamic title');
  });

  it('translates inserted hosts with pre-attached roots once and observes later changes', async () => {
    const { bridge, onTranslate } = await start();
    track(bridge);
    const { shadow } = createHost();
    const first = document.createElement('span');
    first.textContent = 'Inserted';
    shadow.appendChild(first);

    await vi.waitFor(() => expect(first.textContent).toContain('Translated Inserted'));
    expect(onTranslate.mock.calls.filter(([text]) => text === 'Inserted')).toHaveLength(1);

    const later = document.createElement('span');
    later.textContent = 'Later';
    shadow.appendChild(later);
    await vi.waitFor(() => expect(later.textContent).toContain('Translated Later'));
    expect(onTranslate.mock.calls.filter(([text]) => text === 'Later')).toHaveLength(1);
  });

  it('registers nested roots inserted inside an existing ShadowRoot', async () => {
    const { shadow } = createHost();
    const { bridge, onTranslate } = await start();
    track(bridge);
    const { shadow: nestedShadow } = createHost(shadow);
    const first = document.createElement('span');
    first.textContent = 'Dynamic nested';
    nestedShadow.appendChild(first);

    await vi.waitFor(() => expect(first.textContent).toContain('Translated Dynamic nested'));
    expect(onTranslate.mock.calls.filter(([text]) => text === 'Dynamic nested')).toHaveLength(1);

    const later = document.createElement('span');
    later.textContent = 'Nested later';
    nestedShadow.appendChild(later);
    await vi.waitFor(() => expect(later.textContent).toContain('Translated Nested later'));
    expect(onTranslate.mock.calls.filter(([text]) => text === 'Nested later')).toHaveLength(1);
  });

  it('preserves translated state when a Shadow host moves between registered roots', async () => {
    const { shadow: shadowA } = createHost();
    const { shadow: shadowB } = createHost();
    const { host: movingHost, shadow: movingShadow } = createHost(shadowA);
    const existing = document.createElement('span');
    existing.textContent = 'Moved existing';
    movingShadow.appendChild(existing);
    const { bridge, onTranslate } = await start();
    track(bridge);
    await vi.waitFor(() => expect(existing.textContent).toContain('Translated Moved existing'));
    onTranslate.mockClear();

    shadowB.appendChild(movingHost);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(existing.textContent).toContain('Translated Moved existing');
    expect(onTranslate).not.toHaveBeenCalled();

    const later = document.createElement('span');
    later.textContent = 'Moved later';
    movingShadow.appendChild(later);
    await vi.waitFor(() => expect(later.textContent).toContain('Translated Moved later'));
    expect(onTranslate.mock.calls.filter(([text]) => text === 'Moved later')).toHaveLength(1);
  });

  it('preserves translated state when moving a light-DOM host into ShadowRoot', async () => {
    const { shadow: destinationShadow } = createHost();
    const { host: movingHost, shadow: movingShadow } = createHost();
    const existing = document.createElement('span');
    existing.textContent = 'Light to shadow';
    movingShadow.appendChild(existing);
    const { bridge, onTranslate } = await start();
    track(bridge);
    await vi.waitFor(() => expect(existing.textContent).toContain('Translated Light to shadow'));
    onTranslate.mockClear();

    destinationShadow.appendChild(movingHost);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(existing.textContent).toContain('Translated Light to shadow');
    expect(onTranslate).not.toHaveBeenCalled();

    const later = document.createElement('span');
    later.textContent = 'Light to shadow later';
    movingShadow.appendChild(later);
    await vi.waitFor(() => expect(later.textContent).toContain('Translated Light to shadow later'));
  });

  it('preserves translated state when moving a Shadow host into light DOM', async () => {
    const { shadow: sourceShadow } = createHost();
    const destination = document.createElement('section');
    document.body.appendChild(destination);
    const { host: movingHost, shadow: movingShadow } = createHost(sourceShadow);
    const existing = document.createElement('span');
    existing.textContent = 'Shadow to light';
    movingShadow.appendChild(existing);
    const { bridge, onTranslate } = await start();
    track(bridge);
    await vi.waitFor(() => expect(existing.textContent).toContain('Translated Shadow to light'));
    onTranslate.mockClear();

    destination.appendChild(movingHost);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(existing.textContent).toContain('Translated Shadow to light');
    expect(onTranslate).not.toHaveBeenCalled();

    const later = document.createElement('span');
    later.textContent = 'Shadow to light later';
    movingShadow.appendChild(later);
    await vi.waitFor(() => expect(later.textContent).toContain('Translated Shadow to light later'));
  });

  it('restores and unregisters a host moved outside translation ownership', async () => {
    const { shadow, host } = createHost();
    const existing = document.createElement('span');
    existing.textContent = 'Owned before detach';
    shadow.appendChild(existing);
    const { bridge, onTranslate } = await start();
    track(bridge);
    await vi.waitFor(() => expect(existing.textContent).toContain('Translated Owned before detach'));

    host.remove();
    await new Promise(resolve => setTimeout(resolve, 0));
    onTranslate.mockClear();
    const later = document.createElement('span');
    later.textContent = 'After detach';
    shadow.appendChild(later);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(existing.textContent).toBe('Owned before detach');
    expect(onTranslate).not.toHaveBeenCalled();
  });

  it.each(['text', 'title'])('preserves externally edited shadow %s during host retirement', async (kind) => {
    const { shadow, host } = createHost();
    const existing = document.createElement('span');
    existing.textContent = 'Owned before detach';
    existing.setAttribute('title', 'Original title');
    shadow.appendChild(existing);
    const { bridge } = await start();
    track(bridge);
    await vi.waitFor(() => expect(existing.textContent).toContain('Translated Owned before detach'));
    await vi.waitFor(() => expect(existing.getAttribute('title')).toContain('Translated Original title'));

    if (kind === 'title') existing.setAttribute('title', 'Host title edit');
    else existing.firstChild.nodeValue = 'Host text edit';
    host.remove();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(kind === 'title' ? existing.getAttribute('title') : existing.textContent)
      .toBe(kind === 'title' ? 'Host title edit' : 'Host text edit');
  });

  it('rejects late results after a registered host is removed', async () => {
    const { shadow } = createHost();
    const { bridge, pending } = await startDeferred();
    track(bridge);
    const span = document.createElement('span');
    span.textContent = 'Pending';
    shadow.appendChild(span);
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    const stale = vi.fn();

    span.getRootNode().host.remove();
    await Promise.resolve();
    pending[0].resolve(settlement('Translated Pending', stale));

    await Promise.resolve();
    await Promise.resolve();
    expect(span.textContent).toBe('Pending');
    expect(stale).toHaveBeenCalledWith('stale');
  });

  it('applies translation font only after accepted text writes and restores the original inline font', async () => {
    const owner = document.createElement('span');
    owner.style.setProperty('font-family', 'serif');
    owner.textContent = 'Font source';
    document.body.appendChild(owner);
    const { bridge } = await start(document.body, {
      useTranslationFont: true,
      translationFontFamily: 'system-ui',
    });
    track(bridge);

    await vi.waitFor(() => expect(owner.textContent).toContain('Translated Font source'));
    expect(owner.textContent).toContain('\u200e');
    expect(owner.getAttribute('data-page-translated')).toBe('true');
    expect(bridge.session.translationFontFamily).toBe('system-ui');
    expect(getTranslationFontTarget(owner.firstChild)).toBe(owner);
    expect(bridge.session.fontOwnership.size).toBe(1);
    expect(owner.style.fontFamily).toBe('system-ui');

    bridge.restore(document.body);

    expect(owner.style.fontFamily).toBe('serif');
    expect(owner.style.getPropertyPriority('font-family')).toBe('');
    expect(bridge.session).toBeNull();
    bridge.cleanup();
    expect(owner.style.fontFamily).toBe('serif');
    expect(bridge.session).toBeNull();
  });

  it('removes an originally absent inline font on full restore', async () => {
    const owner = document.createElement('span');
    owner.textContent = 'Absent font';
    document.body.appendChild(owner);
    const { bridge } = await start(document.body, {
      useTranslationFont: true,
      translationFontFamily: 'system-ui',
    });
    track(bridge);

    await vi.waitFor(() => expect(owner.textContent).toContain('Translated Absent font'));
    expect(owner.style.fontFamily).toBe('system-ui');

    bridge.restore(document.body);

    expect(owner.style.getPropertyValue('font-family')).toBe('');
    expect(owner.style.getPropertyPriority('font-family')).toBe('');
  });

  it('leaves website font unchanged when Page Translation font is disabled', async () => {
    const owner = document.createElement('span');
    owner.style.fontFamily = 'serif';
    owner.textContent = 'Font disabled';
    document.body.appendChild(owner);
    const { bridge } = await start(document.body);
    track(bridge);

    await vi.waitFor(() => expect(owner.textContent).toContain('Translated Font disabled'));

    expect(owner.style.fontFamily).toBe('serif');
    expect(bridge.session.fontOwnership.size).toBe(0);
  });

  it('skips unsafe mixed parents and translated attributes', async () => {
    const mixed = document.createElement('div');
    mixed.append(document.createTextNode('Mixed source'), document.createElement('strong'));
    const attributeOnly = document.createElement('span');
    attributeOnly.title = 'Attribute source';
    document.body.append(mixed, attributeOnly);
    const { bridge } = await start(document.body, {
      useTranslationFont: true,
      translationFontFamily: 'system-ui',
    });
    track(bridge);

    await vi.waitFor(() => expect(mixed.textContent).toContain('Translated Mixed source'));
    await vi.waitFor(() => expect(attributeOnly.title).toContain('Translated Attribute source'));

    expect(mixed.style.getPropertyValue('font-family')).toBe('');
    expect(attributeOnly.style.getPropertyValue('font-family')).toBe('');
  });

  it('does not apply font for identical translated text', async () => {
    const owner = document.createElement('span');
    owner.textContent = 'Identical source';
    document.body.appendChild(owner);
    const { bridge, pending } = await startDeferred(document.body, {
      useTranslationFont: true,
      translationFontFamily: 'system-ui',
    });
    track(bridge);
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));

    pending.forEach(({ text, resolve }) => resolve(settlement(text)));
    await vi.waitFor(() => expect(owner.textContent).toBe('Identical source'));

    expect(owner.style.getPropertyValue('font-family')).toBe('');
    expect(bridge.session.fontOwnership.size).toBe(0);
  });

  it('keeps translation successful when font style mutation fails', async () => {
    const owner = document.createElement('span');
    owner.textContent = 'Style failure';
    document.body.appendChild(owner);
    const setProperty = vi.spyOn(owner.style, 'setProperty').mockImplementation((property, value, priority) => {
      if (property === 'font-family') throw new Error('font style failure');
      return CSSStyleDeclaration.prototype.setProperty.call(owner.style, property, value, priority);
    });
    const { bridge } = await start(document.body, {
      useTranslationFont: true,
      translationFontFamily: 'system-ui',
    });
    track(bridge);

    await vi.waitFor(() => expect(owner.textContent).toContain('Translated Style failure'));
    setProperty.mockRestore();

    expect(owner.style.getPropertyValue('font-family')).toBe('');
    expect(bridge.session.fontOwnership.size).toBe(0);
  });

  it('preserves external font changes during restore', async () => {
    const owner = document.createElement('span');
    owner.style.fontFamily = 'serif';
    owner.textContent = 'External drift';
    document.body.appendChild(owner);
    const { bridge } = await start(document.body, {
      useTranslationFont: true,
      translationFontFamily: 'system-ui',
    });
    track(bridge);

    await vi.waitFor(() => expect(owner.textContent).toContain('Translated External drift'));
    owner.style.fontFamily = 'site-override';
    bridge.restore(document.body);

    expect(owner.style.fontFamily).toBe('site-override');
  });

  it('restores connected font ownership during cleanup and clears the session', async () => {
    const owner = document.createElement('span');
    owner.style.fontFamily = 'serif';
    owner.textContent = 'Cleanup ownership';
    document.body.appendChild(owner);
    const { bridge } = await start(document.body, {
      useTranslationFont: true,
      translationFontFamily: 'system-ui',
    });
    track(bridge);

    await vi.waitFor(() => expect(owner.textContent).toContain('Translated Cleanup ownership'));
    bridge.cleanup();

    expect(owner.style.fontFamily).toBe('serif');
    expect(bridge.session).toBeNull();
  });

  it('restores detached font ownership during cleanup', async () => {
    const owner = document.createElement('span');
    owner.style.fontFamily = 'serif';
    owner.textContent = 'Detached cleanup';
    document.body.appendChild(owner);
    const { bridge } = await start(document.body, {
      useTranslationFont: true,
      translationFontFamily: 'system-ui',
    });
    track(bridge);

    await vi.waitFor(() => expect(owner.textContent).toContain('Translated Detached cleanup'));
    owner.remove();
    expect(owner.style.fontFamily).toBe('system-ui');
    bridge.cleanup();

    expect(owner.style.fontFamily).toBe('serif');
    expect(bridge.session).toBeNull();
  });

  it('preserves external font drift during cleanup', async () => {
    const owner = document.createElement('span');
    owner.style.fontFamily = 'serif';
    owner.textContent = 'Cleanup drift';
    document.body.appendChild(owner);
    const { bridge } = await start(document.body, {
      useTranslationFont: true,
      translationFontFamily: 'system-ui',
    });
    track(bridge);

    await vi.waitFor(() => expect(owner.textContent).toContain('Translated Cleanup drift'));
    owner.style.fontFamily = 'site-override';
    bridge.cleanup();

    expect(owner.style.fontFamily).toBe('site-override');
    expect(bridge.session).toBeNull();
  });

  it('applies and restores the same owned font for dynamic text updates after persistence stops', async () => {
    const { bridge } = await start(document.body, {
      useTranslationFont: true,
      translationFontFamily: 'system-ui',
    });
    track(bridge);
    const owner = document.createElement('span');
    owner.style.fontFamily = 'serif';
    owner.textContent = 'Dynamic font';
    document.body.appendChild(owner);

    await vi.waitFor(() => expect(owner.textContent).toContain('Translated Dynamic font'));
    const firstOwnershipSize = bridge.session.fontOwnership.size;
    owner.firstChild.nodeValue = 'Dynamic changed';
    await vi.waitFor(() => expect(owner.textContent).toContain('Translated Dynamic changed'));

    expect(owner.style.fontFamily).toBe('system-ui');
    expect(bridge.session.fontOwnership.size).toBe(firstOwnershipSize);
    bridge.stopPersistence();
    expect(owner.style.fontFamily).toBe('system-ui');
    expect(bridge.session.fontOwnership.size).toBe(firstOwnershipSize);
    bridge.restore(document.body);

    expect(owner.style.fontFamily).toBe('serif');
  });

  it('stops future Shadow work while preserving already translated content', async () => {
    const { shadow } = createHost();
    const { bridge, onTranslate } = await start();
    track(bridge);
    const first = document.createElement('span');
    first.textContent = 'First';
    shadow.appendChild(first);
    await vi.waitFor(() => expect(first.textContent).toContain('Translated First'));

    bridge.stopPersistence();
    onTranslate.mockClear();
    const later = document.createElement('span');
    later.textContent = 'Stopped';
    shadow.appendChild(later);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(onTranslate).not.toHaveBeenCalled();
    bridge.restore(document.body);
    expect(first.textContent).toBe('First');
  });

  it('blocks old observer work after session replacement', async () => {
    const { shadow } = createHost();
    const firstCallback = vi.fn(async (text) => `Translated ${text}`);
    const bridge = track(new PageTranslationBridge());
    await bridge.initialize(settings(), firstCallback);
    bridge.translate(document.body);

    const oldText = document.createElement('span');
    oldText.textContent = 'Old session';
    shadow.appendChild(oldText);
    await bridge.initialize(settings(), vi.fn(async (text) => `Translated ${text}`));
    bridge.translate(document.body);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(firstCallback).not.toHaveBeenCalledWith('Old session', expect.anything(), expect.anything(), expect.anything());
  });

  it.each([
    ['.notranslate', (element) => element.classList.add('notranslate'), []],
    ['translate=no', (element) => element.setAttribute('translate', 'no'), []],
    ['configured selector', (element) => element.classList.add('custom-excluded'), ['.custom-excluded']],
  ])('applies dynamic exclusion for %s', async (_name, configure, excludedSelectors) => {
    const { shadow } = createHost();
    const { bridge, onTranslate } = await start(document.body, { excludedSelectors });
    track(bridge);
    const span = document.createElement('span');
    span.textContent = 'Excluded dynamic';
    configure(span);
    shadow.appendChild(span);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(onTranslate).not.toHaveBeenCalled();
    expect(span.textContent).toBe('Excluded dynamic');
  });

  it('preserves dynamic editable and BUTTON value policy', async () => {
    const { shadow } = createHost();
    const { bridge, onTranslate } = await start();
    track(bridge);
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.textContent = 'Editable dynamic';
    const input = document.createElement('input');
    input.value = 'Machine value';
    const button = document.createElement('button');
    button.value = 'machine';
    button.textContent = 'Visible button';
    shadow.append(editor, input, button);

    await vi.waitFor(() => expect(button.textContent).toContain('Translated Visible button'));
    expect(editor.textContent).toBe('Editable dynamic');
    expect(input.value).toBe('Machine value');
    expect(button.value).toBe('machine');
    expect(onTranslate.mock.calls.map(([text]) => text)).toContain('Visible button');
    expect(onTranslate.mock.calls.map(([text]) => text)).not.toContain('Editable dynamic');
    expect(onTranslate.mock.calls.map(([text]) => text)).not.toContain('Machine value');
  });

  it('keeps direct ShadowRoot text unsupported', async () => {
    const { shadow } = createHost();
    const { bridge, onTranslate } = await start();
    track(bridge);
    shadow.appendChild(document.createTextNode('Direct root text'));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(onTranslate).not.toHaveBeenCalled();
  });

  it('does not discover attachShadow on an unchanged connected host', async () => {
    const host = document.createElement('custom-element');
    document.body.appendChild(host);
    const { bridge, onTranslate } = await start();
    track(bridge);
    const shadow = host.attachShadow({ mode: 'open' });
    const span = document.createElement('span');
    span.textContent = 'Late root';
    shadow.appendChild(span);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(onTranslate).not.toHaveBeenCalled();
    expect(span.textContent).toBe('Late root');
  });

  it('disconnects Shadow observers and clears session on cleanup', async () => {
    const { shadow } = createHost();
    const { bridge, onTranslate } = await start();
    const span = document.createElement('span');
    span.textContent = 'Before cleanup';
    shadow.appendChild(span);
    await vi.waitFor(() => expect(span.textContent).toContain('Translated Before cleanup'));
    bridge.cleanup();
    onTranslate.mockClear();

    span.firstChild.nodeValue = 'After cleanup';
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(bridge.session).toBeNull();
    expect(onTranslate).not.toHaveBeenCalled();
  });
});
