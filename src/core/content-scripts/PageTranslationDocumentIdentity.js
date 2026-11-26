import { MessageActions } from '@/shared/messaging/core/MessageActions.js';

export function installPageTranslationDocumentProbe(browserAPI) {
  if (window.__translateItPageDocumentToken) return window.__translateItPageDocumentToken;
  const documentToken = crypto.randomUUID();
  window.__translateItPageDocumentToken = documentToken;
  browserAPI?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
    if (message?.action !== MessageActions.PAGE_TRANSLATE_FRAME_PROBE) return undefined;
    sendResponse({ documentToken });
    return true;
  });
  return documentToken;
}
