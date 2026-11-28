import browser from 'webextension-polyfill';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { pageNavigationTracker } from '../PageNavigationTracker.js';
import settingsManager from '@/shared/managers/SettingsManager.js';

const logger = getScopedLogger(LOG_COMPONENTS.BACKGROUND, 'SpaNavigationListener');

/**
 * Forward history updates to the matching frame content script.
 * @param {object} details - Browser navigation details.
 * @returns {Promise<void>}
 */
export async function handleSpaNavigation(details) {
  const tabId = details?.tabId;
  const frameId = details?.frameId;

  if (!Number.isInteger(tabId) || tabId < 0 || !Number.isInteger(frameId) || frameId < 0) {
    return;
  }

  // Mint before storage/settings awaits so a subsequently delivered explicit
  // Stop/Restore can revoke this exact queued navigation.
  const restartFence = pageNavigationTracker.getOrMintRestartFence(tabId);
  try {
    let data;
    try {
      let navigationCursor;
      if (frameId === 0) {
        navigationCursor = await pageNavigationTracker.captureTopNavigation(tabId, details.url, {
          shouldCreate: async () => (await settingsManager.getAsync('WHOLE_PAGE_AUTO_TRANSLATE_RULES', [])).length > 0,
        });
      } else {
        navigationCursor = await pageNavigationTracker.capture(tabId, frameId, details.url);
      }
      data = {
        ...(navigationCursor && { navigationCursor }),
        ...(navigationCursor && restartFence && { restartFence }),
      };
    } catch {
      data = { navigationUnavailable: true };
    }
    await browser.tabs.sendMessage(tabId, {
      action: MessageActions.SPA_NAVIGATION,
      data,
    }, {
      frameId,
    });
  } catch (error) {
    logger.debug('SPA navigation message skipped', {
      tabId,
      frameId,
      error: error?.message || String(error),
    });
  }
}

browser.webNavigation?.onCommitted?.addListener(details => {
  if (!Number.isInteger(details?.tabId) || details.tabId < 0
      || !Number.isInteger(details.frameId) || details.frameId < 0) return;
  void pageNavigationTracker.committed(details.tabId, details.frameId, details.url).catch(() => {
    logger.debug('Page navigation commit tracking unavailable');
  });
});

browser.tabs?.onRemoved?.addListener(tabId => {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  void pageNavigationTracker.removeTab(tabId).catch(() => {
    logger.debug('Page navigation tab cleanup unavailable');
  });
});

if (browser.webNavigation?.onHistoryStateUpdated) {
  browser.webNavigation.onHistoryStateUpdated.addListener(handleSpaNavigation);
  logger.debug('SPA navigation listener registered');
}

if (browser.webNavigation?.onReferenceFragmentUpdated) {
  browser.webNavigation.onReferenceFragmentUpdated.addListener(handleSpaNavigation);
  logger.debug('SPA fragment navigation listener registered');
}
