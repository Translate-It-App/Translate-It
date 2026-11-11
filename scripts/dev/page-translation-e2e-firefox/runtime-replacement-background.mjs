import { matchesAutoTranslateRule } from '../../../src/utils/ui/exclusion.js';
import { replacementContentEventAction, replacementContentStatusAction, replacementEventSchemas, replacementProtocol } from './runtime-replacement-protocol.mjs';

const VERSION = replacementProtocol.version;
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const boundedId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const sameArray = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
const nativeCodes = new Set(replacementProtocol.nativeCodes);

function canonicalFixtureRoutes(fixtureUrl) {
  let url;
  try { url = new URL(fixtureUrl); } catch { throw new TypeError('fixtureUrl must be canonical loopback HTTP at an explicit port.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new TypeError('fixtureUrl must be canonical loopback HTTP at an explicit port and path /.');
  }
  return { origin: url.origin, A: `${url.origin}/`, B: `${url.origin}/replacement` };
}

/**
 * Seed the persistent settings the production auto-translation path needs.
 *
 * The trusted SPA-restart path starts a session through the real
 * `PAGE_TRANSLATE` command, which carries no provider or target-language
 * override: both come from extension settings. Without these seeds the
 * Firefox defaults (a different provider and English) would be used and the
 * loopback-allowlisted Edge endpoint would never be called.
 */
export async function seedReplacementAutoSettings({ fixtureUrl, storage = globalThis.browser?.storage?.local, matchRule = matchesAutoTranslateRule } = {}) {
  if (!storage || typeof storage.set !== 'function' || typeof matchRule !== 'function') throw new TypeError('Replacement auto-settings storage/matcher is unavailable.');
  const routes = canonicalFixtureRoutes(fixtureUrl);
  // Existing rules are host/path strings (the matcher ignores ports); these two
  // exact paths cover only the fixture routes, not arbitrary loopback pages.
  const rules = ['127.0.0.1/', '127.0.0.1/replacement'];
  if (!matchRule(routes.A, rules[0]) || !matchRule(routes.B, rules[1])
      || matchRule(`${routes.origin}/other`, rules[0]) || matchRule('http://localhost/', rules[0])) {
    throw new Error('Existing auto-translation matcher rejected the exact fixture route rules.');
  }
  const settings = {
    WHOLE_PAGE_AUTO_TRANSLATE_RULES: rules,
    WHOLE_PAGE_AUTO_TRANSLATE_ON_DOM_CHANGES: true,
    TRANSLATION_API: 'edge',
    TARGET_LANGUAGE: 'fr',
    PROVIDER_OPTIMIZATION_LEVELS: { edge: 5 },
  };
  await storage.set(settings);
  return { rules, settings: Object.keys(settings), matchedRoutes: [routes.A, routes.B] };
}

function normalizeSender(sender) {
  return {
    id: sender?.id ?? null,
    tabId: sender?.tab?.id ?? sender?.tabId ?? null,
    frameId: sender?.frameId ?? null,
    url: sender?.url ?? null,
    origin: sender?.origin === undefined ? null : sender.origin,
    documentId: sender?.documentId ?? null,
  };
}

function configRoutes(config) {
  if (!config || typeof config !== 'object' || !boundedId(config.runId) || !/^[a-f\d]{64,}$/i.test(config.authToken ?? '')
      || typeof config.expectedExtensionId !== 'string' || !config.expectedExtensionId
      || (config.expectedTabId !== null && (!Number.isSafeInteger(config.expectedTabId) || config.expectedTabId < 0))
      || config.expectedDocumentId === undefined || (config.expectedDocumentId !== null
        && (typeof config.expectedDocumentId !== 'string' || !config.expectedDocumentId || config.expectedDocumentId.length > 256))) {
    throw new TypeError('Invalid replacement background configuration.');
  }
  const routes = canonicalFixtureRoutes(config.fixtureUrl);
  if (config.extensionOrigin !== undefined && (typeof config.extensionOrigin !== 'string' || !/^moz-extension:\/\/[a-z\d-]+$/i.test(config.extensionOrigin))) {
    throw new TypeError('extensionOrigin must be a canonical moz-extension origin when provided.');
  }
  return routes;
}

/**
 * Extension-background bridge for actual content sender identity and worker evidence.
 * Config: runId, authToken, fixtureUrl, expectedExtensionId, expectedTabId (a
 * safe integer, or null to pin the bootstrap tab from the first admitted A
 * session-start sender), expectedDocumentId (null until the first real A
 * MessageSender if Firefox is still on the inert binding document); optional
 * extensionOrigin. No driver/build integration is performed here. Content
 * event payloads omit sender: it is attached from the browser's real runtime
 * MessageSender before the report reaches the collector. Capture-final is
 * brokered here (the authToken lives only in the background bundle).
 */
export function createReplacementBackgroundAdapter(config, {
  browserApi = globalThis.browser,
  fetchImpl = globalThis.fetch,
  storage = browserApi?.storage?.local,
  matchRule = matchesAutoTranslateRule,
  reportTimeoutMs = 5_000,
} = {}) {
  const routes = configRoutes(config);
  if (!browserApi?.runtime?.onMessage?.addListener || typeof fetchImpl !== 'function') throw new TypeError('Replacement extension runtime/fetch is unavailable.');
  const reportUrl = `${routes.origin}${replacementProtocol.reportPath}`;
  const token = config.authToken;
  let initialized = false; let closed = false; let navigationCursor = null; let stopAckObserved = false; let pinnedSender = null; let currentSender = null;
  let currentRoute = routes.A; let sequence = 0; let reportQueue = Promise.resolve(); let listener;
  let pinnedDocumentId = config.expectedDocumentId; let bootstrapSender = null; let pendingNavigation = null;
  const transitionWaiters = new Set();
  const batches = new Map(); const invocations = new Map(); const attempts = new Map(); const reports = [];
  const eventWaiters = new Map(); const rejectedMessages = [];

  function senderIsPinned(sender, expectedUrl, { allowBootstrap = false } = {}) {
    // Firefox may not expose MessageSender.documentId for runtime messages, so
    // a null document is an accepted absence (never fabricated). Identity is
    // then pinned by extension, tab, top frame, origin and exact route.
    const identity = sender.id === config.expectedExtensionId
      && (config.expectedTabId === null || sender.tabId === config.expectedTabId) && sender.frameId === 0
      && (sender.origin === null || sender.origin === routes.origin)
      && (sender.documentId === null || (typeof sender.documentId === 'string' && sender.documentId.length > 0 && sender.documentId.length <= 256));
    if (!identity) return false;
    // Once a sender is pinned, every later message must match it exactly.
    if (pinnedSender) {
      return sender.url === pinnedSender.url
        && sender.id === pinnedSender.id && sender.tabId === pinnedSender.tabId && sender.frameId === pinnedSender.frameId
        && sender.origin === pinnedSender.origin && sender.documentId === pinnedSender.documentId;
    }
    // Bootstrap: the first authenticated A-route sender establishes the pin.
    if (!allowBootstrap || expectedUrl !== routes.A) return false;
    if (pinnedDocumentId !== null && sender.documentId !== pinnedDocumentId) return false;
    return sender.url === expectedUrl
      && (!bootstrapSender || (sender.id === bootstrapSender.id && sender.tabId === bootstrapSender.tabId
        && sender.frameId === bootstrapSender.frameId && sender.origin === bootstrapSender.origin
        && sender.documentId === bootstrapSender.documentId));
  }
  function eventFieldsValid(event, evidence) {
    const keys = replacementEventSchemas[event];
    return !!keys && exact(evidence, keys);
  }
  /**
   * Anchor the bootstrap tab pin to browser-provided evidence: the pinned tab
   * must be a live tab of this extension serving the exact fixture origin. The
   * caller-supplied sender alone never establishes the tab identity.
   */
  async function confirmFixtureTab(tabId) {
    if (!Number.isSafeInteger(tabId) || tabId < 0) return false;
    if (!browserApi?.tabs?.query) return false;
    let tabs;
    try { tabs = await browserApi.tabs.query({}); } catch { return false; }
    return Array.isArray(tabs) && tabs.some(tab => tab?.id === tabId && typeof tab?.url === 'string' && tab.url.startsWith(routes.origin));
  }
  function queueForObservedNavigation(message, sender) {
    if (transitionWaiters.size >= 16) return Promise.resolve(false);
    return new Promise(resolve => {
      const waiter = { message, sender, resolve: value => { clearTimeout(timer); transitionWaiters.delete(waiter); resolve(value); } };
      const timer = setTimeout(() => waiter.resolve(false), 5_000); timer.unref?.();
      transitionWaiters.add(waiter);
      if (pendingNavigation) pendingNavigation.then(() => settleTransitionWaiters(true), () => settleTransitionWaiters(false));
    });
  }
  function settleTransitionWaiters(accepted) {
    if (!accepted) { for (const waiter of [...transitionWaiters]) waiter.resolve(false); return; }
    for (const waiter of [...transitionWaiters]) {
      // Once currentRoute has switched, a fresh invocation validates the exact
      // immutable pinned sender and normal event schema.
      waiter.resolve(handleContentMessage(waiter.message, waiter.sender));
    }
  }
  function requestOptions() {
    return { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, redirect: 'error',
      signal: AbortSignal.timeout(reportTimeoutMs) };
  }
  function dispatch(event, evidence, sender) {
    if (closed || !initialized || !eventFieldsValid(event, evidence)) return Promise.reject(new Error('Replacement report is closed or malformed.'));
    const delivery = reportQueue.then(async () => {
      if (closed) throw new Error('Replacement report admission is closed.');
      const nextSequence = sequence + 1;
      const report = { v: VERSION, runId: config.runId, seq: nextSequence, operation: replacementProtocol.operation, event,
        evidence: { ...structuredClone(evidence), sender: structuredClone(sender) } };
      const response = await fetchImpl(reportUrl, { ...requestOptions(), body: JSON.stringify(report) });
      if (!response?.ok) {
        const bodyText = await response?.text?.().catch?.(() => '') ?? '';
        const errorReceipt = (() => { try { return JSON.parse(bodyText); } catch { return null; } })();
        const code = errorReceipt?.error;
        throw new Error(['PROTOCOL_REJECTED', 'ADMISSION_CLOSED', 'BODY_INVALID', 'ROUTE_REJECTED', 'ORIGIN_REJECTED', 'UNAUTHORIZED'].includes(code)
          ? `Replacement collector rejected an authenticated report (${code}) for ${event}: status=${response?.status} body=${bodyText.slice(0, 200)}`
          : `Replacement collector rejected an authenticated report for ${event}: status=${response?.status} body=${bodyText.slice(0, 200)}`);
      }
      const receipt = await response.json();
      if (!exact(receipt, ['v', 'runId', 'seq', 'accepted']) || receipt.v !== VERSION || receipt.runId !== config.runId
          || receipt.seq !== nextSequence || receipt.accepted !== true) throw new Error('Replacement collector report receipt mismatch.');
      sequence = nextSequence; reports.push(structuredClone(report));
      track(event, report.evidence);
      const waiters = eventWaiters.get(event);
      if (waiters) { eventWaiters.delete(event); for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.resolve(structuredClone(report)); } }
      return { accepted: true, seq: sequence };
    });
    reportQueue = delivery.catch(() => {});
    return delivery;
  }
  function track(event, evidence) {
    if (event === 'scheduler-batch') batches.set(evidence.messageId, { ...evidence });
    if (event === 'provider-invoked') invocations.set(evidence.messageId, { ...evidence });
    if (event === 'physical-start') attempts.set(evidence.attemptId, { ...evidence, settled: false, rootSettled: false, aborted: false });
    if (event === 'controller-abort') { const item = attempts.get(evidence.attemptId); if (item) item.aborted = true; }
    if (event === 'physical-settled') { const item = attempts.get(evidence.attemptId); if (item) Object.assign(item, { settled: true, outcome: evidence.outcome, code: evidence.code }); }
    if (event === 'provider-root-settled') {
      const item = [...attempts.values()].find(candidate => candidate.messageId === evidence.messageId && candidate.sessionId === evidence.sessionId);
      if (item) Object.assign(item, { rootSettled: true, rootStatus: evidence.status, rootCode: evidence.code,
        rootOperationAborted: evidence.operationAborted, rootCancellationReason: evidence.cancellationReason });
    }
    if (event === 'spa-navigation') { navigationCursor = structuredClone(evidence.cursor); currentRoute = routes.B; }
    if (event === 'stop-ack') stopAckObserved = true;
  }
  function validWorkerEvent(event, evidence) {
    if (event === 'error') return ['PROTOCOL_ERROR', 'TIMEOUT', 'TEARDOWN', 'PROVIDER_ERROR', 'DOM_MISMATCH'].includes(evidence.code);
    if (event === 'provider-invoked') {
      const batch = batches.get(evidence.messageId);
      return !!batch && batch.owner === evidence.owner && batch.sessionId === evidence.sessionId
        && sameArray(batch.targetIds, evidence.targetIds) && boundedId(evidence.invocationId) && !invocations.has(evidence.messageId);
    }
    if (event === 'physical-start') {
      const invocation = invocations.get(evidence.messageId);
      return !!invocation && invocation.owner === evidence.owner && invocation.sessionId === evidence.sessionId
        && invocation.invocationId === evidence.invocationId && sameArray(invocation.targetIds, evidence.targetIds)
        && boundedId(evidence.attemptId) && !attempts.has(evidence.attemptId)
        && ![...attempts.values()].some(item => item.messageId === evidence.messageId);
    }
    if (event === 'controller-abort') {
      const attempt = attempts.get(evidence.attemptId);
      return !!navigationCursor && stopAckObserved && !!attempt && attempt.messageId === evidence.messageId
        && attempt.sessionId === evidence.sessionId && attempt.owner === 'A' && evidence.aborted === true
        && evidence.cause === 'spa-navigation' && !attempt.aborted && !attempt.settled;
    }
    if (event === 'physical-settled') {
      const attempt = attempts.get(evidence.attemptId);
      return !!attempt && attempt.messageId === evidence.messageId && attempt.sessionId === evidence.sessionId
        && !attempt.settled && evidence.cleanup === false && ['fulfilled', 'rejected', 'cancelled'].includes(evidence.outcome)
        && (evidence.code === null || replacementProtocol.nativeCodes.includes(evidence.code));
    }
    if (event === 'provider-root-settled') {
      const attempt = [...attempts.values()].find(item => item.messageId === evidence.messageId && item.sessionId === evidence.sessionId);
      return !!attempt && attempt.settled && !attempt.rootSettled && evidence.cleanup === false
        && ['fulfilled', 'rejected', 'cancelled'].includes(evidence.status)
        && (evidence.code === null || replacementProtocol.nativeCodes.includes(evidence.code))
        && typeof evidence.operationAborted === 'boolean'
        && (evidence.cancellationReason === null || replacementProtocol.cancellationReasons.includes(evidence.cancellationReason))
        && evidence.operationAborted === (evidence.cancellationReason !== null);
    }
    return false;
  }
  function handleContentMessage(message, sender) {
    const reject = reason => {
      const detail = { reason, event: message?.event ?? null, senderUrl: sender?.url ?? null,
        senderTabId: sender?.tab?.id ?? sender?.tabId ?? null, senderFrameId: sender?.frameId ?? null,
        senderOrigin: sender?.origin ?? null, senderDocumentId: sender?.documentId ?? null };
      rejectedMessages.push(detail);
      // Firefox only delivers a listener's response when the listener returns a
      // promise, so a rejection must be a resolved promise as well.
      return Promise.resolve({ v: VERSION, runId: config.runId, accepted: false, seq: sequence + 1, reason, detail });
    };
    if (message?.action === replacementContentStatusAction) {
      const withTimeoutKeys = message?.type === 'wait-quiescence';
      const statusKeys = withTimeoutKeys ? ['action', 'v', 'runId', 'type', 'timeoutMs'] : ['action', 'v', 'runId', 'type'];
      // Phase 2C: the stale-release control exists only in stale mode, so the
      // Phase 2B accepted status surface is unchanged otherwise.
      const statusTypes = config.staleSuccess === true ? ['status', 'capture-final', 'release-stale'] : ['status', 'capture-final'];
      if (!exact(message, statusKeys) || message.v !== VERSION || message.runId !== config.runId
          || (withTimeoutKeys
            ? message.type !== 'wait-quiescence' || !Number.isFinite(message.timeoutMs) || message.timeoutMs < 1 || message.timeoutMs > 60_000
            : !statusTypes.includes(message?.type))) return false;
      const actualSender = normalizeSender(sender);
      if (currentRoute === routes.A && actualSender.url === routes.B && pinnedSender && senderIsPinned(actualSender, routes.B)) {
        return queueForObservedNavigation(message, sender);
      }
      if (!senderIsPinned(actualSender, currentRoute, { allowBootstrap: !pinnedSender && currentRoute === routes.A })) return false;
      const status = () => ({ v: VERSION, runId: config.runId, seeded: initialized, currentRoute, navigationCursor, stopAckObserved, worker: operationSnapshot() });
      // Capture-final authorization itself lives in the collector; the content
      // realm never sees the driver token, so the background brokers the call.
      if (message.type === 'capture-final') return Promise.resolve(getReplacementControl(config, 'capture-final', fetchImpl));
      // The stale-reply release grant is brokered the same way; an ungranted
      // release answers with an error the caller can retry.
      if (message.type === 'release-stale') return Promise.resolve(getReplacementControl(config, 'release-stale', fetchImpl));
      return message.type === 'wait-quiescence'
        ? waitForWorkerQuiescence({ timeoutMs: message.timeoutMs }).then(status) : Promise.resolve(status());
    }
    if (message?.action !== replacementContentEventAction) return false;
    if (!exact(message, ['action', 'v', 'runId', 'event', 'evidence']) || message.v !== VERSION || message.runId !== config.runId
        || !eventFieldsValid(message.event, message.evidence)) return reject('malformed');
    const actualSender = normalizeSender(sender);
    if (currentRoute === routes.A && actualSender.url === routes.B && message.event !== 'spa-navigation'
        && pinnedSender && senderIsPinned(actualSender, routes.B)) return queueForObservedNavigation(message, sender);
    // A navigation report in flight has to be admitted before the events that
    // depend on it, so their order does not depend on message timing.
    if (pendingNavigation && message.event !== 'spa-navigation') return queueForObservedNavigation(message, sender);
    const expectedUrl = message.event === 'spa-navigation' ? routes.B : currentRoute;
    const bootstrapA = !pinnedSender && message.event === 'session-start' && message.evidence.owner === 'A';
    if (!senderIsPinned(actualSender, expectedUrl, { allowBootstrap: bootstrapA })) return reject(`sender-not-pinned:${actualSender.url}`);
    if (!pinnedSender && (message.event !== 'session-start' || message.evidence.owner !== 'A' || actualSender.url !== routes.A)) return reject('bootstrap');
    if (pinnedSender && (actualSender.id !== pinnedSender.id || actualSender.tabId !== pinnedSender.tabId
        || actualSender.frameId !== pinnedSender.frameId || actualSender.origin !== pinnedSender.origin
        || actualSender.documentId !== pinnedSender.documentId)) return reject(`sender-mismatch:${JSON.stringify({ actual: actualSender, pinned: pinnedSender })}`);
    if (!pinnedSender && message.event === 'session-start' && message.evidence.owner === 'A') {
      if (bootstrapSender && (actualSender.documentId !== bootstrapSender.documentId || actualSender.tabId !== bootstrapSender.tabId)) return false;
      bootstrapSender ??= structuredClone(actualSender);
    }

    if (message.event === 'session-start') {
      const { owner, currentUrl, cursor, preserveAcceptedTranslations } = message.evidence;
      if (owner === 'A' && (currentUrl !== routes.A || preserveAcceptedTranslations !== false)) return false;
      if (owner === 'B' && (!navigationCursor || currentUrl !== routes.B || preserveAcceptedTranslations !== true
          || !cursor || cursor.documentEpoch !== navigationCursor.documentEpoch || cursor.routeRevision !== navigationCursor.routeRevision
          || cursor.url !== navigationCursor.url)) return false;
    }
    if (message.event === 'spa-navigation') {
      const { fromUrl, toUrl, cursor } = message.evidence;
      if (navigationCursor || currentRoute !== routes.A || fromUrl !== routes.A || toUrl !== routes.B
          || cursor?.url !== routes.B || !Number.isSafeInteger(cursor.documentEpoch) || cursor.documentEpoch <= 0
          || !Number.isSafeInteger(cursor.routeRevision) || cursor.routeRevision < 0) return reject('spa-navigation-evidence');
    }
    const promise = (bootstrapA
      ? confirmFixtureTab(actualSender.tabId).then(confirmed => {
        if (!confirmed) throw new Error('Bootstrap tab is not a live fixture tab of this extension.');
      })
      : Promise.resolve())
      .then(() => dispatch(message.event, message.evidence, actualSender))
      .then(receipt => {
      if (!pinnedSender && message.event === 'session-start' && message.evidence.owner === 'A') {
        pinnedSender = structuredClone(actualSender);
        pinnedDocumentId ??= actualSender.documentId;
      }
      currentSender = structuredClone(actualSender);
      if (message.event === 'spa-navigation') {
        navigationCursor = structuredClone(message.evidence.cursor); currentRoute = routes.B;
        settleTransitionWaiters(true);
      }
      return { v: VERSION, runId: config.runId, accepted: true, seq: receipt.seq };
    }, error => {
      if (!pinnedSender && bootstrapSender?.documentId === actualSender.documentId) bootstrapSender = null;
      if (message.event === 'spa-navigation') settleTransitionWaiters(false);
      throw error;
    });
    if (message.event === 'spa-navigation') {
      pendingNavigation = promise;
      promise.finally(() => { if (pendingNavigation === promise) pendingNavigation = null; }).catch(() => {});
    }
    return promise;
  }

  async function initialize() {
    if (initialized) return snapshot();
    const settings = await seedReplacementAutoSettings({ fixtureUrl: config.fixtureUrl, storage, matchRule });
    listener = (message, sender) => handleContentMessage(message, sender);
    browserApi.runtime.onMessage.addListener(listener);
    initialized = true;
    return { seeded: settings, routes };
  }
  function reportFromWorker(event, evidence) {
    // The content sender URL is the committed document URL, which a
    // same-document route change does not alter, so it cannot identify the
    // current route. The sender identity is already authenticated and pinned.
    if (!currentSender || !eventFieldsValid(event, evidence)) return Promise.reject(new Error('Worker telemetry has no authenticated current content sender.'));
    if (!['provider-invoked', 'physical-start', 'physical-settled', 'provider-root-settled', 'controller-abort', 'error'].includes(event)) {
      return Promise.reject(new Error('Worker reported a disallowed replacement event.'));
    }
    if (!validWorkerEvent(event, evidence)) {
      return Promise.reject(new Error('Worker event does not correlate with an admitted operation.'));
    }
    return dispatch(event, evidence, currentSender);
  }
  function operationSnapshot() {
    return {
      batches: [...batches.values()].map(value => structuredClone(value)),
      invocations: [...invocations.values()].map(value => structuredClone(value)),
      attempts: [...attempts.values()].map(value => structuredClone(value)),
      pendingPhysical: [...attempts.values()].filter(item => !item.settled).length,
      pendingRoots: [...attempts.values()].filter(item => !item.rootSettled).length,
    };
  }
  async function waitForWorkerQuiescence({ timeoutMs = 15_000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('Worker quiescence timeout is invalid.');
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const state = operationSnapshot();
      if (state.pendingPhysical === 0 && state.pendingRoots === 0 && state.attempts.length >= 3) return state;
      await new Promise(resolve => setTimeout(resolve, Math.min(40, Math.max(1, end - Date.now()))));
    }
    throw new Error('Timed out waiting for independently reported physical and Provider-root settlements.');
  }
  function waitForEvent(event, { timeoutMs = 10_000 } = {}) {
    if (!replacementEventSchemas[event] || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) return Promise.reject(new TypeError('Invalid replacement event wait.'));
    const existing = reports.find(item => item.event === event);
    if (existing) return Promise.resolve(structuredClone(existing));
    if (closed) return Promise.reject(new Error('Replacement background adapter is closed.'));
    return new Promise((resolve, reject) => {
      const list = eventWaiters.get(event) ?? []; const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const next = (eventWaiters.get(event) ?? []).filter(item => item !== waiter);
        if (next.length) eventWaiters.set(event, next); else eventWaiters.delete(event);
        reject(new Error(`Timed out waiting for authenticated content event ${event}.`));
      }, timeoutMs);
      waiter.timer.unref?.(); list.push(waiter); eventWaiters.set(event, list);
    });
  }
  function snapshot() {
    return structuredClone({ initialized, closed, sequence, currentRoute, navigationCursor, stopAckObserved, pinnedSender, currentSender,
      reportCount: reports.length, events: reports.map(report => ({ seq: report.seq, event: report.event })), worker: operationSnapshot(),
      rejectedMessages });
  }
  function close() {
    if (closed) return false;
    closed = true;
    if (listener) browserApi.runtime.onMessage.removeListener?.(listener);
    listener = null;
    for (const list of eventWaiters.values()) for (const waiter of list) { clearTimeout(waiter.timer); waiter.reject(new Error('Replacement background adapter closed.')); }
    eventWaiters.clear();
    settleTransitionWaiters(false);
    return true;
  }
  return { initialize, reportFromWorker, waitForEvent, waitForWorkerQuiescence, snapshot, close,
    getControl: type => getReplacementControl(config, type, fetchImpl) };
}

export async function getReplacementControl(config, type, fetchImpl = globalThis.fetch) {
  const routes = configRoutes(config);
  const path = type === 'navigate-to-b' ? replacementProtocol.controlPaths.navigateToB
    : type === 'capture-final' ? replacementProtocol.controlPaths.captureFinal
    // The release-stale path is added to the shared protocol by the Phase 2C
    // lane; fall back to the fixed literal so this adapter still loads if the
    // constant is missing.
    : type === 'release-stale' ? (replacementProtocol.controlPaths.releaseStale ?? '/__page-translation-replacement/control/release-stale') : null;
  if (!path || typeof fetchImpl !== 'function') throw new TypeError('Only the fixed replacement controls are available.');
  const response = await fetchImpl(`${routes.origin}${path}`, { method: 'GET', headers: { authorization: `Bearer ${config.authToken}` },
    redirect: 'error', signal: AbortSignal.timeout(5_000) });
  if (!response?.ok) throw new Error(`Replacement control ${type} is not ready.`);
  const value = await response.json();
  const expected = type === 'navigate-to-b' ? { v: VERSION, runId: config.runId, type, url: routes.B } : { v: VERSION, runId: config.runId, type };
  if (!exact(value, Object.keys(expected)) || Object.keys(expected).some(key => value[key] !== expected[key])) throw new Error('Replacement control receipt is malformed.');
  return value;
}

const workerNativeCodes = new Set(replacementProtocol.nativeCodes);
const workerEndpointAllowed = value => {
  try {
    const url = new URL(value); const keys = [...url.searchParams.keys()];
    return url.protocol === 'https:' && url.hostname === 'edge.microsoft.com' && url.port === ''
      && url.pathname === '/translate/translatetext' && url.searchParams.get('to') === 'fr'
      && url.searchParams.get('isEnterpriseClient') === 'false' && keys.every(key => ['from', 'to', 'isEnterpriseClient'].includes(key))
      && keys.filter(key => key === 'to').length === 1 && keys.filter(key => key === 'isEnterpriseClient').length === 1
      && keys.filter(key => key === 'from').length <= 1 && !url.username && !url.password && !url.hash;
  } catch { return false; }
};
const workerNativeErrorCode = error => workerNativeCodes.has(error?.code) ? error.code
  : workerNativeCodes.has(error?.type) ? error.type : workerNativeCodes.has(error?.name) ? error.name
    : error?.name === 'TypeError' ? 'NETWORK_ERROR' : null;

/** Install wrappers around production provider boundaries; wrappers only observe and call through. */
export function installReplacementWorkerObservers({ background, BaseProvider, ProviderRequestEngine, proxyManager,
  cryptoApi = globalThis.crypto, globalObject = globalThis } = {}) {
  if (!background || typeof background.reportFromWorker !== 'function' || typeof background.waitForEvent !== 'function'
      || typeof background.snapshot !== 'function' || typeof BaseProvider?.prototype?.translate !== 'function'
      || typeof ProviderRequestEngine?.executeApiCall !== 'function' || typeof proxyManager?.fetch !== 'function'
      || typeof proxyManager?.isEnabled !== 'function' || typeof cryptoApi?.randomUUID !== 'function') throw new TypeError('Production provider/worker observers are unavailable.');
  const roots = new Map(); const controllersToRoots = new WeakMap(); const signalOwners = new WeakMap(); const restorers = []; const abortListeners = new Map();
  const pendingPreOptions = new Map();
  const removePre = pre => {
    const list = pendingPreOptions.get(pre.key);
    if (!list) return;
    const index = list.indexOf(pre);
    if (index >= 0) list.splice(index, 1);
    if (!list.length) pendingPreOptions.delete(pre.key);
  };
  // The provider may split one Scheduler batch into provider chunks, so a
  // physical request body is a contiguous slice of the batch payload.
  const containsContiguous = (haystack, needle) => {
    if (!Array.isArray(haystack) || !Array.isArray(needle) || !needle.length || needle.length > haystack.length) return false;
    for (let start = 0; start + needle.length <= haystack.length; start += 1) {
      if (needle.every((value, index) => haystack[start + index] === value)) return true;
    }
    return false;
  };
  let rootOrdinal = 0; let attemptOrdinal = 0; let closed = false;
  const send = (event, evidence) => closed ? Promise.reject(new Error('Replacement worker observers are closed.')) : background.reportFromWorker(event, evidence);
  const reportFault = () => { void send('error', { code: 'PROTOCOL_ERROR' }).catch(() => {}); };
  const rootKey = (sessionId, messageId) => `${sessionId}\u0000${messageId}`;
  const recordRoot = async (root, status, error) => {
    if (!root.attemptId || !root.physicalSettlementPromise) { reportFault(); return false; }
    await root.physicalSettlementPromise;
    const code = status === 'fulfilled' ? null : workerNativeErrorCode(error);
      const operationAborted = status !== 'fulfilled' && error?.operationAborted === true;
      const cancellationReason = operationAborted ? error?.cancellationReason ?? null : null;
      if (operationAborted && !replacementProtocol.cancellationReasons.includes(cancellationReason)) reportFault();
      if (status !== 'fulfilled' && code === null && !(operationAborted
          && replacementProtocol.cancellationReasons.includes(cancellationReason))) reportFault();
    try { return await send('provider-root-settled', { sessionId: root.sessionId, messageId: root.messageId, status, code, cleanup: false,
      operationAborted, cancellationReason }); }
    catch { reportFault(); return false; }
  };
  const observeControllerAbort = root => {
    if (root.abortReported || !root.attemptId || !root.sessionId || !root.messageId) return Promise.resolve(false);
    root.abortReported = true;
    root.controllerAbortPromise = (async () => {
      // The AbortSignal is the native observation; telemetry waits separately
      // for authenticated Stop/navigation evidence before publishing its cause.
      const stopReport = await background.waitForEvent('stop-ack', { timeoutMs: 15_000 });
      const current = background.snapshot();
      if (current.currentRoute !== new URL(current.currentSender?.url).origin + '/replacement'
          || !current.stopAckObserved || root.owner !== 'A' || !current.events.some(item => item.event === 'accepted-A')
          || stopReport.evidence?.sessionId !== root.sessionId || stopReport.evidence?.resultSessionId !== root.sessionId
          || stopReport.evidence?.cancellationReason !== 'operation-abort') {
        throw new Error('Controller abort was not preceded by the observed navigation/Stop and accepted A work.');
      }
      return await send('controller-abort', { sessionId: root.sessionId, messageId: root.messageId,
        attemptId: root.attemptId, aborted: true, cause: 'spa-navigation' });
    })().catch(() => { reportFault(); return false; });
    return root.controllerAbortPromise;
  };

  const originalTranslate = BaseProvider.prototype.translate;
  const wrappedTranslate = function (...args) {
    const options = args[3] ?? {}; const { sessionId, messageId } = options;
    const batch = background.snapshot().worker.batches.find(item => item.sessionId === sessionId && item.messageId === messageId);
    if (!batch || typeof sessionId !== 'string' || typeof messageId !== 'string') { reportFault(); return originalTranslate.apply(this, args); }
    let resolvePhysical;
    const physicalSettlementPromise = new Promise(resolve => { resolvePhysical = resolve; });
    const root = { sessionId, messageId, owner: batch.owner, targetIds: [...batch.targetIds],
      invocationId: `provider-${cryptoApi.randomUUID()}-${++rootOrdinal}`, attemptId: null, controller: options.abortController ?? null,
      sourceTexts: Array.isArray(args[0])
        ? args[0].map(item => (typeof item === 'string' ? item : typeof item?.text === 'string' ? item.text : '')).filter(text => text.length > 0)
        : null,
      physicalSettlementPromise, resolvePhysical, invocationPromise: null, executeBound: false, fetchObserved: false };
    if (root.controller) controllersToRoots.set(root.controller, root);
    if (root.controller?.signal) signalOwners.set(root.controller.signal, root);
    roots.set(rootKey(sessionId, messageId), root);
    root.invocationPromise = send('provider-invoked', { owner: root.owner, sessionId, messageId,
      invocationId: root.invocationId, targetIds: root.targetIds }).catch(() => { reportFault(); return false; });
    const signal = root.controller?.signal;
    if (signal?.addEventListener && !abortListeners.has(signal)) {
      const listener = () => { root.controllerAbortPromise = observeControllerAbort(root); };
      signal.addEventListener('abort', listener, { once: true }); abortListeners.set(signal, { signal, listener });
    }
    let result;
    try { result = originalTranslate.apply(this, args); }
    catch (error) { void recordRoot(root, 'rejected', error); throw error; }
    Promise.resolve(result).then(() => { void recordRoot(root, 'fulfilled', null); }, error => { void recordRoot(root, 'rejected', error); });
    return result;
  };
  BaseProvider.prototype.translate = wrappedTranslate;
  restorers.push(() => { if (BaseProvider.prototype.translate === wrappedTranslate) BaseProvider.prototype.translate = originalTranslate; });

  const originalExecute = ProviderRequestEngine.executeApiCall;
  const wrappedExecute = function (provider, options, ...rest) {
    // Production executeRequest drops messageId before executeApiCall and may
    // derive a different abort controller downstream, so the physical request
    // is correlated by content (session plus the exact source texts sent),
    // exactly as the proven Phase 1/2A provider probe does.
    const fetchOptions = options?.fetchOptions;
    const key = typeof fetchOptions?.body === 'string' ? `${options?.url}\n${fetchOptions.method}\n${fetchOptions.body}` : null;
    let pre = null;
    if (key) {
      let bodyTexts = null;
      try { bodyTexts = JSON.parse(fetchOptions.body); } catch { bodyTexts = null; }
      const sessionId = options?.sessionId ?? null;
      const candidates = [...roots.values()].filter(root => (sessionId === null || root.sessionId === sessionId)
        && containsContiguous(root.sourceTexts, bodyTexts));
      if (candidates.length === 1) {
        pre = { key, root: candidates[0], consumed: false };
        // The provider engine call is now bound to exactly one admitted root.
        pre.root.executeBound = true;
        const list = pendingPreOptions.get(key) ?? [];
        list.push(pre);
        pendingPreOptions.set(key, list);
      }
    }
    let result;
    try { result = originalExecute.call(this, provider, options, ...rest); }
    catch (error) { if (pre) removePre(pre); throw error; }
    if (pre && result && typeof result.then === 'function') {
      result.then(() => { if (!pre.consumed) removePre(pre); }, () => { if (!pre.consumed) removePre(pre); });
    }
    return result;
  };
  ProviderRequestEngine.executeApiCall = wrappedExecute;
  restorers.push(() => { if (ProviderRequestEngine.executeApiCall === wrappedExecute) ProviderRequestEngine.executeApiCall = originalExecute; });

  const originalFetch = proxyManager.fetch;
  const wrappedFetch = function (url, options = {}, requestConfig, responsePolicy, ...rest) {
    // The Edge request leaves through the global fetch inside ProxyManager when
    // the extension proxy is disabled, so the physical attempt is observed at
    // that seam (the same place the proven Phase 1/2A provider probe
    // observed it). This wrapper only records the provider request context.
    const key = typeof options?.body === 'string' ? `${url}\n${options.method}\n${options.body}` : null;
    const list = key ? pendingPreOptions.get(key) : null;
    const pre = list?.[0];
    if (pre) { pre.consumed = true; removePre(pre); }
    return originalFetch.call(this, url, options, requestConfig, responsePolicy, ...rest);
  };
  proxyManager.fetch = wrappedFetch;
  restorers.push(() => { if (proxyManager.fetch === wrappedFetch) proxyManager.fetch = originalFetch; });

  const originalGlobalFetch = globalObject.fetch;
  // The patched global is always the real global one, so teardown restores it
  // even when the downstream original was injected for a test.
  const patchedGlobalFetch = globalThis.fetch;
  const wrappedGlobalFetch = async function (input, init = {}) {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    const method = String(init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : null;
    if (!body || method !== 'POST' || !workerEndpointAllowed(url)) return originalGlobalFetch.call(this, input, init);
    let bodyTexts = null;
    try { bodyTexts = JSON.parse(body); } catch { bodyTexts = null; }
    if (!Array.isArray(bodyTexts) || !bodyTexts.length || bodyTexts.length > 12
        || bodyTexts.some(text => typeof text !== 'string' || !text.trim()) || new Set(bodyTexts).size !== bodyTexts.length) {
      return originalGlobalFetch.call(this, input, init);
    }
    const candidates = [...roots.values()].filter(root => !root.attemptId && containsContiguous(root.sourceTexts, bodyTexts));
    if (candidates.length !== 1) return originalGlobalFetch.call(this, input, init);
    const root = candidates[0];
    root.fetchObserved = true;
    root.attemptId = `physical-${cryptoApi.randomUUID()}-${++attemptOrdinal}`;
    const physicalEvidence = { owner: root.owner, sessionId: root.sessionId, messageId: root.messageId,
      invocationId: root.invocationId, attemptId: root.attemptId, targetIds: root.targetIds };
    root.lastPhysicalEvidence = structuredClone(physicalEvidence);
    const started = root.invocationPromise.then(() => send('physical-start', physicalEvidence)).catch(error => {
      root.physicalStartError = typeof error?.message === 'string' ? error.message : 'report-rejected';
      reportFault(); return false;
    });
    let result;
    try { result = await originalGlobalFetch.call(this, input, init); }
    catch (error) {
      // An aborted request rejects with the abort reason itself (a plain
      // value), so the observed cancellation is classified from the signal
      // when the rejection carries no native error code.
      const code = workerNativeErrorCode(error)
        ?? (root.controller?.signal?.aborted === true ? 'ABORTED' : null);
      if (code === null) reportFault();
      root.physicalSettlementPromise = started.then(async () => {
        if (root.controller?.signal?.aborted) await root.controllerAbortPromise;
        try { await send('physical-settled', { sessionId: root.sessionId, messageId: root.messageId, attemptId: root.attemptId,
          outcome: root.controller?.signal?.aborted ? 'cancelled' : 'rejected', code, cleanup: false }); } catch { reportFault(); }
      }).finally(root.resolvePhysical);
      throw error;
    }
    root.physicalSettlementPromise = started.then(async () => {
      await send('physical-settled', { sessionId: root.sessionId, messageId: root.messageId, attemptId: root.attemptId,
        outcome: 'fulfilled', code: null, cleanup: false });
    }).catch(() => { reportFault(); }).finally(root.resolvePhysical);
    return result;
  };
  globalThis.fetch = wrappedGlobalFetch;
  restorers.push(() => { if (globalThis.fetch === wrappedGlobalFetch) globalThis.fetch = patchedGlobalFetch; });

  const snapshot = () => structuredClone({ roots: [...roots.values()].map(root => ({ owner: root.owner, sessionId: root.sessionId,
    messageId: root.messageId, invocationId: root.invocationId, attemptId: root.attemptId, executeBound: root.executeBound,
    fetchObserved: root.fetchObserved, physicalStartError: root.physicalStartError ?? null,
    lastPhysicalEvidence: root.lastPhysicalEvidence ?? null, abortReported: root.abortReported === true })), background: background.snapshot() });
  globalThis.__firefoxPageTranslationReplacementWorker = Object.freeze({ snapshot,
    waitForStopAck: (timeoutMs = 10_000) => background.waitForEvent('stop-ack', { timeoutMs }) });
  return { snapshot, dispose() {
    if (closed) return false; closed = true;
    const finalSnapshot = snapshot();
    const removedAbortObservers = abortListeners.size;
    for (const { signal, listener } of abortListeners.values()) signal.removeEventListener('abort', listener);
    abortListeners.clear();
    for (const undo of restorers.reverse()) { try { undo(); } catch { /* Teardown does not affect production cleanup. */ } }
    delete globalThis.__firefoxPageTranslationReplacementWorker;
    return { workerObserversDisposed: true, removedAbortObservers, operationSnapshot: finalSnapshot };
  } };
}
