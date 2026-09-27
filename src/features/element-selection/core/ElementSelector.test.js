import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ElementSelector } from './ElementSelector.js';
import { isSelectableTextRoot } from '../utils/elementHelpers.js';

// Mock dependencies
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

vi.mock('../utils/elementHelpers.js', () => ({
  isSelectableTextRoot: vi.fn(() => true)
}));

describe('ElementSelector', () => {
  let selector;

  beforeEach(() => {
    vi.clearAllMocks();
    isSelectableTextRoot.mockReturnValue(true);
    selector = new ElementSelector();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    selector.cleanup();
  });

  it('should be instantiable with default config', () => {
    expect(selector).toBeDefined();
    expect(selector.isActive).toBe(false);
    const config = selector.getConfig();
    expect(config.minArea).toBe(4000);
    expect(config.minTextLength).toBe(20);
  });

  it('should activate and deactivate correctly', () => {
    selector.activate();
    expect(selector.isActive).toBe(true);
    
    selector.deactivate();
    expect(selector.isActive).toBe(false);
  });

  describe('isOurElement', () => {
    it('should identify UI Host as our element', () => {
      const el = document.createElement('div');
      el.id = 'translate-it-ui-host';
      expect(selector.isOurElement(el)).toBe(true);
    });

    it('should identify toast/notification classes', () => {
      const el = document.createElement('div');
      el.classList.add('sonner-toast');
      expect(selector.isOurElement(el)).toBe(true);
    });

    it('should identify elements inside UI host', () => {
      const host = document.createElement('div');
      host.id = 'translate-it-ui-host';
      const child = document.createElement('span');
      host.appendChild(child);
      document.body.appendChild(host);

      expect(selector.isOurElement(child)).toBe(true);
    });

    it('should not mark highlighted element as our element', () => {
      const el = document.createElement('div');
      el.id = 'translate-it-some-id';
      el.classList.add('translate-it-element-highlighted');
      expect(selector.isOurElement(el)).toBe(false);
    });
  });

  describe('findBestTextElement', () => {
    it('should find element that satisfies area and text requirements', () => {
      const container = document.createElement('div');
      container.style.width = '200px';
      container.style.height = '100px';
      container.textContent = 'This is a long enough text to satisfy the word count and length requirements.';
      
      // JSDOM mock for offsetWidth/Height
      Object.defineProperty(container, 'offsetWidth', { value: 200 });
      Object.defineProperty(container, 'offsetHeight', { value: 100 });
      
      const result = selector.findBestTextElement(container);
      expect(result).toBe(container);
    });

    it('should walk up to find a better block parent', () => {
      const parent = document.createElement('div');
      Object.defineProperty(parent, 'offsetWidth', { value: 200 });
      Object.defineProperty(parent, 'offsetHeight', { value: 100 });
      parent.textContent = 'This is a long enough text to satisfy the requirements.';

      const child = document.createElement('span');
      child.textContent = 'Small text';
      Object.defineProperty(child, 'offsetWidth', { value: 50 });
      Object.defineProperty(child, 'offsetHeight', { value: 20 });
      
      parent.appendChild(child);
      document.body.appendChild(parent);

      const result = selector.findBestTextElement(child);
      expect(result).toBe(parent);
    });

    it('keeps nested inline descendants on their paragraph and switches to a sibling paragraph', () => {
      selector.activate();
      const wrapper = document.createElement('div');
      Object.defineProperties(wrapper, {
        offsetWidth: { value: 500 },
        offsetHeight: { value: 400 },
      });
      const firstParagraph = document.createElement('p');
      firstParagraph.textContent = 'First paragraph has enough meaningful text for selection.';
      Object.defineProperties(firstParagraph, {
        offsetWidth: { value: 200 },
        offsetHeight: { value: 60 },
      });
      const firstInline = document.createElement('span');
      firstInline.textContent = 'First paragraph';
      const nestedInline = document.createElement('a');
      nestedInline.textContent = ' nested link';
      firstInline.appendChild(nestedInline);
      firstParagraph.appendChild(firstInline);

      const secondParagraph = document.createElement('p');
      secondParagraph.textContent = 'Second paragraph also has enough text for selection.';
      Object.defineProperties(secondParagraph, {
        offsetWidth: { value: 200 },
        offsetHeight: { value: 60 },
      });
      const secondInline = document.createElement('span');
      secondInline.textContent = 'Second paragraph';
      secondParagraph.appendChild(secondInline);
      wrapper.append(firstParagraph, secondParagraph);
      document.body.appendChild(wrapper);

      selector.handleMouseOver(firstInline);
      expect(selector.getHighlightedElement()).toBe(firstParagraph);
      selector.handleMouseOver(nestedInline);
      expect(selector.getHighlightedElement()).toBe(firstParagraph);
      selector.handleMouseOver(secondInline);
      expect(selector.getHighlightedElement()).toBe(secondParagraph);
    });
  });

  describe('highlighting', () => {
    it('should highlight valid element on mouseover', () => {
      selector.activate();
      const el = document.createElement('div');
      el.textContent = 'Valid text for highlighting purposes that meets the length.';
      Object.defineProperty(el, 'offsetWidth', { value: 200 });
      Object.defineProperty(el, 'offsetHeight', { value: 100 });
      
      selector.handleMouseOver(el);
      
      expect(el.classList.contains('translate-it-element-highlighted')).toBe(true);
      expect(el.getAttribute('data-translate-highlighted')).toBe('true');
      expect(selector.getHighlightedElement()).toBe(el);
    });

    it('should clear highlight on mouseout after timeout', () => {
      vi.useFakeTimers();
      selector.activate();
      const el = document.createElement('div');
      el.classList.add('translate-it-element-highlighted');
      selector.currentHighlighted = el;

      selector.handleMouseOut();
      
      vi.advanceTimersByTime(50);
      expect(selector.currentHighlighted).toBe(el); // Still there

      vi.advanceTimersByTime(60); // Total 110ms > default 100ms
      expect(selector.currentHighlighted).toBeNull();
      expect(el.classList.contains('translate-it-element-highlighted')).toBe(false);
      
      vi.useRealTimers();
    });

    it('should clear previous highlight when moving to new element', () => {
      selector.activate();
      const el1 = document.createElement('div');
      el1.textContent = 'First element text content that is long enough.';
      Object.defineProperty(el1, 'offsetWidth', { value: 200 });
      Object.defineProperty(el1, 'offsetHeight', { value: 100 });
      
      const el2 = document.createElement('div');
      el2.textContent = 'Second element text content that is long enough.';
      Object.defineProperty(el2, 'offsetWidth', { value: 200 });
      Object.defineProperty(el2, 'offsetHeight', { value: 100 });

      selector.handleMouseOver(el1);
      expect(el1.classList.contains('translate-it-element-highlighted')).toBe(true);

      selector.handleMouseOver(el2);
      expect(el1.classList.contains('translate-it-element-highlighted')).toBe(false);
      expect(el2.classList.contains('translate-it-element-highlighted')).toBe(true);
    });
  });

  describe('root eligibility via isSelectableTextRoot', () => {
    it('does not highlight an element rejected by root eligibility', () => {
      selector.activate();
      isSelectableTextRoot.mockReturnValue(false);
      const el = document.createElement('div');
      el.textContent = 'Valid text for highlighting purposes that meets the length.';
      Object.defineProperty(el, 'offsetWidth', { value: 200 });
      Object.defineProperty(el, 'offsetHeight', { value: 100 });

      selector.handleMouseOver(el);

      expect(el.classList.contains('translate-it-element-highlighted')).toBe(false);
      expect(selector.getHighlightedElement()).toBeNull();
    });

    it('falls back to a small standalone selectable block below the strong text threshold', () => {
      selector.activate();
      isSelectableTextRoot.mockReturnValue(true); // Root says eligible
      const el = document.createElement('div');
      el.textContent = 'Too short'; // Below minTextLength (20)
      Object.defineProperty(el, 'offsetWidth', { value: 200 });
      Object.defineProperty(el, 'offsetHeight', { value: 100 });

      selector.handleMouseOver(el);

      expect(selector.getHighlightedElement()).toBe(el);
    });

    it('prefers a meaningful block parent to a tiny inline descendant', () => {
      selector.activate();
      const parent = document.createElement('div');
      parent.textContent = 'A meaningful block containing a short phrase.';
      Object.defineProperty(parent, 'offsetWidth', { value: 100 });
      Object.defineProperty(parent, 'offsetHeight', { value: 30 });
      const inline = document.createElement('span');
      inline.textContent = 'short phrase';
      Object.defineProperty(inline, 'offsetWidth', { value: 10 });
      Object.defineProperty(inline, 'offsetHeight', { value: 10 });
      parent.appendChild(inline);
      document.body.appendChild(parent);

      expect(selector.findBestTextElement(inline)).toBe(parent);
    });

    it('does not let a delayed mouseout clear a highlighted subtree after re-entry', () => {
      vi.useFakeTimers();
      selector.activate();
      const el = document.createElement('div');
      el.textContent = 'Valid text for highlighting purposes that meets the length.';
      Object.defineProperty(el, 'offsetWidth', { value: 200 });
      Object.defineProperty(el, 'offsetHeight', { value: 100 });
      const child = document.createElement('span');
      el.appendChild(child);
      document.body.appendChild(el);

      selector.handleMouseOver(el);
      selector.handleMouseOut();
      selector.handleMouseOver(child);
      vi.advanceTimersByTime(150);

      expect(selector.getHighlightedElement()).toBe(el);
      vi.useRealTimers();
    });

    it('cancels a pending clear when mouseout transitions into the highlighted subtree', () => {
      vi.useFakeTimers();
      selector.activate();
      const root = document.createElement('div');
      const child = document.createElement('span');
      root.appendChild(child);
      selector.currentHighlighted = root;
      root.classList.add(selector.HIGHLIGHT_CLASS);

      selector.handleMouseOut();
      selector.handleMouseOut(child);
      vi.advanceTimersByTime(150);

      expect(selector.getHighlightedElement()).toBe(root);
      expect(selector.highlightTimeout).toBeNull();
      vi.useRealTimers();
    });

    it('clears after mouseout with no related target without consulting stale coordinates', () => {
      vi.useFakeTimers();
      selector.activate();
      const root = document.createElement('div');
      selector.currentHighlighted = root;
      document.elementFromPoint = vi.fn();

      selector.handleMouseOut(null);
      vi.advanceTimersByTime(selector.config.highlightTimeout);

      expect(document.elementFromPoint).not.toHaveBeenCalled();
      expect(selector.getHighlightedElement()).toBeNull();
      vi.useRealTimers();
    });

    it('clears a pending timeout when deactivated', () => {
      vi.useFakeTimers();
      selector.activate();
      const root = document.createElement('div');
      selector.currentHighlighted = root;
      selector.handleMouseOut();

      selector.deactivate();
      vi.advanceTimersByTime(selector.config.highlightTimeout);

      expect(selector.highlightTimeout).toBeNull();
      expect(selector.getHighlightedElement()).toBeNull();
      vi.useRealTimers();
    });
  });

  it('should update config correctly', () => {
    selector.updateConfig({ minArea: 500 });
    expect(selector.getConfig().minArea).toBe(500);
  });
});
