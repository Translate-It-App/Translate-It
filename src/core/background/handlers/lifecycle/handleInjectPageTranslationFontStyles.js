import browser from 'webextension-polyfill';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';

const logger = getScopedLogger(LOG_COMPONENTS.CORE, 'handleInjectPageTranslationFontStyles');

export async function handleInjectPageTranslationFontStyles(_message, sender) {
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number' || typeof sender.frameId !== 'number') {
    return { success: false, error: 'Missing tab or frame context' };
  }
  try {
    await browser.scripting.insertCSS({
      target: { tabId, frameIds: [sender.frameId] },
      files: ['translate-it-page-font.css'],
    });
    return { success: true };
  } catch (error) {
    logger.debug('Page Translation font stylesheet injection skipped/failed', {
      tabId,
      frameId: sender.frameId,
      error: error?.message || String(error),
    });
    return { success: false, error: error?.message || 'Stylesheet injection failed' };
  }
}
