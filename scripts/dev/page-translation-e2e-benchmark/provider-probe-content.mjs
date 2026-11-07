import { groupMutationRecords, isDuplicateAcceptedMutation } from './measurement-lifecycle.mjs';

const translation = source => `\u200efixture translation: ${source}`;
const targetId = node => (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest?.('[data-bench-id]')?.dataset?.benchId ?? null;
const targetIndex = id => {
  const match = /^target-(\d+)$/.exec(id ?? '');
  const value = Number(match?.[1]);
  return Number.isInteger(value) && value >= 0 && value < 12 ? value : -1;
};
const attributesOf = element => Object.fromEntries([...element.attributes].map(attribute => [attribute.name, attribute.value]).sort(([left], [right]) => left.localeCompare(right)));
const sameAttributes = (element, expected) => {
  const actual = attributesOf(element);
  return Object.keys(actual).length === Object.keys(expected).length
    && Object.entries(expected).every(([name, value]) => actual[name] === value);
};

export function installContentProviderProbe({ handler, report, fixtureUrl }) {
  const elements = [...document.querySelectorAll('[data-bench-id]')];
  const handlerCallbacks = handler?.handlers;
  const originalPageTranslate = handlerCallbacks?.get?.('page-translate');
  if (!handler || typeof handler.setPageTranslationManager !== 'function' || typeof originalPageTranslate !== 'function' || elements.length !== 12
      || elements.some((element, index) => targetIndex(element.dataset.benchId) !== index)) return { installed: false };
  let manager = null;
  let scheduler = null;
  const trackedAncestors = new Set([document.documentElement, document.body]);
  for (const element of elements) for (let parent = element; parent && parent.nodeType === Node.ELEMENT_NODE; parent = parent.parentElement) trackedAncestors.add(parent);
  const baseline = new Map(elements.map(element => [element.dataset.benchId, {
    text: element.textContent,
    markup: element.innerHTML,
    attrs: attributesOf(element),
  }]));
  const metadataBaseline = new Map([...trackedAncestors].map(element => [element, attributesOf(element)]));
  const layoutStyle = !!document.getElementById('ti-translation-layout-fix');
  const accepted = new Set();
  const acceptedSessions = new Map();
  const writes = new Set();
  let duplicateAcceptances = 0;
  let staleWrites = 0;
  let sessionId = null;
  let sentTranslated = false;
  let restoreStarted = false;
  let restoreObserved = false;
  let restoreCommandSuccess = false;
  let commandResultReported = false;
  let lastActivity = Date.now();
  let deadlineTimer;
  let quietTimer;

  const emitError = code => { void report('error', { code }).catch(() => {}); };
  const reportCommandResult = (value, failed = false, message = null) => {
    if (commandResultReported) return;
    const probeCommand = message?.context === 'content' && message?.data?.provider === 'edge' && message?.data?.targetLanguage === 'fr';
    if (!probeCommand) return;
    commandResultReported = true;
    const session = value?.messageId ?? value?.sessionId ?? manager?.acceptedLifecycleSessionId ?? manager?.translationMessageId ?? null;
    void report('command-result', { success: !failed && value?.success === true, sessionId: typeof session === 'string' ? session : null, code: failed || value?.success !== true ? 'PROTOCOL_ERROR' : null }).catch(() => {});
  };
  handlerCallbacks.set('page-translate', function (message, ...args) {
    let result;
    try { result = originalPageTranslate.call(this, message, ...args); }
    catch (error) { reportCommandResult(null, true, message); throw error; }
    if (result && typeof result.then === 'function') result.then(value => reportCommandResult(value, false, message), () => reportCommandResult(null, true, message));
    else reportCommandResult(result, false, message);
    return result;
  });
  const domMatchesTranslated = () => elements.every(element => element.textContent === translation(baseline.get(element.dataset.benchId).text));
  const domMatchesOriginal = () => elements.every(element => {
    const saved = baseline.get(element.dataset.benchId);
    return element.textContent === saved.text && element.innerHTML === saved.markup && sameAttributes(element, saved.attrs);
  });
  const metadataRestored = () => [...metadataBaseline].every(([element, attributes]) => element.isConnected && sameAttributes(element, attributes))
    && !!document.getElementById('ti-translation-layout-fix') === layoutStyle;

  const finishTranslatedIfQuiet = () => {
    if (!manager || sentTranslated || accepted.size !== 12 || !domMatchesTranslated()) return;
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      if (sentTranslated || manager.isTranslating === true || (manager.scheduler?.activeFlushes ?? 0) > 0
          || (manager.scheduler?.queue?.length ?? 0) > 0 || Date.now() - lastActivity < 150) {
        finishTranslatedIfQuiet();
        return;
      }
      const activeSessionId = manager.acceptedLifecycleSessionId ?? manager.translationMessageId ?? sessionId;
      const sessionOwned = typeof sessionId === 'string' && activeSessionId === sessionId
        && manager.scheduler?.translationSessionId === sessionId
        && [...acceptedSessions.values()].every(value => value === sessionId);
      const evidence = {
        sessionId,
        acceptedTargetIds: [...accepted].sort((left, right) => targetIndex(left) - targetIndex(right)),
        acceptedCount: accepted.size,
        duplicateAcceptances,
        staleWrites,
        domMatches: domMatchesTranslated(),
        sessionOwned,
        quiescent: manager.isTranslating === false && (manager.scheduler?.activeFlushes ?? 0) === 0 && (manager.scheduler?.queue?.length ?? 0) === 0,
      };
      if (!sessionOwned || !evidence.quiescent || duplicateAcceptances || staleWrites || !evidence.domMatches) {
        emitError('PROTOCOL_ERROR');
        return;
      }
      if (location.href !== fixtureUrl || window !== window.top) { emitError('PROTOCOL_ERROR'); return; }
      sentTranslated = true;
      void report('translated', evidence).then(async receipt => {
        if (receipt?.decision === 'stop') {
          restoreStarted = true;
          observer.disconnect(); clearTimeout(deadlineTimer); clearTimeout(quietTimer);
          return;
        }
        if (receipt?.decision !== 'restore') { emitError('PROTOCOL_ERROR'); return; }
        if (location.href !== fixtureUrl || window !== window.top) { emitError('PROTOCOL_ERROR'); return; }
        try {
          const result = await globalThis.browser.runtime.sendMessage({ action: 'page-restore', context: 'content', data: {} });
          if (result?.success === false) emitError('PROTOCOL_ERROR');
        } catch { emitError('PROTOCOL_ERROR'); }
      }).catch(() => emitError('PROTOCOL_ERROR'));
    }, 150);
  };

  const attachManager = candidate => {
    if (!candidate || manager === candidate) return false;
    const candidateScheduler = candidate.scheduler;
    const originalSettlement = candidateScheduler?._createSettlement;
    const originalRestore = candidate.restorePage;
    if (typeof originalSettlement !== 'function' || typeof originalRestore !== 'function') return false;
    manager = candidate;
    scheduler = candidateScheduler;
    scheduler._createSettlement = function (...args) {
      const settlement = originalSettlement.apply(this, args);
      const id = targetId(args[0]?.node);
      const originalSettle = settlement?.settle;
      if (typeof originalSettle === 'function') {
        settlement.settle = function (outcome) {
          const result = originalSettle.call(this, outcome);
          if (result === true && outcome === 'accepted' && id) {
            sessionId ??= scheduler.translationSessionId;
            acceptedSessions.set(id, scheduler.translationSessionId);
            if (accepted.has(id)) duplicateAcceptances++;
            accepted.add(id);
            lastActivity = Date.now();
            finishTranslatedIfQuiet();
          }
          return result;
        };
      }
      return settlement;
    };
    manager.restorePage = function (...args) {
      if (!sentTranslated) return originalRestore.apply(this, args);
      restoreStarted = true;
      const result = originalRestore.apply(this, args);
      if (result && typeof result.then === 'function') result.then(value => {
        restoreObserved = true;
        restoreCommandSuccess = value?.success === true;
        lastActivity = Date.now();
        const evidence = {
          sessionId: value?.sessionId ?? sessionId,
          commandSuccess: restoreCommandSuccess,
          domMatchesOriginal: domMatchesOriginal(),
          metadataRestored: metadataRestored(),
          restoreObserved,
        };
        if (Object.values(evidence).some(value => value === false) || typeof evidence.sessionId !== 'string') emitError('PROTOCOL_ERROR');
        else void report('restored', evidence).catch(() => {});
        observer.disconnect(); clearTimeout(deadlineTimer); clearTimeout(quietTimer);
      }, () => emitError('PROTOCOL_ERROR'));
      return result;
    };
    return true;
  };

  const observer = new MutationObserver(records => {
    if (sentTranslated && !restoreStarted) {
      lastActivity = Date.now();
      emitError('PROTOCOL_ERROR');
      return;
    }
    const groups = groupMutationRecords(records, record => targetId(record.target));
    for (const { key: id, records: targetRecords } of groups) {
      const element = elements[targetIndex(id)];
      if (!element) continue;
      const expectedText = translation(baseline.get(id).text);
      if (element.textContent === expectedText) {
        if (!accepted.has(id)) staleWrites++;
        else {
          const matchingChildWrites = targetRecords.filter(record => record.type === 'childList'
            && [...record.addedNodes].some(node => node.textContent === expectedText)).length;
          if (isDuplicateAcceptedMutation({ wasAlreadyAccepted: writes.has(id) || matchingChildWrites > 1, expectedText, resultingText: element.textContent, records: targetRecords })) duplicateAcceptances++;
        }
        writes.add(id);
      }
    }
    lastActivity = Date.now();
    finishTranslatedIfQuiet();
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true, attributes: true, attributeFilter: ['dir', 'lang', 'title', 'translate', 'class', 'style'] });

  const originalSetPageTranslationManager = handler.setPageTranslationManager;
  handler.setPageTranslationManager = function (candidate, ...args) {
    const result = originalSetPageTranslationManager.call(this, candidate, ...args);
    attachManager(candidate);
    return result;
  };
  attachManager(handler.pageTranslationManager);

  deadlineTimer = setTimeout(() => {
    if (!sentTranslated) emitError('TIMEOUT');
  }, 60_000);
  return {
    installed: true,
    disconnect() { observer.disconnect(); clearTimeout(deadlineTimer); clearTimeout(quietTimer); },
  };
}
