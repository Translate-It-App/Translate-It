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

function stopFocusInPropagation(event) {
  event.stopPropagation();
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

  try {
    if (!ExtensionContextManager.isValidSync()) return;
    if (!isSuitableEnvironmentForVue()) return;

    setupTrustedTypesCompatibility();
    const app = createApp(ContentApp);
    pinia = createPinia();
    app.use(pinia);

    try {
      const { i18nPlugin } = await utilsFactory.getI18nUtils();
      app.use(i18nPlugin);
    } catch (error) {
      logger.warn('Failed to load i18n plugin:', error);
    }

    const mountPoint = await createMountPoint();
    app.mount(mountPoint);
    vueApp = app;

    if (contentCore) {
      contentCore.vueLoaded = true;
      contentCore.dispatchEvent(new CustomEvent('vue-loaded'));
    }
  } catch (error) {
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
        visibility: visible !important;
        direction: ltr !important;
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
    // CRITICAL: Append to documentElement (html) to escape any transforms or filters applied to body
    // This ensures position: fixed children anchor to the viewport correctly
    document.documentElement.appendChild(hostElement);
  }

  const shadowRoot = hostElement.shadowRoot;
  shadowRoot.addEventListener('focusin', stopFocusInPropagation);
  return shadowRoot.getElementById(UI_HOST_IDS.APP_CONTAINER);
}

export function cleanupVueApp() {
  if (vueApp) {
    try {
      vueApp.unmount();
      vueApp = null;
      pinia = null;
      const hostElement = document.getElementById(UI_HOST_IDS.MAIN) || document.getElementById(UI_HOST_IDS.IFRAME);
      if (hostElement) hostElement.remove();
    } catch (error) {
      logger.error('Error cleaning up Vue app:', error);
    }
  }
}

export default { loadVueApp, cleanupVueApp };
