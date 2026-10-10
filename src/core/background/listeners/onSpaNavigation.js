import browser from 'webextension-polyfill';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { pageNavigationTracker } from '../PageNavigationTracker.js';

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

  try {
    let data;
    try {
      const navigationCursor = await pageNavigationTracker.capture(tabId, frameId, details.url);
      data = navigationCursor ? { navigationCursor } : {};
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
