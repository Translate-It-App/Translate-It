// Background script entry point for Vue build
// Cross-browser service worker for Manifest V3

import browser from 'webextension-polyfill'
import { LifecycleManager } from "@/core/managers/core/LifecycleManager.js";
import { registerAllProviders } from "@/features/translation/providers/register-providers.js";
import { unifiedTranslationService } from '@/core/services/translation/UnifiedTranslationService.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { isDevelopmentMode } from '@/shared/utils/environment.js';
import { ErrorHandler } from '@/shared/error-management/ErrorHandler.js';
import { handleInstallationEvent } from '@/handlers/lifecycle/InstallHandler.js';
import ExtensionContextManager from '@/core/extensionContext.js'
import { initializeBackgroundService } from './backgroundStartup.js';
import { OFFSCREEN_IDLE_ALARM_NAME, offscreenRuntimeLeaseManager } from '@/shared/runtime/OffscreenRuntimeLeaseManager.js';
import { liveDubbingCoordinator } from '@/features/live-dubbing/background/LiveDubbingCoordinator.js';
import { registerLiveDubbingTabLifecycle } from '@/features/live-dubbing/background/tabLifecycle.js';
import * as browserCapabilities from '@/core/browserHandlers.js';

// Import context menu click listener
import "./listeners/onContextMenuClicked.js";

// Import notification click listener
import "./listeners/onNotificationClicked.js";

// Inject iframe-only content scripts after subframe DOM becomes available
import "./listeners/onSubframeDOMContentLoaded.js";
import "./listeners/onSpaNavigation.js";

function isChromeRuntime() {
  if (typeof __BROWSER__ !== 'undefined') return __BROWSER__ === 'chrome';
  const detector = Object.prototype.hasOwnProperty.call(browserCapabilities, 'isChrome')
    ? browserCapabilities.isChrome
    : null;
  return typeof detector === 'function' ? detector() : true;
}

// Live dubbing owns tab teardown, independent of popup/sidepanel lifetime.
if (isChromeRuntime()) registerLiveDubbingTabLifecycle();

// Import Memory Garbage Collector
import { initializeGlobalCleanup } from '@/core/memory/GlobalCleanup.js';
import { startMemoryMonitoring } from '@/core/memory/MemoryMonitor.js';

// --- Diagnostic Logging ---
const logger = getScopedLogger(LOG_COMPONENTS.BACKGROUND, 'index');
const errorHandler = ErrorHandler.getInstance();

// --- Port Lifecycle Management ---

/**
 * Shared cleanup logic for UI ports (popup, sidepanel)
 */
async function performUiCleanup(context, sender) {
  // Exit early if extension context is invalidated to avoid "Extension context invalidated" errors
  if (!ExtensionContextManager.isValidSync()) {
    return;
  }

  logger.info(`[Background] Starting cleanup for context: ${context}`);
  
  try {
    if (globalThis.backgroundService?.initialized) {
      const service = globalThis.backgroundService;
      
      // 1. Stop all TTS when UI closes
      const ttsHandler = service.messageHandler.getHandlerForMessage('TTS_STOP');
      if (ttsHandler) {
        logger.debug(`[Background] Stopping TTS for ${context} closure`);
        await ttsHandler({ 
          action: 'TTS_STOP', 
          data: { 
            source: `${context}-port-disconnect`,
            stopOnlyIfOwner: true
          } 
        }, sender);
      }

      // 2. Cancel all active translations from UI
      const cancelHandler = service.messageHandler.getHandlerForMessage('CANCEL_TRANSLATION');
      if (cancelHandler) {
        logger.info(`[Background] Triggering CANCEL_TRANSLATION for context: ${context}`);
        await cancelHandler({
          action: 'CANCEL_TRANSLATION',
          data: { 
            cancelAll: true, 
            context: context,
            reason: `${context}_closed` 
          }
        }, sender);
      } else {
        // Fallback: directly call engine and queue manager
        if (service.translationEngine) {
          logger.info(`[Background] Fallback: Directly cancelling translations for context: ${context}`);
          await service.translationEngine.cancelAllTranslations(context);
          
          try {
            const { queueManager } = await import("@/features/translation/core/QueueManager.js");
            queueManager.cancelByUiContext(context);
          } catch { /* ignore */ }
        }
      }
    }
  } catch (error) {
    errorHandler.handle(error, {
      context: `background-cleanup-${context}`,
      showToast: false
    });
  }
}

// Register onConnect at the very top level for maximum reliability in Service Workers
const runtime = (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime : browser.runtime;

runtime.onConnect.addListener((port) => {
  try {
    const isUiPort = port.name === 'popup-lifecycle' || port.name === 'sidepanel-lifecycle';
    
    if (isUiPort) {
      logger.info(`[Background] UI Port connected: ${port.name}`);
      const context = port.name === 'popup-lifecycle' ? 'popup' : 'sidepanel';
      
      port.onMessage.addListener((msg) => {
        if (msg.action === 'POPUP_OPENED' || msg.action === 'SIDEPANEL_OPENED') {
          logger.debug(`[Background] UI established connection: ${port.name}`);
        }
      });
      
      port.onDisconnect.addListener(() => {
        logger.info(`[Background] Port DISCONNECTED: ${port.name}`);
        performUiCleanup(context, port.sender).catch(err => {
          errorHandler.handle(err, {
            context: `background-port-disconnect-${context}`,
            showToast: false
          });
        });
      });
    }
  } catch (err) {
    errorHandler.handle(err, {
      context: 'background-onConnect',
      showToast: false
    });
  }
});

// Idle offscreen cleanup fires through a single alarms listener (Chromium only;
// Firefox has no offscreen document to leak). The lease manager re-checks
// guards and physical presence before closing so stale alarms stay harmless.
if (isChromeRuntime()) {
  browser.alarms?.onAlarm?.addListener?.((alarm) => {
    if (alarm?.name === OFFSCREEN_IDLE_ALARM_NAME) {
      offscreenRuntimeLeaseManager._handleIdleCloseAlarm();
    }
  });
}

// --- Initialization ---

// Register all translation providers
registerAllProviders();

const backgroundService = new LifecycleManager();
globalThis.backgroundService = backgroundService;


// Handle extension installation
browser.runtime.onInstalled.addListener(async (details) => {
  try {
    await handleInstallationEvent(details);
  } catch (error) {
    logger.error('Failed to handle installation event:', error);
  }
});

async function postInitializeBackgroundService() {
  logger.info("[Background] Background service initialization completed!");

  if (isChromeRuntime()) {
    // Service workers can restart while a capture session remains in session storage.
    await liveDubbingCoordinator.reconcile().catch(error => {
      logger.debug('[Background] Live dubbing reconciliation skipped:', error);
    });
  }

  // Initialize DebugModeBridge for background script
  try {
    const { debugModeBridge } = await import('@/shared/logging/DebugModeBridge.js');
    await debugModeBridge.initialize();
    logger.info("[Background] DebugModeBridge initialized in background script");
  } catch (error) {
    logger.warn("[Background] Failed to initialize DebugModeBridge:", error);
  }

  // Initialize UnifiedTranslationService with dependencies
  unifiedTranslationService.initialize({
    translationEngine: backgroundService.translationEngine,
    backgroundService: backgroundService
  });
  logger.info("[Background] UnifiedTranslationService initialized!");

  // Initialize Memory Garbage Collector
  initializeGlobalCleanup();
  if (isDevelopmentMode()) {
    startMemoryMonitoring();
  }
  logger.info("[Background] Memory Garbage Collector initialized!");
}

let resolveCommandReadiness;
const commandReadiness = new Promise(resolve => {
  resolveCommandReadiness = resolve;
});

// Register commands before asynchronous startup so Chrome can wake this worker
// and deliver a command while background initialization is still in progress.
if (browser.commands && browser.commands.onCommand) {
  browser.commands.onCommand.addListener(async (command, tab) => {
    try {
      if (!(await commandReadiness)) return;

      const { handleCommandEvent } = await import("@/handlers/command-handler.js");
      if (typeof handleCommandEvent === 'function') {
        await handleCommandEvent(command, tab);
      }
    } catch (error) {
      errorHandler.handle(error, {
        context: `background-command-${command}`,
        showToast: false
      });
    }
  });
}

// Initialize Background Service
initializeBackgroundService(backgroundService, postInitializeBackgroundService, {
  shouldRetry: error => !ExtensionContextManager.isContextError(error),
}).then(() => {
  resolveCommandReadiness(true);
}, (error) => {
  resolveCommandReadiness(false);
  errorHandler.handle(error, {
    context: 'background-init',
    showToast: false
  });
}).catch(() => {});

// Phase D OpenAI spike hook (DEV ONLY): shaken out of production builds.
// Installs `globalThis.__translateItOpenAIRealtimeSpike` (start/status/stop)
// in the service-worker devtools. No production wiring: the hook only
// sends dev-namespaced messages the production routers never match.
if (typeof __IS_DEVELOPMENT__ !== 'undefined' && __IS_DEVELOPMENT__) {
  import('@/features/live-dubbing/spikes/openai/spikeDevBackground.js').then(
    (module) => {
      try {
        module.installOpenAISpikeDevBackgroundHook?.();
      } catch { /* dev-only install is best effort */ }
    },
  ).catch(() => {});
}

export { backgroundService };
