import { PageTranslationManager } from '../../../src/features/page-translation/PageTranslationManager.js';
import { FeatureManager } from '../../../src/core/managers/content/FeatureManager.js';
import { PageTranslationScheduler } from '../../../src/features/page-translation/PageTranslationScheduler.js';
import { PageTranslationBridge } from '../../../src/features/page-translation/PageTranslationBridge.js';
import { installCallThrough } from './trace.mjs';
import { drainAndDisconnectMeasurementObservers } from './measurement-lifecycle.mjs';

const trace = {
  entry: 'src/core/content-scripts/index-main.js',
  calls: [],
  restores: [],
  events: [],
  record(name, detail = {}) { this.events.push({ name, at: Date.now(), ...detail }); },
  featureState() {
    const manager = FeatureManager.getInstance();
    const messageHandler = manager.getFeatureHandler('contentMessageHandler');
    return { initialized: manager.initialized, active: manager.isFeatureActive('contentMessageHandler'), handlerActive: !!messageHandler?.isActive };
  },
};
const originalTranslate = PageTranslationManager.prototype.translatePage;
PageTranslationManager.prototype.translatePage = function(...args) {
  const at = Date.now();
  const options = args[0] ?? {};
  trace.record('manager.translatePage.entry', { isAuto: options.isAuto === true, targetLanguage: options.targetLanguage ?? null });
  const append = () => trace.calls.push({ at, endedAt: Date.now(), settings: {
    targetLanguage: this.settings?.targetLanguage ?? null,
    lazyLoading: this.settings?.lazyLoading ?? null,
    translateAfterScrollStop: this.settings?.translateAfterScrollStop ?? null,
    autoTranslateOnDOMChanges: this.settings?.autoTranslateOnDOMChanges ?? null,
  }, messageId: this.translationMessageId, totalTasks: this.scheduler?.totalTasks });
  let result;
  try { result = originalTranslate.apply(this, args); } catch (error) { append(); throw error; }
  if (result && typeof result.then === 'function') result.then(append, append);
  else append();
  return result;
};
const originalRestore = PageTranslationManager.prototype.restorePage;
PageTranslationManager.prototype.restorePage = function(...args) {
  const at = Date.now();
  trace.record('manager.restorePage.entry', { manual: args[0]?.manual ?? null });
  const append = () => trace.restores.push({ at, endedAt: Date.now(), settings: { targetLanguage: this.settings?.targetLanguage ?? null } });
  let result;
  try { result = originalRestore.apply(this, args); } catch (error) { append(); throw error; }
  if (result && typeof result.then === 'function') result.then(append, append);
  else append();
  return result;
};

installCallThrough(PageTranslationScheduler.prototype, 'enqueue', function (args) {
  const [text, , score] = args;
  trace.record('scheduler.enqueue', { score: Number(score) || 0, textLength: typeof text === 'string' ? text.length : null });
});
installCallThrough(PageTranslationScheduler.prototype, 'flush', function () {
  trace.record('scheduler.flush.entry', { queueLength: this.queue?.length ?? null, activeFlushes: this.activeFlushes ?? null, batchTimerPending: this.batchTimer != null });
});
installCallThrough(PageTranslationScheduler.prototype, '_executeBatchRequest', function ([batch]) {
  trace.record('scheduler.executeBatchRequest.entry', { itemCount: Array.isArray(batch) ? batch.length : null });
});
installCallThrough(PageTranslationBridge.prototype, 'translate', function () { trace.record('bridge.translate.entry'); });
installCallThrough(PageTranslationBridge.prototype, 'restore', function () { trace.record('bridge.restore.entry'); });
installCallThrough(PageTranslationBridge.prototype, 'initialize', function (args) {
  const callbacks = args[3];
  if (typeof callbacks?.onDiscoveryStateChange !== 'function' || callbacks.onDiscoveryStateChange.__benchmarkWrapped) return;
  const original = callbacks.onDiscoveryStateChange;
  const wrapped = function (...callbackArgs) {
    trace.record('bridge.discovery.pending', { pending: callbackArgs[0] === true });
    return original.apply(this, callbackArgs);
  };
  wrapped.__benchmarkWrapped = true;
  callbacks.onDiscoveryStateChange = wrapped;
});

let measurement = null;
const visible = element => {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
};
trace.startMeasurement = () => {
  measurement?.observer.disconnect();
  const targets = [...document.querySelectorAll('[data-bench-id]')].map(element => ({
    id: element.dataset.benchId, source: element.textContent, visibleAtStart: visible(element), element,
  }));
  const acceptedIds = new Set();
  const mutations = [];
  let firstVisibleAcceptedWriteAt = null;
  const processMutations = records => {
    for (const mutation of records) {
      const element = (mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement)?.closest('[data-bench-id]');
      const target = targets.find(item => item.element === element);
      if (!target) continue;
      const acceptedWrite = element.textContent === `\u200efixture translation: ${target.source}`;
      mutations.push({ at: Date.now(), id: target.id, type: mutation.type, acceptedWrite });
      if (acceptedWrite && !acceptedIds.has(target.id)) {
        acceptedIds.add(target.id);
        trace.record('dom.acceptedWrite', { id: target.id, visibleAtStart: target.visibleAtStart });
        if (target.visibleAtStart && firstVisibleAcceptedWriteAt === null) {
          firstVisibleAcceptedWriteAt = Date.now();
          trace.record('dom.firstVisibleAcceptedWrite', { id: target.id });
        }
      }
    }
  };
  const longTasks = [];
  const observer = new MutationObserver(processMutations);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  let longTaskObserver = null;
  let longTasksUnavailableReason = null;
  if (!globalThis.PerformanceObserver || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    longTasksUnavailableReason = 'PerformanceObserver longtask entries unsupported';
  } else {
    try {
      longTaskObserver = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => ({ startTime: entry.startTime, duration: entry.duration }))));
      longTaskObserver.observe({ type: 'longtask', buffered: false });
    } catch (error) { longTasksUnavailableReason = error.message; longTaskObserver = null; }
  }
  measurement = { startedAt: Date.now(), targets, acceptedIds, mutations, observer, processMutations, longTaskObserver, longTasks, longTasksUnavailableReason, firstVisible: () => firstVisibleAcceptedWriteAt };
  trace.record('measurement.start', { targetCount: targets.length });
  return { startedAt: measurement.startedAt, targetCount: targets.length, longTasksSupported: !!longTaskObserver, longTasksUnavailableReason };
};
trace.stopMeasurement = () => {
  if (!measurement) return { available: false, reason: 'measurement not started' };
  const current = measurement;
  try {
    drainAndDisconnectMeasurementObservers({
      mutationObserver: current.observer,
      processMutations: current.processMutations,
      longTaskObserver: current.longTaskObserver,
      processLongTasks: entries => current.longTasks.push(...entries.map(entry => ({ startTime: entry.startTime, duration: entry.duration }))),
    });
  } finally {
    measurement = null;
  }
  trace.record('measurement.stop');
  return {
    available: true, startedAt: current.startedAt, stoppedAt: Date.now(), targetCount: current.targets.length,
    acceptedUniqueCount: current.acceptedIds.size, acceptedIds: [...current.acceptedIds],
    firstVisibleAcceptedWriteAt: current.firstVisible(), mutations: current.mutations,
    longTasks: current.longTaskObserver ? current.longTasks : null,
    longTasksUnavailableReason: current.longTasksUnavailableReason,
  };
};
trace.calibrateLongTasks = async () => {
  if (!globalThis.PerformanceObserver || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    return { supported: false, captured: false, count: null, maxDurationMs: null, entries: null, reason: 'PerformanceObserver longtask entries unsupported' };
  }
  const entries = [];
  let observer;
  try {
    observer = new PerformanceObserver(list => entries.push(...list.getEntries().map(entry => ({ duration: entry.duration }))));
    observer.observe({ type: 'longtask', buffered: false });
    await new Promise(resolve => setTimeout(() => {
      const deadline = performance.now() + 75;
      while (performance.now() < deadline) { /* Isolated long-task observer calibration, before translation measurement. */ }
      resolve();
    }, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    entries.push(...observer.takeRecords().map(entry => ({ duration: entry.duration })));
    observer.disconnect();
    const maxDurationMs = entries.length ? Math.max(...entries.map(entry => entry.duration)) : 0;
    return { supported: true, captured: entries.some(entry => entry.duration >= 50), count: entries.length, maxDurationMs, entries };
  } catch (error) {
    observer?.disconnect();
    return { supported: false, captured: false, count: null, maxDurationMs: null, entries: null, reason: error.message };
  }
};

// Load the real content-script graph before exposing a thin runtime control channel.
await import('../../../src/core/content-scripts/index-main.js');

globalThis.chrome.runtime.onMessage.addListener(message => {
  if (message?.action === 'page-translation-frame-lifecycle') {
    trace.record('content.lifecycle', { action: message.action, at: Date.now(), sessionId: message?.data?.sessionId ?? null });
    window.dispatchEvent(new CustomEvent('__benchmark-runtime-event', { detail: message }));
  } else if (typeof message?.action === 'string' && message.action.startsWith('PAGE_TRANSLATE')) {
    trace.record('content.runtimeMessage', { action: message.action, sessionId: message?.data?.sessionId ?? null });
    window.dispatchEvent(new CustomEvent('__benchmark-runtime-event', { detail: message }));
  }
});
window.__pageTranslationBenchmark = trace;
