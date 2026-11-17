import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTranslationFontTarget, getSelectElementMixedFontTarget, isSelectElementFontTargetSafe } from './TranslationFontPolicy.js';

const nativeGetComputedStyle = window.getComputedStyle.bind(window);
let computedStyleSpy;
let pseudoContentOverrides;
let fontFamilyOverrides;

const setPseudoContent = (element, pseudo, content) => {
  let overrides = pseudoContentOverrides.get(element);
  if (!overrides) {
    overrides = new Map();
    pseudoContentOverrides.set(element, overrides);
  }
  overrides.set(pseudo, content);
};

const setComputedFontFamily = (element, fontFamily) => fontFamilyOverrides.set(element, fontFamily);

describe('getTranslationFontTarget', () => {
  beforeEach(() => {
    pseudoContentOverrides = new WeakMap();
    fontFamilyOverrides = new WeakMap();
    computedStyleSpy = vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
      if (pseudo) {
        return { content: pseudoContentOverrides.get(element)?.get(pseudo) ?? 'none' };
      }
      const computed = nativeGetComputedStyle(element, pseudo);
      return {
        ...computed,
        fontFamily: fontFamilyOverrides.get(element) ?? computed.fontFamily,
      };
    });
  });

  afterEach(() => {
    computedStyleSpy.mockRestore();
    computedStyleSpy = null;
  });

  it('allows a single meaningful direct TextNode', () => {
    const element = document.createElement('span');
    element.textContent = 'source';

    expect(getTranslationFontTarget(element.firstChild)).toBe(element);
  });

  it.each([
    ['code', 'code', null],
    ['pre', 'pre', null],
    ['Font Awesome', 'i', 'fa'],
  ])('keeps shared font targeting unchanged for Select Element-sensitive %s targets', (_label, tag, className) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.append('source');

    expect(getTranslationFontTarget(element.firstChild)).toBe(element);
    expect(isSelectElementFontTargetSafe(element)).toBe(false);
  });

  it('ignores an extra whitespace-only direct TextNode', () => {
    const element = document.createElement('span');
    const text = document.createTextNode('source');
    element.append(text, document.createTextNode('   '));

    expect(getTranslationFontTarget(text)).toBe(element);
  });

  it('allows direct text with independently fonted formatting, icon, and code children', () => {
    const element = document.createElement('span');
    const text = document.createTextNode('source');
    const bold = document.createElement('b');
    bold.append('formatted text');
    const independentFont = document.createElement('i');
    const icon = document.createElement('i');
    const code = document.createElement('code');
    element.style.fontFamily = 'serif';
    bold.style.fontFamily = 'Vazirmatn';
    independentFont.style.fontFamily = 'Vazirmatn';
    icon.style.fontFamily = 'icons';
    code.style.fontFamily = 'monospace';
    setComputedFontFamily(element, 'serif');
    setComputedFontFamily(bold, 'Vazirmatn');
    setComputedFontFamily(independentFont, 'Vazirmatn');
    setComputedFontFamily(icon, 'icons');
    setComputedFontFamily(code, 'monospace');
    element.append(text, bold, independentFont, icon, code);

    expect(getTranslationFontTarget(text)).toBe(element);
  });

  it('rejects meaningful descendant text that would inherit the parent font', () => {
    const element = document.createElement('span');
    const text = document.createTextNode('source');
    const child = document.createElement('span');
    child.textContent = 'untranslated text';
    element.append(text, child);
    setComputedFontFamily(element, 'serif');
    setComputedFontFamily(child, 'serif');

    expect(getTranslationFontTarget(text)).toBeNull();
  });

  it('rejects mixed parents containing detectable open ShadowRoot hosts', () => {
    const element = document.createElement('span');
    const text = document.createTextNode('source');
    const host = document.createElement('span');
    host.attachShadow({ mode: 'open' }).append('untranslated shadow text');
    element.append(text, host);

    expect(getTranslationFontTarget(text)).toBeNull();

    const shadowHost = document.createElement('span');
    shadowHost.append('source');
    shadowHost.attachShadow({ mode: 'open' }).append('untranslated shadow text');
    expect(getTranslationFontTarget(shadowHost.firstChild)).toBeNull();
  });

  it.each(['::before', '::after'])('rejects generated descendant content in %s', pseudo => {
    const element = document.createElement('span');
    const text = document.createTextNode('source');
    const icon = document.createElement('i');
    element.append(text, icon);
    setPseudoContent(icon, pseudo, '"icon"');

    expect(getTranslationFontTarget(text)).toBeNull();
  });

  it.each([
    ['link', () => Object.assign(document.createElement('a'), { href: '#', textContent: 'link' })],
    ['form control', () => document.createElement('input')],
    ['media', () => document.createElement('video')],
    ['interactive control', () => Object.assign(document.createElement('button'), { textContent: 'control' })],
    ['custom element', () => Object.assign(document.createElement('x-widget'), { textContent: 'widget' })],
    ['editable descendant', () => {
      const descendant = document.createElement('span');
      descendant.setAttribute('contenteditable', 'true');
      descendant.textContent = 'edit';
      return descendant;
    }],
    ['interactive role', () => {
      const descendant = document.createElement('span');
      descendant.setAttribute('role', 'link');
      descendant.textContent = 'link';
      return descendant;
    }],
    ['handler descendant', () => {
      const descendant = document.createElement('span');
      descendant.textContent = 'handler';
      descendant.onclick = () => {};
      return descendant;
    }],
    ['tabindex descendant', () => {
      const descendant = document.createElement('span');
      descendant.setAttribute('tabindex', '0');
      descendant.textContent = 'focus';
      return descendant;
    }],
  ])('rejects a mixed parent containing an unsafe %s', (_label, createDescendant) => {
    const element = document.createElement('span');
    const text = document.createTextNode('source');
    element.append(text, createDescendant());

    expect(getTranslationFontTarget(text)).toBeNull();
  });

  it('rejects another meaningful direct TextNode, including technical text', () => {
    const element = document.createElement('span');
    const translated = document.createTextNode('Hello');
    element.append(translated, document.createTextNode('123'));
    const technical = document.createElement('span');
    const technicalText = document.createTextNode('label');
    technical.append(technicalText, document.createTextNode('--data-id--'));

    expect(getTranslationFontTarget(translated)).toBeNull();
    expect(getTranslationFontTarget(technicalText)).toBeNull();
  });

  it('rejects unsafe interactive, form, custom, SVG, and media parents', () => {
    const button = document.createElement('button');
    button.textContent = 'source';
    const link = document.createElement('a');
    link.textContent = 'source';
    const form = document.createElement('form');
    form.textContent = 'source';
    const custom = document.createElement('x-custom');
    custom.textContent = 'source';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.appendChild(document.createTextNode('source'));
    const video = document.createElement('video');
    video.appendChild(document.createTextNode('source'));

    expect(getTranslationFontTarget(button.firstChild)).toBeNull();
    expect(getTranslationFontTarget(link.firstChild)).toBeNull();
    expect(getTranslationFontTarget(form.firstChild)).toBeNull();
    expect(getTranslationFontTarget(custom.firstChild)).toBeNull();
    expect(getTranslationFontTarget(svg.firstChild)).toBeNull();
    expect(getTranslationFontTarget(video.firstChild)).toBeNull();
  });

  it('rejects interactive roles, editable parents, pseudo content, and important font families', () => {
    const roleButton = document.createElement('span');
    roleButton.setAttribute('role', 'button');
    roleButton.textContent = 'source';
    const editable = document.createElement('span');
    editable.setAttribute('contenteditable', 'true');
    editable.textContent = 'source';
    const important = document.createElement('span');
    important.textContent = 'source';
    important.style.setProperty('font-family', 'serif', 'important');
    const pseudo = document.createElement('span');
    pseudo.textContent = 'source';
    setPseudoContent(pseudo, '::before', '"label"');

    expect(getTranslationFontTarget(roleButton.firstChild)).toBeNull();
    expect(getTranslationFontTarget(editable.firstChild)).toBeNull();
    expect(getTranslationFontTarget(important.firstChild)).toBeNull();
    expect(getTranslationFontTarget(pseudo.firstChild)).toBeNull();
  });
});

describe('getSelectElementMixedFontTarget', () => {
  it('permits one direct TextNode with link, quote, and other visual siblings without relaxing shared policy', () => {
    const parent = document.createElement('span');
    const direct = document.createTextNode('source');
    const quote = document.createElement('q');
    quote.textContent = 'quote';
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = 'link';
    parent.append(direct, quote, link, document.createElement('img'));

    expect(getTranslationFontTarget(direct)).toBeNull();
    expect(getSelectElementMixedFontTarget(direct)).toBe(parent);
  });

  it.each(['button', 'a', 'x-widget'])('rejects unsafe mixed parent <%s>', tag => {
    const parent = document.createElement(tag);
    parent.append(document.createTextNode('source'), document.createElement('i'));
    expect(getSelectElementMixedFontTarget(parent.firstChild)).toBeNull();
  });

  it('skips mixed-content CSS targets inside a ShadowRoot', () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const parent = document.createElement('span');
    const text = document.createTextNode('source');
    parent.append(text, document.createElement('a'));
    shadow.append(parent);

    expect(getSelectElementMixedFontTarget(text)).toBeNull();
  });
});
