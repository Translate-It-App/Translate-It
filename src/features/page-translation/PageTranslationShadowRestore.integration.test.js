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

import { PageTranslationBridge } from './PageTranslationBridge.js';
import { PAGE_TRANSLATION_ATTRIBUTES } from './PageTranslationConstants.js';
import { PageTranslationHelper } from './PageTranslationHelper.js';

const settings = {
  targetLanguage: 'fa',
  lazyLoading: false,
  showOriginalOnHover: true,
  autoTranslateOnDOMChanges: false,
  excludedSelectors: [],
  attributesToTranslate: ['title'],
};

const settlement = (text) => ({
  __pageTranslationSettlement: true,
  text,
  state: 'pending',
  settle: vi.fn(),
});

const translate = async (root, sourceText = 'Hello') => {
  const pending = [];
  const onTranslate = vi.fn((text, context, score, node) => new Promise(resolve => {
    pending.push({ text, node, resolve });
    // Sliced discovery issues provider requests across slices, so every
    // request is settled as soon as it arrives.
    resolve(settlement(text === sourceText ? 'سلام' : 'عنوان'));
  }));
  const bridge = new PageTranslationBridge();
  await bridge.initialize(settings, onTranslate);
  bridge.translate(root);
  await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
  return { bridge, onTranslate };
};

describe('PageTranslationBridge Shadow DOM restore symmetry', () => {
  const bridges = [];

  afterEach(() => {
    bridges.forEach(bridge => bridge.cleanup());
    bridges.length = 0;
    document.body.innerHTML = '';
  });

  const track = (bridge) => {
    bridges.push(bridge);
    return bridge;
  };

  const createNestedText = () => {
    const outerHost = document.createElement('custom-element');
    document.body.appendChild(outerHost);
    const outerShadow = outerHost.attachShadow({ mode: 'open' });
    const nestedHost = document.createElement('nested-element');
    outerShadow.appendChild(nestedHost);
    const nestedShadow = nestedHost.attachShadow({ mode: 'open' });
    const span = document.createElement('span');
    span.title = 'Original title';
    span.textContent = 'Hello';
    nestedShadow.appendChild(span);
    return span;
  };

  it('restores nested Shadow text, attributes, direction, and markers', async () => {
    const span = createNestedText();
    const { bridge: translatedBridge } = await translate(document.body);
    const bridge = track(translatedBridge);

    await vi.waitFor(() => expect(span.textContent).toContain('سلام'));
    expect(span.style.direction).toBe('rtl');
    expect(span.style.unicodeBidi).toBe('isolate');
    expect(span.hasAttribute('data-dir-original-saved')).toBe(true);
    expect(span.getAttribute(PAGE_TRANSLATION_ATTRIBUTES.TRANSLATED_MARKER)).toBe('true');
    expect(span.getAttribute(PAGE_TRANSLATION_ATTRIBUTES.HAS_ORIGINAL)).toBe('true');
    expect(span.title).toContain('عنوان');

    bridge.restore(document.documentElement);

    expect(span.textContent).toBe('Hello');
    expect(span.title).toBe('Original title');
    expect(span.style.direction).toBe('');
    expect(span.style.unicodeBidi).toBe('');
    expect(span.style.maxWidth).toBe('');
    expect(span.hasAttribute('data-dir-original-saved')).toBe(false);
    expect(span.hasAttribute(PAGE_TRANSLATION_ATTRIBUTES.TRANSLATED_MARKER)).toBe(false);
    expect(span.hasAttribute(PAGE_TRANSLATION_ATTRIBUTES.HAS_ORIGINAL)).toBe(false);
    expect(span.hasAttribute(PAGE_TRANSLATION_ATTRIBUTES.TRANSLATE_DIR)).toBe(false);
  });

  it('supports repeated translate and restore cycles in nested ShadowRoots', async () => {
    const span = createNestedText();
    const { bridge: firstBridge } = await translate(document.body);
    const first = track(firstBridge);
    await vi.waitFor(() => expect(span.textContent).toContain('سلام'));
    first.restore(document.documentElement);
    expect(span.textContent).toBe('Hello');

    const { bridge: secondBridge } = await translate(document.body);
    const second = track(secondBridge);
    await vi.waitFor(() => expect(span.textContent).toContain('سلام'));
    second.restore(document.documentElement);

    expect(span.textContent).toBe('Hello');
    expect(span.title).toBe('Original title');
    expect(span.hasAttribute('data-dir-original-saved')).toBe(false);
    expect(span.hasAttribute(PAGE_TRANSLATION_ATTRIBUTES.TRANSLATED_MARKER)).toBe(false);
  });

  it('deep-cleans Page markers inside nested open ShadowRoots', () => {
    const span = createNestedText();
    span.setAttribute(PAGE_TRANSLATION_ATTRIBUTES.TRANSLATED_MARKER, 'true');
    span.setAttribute(PAGE_TRANSLATION_ATTRIBUTES.HAS_ORIGINAL, 'true');
    span.setAttribute(PAGE_TRANSLATION_ATTRIBUTES.TRANSLATE_DIR, 'rtl');

    PageTranslationHelper.deepCleanDOM();

    expect(span.hasAttribute(PAGE_TRANSLATION_ATTRIBUTES.TRANSLATED_MARKER)).toBe(false);
    expect(span.hasAttribute(PAGE_TRANSLATION_ATTRIBUTES.HAS_ORIGINAL)).toBe(false);
    expect(span.hasAttribute(PAGE_TRANSLATION_ATTRIBUTES.TRANSLATE_DIR)).toBe(false);
  });

  it('does not clean unrelated ShadowRoots outside session root', async () => {
    const ownedSpan = createNestedText();
    const unrelatedHost = document.createElement('unrelated-element');
    document.documentElement.appendChild(unrelatedHost);
    const unrelatedShadow = unrelatedHost.attachShadow({ mode: 'open' });
    const unrelatedSpan = document.createElement('span');
    unrelatedSpan.style.direction = 'rtl';
    unrelatedSpan.style.unicodeBidi = 'isolate';
    unrelatedSpan.setAttribute('data-dir-original-saved', 'true');
    unrelatedSpan.setAttribute('data-original-direction', 'ltr');
    unrelatedSpan.setAttribute(PAGE_TRANSLATION_ATTRIBUTES.TRANSLATE_DIR, 'rtl');
    unrelatedSpan.setAttribute(PAGE_TRANSLATION_ATTRIBUTES.TRANSLATED_MARKER, 'true');
    unrelatedShadow.appendChild(unrelatedSpan);

    const { bridge: translatedBridge } = await translate(document.body);
    const bridge = track(translatedBridge);
    await vi.waitFor(() => expect(ownedSpan.textContent).toContain('سلام'));

    bridge.restore(document.documentElement);
    PageTranslationHelper.deepCleanDOM(document.body);

    expect(unrelatedSpan.style.direction).toBe('rtl');
    expect(unrelatedSpan.style.unicodeBidi).toBe('isolate');
    expect(unrelatedSpan.hasAttribute('data-dir-original-saved')).toBe(true);
    expect(unrelatedSpan.hasAttribute(PAGE_TRANSLATION_ATTRIBUTES.TRANSLATED_MARKER)).toBe(true);
    expect(unrelatedSpan.hasAttribute(PAGE_TRANSLATION_ATTRIBUTES.TRANSLATE_DIR)).toBe(true);
  });
});
