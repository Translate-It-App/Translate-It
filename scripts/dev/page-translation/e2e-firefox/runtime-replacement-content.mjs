import { MessageActions } from '../../../../src/shared/messaging/core/MessageActions.js';
import { MessageContexts } from '../../../../src/shared/messaging/core/MessagingCore.js';
import { replacementCancellationReasons, replacementContentEventAction, replacementContentStatusAction, replacementEventSchemas, replacementInvalidatedDomEvent,
  replacementProtocol } from './runtime-replacement-protocol.mjs';


const VERSION = replacementProtocol.version;
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const idPattern = /^target-(?:[0-9]|1[01])$/;
const idValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const allowedReports = new Set(['session-start', 'scheduler-batch', 'accepted-A', 'spa-navigation', 'stop-ack', 'retained-A', 'accepted-B', 'stop-B', 'cleanup', 'final-dom', 'error',
  'stale-reply-held', 'stale-reply-released', 'stale-batch-rejected']);
const ownerCode = error => ['PROTOCOL_ERROR', 'TIMEOUT', 'TEARDOWN', 'PROVIDER_ERROR', 'DOM_MISMATCH'].includes(error?.code) ? error.code : 'PROTOCOL_ERROR';

function routesFor(fixtureUrl) {
  let url;
  try { url = new URL(fixtureUrl); } catch { throw new TypeError('fixtureUrl must be canonical loopback HTTP.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new TypeError('fixtureUrl must be canonical loopback HTTP at an explicit port and path /.');
  }
  return { A: url.origin + '/', B: url.origin + '/replacement' };
}
function validateConfig(config) {
  // The test-only harness Vite build keeps the auth token out of the content
  // bundle; the background brokers every authenticated collector call, so a
  // missing token is the supported configuration and a present token must be
  // well formed.
  const token = config?.authToken;
  if (!config || !idValid(config.runId) || (token !== undefined && !/^[a-f\d]{64,}$/i.test(token))
      || typeof config.expectedExtensionId !== 'string' || !config.expectedExtensionId
      || (config.expectedTabId !== null && (!Number.isSafeInteger(config.expectedTabId) || config.expectedTabId < 0))
      || config.expectedDocumentId === undefined || (config.expectedDocumentId !== null
        && (typeof config.expectedDocumentId !== 'string' || !config.expectedDocumentId || config.expectedDocumentId.length > 256))) {
    throw new TypeError('Invalid replacement content configuration.');
  }
  return routesFor(config.fixtureUrl);
}
function targetId(node) {
  const element = node?.nodeType === 1 ? node : node?.nodeType === 2 ? node.ownerElement : node?.parentElement;
  return element?.closest?.('[data-bench-id]')?.dataset?.benchId ?? null;
}
function readTarget(element) {
  return element?.dataset?.benchKind === 'title' ? element.getAttribute('title') : element?.textContent ?? null;
}
function sha256(value) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)).then(bytes =>
    [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''));
}
function errorCode(error) { return ownerCode(error); }

/**
 * Phase 2C stale-success reply texts: the background's successful
 * PAGE_TRANSLATE_BATCH reply carries translatedText as a JSON string whose
 * items are plain strings or objects carrying text/t/translatedText (the same
 * shapes production _executeBatchRequest resolves). Returns the aligned text
 * list, or null when the reply cannot be parsed for the barrier evidence.
 */
function staleReplyTexts(targetCount, translatedText) {
  let parsed;
  try { parsed = JSON.parse(translatedText); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length !== targetCount) return null;
  return parsed.map(item => typeof item === 'string' ? item
    : item && typeof item === 'object'
      ? (typeof item.text === 'string' ? item.text : typeof item.t === 'string' ? item.t
        : typeof item.translatedText === 'string' ? item.translatedText : '')
    : '');
}

/**
 * Observation-only content adapter. Requires actual production classes,
 * browser.runtime and config {runId,fixtureUrl,expectedExtensionId,
 * expectedTabId|null (null pins the bootstrap sender in the harness),
 * expectedDocumentId|null,authToken: the token is required only when the
 * harness build does not keep it out of this bundle and then only for direct
 * collector calls; the Vite test build omits it and the background brokers
 * capture-final}. Install it before importing the real content entry. It never
 * sends PAGE_TRANSLATE, synthesizes a cursor, or calls a manager start/stop API
 * itself. Reporting goes to the background bridge, which attaches the
 * Firefox-provided sender.
 */
export function createReplacementContentRuntime(config, {
  browserApi = globalThis.browser,
  PageTranslationManager,
  PageTranslationScheduler,
  PageTranslationBridge,
  FeatureManager,
  fetchImpl = globalThis.fetch,
  sendRuntimeMessage = message => browserApi.runtime.sendMessage(message),
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  MutationObserverClass = globalThis.MutationObserver,
  CustomEventClass = globalThis.CustomEvent,
  now = () => Date.now(),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const routes = validateConfig(config);
  if (!browserApi?.runtime?.sendMessage || !PageTranslationManager?.prototype || !PageTranslationScheduler?.prototype
      || !PageTranslationBridge?.prototype || !FeatureManager?.prototype || typeof fetchImpl !== 'function') {
    throw new TypeError('Replacement content adapter requires Firefox runtime and production Page feature prototypes.');
  }
  // Phase 2C stale-success delivery barrier is active only in stale mode; the
  // deadline is bounded so a missing release grant fails closed, never hangs.
  const staleSuccess = config.staleSuccess === true;
  const staleReplyTimeoutMs = config.staleReplyTimeoutMs ?? 30_000;
  if (staleSuccess && (!Number.isFinite(staleReplyTimeoutMs) || staleReplyTimeoutMs < 10 || staleReplyTimeoutMs > 60_000)) {
    throw new TypeError('Invalid stale-reply barrier deadline.');
  }
  const state = {
    installed: false, disposed: false, currentRoute: routes.A, navigationCursor: null,
    startOptions: new WeakMap(), sessions: new Map(), sessionPromises: new Map(), itemBatch: new WeakMap(),
    batches: [], acceptedByBatch: new Map(), acceptedValues: new Map(), targetBatchOwner: new Map(), acceptedA: null, acceptedB: null,
    baselineValues: new Map(), bBatchSourceValues: new Map(), acceptedBValues: new Map(), bWriteCounts: new Map(), pendingBMutationRecords: new Map(),
    retainedCount: 0, retainedReported: false, stopAck: null, stopB: null, stopBPromise: null,
    postInvalidationAWrites: new Set(), authorizedFixtureTitleUpdates: new Map(), observer: null,
    navigationStopInvoked: false, urlChangeLog: [], lastRejection: null, rejections: [], reportLog: [],
    originalRuntimeSendMessage: null, restores: [], lastError: null, cleanupReport: null, finalDOMEvidence: null,
    staleItems: new WeakMap(),
  };
  const fixtureElements = () => [...(documentRef?.querySelectorAll?.('[data-bench-id]') ?? [])];
  const elementForId = target => fixtureElements().find(element => element.dataset.benchId === target) ?? null;
  const sourceValue = target => state.bBatchSourceValues.get(target);
  const validBMutation = (target, records, translated) => {
    const source = sourceValue(target);
    if (records.length !== 1 || translated === source) return false;
    const record = records[0];
    if (record.oldValue !== source) return false;
    return (record.type === 'attributes' && record.attributeName === 'title') || record.type === 'characterData';
  };
  function observeMutationRecords(records) {
    if (!state.navigationCursor || !state.acceptedA) return;
    for (const record of records) {
      const target = targetId(record.target); if (!target) continue;
      const current = readTarget(elementForId(target));
      const fixtureUpdate = state.authorizedFixtureTitleUpdates.get(target);
      // The fixture rewrites only the pending sources right after the
      // navigation Stop; that rewrite is harness-owned and must not be
      // counted as a production write.
      if (fixtureUpdate && fixtureUpdate.count === 0 && record.oldValue === fixtureUpdate.before
          && current !== fixtureUpdate.before && windowRef.location.href === routes.B) {
        fixtureUpdate.after = current; fixtureUpdate.count++; continue;
      }
      if (state.acceptedA.targetIds.includes(target)) { state.postInvalidationAWrites.add(target); continue; }
      if (state.targetBatchOwner.get(target)?.owner === 'B' && state.bBatchSourceValues.has(target)) {
        if (state.acceptedBValues.has(target)) {
          const bRecords = state.bWriteCounts.get(target) ?? 0;
          if (!bRecords && validBMutation(target, [record], current)) { state.bWriteCounts.set(target, 1); continue; }
          state.postInvalidationAWrites.add(target); continue;
        }
        const waiting = state.pendingBMutationRecords.get(target) ?? []; waiting.push({ type: record.type, attributeName: record.attributeName, oldValue: record.oldValue });
        state.pendingBMutationRecords.set(target, waiting); continue;
      }
      if (state.targetBatchOwner.get(target)?.owner === 'A') state.postInvalidationAWrites.add(target);
    }
    if (state.acceptedB && [...state.authorizedFixtureTitleUpdates.values()].every(item => item.count === 1)) void maybeReportCleanup().catch(emitError);
  }
  function prepareAuthorizedFixtureTitleUpdates() {
    if (!state.acceptedA || !state.navigationCursor || state.authorizedFixtureTitleUpdates.size) {
      return { ok: false, reason: `preconditions (acceptedA=${!!state.acceptedA}, cursor=${!!state.navigationCursor}, prepared=${state.authorizedFixtureTitleUpdates.size})` };
    }
    // The pending set is exactly what production left unaccepted, so it comes
    // from the observed Scheduler batches instead of an assumed fixture split.
    const seen = new Set(state.batches.filter(batch => batch.owner === 'A').flatMap(batch => batch.targetIds));
    const pendingIds = Array.from({ length: 12 }, (_, index) => `target-${index}`)
      .filter(id => !state.acceptedA.targetIds.includes(id));
    if (!pendingIds.length || pendingIds.some(id => !seen.has(id))) {
      return { ok: false, reason: `pending=${JSON.stringify(pendingIds)} observedA=${JSON.stringify([...seen])} accepted=${JSON.stringify(state.acceptedA.targetIds)}` };
    }
    for (const target of pendingIds) {
      const element = elementForId(target);
      if (!element) return { ok: false, reason: `pending target ${target} is not present` };
      state.authorizedFixtureTitleUpdates.set(target, { before: readTarget(element), count: 0 });
    }
    // Publish the pending ids so the fixture changes exactly those sources and
    // leaves already accepted A translations untouched.
    try {
      documentRef?.documentElement?.setAttribute('data-translate-it-replacement-pending', pendingIds.join(','));
    } catch { /* The document may be gone. */ }
    return { ok: true };
  }
  const evidenceExact = (event, evidence) => {
    const keys = replacementEventSchemas[event];
    return !!keys && exact(evidence, keys);
  };
  const publishDiagnostics = () => {
    try {
      documentRef?.documentElement?.setAttribute('data-translate-it-replacement-url-change-log', JSON.stringify({
        log: state.urlChangeLog, lastRejection: state.lastRejection, rejections: state.rejections, reportLog: state.reportLog }));
    } catch { /* The document may be gone. */ }
  };
  const report = async (event, evidence) => {
    if (state.disposed || !allowedReports.has(event) || !evidenceExact(event, evidence)) return false;
    let response;
    try { response = await browserApi.runtime.sendMessage({ action: replacementContentEventAction, v: VERSION, runId: config.runId, event, evidence }); }
    catch (error) {
      state.reportLog.push({ event, outcome: 'threw', message: String(error?.message ?? error).slice(0, 200) });
      publishDiagnostics();
      throw error;
    }
    if (!exact(response, ['v', 'runId', 'accepted', 'seq']) || response.v !== VERSION || response.runId !== config.runId
        || response.accepted !== true || !Number.isSafeInteger(response.seq) || response.seq < 1) {
      // A rejected report carries the background's reason; it is evidence, not
      // a protocol error of this adapter.
      const reason = typeof response?.reason === 'string' ? response.reason : 'unacknowledged';
      state.rejections.push({ event, reason, raw: typeof response === 'object' && response !== null ? Object.keys(response) : typeof response });
      state.lastRejection = { event, reason, raw: typeof response === 'object' && response !== null ? Object.keys(response) : typeof response };
      state.lastError = new Error(`Authenticated content report ${event} was rejected: ${reason}`);
      state.reportLog.push({ event, outcome: 'rejected', reason });
      publishDiagnostics();
      return false;
    }
    state.reportLog.push({ event, outcome: 'accepted', seq: response.seq });
    publishDiagnostics();
    return true;
  };
  const emitError = error => {
    if (state.lastError) return Promise.resolve(false);
    const code = ownerCode(error); state.lastError = new Error(code);
    // Surface the concrete reason to the page realm so the runner reports the
    // actual failure instead of a generic protocol error.
    try { documentRef?.documentElement?.setAttribute('data-translate-it-replacement-error', String(error?.message ?? code).slice(0, 300)); } catch { /* The document may be gone. */ }
    return report('error', { code }).catch(() => false);
  };
  const currentManager = () => FeatureManager.getInstance?.().getFeatureHandler?.('pageTranslation') ?? null;

  async function waitForSeedReady({ timeoutMs = 15_000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('Seed-ready deadline is invalid.');
    const end = now() + timeoutMs;
    while (now() < end) {
      try {
        const value = await browserApi.runtime.sendMessage({ action: replacementContentStatusAction, v: VERSION, runId: config.runId, type: 'status' });
        if (exact(value, ['v', 'runId', 'seeded', 'currentRoute', 'navigationCursor', 'stopAckObserved', 'worker'])
            && value.v === VERSION && value.runId === config.runId && value.seeded === true && value.currentRoute === routes.A
            && value.stopAckObserved === false) return true;
      } catch { /* Background entry seeds settings before it acknowledges content readiness. */ }
      await wait(Math.min(50, Math.max(1, end - now())));
    }
    throw new Error('Timed out waiting for auto-rule storage seeding before content initialization.');
  }

  async function ensureSessionStart(manager, sessionId, options = {}) {
    if (!manager || !idValid(sessionId)) return false;
    if (state.sessions.has(sessionId)) return state.sessionPromises.get(sessionId) ?? true;
    if (state.sessionPromises.has(sessionId)) return state.sessionPromises.get(sessionId);
    const currentUrl = windowRef.location.href;
    const owner = currentUrl === routes.A ? 'A' : currentUrl === routes.B ? 'B' : null;
    const settings = manager.settings ?? {};
    const autoTranslateOnDomChanges = settings.autoTranslateOnDOMChanges === true;
    if (!owner || options?.isAuto !== true || !autoTranslateOnDomChanges) return false;
    const preserveAcceptedTranslations = options.preserveAcceptedTranslations === true;
    const cursor = owner === 'B' ? state.navigationCursor : (options.navigationCursor ?? null);
    if (owner === 'B' && (!cursor || cursor.url !== routes.B || preserveAcceptedTranslations !== true)) return false;
    if (owner === 'A' && preserveAcceptedTranslations) return false;
    const evidence = { owner, sessionId, currentUrl, isAuto: true, autoTranslateOnDomChanges,
      preserveAcceptedTranslations, cursor };
    const pending = report('session-start', evidence).then(accepted => {
      if (!accepted) return false;
      state.sessions.set(sessionId, { owner, currentUrl, preserveAcceptedTranslations });
      return owner === 'B' ? waitForRetained(sessionId) : true;
    });
    state.sessionPromises.set(sessionId, pending);
    return pending;
  }

  async function maybeReportRetained(sessionId) {
    if (state.retainedReported || !state.acceptedA || state.retainedCount !== state.acceptedA.targetIds.length) return false;
    const retainedIds = [...state.acceptedA.targetIds];
    const unchanged = retainedIds.every(id => readTarget(elementForId(id)) === state.acceptedValues.get(id));
    if (!unchanged) { await emitError(new Error('Accepted A DOM changed before B retention observation.')); return false; }
    const accepted = await report('retained-A', { sessionId, sourceSessionId: state.acceptedA.sessionId, targetIds: retainedIds });
    if (accepted) state.retainedReported = true;
    return accepted;
  }
  async function waitForAdmittedProviderSettlement(batch, timeoutMs = 15_000) {
    const end = now() + timeoutMs;
    while (now() < end) {
      const value = await browserApi.runtime.sendMessage({ action: replacementContentStatusAction, v: VERSION, runId: config.runId, type: 'status' });
      const matching = value?.worker?.attempts?.filter(item => item.owner === batch.owner && item.sessionId === batch.sessionId && item.messageId === batch.messageId) ?? [];
      if (matching.length === 1) {
        const attempt = matching[0];
        if (attempt.settled && attempt.rootSettled) {
          return attempt.outcome === 'fulfilled' && attempt.code === null && attempt.rootStatus === 'fulfilled' && attempt.rootCode === null;
        }
      }
      await wait(Math.min(30, Math.max(1, end - now())));
    }
    return false;
  }
  async function waitForRetained(sessionId, timeoutMs = 10_000) {
    const end = now() + timeoutMs;
    while (now() < end) {
      if (await maybeReportRetained(sessionId)) return true;
      await wait(Math.min(25, Math.max(1, end - now())));
    }
    await emitError(new Error('Production B initialization did not retain the accepted A targets.'));
    return false;
  }

  function observeAcceptedSettlement(item, outcome) {
    const batch = item && state.itemBatch.get(item);
    const target = targetId(item?.node);
    if (!batch || !target || !idPattern.test(target) || outcome !== 'accepted') return;
    if (batch.owner === 'A') {
      const current = readTarget(elementForId(target));
      if (current === state.baselineValues.get(target)) { void emitError(new Error('A Scheduler accepted target has no observed DOM translation.')); return; }
      state.acceptedValues.set(target, current);
    }
    const accepted = state.acceptedByBatch.get(batch.messageId) ?? new Set();
    const currentValue = readTarget(elementForId(target));
    if (batch.owner === 'B') {
      const source = state.bBatchSourceValues.get(target);
      state.acceptedBValues.set(target, currentValue);
      const queued = state.pendingBMutationRecords.get(target) ?? [];
      if (queued.length) {
        if (validBMutation(target, queued, currentValue)) state.bWriteCounts.set(target, 1);
        else state.postInvalidationAWrites.add(target);
        state.pendingBMutationRecords.delete(target);
      }
      if (source === undefined) state.postInvalidationAWrites.add(target);
    }
    accepted.add(target); state.acceptedByBatch.set(batch.messageId, accepted);
    if (accepted.size !== batch.targetIds.length || !batch.targetIds.every(id => accepted.has(id))) return;
    void (async () => {
      if (batch.owner === 'A') {
        if (state.acceptedA) return;
        if (!await waitForAdmittedProviderSettlement(batch)) { await emitError(new Error('A acceptance preceded admitted physical/Provider-root settlement evidence.')); return; }
        const ok = await report('accepted-A', { sessionId: batch.sessionId, messageId: batch.messageId, targetIds: [...batch.targetIds] });
        if (!ok) return;
        state.acceptedA = { sessionId: batch.sessionId, messageId: batch.messageId, targetIds: [...batch.targetIds] };
      } else {
        if (state.acceptedB) return;
        if (!await waitForAdmittedProviderSettlement(batch)) { await emitError(new Error('B acceptance preceded admitted physical/Provider-root settlement evidence.')); return; }
        state.processMutationRecords?.(state.observer?.takeRecords?.() ?? []);
        const domAccepted = batch.targetIds.every(id => state.acceptedBValues.has(id)
          && state.acceptedBValues.get(id) !== state.bBatchSourceValues.get(id) && state.bWriteCounts.get(id) === 1);
        if (!domAccepted) { await emitError(new Error('B Scheduler settlement lacks matching production DOM mutation evidence.')); return; }
        const ok = await report('accepted-B', { sessionId: batch.sessionId, messageId: batch.messageId, targetIds: [...batch.targetIds], source: 'provider' });
        if (ok) state.acceptedB = { sessionId: batch.sessionId, messageId: batch.messageId, targetIds: [...batch.targetIds] };
      }
      await maybeReportCleanup();
    })().catch(emitError);
  }

  // Phase 2C stale-success delivery barrier: the stale batch's genuine success
  // reply is captured exactly once (never re-sent, never modified) and held
  // until the brokered release-stale control is granted. A rejected send or a
  // non-successful reply passes straight through; only the overall deadline is
  // fatal, and it fails closed through the adapter error path.
  async function failBarrier(barrier, message, code = 'PROTOCOL_ERROR') {
    const error = Object.assign(new Error(message), { code });
    await emitError(error);
    barrier.rejectGate(error);
  }
  async function runStaleBarrier(barrier, callOriginal) {
    let reply;
    try { reply = await callOriginal(); }
    catch (error) { barrier.rejectGate(error); return; }
    if (reply?.success !== true || reply?.hasError === true) { barrier.resolveGate(reply); return; }
    const texts = staleReplyTexts(barrier.targetIds.length, reply.translatedText);
    if (texts === null) { await failBarrier(barrier, 'Stale batch reply could not be parsed for the delivery barrier.'); return; }
    barrier.replyTexts = texts;
    // The hold is only reported once the Provider settlement of this batch is
    // admitted as a clean fulfilled success: the reply is captured before the
    // Provider-root settlement reaches the collector, and the collector admits
    // the hold only after that evidence.
    if (!await waitForAdmittedProviderSettlement(barrier.record, 15_000)) {
      await failBarrier(barrier, 'The stale batch Provider settlement was not admitted as a clean fulfilled success.');
      return;
    }
    const held = await report('stale-reply-held', { sessionId: barrier.sessionId, messageId: barrier.messageId,
      targetIds: [...barrier.targetIds], replyItemCount: texts.length, replyHash: await sha256(JSON.stringify(texts)) }).catch(error => error);
    if (held !== true) {
      await failBarrier(barrier, held instanceof Error ? `Stale-reply-held report failed: ${held.message}` : 'Stale-reply-held evidence was not admitted.');
      return;
    }
    barrier.held = true;
    const end = now() + staleReplyTimeoutMs;
    while (now() < end) {
      try {
        const receipt = await browserApi.runtime.sendMessage({ action: replacementContentStatusAction, v: VERSION, runId: config.runId, type: 'release-stale' });
        if (exact(receipt, ['v', 'runId', 'type']) && receipt.v === VERSION && receipt.runId === config.runId && receipt.type === 'release-stale') {
          barrier.resolveGate(reply);
          void report('stale-reply-released', { sessionId: barrier.sessionId, messageId: barrier.messageId }).catch(emitError);
          return;
        }
      } catch { /* An ungranted release control is the expected pre-grant state; only the deadline is fatal. */ }
      await wait(Math.min(15, Math.max(1, end - now())));
    }
    await failBarrier(barrier, 'Timed out waiting for the stale-reply release grant.', 'TIMEOUT');
  }
  async function verifyStaleRejection(barrier) {
    if (barrier.verified) return;
    barrier.verified = true;
    const problems = [];
    if (barrier.settlements.length !== barrier.targetIds.length) problems.push(`settled ${barrier.settlements.length} of ${barrier.targetIds.length} stale items`);
    barrier.settlements.forEach((entry, index) => {
      if (entry.outcome !== 'cancelled') problems.push(`stale item ${index} settled as ${entry.outcome}`);
      if (entry.text !== barrier.sourceTexts[index]) problems.push(`stale item ${index} was not settled with its original source text`);
      else if (entry.text === barrier.replyTexts[index]) problems.push(`stale item ${index} was settled with the provider translation`);
    });
    if (problems.length) {
      await emitError(Object.assign(new Error(`Stale batch was not rejected by the Scheduler: ${problems.join('; ')}`), { code: 'PROTOCOL_ERROR' }));
      return;
    }
    if (!await report('stale-batch-rejected', { sessionId: barrier.sessionId, messageId: barrier.messageId,
      targetIds: [...barrier.targetIds], outcome: 'cancelled' })) {
      await emitError(Object.assign(new Error('Stale-batch-rejected evidence was not admitted.'), { code: 'PROTOCOL_ERROR' }));
    }
  }

  function installRuntimeBatchObserver() {
    const runtime = browserApi.runtime; const original = runtime.sendMessage;
    if (typeof original !== 'function') throw new Error('Firefox runtime.sendMessage is unavailable.');
    state.originalRuntimeSendMessage = original;
    runtime.sendMessage = function (message, ...args) {
      const batch = state.activeBatch;
      if (message?.action !== MessageActions.PAGE_TRANSLATE_BATCH || !batch) return original.call(this, message, ...args);
      let parsed;
      try { parsed = JSON.parse(message.data?.text); } catch { parsed = null; }
      const mappedInternalIds = Array.isArray(parsed) ? parsed.map(item => item?.id) : [];
      const targetIds = [...batch.targetIds];
      if (!idValid(message.messageId) || !idValid(message.data?.sessionId) || batch.sessionId !== message.data.sessionId
          || mappedInternalIds.length !== batch.internalIds.length || mappedInternalIds.some((id, index) => id !== batch.internalIds[index])
          || targetIds.length !== mappedInternalIds.length || targetIds.some(id => !idPattern.test(id))) {
        void emitError(new Error('Observed Scheduler request did not correlate to its active production batch.'));
        return original.call(this, message, ...args);
      }
      const record = { owner: batch.owner, sessionId: message.data.sessionId, messageId: message.messageId, targetIds };
      const callOriginal = () => original.call(this, message, ...args);
      const telemetry = ensureSessionStart(batch.manager, record.sessionId, batch.options).then(async started => {
        if (!started) return false;
        const accepted = await report('scheduler-batch', record);
        if (accepted) {
          state.batches.push(record);
          for (const target of record.targetIds) state.targetBatchOwner.set(target, { owner: record.owner, sessionId: record.sessionId });
          if (record.owner === 'B') for (const target of record.targetIds) state.bBatchSourceValues.set(target, readTarget(elementForId(target)));
          for (const item of batch.items) state.itemBatch.set(item, record);
        }
        return accepted;
      }).catch(error => {
        void emitError(error);
      });
      // Telemetry failure never invokes the production send twice. The one
      // call-through runs after the bounded report attempt regardless of its
      // outcome; its result/rejection is returned unchanged.
      // Phase 2C stale-success delivery barrier: the SECOND A batch is the
      // stale one. It is identified by the admitted A-batch ordinal, not by
      // `acceptedA`: production creates the next A batch before the previous
      // batch's DOM acceptance is reported, so the accepted-A evidence is not
      // available yet when this message is sent. The original sendMessage is
      // called exactly once and the captured reply value is resolved unchanged
      // once the broker grants the release; every other message passes through.
      const admittedABatches = state.batches.filter(item => item.owner === 'A').length;
      const isStaleBatch = record.owner === 'A' && admittedABatches === 1
        && (!state.acceptedA || record.messageId !== state.acceptedA.messageId);
      if (config.staleSuccess === true && isStaleBatch) {
        const barrier = { sessionId: record.sessionId, messageId: record.messageId, targetIds, record,
          sourceTexts: batch.items.map(item => typeof item?.text === 'string' ? item.text : null),
          settlements: [], replyTexts: null, held: false, verified: false, resolveGate: null, rejectGate: null };
        for (const item of batch.items) state.staleItems.set(item, barrier);
        batch.staleBarrier = barrier;
        const gate = new Promise((resolve, reject) => { barrier.resolveGate = resolve; barrier.rejectGate = reject; });
        void telemetry.then(() => runStaleBarrier(barrier, callOriginal)).catch(error => {
          void emitError(error); barrier.rejectGate?.(error);
        });
        return gate;
      }
      return telemetry.then(callOriginal);
    };
    state.restores.push(() => { if (runtime.sendMessage === wrappedRuntimeSend) runtime.sendMessage = original; });
    const wrappedRuntimeSend = runtime.sendMessage;
  }

  function installManagerHooks() {
    const managerProto = PageTranslationManager.prototype;
    const originalTranslate = managerProto.translatePage;
    if (typeof originalTranslate !== 'function') throw new Error('Production PageTranslationManager.translatePage is unavailable.');
    const wrappedTranslate = function (options = {}) {
      state.startOptions.set(this, options);
      const result = originalTranslate.apply(this, arguments);
      if (result && typeof result.then === 'function') {
        return result.then(value => {
          if (value?.success === true && typeof value.messageId === 'string') {
            void ensureSessionStart(this, value.messageId, options).catch(emitError);
          }
          return value;
        });
      }
      if (result?.success === true && typeof result.messageId === 'string') void ensureSessionStart(this, result.messageId, options).catch(emitError);
      return result;
    };
    managerProto.translatePage = wrappedTranslate;
    state.restores.push(() => { if (managerProto.translatePage === wrappedTranslate) managerProto.translatePage = originalTranslate; });

    const originalStop = managerProto.stopAutoTranslation;
    const wrappedStop = function (options = {}) {
      const navigationStop = replacementCancellationReasons.includes(options?.cancellationReason) && state.navigationCursor !== null;
      const shouldReport = navigationStop;
      const expectedSessionId = this.acceptedLifecycleSessionId ?? this.translationMessageId;
      const result = originalStop.apply(this, arguments);
      if (navigationStop) state.navigationStopInvoked = true;
      if (!shouldReport || !result || typeof result.then !== 'function') return result;
      return result.then(value => {
        // Production identifies the stopped session by its attempt id, while
        // the harness session id is the one reported at session start. The
        // stop-ack evidence must carry the harness session id so the collector
        // can bind it to the session it pinned.
        const harnessSessionId = [...state.sessions.entries()].find(([, session]) => session.owner === 'A')?.[0] ?? value.sessionId;
        if (value?.success === true && value.isAutoTranslating === false && value.sessionId === expectedSessionId) {
          state.stopAck = { sessionId: harnessSessionId, cursor: structuredClone(state.navigationCursor) };
          void report('stop-ack', { sessionId: harnessSessionId, navigationCursor: structuredClone(state.navigationCursor), success: true,
            cancellationReason: options.cancellationReason, resultSessionId: harnessSessionId, isAutoTranslating: false }).catch(emitError);
        }
        return value;
      });
    };
    managerProto.stopAutoTranslation = wrappedStop;
    state.restores.push(() => { if (managerProto.stopAutoTranslation === wrappedStop) managerProto.stopAutoTranslation = originalStop; });

    const originalCheck = FeatureManager.prototype.checkForUrlChange;
    if (typeof originalCheck !== 'function') throw new Error('Production FeatureManager.checkForUrlChange is unavailable.');
    const wrappedCheck = function (navigation = {}) {
      const cursor = navigation?.navigationCursor;
      // Ordering evidence: production may detect the same-document route change
      // in-page (its own URL-change observer) before the trusted background
      // cursor arrives, and only the trusted cursor carries the SPA cursor.
      state.urlChangeLog.push({
        trusted: !!cursor,
        cursorUrl: cursor?.url ?? null,
        cursorRevision: cursor?.routeRevision ?? null,
        cursorEpoch: cursor?.documentEpoch ?? null,
        appliedRevision: state.navigationCursor?.routeRevision ?? null,
        appliedEpoch: state.navigationCursor?.documentEpoch ?? null,
        locationHref: windowRef.location.href,
        routesB: routes.B,
        lastDetectedUrl: this._lastDetectedUrl ?? null,
        featureCursor: this.navigationCursor ? { ...this.navigationCursor } : null,
      });
      if (state.urlChangeLog.length > 8) state.urlChangeLog.shift();
      // The content realm is invisible to the page, so the ordering evidence is
      // published as a DOM attribute the runner can read.
      publishDiagnostics();
      const trusted = cursor && cursor.url === windowRef.location.href && cursor.url === routes.B
        && Number.isSafeInteger(cursor.documentEpoch) && cursor.documentEpoch > 0
        && Number.isSafeInteger(cursor.routeRevision) && cursor.routeRevision >= 0;
      if (!trusted) return originalCheck.apply(this, arguments);
      // Firefox can deliver the same trusted cursor more than once. Production
      // only acts on a strictly newer cursor, so the observation must as well;
      // a repeat must not be reported as a second navigation.
      const applied = state.navigationCursor;
      const isNewer = !applied || cursor.documentEpoch > applied.documentEpoch
        || (cursor.documentEpoch === applied.documentEpoch && cursor.routeRevision > applied.routeRevision);
      if (!isNewer) return originalCheck.apply(this, arguments);
      const fromUrl = this._lastDetectedUrl;
      const evidence = { fromUrl, toUrl: cursor.url, cursor: { documentEpoch: cursor.documentEpoch, routeRevision: cursor.routeRevision, url: cursor.url } };
      const telemetry = report('spa-navigation', evidence).then(accepted => {
        if (!accepted) throw new Error('Trusted production SPA cursor report was not accepted.');
      }).catch(emitError);
      // This cursor came from FeatureManager's trusted production input. Record
      // it locally before synchronous invalidation; collector route state is
      // advanced independently only after the report is authenticated.
      state.navigationCursor = structuredClone(evidence.cursor); state.currentRoute = routes.B;
      state.navigationStopInvoked = false;
      let result;
      try { result = originalCheck.apply(this, arguments); }
      catch (error) { void telemetry; throw error; }
      state.urlChangeLog.push({
        trusted: 'after',
        stopInvoked: state.navigationStopInvoked,
        lastDetectedUrl: this._lastDetectedUrl ?? null,
        featureCursor: this.navigationCursor ? { ...this.navigationCursor } : null,
      });
      if (state.urlChangeLog.length > 12) state.urlChangeLog.shift();
      publishDiagnostics();
      if (state.navigationStopInvoked) {
        const prepared = prepareAuthorizedFixtureTitleUpdates();
        if (!prepared.ok) void emitError(new Error(`Fixture invalidation did not resolve the exact pending title targets: ${prepared.reason}`));
        else {
          try { windowRef.dispatchEvent(new CustomEventClass(replacementInvalidatedDomEvent)); }
          catch (error) { void emitError(error); }
        }
      } else {
        void emitError(new Error('Production URL reevaluation did not synchronously invoke navigation Stop.'));
      }
      void telemetry;
      return result;
    };
    FeatureManager.prototype.checkForUrlChange = wrappedCheck;
    state.restores.push(() => { if (FeatureManager.prototype.checkForUrlChange === wrappedCheck) FeatureManager.prototype.checkForUrlChange = originalCheck; });
  }

  function installSchedulerHooks() {
    const schedulerProto = PageTranslationScheduler.prototype;
    const originalExecute = schedulerProto._executeBatchRequest;
    const originalSettlement = schedulerProto._createSettlement;
    if (typeof originalExecute !== 'function' || typeof originalSettlement !== 'function') throw new Error('Production Scheduler observation boundaries are unavailable.');
    const wrappedExecute = function (batch, configArg, context, sessionId, ...rest) {
      const manager = currentManager(); const options = manager ? state.startOptions.get(manager) : null;
      const targetIds = Array.isArray(batch) ? batch.map(item => targetId(item?.node)) : [];
      const internalIds = Array.isArray(batch) ? batch.map(item => item?.id) : [];
      const url = windowRef.location.href;
      const owner = url === routes.A ? 'A' : url === routes.B ? 'B' : null;
      const record = owner && manager && typeof sessionId === 'string' && targetIds.length && internalIds.every(idValid)
        ? { owner, manager, options, sessionId, items: batch, targetIds, internalIds } : null;
      const previous = state.activeBatch; state.activeBatch = record;
      let result;
      try { result = originalExecute.call(this, batch, configArg, context, sessionId, ...rest); }
      finally { state.activeBatch = previous; }
      // Phase 2C: when the Scheduler's promise for the held stale batch settles,
      // its ownership check has finished; verify the discard evidence and report
      // the production rejection once.
      const barrier = record?.staleBarrier;
      if (barrier && result && typeof result.then === 'function') {
        result.then(() => { if (barrier.held === true) void verifyStaleRejection(barrier); },
          () => { /* A barrier failure already surfaced through the adapter error path. */ });
      }
      return result;
    };
    const wrappedSettlement = function (item, ...rest) {
      const settlement = originalSettlement.call(this, item, ...rest); const settle = settlement?.settle;
      if (typeof settle !== 'function') return settlement;
      // Phase 2C: capture each stale item's settled text and outcome so the
      // release verification can prove the ownership check discarded the batch.
      const staleBarrier = config.staleSuccess === true ? state.staleItems.get(item) ?? null : null;
      const staleEntry = staleBarrier ? { text: rest[0] ?? null, outcome: null } : null;
      if (staleEntry) staleBarrier.settlements.push(staleEntry);
      settlement.settle = function (outcome) {
        const result = settle.call(this, outcome);
        if (result === true) {
          if (staleEntry) staleEntry.outcome = outcome;
          observeAcceptedSettlement(item, outcome);
        }
        return result;
      };
      return settlement;
    };
    schedulerProto._executeBatchRequest = wrappedExecute; schedulerProto._createSettlement = wrappedSettlement;
    state.restores.push(() => { if (schedulerProto._executeBatchRequest === wrappedExecute) schedulerProto._executeBatchRequest = originalExecute; });
    state.restores.push(() => { if (schedulerProto._createSettlement === wrappedSettlement) schedulerProto._createSettlement = originalSettlement; });
  }

  function installRetainedHook() {
    const prototype = PageTranslationBridge.prototype; const original = prototype.initialize;
    if (typeof original !== 'function') throw new Error('Production PageTranslationBridge.initialize is unavailable.');
    const wrapped = function (settings, translate, context, callbacks = {}, ...rest) {
      if (typeof callbacks?.onRetainedTranslation !== 'function') return original.call(this, settings, translate, context, callbacks, ...rest);
      const previous = callbacks.onRetainedTranslation;
      callbacks.onRetainedTranslation = function (...args) {
        if (windowRef.location.href === routes.B && state.navigationCursor) state.retainedCount++;
        return previous.apply(this, args);
      };
      return original.call(this, settings, translate, context, callbacks, ...rest);
    };
    prototype.initialize = wrapped;
    state.restores.push(() => { if (prototype.initialize === wrapped) prototype.initialize = original; });
  }

  function installMutationObserver() {
    if (!MutationObserverClass || !documentRef?.body) return false;
    state.processMutationRecords = observeMutationRecords;
    state.observer = new MutationObserverClass(observeMutationRecords);
    state.observer.observe(documentRef.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true,
      attributes: true, attributeOldValue: true, attributeFilter: ['title'] });
    return true;
  }

  function productionActivity(manager) {
    const scheduler = manager?.scheduler; const bridgeSession = manager?.bridge?.session; const discovery = bridgeSession?.discovery;
    if (!scheduler || !bridgeSession || typeof bridgeSession.active !== 'boolean'
        || typeof discovery?.pending !== 'boolean' || typeof discovery?.running !== 'boolean' || typeof discovery?.starting !== 'boolean'
        || !Array.isArray(discovery.queue) || !Number.isInteger(discovery.head)) return null;
    const discoveryActive = discovery.pending || discovery.running || discovery.starting || discovery.queue.length > discovery.head;
    const workPending = manager.isTranslating === true || scheduler.activeFlushes !== 0 || scheduler.queue?.length !== 0
      || scheduler.activeBatches?.size !== 0 || scheduler.pendingSettlements?.size !== 0;
    const schedulerActive = manager.isTranslating === true || manager.isAutoTranslating === true
      || scheduler.isTranslated === true || workPending;
    return { bridgeActive: bridgeSession.active, schedulerActive: !!schedulerActive, discoveryActive: !!discoveryActive, workPending: !!workPending };
  }
  async function waitForProductionIdle(timeoutMs = 15_000) {
    const end = now() + timeoutMs;
    while (now() < end) {
      const activity = productionActivity(currentManager());
      if (activity && !activity.workPending && !activity.discoveryActive) return activity;
      await wait(Math.min(30, Math.max(1, end - now())));
    }
    return null;
  }
  async function waitForWorkerQuiescence(timeoutMs = 15_000) {
    const value = await browserApi.runtime.sendMessage({ action: replacementContentStatusAction, v: VERSION,
      runId: config.runId, type: 'wait-quiescence', timeoutMs });
    if (!exact(value, ['v', 'runId', 'seeded', 'currentRoute', 'navigationCursor', 'stopAckObserved', 'worker'])
        || value.v !== VERSION || value.runId !== config.runId || value.seeded !== true || value.currentRoute !== routes.B
        || value.stopAckObserved !== true || value.worker?.pendingPhysical !== 0 || value.worker?.pendingRoots !== 0
        || value.worker?.attempts?.length !== 3) throw new Error('Worker physical/Provider-root quiescence evidence was incomplete.');
    return value.worker;
  }
  // Harness-only probe: count every live-session observer the production
  // teardown must release. Reads are non-mutating; wrappers restore themselves.
  function sessionObserverReleaseTargets(manager) {
    const targets = []; const add = value => { if (value && typeof value.disconnect === 'function') targets.push(value); };
    const session = manager?.bridge?.session;
    for (const observer of session?.persistentTranslator?.observedNodesStorage?.values?.() ?? []) add(observer);
    add(session?.shadowDiscoveryObserver);
    if (session?.shadowRoots) for (const shadowRoot of session.shadowRoots.values()) add(shadowRoot?.observer);
    add(session?.intersectionScheduler?.intersectionObserver?.intersectionObserver);
    return targets;
  }
  function instrumentSessionObserverRelease(manager) {
    const targets = sessionObserverReleaseTargets(manager);
    const release = { expected: targets.length, released: 0, failed: 0 };
    const installed = targets.map(target => {
      const original = target.disconnect;
      const owned = Object.prototype.hasOwnProperty.call(target, 'disconnect');
      target.disconnect = function (...args) {
        try {
          const value = original.apply(this, args);
          release.released++;
          return value;
        } catch (error) { release.failed++; throw error; }
      };
      return { target, original, owned };
    });
    return { release, restore() {
      for (const { target, original, owned } of installed) {
        if (owned === false) delete target.disconnect; else target.disconnect = original;
      }
    } };
  }
  async function maybeReportCleanup() {
    if (state.cleanupReport || !state.acceptedB || !state.acceptedA || !state.stopAck) return false;
    if (state.stopBPromise) return state.stopBPromise;
    const pendingUpdates = [...state.authorizedFixtureTitleUpdates.values()].some(item => item.count !== 1);
    const pendingBUpdates = state.acceptedB.targetIds.some(id => state.bWriteCounts.get(id) !== 1 || state.pendingBMutationRecords.has(id));
    if (pendingUpdates || pendingBUpdates || state.postInvalidationAWrites.size) return false;
    state.stopBPromise = (async () => {
      const beforeStop = await waitForProductionIdle();
      if (!beforeStop || beforeStop.workPending || beforeStop.discoveryActive) throw new Error('B Scheduler/discovery work did not drain before Stop B.');
      await waitForWorkerQuiescence();

      // The real content command path ends B only after its provider/DOM work has settled.
      const release = instrumentSessionObserverRelease(currentManager());
      let observerRelease; let stopResult; let mainResponse; let stoppedActivity;
      try {
        stopResult = await sendRuntimeMessage({ action: MessageActions.PAGE_TRANSLATE_STOP_AUTO,
          context: MessageContexts.PAGE_TRANSLATION_UI, data: { sessionId: state.acceptedB.sessionId } });
        mainResponse = Array.isArray(stopResult?.responses)
          ? stopResult.responses.find(response => response?.sessionId === state.acceptedB.sessionId) : null;
        if (stopResult?.success !== true || !mainResponse || mainResponse.success !== true || mainResponse.sessionId !== state.acceptedB.sessionId
            || mainResponse.isAutoTranslating !== false) throw new Error('Production B Stop command did not acknowledge the registered B session.');
        stoppedActivity = productionActivity(currentManager());
        if (!stoppedActivity || stoppedActivity.bridgeActive !== false || stoppedActivity.schedulerActive !== false || stoppedActivity.discoveryActive !== false) {
          throw new Error('Production B Stop did not leave Bridge, Scheduler, and discovery inactive.');
        }
        observerRelease = structuredClone(release.release);
      } finally { release.restore(); }
      if (observerRelease.expected < 1 || observerRelease.released !== observerRelease.expected || observerRelease.failed !== 0) {
        throw new Error('Production B Stop did not release every instrumented live-session observer.');
      }
      const stopEvidence = { sessionId: state.acceptedB.sessionId, success: true, resultSessionId: mainResponse.sessionId,
        isAutoTranslating: mainResponse.isAutoTranslating, bridgeActive: stoppedActivity.bridgeActive,
        schedulerActive: stoppedActivity.schedulerActive, discoveryActive: stoppedActivity.discoveryActive, observerRelease };
      if (!await report('stop-B', stopEvidence)) throw new Error('Production B Stop evidence was not admitted.');
      state.stopB = { ...stopEvidence, observedAt: now() };

      const afterStopActivity = productionActivity(currentManager());
      const worker = await waitForWorkerQuiescence();
      if (!afterStopActivity || afterStopActivity.bridgeActive || afterStopActivity.schedulerActive || afterStopActivity.discoveryActive
          || worker.pendingPhysical !== 0 || worker.pendingRoots !== 0) throw new Error('Production resources became active again after B Stop.');
      if (!await report('cleanup', { activeOperations: 0, pendingRequests: 0, cleanupCancelledAttemptIds: [] })) {
        throw new Error('Quiescence cleanup evidence was not admitted.');
      }
      state.cleanupReport = { reported: true, at: now(), productionStopB: structuredClone(state.stopB), workerQuiescent: true };
      return true;
    })().catch(async error => { await emitError(error); return false; });
    return state.stopBPromise;
  }

  async function captureFinal({ timeoutMs = 30_000, pollMs = 50 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 || !Number.isFinite(pollMs) || pollMs < 10 || pollMs > 1000) throw new TypeError('Final capture bounds are invalid.');
    const end = now() + timeoutMs;
    // The fixture page is not the content realm's authority until the runner
    // grants capture, so the authorization call is brokered through the
    // background (which holds the token in replacement harness builds). Until
    // the broker answers, keep polling without treating any specific attempt
    // as fatal; only the overall deadline is fatal.
    let brokered = null;
    while (now() < end && brokered === null) {
      try {
        const receipt = await sendRuntimeMessage({ action: replacementContentStatusAction, v: VERSION, runId: config.runId, type: 'capture-final' });
        if (exact(receipt, ['v', 'runId', 'type']) && receipt.v === VERSION && receipt.runId === config.runId && receipt.type === 'capture-final') brokered = receipt;
      } catch { /* Race with background readiness or an ungranted capture is expected; retry. */ }
      if (brokered === null) await wait(Math.min(pollMs, Math.max(1, end - now())));
    }
    if (!brokered) throw new Error('Timed out waiting for the fixed capture-final control.');
    state.processMutationRecords?.(state.observer?.takeRecords?.() ?? []);
    const session = state.acceptedB?.sessionId;
    const targets = await Promise.all(fixtureElements().map(async element => {
      const target = element.dataset.benchId;
      return { targetId: target, owner: 'B', state: state.acceptedA?.targetIds.includes(target) ? 'retained' : 'accepted',
        hash: await sha256(String(readTarget(element) ?? '')) };
    }));
    const evidence = { sessionId: session, targets, postInvalidationAWrites: [...state.postInvalidationAWrites].sort() };
    const accepted = await report('final-dom', evidence);
    if (!accepted) throw new Error('Final DOM report was rejected.');
    state.finalDOMReported = true; state.finalDOMEvidence = structuredClone(evidence);
    return { ...evidence, capturedAt: now() };
  }

  async function install({ waitForSeed = true } = {}) {
    if (state.installed) return snapshot();
    if (waitForSeed) await waitForSeedReady();
    for (const element of fixtureElements()) {
      const id = element.dataset.benchId;
      if (idPattern.test(id) && !state.baselineValues.has(id)) state.baselineValues.set(id, readTarget(element));
    }
    installRuntimeBatchObserver(); installManagerHooks(); installSchedulerHooks(); installRetainedHook(); installMutationObserver();
    state.installed = true;
    return snapshot();
  }
  function snapshot() {
    return structuredClone({ installed: state.installed, disposed: state.disposed, currentRoute: state.currentRoute,
      navigationCursor: state.navigationCursor, batches: state.batches, acceptedA: state.acceptedA, acceptedB: state.acceptedB,
      retainedCount: state.retainedCount, retainedReported: state.retainedReported, postInvalidationAWrites: [...state.postInvalidationAWrites],
      cleanup: state.cleanupReport, finalDOMReported: state.finalDOMReported ?? false, finalDOMEvidence: state.finalDOMEvidence,
      urlChangeLog: state.urlChangeLog, lastRejection: state.lastRejection,
      lastError: state.lastError?.message ?? null });
  }
  function dispose() {
    if (state.disposed) return false;
    state.disposed = true; state.observer?.disconnect(); state.observer = null;
    const restoredHooks = state.restores.length;
    for (const restore of state.restores.reverse()) { try { restore(); } catch { /* Observer teardown cannot mask production behavior. */ } }
    state.restores.length = 0;
    return { observersDisposed: true, productionStopB: state.stopB ? structuredClone(state.stopB) : null,
      finalDOMReported: state.finalDOMReported === true, restoredHooks };
  }

  return { install, waitForSeedReady, report, captureFinal, snapshot, dispose, routes };
}

export { targetId as replacementTargetId, readTarget as readReplacementTarget };
