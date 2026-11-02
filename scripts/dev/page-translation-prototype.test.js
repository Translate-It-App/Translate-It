import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  delete globalThis.TranslateItViewportPrototype;
  window.eval(readFileSync(resolve('scripts/dev/page-translation-prototype/engine.js'), 'utf8'));
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

  it('scans cooperatively, handles mutations and stops without late writes', async () => {
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

  it('observes scrolling and open shadow roots; leaves detached and external edits alone', async () => {
    document.body.innerHTML = '<main><p data-y="5000">Later</p><x-card></x-card></main>';
    const shadow = document.querySelector('x-card').attachShadow({ mode: 'open' });
    shadow.append(document.createTextNode('Shadow text'));
    const engine = TranslateItViewportPrototype.createEngine({ root: document.querySelector('main'), mode: 'viewport' });
    await engine.start();
    const p = document.querySelector('p'); p.dataset.y = '0';
    window.dispatchEvent(new Event('scroll'));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(p.textContent).toBe('⟦TI⟧Later');
    expect(shadow.textContent).toBe('⟦TI⟧Shadow text');
    p.firstChild.nodeValue = 'host edit';
    p.remove();
    await engine.cleanup();
    expect(p.textContent).toBe('host edit');
    expect(engine.getStats().restoredNodes).toBe(1);
  });

  it('seeds the visible deep target before cooperative background traversal finishes', async () => {
    document.body.innerHTML = '<main>' + '<p data-y="5000">Far</p>'.repeat(50) + '<p data-y="0">Deep visible</p></main>';
    const visible = document.querySelector('main').lastElementChild;
    document.elementFromPoint = () => visible;
    const engine = TranslateItViewportPrototype.createEngine({ root: document.querySelector('main'), maxStepsPerSlice: 1 });
    const started = engine.start();
    await vi.waitFor(() => expect(visible.textContent).toBe('⟦TI⟧Deep visible'));
    expect(engine.getStats().visitedNodes).toBeLessThan(100);
    await engine.cleanup(); await started;
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
    await vi.waitFor(() => expect(added.textContent).toBe('⟦TI⟧Added'));
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

  it('coalesces scroll bursts and rescans pending candidates at the latest position', async () => {
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

  it('prunes removed and replaced pending targets without a scroll event', async () => {
    document.body.innerHTML = '<main><p data-y="5000" title="Old">Pending</p></main>';
    const root = document.querySelector('main'), p = root.firstElementChild;
    const engine = TranslateItViewportPrototype.createEngine({ root, maxStepsPerSlice: 1 });
    await engine.start(); await engine.whenIdle();
    expect(engine.getStats().candidateCount).toBeGreaterThan(0);
    p.remove();
    await vi.waitFor(() => expect(engine.getStats().candidateCount).toBe(0));
    await engine.whenIdle();
    expect(engine.getStats().candidateCount).toBe(0);
    expect(engine.getStats().pendingJobCount).toBe(0);
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
    expect(added.textContent).toBe('⟦TI⟧New shadow text');
    await engine.cleanup();
  });

  it('bounds sustained append-remove churn by current pending content', async () => {
    document.body.innerHTML = '<main><p data-y="5000" title="Live title">Live pending</p></main>';
    const root = document.querySelector('main'), engine = TranslateItViewportPrototype.createEngine({ root, maxStepsPerSlice: 1 });
    await engine.start(); await engine.whenIdle();
    expect(engine.getStats().candidateCount).toBe(2);
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
    expect(engine.getStats().pendingJobCount).toBeLessThan(10);
    await engine.whenIdle();
    expect(engine.getStats().candidateCount).toBe(2);
    const final = document.createElement('p'); final.dataset.y = '5000'; final.title = 'Final'; final.textContent = 'Final text'; root.append(final);
    await vi.waitFor(() => expect(engine.getStats().candidateCount).toBe(4));
    await engine.whenIdle();
    final.remove();
    live.remove();
    await vi.waitFor(() => expect(engine.getStats().candidateCount).toBe(0));
    await engine.cleanup();
  });

  it('drains multi-turn infinite-scroll additions and ignores owned mutation records', async () => {
    document.body.innerHTML = '<main><p data-y="5000" title="Live title">Live text</p></main>';
    const root = document.querySelector('main'), live = root.firstElementChild;
    const engine = TranslateItViewportPrototype.createEngine({ root, maxStepsPerSlice: 1, budgetMs: 20 });
    await engine.start(); await engine.whenIdle();
    const liveCount = engine.getStats().candidateCount;

    for (let i = 0; i < 12; i++) {
      const p = document.createElement('p'); p.dataset.y = '5000'; p.title = `Cycle title ${i}`; p.textContent = `Cycle text ${i}`;
      const host = document.createElement('x-card'), shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<span data-y="5000" title="Shadow title ${i}">Shadow text ${i}</span>`;
      root.append(p, host);
      await vi.waitFor(() => expect(engine.getStats().candidateCount).toBeGreaterThan(liveCount));
      await engine.whenIdle();
      expect(engine.getStats().candidateCount).toBe(liveCount + 4);
      p.firstChild.nodeValue = `Changed text ${i}`; p.title = `Changed title ${i}`;
      await new Promise(resolve => setTimeout(resolve, 0));
      await engine.whenIdle();
      for (let j = 0; j < 8; j++) window.dispatchEvent(new Event('scroll'));
      root.removeChild(p); root.removeChild(host);
      await vi.waitFor(() => expect(engine.getStats()).toMatchObject({ candidateCount: liveCount, pendingJobCount: 0, observerCount: 1 }));
    }

    live.dataset.y = '0'; window.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => {
      expect(live.textContent).toBe('⟦TI⟧Live text');
      expect(live.title).toBe('⟦TI⟧Live title');
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(engine.getStats()).toMatchObject({ candidateCount: 0, pendingJobCount: 0, observerCount: 1 });
    live.firstChild.nodeValue = 'External text'; live.title = 'External title';
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(engine.getStats()).toMatchObject({ candidateCount: 0, pendingJobCount: 0 });
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
