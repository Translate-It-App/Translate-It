import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { buildBenchmarkExtension } from './build.mjs';
import { launchChrome } from './chrome.mjs';
import { classifyTransportRequest, mapEdgeResponse } from './metrics.mjs';
import { createProviderNetworkObserver, decodeProviderRequest } from './network-interception.mjs';
import { pageTranslationStartMessage, validateProviderNetworkCorrelation } from './scenario-plan.mjs';
import { startupVoicesEndpoint } from './fixture.mjs';
import { writeBenchmarkArtifact } from './artifact-writer.mjs';

const TOP_SOURCE = 'Manual continuity canary top-frame source.';
const CHILD_SOURCE = 'Manual continuity canary admitted iframe source.';
const TOP_ORIGIN = 'http://b.test';
const CHILD_ORIGIN = 'http://a.test';
const FIXTURE_HOST_RULES = 'MAP a.test 127.0.0.1, MAP b.test 127.0.0.1';

const now = () => Number(process.hrtime.bigint()) / 1e6;
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
async function until(read, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await wait(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function exactTranslated(source) {
  return `\u200efixture translation: ${source}`;
}
function isFixtureURL(url, port) {
  return ['a.test', 'b.test'].includes(url.hostname) && Number(url.port) === port;
}
export function validateUnorderedExactSourceCoverage(requests, expectedSources) {
  const expected = new Set(expectedSources);
  const counts = new Map();
  const issues = [];
  if (!Array.isArray(requests)) return { ok: false, issues: ['Provider request evidence is unavailable.'], counts: [] };
  for (const request of requests) {
    if (!Array.isArray(request.batchTexts)) {
      issues.push('Provider request body order/evidence is unavailable.');
      continue;
    }
    for (const source of request.batchTexts) {
      if (!expected.has(source)) issues.push(`Unexpected provider source: ${String(source)}`);
      counts.set(source, (counts.get(source) ?? 0) + 1);
    }
  }
  for (const source of expected) {
    const count = counts.get(source) ?? 0;
    if (count === 0) issues.push(`Missing provider source: ${source}`);
    if (count > 1) issues.push(`Duplicate provider source: ${source}`);
  }
  return { ok: issues.length === 0, issues, counts: [...counts] };
}
export function summarizeCanaryRequestSettlements(requests, outstandingHandlers = 0, errors = []) {
  const missingSettlement = requests.filter(request => !request.settlement
    || typeof request.settlement.action !== 'string'
    || !Number.isFinite(request.settlement.acknowledgedAt));
  const unexpectedOrBlockedRequests = requests.filter(request => request.error
    || (request.blocked && request.knownPlaceholder !== true && request.knownNegativeProbe !== true));
  const allFetchSettlementsAcknowledged = missingSettlement.length === 0;
  return {
    outstandingHandlers,
    allFetchSettlementsAcknowledged,
    missingSettlement,
    unexpectedOrBlockedRequests,
    errors: [...errors],
    ok: allFetchSettlementsAcknowledged && outstandingHandlers === 0
      && unexpectedOrBlockedRequests.length === 0 && errors.length === 0,
  };
}
export function validateHeldStartRaceEvidence(evidence) {
  const issues = [];
  const {
    mode, documentToken, ticket, heldStart, start, readyRetry, releaseAccepted,
    manualContinuityRevoked, providerRequests, domMutations, raceDomUntranslated,
    parentTranslated, liveChildTranslated,
  } = evidence ?? {};
  if (!['stop', 'restore'].includes(mode)) issues.push(`Unsupported race mode: ${mode}`);
  if (!documentToken || ticket?.message?.data?.documentToken !== documentToken
      || ticket?.response?.success !== true || ticket.response.start !== true
      || ticket.response.documentToken !== documentToken) {
    issues.push('READY ticket was not successfully admitted for the held child document.');
  }
  const expectedStartData = ticket?.response ? { ...ticket.response, documentToken } : null;
  if (!heldStart || heldStart.message?.action !== 'page-translate-frame-start'
      || heldStart.message.data?.documentToken !== documentToken
      || JSON.stringify(heldStart.message.data) !== JSON.stringify(expectedStartData)) {
    issues.push('Held START did not preserve the original READY ticket and document token.');
  }
  if (releaseAccepted !== true || !start
      || JSON.stringify(start.message) !== JSON.stringify(heldStart?.message)
      || start.response?.success !== false || start.response?.isTransportFailure === true
      || start.response?.skipped === true || start.response?.reason === 'manager_unavailable'
      || typeof start.response?.reason !== 'string') {
    issues.push('Released START was not explicitly rejected after one unchanged dispatch.');
  }
  if (!readyRetry || readyRetry.message?.action !== 'page-translate-frame-ready'
      || readyRetry.message.data?.documentToken !== documentToken
      || readyRetry.response?.success !== false || readyRetry.response?.isTransportFailure === true) {
    issues.push('Production did not record the expected non-transport READY retry rejection.');
  }
  if (manualContinuityRevoked !== true) issues.push('Manual continuity revocation was not confirmed before releasing START.');
  if (!Array.isArray(providerRequests) || providerRequests.length !== 0) issues.push('Held child produced provider traffic.');
  if (!Array.isArray(domMutations) || domMutations.length !== 0 || raceDomUntranslated !== true) {
    issues.push('Held child produced a DOM write or no longer has its original untranslated DOM.');
  }
  if (mode === 'stop' && (parentTranslated !== true || liveChildTranslated !== true)) {
    issues.push('Stop did not preserve accepted parent and prior live-child translations.');
  }
  if (mode === 'restore' && (parentTranslated !== false || liveChildTranslated !== false)) {
    issues.push('Restore did not restore the parent and prior live child to originals.');
  }
  return { ok: issues.length === 0, issues };
}
function getOutputPath() {
  const requested = process.env.BENCH_IFRAME_CANARY_OUTPUT
    ?? `/tmp/opencode/page-translation-iframe-admission-canary-${new Date().toISOString().replaceAll(':', '-')}-${process.pid}.json`;
  const output = resolve(requested);
  if (!output.startsWith('/tmp/opencode/')) throw new TypeError('BENCH_IFRAME_CANARY_OUTPUT must be inside /tmp/opencode/.');
  return output;
}

export async function runIframeAdmissionCanary({
  outputPath = getOutputPath(), extensionPath: reusableExtensionPath = null, raceMode = null, sampleIndex = null,
} = {}) {
  if (raceMode !== null && !['stop', 'restore'].includes(raceMode)) throw new TypeError('raceMode must be stop, restore, or null.');
  if (reusableExtensionPath !== null && (typeof reusableExtensionPath !== 'string' || !reusableExtensionPath.startsWith('/'))) {
    throw new TypeError('extensionPath must be null or an absolute unpacked extension directory.');
  }
  let server;
  let browser;
  let extensionPath;
  let ownsExtensionPath = false;
  let heldStartGate = null;
  const sessions = new Map();
  const contexts = [];
  const requests = [];
  const providerFetches = [];
  const negativeGuardUrls = new Set();
  const networkEvents = new Map();
  const errors = [];
  const jobs = new Set();
  const artifact = {
    kind: 'iframe-admission-canary',
    status: 'running',
    discovery: 'sliced',
    performanceSamples: 0,
    warmups: 0,
    performanceTiming: false,
    limitation: 'One correctness-only cross-site OOPIF canary; no performance sample or universal no-egress claim.',
    requests,
    providerFetches,
    sessions: [],
    contexts: [],
    errors,
    result: null,
  };
  if (raceMode) artifact.raceMode = raceMode;
  if (sampleIndex !== null) artifact.sampleIndex = sampleIndex;
  const providerNetworkObserver = createProviderNetworkObserver({
    providerNetworkEvents: networkEvents,
    endpoints: [{ origin: 'https://edge.microsoft.com', pathname: '/translate/translatetext' }],
  });
  const track = promise => {
    const job = Promise.resolve(promise);
    jobs.add(job);
    job.then(() => jobs.delete(job), error => {
      jobs.delete(job);
      errors.push(`Fetch handler: ${error?.message ?? String(error)}`);
    });
    return job;
  };
  const handlePaused = async (event, send, fixturePort, extensionOrigin) => {
    const { request, requestId, networkId } = event.params;
    const parsed = new URL(request.url);
    const classification = classifyTransportRequest(request, {
      fixtureOrigin: isFixtureURL(parsed, fixturePort) ? parsed.origin : `http://127.0.0.1:${fixturePort}`,
      extensionOrigin,
      selectedProvider: 'edge',
    });
    const record = {
      sessionId: event.sessionId,
      targetSessionId: event.sessionId,
      requestId,
      networkId: networkId ?? null,
      url: request.url,
      method: request.method,
      resourceType: event.params.resourceType ?? null,
      frameId: event.params.frameId ?? null,
      category: classification.kind,
      startedAt: now(),
      settlement: null,
    };
    requests.push(record);
    try {
      if (classification.kind === 'provider-translation') {
        const decoded = decodeProviderRequest('edge', request, [TOP_SOURCE, CHILD_SOURCE]);
        const providerRecord = { ...record, batchTexts: decoded.texts };
        providerFetches.push(providerRecord);
        const body = mapEdgeResponse(decoded.texts);
        await send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from(JSON.stringify(body)).toString('base64'),
        }, event.sessionId);
        record.settlement = providerRecord.settlement = { action: 'fulfill', acknowledgedAt: now(), status: 200 };
        return;
      }
      if (classification.kind === 'startup-metadata-fixture'
          && parsed.hostname === startupVoicesEndpoint.hostname
          && parsed.pathname === startupVoicesEndpoint.pathname
          && request.method === 'GET') {
        await send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from('[]').toString('base64'),
        }, event.sessionId);
        record.settlement = { action: 'startup-metadata-fixture', acknowledgedAt: now(), status: 200 };
        return;
      }
      if (classification.kind === 'local' && ['GET', 'HEAD'].includes(request.method)
          && (isFixtureURL(parsed, fixturePort)
            || (parsed.protocol === 'chrome-extension:' && `chrome-extension://${parsed.host}` === extensionOrigin))) {
        await send('Fetch.continueRequest', { requestId }, event.sessionId);
        record.settlement = { action: 'continue-local', acknowledgedAt: now() };
        return;
      }
      record.blocked = true;
      record.blockReason = classification.reason ?? 'not an allowlisted request';
      if (negativeGuardUrls.has(request.url)) {
        record.knownNegativeProbe = true;
      } else if (classification.kind !== 'invalid-extension-placeholder') {
        errors.push(`Blocked unexpected request: ${request.method} ${request.url}`);
      } else {
        record.knownPlaceholder = true;
      }
      await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, event.sessionId);
      record.settlement = { action: 'block', acknowledgedAt: now() };
    } catch (error) {
      record.error = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;
      errors.push(record.error);
      throw error;
    }
  };
  const outputDirectory = resolve('/tmp/opencode');
  await mkdir(outputDirectory, { recursive: true });

  try {
    const fixture = createServer((request, response) => {
      if (request.url === '/page') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(`<!doctype html><meta charset="utf-8"><main><p id="top">${TOP_SOURCE}</p></main>`);
      } else if (request.url === '/child') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(`<!doctype html><meta charset="utf-8"><main><p id="child">${CHILD_SOURCE}</p></main>`);
      } else if (request.url === '/favicon.ico') {
        response.writeHead(204).end();
      } else {
        response.writeHead(404).end();
      }
    });
    server = fixture;
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const fixturePort = server.address().port;
    const topUrl = `${TOP_ORIGIN}:${fixturePort}/page`;
    const childUrl = `${CHILD_ORIGIN}:${fixturePort}/child`;
    if (reusableExtensionPath) {
      extensionPath = reusableExtensionPath;
    } else {
      extensionPath = await mkdtemp('/tmp/opencode/page-translation-iframe-canary-build-');
      ownsExtensionPath = true;
      await buildBenchmarkExtension({
        outputDir: extensionPath,
        mode: 'sliced',
        workerEntry: resolve('scripts/dev/page-translation/e2e-benchmark/worker-entry.mjs'),
        contentEntry: resolve('scripts/dev/page-translation/e2e-benchmark/content-entry.mjs'),
        iframeAdmissionCanary: true,
      });
    }

    let routerInstalled = false;
    const routeEvent = event => {
      if (event.method === 'Fetch.requestPaused' && sessions.has(event.sessionId)) {
        const { send, fixturePort: port, extensionOrigin } = sessions.get(event.sessionId);
        track(handlePaused(event, send, port, extensionOrigin));
      } else if (event.method.startsWith('Network.')) {
        providerNetworkObserver(event);
      } else if (event.method === 'Runtime.executionContextCreated') {
        const context = event.params.context;
        contexts.push({
          sessionId: event.sessionId,
          id: context.id,
          uniqueId: context.uniqueId,
          origin: context.origin,
          name: context.name,
          frameId: context.auxData?.frameId ?? null,
          isDefault: context.auxData?.isDefault ?? false,
        });
      } else if (event.method === 'Runtime.executionContextDestroyed') {
        const index = contexts.findIndex(context => context.sessionId === event.sessionId && context.id === event.params.executionContextId);
        if (index >= 0) contexts.splice(index, 1);
      } else if (event.method === 'Runtime.executionContextsCleared') {
        for (let index = contexts.length - 1; index >= 0; index--) {
          if (contexts[index].sessionId === event.sessionId) contexts.splice(index, 1);
        }
      } else if (event.method === 'Target.detachedFromTarget' && sessions.has(event.params.sessionId)) {
        const detached = sessions.get(event.params.sessionId);
        detached.detached = true;
        errors.push(`Guarded target detached during canary: ${detached.type} ${event.params.sessionId}`);
      } else if (event.method === 'Target.attachedToTarget' && event.params.waitingForDebugger
          && ['page', 'iframe'].includes(sessions.get(event.sessionId)?.type)) {
        const { sessionId, targetInfo } = event.params;
        track((async () => {
          if (targetInfo.type !== 'iframe') {
            throw new Error(`Unexpected child target while guarded: ${targetInfo.type} ${targetInfo.url}`);
          }
          const send = browser.send;
          await configureTarget(sessionId, targetInfo, send, true, fixturePort, browser.extensionId);
        })());
      }
    };
    async function configureTarget(sessionId, targetInfo, send, resume, port, extensionId) {
      if (targetInfo.type !== 'page' && targetInfo.type !== 'iframe' && targetInfo.type !== 'service_worker') {
        throw new Error(`Unsupported guarded target type: ${targetInfo.type}`);
      }
      if (targetInfo.type === 'page' || targetInfo.type === 'iframe') {
        await send('Target.setAutoAttach', {
          autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ exclude: false }],
        }, sessionId);
        await send('Page.enable', {}, sessionId);
        await send('Runtime.enable', {}, sessionId);
      } else {
        await send('Runtime.enable', {}, sessionId);
      }
      await send('Network.enable', {}, sessionId);
      await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId);
      const extensionOrigin = `chrome-extension://${extensionId}`;
      sessions.set(sessionId, { type: targetInfo.type, url: targetInfo.url, send, fixturePort: port, extensionOrigin, guarded: true });
      if (resume) await send('Runtime.runIfWaitingForDebugger', {}, sessionId);
    }

    const chrome = await launchChrome({
      extensionPath,
      extraArgs: [`--host-resolver-rules=${FIXTURE_HOST_RULES}`],
      onAttachedTarget: async ({ targetInfo, sessionId, send, onEvent }) => {
        if (targetInfo.type !== 'service_worker') return;
        if (!routerInstalled) {
          onEvent(routeEvent);
          routerInstalled = true;
        }
        await configureTarget(sessionId, targetInfo, send, false, fixturePort, new URL(targetInfo.url).host);
      },
    });
    browser = chrome;
    artifact.browser = chrome.metadata.browserVersion;
    assert(routerInstalled, 'Worker Fetch router was not installed before worker resume.');
    const workerSession = [...sessions].find(([, target]) => target.type === 'service_worker')?.[0];
    assert(workerSession, 'Production worker was not guarded before use.');

    const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: pageSession } = await chrome.send('Target.attachToTarget', { targetId, flatten: true });
    if (!routerInstalled) {
      chrome.onEvent(routeEvent);
      routerInstalled = true;
    }
    const pageInfo = { type: 'page', url: 'about:blank' };
    await configureTarget(pageSession, pageInfo, chrome.send, false, fixturePort, chrome.extensionId);
    await chrome.send('Page.navigate', { url: topUrl }, pageSession);

    const extensionOrigin = `chrome-extension://${chrome.extensionId}`;
    const topContext = await until(() => contexts.find(context => context.sessionId === pageSession && context.origin === extensionOrigin), 30_000, 'top extension context');
    const evaluate = async (sessionId, expression, contextId, awaitPromise = false) => {
      const result = await chrome.send('Runtime.evaluate', {
        expression, awaitPromise, returnByValue: true, userGesture: true,
        ...(contextId === undefined ? {} : { contextId }),
      }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result?.value;
    };
    await until(async () => {
      const state = await evaluate(pageSession,
        '({trace:!!window.__pageTranslationBenchmark,core:!!window.translateItContentCore?.initialized,features:window.__pageTranslationBenchmark?.featureState?.()})',
        topContext.id);
      return state.trace && state.core && state.features?.active && state.features?.handlerActive;
    }, 30_000, 'benchmark top content readiness');
    await evaluate(pageSession, `browser.storage.local.set(${JSON.stringify({
      WHOLE_PAGE_LAZY_LOADING: false,
      WHOLE_PAGE_TRANSLATE_AFTER_SCROLL_STOP: false,
      WHOLE_PAGE_AUTO_TRANSLATE_ON_DOM_CHANGES: false,
      PROXY_ENABLED: false,
    })})`, topContext.id, true);
    assert(await evaluate(pageSession,
      'window.__pageTranslationBenchmark.startMeasurement({})', topContext.id, true), 'Top measurement did not start.');

    const manualStart = {
      ...pageTranslationStartMessage('edge'),
      data: { ...pageTranslationStartMessage('edge').data, isAuto: false, translationOrigin: 'manual' },
    };
    artifact.manualStart = {
      sentAtMonotonicMs: now(),
      response: await evaluate(pageSession, `chrome.runtime.sendMessage(${JSON.stringify(manualStart)})`, topContext.id, true),
    };
    assert(artifact.manualStart.response?.success === true, `Manual PAGE_TRANSLATE was rejected: ${JSON.stringify(artifact.manualStart.response)}`);
    const topSessionId = artifact.manualStart.response.responses?.find(response => response.success)?.messageId
      ?? artifact.manualStart.response.sessionId ?? artifact.manualStart.response.messageId;
    assert(typeof topSessionId === 'string', 'Manual PAGE_TRANSLATE response omitted its session ID.');
    artifact.manualStart.topSessionId = topSessionId;
    const grantStatus = await evaluate(pageSession,
      `chrome.runtime.sendMessage({action:'page-translate-get-status'})`, topContext.id, true);
    artifact.manualContinuityGrant = grantStatus;
    assert(grantStatus?.hasManualContinuity === true && Number.isSafeInteger(grantStatus.manualContinuityGeneration),
      `Manual continuity was not armed before iframe insertion: ${JSON.stringify(grantStatus)}`);
    const topManagerCall = await until(async () => {
      const calls = await evaluate(pageSession, 'window.__pageTranslationBenchmark.calls', topContext.id);
      return calls?.find(call => call.sessionId === topSessionId) ?? null;
    }, 30_000, 'benchmark PageTranslationManager call');
    artifact.managerPath = { call: topManagerCall, isAuto: topManagerCall.isAuto };
    assert(topManagerCall.isAuto === false, `Manual benchmark manager call was unexpectedly auto: ${JSON.stringify(topManagerCall)}`);
    await until(async () => {
      const dom = await evaluate(pageSession, `document.querySelector('#top')?.textContent`, topContext.id);
      return dom === exactTranslated(TOP_SOURCE);
    }, 60_000, 'manual top-frame translation');
    artifact.topTranslated = await evaluate(pageSession, `document.querySelector('#top')?.textContent`, topContext.id);

    const insertionAt = now();
    const frameLayout = await evaluate(pageSession, `(()=>{
      const frame=document.createElement('iframe');
      frame.id='admitted-child';
      frame.width='320';
      frame.height='240';
      document.body.append(frame);
      const rect=frame.getBoundingClientRect();
      const style=getComputedStyle(frame);
      return {width:rect.width,height:rect.height,display:style.display,visibility:style.visibility};
    })()`, topContext.id);
    artifact.iframeLayoutBeforeNavigation = frameLayout;
    assert(frameLayout.width >= 50 && frameLayout.height >= 50
      && frameLayout.display !== 'none' && frameLayout.visibility !== 'hidden',
    `Dynamic iframe did not reach a suitable visible layout before navigation: ${JSON.stringify(frameLayout)}`);
    await evaluate(pageSession, `document.querySelector('#admitted-child').src=${JSON.stringify(childUrl)}`, topContext.id);
    const oopf = await until(() => [...sessions].find(([, target]) => target.type === 'iframe' && !target.detached), 30_000, 'cross-site OOPIF target');
    const [childSession, childTarget] = oopf;
    const childFrame = await until(async () => {
      const tree = await chrome.send('Page.getFrameTree', {}, childSession);
      return tree.frameTree?.frame?.url === childUrl ? tree.frameTree.frame : null;
    }, 30_000, 'OOPIF child frame identity');
    const childFrameId = childFrame.id;
    const childExtensionContext = await until(() => contexts.find(context => context.sessionId === childSession
      && context.frameId === childFrameId && context.origin === extensionOrigin), 30_000, 'child extension execution context');
    const childMainContext = await until(() => contexts.find(context => context.sessionId === childSession
      && context.frameId === childFrameId && context.isDefault), 30_000, 'child main-world execution context');
    artifact.oopf = { sessionId: childSession, targetType: childTarget.type, targetUrl: childTarget.url,
      guardInstalledBeforeResume: childTarget.guarded, childFrameId,
      extensionContext: childExtensionContext, mainContext: childMainContext };
    assert(childTarget.guarded && childTarget.type === 'iframe', 'Cross-site OOPIF target was not guarded before resume.');
    const childDocumentRequest = await until(() => requests.find(request => request.frameId === childFrameId
      && request.url === childUrl && request.resourceType === 'Document'), 30_000, 'guarded first OOPIF document request');
    artifact.oopf.firstDocumentRequest = childDocumentRequest;
    assert(childDocumentRequest.settlement?.action === 'continue-local' && childDocumentRequest.blocked !== true,
      'First OOPIF document request was not intercepted and acknowledged before continuing.');

    const childStarted = await until(async () => {
      const state = await evaluate(childSession, `({
        token:window.__translateItPageDocumentToken??null,
        started:window.__translateItFrameStartedToken??null,
        core:!!window.translateItContentCore?.initialized,
        allowed:window.translateItContentCore?._allowedRuntimeStarted===true,
        events:window.__pageTranslationIframeCanary?.events??[]
      })`, childExtensionContext.id);
      const ready = state.events.find(event => event.stage === 'ready');
      const start = state.events.find(event => event.stage === 'start');
      return state.token && state.token === state.started && state.core && state.allowed && ready && start
        ? { ...state, ready, start } : null;
    }, 60_000, 'real READY admission and accepted START');
    artifact.admission = {
      insertedAtMonotonicMs: insertionAt,
      ready: childStarted.ready,
      start: childStarted.start,
      documentToken: childStarted.token,
      readyAdmissionRoundTripMs: childStarted.ready.settledAt - childStarted.ready.startedAt,
      readyTicketToStartMs: childStarted.start.startedAt - childStarted.ready.settledAt,
      startAcceptanceRoundTripMs: childStarted.start.settledAt - childStarted.start.startedAt,
    };
    assert(childStarted.ready.message?.data?.documentToken === childStarted.token
      && childStarted.ready.response?.success === true && childStarted.ready.response?.start === true,
    `Child READY did not receive the actual admitted ticket: ${JSON.stringify(childStarted.ready)}`);
    assert(childStarted.start.message?.data?.documentToken === childStarted.token
      && childStarted.start.response?.success === true && childStarted.start.response?.isTransportFailure !== true,
    `Child START was not positively accepted: ${JSON.stringify(childStarted.start)}`);
    const negativeGuard = [];
    for (const [world, contextId] of [['main', childMainContext.id], ['extension', childExtensionContext.id]]) {
      const url = `https://iframe-canary-${process.pid}-${negativeGuard.length}-${Date.now()}.example.test/blocked`;
      negativeGuardUrls.add(url);
      const fetchResult = await evaluate(childSession,
        `fetch(${JSON.stringify(url)}, { cache:'no-store' }).then(()=>({resolved:true}),error=>({resolved:false,name:error.name}))`,
        contextId, true);
      const request = await until(() => requests.find(item => item.url === url), 10_000, `${world}-world blocked request`);
      assert(request.knownNegativeProbe === true && request.settlement?.action === 'block' && fetchResult.resolved === false,
        `${world} world Fetch was not intercepted and blocked: ${JSON.stringify({ fetchResult, request })}`);
      negativeGuard.push({ world, fetchResult, request });
    }
    artifact.childNetworkGuardNegativeProbe = negativeGuard;
    const childDocumentValue = await until(async () => {
      const value = await evaluate(childSession, `document.querySelector('#child')?.textContent`, childMainContext.id);
      return value === exactTranslated(CHILD_SOURCE) ? value : null;
    }, 60_000, 'admitted child translated DOM');
    assert(childDocumentValue === exactTranslated(CHILD_SOURCE),
      `Admitted child did not translate expected DOM content: ${JSON.stringify(childDocumentValue)}`);
    artifact.childTranslated = childDocumentValue;
    artifact.admission.translationCompletedAtMonotonicMs = now();
    artifact.admission.insertToTranslationLatencyMs = artifact.admission.translationCompletedAtMonotonicMs - insertionAt;
    const topAfterChild = await evaluate(pageSession,
      '({calls:window.__pageTranslationBenchmark.calls.map(call=>({sessionId:call.sessionId,isAuto:call.isAuto})),value:document.querySelector("#top")?.textContent})',
      topContext.id);
    assert(topAfterChild.calls.length === 1 && topAfterChild.calls[0].sessionId === topSessionId
      && topAfterChild.calls[0].isAuto === false && topAfterChild.value === exactTranslated(TOP_SOURCE),
    `Child admission restarted or changed the manual parent session: ${JSON.stringify(topAfterChild)}`);
    artifact.topAfterAdmission = topAfterChild;

    if (raceMode) {
      const raceElementId = `held-${raceMode}-child`;
      const raceInsertionAt = now();
      const raceLayout = await evaluate(pageSession, `(()=>{
        const frame=document.createElement('iframe');
        frame.id=${JSON.stringify(raceElementId)};
        frame.name='__page_translation_hold_start__';
        frame.width='320';
        frame.height='240';
        document.body.append(frame);
        const rect=frame.getBoundingClientRect();
        const style=getComputedStyle(frame);
        return {width:rect.width,height:rect.height,display:style.display,visibility:style.visibility};
      })()`, topContext.id);
      assert(raceLayout.width >= 50 && raceLayout.height >= 50
        && raceLayout.display !== 'none' && raceLayout.visibility !== 'hidden',
      `Held-start iframe did not reach a suitable visible layout before navigation: ${JSON.stringify(raceLayout)}`);
      await evaluate(pageSession,
        `document.querySelector(${JSON.stringify(`#${raceElementId}`)}).src=${JSON.stringify(childUrl)}`, topContext.id);
      const raceTarget = await until(async () => {
        for (const [sessionId, target] of sessions) {
          if (target.type !== 'iframe' || target.detached || sessionId === childSession) continue;
          const tree = await chrome.send('Page.getFrameTree', {}, sessionId);
          if (tree.frameTree?.frame?.url === childUrl && tree.frameTree.frame.id !== childFrameId) {
            return { sessionId, target, frame: tree.frameTree.frame };
          }
        }
        return null;
      }, 30_000, 'held-start cross-site OOPIF target');
      const raceChildFrameId = raceTarget.frame.id;
      const raceExtensionContext = await until(() => contexts.find(context => context.sessionId === raceTarget.sessionId
        && context.frameId === raceChildFrameId && context.origin === extensionOrigin), 30_000, 'held child extension context');
      const raceMainContext = await until(() => contexts.find(context => context.sessionId === raceTarget.sessionId
        && context.frameId === raceChildFrameId && context.isDefault), 30_000, 'held child main context');
      const raceDocumentRequest = await until(() => requests.find(request => request.frameId === raceChildFrameId
        && request.url === childUrl && request.resourceType === 'Document'), 30_000, 'held OOPIF document request');
      assert(raceTarget.target.guarded && raceDocumentRequest.settlement?.action === 'continue-local',
        'Held-start OOPIF was not guarded before its first document request continued.');
      const heldStart = await until(async () => {
        const events = await evaluate(raceTarget.sessionId,
          'window.__pageTranslationIframeCanary?.events??[]', raceExtensionContext.id);
        return events.find(event => event.stage === 'start-held') ?? null;
      }, 60_000, 'production START held after READY ticket');
      heldStartGate = { sessionId: raceTarget.sessionId, contextId: raceExtensionContext.id };
      const raceToken = heldStart.documentToken;
      const ticket = await until(async () => {
        const events = await evaluate(raceTarget.sessionId,
          'window.__pageTranslationIframeCanary?.events??[]', raceExtensionContext.id);
        return events.find(event => event.stage === 'ready'
          && event.message?.data?.documentToken === raceToken) ?? null;
      }, 10_000, 'successful READY ticket for held START');
      assert(ticket.response?.success === true && ticket.response.start === true,
        `Held START lacked a positive READY ticket: ${JSON.stringify(ticket)}`);
      artifact.heldStartRevocationRace = { mode: raceMode, documentToken: raceToken, ticket, heldStart };
      const mutationObserverStarted = await evaluate(raceTarget.sessionId, `(()=>{
        const target=document.querySelector('#child');
        if(!target)return false;
        window.__pageTranslationHeldMutations=[];
        const observer=new MutationObserver(records=>window.__pageTranslationHeldMutations.push(...records.map(record=>({
          type:record.type,target:record.target.nodeName,attributeName:record.attributeName??null
        }))));
        observer.observe(target,{subtree:true,childList:true,characterData:true,attributes:true});
        window.__pageTranslationHeldObserver=observer;
        return true;
      })()`, raceMainContext.id);
      assert(mutationObserverStarted, 'Could not install held-child DOM mutation observer before revocation.');

      const commandAction = raceMode === 'stop' ? 'page-translate-stop-auto' : 'page-restore';
      const continuityCommand = await evaluate(pageSession,
        `chrome.runtime.sendMessage({action:${JSON.stringify(commandAction)}})`, topContext.id, true);
      assert(continuityCommand?.success === true,
        `${commandAction} was not acknowledged: ${JSON.stringify(continuityCommand)}`);
      const revokedStatus = await until(async () => {
        const status = await evaluate(pageSession,
          `chrome.runtime.sendMessage({action:'page-translate-get-status'})`, topContext.id, true);
        return status?.hasManualContinuity === false && status.manualContinuityRevocationPending === false
          ? status : null;
      }, 30_000, `${raceMode} manual continuity revocation`);
      artifact.heldStartRevocationRace.command = { action: commandAction, response: continuityCommand };
      artifact.heldStartRevocationRace.revocationStatus = revokedStatus;
      const expectedParentText = raceMode === 'stop' ? exactTranslated(TOP_SOURCE) : TOP_SOURCE;
      const expectedLiveChildText = raceMode === 'stop' ? exactTranslated(CHILD_SOURCE) : CHILD_SOURCE;
      const parentAfterCommand = await until(async () => {
        const value = await evaluate(pageSession, `document.querySelector('#top')?.textContent`, topContext.id);
        return value === expectedParentText ? value : null;
      }, 30_000, `${raceMode} parent DOM state`);
      const liveChildAfterCommand = await until(async () => {
        const value = await evaluate(childSession, `document.querySelector('#child')?.textContent`, childMainContext.id);
        return value === expectedLiveChildText ? value : null;
      }, 30_000, `${raceMode} previous live child DOM state`);
      const releaseAccepted = await evaluate(raceTarget.sessionId,
        'window.__pageTranslationIframeCanary.releaseHeldStart()', raceExtensionContext.id);
      if (releaseAccepted === true) heldStartGate = null;
      let postReleaseState;
      try {
        postReleaseState = await until(async () => {
          const events = await evaluate(raceTarget.sessionId,
            'window.__pageTranslationIframeCanary?.events??[]', raceExtensionContext.id);
          const start = events.find(event => event.stage === 'start'
            && event.message?.data?.documentToken === raceToken);
          const readyEvents = events.filter(event => event.stage === 'ready'
            && event.message?.data?.documentToken === raceToken);
          const readyRetry = readyEvents[1];
          return start && readyRetry && events.indexOf(readyRetry) > events.indexOf(start)
            ? { events, start, readyRetry } : null;
        }, 30_000, 'revoked START rejection and production READY retry');
      } catch (error) {
        artifact.heldStartRevocationRace.releaseAccepted = releaseAccepted;
        artifact.heldStartRevocationRace.postReleaseEvents = await evaluate(raceTarget.sessionId,
          'window.__pageTranslationIframeCanary?.events??[]', raceExtensionContext.id).catch(() => null);
        artifact.heldStartRevocationRace.error = error.message;
        throw error;
      }
      const raceDomState = await evaluate(raceTarget.sessionId, `(()=>{
        const target=document.querySelector('#child');
        const mutations=window.__pageTranslationHeldMutations??[];
        if(window.__pageTranslationHeldObserver){
          mutations.push(...window.__pageTranslationHeldObserver.takeRecords().map(record=>({
            type:record.type,target:record.target.nodeName,attributeName:record.attributeName??null
          })));
          window.__pageTranslationHeldObserver.disconnect();
        }
        return {text:target?.textContent??null,translated:target?.getAttribute('data-page-translated')==='true',mutations};
      })()`, raceMainContext.id);
      const raceProviderRequests = providerFetches.filter(request => request.frameId === raceChildFrameId);
      const raceEvidence = {
        mode: raceMode,
        documentToken: raceToken,
        ticket,
        heldStart,
        start: postReleaseState.start,
        readyRetry: postReleaseState.readyRetry,
        releaseAccepted,
        manualContinuityRevoked: revokedStatus.hasManualContinuity === false
          && revokedStatus.manualContinuityRevocationPending === false,
        revocationStatus: revokedStatus,
        command: { action: commandAction, response: continuityCommand },
        providerRequests: raceProviderRequests,
        domMutations: raceDomState.mutations,
        raceDomUntranslated: raceDomState.text === CHILD_SOURCE && raceDomState.translated === false,
        parentTranslated: parentAfterCommand === exactTranslated(TOP_SOURCE),
        liveChildTranslated: liveChildAfterCommand === exactTranslated(CHILD_SOURCE),
        parentTextAfterCommand: parentAfterCommand,
        liveChildTextAfterCommand: liveChildAfterCommand,
        raceDomState,
        raceLayoutBeforeNavigation: raceLayout,
        raceInsertedAtMonotonicMs: raceInsertionAt,
      };
      artifact.heldStartRevocationRace = raceEvidence;
      const raceValidation = validateHeldStartRaceEvidence(raceEvidence);
      artifact.heldStartRevocationRace.validation = raceValidation;
      assert(raceValidation.ok, raceValidation.issues.join('; '));
    }

    const sourceCoverage = validateUnorderedExactSourceCoverage(providerFetches, [TOP_SOURCE, CHILD_SOURCE]);
    assert(sourceCoverage.ok, sourceCoverage.issues.join('; '));
    await until(() => providerFetches.every(fetch => {
      const terminal = networkEvents.get(`${fetch.sessionId}:${fetch.networkId}`);
      fetch.network = terminal ?? null;
      return terminal?.status === 200 && terminal?.outcome === 'finished';
    }), 15_000, 'provider Network response and terminal settlement');
    artifact.providerCorrelation = validateProviderNetworkCorrelation(providerFetches, [...networkEvents.values()]);
    assert(artifact.providerCorrelation.ok, artifact.providerCorrelation.issues.join('; '));
    artifact.provider = {
      logicalProviderBatchCount: (await evaluate(pageSession,
        'window.__pageTranslationBenchmark.pageSessionSnapshot()?.batchCount??null', topContext.id)) ?? null,
      physicalRequestCount: providerFetches.length,
      sourceCoverage: sourceCoverage.counts.map(([source, count]) => ({ source, count })),
      providerRequestBodyOrder: providerFetches.map(fetch => [...fetch.batchTexts]),
      attempts: providerFetches.map(fetch => ({ sessionId: fetch.sessionId, requestId: fetch.requestId,
        networkId: fetch.networkId, batchTexts: fetch.batchTexts, status: fetch.network?.status,
        outcome: fetch.network?.outcome, settlement: fetch.settlement })),
    };
    artifact.status = 'passed';
    artifact.result = { manualContinuityGrantArmedBeforeInsert: true, manualManagerCall: true,
      realReadyAdmission: true, successfulStartAcceptance: true, providerCoverageExact: true,
      topAndChildTranslationsExact: true, parentSessionUnchanged: true };
  } catch (error) {
    artifact.status = 'failed';
    artifact.error = { name: error?.name ?? 'Error', message: error?.message ?? String(error) };
  } finally {
    await Promise.allSettled([...jobs]);
    artifact.sessions = [...sessions].map(([sessionId, state]) => ({ sessionId, ...state }));
    artifact.contexts = contexts.map(context => ({ ...context }));
    artifact.requestSettlement = summarizeCanaryRequestSettlements(requests, jobs.size, errors);
    if (browser && heldStartGate) {
      try {
        const aborted = await browser.send('Runtime.evaluate', {
          expression: 'window.__pageTranslationIframeCanary?.abortHeldStart()??false',
          contextId: heldStartGate.contextId,
          returnByValue: true,
        }, heldStartGate.sessionId);
        artifact.heldStartRevocationRace ??= {};
        artifact.heldStartRevocationRace.cleanupAbortRequested = aborted.result?.value === true;
        if (aborted.result?.value !== true) {
          artifact.cleanupError = 'Could not abort unresolved held iframe START before Chrome teardown.';
          artifact.status = 'failed';
        }
      } catch (error) {
        artifact.cleanupError = `Could not abort unresolved held iframe START: ${error?.message ?? String(error)}`;
        artifact.status = 'failed';
      }
    }
    if (browser) {
      try { await browser.close(); }
      catch (error) {
        artifact.cleanupError = `Chrome close: ${error?.message ?? String(error)}`;
        artifact.status = 'failed';
      }
      browser = null;
    }
    if (server) await new Promise(resolveClose => server.close(resolveClose));
    if (extensionPath && ownsExtensionPath) await rm(extensionPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (!artifact.requestSettlement.ok) artifact.status = 'failed';
    await writeBenchmarkArtifact(outputPath, artifact);
    artifact.outputPath = outputPath;
  }
  return artifact;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const artifact = await runIframeAdmissionCanary();
  console.log(JSON.stringify({ status: artifact.status, outputPath: artifact.outputPath, result: artifact.result, error: artifact.error ?? null }, null, 2));
  if (artifact.status !== 'passed') process.exitCode = 1;
}
