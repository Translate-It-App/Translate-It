import browser from 'webextension-polyfill';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';

export async function handlePendingDisplayInvalidation(message, sender) {
  const tabId = sender?.tab?.id;
  const frameId = sender?.frameId;
  const timestamp = message?.data?.timestamp;
  const extensionUrl = browser.runtime?.getURL?.('');

  if (!browser.runtime?.id || sender?.id !== browser.runtime.id || !Number.isInteger(tabId) || tabId < 0 ||
      !Number.isInteger(frameId) || frameId <= 0 ||
      (typeof sender.url === 'string' && extensionUrl && sender.url.startsWith(extensionUrl))) {
    return { success: false, error: 'Invalid pending-display sender' };
  }
  if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > Date.now()) {
    return { success: false, error: 'Invalid pending-display timestamp' };
  }
  if (typeof browser.webNavigation?.getFrame !== 'function' ||
      typeof browser.tabs?.sendMessage !== 'function') {
    return { success: false, error: 'Frame verification unavailable' };
  }

  try {
    const frame = await browser.webNavigation.getFrame({ tabId, frameId });
    if (!frame || (typeof frame.url === 'string' && extensionUrl && frame.url.startsWith(extensionUrl))) {
      return { success: false, error: 'Unknown content frame' };
    }
    const response = await browser.tabs.sendMessage(tabId, {
      action: MessageActions.INVALIDATE_PENDING_DISPLAY,
      data: { timestamp },
    }, { frameId: 0 });
    if (!response?.success || !response.result || typeof response.result !== 'object') {
      return { success: false, error: 'Pending-display owner rejected invalidation' };
    }
    return { success: true, result: response.result };
  } catch {
    return { success: false, error: 'Pending-display relay failed' };
  }
}
