import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { installPageTranslationDocumentProbe } from './PageTranslationDocumentIdentity.js';

function createBrowserAPI() {
  let listener;
  const addListener = vi.fn(callback => { listener = callback; });
  const listenerReturns = [];
  const browserAPI = { runtime: {
    onMessage: { addListener },
    sendMessage: message => new Promise(resolve => {
      const keepAlive = listener(message, {}, resolve);
      listenerReturns.push(keepAlive);
      if (keepAlive !== true) resolve(undefined);
    }),
  } };
  return { browserAPI, addListener, listenerReturns };
}

describe('Page Translation document identity probe', () => {
  beforeEach(() => {
    delete window.__translateItPageDocumentToken;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses randomUUID when available and registers the document probe', async () => {
    const expectedToken = '00000000-0000-4000-8000-000000000001';
    const randomUUID = vi.fn(() => expectedToken);
    const getRandomValues = vi.fn();
    vi.stubGlobal('crypto', { randomUUID, getRandomValues });
    const { browserAPI, addListener, listenerReturns } = createBrowserAPI();

    const token = installPageTranslationDocumentProbe(browserAPI);

    expect(token).toBe(expectedToken);
    expect(randomUUID).toHaveBeenCalledOnce();
    expect(getRandomValues).not.toHaveBeenCalled();
    expect(installPageTranslationDocumentProbe(browserAPI)).toBe(token);
    await expect(browserAPI.runtime.sendMessage({ action: MessageActions.PAGE_TRANSLATE_FRAME_PROBE }))
      .resolves.toEqual({ documentToken: token });
    await expect(browserAPI.runtime.sendMessage({ action: 'unrelated' })).resolves.toBeUndefined();
    expect(listenerReturns).toEqual([true, undefined]);
    expect(addListener).toHaveBeenCalledOnce();
  });

  it('uses getRandomValues when randomUUID is unavailable and registers the document probe', async () => {
    const getRandomValues = vi.fn(bytes => {
      bytes.set(Array.from({ length: 16 }, (_, index) => index));
      return bytes;
    });
    vi.stubGlobal('crypto', { getRandomValues });
    const { browserAPI, addListener, listenerReturns } = createBrowserAPI();

    const token = installPageTranslationDocumentProbe(browserAPI);

    expect(token).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(getRandomValues.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
    expect(getRandomValues.mock.calls[0][0]).toHaveLength(16);
    expect(installPageTranslationDocumentProbe(browserAPI)).toBe(token);
    await expect(browserAPI.runtime.sendMessage({ action: MessageActions.PAGE_TRANSLATE_FRAME_PROBE }))
      .resolves.toEqual({ documentToken: token });
    await expect(browserAPI.runtime.sendMessage({ action: 'unrelated' })).resolves.toBeUndefined();
    expect(listenerReturns).toEqual([true, undefined]);
    expect(addListener).toHaveBeenCalledOnce();
  });
});
