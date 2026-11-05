import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DIAGNOSTIC_COUNTERS = [
  'visitedNodes', 'seedAncestorVisits', 'seedSubtreeVisits', 'rootTraversalVisits', 'seedTargetRepeatVisits', 'discoveryPasses',
  'discoveryRequests', 'discoveryRequestsStart', 'discoveryRequestsScroll', 'discoveryRequestsResize', 'discoveryRequestsDomMutation', 'discoveryRequestsHeadMutation', 'discoveryRequestsBodyMutation', 'discoveryRequestsStylesheetLoad', 'discoveryRequestsStylesheetError', 'discoveryRequestsRefresh', 'discoveryRequestsImmediate', 'discoveryRequestsCoalesced', 'discoveryFollowupPasses',
  'domMutationObserverBatches', 'rootMutationObserverBatches', 'headMutationObserverBatches', 'bodyMutationObserverBatches', 'mutationChildListRecords', 'mutationUnownedCharacterDataRecords', 'mutationRelevantAttributeRecords', 'mutationDataAttributeRecords', 'mutationCssReferencedBatches', 'mutationCssClearBatches', 'mutationCssFallbackBatches', 'mutationAuditMs', 'mutationAuditCount', 'mutationAuditFallbacks',
];
const VIEWPORT_ONLY_COUNTERS = DIAGNOSTIC_COUNTERS.filter(key => !['visitedNodes', 'discoveryPasses'].includes(key));

beforeEach(() => {
  vi.restoreAllMocks();
  delete globalThis.TranslateItViewportPrototype;
  window.eval(readFileSync(resolve('scripts/dev/page-translation-prototype/engine.js'), 'utf8'));
  Object.defineProperty(HTMLElement.prototype, 'checkVisibility', { configurable: true, value: undefined });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function() {
    const y = Number(this.dataset.y || 0);
    return { top: y, bottom: y + 20, left: 0, right: 100, width: 100, height: 20 };
  });
  document.elementFromPoint = () => document.querySelector('[data-y="0"]');
});

describe('viewport DOM prototype', () => {
  it('admits visible text and attributes, skips exclusions and restores originals', async () => {
    document.body.innerHTML = '<main><p data-y="0" title="Tip">Visible</p><code data-y="0">Code</code><p data-y="5000">Far</p></main>';
    const root = document.querySelector('main');
    const e = TranslateItViewportPrototype.createEngine({ root, mode: 'baseline' });
    await e.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    for (const key of VIEWPORT_ONLY_COUNTERS) expect(e.getStats()[key]).toBe(0);
    expect(root.innerHTML).toContain('⟦TI⟧Visible');
    expect(root.querySelector('p').title).toBe('⟦TI⟧Tip');
    expect(root.querySelector('code').textContent).toBe('Code');
    expect(e.getStats()).not.toHaveProperty('text');
    root.querySelector('p').firstChild.nodeValue = 'external';
    await e.restore();
    expect(root.querySelector('p').textContent).toBe('external');
    expect(root.querySelector('p').title).toBe('Tip');
    expect(e.getStats().preservedExternalNodes).toBe(1);
  });

  it('scans viewport-first cooperatively, handles mutations and stops without late writes', async () => {
    document.body.innerHTML = '<main><div data-y="0">Visible</div>' + '<p data-y="5000">Far</p>'.repeat(80) + '</main>';
    const engine = TranslateItViewportPrototype.createEngine({ root: document.querySelector('main'), mode: 'viewport', maxStepsPerSlice: 2, budgetMs: 20 });
    const started = engine.start();
    await vi.waitFor(() => expect(document.querySelector('div').textContent).toBe('⟦TI⟧Visible'));
    expect(engine.getStats().visitedNodes).toBeGreaterThan(0);
    engine.stop();
    await started;
    const inserted = document.createElement('p'); inserted.dataset.y = '0'; inserted.textContent = 'Late';
    document.querySelector('main').append(inserted);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(inserted.textContent).toBe('Late');
    await engine.cleanup();
  });

  it('freezes numeric viewport diagnostics after stop and restore', async () => {
    document.body.innerHTML = '<main><p data-y="0">Owned source</p></main>';
    const root = document.querySelector('main'), p = root.firstElementChild;
    const engine = TranslateItViewportPrototype.createEngine({ root });
    await engine.start(); await engine.whenIdle();
    const diagnostics = () => Object.fromEntries(DIAGNOSTIC_COUNTERS.map(key => [key, engine.getStats()[key]]));
    const beforeStop = diagnostics();
    engine.stop();
    p.firstChild.nodeValue = 'External after stop';
    window.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('resize'));
    const lateLink = document.createElement('link'); lateLink.rel = 'stylesheet'; lateLink.href = '/late-diagnostic.css'; document.head.append(lateLink);
    lateLink.dispatchEvent(new Event('load'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(diagnostics()).toEqual(beforeStop);
    await engine.restore();
    expect(diagnostics()).toEqual(beforeStop);
    lateLink.remove();
  });

  it('does not start a dirty follow-up when an active sliced pass is stopped', async () => {
    document.body.innerHTML = '<main><p>First</p>' + '<p>Next</p>'.repeat(20) + '</main>';
    const root = document.querySelector('main'); document.elementFromPoint = () => null;
    vi.useFakeTimers();
    try {
      const engine = TranslateItViewportPrototype.createEngine({ root, maxStepsPerSlice: 1 });
      const started = engine.start();
      await vi.advanceTimersToNextTimerAsync(); // initialize the pass
      await vi.advanceTimersToNextTimerAsync(); // advance one root-traversal node
      window.dispatchEvent(new Event('scroll')); // leave a dirty follow-up pending
      engine.refresh(); engine.refresh(); // refreshes coalesce into the same active pass
      expect(engine.getStats()).toMatchObject({ discoveryRequests: 4, discoveryRequestsStart: 1, discoveryRequestsScroll: 1, discoveryRequestsRefresh: 2, discoveryRequestsImmediate: 1, discoveryRequestsCoalesced: 3, discoveryPasses: 1, discoveryFollowupPasses: 0 });
      const stats = engine.getStats();
      expect(stats.discoveryRequests).toBe(stats.discoveryRequestsStart + stats.discoveryRequestsScroll + stats.discoveryRequestsResize + stats.discoveryRequestsDomMutation + stats.discoveryRequestsHeadMutation + stats.discoveryRequestsBodyMutation + stats.discoveryRequestsStylesheetLoad + stats.discoveryRequestsStylesheetError + stats.discoveryRequestsRefresh);
      expect(stats.discoveryRequestsImmediate + stats.discoveryRequestsCoalesced).toBe(stats.discoveryRequests);
      engine.stop(); await started;
      const stopped = Object.fromEntries(DIAGNOSTIC_COUNTERS.map(key => [key, engine.getStats()[key]]));
      await engine.restore(); await vi.runAllTimersAsync();
      expect(Object.fromEntries(DIAGNOSTIC_COUNTERS.map(key => [key, engine.getStats()[key]]))).toEqual(stopped);
      expect(engine.getStats().discoveryFollowupPasses).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('refresh rescans CSSOM-only eligibility changes through the viewport pass', async () => {
    document.body.innerHTML = '<main><style id="cssom">#cssom-target { display: none }</style><p id="cssom-target">CSSOM-only source</p></main>';
    const root = document.querySelector('main'), style = root.querySelector('style'), target = root.querySelector('p');
    expect(window.getComputedStyle(target).display).toBe('none');
    const engine = TranslateItViewportPrototype.createEngine({ root });
    await engine.start(); await engine.whenIdle();
    expect(target.textContent).toBe('CSSOM-only source');
    const beforeCssom = engine.getStats();
    expect(style.sheet.cssRules).toHaveLength(1);
    style.sheet.deleteRule(0);
    await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    expect(window.getComputedStyle(target).display).toBe('block');
    expect(target.textContent).toBe('CSSOM-only source');
    expect(engine.getStats()).toMatchObject({ discoveryPasses: beforeCssom.discoveryPasses, discoveryRequests: beforeCssom.discoveryRequests, discoveryRequestsRefresh: 0, pendingJobCount: 0 });

    engine.refresh(); await engine.whenIdle();
    expect(target.textContent).toBe('⟦TI⟧CSSOM-only source');
    const refreshed = engine.getStats();
    expect(refreshed).toMatchObject({ discoveryRequestsRefresh: 1, discoveryRequestsImmediate: beforeCssom.discoveryRequestsImmediate + 1, discoveryRequestsCoalesced: beforeCssom.discoveryRequestsCoalesced, discoveryPasses: beforeCssom.discoveryPasses + 1, discoveryFollowupPasses: beforeCssom.discoveryFollowupPasses });
    expect(refreshed.discoveryRequests).toBe(refreshed.discoveryRequestsStart + refreshed.discoveryRequestsScroll + refreshed.discoveryRequestsResize + refreshed.discoveryRequestsDomMutation + refreshed.discoveryRequestsHeadMutation + refreshed.discoveryRequestsBodyMutation + refreshed.discoveryRequestsStylesheetLoad + refreshed.discoveryRequestsStylesheetError + refreshed.discoveryRequestsRefresh);
    expect(refreshed.discoveryRequestsImmediate + refreshed.discoveryRequestsCoalesced).toBe(refreshed.discoveryRequests);
    expect(refreshed.discoveryPasses).toBe(refreshed.discoveryRequestsImmediate + refreshed.discoveryFollowupPasses);
    await engine.cleanup();
    expect(engine.getStats()).toMatchObject({ ownedNodes: 0, observerCount: 0, pendingJobCount: 0 });
  });

  it('refresh discovers nested open roots attached after their hosts were scanned', async () => {
    document.body.innerHTML = '<main><x-late-host data-y="0"></x-late-host></main>';
    const root = document.querySelector('main'), host = root.querySelector('x-late-host');
    const engine = TranslateItViewportPrototype.createEngine({ root });
    await engine.start(); await engine.whenIdle();
    const initial = engine.getStats();
    const outer = host.attachShadow({ mode: 'open' }), innerHost = document.createElement('x-late-inner'); outer.append(innerHost);
    const inner = innerHost.attachShadow({ mode: 'open' }), p = document.createElement('p'); p.dataset.y = '0'; p.textContent = 'Nested late shadow source'; inner.append(p);
    await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    expect(p.textContent).toBe('Nested late shadow source');
    expect(engine.getStats()).toMatchObject({ discoveryPasses: initial.discoveryPasses, discoveryRequests: initial.discoveryRequests, observerCount: initial.observerCount });

    engine.refresh(); await engine.whenIdle();
    expect(p.textContent).toBe('⟦TI⟧Nested late shadow source');
    expect(engine.getStats()).toMatchObject({ discoveryPasses: initial.discoveryPasses + 1, discoveryRequests: initial.discoveryRequests + 1, discoveryRequestsRefresh: initial.discoveryRequestsRefresh + 1, observerCount: initial.observerCount + 2 });

    const afterRefresh = engine.getStats();
    const dynamic = document.createTextNode('Dynamic nested shadow source'); p.append(dynamic);
    await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    expect(dynamic.data).toBe('⟦TI⟧Dynamic nested shadow source');
    expect(engine.getStats()).toMatchObject({ discoveryPasses: afterRefresh.discoveryPasses + 1, discoveryRequestsRefresh: afterRefresh.discoveryRequestsRefresh, discoveryRequestsDomMutation: afterRefresh.discoveryRequestsDomMutation + 1 });
    expect(engine.getStats().discoveryRequests).toBe(afterRefresh.discoveryRequests + 1);
    await engine.cleanup();
    expect(engine.getStats()).toMatchObject({ ownedNodes: 0, observerCount: 0, pendingJobCount: 0 });
  });

  it('refresh is a no-op outside an active viewport session', async () => {
    document.body.innerHTML = '<main><p data-y="0">Refresh lifecycle source</p></main>';
    const root = document.querySelector('main');
    const diagnostics = engine => Object.fromEntries(DIAGNOSTIC_COUNTERS.map(key => [key, engine.getStats()[key]]));
    const viewport = TranslateItViewportPrototype.createEngine({ root });
    let before = diagnostics(viewport);
    expect(viewport.refresh()).toBeUndefined();
    expect(diagnostics(viewport)).toEqual(before);
    expect(viewport.getStats().pendingJobCount).toBe(0);
    await viewport.start(); await viewport.whenIdle();
    viewport.stop(); before = diagnostics(viewport);
    viewport.refresh(); await viewport.whenIdle();
    expect(diagnostics(viewport)).toEqual(before);
    await viewport.restore(); before = diagnostics(viewport);
    viewport.refresh(); expect(diagnostics(viewport)).toEqual(before);
    await viewport.cleanup(); before = diagnostics(viewport);
    viewport.refresh(); expect(diagnostics(viewport)).toEqual(before);
    expect(viewport.getStats()).toMatchObject({ ownedNodes: 0, observerCount: 0, pendingJobCount: 0 });

    const baseline = TranslateItViewportPrototype.createEngine({ root, mode: 'baseline' });
    before = diagnostics(baseline); baseline.refresh(); expect(diagnostics(baseline)).toEqual(before);
    await baseline.start(); await baseline.whenIdle(); before = diagnostics(baseline);
    baseline.refresh(); expect(diagnostics(baseline)).toEqual(before);
    expect(baseline.getStats().discoveryRequestsRefresh).toBe(0);
    await baseline.cleanup();
  });

  it('coalesces refreshes into one follow-up pass for an active explicit viewport pass', async () => {
    document.body.innerHTML = '<main>' + '<p>Refresh target</p>'.repeat(20) + '</main>';
    const root = document.querySelector('main'); document.elementFromPoint = () => null;
    vi.useFakeTimers();
    try {
      const engine = TranslateItViewportPrototype.createEngine({ root, maxStepsPerSlice: 1 });
      const started = engine.start(); await vi.runAllTimersAsync(); await started; await engine.whenIdle();
      const translated = engine.getStats().translatedNodes;
      engine.refresh();
      await vi.advanceTimersToNextTimerAsync(); await vi.advanceTimersToNextTimerAsync();
      engine.refresh(); engine.refresh();
      expect(engine.getStats()).toMatchObject({ discoveryRequestsRefresh: 3, discoveryRequestsStart: 1, discoveryRequests: 4, discoveryRequestsImmediate: 2, discoveryRequestsCoalesced: 2, discoveryPasses: 2, discoveryFollowupPasses: 0 });
      await vi.runAllTimersAsync(); await engine.whenIdle();
      const stats = engine.getStats();
      expect(stats).toMatchObject({ discoveryRequests: 4, discoveryRequestsRefresh: 3, discoveryRequestsImmediate: 2, discoveryRequestsCoalesced: 2, discoveryPasses: 3, discoveryFollowupPasses: 1, translatedNodes: translated, pendingJobCount: 0 });
      expect(stats.discoveryRequests).toBe(stats.discoveryRequestsStart + stats.discoveryRequestsScroll + stats.discoveryRequestsResize + stats.discoveryRequestsDomMutation + stats.discoveryRequestsHeadMutation + stats.discoveryRequestsBodyMutation + stats.discoveryRequestsStylesheetLoad + stats.discoveryRequestsStylesheetError + stats.discoveryRequestsRefresh);
      expect(stats.discoveryPasses).toBe(stats.discoveryRequestsImmediate + stats.discoveryFollowupPasses);
      const cleanup = engine.cleanup(); await vi.runAllTimersAsync(); await cleanup;
      expect(engine.getStats()).toMatchObject({ ownedNodes: 0, observerCount: 0, pendingJobCount: 0 });
    } finally { vi.useRealTimers(); }
  });

  it('observes scrolling and open shadow roots; leaves detached and external edits alone', async () => {
    document.body.innerHTML = '<main><p data-y="5000">Later</p><x-card></x-card></main>';
    const shadow = document.querySelector('x-card').attachShadow({ mode: 'open' });
    shadow.append(document.createTextNode('Shadow text'));
    const engine = TranslateItViewportPrototype.createEngine({ root: document.querySelector('main'), mode: 'viewport' });
    await engine.start();
    const p = document.querySelector('p'); p.dataset.y = '0';
    window.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(p.textContent).toBe('⟦TI⟧Later'));
    expect(shadow.textContent).toBe('⟦TI⟧Shadow text');
    p.firstChild.nodeValue = 'host edit';
    p.remove();
    await engine.cleanup();
    expect(p.textContent).toBe('host edit');
    expect(engine.getStats().restoredNodes).toBe(1);
  });

  it('seeds the visible deep target before the sliced background pass completes', async () => {
    document.body.innerHTML = '<main>' + '<p data-y="5000">Far</p>'.repeat(50) + '<p data-y="0">Deep visible</p></main>';
    const visible = document.querySelector('main').lastElementChild;
    document.elementFromPoint = () => visible;
    const engine = TranslateItViewportPrototype.createEngine({ root: document.querySelector('main'), maxStepsPerSlice: 1 });
    const started = engine.start();
    await vi.waitFor(() => expect(visible.textContent).toBe('⟦TI⟧Deep visible'));
    expect(engine.getStats().visitedNodes).toBeLessThan(100);
    await engine.cleanup(); await started;
  });

  it('keeps overlapping seed and root traversal within one-node timer slices', async () => {
    const children = '<p data-y="0">Visible seed child</p>'.repeat(12);
    document.body.innerHTML = `<main><section data-y="0">${children}</section></main>`;
    const root = document.querySelector('main');
    document.elementFromPoint = () => root.firstElementChild;
    vi.useFakeTimers();
    try {
      const engine = TranslateItViewportPrototype.createEngine({ root, maxStepsPerSlice: 1 });
      const started = engine.start();
      expect(engine.getStats().visitedNodes).toBe(0);
      for (let i = 0; i < 3; i++) window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('resize'));
      expect(engine.getStats()).toMatchObject({ discoveryRequests: 5, discoveryRequestsStart: 1, discoveryRequestsScroll: 3, discoveryRequestsResize: 1, discoveryRequestsImmediate: 1, discoveryRequestsCoalesced: 4, discoveryPasses: 1 });
      for (let i = 0; i < 8; i++) {
        const before = engine.getStats().visitedNodes;
        await vi.advanceTimersToNextTimerAsync();
        expect(engine.getStats().visitedNodes - before).toBeLessThanOrEqual(1);
      }
      await vi.runAllTimersAsync(); await started;
      const domNodeCount = root.querySelectorAll('*').length + root.querySelectorAll('*').length + 1;
      expect(engine.getStats().visitedNodes).toBeGreaterThan(domNodeCount);
      expect(engine.getStats().discoveryPasses).toBe(2);
      expect(engine.getStats().discoveryFollowupPasses).toBe(1);
      expect(engine.getStats().visitedNodes).toBe(engine.getStats().seedAncestorVisits + engine.getStats().seedSubtreeVisits + engine.getStats().rootTraversalVisits);
      expect(engine.getStats().seedTargetRepeatVisits).toBe(engine.getStats().discoveryPasses);
      const completed = engine.getStats();
      window.dispatchEvent(new Event('scroll'));
      expect(engine.getStats()).toMatchObject({ discoveryRequests: completed.discoveryRequests + 1, discoveryRequestsScroll: completed.discoveryRequestsScroll + 1, discoveryRequestsImmediate: completed.discoveryRequestsImmediate + 1, discoveryRequestsCoalesced: completed.discoveryRequestsCoalesced, discoveryPasses: completed.discoveryPasses + 1 });
      await vi.runAllTimersAsync(); await engine.whenIdle();
      const cleanup = engine.cleanup(); await vi.runAllTimersAsync(); await cleanup;
    } finally { vi.useRealTimers(); }
  }, 15000);

  it('does not observe a shadow host removed between viewport slices', async () => {
    document.body.innerHTML = '<main><x-card data-y="0"></x-card></main>';
    const root = document.querySelector('main'), host = root.firstElementChild, shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<p>Detached shadow source</p>';
    document.elementFromPoint = () => null;
    vi.useFakeTimers();
    try {
      const engine = TranslateItViewportPrototype.createEngine({ root, maxStepsPerSlice: 1 });
      const started = engine.start();
      await vi.advanceTimersToNextTimerAsync(); // initialize the sliced pass
      await vi.advanceTimersToNextTimerAsync(); // visit the root, but not its child
      expect(engine.getStats().visitedNodes).toBe(1);
      host.remove();
      await vi.runAllTimersAsync(); await started; await engine.whenIdle();
      expect(engine.getStats().observerCount).toBe(1);
      expect(engine.getStats().seedAncestorVisits).toBe(0);
      expect(engine.getStats().seedSubtreeVisits).toBe(0);
      expect(engine.getStats().rootTraversalVisits).toBe(engine.getStats().visitedNodes);
      expect(engine.getStats().seedTargetRepeatVisits).toBe(0);
      expect(shadow.textContent).toBe('Detached shadow source');
      await engine.cleanup();
    } finally { vi.useRealTimers(); }
  });

  it('keeps the configured root observer while its root is detached and reinserted', async () => {
    document.body.innerHTML = '<main><p data-y="0">Old subtree</p></main>';
    const root = document.querySelector('main'), old = root.firstElementChild;
    const engine = TranslateItViewportPrototype.createEngine({ root, maxStepsPerSlice: 1 });
    await engine.start(); await engine.whenIdle();
    root.remove(); old.remove();
    const passes = engine.getStats().discoveryPasses;
    await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes));
    expect(engine.getStats().observerCount).toBe(1);
    document.body.append(root);
    const added = document.createElement('p'); added.dataset.y = '0'; added.textContent = 'Reinserted subtree'; root.append(added);
    await vi.waitFor(() => expect(added.textContent).toBe('⟦TI⟧Reinserted subtree'));
    expect(engine.getStats().observerCount).toBe(1);
    await engine.cleanup();
  });

  it('keeps eligible contenteditable=false descendants inside an editable ancestor', async () => {
    document.body.innerHTML = '<main><section contenteditable="true"><p contenteditable="false" data-y="0">Eligible child</p></section></main>';
    const engine = TranslateItViewportPrototype.createEngine({ root: document.querySelector('main'), maxStepsPerSlice: 1 });
    await engine.start(); await engine.whenIdle();
    expect(document.querySelector('p').textContent).toBe('⟦TI⟧Eligible child');
    await engine.cleanup();
  });

  it('checks exclusions only for candidate writes instead of attrless containers or owned rediscovery', async () => {
    const markup = '<main>' + '<div></div>'.repeat(60) + '<p data-y="0" title="Tip" alt="Alt">Visible</p></main>';
    const originalMatches = Element.prototype.matches;
    let selectorChecks = 0;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function(selector) { selectorChecks++; return originalMatches.call(this, selector); });

    document.body.innerHTML = markup;
    const baseline = TranslateItViewportPrototype.createEngine({ root: document.querySelector('main'), mode: 'baseline', excludedSelectors: ['.never-match'] });
    selectorChecks = 0; await baseline.start();
    const baselineChecks = selectorChecks;
    await baseline.cleanup();

    document.body.innerHTML = markup;
    const root = document.querySelector('main'), engine = TranslateItViewportPrototype.createEngine({ root, excludedSelectors: ['.never-match'] });
    selectorChecks = 0; await engine.start(); await engine.whenIdle();
    const viewportChecks = selectorChecks;
    expect(viewportChecks).toBeLessThan(baselineChecks);
    expect(root.lastElementChild.textContent).toBe('⟦TI⟧Visible');
    selectorChecks = 0; window.dispatchEvent(new Event('scroll')); await engine.whenIdle();
    expect(selectorChecks).toBe(0);
    await engine.cleanup();
  });

  it('does not trim large excluded text during discovery or rediscovery', async () => {
    document.body.innerHTML = '<main><p data-y="0">Visible control</p></main>';
    const root = document.querySelector('main'), payload = ' '.repeat(2 * 1024 * 1024);
    for (const tag of ['script', 'code', 'pre']) {
      const excluded = document.createElement(tag);
      excluded.append(document.createTextNode(payload));
      root.append(excluded);
    }
    const originalTrim = String.prototype.trim;
    let largeStringTrims = 0;
    vi.spyOn(String.prototype, 'trim').mockImplementation(function() {
      if (this.length === payload.length) largeStringTrims++;
      return originalTrim.call(this);
    });

    const engine = TranslateItViewportPrototype.createEngine({ root });
    await engine.start(); await engine.whenIdle();
    expect(largeStringTrims).toBe(0);
    expect(root.querySelector('p').textContent).toBe('⟦TI⟧Visible control');
    const initialVisits = engine.getStats().visitedNodes;
    window.dispatchEvent(new Event('scroll')); await engine.whenIdle();
    expect(engine.getStats().visitedNodes).toBeGreaterThan(initialVisits);
    expect(largeStringTrims).toBe(0);
    await engine.cleanup();
  });

  it('revalidates later attributes after synchronous custom-element reactions', async () => {
    const eligibleTag = 'x-p2-reactive-eligibility', detachedTag = 'x-p2-reactive-detach';
    if (!customElements.get(eligibleTag)) customElements.define(eligibleTag, class extends HTMLElement {
      static observedAttributes = ['title'];
      attributeChangedCallback(name, oldValue, value) { if (name === 'title' && value?.startsWith('⟦TI⟧')) this.setAttribute('contenteditable', 'true'); }
    });
    if (!customElements.get(detachedTag)) customElements.define(detachedTag, class extends HTMLElement {
      static observedAttributes = ['title'];
      attributeChangedCallback(name, oldValue, value) { if (name === 'title' && value?.startsWith('⟦TI⟧')) this.remove(); }
    });
    document.body.innerHTML = `<main><${eligibleTag} data-y="0" title="Eligible title" alt="Keep original">Editable reaction</${eligibleTag}><${detachedTag} data-y="0" title="Detached title" alt="Detached original">Detached reaction</${detachedTag}></main>`;
    const root = document.querySelector('main'), eligible = root.querySelector(eligibleTag), detached = root.querySelector(detachedTag);
    const engine = TranslateItViewportPrototype.createEngine({ root, maxStepsPerSlice: 1 });
    await engine.start(); await engine.whenIdle();
    expect(eligible.title).toBe('⟦TI⟧Eligible title');
    expect(eligible.getAttribute('alt')).toBe('Keep original');
    expect(eligible.textContent).toBe('Editable reaction');
    expect(detached.title).toBe('⟦TI⟧Detached title');
    expect(detached.getAttribute('alt')).toBe('Detached original');
    await engine.cleanup();
    expect(detached.title).toBe('Detached title');
  });

  it('preserves external edits to owned text and attributes during rediscovery and restore', async () => {
    document.body.innerHTML = '<main><p data-y="0" title="Source title">Source text</p></main>';
    const root = document.querySelector('main'), p = root.firstElementChild;
    const engine = TranslateItViewportPrototype.createEngine({ root, maxStepsPerSlice: 1 });
    await engine.start(); await engine.whenIdle();
    p.firstChild.nodeValue = 'External text'; p.title = 'External title';
    await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    window.dispatchEvent(new Event('scroll')); await engine.whenIdle();
    expect(p.textContent).toBe('External text'); expect(p.title).toBe('External title');
    await engine.cleanup();
    expect(p.textContent).toBe('External text'); expect(p.title).toBe('External title');
    expect(engine.getStats().preservedExternalNodes).toBe(2);
  });

  it('skips unrelated data attributes but reaudits CSS when stylesheets change', async () => {
    document.body.innerHTML = '<main><p id="plain">Plain text</p><x-card></x-card></main>';
    const shadow = document.querySelector('x-card').attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>.decorated { color: red }</style><p class="decorated">Shadow text</p>';
    const root = document.querySelector('main'), plain = document.querySelector('#plain'), shadowText = shadow.querySelector('p');
    const engine = TranslateItViewportPrototype.createEngine({ root, maxStepsPerSlice: 2 });
    await engine.start(); await engine.whenIdle();
    const passes = engine.getStats().discoveryPasses, visits = engine.getStats().visitedNodes;
    for (let i = 0; i < 8; i++) {
      plain.dataset.noise = `root-${i}`; shadowText.dataset.noise = `shadow-${i}`;
      await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
      expect(engine.getStats().pendingJobCount).toBe(0);
    }
    expect(engine.getStats().discoveryPasses).toBe(passes);
    expect(engine.getStats().visitedNodes).toBe(visits);
    expect(engine.getStats().mutationAuditCount).toBeGreaterThan(0);
    expect(engine.getStats().mutationAuditFallbacks).toBe(0);
    expect(engine.getStats().mutationDataAttributeRecords).toBeGreaterThanOrEqual(16);
    expect(engine.getStats().mutationCssClearBatches).toBeGreaterThan(0);
    expect(engine.getStats().discoveryRequests).toBe(engine.getStats().discoveryRequestsStart);

    const style = document.createElement('style'); style.textContent = '[data-noise] { color: blue }'; root.append(style);
    await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    const afterStylesheet = engine.getStats().discoveryPasses;
    plain.dataset.noise = 'two';
    await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(afterStylesheet));
    await engine.whenIdle();
    expect(engine.getStats().mutationAuditFallbacks).toBe(0);
    expect(engine.getStats().mutationAuditMs).toBeGreaterThanOrEqual(0);
    await engine.cleanup();
  });

  it('invalidates for native attributes, custom exclusions, and shadow host-context selectors', async () => {
    document.body.innerHTML = '<main><p id="target" data-muted="yes">Unblocked text</p><x-card></x-card></main>';
    const host = document.querySelector('x-card'), shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>:host-context([data-theme]) .item { color: red }</style><p class="item">Themed text</p>';
    const target = document.querySelector('#target'), root = document.querySelector('main');
    const engine = TranslateItViewportPrototype.createEngine({ root, excludedSelectors: ['[data-muted]'], maxStepsPerSlice: 2 });
    await engine.start(); await engine.whenIdle();
    expect(target.textContent).toBe('Unblocked text');
    target.classList.add('changed'); target.style.color = 'red'; target.hidden = true;
    const beforeNative = engine.getStats().discoveryPasses;
    await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(beforeNative));
    await engine.whenIdle();
    expect(engine.getStats().mutationRelevantAttributeRecords).toBeGreaterThanOrEqual(3);
    target.hidden = false;
    target.removeAttribute('data-muted');
    await vi.waitFor(() => expect(target.textContent).toBe('⟦TI⟧Unblocked text'));
    await engine.whenIdle();
    const beforeTheme = engine.getStats().discoveryPasses;
    host.setAttribute('data-theme', 'dark');
    await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(beforeTheme));
    await engine.whenIdle();
    expect(engine.getStats().mutationAuditCount).toBeGreaterThan(0);
    await engine.cleanup();
  });

  it('finds data attribute dependencies in nested rules and declaration attr() values', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(document, 'styleSheets');
    Object.defineProperty(document, 'styleSheets', { configurable: true, value: [{ cssRules: [{ type: 4, conditionText: 'screen', cssRules: [{ type: 1, selectorText: '.ancestor:has([data-state])', style: { cssText: 'content: attr(data-state)' } }] }] }] });
    try {
      document.body.innerHTML = '<main><p data-state="old">State text</p></main>';
      const p = document.querySelector('p'), engine = TranslateItViewportPrototype.createEngine({ root: document.querySelector('main') });
      await engine.start(); await engine.whenIdle();
      const passes = engine.getStats().discoveryPasses;
      p.setAttribute('data-state', 'new');
      await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes));
      await engine.whenIdle();
      expect(engine.getStats().mutationAuditFallbacks).toBe(0);
      expect(engine.getStats().mutationCssReferencedBatches).toBe(1);
      await engine.cleanup();
    } finally {
      if (descriptor) Object.defineProperty(document, 'styleSheets', descriptor);
      else delete document.styleSheets;
    }
  });

  it('audits stylesheets in enclosing shadow scopes when the root is inside a shadow tree', async () => {
    document.body.innerHTML = '<x-shell></x-shell>';
    const host = document.querySelector('x-shell'), shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>[data-scope] { color: red }</style><main><p data-scope="old">Scoped text</p></main>';
    const root = shadow.querySelector('main'), p = root.querySelector('p');
    const engine = TranslateItViewportPrototype.createEngine({ root });
    await engine.start(); await engine.whenIdle();
    const passes = engine.getStats().discoveryPasses;
    p.setAttribute('data-scope', 'new');
    await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes));
    await engine.whenIdle();
    expect(engine.getStats().mutationAuditFallbacks).toBe(0);
    expect(engine.getStats().mutationCssReferencedBatches).toBe(1);
    await engine.cleanup();
  });

  it('uses only live shadow stylesheet nodes after repeated replacement', async () => {
    document.body.innerHTML = '<main><x-card></x-card></main>';
    const shadow = document.querySelector('x-card').attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>[data-noise] { color: red }</style><p>Shadow text</p>';
    const root = document.querySelector('main'), p = shadow.querySelector('p'), engine = TranslateItViewportPrototype.createEngine({ root });
    await engine.start(); await engine.whenIdle();
    p.dataset.noise = 'initial';
    await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(1));
    await engine.whenIdle();
    for (let i = 0; i < 12; i++) {
      const before = engine.getStats().discoveryPasses, style = document.createElement('style');
      style.textContent = `.unrelated-${i} { color: blue }`;
      shadow.querySelector('style').remove(); shadow.prepend(style);
      await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(before));
      await engine.whenIdle();
    }
    const visits = engine.getStats().visitedNodes, passes = engine.getStats().discoveryPasses;
    p.dataset.noise = 'after-replacement';
    await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    expect(engine.getStats().discoveryPasses).toBe(passes);
    expect(engine.getStats().visitedNodes).toBe(visits);
    expect(engine.getStats().mutationAuditFallbacks).toBe(0);
    await engine.cleanup();
  });

  it('falls back when discovered shadow stylesheet nodes exceed the audit cap', async () => {
    document.body.innerHTML = '<main><x-card></x-card></main>';
    const shadow = document.querySelector('x-card').attachShadow({ mode: 'open' });
    for (let i = 0; i < 129; i++) { const style = document.createElement('style'); style.textContent = `.rule-${i} { color: red }`; shadow.append(style); }
    const p = document.createElement('p'); p.textContent = 'Shadow text'; shadow.append(p);
    const engine = TranslateItViewportPrototype.createEngine({ root: document.querySelector('main') });
    await engine.start(); await engine.whenIdle();
    const passes = engine.getStats().discoveryPasses;
    p.dataset.noise = 'change';
    await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes));
    await engine.whenIdle();
    expect(engine.getStats().mutationAuditFallbacks).toBe(1);
    for (const style of [...shadow.querySelectorAll('style')]) style.remove();
    await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    const afterRemoval = engine.getStats().discoveryPasses;
    p.dataset.noise = 'after-shadow-style-removal';
    await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    expect(engine.getStats().discoveryPasses).toBe(afterRemoval);
    expect(engine.getStats().mutationAuditFallbacks).toBe(1);
    await engine.cleanup();
  });

  it('prunes nested-shadow uncertainty on detach but preserves it across same-batch reinsert', async () => {
    document.body.innerHTML = '<main><x-outer></x-outer><p id="live">Live text</p></main>';
    const root = document.querySelector('main'), outer = root.querySelector('x-outer');
    const outerShadow = outer.attachShadow({ mode: 'open' }), inner = document.createElement('x-inner'); outerShadow.append(inner);
    const innerShadow = inner.attachShadow({ mode: 'open' });
    for (let i = 0; i < 129; i++) { const style = document.createElement('style'); style.textContent = `.nested-${i} { color: red }`; innerShadow.append(style); }
    const engine = TranslateItViewportPrototype.createEngine({ root, maxStepsPerSlice: 100 });
    await engine.start(); await engine.whenIdle();
    const live = root.querySelector('#live');
    live.dataset.noise = 'initial';
    await vi.waitFor(() => expect(engine.getStats().mutationAuditFallbacks).toBe(1)); await engine.whenIdle();

    outer.remove(); await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    let passes = engine.getStats().discoveryPasses;
    live.dataset.noise = 'detached';
    await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    expect(engine.getStats().discoveryPasses).toBe(passes);
    expect(engine.getStats().mutationAuditFallbacks).toBe(1);

    root.append(outer); await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    live.dataset.noise = 'reattached';
    await vi.waitFor(() => expect(engine.getStats().mutationAuditFallbacks).toBe(2)); await engine.whenIdle();
    const beforeSameBatch = engine.getStats().mutationAuditFallbacks;
    outer.remove(); root.append(outer);
    await new Promise(resolve => setTimeout(resolve, 0));
    live.dataset.noise = 'same-batch-reinsert';
    await vi.waitFor(() => expect(engine.getStats().mutationAuditFallbacks).toBe(beforeSameBatch + 1));
    await engine.whenIdle();
    await engine.cleanup();
  });

  it('retains fallback for a separate live uncertain stylesheet subtree', async () => {
    document.body.innerHTML = '<main><p id="live">Live text</p></main>';
    const root = document.querySelector('main'), live = root.querySelector('#live'), engine = TranslateItViewportPrototype.createEngine({ root });
    await engine.start(); await engine.whenIdle();
    const makeGroup = (prefix) => {
      const section = document.createElement('section');
      for (let i = 0; i < 300; i++) { const style = document.createElement('style'); style.textContent = `.${prefix}-${i} { color:red }`; section.append(style); }
      return section;
    };
    const first = makeGroup('first'), second = makeGroup('second');
    document.body.append(first); await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    document.body.append(second); await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    live.dataset.noise = 'two-live-roots';
    await vi.waitFor(() => expect(engine.getStats().mutationAuditFallbacks).toBe(1)); await engine.whenIdle();
    first.remove(); await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    live.dataset.noise = 'second-root-remains';
    await vi.waitFor(() => expect(engine.getStats().mutationAuditFallbacks).toBe(2)); await engine.whenIdle();
    second.remove(); await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    const passes = engine.getStats().discoveryPasses;
    live.dataset.noise = 'all-roots-removed'; await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    expect(engine.getStats().discoveryPasses).toBe(passes);
    expect(engine.getStats().mutationAuditFallbacks).toBe(2);
    await engine.cleanup();
  });

  it('keeps pending document stylesheets outside a removed translation subtree', async () => {
    document.body.innerHTML = '<main><section id="removed"><i></i></section><p id="live">Live text</p></main><link rel="stylesheet" href="/outside-root.css">';
    const root = document.querySelector('main'), removed = root.querySelector('#removed'), live = root.querySelector('#live');
    const engine = TranslateItViewportPrototype.createEngine({ root });
    await engine.start(); await engine.whenIdle();
    removed.remove(); await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    live.dataset.noise = 'outside-resource-stays-live';
    await vi.waitFor(() => expect(engine.getStats().mutationAuditFallbacks).toBe(1)); await engine.whenIdle();
    await engine.cleanup();
  });

  it('invalidates namespaced attribute mutations instead of treating them as plain data attributes', async () => {
    document.body.innerHTML = '<main><p>Namespaced target</p></main>';
    const root = document.querySelector('main'), p = root.querySelector('p'), engine = TranslateItViewportPrototype.createEngine({ root });
    await engine.start(); await engine.whenIdle();
    const passes = engine.getStats().discoveryPasses;
    p.setAttributeNS('urn:example', 'x:data-noise', 'changed');
    await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes));
    await engine.whenIdle();
    expect(engine.getStats().mutationAuditCount).toBe(0);
    expect(engine.getStats().mutationRelevantAttributeRecords).toBe(1);
    await engine.cleanup();
  });

  it('falls back conservatively for inaccessible, escaped, imported, and oversized CSSOM audits', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(document, 'styleSheets');
    const cases = [
      [{ get cssRules() { throw new Error('blocked stylesheet'); } }],
      [{ cssRules: [{ type: 3, styleSheet: null }] }],
      [{ cssRules: [{ type: 1, selectorText: '[data\\\\2d noise]', style: { cssText: '' } }] }],
      [{ cssRules: Array.from({ length: 513 }, () => ({ type: 1, selectorText: '.unrelated', style: { cssText: '' } })) }],
    ];
    try {
      for (const sheets of cases) {
        Object.defineProperty(document, 'styleSheets', { configurable: true, value: sheets });
        document.body.innerHTML = '<main><p>Audit fallback</p></main>';
        const p = document.querySelector('p'), engine = TranslateItViewportPrototype.createEngine({ root: document.querySelector('main') });
        await engine.start(); await engine.whenIdle();
        const passes = engine.getStats().discoveryPasses;
        p.dataset.noise = 'changed';
        await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes));
        await engine.whenIdle();
        expect(engine.getStats().mutationAuditCount).toBe(1);
        expect(engine.getStats().mutationAuditFallbacks).toBe(1);
        expect(engine.getStats().mutationCssFallbackBatches).toBe(1);
        await engine.cleanup();
      }
    } finally {
      if (descriptor) Object.defineProperty(document, 'styleSheets', descriptor);
      else delete document.styleSheets;
    }
  });

  it('keeps data mutations conservative while an initial stylesheet link is pending', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(document, 'styleSheets');
    document.body.innerHTML = '<main><p>Pending stylesheet</p></main>';
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/pending.css'; document.head.append(link);
    const root = document.querySelector('main'), p = root.querySelector('p');
    const engine = TranslateItViewportPrototype.createEngine({ root });
    try {
      await engine.start(); await engine.whenIdle();
      let passes = engine.getStats().discoveryPasses;
      p.dataset.show = 'one';
      await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes));
      await engine.whenIdle();
      expect(engine.getStats().mutationAuditFallbacks).toBe(1);

      const sheet = { cssRules: [{ type: 1, selectorText: '[data-show]', style: { cssText: 'content: attr(data-show)' } }] };
      Object.defineProperty(link, 'sheet', { configurable: true, value: sheet });
      Object.defineProperty(document, 'styleSheets', { configurable: true, value: [sheet] });
      passes = engine.getStats().discoveryPasses;
      link.dispatchEvent(new Event('load'));
      await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes));
      await engine.whenIdle();
      passes = engine.getStats().discoveryPasses;
      p.dataset.show = 'two';
      await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes));
      await engine.whenIdle();
      expect(engine.getStats().mutationAuditFallbacks).toBe(1);
    } finally {
      await engine.cleanup();
      if (descriptor) Object.defineProperty(document, 'styleSheets', descriptor);
      else delete document.styleSheets;
      link.remove();
    }
  });

  it('tracks dynamically added pending links and releases head listeners on cleanup', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(document, 'styleSheets');
    document.body.innerHTML = '<main><p>Dynamic stylesheet</p></main>';
    const root = document.querySelector('main'), p = root.querySelector('p'), engine = TranslateItViewportPrototype.createEngine({ root });
    try {
      await engine.start(); await engine.whenIdle();
      const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/dynamic.css';
      let passes = engine.getStats().discoveryPasses;
      const headRequests = engine.getStats().discoveryRequestsHeadMutation;
      document.head.append(link);
      await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes));
      await engine.whenIdle();
      expect(engine.getStats().discoveryRequestsHeadMutation).toBeGreaterThan(headRequests);
      p.dataset.dynamic = 'one';
      await vi.waitFor(() => expect(engine.getStats().mutationAuditFallbacks).toBe(1));
      await engine.whenIdle();

      const sheet = { cssRules: [{ type: 1, selectorText: '[data-dynamic]', style: { cssText: '' } }] };
      Object.defineProperty(link, 'sheet', { configurable: true, value: sheet });
      Object.defineProperty(document, 'styleSheets', { configurable: true, value: [sheet] });
      passes = engine.getStats().discoveryPasses;
      const loadRequests = engine.getStats().discoveryRequestsStylesheetLoad;
      link.dispatchEvent(new Event('load'));
      await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes));
      await engine.whenIdle();
      expect(engine.getStats().discoveryRequestsStylesheetLoad).toBe(loadRequests + 1);
      passes = engine.getStats().discoveryPasses;
      p.dataset.dynamic = 'two';
      await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes));
      await engine.whenIdle();
      expect(engine.getStats().mutationAuditFallbacks).toBe(1);

      const failed = document.createElement('link'); failed.rel = 'stylesheet'; failed.href = '/failed.css';
      const requestsBeforeFailure = engine.getStats().discoveryRequestsHeadMutation;
      document.head.append(failed); await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
      expect(engine.getStats().discoveryRequestsHeadMutation).toBeGreaterThan(requestsBeforeFailure);
      const errorRequests = engine.getStats().discoveryRequestsStylesheetError;
      failed.dispatchEvent(new Event('error')); await engine.whenIdle();
      expect(engine.getStats().discoveryRequestsStylesheetError).toBe(errorRequests + 1);

      await engine.cleanup();
      passes = engine.getStats().discoveryPasses;
      const late = document.createElement('link'); late.rel = 'stylesheet'; late.href = '/late.css'; document.head.append(late);
      late.dispatchEvent(new Event('load'));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(engine.getStats()).toMatchObject({ discoveryPasses: passes, pendingJobCount: 0 });
      late.remove(); failed.remove(); link.remove();
    } finally {
      await engine.cleanup();
      if (descriptor) Object.defineProperty(document, 'styleSheets', descriptor);
      else delete document.styleSheets;
    }
  });

  it('tracks body stylesheet links and rescans when a link load changes viewport geometry', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(document, 'styleSheets');
    document.body.innerHTML = '<main><link id="initial-link" rel="stylesheet" href="/body.css"><p id="body-target" data-show="one">Body stylesheet text</p></main>';
    let targetVisible = false;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function() {
      if (this.id === 'body-target' && !targetVisible) return { top: 5000, bottom: 5020, left: 0, right: 100, width: 100, height: 20 };
      const y = Number(this.dataset.y || 0);
      return { top: y, bottom: y + 20, left: 0, right: 100, width: 100, height: 20 };
    });
    const root = document.querySelector('main'), p = root.querySelector('p'), initialLink = root.querySelector('link');
    const engine = TranslateItViewportPrototype.createEngine({ root });
    try {
      await engine.start(); await engine.whenIdle();
      expect(p.textContent).toBe('Body stylesheet text');
      let passes = engine.getStats().discoveryPasses;
      p.dataset.show = 'two';
      await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes));
      await engine.whenIdle();
      expect(engine.getStats().mutationAuditFallbacks).toBe(1);

      const sheet = { cssRules: [{ type: 1, selectorText: '[data-show]', style: { cssText: 'content: attr(data-show)' } }] };
      Object.defineProperty(initialLink, 'sheet', { configurable: true, value: sheet });
      Object.defineProperty(document, 'styleSheets', { configurable: true, value: [sheet] });
      targetVisible = true; passes = engine.getStats().discoveryPasses;
      initialLink.dispatchEvent(new Event('load'));
      await vi.waitFor(() => expect(p.textContent).toBe('⟦TI⟧Body stylesheet text'));
      await engine.whenIdle();
      expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes);

      const dynamic = document.createElement('link'); dynamic.rel = 'stylesheet'; dynamic.href = '/dynamic-body.css';
      passes = engine.getStats().discoveryPasses; root.append(dynamic);
      await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes));
      await engine.whenIdle();
      p.dataset.unrelated = 'one';
      await vi.waitFor(() => expect(engine.getStats().mutationAuditFallbacks).toBe(2));
      await engine.whenIdle();

      const beforeCleanup = engine.getStats().discoveryPasses;
      await engine.cleanup();
      dynamic.dispatchEvent(new Event('load'));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(engine.getStats()).toMatchObject({ discoveryPasses: beforeCleanup, pendingJobCount: 0 });
      dynamic.remove();
    } finally {
      await engine.cleanup();
      if (descriptor) Object.defineProperty(document, 'styleSheets', descriptor);
      else delete document.styleSheets;
    }
  });

  it('tracks pending stylesheet links outside a narrower translation root', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(document, 'styleSheets');
    document.body.innerHTML = '<main><p id="target" data-show="first">Outside-root link</p></main><link id="external" rel="stylesheet" href="/external.css">';
    let targetVisible = false;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function() {
      if (this.id === 'target' && !targetVisible) return { top: 5000, bottom: 5020, left: 0, right: 100, width: 100, height: 20 };
      const y = Number(this.dataset.y || 0);
      return { top: y, bottom: y + 20, left: 0, right: 100, width: 100, height: 20 };
    });
    const root = document.querySelector('main'), p = root.querySelector('p'), link = document.querySelector('#external');
    const engine = TranslateItViewportPrototype.createEngine({ root });
    let dynamic;
    try {
      await engine.start(); await engine.whenIdle();
      let passes = engine.getStats().discoveryPasses;
      p.dataset.show = 'second';
      await vi.waitFor(() => expect(engine.getStats().mutationAuditFallbacks).toBe(1));
      await engine.whenIdle();

      const sheet = { cssRules: [{ type: 1, selectorText: '[data-show]', style: { cssText: '' } }] };
      Object.defineProperty(link, 'sheet', { configurable: true, value: sheet });
      Object.defineProperty(document, 'styleSheets', { configurable: true, value: [sheet] });
      targetVisible = true;
      link.dispatchEvent(new Event('load'));
      await vi.waitFor(() => expect(p.textContent).toBe('⟦TI⟧Outside-root link'));
      await engine.whenIdle();
      expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes);

      dynamic = document.createElement('link'); dynamic.rel = 'stylesheet'; dynamic.href = '/dynamic-external.css';
      passes = engine.getStats().discoveryPasses;
      const bodyRequests = engine.getStats().discoveryRequestsBodyMutation;
      document.body.append(dynamic);
      await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes));
      await engine.whenIdle();
      expect(engine.getStats().discoveryRequestsBodyMutation).toBeGreaterThan(bodyRequests);
      p.dataset.outside = 'one';
      await vi.waitFor(() => expect(engine.getStats().mutationAuditFallbacks).toBe(2));
      await engine.whenIdle();

      const dynamicSheet = { cssRules: [{ type: 1, selectorText: '[data-outside]', style: { cssText: '' } }] };
      Object.defineProperty(dynamic, 'sheet', { configurable: true, value: dynamicSheet });
      Object.defineProperty(document, 'styleSheets', { configurable: true, value: [sheet, dynamicSheet] });
      dynamic.dispatchEvent(new Event('load')); await engine.whenIdle();
      passes = engine.getStats().discoveryPasses; p.dataset.outside = 'two';
      await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes));
      await engine.whenIdle();
      expect(engine.getStats().mutationAuditFallbacks).toBe(2);

      await engine.cleanup();
      passes = engine.getStats().discoveryPasses;
      dynamic.dispatchEvent(new Event('load')); await new Promise(resolve => setTimeout(resolve, 0));
      expect(engine.getStats()).toMatchObject({ discoveryPasses: passes, pendingJobCount: 0 });
    } finally {
      await engine.cleanup(); dynamic?.remove(); link.remove();
      if (descriptor) Object.defineProperty(document, 'styleSheets', descriptor);
      else delete document.styleSheets;
    }
  });

  it('clears temporary CSS uncertainty after an oversized unrelated body subtree is removed', async () => {
    document.body.innerHTML = '<main><p>Unrelated body churn</p></main>';
    const root = document.querySelector('main'), p = root.querySelector('p'), engine = TranslateItViewportPrototype.createEngine({ root });
    await engine.start(); await engine.whenIdle();
    const group = document.createElement('section'); group.innerHTML = '<i></i>'.repeat(600);
    let passes = engine.getStats().discoveryPasses; document.body.append(group);
    await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes));
    await engine.whenIdle();
    passes = engine.getStats().discoveryPasses; group.remove();
    await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes));
    await engine.whenIdle();
    passes = engine.getStats().discoveryPasses; p.dataset.noise = 'after-removal';
    await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    expect(engine.getStats().discoveryPasses).toBe(passes);
    expect(engine.getStats().mutationAuditFallbacks).toBe(0);
    await engine.cleanup();
  });

  it('clears stylesheet-resource-cap fallback when the oversized stylesheet subtree is removed', async () => {
    document.body.innerHTML = '<main><p>Stylesheet resource cap</p></main>';
    const root = document.querySelector('main'), p = root.querySelector('p'), engine = TranslateItViewportPrototype.createEngine({ root });
    await engine.start(); await engine.whenIdle();
    const group = document.createElement('section');
    for (let i = 0; i < 300; i++) { const style = document.createElement('style'); style.textContent = `.resource-${i} { color: red }`; group.append(style); }
    let passes = engine.getStats().discoveryPasses; document.body.append(group);
    await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes)); await engine.whenIdle();
    p.dataset.noise = 'while-styles-live';
    await vi.waitFor(() => expect(engine.getStats().mutationAuditFallbacks).toBe(1)); await engine.whenIdle();
    group.remove(); await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    passes = engine.getStats().discoveryPasses;
    p.dataset.noise = 'after-styles-removed';
    await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    expect(engine.getStats().discoveryPasses).toBe(passes);
    expect(engine.getStats().mutationAuditFallbacks).toBe(1);
    await engine.cleanup();
  });

  it('clears pending-link-cap fallback when the oversized link subtree is removed', async () => {
    document.body.innerHTML = '<main><p>Pending link cap</p></main>';
    const root = document.querySelector('main'), p = root.querySelector('p'), engine = TranslateItViewportPrototype.createEngine({ root });
    await engine.start(); await engine.whenIdle();
    const group = document.createElement('section');
    for (let i = 0; i < 300; i++) { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = `/pending-${i}.css`; group.append(link); }
    let passes = engine.getStats().discoveryPasses; document.body.append(group);
    await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes)); await engine.whenIdle();
    p.dataset.noise = 'while-links-pending';
    await vi.waitFor(() => expect(engine.getStats().mutationAuditFallbacks).toBe(1)); await engine.whenIdle();
    group.remove(); await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    passes = engine.getStats().discoveryPasses;
    p.dataset.noise = 'after-links-removed';
    await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    expect(engine.getStats().discoveryPasses).toBe(passes);
    expect(engine.getStats().mutationAuditFallbacks).toBe(1);
    await engine.cleanup();
  });

  it('rechecks and clears the bounded initial body-link inventory after links are removed', async () => {
    document.body.innerHTML = '<main><p>Initial link inventory</p></main>';
    for (let i = 0; i < 129; i++) { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = `/initial-${i}.css`; document.body.append(link); }
    const root = document.querySelector('main'), p = root.querySelector('p'), engine = TranslateItViewportPrototype.createEngine({ root });
    await engine.start(); await engine.whenIdle();
    p.dataset.noise = 'while-inventory-overflowed';
    await vi.waitFor(() => expect(engine.getStats().mutationAuditFallbacks).toBe(1)); await engine.whenIdle();
    for (const link of [...document.body.querySelectorAll(':scope > link')]) link.remove();
    await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    const passes = engine.getStats().discoveryPasses;
    p.dataset.noise = 'after-inventory-recheck';
    await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    expect(engine.getStats().discoveryPasses).toBe(passes);
    expect(engine.getStats().mutationAuditFallbacks).toBe(1);
    await engine.cleanup();
  });

  it('keeps session fallback when the bounded uncertainty-root registry itself overflows', async () => {
    document.body.innerHTML = '<main><p>Uncertainty registry cap</p></main>';
    const root = document.querySelector('main'), p = root.querySelector('p'), engine = TranslateItViewportPrototype.createEngine({ root });
    await engine.start(); await engine.whenIdle();
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 600; i++) fragment.append(document.createElement('i'));
    const beforeAppend = engine.getStats().discoveryPasses; document.body.append(fragment);
    await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(beforeAppend)); await engine.whenIdle();
    for (const node of [...document.body.querySelectorAll('i')]) node.remove();
    await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    const passes = engine.getStats().discoveryPasses;
    p.dataset.noise = 'after-untracked-overflow';
    await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes));
    await engine.whenIdle();
    expect(engine.getStats().mutationAuditFallbacks).toBe(1);
    await engine.cleanup();
  });

  it('keeps an oversized live subtree fail-closed, then clears that uncertainty on removal', async () => {
    document.body.innerHTML = '<main><p>Unscanned external stylesheet</p></main>';
    const root = document.querySelector('main'), p = root.querySelector('p'), engine = TranslateItViewportPrototype.createEngine({ root });
    await engine.start(); await engine.whenIdle();
    const group = document.createElement('section'); group.innerHTML = '<i></i>'.repeat(600);
    const hiddenLink = document.createElement('link'); hiddenLink.rel = 'stylesheet'; hiddenLink.href = '/past-scan-budget.css'; group.append(hiddenLink);
    let passes = engine.getStats().discoveryPasses; document.body.append(group);
    await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes));
    await engine.whenIdle();
    p.dataset.noise = 'while-live';
    await vi.waitFor(() => expect(engine.getStats().mutationAuditFallbacks).toBe(1));
    await engine.whenIdle();

    passes = engine.getStats().discoveryPasses; group.remove();
    await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passes));
    await engine.whenIdle();
    passes = engine.getStats().discoveryPasses; p.dataset.noise = 'after-removal';
    await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    expect(engine.getStats().discoveryPasses).toBe(passes);
    expect(engine.getStats().mutationAuditFallbacks).toBe(1);
    await engine.cleanup();
  });

  it('prunes large offscreen branches, then discovers their unseen descendants on scroll', async () => {
    const descendants = '<div data-y="5000"><p>Hidden child</p></div>'.repeat(1000);
    document.body.innerHTML = `<main><section id="far" data-y="5000">${descendants}<p data-y="5000">Reveal me</p></section></main>`;
    const root = document.querySelector('main'), branch = document.querySelector('#far'), target = branch.lastElementChild;
    const engine = TranslateItViewportPrototype.createEngine({ root, maxStepsPerSlice: 100 });
    await engine.start(); await engine.whenIdle();
    expect(engine.getStats().prunedBranches).toBeGreaterThan(0);
    expect(engine.getStats().geometryChecks).toBeGreaterThan(0);
    expect(engine.getStats().visitedNodes).toBeLessThan(20);
    expect(target.textContent).toBe('Reveal me');
    branch.dataset.y = '0'; target.dataset.y = '0';
    window.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(target.textContent).toBe('⟦TI⟧Reveal me'), { timeout: 5000 });
    await engine.cleanup();
  });

  it('descends through zero-box containers and reacts to nested and shadow-local scrolls', async () => {
    document.body.innerHTML = '<main><section data-zero><p data-y="0">Zero box child</p><div id="nested"><p id="nested-target">Nested target</p></div><p id="resize-target">Resize target</p><x-card></x-card></section></main>';
    const shadow = document.querySelector('x-card').attachShadow({ mode: 'open' });
    shadow.innerHTML = '<link rel="stylesheet" href="/shadow-local.css"><p id="shadow-target">Shadow target</p>';
    let nestedVisible = false, shadowVisible = false, resizeVisible = false;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function() {
      if (this.hasAttribute('data-zero')) return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
      if (this.id === 'nested-target' && !nestedVisible || this.id === 'shadow-target' && !shadowVisible) return { top: 5000, bottom: 5020, left: 0, right: 100, width: 100, height: 20 };
      if (this.id === 'resize-target' && !resizeVisible) return { top: 5000, bottom: 5020, left: 0, right: 100, width: 100, height: 20 };
      const y = Number(this.dataset.y || 0);
      return { top: y, bottom: y + 20, left: 0, right: 100, width: 100, height: 20 };
    });
    const root = document.querySelector('main'), nested = document.querySelector('#nested'), nestedTarget = document.querySelector('#nested-target'), resizeTarget = document.querySelector('#resize-target'), shadowTarget = shadow.querySelector('#shadow-target');
    const engine = TranslateItViewportPrototype.createEngine({ root, maxStepsPerSlice: 1 });
    await engine.start(); await engine.whenIdle();
    expect(document.querySelector('[data-zero] p').textContent).toBe('⟦TI⟧Zero box child');
    expect(nestedTarget.textContent).toBe('Nested target');
    expect(shadowTarget.textContent).toBe('Shadow target');
    const scrollRequests = engine.getStats().discoveryRequestsScroll;
    nestedVisible = true; nested.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(nestedTarget.textContent).toBe('⟦TI⟧Nested target'));
    shadowVisible = true; shadow.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(shadowTarget.textContent).toBe('⟦TI⟧Shadow target'));
    expect(engine.getStats().discoveryRequestsScroll).toBe(scrollRequests + 2);
    const resizeRequests = engine.getStats().discoveryRequestsResize;
    resizeVisible = true; window.dispatchEvent(new Event('resize'));
    await vi.waitFor(() => expect(resizeTarget.textContent).toBe('⟦TI⟧Resize target'));
    expect(engine.getStats().discoveryRequestsResize).toBe(resizeRequests + 1);
    const loadRequests = engine.getStats().discoveryRequestsStylesheetLoad;
    const shadowLink = shadow.querySelector('link');
    Object.defineProperty(shadowLink, 'sheet', { configurable: true, value: { cssRules: [] } });
    shadowLink.dispatchEvent(new Event('load', { composed: true })); await engine.whenIdle();
    expect(engine.getStats().discoveryRequestsStylesheetLoad).toBe(loadRequests + 1);
    await engine.cleanup();
  });

  it('uses Range visibility only for genuine zero-box text owners', async () => {
    document.body.innerHTML = '<main><p id="normal" title="Normal box title">Normal box text</p><div id="zero">Zero box text</div></main>';
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function() {
      if (this.id === 'zero') return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
      return { top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 };
    });
    const rangeRect = { top: 0, bottom: 18, left: 0, right: 100, width: 100, height: 18 };
    const range = { selectNodeContents: vi.fn(), getClientRects: () => ({ length: 1, item: () => rangeRect }) };
    const createRange = vi.spyOn(document, 'createRange').mockImplementation(() => range);
    const getComputedStyle = vi.spyOn(window, 'getComputedStyle');
    const engine = TranslateItViewportPrototype.createEngine({ root: document.querySelector('main') });
    await engine.start(); await engine.whenIdle();
    expect(document.querySelector('#normal').textContent).toBe('⟦TI⟧Normal box text');
    expect(document.querySelector('#normal').title).toBe('⟦TI⟧Normal box title');
    expect(document.querySelector('#zero').textContent).toBe('⟦TI⟧Zero box text');
    expect(createRange).toHaveBeenCalledTimes(1);
    expect(getComputedStyle).toHaveBeenCalled();
    expect(getComputedStyle.mock.calls.some(([owner]) => owner.id === 'normal')).toBe(true);
    await engine.cleanup();
  });

  it('defaults absent optional style properties but fails closed on unsupported effects', async () => {
    document.body.innerHTML = '<main><div id="basic">Basic styles</div><div id="mask">Masked</div><div id="clip">Clipped</div><div id="transform">Transformed</div><div id="scale">Scaled</div></main>';
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function() {
      if (this.id) return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
      return { top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 };
    });
    const effects = {
      mask: { maskImage: 'url(mask)' }, clip: { clipPath: 'circle(10px)' },
      transform: { transform: 'matrix(1, 0, 0, 1, 0, 0)' }, scale: { scale: '2' },
    };
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element => ({
      display: 'contents', visibility: 'visible', overflowX: 'visible', overflowY: 'visible', ...effects[element.id],
    }));
    const rangeRect = { top: 0, bottom: 18, left: 0, right: 100, width: 100, height: 18 };
    vi.spyOn(document, 'createRange').mockImplementation(() => ({ selectNodeContents() {}, getClientRects: () => ({ length: 1, item: () => rangeRect }) }));
    const engine = TranslateItViewportPrototype.createEngine({ root: document.querySelector('main') });
    await engine.start(); await engine.whenIdle();
    expect(document.querySelector('#basic').textContent).toBe('⟦TI⟧Basic styles');
    for (const id of Object.keys(effects)) expect(document.querySelector(`#${id}`).textContent).not.toContain('⟦TI⟧');
    await engine.cleanup();
  });

  it('uses supported checkVisibility false results and falls back on missing or throwing APIs', async () => {
    document.body.innerHTML = '<main><p id="hidden">Hidden by native API</p><p id="throws">Throwing native API</p><p id="missing">Missing native API</p><x-slot-host id="slot-host">Visible through slot override</x-slot-host></main>';
    const hidden = document.querySelector('#hidden'), throws = document.querySelector('#throws'), missing = document.querySelector('#missing'), host = document.querySelector('#slot-host');
    const calls = [];
    Object.defineProperty(hidden, 'checkVisibility', { configurable: true, value(options) { calls.push(['hidden', options]); return false; } });
    Object.defineProperty(throws, 'checkVisibility', { configurable: true, value() { throw new Error('native visibility unavailable'); } });
    Object.defineProperty(missing, 'checkVisibility', { configurable: true, value: undefined });
    const shadow = host.attachShadow({ mode: 'open' }), slot = document.createElement('slot'); slot.style.cssText = 'display:block;visibility:visible'; shadow.append(slot);
    Object.defineProperty(host.firstChild, 'assignedSlot', { configurable: true, value: slot });
    const shadowQueries = vi.spyOn(shadow, 'querySelectorAll'), assignedNodeLookups = vi.spyOn(slot, 'assignedNodes');
    Object.defineProperty(host, 'checkVisibility', { configurable: true, value(options) { calls.push(['slot', options]); return false; } });
    const engine = TranslateItViewportPrototype.createEngine({ root: document.querySelector('main') });
    await engine.start(); await engine.whenIdle();
    expect(hidden.textContent).toBe('Hidden by native API');
    expect(throws.textContent).toBe('⟦TI⟧Throwing native API');
    expect(missing.textContent).toBe('⟦TI⟧Missing native API');
    expect(host.firstChild.data).toBe('⟦TI⟧Visible through slot override');
    expect(calls.find(([name]) => name === 'hidden')[1]).toMatchObject({ visibilityProperty: true, contentVisibilityAuto: true });
    expect(calls.some(([name]) => name === 'slot')).toBe(false);
    expect(shadowQueries).not.toHaveBeenCalled();
    expect(assignedNodeLookups).not.toHaveBeenCalled();
    await engine.cleanup();
  });

  it('rejects hidden ancestors even when unsupported positioning forces best-effort clipping', async () => {
    document.body.innerHTML = '<main><section id="display-outer" style="display:none"><p id="display-child" style="position:absolute">Display hidden</p></section><section id="content-outer" style="content-visibility:hidden"><p id="content-child" style="position:fixed">Content hidden</p></section><section id="visibility-outer" style="visibility:hidden"><p id="visibility-child" style="visibility:visible">Visibility override</p></section></main>';
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 });
    const engine = TranslateItViewportPrototype.createEngine({ root: document.querySelector('main') });
    await engine.start(); await engine.whenIdle();
    expect(document.querySelector('#display-child').textContent).toBe('Display hidden');
    expect(document.querySelector('#content-child').textContent).toBe('Content hidden');
    expect(document.querySelector('#visibility-child').textContent).toBe('⟦TI⟧Visibility override');
    await engine.cleanup();
  });

  it('records available hidden styles before falling back on incomplete style metadata', async () => {
    document.body.innerHTML = '<main><p id="hidden-start">Hidden start</p><section id="hidden-outer" style="content-visibility:hidden"><p id="unsupported-inner">Hidden outer</p></section></main>';
    const hiddenStart = document.querySelector('#hidden-start'), hiddenOuter = document.querySelector('#hidden-outer'), unsupportedInner = document.querySelector('#unsupported-inner');
    Object.defineProperty(unsupportedInner, 'checkVisibility', { configurable: true, value: () => true });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 });
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    const styleCalls = [], styleReads = { hiddenStart: {}, hiddenOuter: {}, unsupportedInner: {} };
    const trackedStyle = (name, values) => new Proxy(values, { get(target, key, receiver) {
      styleReads[name][key] = (styleReads[name][key] || 0) + 1;
      return Reflect.get(target, key, receiver);
    } });
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
      styleCalls.push(element);
      if (element === hiddenStart) return trackedStyle('hiddenStart', { display: 'block', visibility: 'hidden', overflowX: 'visible', overflowY: 'visible' });
      if (element === unsupportedInner) return trackedStyle('unsupportedInner', { display: 'block', visibility: 'visible', overflowX: 'visible', overflowY: 'visible' });
      if (element === hiddenOuter) return trackedStyle('hiddenOuter', { display: 'block', visibility: 'visible', contentVisibility: 'hidden', overflowX: 'visible', overflowY: 'visible', position: 'static' });
      return nativeGetComputedStyle(element);
    });
    const engine = TranslateItViewportPrototype.createEngine({ root: document.querySelector('main') });
    await engine.start(); await engine.whenIdle();
    expect(hiddenStart.textContent).toBe('Hidden start');
    expect(unsupportedInner.textContent).toBe('Hidden outer');
    expect(styleCalls.filter(element => element === hiddenStart)).toHaveLength(1);
    expect(styleCalls.filter(element => element === unsupportedInner)).toHaveLength(1);
    expect(styleCalls.filter(element => element === hiddenOuter)).toHaveLength(1);
    expect(styleReads.hiddenStart.position).toBeUndefined();
    expect(styleReads.unsupportedInner.position).toBe(1);
    expect(styleReads.hiddenOuter.display).toBe(1);
    expect(styleReads.hiddenOuter.contentVisibility).toBe(1);
    for (const key of ['visibility', 'overflowX', 'overflowY', 'position', 'transform', 'filter']) expect(styleReads.hiddenOuter[key]).toBeUndefined();
    await engine.cleanup();
  });

  it('uses best-effort admission beyond the positive-visibility ancestor cap', async () => {
    document.body.innerHTML = '<main></main>';
    const root = document.querySelector('main'); let parent = root, farAncestor;
    for (let i = 0; i < 70; i++) { const ancestor = document.createElement('div'); parent.append(ancestor); parent = ancestor; farAncestor ??= ancestor; }
    farAncestor.style.display = 'none';
    const target = document.createElement('p'); target.textContent = 'Beyond visibility cap'; parent.append(target);
    const engine = TranslateItViewportPrototype.createEngine({ root });
    await engine.start(); await engine.whenIdle();
    expect(target.textContent).toBe('⟦TI⟧Beyond visibility cap');
    await engine.cleanup();
  });

  it('uses clip-intersected Range fragments for positive owners but keeps Attr owner-box visibility', async () => {
    document.body.innerHTML = '<main><section id="clip"><p id="full" title="Full owner">Full clipped text</p><p id="partial" title="Partial owner">Partial clipped text</p></section></main>';
    const clip = document.querySelector('#clip'), full = document.querySelector('#full'), partial = document.querySelector('#partial');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function() {
      if (this === clip) return { top: 0, bottom: 30, left: 0, right: 50, width: 50, height: 30 };
      if (this === full || this === partial) return { top: 0, bottom: 20, left: 0, right: 40, width: 40, height: 20 };
      return { top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 };
    });
    for (const key of ['clientLeft', 'clientTop']) Object.defineProperty(clip, key, { configurable: true, value: 0 });
    Object.defineProperty(clip, 'clientWidth', { configurable: true, value: 50 });
    Object.defineProperty(clip, 'clientHeight', { configurable: true, value: 30 });
    Object.defineProperty(clip, 'clientWidth', { configurable: true, value: 50 });
    Object.defineProperty(clip, 'clientHeight', { configurable: true, value: 30 });
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element => element === clip
      ? { display: 'block', visibility: 'visible', overflowX: 'hidden', overflowY: 'hidden', position: 'static' }
      : nativeGetComputedStyle(element));
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      let target;
      return { selectNodeContents(node) { target = node; }, getClientRects() {
        const rect = target.parentElement === full
          ? { top: 0, bottom: 18, left: 60, right: 80, width: 20, height: 18 }
          : { top: 0, bottom: 18, left: 10, right: 30, width: 20, height: 18 };
        return { length: 1, item: () => rect };
      } };
    });
    const engine = TranslateItViewportPrototype.createEngine({ root: document.querySelector('main') });
    await engine.start(); await engine.whenIdle();
    expect(full.textContent).toBe('Full clipped text');
    expect(full.title).toBe('⟦TI⟧Full owner');
    expect(partial.textContent).toBe('⟦TI⟧Partial clipped text');
    expect(partial.title).toBe('⟦TI⟧Partial owner');
    await engine.cleanup();
  });

  it('keeps V1 positive-box admission on unsupported style, clip, and Range APIs', async () => {
    for (const missing of ['style', 'clip', 'range']) {
      document.body.innerHTML = '<main><section id="clip"><p id="target">Off-clip range</p></section></main>';
      const clip = document.querySelector('#clip'), target = document.querySelector('#target');
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function() {
        if (this === clip) return { top: 0, bottom: 30, left: 0, right: 50, width: 50, height: 30 };
        if (this === target) return { top: 0, bottom: 20, left: 0, right: 40, width: 40, height: 20 };
        return { top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 };
      });
      Object.defineProperty(clip, 'clientLeft', { configurable: true, value: 0 });
      Object.defineProperty(clip, 'clientTop', { configurable: true, value: 0 });
      Object.defineProperty(clip, 'clientWidth', { configurable: true, value: missing === 'clip' ? undefined : 50 });
      Object.defineProperty(clip, 'clientHeight', { configurable: true, value: 30 });
      const nativeGetComputedStyle = window.getComputedStyle.bind(window);
      vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
        if (missing === 'style' && element === target) throw new Error('computed style unavailable');
        if (element === clip) return { display: 'block', visibility: 'visible', overflowX: 'hidden', overflowY: 'hidden', position: 'static' };
        return nativeGetComputedStyle(element);
      });
      vi.spyOn(document, 'createRange').mockImplementation(() => {
        if (missing === 'range') throw new Error('Range unavailable');
        return { selectNodeContents() {}, getClientRects: () => ({ length: 1, item: () => ({ top: 0, bottom: 18, left: 60, right: 80, width: 20, height: 18 }) }) };
      });
      const engine = TranslateItViewportPrototype.createEngine({ root: document.querySelector('main') });
      await engine.start(); await engine.whenIdle();
      expect(target.textContent).toBe('⟦TI⟧Off-clip range');
      await engine.cleanup();
    }
  });

  it('fails closed for hidden zero-box text and unavailable Range geometry', async () => {
    document.body.innerHTML = '<main><span id="display" style="display:none">Display hidden</span><span id="visibility" style="visibility:hidden">Visibility hidden</span><span id="content" style="content-visibility:hidden">Content hidden</span><span id="content-auto" style="content-visibility:auto">Content auto</span><span id="paint-contain" style="contain:paint">Paint contained</span><span id="range">Missing range</span><span id="style-api">Missing style API</span><span id="clip-api">Missing clip API</span></main>';
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function() {
      if (this.id) return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
      return { top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 };
    });
    vi.spyOn(document, 'createRange').mockImplementation(() => ({ selectNodeContents() {}, getClientRects() { throw new Error('Range geometry unavailable'); } }));
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
      if (element.id === 'style-api') throw new Error('Computed style unavailable');
      if (element.id === 'clip-api') return { display: 'block' };
      return nativeGetComputedStyle(element);
    });
    const engine = TranslateItViewportPrototype.createEngine({ root: document.querySelector('main') });
    await engine.start(); await engine.whenIdle();
    for (const id of ['display', 'visibility', 'content', 'content-auto', 'paint-contain', 'range', 'style-api', 'clip-api']) expect(document.querySelector(`#${id}`).textContent).not.toContain('⟦TI⟧');
    await engine.cleanup();
  });

  it('processes mutations after idle and handles repeated scrolls and timer drainage', async () => {
    document.body.innerHTML = '<main><p data-y="5000">Offscreen</p></main>';
    const engine = TranslateItViewportPrototype.createEngine({ root: document.querySelector('main'), maxStepsPerSlice: 2 });
    await engine.start(); await engine.whenIdle();
    const p = document.querySelector('p'); p.dataset.y = '0'; window.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(p.textContent).toBe('⟦TI⟧Offscreen'));
    for (let i = 0; i < 3; i++) window.dispatchEvent(new Event('scroll'));
    await engine.whenIdle();
    const added = document.createElement('p'); added.dataset.y = '0'; added.textContent = 'Added'; p.after(added);
    const domRequestsBefore = engine.getStats().discoveryRequestsDomMutation, childrenBefore = engine.getStats().mutationChildListRecords;
    await vi.waitFor(() => expect(added.textContent).toBe('⟦TI⟧Added'));
    expect(engine.getStats().discoveryRequestsDomMutation).toBeGreaterThan(domRequestsBefore);
    expect(engine.getStats().mutationChildListRecords).toBeGreaterThan(childrenBefore);
    await engine.cleanup();
  });

  it('preserves external text and attribute edits and does not write replaced attributes', async () => {
    document.body.innerHTML = '<main><p data-y="0" title="Title">Text</p></main>';
    const p = document.querySelector('p');
    const engine = TranslateItViewportPrototype.createEngine({ root: document.querySelector('main'), mode: 'baseline' });
    await engine.start();
    p.firstChild.nodeValue = 'external text'; p.title = 'external title';
    await engine.cleanup();
    expect(p.textContent).toBe('external text'); expect(p.title).toBe('external title');
    expect(engine.getStats().preservedExternalNodes).toBe(2);
  });

  it('disconnects observers, fences pending work and releases discovery references on cleanup', async () => {
    document.body.innerHTML = '<main><p data-y="5000">Queued</p></main>';
    const original = window.MutationObserver;
    const instances = [];
    window.MutationObserver = class extends original { constructor(cb) { super(cb); instances.push(this); } };
    try {
      const engine = TranslateItViewportPrototype.createEngine({ root: document.querySelector('main'), maxStepsPerSlice: 1 });
      const start = engine.start(); await engine.cleanup(); await start;
      expect(instances.length).toBeGreaterThan(0);
      for (const observer of instances) expect(observer.takeRecords()).toHaveLength(0);
      expect(engine.getStats().ownedNodes).toBe(0);
    } finally { window.MutationObserver = original; }
  });

  it('produces the same eligible visible output in baseline and viewport modes', async () => {
    const markup = '<main><p data-y="0" title="Tip">Words</p><code data-y="0">Code</code><p data-y="5000">Offscreen</p></main>';
    const outputs = [];
    for (const mode of ['baseline', 'viewport']) {
      document.body.innerHTML = markup;
      const engine = TranslateItViewportPrototype.createEngine({ root: document.querySelector('main'), mode, maxStepsPerSlice: 3 });
      await engine.start(); await engine.whenIdle();
      const root = document.querySelector('main');
      outputs.push([root.querySelector('p').textContent, root.querySelector('p').title, root.querySelector('code').textContent, root.lastElementChild.textContent, engine.getStats().translatedNodes]);
      await engine.cleanup();
    }
    expect(outputs[0]).toEqual(outputs[1]);
  });

  it('rejects attribute identity changes and nodes moved outside its root before writes or restore', async () => {
    document.body.innerHTML = '<main><p data-y="0" title="Original">Text</p></main><aside></aside>';
    const root = document.querySelector('main'), p = root.querySelector('p');
    const engine = TranslateItViewportPrototype.createEngine({ root, maxStepsPerSlice: 1 });
    const start = engine.start();
    p.setAttribute('title', 'Replacement');
    document.querySelector('aside').append(p);
    await start; await engine.whenIdle();
    expect(p.title).toBe('Replacement'); expect(p.textContent).toBe('Text');
    await engine.cleanup();
    expect(p.title).toBe('Replacement'); expect(p.textContent).toBe('Text');
  });

  it('restores owned detached subtrees and preserves detached external edits in both modes', async () => {
    for (const mode of ['baseline', 'viewport']) {
      document.body.innerHTML = '<main><p data-y="0" title="Original title">Original text</p></main>';
      const root = document.querySelector('main'), detached = root.firstElementChild;
      const first = TranslateItViewportPrototype.createEngine({ root, mode, maxStepsPerSlice: 1 });
      await first.start(); await first.whenIdle();
      expect(detached.textContent).toBe('⟦TI⟧Original text');
      expect(detached.title).toBe('⟦TI⟧Original title');
      detached.remove();
      const restore = first.restore();
      expect(first.restore()).toBe(restore);
      expect(first.cleanup()).toBe(restore);
      await restore;
      expect(detached.textContent).toBe('Original text');
      expect(detached.title).toBe('Original title');
      root.append(detached);
      expect(detached.textContent).toBe('Original text');
      expect(detached.title).toBe('Original title');

      const reinserted = document.createElement('p'); reinserted.dataset.y = '0'; reinserted.title = 'Before'; reinserted.textContent = 'Before text'; root.append(reinserted);
      const second = TranslateItViewportPrototype.createEngine({ root, mode, maxStepsPerSlice: 1 });
      await second.start(); await second.whenIdle();
      reinserted.remove(); root.append(reinserted);
      await second.restore();
      expect(reinserted.textContent).toBe('Before text');
      expect(reinserted.title).toBe('Before');

      const edited = document.createElement('p'); edited.dataset.y = '0'; edited.title = 'Owned title'; edited.textContent = 'Owned text'; root.append(edited);
      const third = TranslateItViewportPrototype.createEngine({ root, mode, maxStepsPerSlice: 1 });
      await third.start(); await third.whenIdle();
      edited.remove(); edited.firstChild.nodeValue = 'External text'; edited.removeAttribute('title'); edited.setAttribute('title', 'Replacement title');
      await third.restore();
      expect(edited.textContent).toBe('External text');
      expect(edited.title).toBe('Replacement title');
      expect(third.getStats().preservedExternalNodes).toBe(1);
      root.append(edited);
      expect(edited.textContent).toBe('External text');
      expect(edited.title).toBe('Replacement title');
    }
  });

  it('restores unchanged owned text moved into a nested shadow root in both modes', async () => {
    for (const mode of ['baseline', 'viewport']) {
      document.body.innerHTML = '<main><p id="source">Moved source</p><x-shell></x-shell><p id="reordered">Same-owner reorder</p><p>Sibling</p></main>';
      const root = document.querySelector('main'), source = root.querySelector('#source'), movedText = source.firstChild;
      const outerShadow = root.querySelector('x-shell').attachShadow({ mode: 'open' });
      const inner = document.createElement('x-inner'); outerShadow.append(inner);
      const destinationShadow = inner.attachShadow({ mode: 'open' }), destination = document.createElement('span');
      destinationShadow.append(destination);
      const reordered = root.querySelector('#reordered');
      const engine = TranslateItViewportPrototype.createEngine({ root, mode });
      await engine.start(); await engine.whenIdle();
      expect(movedText.data).toBe('⟦TI⟧Moved source');
      root.append(reordered);
      destination.append(movedText); source.remove();
      await engine.restore();
      expect(movedText.data).toBe('Moved source');
      expect(reordered.textContent).toBe('Same-owner reorder');
      expect(engine.getStats().restoredNodes).toBe(3);
      expect(engine.getStats().preservedExternalNodes).toBe(0);
    }
  });

  it('restores owned text moved within a temporarily detached root in both modes', async () => {
    for (const mode of ['baseline', 'viewport']) {
      document.body.innerHTML = '<main><p id="source" title="Source title">Moved source</p><p id="destination" title="Destination title"></p></main>';
      const root = document.querySelector('main'), source = root.querySelector('#source'), destination = root.querySelector('#destination'), movedText = source.firstChild;
      const engine = TranslateItViewportPrototype.createEngine({ root, mode });
      await engine.start(); await engine.whenIdle();
      destination.append(movedText); source.remove(); root.remove();
      await engine.restore();
      expect(movedText.data).toBe('Moved source');
      expect(source.title).toBe('Source title');
      expect(destination.title).toBe('Destination title');
      expect(engine.getStats().restoredNodes).toBe(3);
      expect(engine.getStats().preservedExternalNodes).toBe(0);
    }
  });

  it('does not restore an unchanged Attr moved to a different owner inside the root', async () => {
    for (const mode of ['baseline', 'viewport']) {
      document.body.innerHTML = '<main><p id="source" title="Original"></p><p id="destination"></p></main>';
      const root = document.querySelector('main'), source = root.querySelector('#source'), destination = root.querySelector('#destination');
      const attr = source.getAttributeNode('title');
      const engine = TranslateItViewportPrototype.createEngine({ root, mode });
      await engine.start(); await engine.whenIdle();
      expect(attr.value).toBe('⟦TI⟧Original');
      source.removeAttributeNode(attr); destination.setAttributeNode(attr);
      await engine.restore();
      expect(destination.getAttributeNode('title')).toBe(attr);
      expect(attr.value).toBe('⟦TI⟧Original');
      expect(engine.getStats().restoredNodes).toBe(0);
    }
  });

  it('does not restore nodes still connected outside the original root', async () => {
    for (const mode of ['baseline', 'viewport']) {
      document.body.innerHTML = '<main><p data-y="0" title="Original title">Original text</p></main><aside></aside>';
      const root = document.querySelector('main'), moved = root.firstElementChild;
      const engine = TranslateItViewportPrototype.createEngine({ root, mode });
      await engine.start(); await engine.whenIdle();
      document.querySelector('aside').append(moved);
      await engine.restore();
      expect(moved.textContent).toBe('⟦TI⟧Original text');
      expect(moved.title).toBe('⟦TI⟧Original title');
    }
  });

  it('restores individually detached Text nodes on reinsert in both modes', async () => {
    for (const mode of ['baseline', 'viewport']) {
      document.body.innerHTML = '<main><p data-y="0" title="Original title">Original text</p></main>';
      const root = document.querySelector('main'), paragraph = root.firstElementChild, text = paragraph.firstChild;
      const engine = TranslateItViewportPrototype.createEngine({ root, mode });
      await engine.start(); await engine.whenIdle();
      paragraph.removeChild(text);
      await engine.restore();
      expect(text.data).toBe('Original text');
      expect(paragraph.title).toBe('Original title');
      paragraph.append(text);
      expect(paragraph.textContent).toBe('Original text');
    }
  });

  it('preserves edits to detached Text nodes and does not restore them after moving outside the root', async () => {
    for (const mode of ['baseline', 'viewport']) {
      document.body.innerHTML = '<main><p data-y="0" title="Original title">Original text</p></main><aside></aside>';
      const root = document.querySelector('main'), paragraph = root.firstElementChild, text = paragraph.firstChild;
      const engine = TranslateItViewportPrototype.createEngine({ root, mode });
      await engine.start(); await engine.whenIdle();
      paragraph.removeChild(text);
      text.data = 'External edit';
      await engine.restore();
      expect(text.data).toBe('External edit');
      expect(paragraph.title).toBe('Original title');
      expect(engine.getStats().preservedExternalNodes).toBe(1);
      paragraph.append(text);
      expect(paragraph.textContent).toBe('External edit');

      const moved = paragraph.firstChild;
      const second = TranslateItViewportPrototype.createEngine({ root, mode });
      await second.start(); await second.whenIdle();
      paragraph.removeChild(moved);
      document.querySelector('aside').append(moved);
      await second.restore();
      expect(moved.data).toBe('⟦TI⟧External edit');
      expect(paragraph.title).toBe('Original title');
    }
  });

  it('counts prototype restore targets separately from baseline DOM traversal nodes', async () => {
    document.body.innerHTML = '<main><p data-y="0" title="Tip">Visible</p><p data-y="5000">Offscreen</p></main>';
    const root = document.querySelector('main');
    const prototype = TranslateItViewportPrototype.createEngine({ root, mode: 'viewport' });
    await prototype.start();
    const ownedTargets = prototype.getStats().ownedNodes;
    expect(ownedTargets).toBeGreaterThan(0);
    await prototype.cleanup();
    expect(prototype.getStats().restoreVisitedNodes).toBe(ownedTargets);

    document.body.innerHTML = '<main><p data-y="0" title="Tip">Visible</p><p data-y="5000">Offscreen</p></main>';
    const baseline = TranslateItViewportPrototype.createEngine({ root: document.querySelector('main'), mode: 'baseline' });
    await baseline.start();
    const baselineTargets = baseline.getStats().ownedNodes;
    await baseline.cleanup();
    expect(baseline.getStats().restoreVisitedNodes).toBeGreaterThan(baselineTargets);
  });

  it('coalesces scroll bursts and discovers the latest viewport position', async () => {
    document.body.innerHTML = '<main><p data-y="5000">Initially far</p><p data-y="9000">Later far</p></main>';
    const root = document.querySelector('main');
    const engine = TranslateItViewportPrototype.createEngine({ root, maxStepsPerSlice: 1 });
    await engine.start(); await engine.whenIdle();
    for (let i = 0; i < 500; i++) window.dispatchEvent(new Event('scroll'));
    expect(engine.getStats().pendingJobCount).toBeLessThanOrEqual(1);
    root.lastElementChild.dataset.y = '0';
    window.dispatchEvent(new Event('scroll'));
    await engine.whenIdle();
    expect(root.lastElementChild.textContent).toBe('⟦TI⟧Later far');
    await engine.cleanup();
  });

  it('does not retain offscreen candidates and drains a detached-branch mutation', async () => {
    document.body.innerHTML = '<main><p data-y="5000" title="Old">Pending</p></main>';
    const root = document.querySelector('main'), p = root.firstElementChild;
    const engine = TranslateItViewportPrototype.createEngine({ root, maxStepsPerSlice: 1 });
    await engine.start(); await engine.whenIdle();
    expect(engine.getStats().candidateCount).toBe(0);
    expect(engine.getStats().prunedBranches).toBeGreaterThan(0);
    p.remove();
    await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    expect(engine.getStats()).toMatchObject({ candidateCount: 0, pendingJobCount: 0 });
    await engine.cleanup();
  });

  it('re-observes a reinserted shadow host and rediscovers its pending shadow targets', async () => {
    document.body.innerHTML = '<main><x-card></x-card></main>';
    const root = document.querySelector('main'), host = root.firstElementChild, shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<p data-y="5000" title="Shadow title">Shadow text</p>';
    const engine = TranslateItViewportPrototype.createEngine({ root, maxStepsPerSlice: 1 });
    await engine.start(); await engine.whenIdle();
    expect(engine.getStats().observerCount).toBe(2);
    host.remove();
    await vi.waitFor(() => expect(engine.getStats().observerCount).toBe(1));
    root.append(host);
    await engine.whenIdle();
    shadow.querySelector('p').dataset.y = '0';
    window.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(shadow.querySelector('p').textContent).toBe('⟦TI⟧Shadow text'));
    const added = document.createElement('p'); added.dataset.y = '0'; added.title = 'New shadow title'; added.textContent = 'New shadow text'; shadow.append(added);
    await vi.waitFor(() => expect(added.title).toBe('⟦TI⟧New shadow title'));
    await vi.waitFor(() => expect(added.textContent).toBe('⟦TI⟧New shadow text'));
    await engine.cleanup();
  });

  it('bounds sustained append-remove churn by current pending content', async () => {
    document.body.innerHTML = '<main><p data-y="5000" title="Live title">Live pending</p></main>';
    const root = document.querySelector('main'), engine = TranslateItViewportPrototype.createEngine({ root, maxStepsPerSlice: 1 });
    await engine.start(); await engine.whenIdle();
    expect(engine.getStats().candidateCount).toBe(0);
    const live = root.firstElementChild;
    for (let i = 0; i < 100; i++) { live.firstChild.nodeValue = `Live pending ${i}`; live.title = `Live title ${i}`; }
    for (let i = 0; i < 100; i++) {
      const p = document.createElement('p'); p.dataset.y = '5000'; p.title = `Transient ${i}`; p.textContent = `Transient text ${i}`;
      const host = document.createElement('x-card'), shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<span title="Shadow ${i}">Shadow text ${i}</span>`;
      root.append(p, host); p.firstChild.nodeValue += '!'; p.title += '!'; root.removeChild(p); root.removeChild(host);
      for (let j = 0; j < 5; j++) window.dispatchEvent(new Event('scroll'));
    }
    await Promise.resolve();
    expect(engine.getStats().pendingJobCount).toBeLessThanOrEqual(1);
    await engine.whenIdle();
    expect(engine.getStats().candidateCount).toBe(0);
    expect(engine.getStats().mutationUnownedCharacterDataRecords).toBeGreaterThan(0);
    expect(engine.getStats().mutationChildListRecords).toBeGreaterThan(0);
    expect(engine.getStats().mutationRelevantAttributeRecords).toBeGreaterThan(0);
    const final = document.createElement('p'); final.dataset.y = '5000'; final.title = 'Final'; final.textContent = 'Final text'; root.append(final);
    const passesBeforeAppend = engine.getStats().discoveryPasses;
    await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(passesBeforeAppend));
    await engine.whenIdle();
    final.remove();
    live.remove();
    await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
    expect(engine.getStats().candidateCount).toBe(0);
    await engine.cleanup();
  });

  it('drains multi-turn infinite-scroll additions and ignores owned mutation records', async () => {
    document.body.innerHTML = '<main><p data-y="5000" title="Live title">Live text</p></main>';
    const root = document.querySelector('main'), live = root.firstElementChild;
    const engine = TranslateItViewportPrototype.createEngine({ root, maxStepsPerSlice: 1, budgetMs: 20 });
    await engine.start(); await engine.whenIdle();

    for (let i = 0; i < 12; i++) {
      const p = document.createElement('p'); p.dataset.y = '5000'; p.title = `Cycle title ${i}`; p.textContent = `Cycle text ${i}`;
      const host = document.createElement('x-card'), shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<span data-y="5000" title="Shadow title ${i}">Shadow text ${i}</span>`;
      root.append(p, host);
      const beforePasses = engine.getStats().discoveryPasses;
      await vi.waitFor(() => expect(engine.getStats().discoveryPasses).toBeGreaterThan(beforePasses));
      await engine.whenIdle();
      expect(engine.getStats().candidateCount).toBe(0);
      expect(engine.getStats().pendingJobCount).toBe(0);
      p.firstChild.nodeValue = `Changed text ${i}`; p.title = `Changed title ${i}`;
      await new Promise(resolve => setTimeout(resolve, 0));
      await engine.whenIdle();
      for (let j = 0; j < 8; j++) window.dispatchEvent(new Event('scroll'));
      root.removeChild(p); root.removeChild(host);
      await new Promise(resolve => setTimeout(resolve, 0)); await engine.whenIdle();
      expect(engine.getStats()).toMatchObject({ candidateCount: 0, pendingJobCount: 0, observerCount: 1 });
    }

    live.dataset.y = '0'; window.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => {
      expect(live.textContent).toBe('⟦TI⟧Live text');
      expect(live.title).toBe('⟦TI⟧Live title');
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    await engine.whenIdle();
    expect(engine.getStats()).toMatchObject({ candidateCount: 0, pendingJobCount: 0, observerCount: 1 });
    const requestsBeforeExternalEdit = engine.getStats().discoveryRequests;
    const unownedTextBeforeExternalEdit = engine.getStats().mutationUnownedCharacterDataRecords;
    const relevantAttrsBeforeExternalEdit = engine.getStats().mutationRelevantAttributeRecords;
    live.firstChild.nodeValue = 'External text'; live.title = 'External title';
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(engine.getStats()).toMatchObject({ candidateCount: 0, pendingJobCount: 0 });
    expect(engine.getStats().discoveryRequests).toBe(requestsBeforeExternalEdit);
    expect(engine.getStats().mutationUnownedCharacterDataRecords).toBe(unownedTextBeforeExternalEdit);
    expect(engine.getStats().mutationRelevantAttributeRecords).toBe(relevantAttrsBeforeExternalEdit);
    await engine.cleanup();
    expect(live.textContent).toBe('External text');
    expect(live.title).toBe('External title');
    expect(engine.getStats().preservedExternalNodes).toBe(2);
  });

  it('counts full baseline discovery, keeps exclusions through contenteditable=false, and rechecks dynamic candidates', async () => {
    document.body.innerHTML = '<main><section class="blocked"><p contenteditable="false" data-y="0" title="No">No</p></section><p data-y="5000">Offscreen</p></main>';
    const root = document.querySelector('main'), baseline = TranslateItViewportPrototype.createEngine({ root, mode: 'baseline', excludedSelectors: ['.blocked'] });
    await baseline.start();
    expect(baseline.getStats().visitedNodes).toBeGreaterThan(5);
    expect(document.querySelector('.blocked p').textContent).toBe('No');
    const offscreen = root.lastElementChild; offscreen.setAttribute('title', 'New title');
    offscreen.firstChild.nodeValue = 'New text';
    await new Promise(resolve => setTimeout(resolve, 10));
    offscreen.dataset.y = '0'; window.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(offscreen.textContent).toBe('⟦TI⟧New text'));
    expect(offscreen.title).toBe('⟦TI⟧New title');
    await baseline.cleanup();
    expect(baseline.getStats().restoreVisitedNodes).toBeGreaterThan(baseline.getStats().ownedNodes);
  });

  it('continues across siblings removed during a scan and discovers newly inserted siblings', async () => {
    document.body.innerHTML = '<main>' + '<p data-y="0">One</p><p data-y="0">Two</p><p data-y="0">Three</p></main>';
    const root = document.querySelector('main'), first = root.firstElementChild;
    document.elementFromPoint = () => first;
    const engine = TranslateItViewportPrototype.createEngine({ root, maxStepsPerSlice: 1 });
    const start = engine.start();
    await vi.waitFor(() => expect(first.textContent).toBe('⟦TI⟧One'));
    first.remove();
    const inserted = document.createElement('p'); inserted.dataset.y = '0'; inserted.textContent = 'Four'; root.append(inserted);
    await start; await engine.whenIdle();
    expect([...root.querySelectorAll('p')].map(e => e.textContent)).toEqual(['⟦TI⟧Two', '⟦TI⟧Three', '⟦TI⟧Four']);
    await engine.cleanup();
  });
});
