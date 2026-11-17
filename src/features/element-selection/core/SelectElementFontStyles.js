import browser from 'webextension-polyfill';

const injectedDocuments = new WeakSet();
const injectingDocuments = new WeakMap();

export function ensureSelectElementFontStyles(doc = globalThis.document) {
  if (!doc || (typeof doc !== 'object' && typeof doc !== 'function')) return false;
  if (injectedDocuments.has(doc) || injectingDocuments.has(doc)) return true;
  const hasExtensionInjector = typeof browser.runtime?.sendMessage === 'function';
  if (!hasExtensionInjector) return false;
  try {
    const request = browser.runtime.sendMessage({ action: 'injectSelectElementFontStyles' });
    const injection = Promise.resolve(request)
      .then(response => {
        if (response?.success === true) injectedDocuments.add(doc);
      }, () => {})
      .finally(() => injectingDocuments.delete(doc));
    injectingDocuments.set(doc, injection);
  } catch {
    return false;
  }
  return true;
}

export function applySelectElementMixedFontStyle(
  target,
  fontFamily,
  targetStates,
  doc = globalThis.document
) {
  if (!target || !fontFamily || !targetStates || !ensureSelectElementFontStyles(doc)) return false;

  if (!targetStates.has(target)) {
    targetStates.set(target, {
      marker: {
        present: target.hasAttribute('data-ti-select-font-target'),
        value: target.getAttribute('data-ti-select-font-target'),
      },
      family: {
        present: target.style.getPropertyValue('--ti-select-element-font-family') !== '',
        value: target.style.getPropertyValue('--ti-select-element-font-family'),
        priority: target.style.getPropertyPriority('--ti-select-element-font-family'),
      },
    });
  }

  try {
    target.setAttribute('data-ti-select-font-target', '');
    target.style.setProperty('--ti-select-element-font-family', fontFamily);
    return true;
  } catch {
    try { restoreSelectElementMixedFontStyle(target, targetStates.get(target)); } catch { /* best-effort style enhancement rollback */ }
    targetStates.delete(target);
    return false;
  }
}

export function restoreSelectElementMixedFontStyle(target, state) {
  if (!target || !state) return;
  if (state.marker.present) target.setAttribute('data-ti-select-font-target', state.marker.value);
  else target.removeAttribute('data-ti-select-font-target');
  if (state.family.present) {
    target.style.setProperty('--ti-select-element-font-family', state.family.value, state.family.priority);
  } else {
    target.style.removeProperty('--ti-select-element-font-family');
  }
}
