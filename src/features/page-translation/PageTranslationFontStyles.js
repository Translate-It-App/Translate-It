import browser from 'webextension-polyfill';

const injectedDocuments = new WeakSet();
const injectingDocuments = new WeakMap();

export function ensurePageTranslationFontStyles(doc = globalThis.document) {
  if (!doc || (typeof doc !== 'object' && typeof doc !== 'function')) return false;
  if (injectedDocuments.has(doc) || injectingDocuments.has(doc)) return true;
  if (typeof browser.runtime?.sendMessage !== 'function') return false;
  try {
    const request = browser.runtime.sendMessage({ action: 'injectPageTranslationFontStyles' });
    const injection = Promise.resolve(request)
      .then(response => {
        if (response?.success === true) injectedDocuments.add(doc);
      }, () => {})
      .finally(() => injectingDocuments.delete(doc));
    injectingDocuments.set(doc, injection);
    return true;
  } catch {
    return false;
  }
}
