import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { installPageTranslationDocumentProbe } from './PageTranslationDocumentIdentity.js';

describe('Page Translation document identity probe', () => {
  beforeEach(() => {
    delete window.__translateItPageDocumentToken;
  });

  it('uses sendResponse and the keepalive return contract for probes', async () => {
    const addListener = vi.fn();
    let listener;
    const listenerReturns = [];
    const browserAPI = { runtime: {
      onMessage: { addListener: callback => { listener = callback; addListener(callback); } },
      sendMessage: message => new Promise(resolve => {
        const keepAlive = listener(message, {}, resolve);
        listenerReturns.push(keepAlive);
        if (keepAlive !== true) resolve(undefined);
      }),
    } };
    const token = installPageTranslationDocumentProbe(browserAPI);

    expect(token).toBe(window.__translateItPageDocumentToken);
    await expect(browserAPI.runtime.sendMessage({ action: MessageActions.PAGE_TRANSLATE_FRAME_PROBE }))
      .resolves.toEqual({ documentToken: token });
    await expect(browserAPI.runtime.sendMessage({ action: 'unrelated' })).resolves.toBeUndefined();
    expect(listenerReturns).toEqual([true, undefined]);
    expect(installPageTranslationDocumentProbe(browserAPI)).toBe(token);
    expect(addListener).toHaveBeenCalledOnce();
  });
});
