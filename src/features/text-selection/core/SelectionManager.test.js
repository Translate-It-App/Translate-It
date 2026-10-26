import { afterEach, describe, expect, it, vi } from 'vitest';
import { SelectionManager } from './SelectionManager.js';
import { UI_HOST_IDS } from '@/shared/constants/ui.js';
import { ExtensionContextManager } from '@/core/extensionContext.js';
import { pageEventBus } from '@/core/PageEventBus.js';
import { SELECTION_EVENTS } from '@/features/text-selection/events/SelectionEvents.js';
import settingsManager from '@/shared/managers/SettingsManager.js';

const rect = (left, bottom, width, height) => ({ left, bottom, width, height });

describe('SelectionManager selection geometry', () => {
  const manager = new SelectionManager();
  afterEach(() => vi.restoreAllMocks());

  it('preserves valid getRangeAt geometry and top-frame scroll offsets', () => {
    vi.spyOn(window, 'scrollX', 'get').mockReturnValue(7);
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(11);
    const selection = {
      rangeCount: 1,
      getRangeAt: () => ({ getBoundingClientRect: () => rect(20, 40, 10, 5) }),
      toString: () => 'selected'
    };

    expect(manager.calculateSelectionPosition(selection)).toEqual({ x: 20, y: 54, _isViewportRelative: false });
  });

  it('uses a noncollapsed composed StaticRange when the ordinary range is collapsed', () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const text = document.createTextNode('selected');
    root.append(text);
    const staticRange = { startContainer: text, startOffset: 0, endContainer: text, endOffset: 8, collapsed: false };
    const composedSpy = vi.fn(({ shadowRoots }) => {
      expect(shadowRoots).toContain(root);
      return [staticRange];
    });
    const selection = {
      rangeCount: 1,
      anchorNode: text,
      anchorOffset: 0,
      focusNode: text,
      focusOffset: 8,
      getRangeAt: () => ({ getBoundingClientRect: () => rect(0, 0, 0, 0) }),
      getComposedRanges: composedSpy,
      toString: () => 'selected'
    };
    const createRange = vi.spyOn(document, 'createRange').mockImplementation(() => ({
      setStart: vi.fn(),
      setEnd: vi.fn(),
      toString: () => 'selected',
      getBoundingClientRect: () => rect(30, 50, 20, 8)
    }));

    expect(manager.calculateSelectionPosition(selection)).toEqual({ x: 28, y: 53, _isViewportRelative: false });
    expect(composedSpy).toHaveBeenCalledOnce();
    expect(createRange).toHaveBeenCalledOnce();
    expect(selection.getRangeAt(0).collapsed).toBeUndefined();
  });

  it('skips descendant discovery when a directly supplied root provides usable geometry', () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const text = document.createTextNode('selected');
    root.append(text);
    const range = { startContainer: text, startOffset: 0, endContainer: text, endOffset: 8, collapsed: false };
    const selection = {
      rangeCount: 1, anchorNode: text, anchorOffset: 0, focusNode: text, focusOffset: 8,
      getRangeAt: () => ({ getBoundingClientRect: () => rect(0, 0, 0, 0) }),
      getComposedRanges: vi.fn(({ shadowRoots }) => shadowRoots.includes(root) ? [range] : []),
      toString: () => 'selected'
    };
    vi.spyOn(document, 'createRange').mockImplementation(() => ({
      setStart: vi.fn(), setEnd: vi.fn(), toString: () => 'selected',
      getBoundingClientRect: () => rect(30, 50, 20, 8)
    }));
    const discoverDescendants = vi.spyOn(manager, 'getDescendantSelectionShadowRoots');

    expect(manager.calculateSelectionPosition(selection)).toEqual({ x: 28, y: 53, _isViewportRelative: false });
    expect(selection.getComposedRanges).toHaveBeenCalledOnce();
    expect(discoverDescendants).not.toHaveBeenCalled();
  });

  it('accepts matching same-root element boundaries without descendant discovery', () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const caption = document.createElement('section');
    const paragraph = document.createElement('p');
    paragraph.textContent = 'whole caption';
    caption.append(paragraph);
    root.append(caption);

    const nativeRange = document.createRange();
    nativeRange.selectNodeContents(caption);
    const composedRange = {
      startContainer: nativeRange.startContainer,
      startOffset: nativeRange.startOffset,
      endContainer: nativeRange.endContainer,
      endOffset: nativeRange.endOffset,
      collapsed: nativeRange.collapsed
    };
    const selection = {
      rangeCount: 1,
      anchorNode: caption,
      anchorOffset: nativeRange.startOffset,
      focusNode: caption,
      focusOffset: nativeRange.endOffset,
      getRangeAt: () => ({ getBoundingClientRect: () => rect(0, 0, 0, 0) }),
      getComposedRanges: vi.fn(({ shadowRoots }) => {
        expect(shadowRoots).toContain(root);
        return [composedRange];
      }),
      toString: () => 'whole caption'
    };
    const measure = vi.fn(() => rect(30, 50, 20, 8));
    vi.spyOn(document, 'createRange').mockImplementation(() => ({
      setStart: vi.fn(),
      setEnd: vi.fn(),
      getBoundingClientRect: measure
    }));
    const discoverDescendants = vi.spyOn(manager, 'getDescendantSelectionShadowRoots');

    expect(manager.calculateSelectionPosition(selection)).toEqual({ x: 28, y: 53, _isViewportRelative: false });
    expect(selection.getComposedRanges).toHaveBeenCalledOnce();
    expect(measure).toHaveBeenCalledOnce();
    expect(discoverDescendants).not.toHaveBeenCalled();
  });

  it('accepts a whole-caption range with endpoints retargeted outside its ShadowRoot', () => {
    const host = document.createElement('div');
    host.tabIndex = 0;
    document.body.append(host);
    host.focus();
    const root = host.attachShadow({ mode: 'open' });
    const caption = document.createElement('section');
    const paragraph = document.createElement('p');
    paragraph.textContent = 'whole caption';
    caption.append(paragraph);
    root.append(caption);

    const nativeRange = document.createRange();
    nativeRange.selectNodeContents(caption);
    const composedRange = {
      startContainer: nativeRange.startContainer,
      startOffset: nativeRange.startOffset,
      endContainer: nativeRange.endContainer,
      endOffset: nativeRange.endOffset,
      collapsed: nativeRange.collapsed
    };
    const selection = {
      rangeCount: 1,
      anchorNode: host,
      anchorOffset: 0,
      focusNode: host,
      focusOffset: 1,
      getRangeAt: () => ({ getBoundingClientRect: () => rect(0, 0, 0, 0) }),
      getComposedRanges: vi.fn(() => [composedRange]),
      toString: () => 'whole caption'
    };
    const measure = vi.fn(() => rect(30, 50, 20, 8));
    const createRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = createRange();
      range.getBoundingClientRect = measure;
      return range;
    });
    const discoverDescendants = vi.spyOn(manager, 'getDescendantSelectionShadowRoots');

    try {
      expect(document.activeElement).toBe(host);
      expect(manager.calculateSelectionPosition(selection)).toEqual({ x: 28, y: 53, _isViewportRelative: false });
      expect(measure).toHaveBeenCalledOnce();
      expect(discoverDescendants).toHaveBeenCalledOnce();
      expect(selection.getComposedRanges).toHaveBeenCalledTimes(2);
    } finally {
      host.remove();
    }
  });

  it('retries when a supplied outer root yields a range around a nested ShadowRoot host', () => {
    const outerHost = document.createElement('div');
    outerHost.tabIndex = 0;
    document.body.append(outerHost);
    outerHost.focus();
    const outerRoot = outerHost.attachShadow({ mode: 'open' });
    const innerHost = document.createElement('gallery-caption');
    const innerRoot = innerHost.attachShadow({ mode: 'open' });
    const selectedText = document.createTextNode('selected');
    innerRoot.append(selectedText);

    const container = document.createElement('div');
    container.append(innerHost);
    outerRoot.append(container);

    const nativeHostRange = document.createRange();
    nativeHostRange.selectNodeContents(container);
    const hostRange = {
      startContainer: nativeHostRange.startContainer,
      startOffset: nativeHostRange.startOffset,
      endContainer: nativeHostRange.endContainer,
      endOffset: nativeHostRange.endOffset,
      collapsed: nativeHostRange.collapsed
    };
    const innerRange = { startContainer: selectedText, startOffset: 0, endContainer: selectedText, endOffset: 8, collapsed: false };
    const selection = {
      rangeCount: 1, anchorNode: outerHost, anchorOffset: 0, focusNode: outerHost, focusOffset: 1,
      getRangeAt: () => ({ getBoundingClientRect: () => rect(0, 0, 0, 0) }),
      getComposedRanges: vi.fn(({ shadowRoots }) => [shadowRoots.includes(innerRoot) ? innerRange : hostRange]),
      toString: () => 'selected'
    };
    const createRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = createRange();
      range.getBoundingClientRect = () => range.startContainer === container
        ? rect(1, 20, 200, 80)
        : rect(30, 50, 20, 8);
      return range;
    });

    try {
      expect(document.activeElement).toBe(outerHost);
      expect(manager.calculateSelectionPosition(selection)).toEqual({ x: 28, y: 53, _isViewportRelative: false });
      expect(selection.getComposedRanges).toHaveBeenNthCalledWith(1, { shadowRoots: [outerRoot] });
      expect(selection.getComposedRanges).toHaveBeenNthCalledWith(2, { shadowRoots: [outerRoot, innerRoot] });
    } finally {
      outerHost.remove();
    }
  });

  it('accepts a matching mixed-content range around a nested ShadowRoot after descendant discovery', () => {
    const outerHost = document.createElement('div');
    outerHost.tabIndex = 0;
    document.body.append(outerHost);
    outerHost.focus();
    const outerRoot = outerHost.attachShadow({ mode: 'open' });
    const innerHost = document.createElement('gallery-caption');
    const innerRoot = innerHost.attachShadow({ mode: 'open' });
    innerRoot.append(document.createTextNode('nested text'));
    const container = document.createElement('div');
    container.append(document.createTextNode('before'), innerHost, document.createTextNode('after'));
    outerRoot.append(container);

    const nativeRange = document.createRange();
    nativeRange.selectNodeContents(container);
    const asStaticRange = () => ({
      startContainer: nativeRange.startContainer,
      startOffset: nativeRange.startOffset,
      endContainer: nativeRange.endContainer,
      endOffset: nativeRange.endOffset,
      collapsed: nativeRange.collapsed
    });
    const hostFallback = asStaticRange();
    const matchingRange = asStaticRange();
    const selection = {
      rangeCount: 1,
      anchorNode: container,
      anchorOffset: nativeRange.startOffset,
      focusNode: container,
      focusOffset: nativeRange.endOffset,
      getRangeAt: () => ({ getBoundingClientRect: () => rect(0, 0, 0, 0) }),
      getComposedRanges: vi.fn(({ shadowRoots }) => [shadowRoots.includes(innerRoot) ? matchingRange : hostFallback]),
      toString: () => 'before nested text after'
    };
    const createRangeFromStaticRange = manager.createRangeFromStaticRange.bind(manager);
    vi.spyOn(manager, 'createRangeFromStaticRange').mockImplementation((staticRange) => {
      const range = createRangeFromStaticRange(staticRange);
      range.getBoundingClientRect = () => rect(30, 50, 20, 8);
      return range;
    });

    try {
      expect(document.activeElement).toBe(outerHost);
      expect(manager.calculateSelectionPosition(selection)).toEqual({ x: 28, y: 53, _isViewportRelative: false });
      expect(selection.getComposedRanges).toHaveBeenNthCalledWith(1, { shadowRoots: [outerRoot] });
      expect(selection.getComposedRanges).toHaveBeenNthCalledWith(2, { shadowRoots: [outerRoot, innerRoot] });
    } finally {
      outerHost.remove();
    }
  });

  it('rejects a nested-host-only range despite unselected light-DOM text outside its boundaries', () => {
    const outerHost = document.createElement('div');
    outerHost.tabIndex = 0;
    document.body.append(outerHost);
    outerHost.focus();
    const outerRoot = outerHost.attachShadow({ mode: 'open' });
    const innerHost = document.createElement('gallery-caption');
    const innerRoot = innerHost.attachShadow({ mode: 'open' });
    innerRoot.append(document.createTextNode('nested text'));
    const container = document.createElement('div');
    container.append(document.createTextNode('unselected before'), innerHost, document.createTextNode('unselected after'));
    outerRoot.append(container);
    const hostOnlyRange = { startContainer: container, startOffset: 1, endContainer: container, endOffset: 2, collapsed: false };
    const selection = {
      rangeCount: 1,
      anchorNode: container, anchorOffset: 1,
      focusNode: container, focusOffset: 2,
      getRangeAt: () => ({ getBoundingClientRect: () => rect(0, 0, 0, 0) }),
      getComposedRanges: vi.fn(() => [hostOnlyRange]),
      toString: () => 'nested text'
    };
    const createRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = createRange();
      range.getBoundingClientRect = () => rect(1, 20, 200, 80);
      return range;
    });

    try {
      expect(manager.calculateSelectionPosition(selection)).toBeNull();
      expect(selection.getComposedRanges).toHaveBeenNthCalledWith(1, { shadowRoots: [outerRoot] });
      expect(selection.getComposedRanges).toHaveBeenNthCalledWith(2, { shadowRoots: [outerRoot, innerRoot] });
    } finally {
      outerHost.remove();
    }
  });

  it('accepts a partial mixed-content range containing a nested ShadowRoot host', () => {
    const outerHost = document.createElement('div');
    outerHost.tabIndex = 0;
    document.body.append(outerHost);
    outerHost.focus();
    const outerRoot = outerHost.attachShadow({ mode: 'open' });
    const innerHost = document.createElement('gallery-caption');
    const innerRoot = innerHost.attachShadow({ mode: 'open' });
    innerRoot.append(document.createTextNode('nested text'));
    const container = document.createElement('div');
    container.append(document.createTextNode('selected before'), innerHost, document.createTextNode('unselected after'));
    outerRoot.append(container);
    const partialRange = { startContainer: container, startOffset: 0, endContainer: container, endOffset: 2, collapsed: false };
    const selection = {
      rangeCount: 1,
      anchorNode: container, anchorOffset: 0,
      focusNode: container, focusOffset: 2,
      getRangeAt: () => ({ getBoundingClientRect: () => rect(0, 0, 0, 0) }),
      getComposedRanges: vi.fn(() => [partialRange]),
      toString: () => 'selected before nested text'
    };
    const createRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = createRange();
      range.getBoundingClientRect = () => rect(30, 50, 20, 8);
      return range;
    });

    try {
      expect(manager.calculateSelectionPosition(selection)).toEqual({ x: 28, y: 53, _isViewportRelative: false });
      expect(selection.getComposedRanges).toHaveBeenNthCalledWith(1, { shadowRoots: [outerRoot] });
      expect(selection.getComposedRanges).toHaveBeenNthCalledWith(2, { shadowRoots: [outerRoot, innerRoot] });
    } finally {
      outerHost.remove();
    }
  });

  it('rejects a host-level range when the nested ShadowRoot host is below the range children', () => {
    const outerHost = document.createElement('div');
    const outerRoot = outerHost.attachShadow({ mode: 'open' });
    const innerHost = document.createElement('gallery-caption');
    const innerRoot = innerHost.attachShadow({ mode: 'open' });
    const selectedText = document.createTextNode('selected');
    innerRoot.append(selectedText);

    const container = document.createElement('section');
    const firstLevel = document.createElement('div');
    const secondLevel = document.createElement('div');
    secondLevel.append(innerHost);
    firstLevel.append(secondLevel);
    container.append(firstLevel);
    outerRoot.append(container);

    const nativeHostRange = document.createRange();
    nativeHostRange.selectNodeContents(container);
    const hostRange = {
      startContainer: nativeHostRange.startContainer,
      startOffset: nativeHostRange.startOffset,
      endContainer: nativeHostRange.endContainer,
      endOffset: nativeHostRange.endOffset,
      collapsed: nativeHostRange.collapsed
    };
    const innerRange = { startContainer: selectedText, startOffset: 0, endContainer: selectedText, endOffset: 8, collapsed: false };
    const selection = {
      rangeCount: 1,
      anchorNode: container,
      anchorOffset: nativeHostRange.startOffset,
      focusNode: container,
      focusOffset: nativeHostRange.endOffset,
      getRangeAt: () => ({ getBoundingClientRect: () => rect(0, 0, 0, 0) }),
      getComposedRanges: vi.fn(({ shadowRoots }) => [shadowRoots.includes(innerRoot) ? innerRange : hostRange]),
      toString: () => 'selected'
    };
    const createRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = createRange();
      range.getBoundingClientRect = () => range.startContainer === container
        ? rect(1, 20, 200, 80)
        : rect(30, 50, 20, 8);
      return range;
    });

    expect(manager.calculateSelectionPosition(selection)).toEqual({ x: 28, y: 53, _isViewportRelative: false });
    expect(selection.getComposedRanges).toHaveBeenNthCalledWith(1, { shadowRoots: [outerRoot] });
    expect(selection.getComposedRanges).toHaveBeenNthCalledWith(2, { shadowRoots: [outerRoot, innerRoot] });
  });

  it('accepts a valid multiline BR range when Selection and Range text serialization differ', () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const paragraph = document.createElement('p');
    const first = document.createTextNode('first');
    const second = document.createTextNode('second');
    paragraph.append(first, document.createElement('br'), second);
    root.append(paragraph);
    const composedRange = { startContainer: first, startOffset: 0, endContainer: second, endOffset: 6, collapsed: false };
    const selection = {
      rangeCount: 1, anchorNode: first, anchorOffset: 0, focusNode: second, focusOffset: 6,
      getRangeAt: () => ({ getBoundingClientRect: () => rect(0, 0, 0, 0) }),
      getComposedRanges: () => [composedRange], toString: () => 'first\nsecond'
    };
    const createRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = createRange();
      range.getBoundingClientRect = () => rect(30, 50, 20, 8);
      return range;
    });

    try {
      expect(manager.calculateSelectionPosition(selection)).toEqual({ x: 28, y: 53, _isViewportRelative: false });
      const nativeRange = createRange();
      nativeRange.setStart(first, 0);
      nativeRange.setEnd(second, 6);
      expect(selection.toString()).not.toBe(nativeRange.toString());
    } finally {
      host.remove();
    }
  });

  it('accepts a range spanning block elements independent of text serialization', () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const container = document.createElement('div');
    const first = document.createElement('p');
    const second = document.createElement('p');
    first.append(document.createTextNode('first'));
    second.append(document.createTextNode('second'));
    container.append(first, second);
    root.append(container);
    const firstText = first.firstChild;
    const secondText = second.firstChild;
    const composedRange = { startContainer: firstText, startOffset: 0, endContainer: secondText, endOffset: 6, collapsed: false };
    const selection = {
      rangeCount: 1, anchorNode: firstText, anchorOffset: 0, focusNode: secondText, focusOffset: 6,
      getRangeAt: () => ({ getBoundingClientRect: () => rect(0, 0, 0, 0) }),
      getComposedRanges: () => [composedRange], toString: () => 'first\nsecond'
    };
    const createRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = createRange();
      range.getBoundingClientRect = () => rect(30, 50, 20, 8);
      return range;
    });

    try {
      expect(manager.calculateSelectionPosition(selection)).toEqual({ x: 28, y: 53, _isViewportRelative: false });
      const nativeRange = createRange();
      nativeRange.setStart(firstText, 0);
      nativeRange.setEnd(secondText, 6);
      expect(selection.toString()).not.toBe(nativeRange.toString());
    } finally {
      host.remove();
    }
  });

  it('discovers a descendant ShadowRoot when selection endpoints are retargeted to an ancestor', () => {
    const figure = document.createElement('figure');
    const caption = document.createElement('gallery-caption');
    const root = caption.attachShadow({ mode: 'open' });
    const text = document.createTextNode('selected');
    root.append(text);
    figure.append(caption);
    document.body.append(figure);

    const activeElement = document.createElement('div');
    activeElement.tabIndex = 0;
    document.body.append(activeElement);
    activeElement.focus();

    const staticRange = { startContainer: text, startOffset: 0, endContainer: text, endOffset: 8, collapsed: false };
    const hostRange = { startContainer: figure, startOffset: 0, endContainer: figure, endOffset: 1, collapsed: false };
    const selection = {
      rangeCount: 1,
      anchorNode: figure,
      anchorOffset: 0,
      focusNode: figure,
      focusOffset: 1,
      getRangeAt: () => ({ getBoundingClientRect: () => rect(0, 0, 0, 0) }),
      getComposedRanges: vi.fn(({ shadowRoots }) => [shadowRoots.includes(root) ? staticRange : hostRange]),
      toString: () => 'selected'
    };
    const createRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = createRange();
      range.getBoundingClientRect = () => range.startContainer === figure
        ? rect(1, 20, 200, 80)
        : rect(30, 50, 20, 8);
      return range;
    });

    try {
      expect(document.activeElement).toBe(activeElement);
      expect(manager.calculateSelectionPosition(selection)).toEqual({ x: 28, y: 53, _isViewportRelative: false });
      expect(selection.getComposedRanges).toHaveBeenNthCalledWith(1, { shadowRoots: [] });
      expect(selection.getComposedRanges).toHaveBeenNthCalledWith(2, { shadowRoots: [root] });
    } finally {
      figure.remove();
      activeElement.remove();
    }
  });

  it('does not attempt composed ranges when unsupported or text is empty', () => {
    const emptyGeometry = { rangeCount: 1, getRangeAt: () => ({ getBoundingClientRect: () => rect(0, 0, 0, 0) }), toString: () => 'text' };
    expect(manager.calculateSelectionPosition(emptyGeometry)).toBeNull();
    const emptySelection = { ...emptyGeometry, getComposedRanges: vi.fn(), toString: () => '' };
    expect(manager.calculateSelectionPosition(emptySelection)).toBeNull();
    expect(emptySelection.getComposedRanges).not.toHaveBeenCalled();
  });

  it('rejects collapsed and zero-geometry composed ranges', () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const text = document.createTextNode('selected');
    root.append(text);
    const selection = {
      rangeCount: 1, anchorNode: text, anchorOffset: 0, focusNode: text, focusOffset: 8,
      getRangeAt: () => ({ getBoundingClientRect: () => rect(0, 0, 0, 0) }),
      getComposedRanges: vi.fn(() => [
        { startContainer: text, startOffset: 0, endContainer: text, endOffset: 0, collapsed: true },
        { startContainer: text, startOffset: 0, endContainer: text, endOffset: 8, collapsed: false }
      ]), toString: () => 'selected'
    };
    const setStart = vi.fn();
    const setEnd = vi.fn();
    const measure = vi.fn(() => rect(0, 0, 0, 0));
    vi.spyOn(document, 'createRange').mockImplementation(() => ({ setStart, setEnd, getBoundingClientRect: measure }));
    expect(manager.calculateSelectionPosition(selection)).toBeNull();
    expect(selection.getComposedRanges).toHaveBeenCalledOnce();
    expect(setStart).toHaveBeenCalledWith(text, 0);
    expect(setEnd).toHaveBeenCalledWith(text, 8);
    expect(measure).toHaveBeenCalledOnce();
  });

  it('rejects composed ranges inside an extension UI host', () => {
    const host = document.createElement('div');
    host.id = UI_HOST_IDS.MAIN;
    const root = host.attachShadow({ mode: 'open' });
    const text = document.createTextNode('selected');
    root.append(text);
    const selection = {
      rangeCount: 1, anchorNode: text, focusNode: text,
      getRangeAt: () => ({ getBoundingClientRect: () => rect(0, 0, 0, 0) }),
      getComposedRanges: () => [{ startContainer: text, collapsed: false }], toString: () => 'selected'
    };
    expect(manager.calculateSelectionPosition(selection)).toBeNull();
  });

  it('keeps iframe coordinates viewport-relative without scroll offsets', () => {
    vi.spyOn(window, 'top', 'get').mockReturnValue({});
    vi.spyOn(window, 'scrollX', 'get').mockReturnValue(7);
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(11);
    const selection = {
      rangeCount: 1,
      getRangeAt: () => ({ getBoundingClientRect: () => rect(20, 40, 10, 5) }),
      toString: () => 'selected'
    };
    expect(manager.calculateSelectionPosition(selection)).toEqual({ x: 13, y: 43, _isViewportRelative: true });
  });

  it('relays iframe toolbarPosition separately from the selection position and options', () => {
    const postMessage = vi.fn();
    vi.spyOn(window, 'top', 'get').mockReturnValue({});
    vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage });
    const position = { x: 10, y: 20, _isViewportRelative: true };
    const toolbarPosition = { x: 30, y: 40, _isViewportRelative: true };

    manager.requestWindowCreationInMainFrame('selected', position, {
      ctrlPressed: false,
      displayInteraction: 'multi-click',
    }, toolbarPosition);

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      position,
      toolbarPosition,
      options: { ctrlPressed: false, displayInteraction: 'multi-click' }
    }), '*');
  });
});

describe('SelectionManager duplicate selection events', () => {
  afterEach(() => {
    pageEventBus.off(SELECTION_EVENTS.GLOBAL_SELECTION_CHANGE, onSelectionChange);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const onSelectionChange = vi.fn();

  it('emits both global events and marks only the duplicate as display-suppressed', async () => {
    vi.useFakeTimers();
    const manager = new SelectionManager();
    const position = { x: 20, y: 40, _isViewportRelative: false };
    vi.spyOn(ExtensionContextManager, 'isValidSync').mockReturnValue(true);
    vi.spyOn(settingsManager, 'get').mockImplementation((_key, fallback) => fallback);
    vi.spyOn(manager, 'calculateSelectionPosition').mockReturnValue(position);
    vi.spyOn(manager, 'checkExclusion').mockResolvedValue(false);
    vi.spyOn(manager, 'isWindowVisible').mockReturnValue(false);
    vi.spyOn(manager, 'showTranslationUI').mockResolvedValue(undefined);
    onSelectionChange.mockClear();
    pageEventBus.on(SELECTION_EVENTS.GLOBAL_SELECTION_CHANGE, onSelectionChange);

    try {
      const selection = {};
      await manager.processSelection('same text', selection, { ctrlPressed: true });
      await vi.advanceTimersByTimeAsync(50);
      await manager.processSelection('same text', selection, { ctrlPressed: true });

      expect(onSelectionChange).toHaveBeenCalledTimes(2);
      const [first, duplicate] = onSelectionChange.mock.calls.map(([detail]) => detail);
      expect(first).toEqual(expect.objectContaining({
        text: 'same text', position, options: { ctrlPressed: true },
        context: { frameId: manager.frameId, isIframe: false },
      }));
      expect(first).not.toHaveProperty('suppressWindowsManagerDisplay');
      expect(duplicate).toEqual(expect.objectContaining({
        text: 'same text', position, options: { ctrlPressed: true },
        context: { frameId: manager.frameId, isIframe: false },
        suppressWindowsManagerDisplay: true,
      }));
      expect(manager.showTranslationUI).toHaveBeenCalledOnce();
    } finally {
      manager.cleanup();
    }
  });

  it('dedupes the same interaction but accepts the same text from a new primary interaction', async () => {
    vi.useFakeTimers();
    const manager = new SelectionManager();
    const position = { x: 20, y: 40, _isViewportRelative: false };
    const toolbarPosition = { x: 31, y: 42 };
    const selectionGeometry = { range: 'primary-selection' };
    let pendingShow;
    let committedShow;
    vi.spyOn(ExtensionContextManager, 'isValidSync').mockReturnValue(true);
    vi.spyOn(settingsManager, 'get').mockImplementation((_key, fallback) => fallback);
    vi.spyOn(manager, 'calculateSelectionPosition').mockReturnValue(position);
    vi.spyOn(manager, 'checkExclusion').mockResolvedValue(false);
    vi.spyOn(manager, 'isWindowVisible').mockReturnValue(false);
    vi.spyOn(manager, 'showTranslationUI').mockImplementation((...args) => {
      clearTimeout(pendingShow);
      pendingShow = setTimeout(() => { committedShow = args; }, 200);
    });
    onSelectionChange.mockClear();
    pageEventBus.on(SELECTION_EVENTS.GLOBAL_SELECTION_CHANGE, onSelectionChange);

    try {
      const selection = { rangeCount: 1 };
      const options = { selectionInteractionId: 11, toolbarPosition, geometry: selectionGeometry };
      await manager.processSelection('same text', selection, options);
      await vi.advanceTimersByTimeAsync(50);
      expect(await manager.processSelection('same text', selection, options)).toBe(false);
      expect(onSelectionChange.mock.calls[1][0]).toHaveProperty('suppressWindowsManagerDisplay', true);
      expect(onSelectionChange.mock.calls[0][0].selectionInteractionId).toBe(11);
      expect(onSelectionChange.mock.calls[1][0].selectionInteractionId).toBe(11);
      expect(onSelectionChange.mock.calls[0][0].options).not.toHaveProperty('selectionInteractionId');

      clearTimeout(pendingShow);
      expect(committedShow).toBeUndefined();
      await manager.processSelection('same text', selection, {
        ...options,
        selectionInteractionId: 12,
      });
      await vi.advanceTimersByTimeAsync(200);

      expect(onSelectionChange).toHaveBeenCalledTimes(3);
      expect(onSelectionChange.mock.calls[2][0]).not.toHaveProperty('suppressWindowsManagerDisplay');
      expect(onSelectionChange.mock.calls[2][0].selectionInteractionId).toBe(12);
      expect(manager.showTranslationUI).toHaveBeenCalledTimes(2);
      expect(manager.showTranslationUI.mock.calls[1]).toEqual([
        'same text', position,
        expect.objectContaining({
          geometry: selectionGeometry,
          selectionInteractionId: 12,
        }),
        toolbarPosition,
      ]);
      expect(committedShow).toEqual([
        'same text', position,
        expect.objectContaining({
          geometry: selectionGeometry,
          selectionInteractionId: 12,
        }),
        toolbarPosition,
      ]);
    } finally {
      clearTimeout(pendingShow);
      manager.cleanup();
    }
  });
});
