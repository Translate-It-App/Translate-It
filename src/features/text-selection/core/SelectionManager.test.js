import { afterEach, describe, expect, it, vi } from 'vitest';
import { SelectionManager } from './SelectionManager.js';
import { UI_HOST_IDS } from '@/shared/constants/ui.js';

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
      focusNode: text,
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
    const range = { startContainer: text, collapsed: false };
    const selection = {
      rangeCount: 1, anchorNode: text, focusNode: text,
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
      focusNode: figure,
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
      rangeCount: 1, anchorNode: text, focusNode: text,
      getRangeAt: () => ({ getBoundingClientRect: () => rect(0, 0, 0, 0) }),
      getComposedRanges: vi.fn(() => [
        { startContainer: text, collapsed: true },
        { startContainer: text, collapsed: false }
      ]), toString: () => 'selected'
    };
    vi.spyOn(document, 'createRange').mockImplementation(() => ({
      setStart: vi.fn(), setEnd: vi.fn(), toString: () => 'selected',
      getBoundingClientRect: () => rect(0, 0, 0, 0)
    }));
    expect(manager.calculateSelectionPosition(selection)).toBeNull();
    expect(selection.getComposedRanges).toHaveBeenCalledOnce();
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
});
