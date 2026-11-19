import { createServer } from 'node:http';
import { createRuntimeCollector, validateRuntimeBridgeConfig } from '../e2e-firefox/runtime-collector.mjs';

export const targetTexts = Array.from({ length: 12 }, (_, index) => `Benchmark sentence ${index + 1} has stable fixture content.`);
export const startupVoicesEndpoint = Object.freeze({ hostname: 'speech.platform.bing.com', pathname: '/consumer/speech/synthesize/readaloud/voices/list', method: 'GET' });
export const startupVoicesResponse = Object.freeze([]);

const largeScenarios = new Set(['early-visible', 'in-window-visible', 'late-visible']);
const scrollBandTops = [20, 1120, 2220];
const largeTargetCount = 1000;
const visibleTargetIndexes = [500, 501, 502, 503];

export function createFixture(scenario = 'small') {
  if (scenario === 'shadow-dom') {
    const targets = [
      { id: 'shadow-light', source: 'Shadow fixture light DOM source.', kind: 'text', visible: true },
      { id: 'shadow-open', source: 'Shadow fixture open-root source.', kind: 'text', visible: true },
      { id: 'shadow-nested-title', source: 'Shadow fixture nested title source.', kind: 'title', visible: true },
      { id: 'shadow-dynamic-host', source: 'Shadow fixture inserted-host source.', kind: 'text', visible: true },
      { id: 'shadow-dynamic-root', source: 'Shadow fixture later-root source.', kind: 'text', visible: true },
    ];
    const html = `<!doctype html><meta charset="utf-8"><title>Shadow DOM benchmark</title><main><p data-bench-id="shadow-light" data-bench-kind="text">${targets[0].source}</p><div id="shadow-initial-host"></div><div id="shadow-closed-host"></div></main><script>
      const initialHost=document.getElementById('shadow-initial-host');
      const initialRoot=initialHost.attachShadow({mode:'open'});
      const openTarget=document.createElement('p');openTarget.dataset.benchId='shadow-open';openTarget.dataset.benchKind='text';openTarget.style.direction='rtl';openTarget.style.unicodeBidi='isolate';openTarget.textContent=${JSON.stringify(targets[1].source)};initialRoot.append(openTarget);
      const nestedHost=document.createElement('div');nestedHost.id='shadow-nested-host';initialRoot.append(nestedHost);
      const nestedRoot=nestedHost.attachShadow({mode:'open'});
      const nestedTitle=document.createElement('p');nestedTitle.dataset.benchId='shadow-nested-title';nestedTitle.dataset.benchKind='title';nestedTitle.style.minHeight='1px';nestedTitle.setAttribute('title',${JSON.stringify(targets[2].source)});nestedRoot.append(nestedTitle);
      initialRoot.append(document.createTextNode('SHADOW_DIRECT_TEXT_SENTINEL'));
      const closedRoot=document.getElementById('shadow-closed-host').attachShadow({mode:'closed'});
      const closedSentinel=document.createElement('p');closedSentinel.textContent='SHADOW_CLOSED_ROOT_SENTINEL';closedRoot.append(closedSentinel);
      window.__shadowBenchmarkOracle={initialHost,initialRoot,openTarget,nestedHost,nestedRoot,nestedTitle,closedHost:document.getElementById('shadow-closed-host'),closedSentinel};
    </script>`;
    return { scenario, targetCount: 3, targetTexts: targets.slice(0, 3).map(target => target.source), targets: targets.slice(0, 3), shadowTargets: targets,
      visibleIds: targets.slice(0, 3).map(target => target.id), html, viewport: { width: 1280, height: 900 }, scroll: { x: 0, y: 0 }, responseDelayMs: 50 };
  }
  if (scenario !== 'small' && scenario !== 'dynamic-dom' && scenario !== 'spa-navigation' && scenario !== 'scroll-through' && !largeScenarios.has(scenario)) throw new TypeError(`Unknown benchmark fixture scenario: ${scenario}`);

  const texts = scenario === 'small' || scenario === 'dynamic-dom' || scenario === 'spa-navigation' || scenario === 'scroll-through'
    ? targetTexts
    : Array.from({ length: largeTargetCount }, (_, index) => `Benchmark target ${String(index + 1).padStart(4, '0')} has stable fixture content.`);
  const count = texts.length;
  const visibleIndexes = scenario === 'scroll-through' ? [0, 1, 2, 3]
    : scenario === 'small' || scenario === 'dynamic-dom' || scenario === 'spa-navigation' ? texts.map((_, index) => index) : visibleTargetIndexes;
  let indexes = texts.map((_, index) => index);
  if (scenario === 'early-visible') indexes = [...visibleIndexes, ...indexes.filter(index => !visibleIndexes.includes(index))];
  if (scenario === 'in-window-visible') indexes = [0, 1, ...visibleIndexes, ...indexes.filter(index => index > 1 && !visibleIndexes.includes(index))];

  const targets = indexes.map(index => ({
    id: `target-${index}`,
    source: texts[index],
    visible: visibleIndexes.includes(index),
    ...(scenario === 'spa-navigation' ? { kind: index < 6 ? 'text' : 'title' } : {}),
  }));
  const htmlTargets = targets.map(target => {
    const targetIndex = Number(target.id.slice(7));
    const position = scenario === 'small' || scenario === 'dynamic-dom' || scenario === 'spa-navigation'
      ? ''
      : scenario === 'scroll-through'
        ? `position:absolute;left:20px;top:${scrollBandTops[Math.floor(targetIndex / 4)] + (targetIndex % 4) * 30}px;width:900px;height:24px;`
        : `position:absolute;left:20px;top:${target.visible ? 20 + visibleIndexes.indexOf(targetIndex) * 30 : 2000 + targetIndex * 30}px;width:900px;height:24px;`;
    const style = [position, target.kind === 'title' ? 'min-height:1px;' : ''].filter(Boolean).join('');
    return target.kind === 'title'
      ? `<p data-bench-id="${target.id}" data-bench-kind="title"${style ? ` style="${style}"` : ''} title="${target.source}"></p>`
      : `<p data-bench-id="${target.id}"${target.kind ? ' data-bench-kind="text"' : ''}${style ? ` style="${style}"` : ''}>${target.source}</p>`;
  }).join('');
  const spaControl = scenario === 'spa-navigation' ? `<button id="spa-navigation-control" type="button" translate="no">Navigate</button><script>
  const bSources = ${JSON.stringify(targetTexts.map((_, index) => `SPA route B sentence ${index + 1} has distinct stable content.`))};
  let changed = false;
  document.addEventListener('translate-it:benchmark-spa-invalidated', () => {
    if (changed) return; changed = true;
    for (const index of [1, 5, 9]) { const el = document.querySelector('[data-bench-id="target-' + index + '"]'); if (el.dataset.benchKind === 'title') el.setAttribute('title', bSources[index]); else el.firstChild.nodeValue = bSources[index]; el.dataset.benchRouteSource = bSources[index]; }
    document.documentElement.dataset.spaSourcesChanged = 'true';
  }, { once: true });
  document.getElementById('spa-navigation-control').addEventListener('click', () => history.pushState({}, '', '/replacement'));
  </script>` : '';
  const html = `<!doctype html><meta charset="utf-8"><title>Page translation benchmark</title><main${scenario === 'small' || scenario === 'dynamic-dom' || scenario === 'spa-navigation' ? '' : ` style="position:relative;min-height:${scenario === 'scroll-through' ? 3200 : 12000}px"`}>${htmlTargets}${spaControl}</main>${scenario === 'spa-navigation' ? '<script>document.documentElement.dataset.benchSpaScenario="true"</script>' : ''}`;
  const orderedTexts = targets.map(target => target.source);
  const visibleIds = targets.filter(target => target.visible).map(target => target.id);
  const dynamicCohorts = scenario === 'dynamic-dom' ? [0, 1].map(cohortIndex => ({
    id: `cohort-${cohortIndex + 1}`,
    targets: Array.from({ length: 3 }, (_, index) => ({
      id: `dynamic-${cohortIndex + 1}-${index + 1}`,
      source: `Dynamic cohort ${cohortIndex + 1} sentence ${index + 1} has unique stable fixture content.`,
      visible: true,
    })),
  })) : undefined;
  return {
    scenario,
    targetCount: count,
    targetTexts: orderedTexts,
    targets,
    visibleIds,
    html,
    viewport: { width: 1280, height: 900 },
    scroll: { x: 0, y: 0 },
    responseDelayMs: 50,
    ...(dynamicCohorts ? { dynamicCohorts } : {}),
    ...(scenario === 'spa-navigation' ? { spaChangedIds: ['target-1', 'target-5', 'target-9'], spaSources: targetTexts.map((_, index) => `SPA route B sentence ${index + 1} has distinct stable content.`) } : {}),
    ...(scenario === 'scroll-through' ? { scrollBands: scrollBandTops.map((top, band) => ({ band, top, ids: targets.slice(band * 4, band * 4 + 4).map(target => target.id) })) } : {}),
  };
}

export function createPageTranslationFixture() {
  const targets = targetTexts.map((source, index) => ({
    id: `target-${index}`,
    source,
    kind: index < 6 ? 'text' : 'title',
    visible: true,
  }));
  const html = `<!doctype html><meta charset="utf-8"><title>Page translation Firefox E2E</title><main>${targets.map(target =>
    target.kind === 'text'
      ? `<p data-bench-id="${target.id}" data-bench-kind="text">${target.source}</p>`
      : `<p data-bench-id="${target.id}" data-bench-kind="title" title="${target.source}"></p>`,
  ).join('')}</main>`;
  return {
    scenario: 'page-translation', targetCount: targets.length, targets,
    targetTexts: targets.map(target => target.source), visibleIds: targets.map(target => target.id), html,
    viewport: { width: 1280, height: 900 }, scroll: { x: 0, y: 0 }, responseDelayMs: 0,
  };
}

export function createPageTranslationReplacementFixture() {
  const sourceManifests = {
    A: [...targetTexts],
    // Every target gets a distinct B source so any pending subset produced by
    // production batching can be re-translated without reusing an A source.
    B: targetTexts.map((source, index) => `Replacement benchmark sentence ${index + 1} has stable fixture content.`),
  };
  const targets = sourceManifests.A.map((source, index) => ({
    id: `target-${index}`,
    source,
    kind: index < 6 ? 'text' : 'title',
    visible: true,
  }));
  const html = `<!doctype html><meta charset="utf-8"><title>Page translation Firefox replacement E2E</title><main>${targets.map(target =>
    target.kind === 'text'
      ? `<p data-bench-id="${target.id}" data-bench-kind="text">${target.source}</p>`
      : `<p data-bench-id="${target.id}" data-bench-kind="title" title="${target.source}"></p>`,
  ).join('')}<button id="page-translation-replacement-control" type="button" translate="no">Navigate to replacement</button><main style="display:none"></main><script>
let replacementNavigationStarted = false;
window.addEventListener('translate-it:page-translation-replacement-invalidated', () => {
  if (!replacementNavigationStarted) return;
  // Only the targets production left pending may change source; already
  // accepted translations must stay untouched. The runner publishes the
  // pending target ids it observed in the real Scheduler batches.
  const pending = (document.documentElement?.getAttribute('data-translate-it-replacement-pending') ?? '').split(',').map(id => id.trim()).filter(Boolean);
  const sources = ${JSON.stringify(sourceManifests.B)};
  for (const id of pending) {
    const element = document.querySelector('[data-bench-id="' + id + '"]');
    if (!element) continue;
    const index = Number(id.slice('target-'.length));
    if (element.dataset.benchKind === 'title') element.setAttribute('title', sources[index]);
    else if (element.firstChild) element.firstChild.nodeValue = sources[index];
  }
}, { once: true });
document.getElementById('page-translation-replacement-control').addEventListener('click', () => {
  if (replacementNavigationStarted) return;
  replacementNavigationStarted = true;
  history.pushState({}, '', '/replacement');
});
</script>`;
  return {
    scenario: 'page-translation-replacement', targetCount: targets.length, targets,
    targetTexts: targets.map(target => target.source), visibleIds: targets.map(target => target.id), html,
    sourceManifests,
    // Runtime adapters trigger the one-click same-document navigation using this fixed button ID.
    replacementControlId: 'page-translation-replacement-control',
    viewport: { width: 1280, height: 900 }, scroll: { x: 0, y: 0 }, responseDelayMs: 0,
  };
}

export async function startFixture(fixture = createFixture(), { runtimeBridge, replacementCollector: replacementCollectorOption } = {}) {
  if (runtimeBridge) validateRuntimeBridgeConfig(runtimeBridge);
  let bridge;
  // The collector may be a ready instance or a factory invoked once with the
  // bound URL (harness builds need the real port); either way the request
  // handler below only dereferences it after listen().
  let replacementCollector = replacementCollectorOption ?? null;
  const sockets = new Set();
  const server = createServer((request, response) => {
    if (bridge || replacementCollector) {
      let url;
      try { url = new URL(request.url, `http://127.0.0.1:${server.address().port}`); } catch { response.writeHead(400).end(); return; }
      void (async () => {
        if (bridge && await bridge._handle(request, response, url)) return;
        const replacementPaths = replacementCollector ? new Set([
          replacementCollector.reportUrl && new URL(replacementCollector.reportUrl).pathname,
          // Phase 2C adds the release-stale control; other collectors simply
          // never expose that pathname, so including it is inert for them.
          ...['navigate-to-b', 'capture-final', 'release-stale'].map(type => {
            try { return new URL(replacementCollector.controlUrl(type)).pathname; } catch { return null; }
          }),
        ].filter(Boolean)) : new Set();
        if (replacementCollector && replacementPaths.has(url.pathname)
            && await replacementCollector.handle(request, response)) return;
        const replacementFixture = fixture.scenario === 'page-translation-replacement' || fixture.scenario === 'spa-navigation';
        const isFixtureRoute = url.pathname === '/' || (replacementFixture && url.pathname === '/replacement');
        if (!isFixtureRoute || url.search) { response.writeHead(404).end(); return; }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fixture.html);
      })().catch(() => {
        if (response.destroyed) return;
        if (response.headersSent) response.destroy();
        else { response.writeHead(500).end(); response.once('finish', () => request.destroy()); }
      });
      return;
    }
    if (request.url !== '/' && !(['page-translation-replacement', 'spa-navigation'].includes(fixture.scenario) && request.url === '/replacement')) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(fixture.html);
  });
  if (runtimeBridge) server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const deadline = setTimeout(() => socket.destroy(), 3000);
    deadline.unref();
    socket.once('close', () => clearTimeout(deadline));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  if (typeof replacementCollectorOption === 'function') replacementCollector = replacementCollectorOption(url);
  if (runtimeBridge) {
    server.maxConnections = 16;
    server.requestTimeout = 3000;
    server.headersTimeout = 3000;
    bridge = createRuntimeCollector(runtimeBridge, url);
    bridge._attach(server, sockets);
    return { server, url, bridge };
  }
  return replacementCollector ? { server, url, replacementCollector } : { server, url };
}
