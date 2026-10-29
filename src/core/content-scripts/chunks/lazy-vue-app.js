// src/core/content-scripts/chunks/lazy-vue-app.js
// Lazy-loaded Vue application and all UI components

import { getScopedLogger } from "@/shared/logging/logger.js";
import { LOG_COMPONENTS } from "@/shared/logging/logConstants.js";
import ExtensionContextManager from '@/core/extensionContext.js';
import { utilsFactory } from '@/utils/UtilsFactory.js';
import { UI_HOST_IDS } from '@/shared/constants/ui.js';

// Import Vue and dependencies
import { createApp } from 'vue';
import { createPinia } from 'pinia';

// Import the main Vue app component
import ContentApp from '@/apps/content/ContentApp.vue';

// Import UI utilities
import { setupTrustedTypesCompatibility } from '@/shared/vue/vue-utils.js';

// Import global styles for the app
import contentAppStyles from '@/assets/styles/content-app-global.scss?inline';

// Import shared styles from the dedicated styles chunk
import { sharedStyles } from './lazy-styles.js';

// Combine shared component styles
const allComponentStyles = Object.values(sharedStyles).join('\n');

const logger = getScopedLogger(LOG_COMPONENTS.CONTENT, 'LazyVueApp');

let vueApp = null;
let pinia = null;
let rootHostPromotionWatch = null;
let promotedRootHost = null;

function stopFocusInPropagation(event) {
  event.stopPropagation();
}

function needsTopLayerViewportHost() {
  const rootStyle = getComputedStyle(document.documentElement);
  if (/(?:^|\s)(?:layout|paint|strict|content)(?:\s|$)/.test(rootStyle.contain)) return true;
  if ([rootStyle.transform, rootStyle.perspective, rootStyle.rotate, rootStyle.scale, rootStyle.translate].some(value => value && value !== 'none')) return true;
  return (rootStyle.willChange || 'auto').split(',').some(value => ['transform', 'perspective', 'rotate', 'scale', 'translate'].includes(value.trim()));
}

function stopRootHostPromotionWatch(host = null) {
  const watch = rootHostPromotionWatch;
  if (!watch || (host && watch.host !== host)) return;
  watch.rootObserver.disconnect();
  watch.headObserver.disconnect();
  document.removeEventListener('load', watch.onStylesheetLoad, true);
  window.removeEventListener('resize', watch.onViewportResize);
  if (watch.frameId !== null) cancelAnimationFrame(watch.frameId);
  rootHostPromotionWatch = null;
}

function promoteRootHost(host) {
  if (promotedRootHost === host || !needsTopLayerViewportHost()) return promotedRootHost === host;
  if (typeof host.showPopover !== 'function') return false;

  try {
    host.setAttribute('popover', 'manual');
    host.showPopover();
    promotedRootHost = host;
    stopRootHostPromotionWatch(host);
    return true;
  } catch {
    host.removeAttribute('popover');
    return false;
  }
}

function isStylesheetLink(element, rel = element?.rel) {
  return element?.localName === 'link'
    && String(rel || '').toLowerCase().split(/\s+/).includes('stylesheet');
}

function containsStylesheet(node) {
  if (!node || (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE)) return false;
  if (node.localName === 'style' || isStylesheetLink(node)) return true;
  return Array.from(node.querySelectorAll?.('style, link[rel]') || [])
    .some(element => element.localName === 'style' || isStylesheetLink(element));
}

function isRelevantHeadMutation(record) {
  if (record.type === 'childList') {
    if (record.target?.localName === 'style') return true;
    return [...record.addedNodes, ...record.removedNodes].some(containsStylesheet);
  }
  if (record.type === 'characterData') {
    return record.target.parentNode?.localName === 'style';
  }
  if (record.type !== 'attributes') return false;

  const { target, attributeName, oldValue } = record;
  if (target.localName === 'style') return attributeName === 'media' || attributeName === 'disabled';
  if (target.localName !== 'link') return false;
  if (attributeName === 'rel') return isStylesheetLink(target) || isStylesheetLink(target, oldValue);
  return ['href', 'media', 'disabled'].includes(attributeName) && isStylesheetLink(target);
}

function watchRootHostPromotion(host) {
  if (promotedRootHost === host || typeof host.showPopover !== 'function' || typeof MutationObserver !== 'function') return;
  if (rootHostPromotionWatch?.host === host) return;
  stopRootHostPromotionWatch();

  const watch = {
    host,
    rootObserver: new MutationObserver(scheduleCheck),
    headObserver: new MutationObserver(records => {
      if (records.some(isRelevantHeadMutation)) scheduleCheck();
    }),
    frameId: null,
    onStylesheetLoad: event => {
      if (event.target?.localName === 'link' && event.target.relList?.contains('stylesheet')) scheduleCheck();
    },
    onViewportResize: scheduleCheck,
  };
  function scheduleCheck() {
    if (rootHostPromotionWatch !== watch || watch.frameId !== null) return;
    watch.frameId = requestAnimationFrame(() => {
      watch.frameId = null;
      if (!host.isConnected) {
        stopRootHostPromotionWatch(host);
        return;
      }
      if (promoteRootHost(host)) stopRootHostPromotionWatch(host);
    });
  }

  rootHostPromotionWatch = watch;
  watch.rootObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class'],
  });
  watch.headObserver.observe(document.head, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ['href', 'rel', 'media', 'disabled'],
  });
  document.addEventListener('load', watch.onStylesheetLoad, true);
  window.addEventListener('resize', watch.onViewportResize);
}

function ensureRootHostPromotion(host) {
  if (promotedRootHost === host) return;
  if (!promoteRootHost(host)) watchRootHostPromotion(host);
}

function isSuitableEnvironmentForVue() {
  if (!document.body) return false;
  const isBrowserXMLViewer =
    document.body.querySelector('#webkit-xml-viewer-source-xml') !== null ||
    document.body.querySelector('[data-viewer="xml"]') !== null ||
    (document.body.querySelector('#json') !== null && document.body.querySelector('.toolbar') !== null) ||
    document.title?.includes('XML page cannot be displayed') ||
    document.title?.includes('JSON page cannot be displayed');

  if (isBrowserXMLViewer) return false;
  if (!document.head || !document.body || !document.documentElement?.style) return false;

  try {
    const testElement = document.createElement('div');
    testElement.style.setProperty('display', 'block');
    if (testElement.style.getPropertyValue('display') !== 'block') return false;
  } catch { return false; }

  return true;
}

export async function loadVueApp(contentCore) {
  if (vueApp) return;

  let app;
  let mountHost;
  try {
    if (!ExtensionContextManager.isValidSync()) return;
    if (!isSuitableEnvironmentForVue()) return;

    setupTrustedTypesCompatibility();
    app = createApp(ContentApp);
    pinia = createPinia();
    app.use(pinia);

    try {
      const { i18nPlugin } = await utilsFactory.getI18nUtils();
      app.use(i18nPlugin);
    } catch (error) {
      logger.warn('Failed to load i18n plugin:', error);
    }

    const mountPoint = await createMountPoint();
    mountHost = mountPoint.getRootNode().host;
    app.mount(mountPoint);
    vueApp = app;

    if (contentCore) {
      contentCore.vueLoaded = true;
      contentCore.dispatchEvent(new CustomEvent('vue-loaded'));
    }
  } catch (error) {
    stopRootHostPromotionWatch(mountHost);
    try { app?.unmount(); } catch { /* ignore partial mount cleanup errors */ }
    if (vueApp === app) vueApp = null;
    pinia = null;
    logger.error('Failed to load Vue app:', error);
    throw error;
  }
}
async function createMountPoint() {
  const isTopFrame = window === window.top;
  const hostId = isTopFrame ? UI_HOST_IDS.MAIN : UI_HOST_IDS.IFRAME;
  let hostElement = document.getElementById(hostId);
  if (!hostElement) {
    hostElement = document.createElement('div');
    hostElement.id = hostId;
    hostElement.classList.add('notranslate');

    // Apply layout-neutral inline styles before appending
    Object.assign(hostElement.style, {
      position: 'fixed',
      width: '0',
      height: '0',
      overflow: 'visible',
      top: '0',
      left: '0',
      zIndex: '2147483647',
      margin: '0',
      padding: '0',
      border: 'none',
      pointerEvents: 'none'
    });

    const shadowRoot = hostElement.attachShadow({ mode: 'open' });
    const appContainer = document.createElement('div');
    appContainer.id = UI_HOST_IDS.APP_CONTAINER;
    appContainer.classList.add('notranslate');

    const resetStyles = document.createElement('style');
    resetStyles.textContent = `
      :host {
        display: block !important;
        inset: 0 auto auto 0 !important;
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        width: 0 !important;
        height: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        border: none !important;
        pointer-events: none !important;
        z-index: 2147483647 !important;
        overflow: visible !important;
        background: transparent !important;
        color: inherit !important;
        visibility: visible !important;
        direction: ltr !important;
      }
      :host([popover]) {
        transform: none !important;
        translate: none !important;
        scale: none !important;
        rotate: none !important;
        perspective: none !important;
        will-change: auto !important;
        content-visibility: visible !important;
        zoom: 1 !important;
        opacity: 1 !important;
        visibility: visible !important;
        contain: none !important;
        filter: none !important;
        clip-path: none !important;
      }
      :host([popover])::backdrop {
        display: none !important;
        background: transparent !important;
        pointer-events: none !important;
      }
      #${UI_HOST_IDS.APP_CONTAINER} { 
        position: relative !important; 
        top: 0 !important;
        left: 0 !important;
        width: 100% !important; 
        height: 100% !important; 
        pointer-events: none !important; 
        overflow: visible !important; 
        direction: ltr !important;
      }
      #${UI_HOST_IDS.APP_CONTAINER} > * { 
        pointer-events: none; 
      }
    `;
    shadowRoot.appendChild(resetStyles);

    const appStyles = document.createElement('style');
    appStyles.textContent = contentAppStyles;
    shadowRoot.appendChild(appStyles);

    if (allComponentStyles) {
      const componentStylesElement = document.createElement('style');
      componentStylesElement.id = 'vue-sfc-automated-styles';
      componentStylesElement.textContent = allComponentStyles;
      shadowRoot.appendChild(componentStylesElement);
    }

    shadowRoot.appendChild(appContainer);
    // Root-level append avoids body-level containing blocks; the promotion check
    // below handles fixed-position containing blocks established by root CSS.
    document.documentElement.appendChild(hostElement);
  }

  ensureRootHostPromotion(hostElement);
  const shadowRoot = hostElement.shadowRoot;
  shadowRoot.addEventListener('focusin', stopFocusInPropagation);
  return shadowRoot.getElementById(UI_HOST_IDS.APP_CONTAINER);
}

export function cleanupVueApp() {
  const hostElement = document.getElementById(UI_HOST_IDS.MAIN) || document.getElementById(UI_HOST_IDS.IFRAME);
  stopRootHostPromotionWatch();
  try {
    vueApp?.unmount();
  } catch (error) {
    logger.error('Error cleaning up Vue app:', error);
  } finally {
    vueApp = null;
    pinia = null;
    promotedRootHost = null;
    hostElement?.remove();
  }
}

export default { loadVueApp, cleanupVueApp };
