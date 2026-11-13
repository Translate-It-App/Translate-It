import { groupMutationRecords, isDuplicateAcceptedMutation } from './measurement-lifecycle.mjs';

const translation = source => `\u200efixture translation: ${source}`;
const targetId = node => (node?.nodeType === Node.ELEMENT_NODE ? node : node?.nodeType === Node.ATTRIBUTE_NODE ? node.ownerElement : node?.parentElement)?.closest?.('[data-bench-id]')?.dataset?.benchId ?? null;
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

export function validateAcceptedMutationAccounting({ targetKinds, acceptedIds, mutationIds, duplicateAcceptances, staleWrites, unattributedWrites }) {
  const expectedIds = Array.from({ length: 12 }, (_, index) => `target-${index}`);
  const expectedKinds = targetKinds;
  const actualIds = [...acceptedIds];
  const observedIds = [...mutationIds];
  const counts = { text: 0, title: 0 };
  for (const kind of expectedKinds) {
    if (kind !== 'text' && kind !== 'title') return { ok: false, counts };
    counts[kind]++;
  }
  const idsExactlyOnce = values => values.length === 12 && new Set(values).size === 12
    && expectedIds.every(id => values.includes(id));
  return {
    ok: expectedKinds.length === 12 && idsExactlyOnce(actualIds) && idsExactlyOnce(observedIds)
      && duplicateAcceptances === 0 && staleWrites === 0 && unattributedWrites === 0,
    counts,
  };
}

export function installContentProviderProbe({ handler, report, fixtureUrl }) {
  const benchmarkTrace = window.__pageTranslationBenchmark;
  if (benchmarkTrace) {
    benchmarkTrace.schedulerBatchReporter = evidence => report('scheduler-batch', evidence);
    if (benchmarkTrace.pageTranslationE2E === true) benchmarkTrace.pageTranslationStartReporter = evidence => report('command-result', evidence);
  }
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
  const acceptedMutationIds = new Set();
  const acceptedMutationCounts = { text: 0, title: 0 };
  let unattributedWrites = 0;
  let duplicateAcceptances = 0;
  let staleWrites = 0;
  let sessionId = null;
  let sentTranslated = false;
  let commandResultReported = false;
  let restoreStarted = false;
  let restoreObserved = false;
  let restoreCommandSuccess = false;
  let lastActivity = Date.now();
  let deadlineTimer;
  let quietTimer;

  const emitError = code => { void report('error', { code }).catch(() => {}); };
  if (benchmarkTrace?.pageTranslationE2E !== true) {
    handlerCallbacks.set('page-translate', function (message, ...args) {
      const isProbeCommand = message?.context === 'content' && message?.data?.provider === 'edge' && message?.data?.targetLanguage === 'fr';
      if (commandResultReported || !isProbeCommand) return originalPageTranslate.call(this, message, ...args);
      const sendResult = (value, failed = false) => {
        if (!isProbeCommand || commandResultReported) return;
        commandResultReported = true;
        const commandSession = value?.messageId ?? null;
        void report('command-result', {
          success: !failed && value?.success === true,
          sessionId: !failed && value?.success === true && typeof commandSession === 'string' ? commandSession : null,
          code: !failed && value?.success === true ? null : 'PROTOCOL_ERROR',
        }).catch(() => {});
      };
      let result;
      try { result = originalPageTranslate.call(this, message, ...args); }
      catch (error) { sendResult(null, true); throw error; }
      if (result && typeof result.then === 'function') result.then(value => sendResult(value), () => sendResult(null, true));
      else sendResult(result);
      return result;
    });
  }
  const translatedValue = element => element.dataset.benchKind === 'title'
    ? element.title === translation(baseline.get(element.dataset.benchId).attrs.title)
    : element.textContent === translation(baseline.get(element.dataset.benchId).text);
  const domMatchesTranslated = () => elements.every(translatedValue);
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
        ...(elements.some(element => element.dataset.benchKind === 'title') ? { acceptedMutationCounts: { ...acceptedMutationCounts }, unattributedWrites } : {}),
      };
      const accounting = validateAcceptedMutationAccounting({
        targetKinds: elements.map(element => element.dataset.benchKind === 'title' ? 'title' : 'text'),
        acceptedIds: accepted, mutationIds: acceptedMutationIds, duplicateAcceptances, staleWrites, unattributedWrites,
      });
      const completeMutationAccounting = accounting.ok && accounting.counts.text === acceptedMutationCounts.text
        && accounting.counts.title === acceptedMutationCounts.title;
      if (!sessionOwned || !evidence.quiescent || duplicateAcceptances || staleWrites || !evidence.domMatches || !completeMutationAccounting) {
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
      if (!element) { unattributedWrites++; continue; }
      const expectedText = element.dataset.benchKind === 'title'
        ? translation(baseline.get(id).attrs.title)
        : translation(baseline.get(id).text);
      const acceptedValue = element.dataset.benchKind === 'title' ? element.title : element.textContent;
      if (acceptedValue === expectedText) {
        if (!accepted.has(id)) staleWrites++;
        else {
          const matchingChildWrites = targetRecords.filter(record => record.type === 'childList'
            && [...record.addedNodes].some(node => node.textContent === expectedText)).length;
          const titleWrites = targetRecords.filter(record => record.type === 'attributes' && record.attributeName === 'title').length;
          const repeatedAttributeAcceptance = element.dataset.benchKind === 'title'
            && (writes.has(id) || titleWrites > 1) && titleWrites > 0;
          if (repeatedAttributeAcceptance || isDuplicateAcceptedMutation({ wasAlreadyAccepted: writes.has(id) || matchingChildWrites > 1, expectedText, resultingText: acceptedValue, records: targetRecords })) duplicateAcceptances++;
          if (!acceptedMutationIds.has(id)) {
            acceptedMutationIds.add(id);
            acceptedMutationCounts[element.dataset.benchKind === 'title' ? 'title' : 'text']++;
          }
        }
        writes.add(id);
      }
    }
    lastActivity = Date.now();
    finishTranslatedIfQuiet();
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true, attributes: true, attributeOldValue: true, attributeFilter: ['dir', 'lang', 'title', 'translate', 'class', 'style'] });

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
