(() => {
  'use strict';

  async function run() {
    const fixture = document.querySelector('main#benchmark-root[data-benchmark-fixture="page-translation-prototype"]');
    if (!fixture) throw new Error('Coverage checks require the marked local fixture root.');
    const delay = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
    const makeText = (parent, value) => { const node = document.createTextNode(value); parent.append(node); return node; };
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const rangeSummary = node => {
      const range = document.createRange(); range.selectNodeContents(node);
      const rects = range.getClientRects(); let positive = 0, onScreen = 0, maxWidth = 0, maxHeight = 0;
      for (let i = 0; i < rects.length; i++) {
        const r = rects.item(i) ?? rects[i];
        if (r.width > 0 && r.height > 0) { positive++; maxWidth = Math.max(maxWidth, r.width); maxHeight = Math.max(maxHeight, r.height); if (r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight) onScreen++; }
      }
      return { fragments: rects.length, positiveFragments: positive, onScreenFragments: onScreen, maxWidth, maxHeight };
    };
    const assertVector = (name, field, actual, expected) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Coverage check ${name}: ${field} mismatch.`);
    };
    const assertGeometry = (name, actual, expected) => {
      if (actual.length !== expected.length || actual.some((row, i) => row.ownerZeroBox !== expected[i][0] || (row.range.positiveFragments > 0) !== expected[i][1] || (row.range.onScreenFragments > 0) !== expected[i][2])) throw new Error(`Coverage check ${name}: geometry mismatch.`);
    };
    const cases = [];
    const exercise = async (name, build, { rootForEngine = () => fixture, afterStart, expectedInitial, expectedAfter, expectedGeometry } = {}) => {
      window.scrollTo(0, 0); fixture.replaceChildren();
      const probes = build();
      await delay();
      const geometry = probes.map(({ node, owner }) => ({ ownerZeroBox: rect(owner).width === 0 && rect(owner).height === 0, range: rangeSummary(node) }));
      const engineRoot = rootForEngine();
      const engine = TranslateItViewportPrototype.createEngine({ root: engineRoot, mode: 'viewport' });
      let initial, afterTrigger, activeStats, cleanupStats;
      try {
        await engine.start(); await engine.whenIdle();
        initial = probes.map(({ node }) => node.data.startsWith('⟦TI⟧'));
        assertVector(name, 'initial translations', initial, expectedInitial);
        if (afterStart) { await afterStart(); await delay(50); await engine.whenIdle(); }
        afterTrigger = probes.map(({ node }) => node.data.startsWith('⟦TI⟧'));
        assertVector(name, 'trigger translations', afterTrigger, expectedAfter);
        assertGeometry(name, geometry, expectedGeometry);
        activeStats = engine.getStats();
      } finally {
        await engine.cleanup();
        cleanupStats = engine.getStats();
      }
      const restored = probes.map(({ node, original }) => node.data === original);
      window.dispatchEvent(new Event('scroll')); await delay(30);
      const lateWritesAbsent = probes.every(({ node, original }) => node.data === original);
      assertVector(name, 'restoration', restored, probes.map(() => true));
      if (!lateWritesAbsent || cleanupStats.observerCount !== 0 || cleanupStats.pendingJobCount !== 0) throw new Error(`Coverage check ${name}: cleanup mismatch.`);
      cases.push({
        name, geometry, translatedInitially: initial, translatedAfterTrigger: afterTrigger, restored, lateWritesAbsent,
        stats: {
          visitedNodes: activeStats.visitedNodes, geometryChecks: activeStats.geometryChecks, prunedBranches: activeStats.prunedBranches,
          translatedNodes: activeStats.translatedNodes, observersAfterCleanup: cleanupStats.observerCount,
          pendingAfterCleanup: cleanupStats.pendingJobCount,
        },
      });
    };

    try {
    await exercise('display-contents-direct-text', () => {
      const owner = document.createElement('div'); owner.style.display = 'contents';
      fixture.append(owner); const node = makeText(owner, 'display contents'); return [{ node, owner, original: node.data }];
    }, { expectedInitial: [true], expectedAfter: [true], expectedGeometry: [[true, true, true]] });
    await exercise('zero-size-shadow-host-direct-text-and-wrapped-control', () => {
      const host = document.createElement('x-coverage-zero');
      host.style.cssText = 'position:absolute;left:20px;top:20px;width:0;height:0;overflow:visible;font:18px Arial;white-space:nowrap'; fixture.append(host);
      const shadow = host.attachShadow({ mode: 'open' }), direct = makeText(shadow, 'direct shadow text');
      const span = document.createElement('span'); span.style.cssText = 'display:block;margin-top:20px';
      const wrapped = makeText(span, 'wrapped control'); shadow.append(span);
      return [{ node: direct, owner: host, original: direct.data }, { node: wrapped, owner: span, original: wrapped.data }];
    }, { expectedInitial: [true, true], expectedAfter: [true, true], expectedGeometry: [[true, true, true], [false, true, true]] });
    await exercise('visible-direct-slotted-text-under-zero-size-host', () => {
      const host = document.createElement('x-coverage-slotted');
      host.style.cssText = 'position:absolute;left:20px;top:80px;width:0;height:0;overflow:visible;font:18px Arial;white-space:nowrap';
      const shadow = host.attachShadow({ mode: 'open' }), slot = document.createElement('slot'); slot.style.display = 'contents'; shadow.append(slot);
      fixture.append(host); const node = makeText(host, 'visible slotted text');
      return [{ node, owner: host, original: node.data }];
    }, { expectedInitial: [true], expectedAfter: [true], expectedGeometry: [[true, true, true]] });
    await exercise('hidden-direct-slotted-text-control', () => {
      const host = document.createElement('x-coverage-hidden-slot');
      host.style.cssText = 'position:absolute;left:20px;top:120px;width:0;height:0;overflow:visible;font:18px Arial;white-space:nowrap';
      const shadow = host.attachShadow({ mode: 'open' }), slot = document.createElement('slot'); slot.style.cssText = 'display:contents;visibility:hidden'; shadow.append(slot);
      fixture.append(host); const node = makeText(host, 'hidden slotted text');
      return [{ node, owner: host, original: node.data }];
    }, { expectedInitial: [false], expectedAfter: [false], expectedGeometry: [[true, true, true]] });
    await exercise('shadow-overflow-clip-control', () => {
      const host = document.createElement('x-coverage-shadow-clip');
      host.style.cssText = 'position:absolute;left:20px;top:160px;width:0;height:0;overflow:visible';
      const shadow = host.attachShadow({ mode: 'open' }), clip = document.createElement('div');
      clip.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:hidden;font:18px Arial;white-space:nowrap';
      const owner = document.createElement('div'); owner.style.display = 'contents'; clip.append(owner); shadow.append(clip); fixture.append(host);
      const node = makeText(owner, 'shadow clipped text');
      return [{ node, owner, original: node.data }];
    }, { expectedInitial: [false], expectedAfter: [false], expectedGeometry: [[true, true, true]] });
    await exercise('hidden-zero-box-text', () => {
      const probes = [];
      for (const [id, style] of [['display', 'display:none'], ['visibility', 'visibility:hidden'], ['content-visibility', 'content-visibility:hidden']]) {
        const owner = document.createElement('div'); owner.style.cssText = `display:contents;${style}`; owner.dataset.coverage = id;
        fixture.append(owner); const node = makeText(owner, `hidden ${id}`); probes.push({ node, owner, original: node.data });
      }
      return probes;
    }, { expectedInitial: [false, false, false], expectedAfter: [false, false, false], expectedGeometry: [[true, false, false], [true, true, true], [true, true, true]] });
    await exercise('zero-size-overflow-hidden-clip', () => {
      const clip = document.createElement('div'); clip.style.cssText = 'position:absolute;left:20px;top:180px;width:0;height:0;overflow:hidden';
      const owner = document.createElement('div'); owner.style.display = 'contents'; clip.append(owner); fixture.append(clip);
      const node = makeText(owner, 'fully clipped text'); return [{ node, owner, original: node.data }];
    }, { expectedInitial: [false], expectedAfter: [false], expectedGeometry: [[true, true, true]] });
    await exercise('partial-overflow-clip-keeps-visible-fragment', () => {
      const clip = document.createElement('div'); clip.style.cssText = 'position:absolute;left:20px;top:220px;width:70px;height:32px;overflow:hidden;font:20px Arial;white-space:nowrap';
      const owner = document.createElement('div'); owner.style.display = 'contents'; clip.append(owner); fixture.append(clip);
      const node = makeText(owner, 'partially visible fragment'); return [{ node, owner, original: node.data }];
    }, { expectedInitial: [true], expectedAfter: [true], expectedGeometry: [[true, true, true]] });
    await exercise('clip-ancestor-outside-engine-root', () => {
      const clip = document.createElement('div'); clip.style.cssText = 'position:absolute;left:20px;top:270px;width:0;height:20px;overflow:hidden';
      const engineRoot = document.createElement('section'); const owner = document.createElement('div'); owner.style.display = 'contents';
      const node = makeText(owner, 'outside root clipped text'); engineRoot.append(owner); clip.append(engineRoot); fixture.append(clip);
      return [{ node, owner, original: node.data }];
    }, { rootForEngine: () => fixture.querySelector('section'), expectedInitial: [false], expectedAfter: [false], expectedGeometry: [[true, true, true]] });
    await exercise('offscreen-beyond-margin', () => {
      const position = document.createElement('div'); position.style.cssText = 'position:absolute;left:0;top:1200px';
      const owner = document.createElement('div'); owner.style.display = 'contents'; position.append(owner); fixture.append(position);
      const node = makeText(owner, 'beyond viewport margin'); return [{ node, owner, original: node.data }];
    }, { expectedInitial: [false], expectedAfter: [false], expectedGeometry: [[true, true, false]] });
    await exercise('scroll-into-viewport', () => {
      const spacer = document.createElement('div'); spacer.style.height = '1000px'; fixture.append(spacer);
      const owner = document.createElement('div'); owner.style.display = 'contents'; fixture.append(owner);
      const node = makeText(owner, 'scroll target'); return [{ node, owner, original: node.data }];
    }, { afterStart: () => window.scrollTo(0, 1000), expectedInitial: [false], expectedAfter: [true], expectedGeometry: [[true, true, false]] });

    return { environment: { userAgent: navigator.userAgent, viewport: `${innerWidth}x${innerHeight}` }, cases };
    } finally {
      fixture.replaceChildren(); window.scrollTo(0, 0);
    }
  }

  globalThis.TranslateItPageCoverageChecks = { run };
})();
