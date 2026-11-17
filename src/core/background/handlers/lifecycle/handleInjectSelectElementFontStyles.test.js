import { beforeEach, describe, expect, it, vi } from 'vitest';

const { browserMock } = vi.hoisted(() => ({ browserMock: { scripting: { insertCSS: vi.fn() } } }));
vi.mock('webextension-polyfill', () => ({ default: browserMock }));

import { handleInjectSelectElementFontStyles } from './handleInjectSelectElementFontStyles.js';

describe('handleInjectSelectElementFontStyles', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('injects the packaged stylesheet into the originating frame', async () => {
    browserMock.scripting.insertCSS.mockResolvedValue();

    await expect(handleInjectSelectElementFontStyles({}, { tab: { id: 12 }, frameId: 4 }))
      .resolves.toEqual({ success: true });
    expect(browserMock.scripting.insertCSS).toHaveBeenCalledWith({
      target: { tabId: 12, frameIds: [4] },
      files: ['translate-it-select-font.css'],
    });
  });

  it('reports injection failures without throwing', async () => {
    browserMock.scripting.insertCSS.mockRejectedValue(new Error('restricted page'));

    await expect(handleInjectSelectElementFontStyles({}, { tab: { id: 12 }, frameId: 0 }))
      .resolves.toMatchObject({ success: false, error: 'restricted page' });
  });
});
