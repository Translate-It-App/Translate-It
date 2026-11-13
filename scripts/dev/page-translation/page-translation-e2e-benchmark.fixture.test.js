import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createNodesFilter } from 'domtranslator/utils/nodes';
import { PAGE_TRANSLATION_SELECTORS } from '../../../src/features/page-translation/PageTranslationConstants.js';
import {
  createFixture, createPageTranslationFixture, createPageTranslationReplacementFixture,
  startFixture, targetTexts,
} from './e2e-benchmark/fixture.mjs';

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ server }) => new Promise(resolve => server.close(resolve))));
});

describe('page translation replacement fixture', () => {
  it('exposes fixed A/B manifests and exactly twelve correctly typed targets', () => {
    const fixture = createPageTranslationReplacementFixture();
    expect(fixture.targets.map(({ id }) => id)).toEqual(Array.from({ length: 12 }, (_, i) => `target-${i}`));
    expect(fixture.targets.map(({ kind }) => kind)).toEqual(Array.from({ length: 12 }, (_, i) => i < 6 ? 'text' : 'title'));
    expect(fixture.sourceManifests.A).toEqual(targetTexts);
    // Every target gets its own B source so any pending subset production
    // leaves unaccepted can be re-translated without reusing an A source.
    expect(fixture.sourceManifests.B).not.toEqual(fixture.sourceManifests.A);
    expect(new Set([...fixture.sourceManifests.A, ...fixture.sourceManifests.B]).size).toBe(24);
  });

  it('admits exactly the twelve manifested primitives through the production node filter', () => {
    const fixture = createPageTranslationReplacementFixture();
    const dom = new JSDOM(fixture.html, { url: 'http://127.0.0.1:4567/' });
    const { document } = dom.window;
    // Same always-present excluded list the production Bridge composes.
    const excludedSelectors = [
      `#${PAGE_TRANSLATION_SELECTORS.UI_HOST_MAIN}`,
      `#${PAGE_TRANSLATION_SELECTORS.UI_HOST_IFRAME}`,
      `#${PAGE_TRANSLATION_SELECTORS.TOOLTIP_ID}`,
      `.${PAGE_TRANSLATION_SELECTORS.INTERNAL_IGNORE_CLASS}`,
      `.${PAGE_TRANSLATION_SELECTORS.STANDARD_NO_TRANSLATE_CLASS}`,
      `[translate='${PAGE_TRANSLATION_SELECTORS.TRANSLATE_NO_VALUE}']`,
    ];
    const filter = createNodesFilter({ ignoredSelectors: excludedSelectors,
      attributesList: ['title', 'alt', 'placeholder', 'label', 'value'] });
    const ownerOf = node => node.nodeType === 2 ? node.ownerElement : node.parentElement;
    const targetOf = node => ownerOf(node)?.closest?.('[data-bench-id]')?.dataset.benchId ?? null;
    const primitives = [];
    // Script/style text is not a translation candidate; exclude those elements as
    // production translation does. The must-replace `<noscript>` has no script text.
    const isTextCandidate = element => element.tagName !== 'SCRIPT' && element.tagName !== 'STYLE';
    for (const element of Array.from(document.body.querySelectorAll('*')).filter(isTextCandidate)) {
      for (const child of element.childNodes) if (child.nodeType === 3 && child.textContent) primitives.push(child);
      Array.from({ length: element.attributes.length }, (_, index) => element.attributes[index]).forEach(attribute => primitives.push(attribute));
    }
    const admitted = primitives.filter(filter);
    expect(admitted).toHaveLength(12);
    const admittedTextOwners = admitted.filter(node => node.nodeType === 3).map(targetOf);
    const byIndex = (a, b) => Number(a.slice(7)) - Number(b.slice(7));
    expect([...admittedTextOwners].sort(byIndex)).toEqual(Array.from({ length: 6 }, (_, index) => `target-${index}`));
    const admittedTitleTargets = admitted.filter(node => node.nodeType === 2 && node.name === 'title').map(targetOf);
    expect([...admittedTitleTargets].sort(byIndex)).toEqual(Array.from({ length: 6 }, (_, index) => `target-${index + 6}`));
    expect(admitted.filter(node => node.nodeType === 2)).toHaveLength(6);
    const controlText = Array.from(document.getElementById(fixture.replacementControlId).childNodes).find(node => node.nodeType === 3);
    expect(admitted.includes(controlText)).toBe(false);
    dom.window.close();
  });

  it('waits for the one-time invalidation event before changing pending titles and pushes state once', () => {
    const fixture = createPageTranslationReplacementFixture();
    expect(fixture.replacementControlId).toBe('page-translation-replacement-control');
    const dom = new JSDOM(fixture.html, { runScripts: 'dangerously', url: 'http://127.0.0.1:4567/' });
    const { document, history } = dom.window;
    const acceptedA = [...document.querySelectorAll('[data-bench-kind="text"]')].map(node => node.textContent);
    const pendingA = [...document.querySelectorAll('[data-bench-kind="title"]')].map(node => node.getAttribute('title'));
    const pushState = vi.spyOn(history, 'pushState');

    document.getElementById(fixture.replacementControlId).click();
    expect([...document.querySelectorAll('[data-bench-kind="title"]')].map(node => node.getAttribute('title'))).toEqual(pendingA);
    document.getElementById(fixture.replacementControlId).click();

    expect(pushState).toHaveBeenCalledOnce();
    expect(pushState).toHaveBeenCalledWith({}, '', '/replacement');
    expect(dom.window.location.pathname).toBe('/replacement');
    expect([...document.querySelectorAll('[data-bench-kind="text"]')].map(node => node.textContent)).toEqual(acceptedA);
    expect([...document.querySelectorAll('[data-bench-kind="title"]')].map(node => node.getAttribute('title'))).toEqual(pendingA);

    // The runner publishes exactly the targets production left pending.
    document.documentElement.setAttribute('data-translate-it-replacement-pending', 'target-8,target-9');
    dom.window.dispatchEvent(new dom.window.CustomEvent('translate-it:page-translation-replacement-invalidated'));

    const titleOf = id => document.querySelector(`[data-bench-id="${id}"]`).getAttribute('title');
    expect(titleOf('target-7')).toBe(fixture.sourceManifests.A[7]);
    expect(titleOf('target-8')).toBe(fixture.sourceManifests.B[8]);
    expect(titleOf('target-9')).toBe(fixture.sourceManifests.B[9]);
    expect(titleOf('target-10')).toBe(fixture.sourceManifests.A[10]);
    expect([...document.querySelectorAll('[data-bench-kind="text"]')].map(node => node.textContent)).toEqual(acceptedA);
    dom.window.close();
  });

  it('does not miss invalidation delivered synchronously by pushState instrumentation', () => {
    const fixture = createPageTranslationReplacementFixture();
    const dom = new JSDOM(fixture.html, { runScripts: 'dangerously', url: 'http://127.0.0.1:4567/' });
    const { document, history } = dom.window;
    document.documentElement.setAttribute('data-translate-it-replacement-pending', 'target-6');
    const originalPushState = history.pushState.bind(history);
    const pushState = vi.spyOn(history, 'pushState').mockImplementation((...args) => {
      const result = originalPushState(...args);
      dom.window.dispatchEvent(new dom.window.CustomEvent('translate-it:page-translation-replacement-invalidated'));
      return result;
    });

    document.getElementById(fixture.replacementControlId).click();

    expect(pushState).toHaveBeenCalledOnce();
    const titleOf = id => document.querySelector(`[data-bench-id="${id}"]`).getAttribute('title');
    expect(titleOf('target-6')).toBe(fixture.sourceManifests.B[6]);
    expect(titleOf('target-7')).toBe(fixture.sourceManifests.A[7]);
    dom.window.close();
  });

  it('serves both fixed fixture routes and delegates configured collector paths without listener races', async () => {
    const fixture = createPageTranslationReplacementFixture();
    const handled = [];
    const collector = {
      routes: { A: 'http://127.0.0.1:1/', B: 'http://127.0.0.1:1/replacement' },
      reportUrl: 'http://127.0.0.1:1/__replacement/report',
      controlUrl: type => `http://127.0.0.1:1/__replacement/control/${type}`,
      async handle(request, response) {
        handled.push(new URL(request.url, 'http://127.0.0.1').pathname);
        response.writeHead(204).end();
        return true;
      },
    };
    const started = await startFixture(fixture, { replacementCollector: collector });
    servers.push(started);
    for (const route of ['/', '/replacement']) {
      const response = await fetch(new URL(route, started.url));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(fixture.html);
    }
    for (const route of ['/__replacement/report', '/__replacement/control/navigate-to-b', '/__replacement/control/capture-final']) {
      const response = await fetch(new URL(route, started.url));
      expect(response.status).toBe(204);
    }
    expect(handled).toEqual(['/__replacement/report', '/__replacement/control/navigate-to-b', '/__replacement/control/capture-final']);
  });

  it('preserves the existing Phase1/2A fixture output and default routes', async () => {
    const pageFixture = createPageTranslationFixture();
    expect(pageFixture).toEqual({
      scenario: 'page-translation', targetCount: 12,
      targets: targetTexts.map((source, index) => ({ id: `target-${index}`, source, kind: index < 6 ? 'text' : 'title', visible: true })),
      targetTexts, visibleIds: targetTexts.map((_, index) => `target-${index}`),
      html: pageFixture.html, viewport: { width: 1280, height: 900 }, scroll: { x: 0, y: 0 }, responseDelayMs: 0,
    });
    expect(createFixture()).toMatchObject({ scenario: 'small', targetCount: 12, targetTexts });
    const started = await startFixture(pageFixture);
    servers.push(started);
    expect((await fetch(started.url)).status).toBe(200);
    expect((await fetch(new URL('/replacement', started.url))).status).toBe(404);
  });
});
