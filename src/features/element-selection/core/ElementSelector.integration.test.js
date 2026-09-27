import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ElementSelector } from './ElementSelector.js';

// Real elementHelpers + SelectElementPolicy (no mock) to prove the selector
// honors the shared root-eligibility contract end to end.

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

vi.mock('@/shared/constants/ui.js', () => ({
  UI_HOST_IDS: {
    MAIN: 'translate-it-ui-host',
    IFRAME: 'translate-it-iframe-host'
  }
}));

const LONG_TEXT = 'This is a long enough text to satisfy the word count and length requirements.';

function sizedTextElement(tagName, text, width = 200, height = 100) {
  const el = document.createElement(tagName);
  el.textContent = text;
  Object.defineProperty(el, 'offsetWidth', { value: width });
  Object.defineProperty(el, 'offsetHeight', { value: height });
  document.body.appendChild(el);
  return el;
}

describe('ElementSelector with real SelectElementPolicy', () => {
  let selector;

  beforeEach(() => {
    selector = new ElementSelector();
    selector.activate();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    selector.cleanup();
    document.body.innerHTML = '';
  });

  it('highlights a normal DIV root', () => {
    const el = sizedTextElement('div', LONG_TEXT);
    selector.handleMouseOver(el);
    expect(selector.getHighlightedElement()).toBe(el);
  });

  it('keeps BUTTON highlightable', () => {
    const el = sizedTextElement('button', LONG_TEXT);
    selector.handleMouseOver(el);
    expect(selector.getHighlightedElement()).toBe(el);
  });

  it.each(['select', 'option'])('rejects %s as a root (no highlight)', (tag) => {
    const el = sizedTextElement(tag, LONG_TEXT);
    selector.handleMouseOver(el);
    expect(selector.getHighlightedElement()).toBeNull();
  });

  it.each(['kbd', 'samp'])('rejects %s root', (tag) => {
    const el = sizedTextElement(tag, LONG_TEXT);
    selector.handleMouseOver(el);
    expect(selector.getHighlightedElement()).toBeNull();
  });

  it('rejects an element under a notranslate ancestor', () => {
    const parent = document.createElement('div');
    parent.className = 'notranslate';
    const child = document.createElement('span');
    child.textContent = LONG_TEXT;
    parent.appendChild(child);
    document.body.appendChild(parent);

    selector.handleMouseOver(child);
    expect(selector.getHighlightedElement()).toBeNull();
  });

  it('rejects a hidden (display:none) root', () => {
    const el = sizedTextElement('div', LONG_TEXT);
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      display: 'none',
      visibility: 'visible',
      opacity: '1',
    });
    selector.handleMouseOver(el);
    expect(selector.getHighlightedElement()).toBeNull();
    vi.restoreAllMocks();
  });

  it('rejects an opacity:0 root', () => {
    const el = sizedTextElement('div', LONG_TEXT);
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      display: 'block',
      visibility: 'visible',
      opacity: '0',
    });
    selector.handleMouseOver(el);
    expect(selector.getHighlightedElement()).toBeNull();
    vi.restoreAllMocks();
  });

  it('allows a meaningful standalone block below the strong text threshold', () => {
    const el = sizedTextElement('div', 'Too short'); // Below minTextLength (20)
    selector.handleMouseOver(el);
    expect(selector.getHighlightedElement()).toBe(el);
  });

  it.each(['span', 'a'])('highlights a standalone eligible inline %s root', tag => {
    const el = sizedTextElement(tag, LONG_TEXT, 0, 0);
    selector.handleMouseOver(el);
    expect(selector.getHighlightedElement()).toBe(el);
  });

  it.each([
    ['zero-sized', 0, 0],
    ['oversized', 400, 400],
  ])('falls back to an eligible standalone block with %s dimensions', (_label, width, height) => {
    const el = sizedTextElement('div', LONG_TEXT, width, height);
    selector.handleMouseOver(el);
    expect(selector.getHighlightedElement()).toBe(el);
  });

  it('walks up to a parent that satisfies area/text heuristics', () => {
    const parent = document.createElement('div');
    parent.textContent = LONG_TEXT;
    Object.defineProperty(parent, 'offsetWidth', { value: 200 });
    Object.defineProperty(parent, 'offsetHeight', { value: 100 });

    const child = document.createElement('span');
    child.textContent = 'Small';
    Object.defineProperty(child, 'offsetWidth', { value: 20 });
    Object.defineProperty(child, 'offsetHeight', { value: 10 });

    parent.appendChild(child);
    document.body.appendChild(parent);

    selector.handleMouseOver(child);
    expect(selector.getHighlightedElement()).toBe(parent);
  });
});
