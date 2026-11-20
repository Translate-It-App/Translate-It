import { Buffer } from 'node:buffer';
import { createCancellationRequestLifecycle } from './cancellation-probes.mjs';
import { classifyTransportRequest } from './metrics.mjs';
import { decodeGoogleV2Request, mapGoogleV2Response } from './google-v2-fixture.mjs';
import { decodeCustomRequest, mapCustomResponse } from './custom-fixture.mjs';
import { decodeGeminiRequest, mapGeminiResponse } from './gemini-fixture.mjs';
import { mapEdgeResponse } from './metrics.mjs';

export function classifyPausedRequest(request, { fixtureOrigin, extensionOrigin, selectedProvider }) {
  return classifyTransportRequest(request, { fixtureOrigin, extensionOrigin, selectedProvider });
}

export function createNetworkSessionState() {
  return {
    guardedSessions: new Set(),
    sendBySession: new Map(),
    extensionOriginBySession: new Map(),
    subscriptionsBySession: new Map(),
  };
}

export function registerGuardedSession(state, sessionId, send, extensionOrigin) {
  state.guardedSessions.add(sessionId);
  state.sendBySession.set(sessionId, send);
  state.extensionOriginBySession.set(sessionId, extensionOrigin);
}

export async function enableFetchGuard(send, sessionId) {
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId);
}

export async function enableProviderNetworkObservation(send, sessionId) {
  await send('Network.enable', {}, sessionId);
}

export async function fulfillPausedFetch({ send, sessionId, requestId, status, body, headers, requestRecord, now, response }) {
  await send('Fetch.fulfillRequest', {
    requestId, responseCode: status,
    responseHeaders: headers ?? [{ name: 'Content-Type', value: 'application/json' }],
    body: Buffer.from(JSON.stringify(body)).toString('base64'),
  }, sessionId);
  if (requestRecord) requestRecord.response = { status, body, ...response, endedAt: now() };
}

export async function failPausedFetch({ send, sessionId, requestId, errorReason, requestRecord, now, response }) {
  await send('Fetch.failRequest', { requestId, errorReason }, sessionId);
  if (requestRecord) requestRecord.response = { failed: true, reason: errorReason, ...response, endedAt: now() };
}

export async function continuePausedFetch({ send, sessionId, requestId, requestRecord, now }) {
  await send('Fetch.continueRequest', { requestId }, sessionId);
  if (requestRecord) requestRecord.response = { continued: true, endedAt: now() };
}

export async function runNetworkGuardNegativeProbe({ requests, chrome, pageSession, contentContext, evaluate, until, now, processId, probeResults = [] }) {
  await until(() => evaluate(chrome, pageSession,
    'Boolean(window.__pageTranslationBenchmark?.entry)', contentContext, false).catch(() => false));
  for (const [world, contextId] of [['page-main-world', undefined], ['extension-isolated-world', contentContext]]) {
    const url = `https://unexpected-${processId}-${now()}-${world}.example.test/blocked`;
    const fetch = await evaluate(chrome, pageSession,
      `fetch(${JSON.stringify(url)}, { cache: 'no-store' }).then(()=>({resolved:true}),error=>({resolved:false,name:error.name,message:error.message}))`,
      contextId, true);
    const request = await until(async () => requests.find(candidate => candidate.url === url));
    probeResults.push({ world, url, fetch, request, passed: request.blocked === true && request.category === 'blocked' && fetch.resolved === false });
  }
  if (probeResults.length !== 2 || probeResults.some(result => !result.passed)) {
    throw new Error('Negative network probe failed to prove blocked page and content-world fetches.');
  }
  return probeResults;
}

export function createNetworkCleanupSteps({ requestUnsubscribe, eventUnsubscribe, pageEventUnsubscribe, subscriptionsBySession }) {
  return [
    () => requestUnsubscribe?.(),
    () => eventUnsubscribe?.(),
    () => pageEventUnsubscribe?.(),
    async () => {
      const results = await Promise.allSettled([...subscriptionsBySession.values()].map(async unsubscribe => unsubscribe()));
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Network subscriptions failed to close.');
    },
  ];
}

export function decodeProviderRequest(provider, request, expectedTexts) {
  if (provider === 'googlev2') {
    const decoded = decodeGoogleV2Request({ method: request.method, url: request.url, body: request.postData ?? '' });
    return { texts: decoded.texts, sourceLanguage: decoded.sourceLanguage, responseBody: mapGoogleV2Response(decoded.texts) };
  }
  if (provider === 'custom') {
    const decoded = decodeCustomRequest({
      method: request.method, url: request.url, body: request.postData ?? '',
      headers: request.headers ?? {}, expectedTexts,
    });
    return { texts: decoded.texts, ids: decoded.ids, responseBody: mapCustomResponse(decoded) };
  }
  if (provider === 'gemini') {
    const decoded = decodeGeminiRequest({
      method: request.method, url: request.url, body: request.postData ?? '',
      headers: request.headers ?? {}, expectedTexts,
    });
    return { texts: decoded.texts, ids: decoded.ids, responseBody: mapGeminiResponse(decoded) };
  }
  const texts = JSON.parse(request.postData ?? 'null');
  return { texts, responseBody: mapEdgeResponse(texts) };
}

export function createFetchRequestListener({ guardSessions, now, requests, onRequest, reserveRequest, onAdmission, handlePaused, trackHandler }) {
  return event => {
    if (event.method !== 'Fetch.requestPaused' || !guardSessions.has(event.sessionId)) return;
    const { request, requestId } = event.params;
    const requestRecord = {
      startedAt: now(), url: request.url, method: request.method,
      postData: request.postData ?? null, initiator: request.initiator ?? null,
    };
    requests.push(requestRecord);
    onRequest?.(event, request, requestRecord);
    const reservation = reserveRequest(event, requestRecord, requestId);
    let admissionError;
    try {
      onAdmission?.(event, request, requestRecord, reservation, requestId);
    } catch (error) {
      admissionError = error;
    }
    let job;
    try {
      job = handlePaused(event, requestRecord, reservation, admissionError);
    } catch (error) {
      job = Promise.reject(error);
    }
    return trackHandler(reservation, job);
  };
}

export function createNetworkRequestLifecycle({ now, sendBySession }) {
  return createCancellationRequestLifecycle(async (reservation, action, detail) => {
    const send = sendBySession.get(reservation.sessionId);
    if (!send) throw new Error(`No CDP session remains for held Fetch ${reservation.requestId}.`);
    if (action === 'continue') {
      await send('Fetch.continueRequest', { requestId: reservation.requestId }, reservation.sessionId);
      reservation.requestRecord.response = { continued: true, endedAt: now(), releasedDuringCleanup: detail?.reason === 'teardown' };
    } else if (action === 'fail') {
      await send('Fetch.failRequest', { requestId: reservation.requestId, errorReason: detail?.errorReason ?? 'Aborted' }, reservation.sessionId);
      if (detail?.response) reservation.requestRecord.response = { ...detail.response, endedAt: now() };
    } else if (action === 'fulfill') {
      await send('Fetch.fulfillRequest', {
        requestId: reservation.requestId, responseCode: detail?.responseCode ?? 200,
        responseHeaders: detail?.responseHeaders ?? [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify(detail?.body)).toString('base64'),
      }, reservation.sessionId);
      reservation.requestRecord.response = { status: detail?.responseCode ?? 200, body: detail?.body, endedAt: now(), releasedAfterPause: reservation.held };
    } else {
      throw new TypeError(`Unsupported Fetch release action: ${action}`);
    }
    return { ok: true, action, requestId: reservation.requestId };
  });
}

export function createCustomFetchSettlement({ protocol, sendBySession, now }) {
  const release = async (role, status, body, headers = [{ name: 'Content-Type', value: 'application/json' }]) => {
    if (!protocol || protocol.releaseStates.has(role)) throw new Error(`Custom 429 ${role} Fetch already has a settlement in progress or completed.`);
    const claim = protocol.roles.get(role);
    if (!claim) throw new Error(`Custom 429 ${role} Fetch is not claimed.`);
    protocol.releaseStates.set(role, 'fulfill-in-flight');
    claim.settlementPromise = Promise.resolve().then(() => sendBySession.get(claim.event.sessionId)('Fetch.fulfillRequest', {
      requestId: claim.event.params.requestId, responseCode: status, responseHeaders: headers,
      body: Buffer.from(JSON.stringify(body)).toString('base64'),
    }, claim.event.sessionId)).then(() => {
      protocol.releaseStates.set(role, 'fulfilled');
      claim.requestRecord.response = { status, retryAfter: status === 429 ? '5' : null, endedAt: now() };
    }, error => {
      protocol.releaseStates.set(role, 'fulfill-failed');
      claim.requestRecord.releaseError = error?.message ?? String(error);
      protocol.evidence.events.push({ type: 'fulfill-send-failed', role, at: now(), message: claim.requestRecord.releaseError });
      throw error;
    });
    await claim.settlementPromise;
    return claim;
  };
  const failHeld = async reason => {
    if (!protocol) return;
    for (const [role, claim] of protocol.roles) {
      let state = protocol.releaseStates.get(role);
      if (state === 'fulfill-in-flight') {
        await claim.settlementPromise?.catch(() => {});
        state = protocol.releaseStates.get(role);
      }
      if (state === 'fulfilled' || state === 'failed' || state === 'fail-in-flight' || state === 'fail-failed') continue;
      protocol.releaseStates.set(role, 'fail-in-flight');
      try {
        await sendBySession.get(claim.event.sessionId)?.('Fetch.failRequest', {
          requestId: claim.event.params.requestId, errorReason: 'Aborted',
        }, claim.event.sessionId);
        protocol.releaseStates.set(role, 'failed');
        claim.requestRecord.response = { failed: true, reason, endedAt: now() };
      } catch (error) {
        protocol.releaseStates.set(role, 'fail-failed');
        claim.requestRecord.releaseError ??= error?.message ?? String(error);
        protocol.evidence.events.push({ type: 'fail-send-failed', role, at: now(), message: claim.requestRecord.releaseError });
      }
    }
  };
  return { release, failHeld };
}

export function createProviderNetworkObserver({ providerNetworkEvents, endpoints }) {
  return event => {
    const params = event.params ?? {};
    const id = params.requestId;
    if (!id || !event.sessionId) return;
    const key = `${event.sessionId}:${id}`;
    let entry = providerNetworkEvents.get(key);
    if (event.method === 'Network.requestWillBeSent') {
      let url;
      try { url = new URL(params.request?.url); } catch { return; }
      if (!endpoints.some(endpoint => url.origin === endpoint.origin && url.pathname === endpoint.pathname)) return;
      entry = {
        sessionId: event.sessionId, networkId: id,
        startedAt: Number.isFinite(params.timestamp) ? params.timestamp * 1000 : null,
        wallTime: Number.isFinite(params.wallTime) ? params.wallTime * 1000 : null,
      };
      providerNetworkEvents.set(key, entry);
    } else if (entry && event.method === 'Network.responseReceived') {
      entry.status = params.response?.status ?? null;
      entry.responseAtMonoMs = Number.isFinite(params.timestamp) ? params.timestamp * 1000 : null;
      entry.responseWallTime = Number.isFinite(entry.wallTime) && Number.isFinite(entry.startedAt) && Number.isFinite(entry.responseAtMonoMs)
        ? entry.wallTime + entry.responseAtMonoMs - entry.startedAt : null;
    } else if (entry && ['Network.loadingFinished', 'Network.loadingFailed'].includes(event.method)) {
      entry.settledAt = Number.isFinite(params.timestamp) ? params.timestamp * 1000 : null;
      entry.outcome = event.method === 'Network.loadingFinished' ? 'finished' : 'failed';
      if (event.method === 'Network.loadingFailed') entry.error = params.errorText ?? 'Network loading failed';
    }
  };
}

export function createHandlerJobTracker() {
  const jobs = new Set();
  return {
    jobs,
    track(lifecycle, reservation, job, onError) {
      const tracked = lifecycle.trackHandler(reservation, job);
      jobs.add(tracked);
      tracked.then(() => jobs.delete(tracked), error => {
        jobs.delete(tracked);
        onError(error);
      });
      return tracked;
    },
  };
}

export function closeNetworkRequestLifecycle({ lifecycle, guardedSessions, chrome, timeoutMs = 8_000 }) {
  return lifecycle.closeAndDrain({
    timeoutMs,
    disableFetch: async () => {
      if (!chrome || !guardedSessions.size) throw new Error('Fetch target sessions unavailable while closing request admission.');
      const sessions = [...guardedSessions];
      const results = await Promise.allSettled(sessions.map(sessionId => chrome.send('Fetch.disable', {}, sessionId)));
      const failures = results.flatMap((result, index) => result.status === 'rejected'
        ? [`${sessions[index]}: ${result.reason?.message ?? String(result.reason)}`] : []);
      if (failures.length) throw new AggregateError(failures.map(message => new Error(message)), `Fetch.disable failed for ${failures.length} target(s).`);
    },
  });
}
