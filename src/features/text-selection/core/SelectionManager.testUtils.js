import { vi } from 'vitest';

export const rect = (left, bottom, width, height) => ({ left, bottom, width, height });

export const createCrossRootSelection = ({ textEndpoint = false, endOffset = 0, fragmentLength = 227 } = {}) => {
  const container = document.createElement('div');
  container.append(document.createElement('i'), document.createElement('i'));
  const host = document.createElement('shreddit-subreddit-header');
  container.append(host);
  document.body.append(container);
  const root = host.attachShadow({ mode: 'open' });
  const endingPhrase = 'Community Guide Insiders Updating their PC';
  const fragment = `${'x'.repeat(fragmentLength - 1)} `;
  const text = document.createTextNode(fragment);
  root.append(text);
  const tooltip = document.createElement('rpl-tooltip');
  const endContainer = textEndpoint ? document.createTextNode(endingPhrase) : document.createElement('div');
  if (textEndpoint) {
    tooltip.append(endContainer);
    host.append(tooltip);
  } else {
    tooltip.append(endContainer);
    host.append(document.createTextNode(endingPhrase), tooltip);
  }

  const nativeRange = document.createRange();
  nativeRange.setStart(container, 2);
  nativeRange.collapse(true);
  nativeRange.getBoundingClientRect = () => rect(0, 0, 0, 0);
  const composedRange = { startContainer: text, startOffset: 0, endContainer, endOffset: textEndpoint ? endOffset : 0, collapsed: false };
  const selectedText = `${fragment}${textEndpoint ? endingPhrase.slice(0, endOffset) : endingPhrase}`;
  const selection = {
    rangeCount: 1, anchorNode: container, anchorOffset: 2, focusNode: container, focusOffset: 2,
    getRangeAt: () => nativeRange,
    getComposedRanges: vi.fn(({ shadowRoots }) => shadowRoots.includes(root) ? [composedRange] : []),
    toString: () => selectedText
  };
  return { container, host, root, text, tooltip, endContainer, nativeRange, composedRange, selection, fragment, endingPhrase, selectedText };
};

export const mockFragmentGeometry = (geometry = rect(100, 135, 1008, 35)) => {
  const measured = [];
  const createRange = document.createRange.bind(document);
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = createRange();
    range.getBoundingClientRect = () => {
      measured.push({ startContainer: range.startContainer, startOffset: range.startOffset, endContainer: range.endContainer, endOffset: range.endOffset });
      return geometry;
    };
    return range;
  });
  return measured;
};
