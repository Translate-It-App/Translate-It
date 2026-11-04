(() => {
  'use strict';

  async function run() {
    const fixture = document.querySelector('main#benchmark-root[data-benchmark-fixture="page-translation-prototype"]');
    if (!fixture) throw new Error('Coverage checks require the marked local fixture root.');
    const delay = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
    const makeText = (parent, value) => { const node = document.createTextNode(value); parent.append(node); return node; };
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const clientClip = element => { const r = element.getBoundingClientRect(), left = r.left + element.clientLeft, top = r.top + element.clientTop; return { left, top, right: left + element.clientWidth, bottom: top + element.clientHeight, width: element.clientWidth, height: element.clientHeight }; };
    const rangeSummary = (node, owner, clips = []) => {
      const range = document.createRange(); range.selectNodeContents(node);
      const rects = range.getClientRects(), fragments = [], clipBoxes = clips.map(clientClip); let positive = 0, onScreen = 0, maxWidth = 0, maxHeight = 0, rangeIntersectsClip = clips.length ? false : null, rangeCenterHitsOwner = false, rangeCenterHitsClip = false;
      for (let i = 0; i < rects.length; i++) {
        const r = rects.item(i) ?? rects[i];
        fragments.push({ x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom });
        if (r.width > 0 && r.height > 0) {
          positive++; maxWidth = Math.max(maxWidth, r.width); maxHeight = Math.max(maxHeight, r.height);
          if (r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight) onScreen++;
          const clipIntersection = clipBoxes.length && clipBoxes.every(c => r.right > c.left && r.left < c.right && r.bottom > c.top && r.top < c.bottom);
          if (clipIntersection) rangeIntersectsClip = true;
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          rangeCenterHitsOwner ||= !!hit && (hit === owner || owner.contains(hit));
          rangeCenterHitsClip ||= !!hit && clips.some(clip => hit === clip || clip.contains(hit));
        }
      }
      return { fragments: rects.length, positiveFragments: positive, onScreenFragments: onScreen, maxWidth, maxHeight, fragmentsRect: fragments, rangeIntersectsClip, rangeCenterHitsOwner, rangeCenterHitsClip };
    };
    const assertVector = (name, field, actual, expected) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Coverage check ${name}: ${field} mismatch (${JSON.stringify(actual)}).`);
    };
    const assertGeometry = (name, actual, expected) => {
      if (actual.length !== expected.length || actual.some((row, i) => row.ownerZeroBox !== expected[i][0] || (row.range.positiveFragments > 0) !== expected[i][1] || (row.range.onScreenFragments > 0) !== expected[i][2])) throw new Error(`Coverage check ${name}: geometry mismatch (${JSON.stringify(actual.map(row => [row.ownerZeroBox, row.range.positiveFragments > 0, row.range.onScreenFragments > 0]))}).`);
    };
    const cases = [];
    const exercise = async (name, build, { rootForEngine = () => fixture, afterStart, expectedInitial, expectedAfter, expectedInitialAttrs, expectedAfterAttrs, expectedGeometry, expectedClipIntersection, expectedRangeHitOwner } = {}) => {
      window.scrollTo(0, 0); fixture.replaceChildren();
      const probes = build();
      await delay();
      const geometry = probes.map(({ node, owner, clips = [] }) => ({ ownerZeroBox: rect(owner).width === 0 && rect(owner).height === 0, ownerRect: rect(owner), clipRects: clips.map(clip => rect(clip)), range: rangeSummary(node, owner, clips) }));
      const engineRoot = rootForEngine();
      const engine = TranslateItViewportPrototype.createEngine({ root: engineRoot, mode: 'viewport' });
      const attrProbes = probes.filter(probe => probe.attr);
      let initial, afterTrigger, initialAttrs, afterTriggerAttrs, activeStats, cleanupStats;
      try {
        await engine.start(); await engine.whenIdle();
        initial = probes.map(({ node }) => node.data.startsWith('⟦TI⟧'));
        assertVector(name, 'initial translations', initial, expectedInitial);
        initialAttrs = attrProbes.map(({ attr }) => attr.value.startsWith('⟦TI⟧'));
        if (expectedInitialAttrs) assertVector(name, 'initial attributes', initialAttrs, expectedInitialAttrs);
        if (afterStart) { await afterStart(); await delay(50); await engine.whenIdle(); }
        afterTrigger = probes.map(({ node }) => node.data.startsWith('⟦TI⟧'));
        assertVector(name, 'trigger translations', afterTrigger, expectedAfter);
        afterTriggerAttrs = attrProbes.map(({ attr }) => attr.value.startsWith('⟦TI⟧'));
        if (expectedAfterAttrs) assertVector(name, 'trigger attributes', afterTriggerAttrs, expectedAfterAttrs);
        assertGeometry(name, geometry, expectedGeometry);
        if (expectedClipIntersection) assertVector(name, 'range/clip intersections', geometry.map(row => row.range.rangeIntersectsClip), expectedClipIntersection);
        if (expectedRangeHitOwner) assertVector(name, 'Range-center owner hit', geometry.map(row => row.range.rangeCenterHitsOwner), expectedRangeHitOwner);
        activeStats = engine.getStats();
      } finally {
        await engine.cleanup();
        cleanupStats = engine.getStats();
      }
      const restored = probes.map(({ node, original }) => node.data === original);
      const attributesRestored = attrProbes.map(({ attr, originalAttr }) => attr.value === originalAttr);
      window.dispatchEvent(new Event('scroll')); await delay(30);
      const lateWritesAbsent = probes.every(({ node, original }) => node.data === original);
      assertVector(name, 'restoration', restored, probes.map(() => true));
      assertVector(name, 'attribute restoration', attributesRestored, attrProbes.map(() => true));
      if (!lateWritesAbsent || cleanupStats.observerCount !== 0 || cleanupStats.pendingJobCount !== 0) throw new Error(`Coverage check ${name}: cleanup mismatch.`);
      cases.push({
        name, geometry, translatedInitially: initial, translatedAfterTrigger: afterTrigger, attributesInitially: initialAttrs, attributesAfterTrigger: afterTriggerAttrs, restored, attributesRestored, lateWritesAbsent,
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
      return [{ node, owner, original: node.data, clips: [clip] }];
    }, { expectedInitial: [false], expectedAfter: [false], expectedGeometry: [[true, true, true]] });
    await exercise('shadow-positive-owner-ordinary-clip', () => {
      const host = document.createElement('x-coverage-shadow-positive-clip'); host.style.cssText = 'display:block;width:160px;height:32px;margin-top:20px';
      const shadow = host.attachShadow({ mode: 'open' }), clip = document.createElement('div'); clip.style.cssText = 'width:0;height:24px;overflow:hidden;font:18px Arial;white-space:nowrap';
      const owner = document.createElement('span'); owner.style.cssText = 'display:block;width:150px;height:24px';
      const node = makeText(owner, 'shadow positive clip'); clip.append(owner); shadow.append(clip); fixture.append(host);
      return [{ node, owner, original: node.data, clips: [clip] }];
    }, { expectedInitial: [false], expectedAfter: [false], expectedGeometry: [[false, true, true]], expectedClipIntersection: [false], expectedRangeHitOwner: [false] });
    await exercise('positive-host-hidden-slot-slotted-text', () => {
      const host = document.createElement('x-coverage-positive-hidden-slot'); host.style.cssText = 'display:block;width:160px;height:32px;margin-top:20px';
      const shadow = host.attachShadow({ mode: 'open' }), slot = document.createElement('slot'); slot.style.visibility = 'hidden'; shadow.append(slot); fixture.append(host);
      const node = makeText(host, 'hidden positive slot'); return [{ node, owner: host, original: node.data }];
    }, { expectedInitial: [false], expectedAfter: [false], expectedGeometry: [[false, true, true]] });
    await exercise('hidden-host-visible-slot-slotted-text', () => {
      const host = document.createElement('x-coverage-hidden-host-visible-slot'); host.style.cssText = 'display:block;width:160px;height:32px;margin-top:20px;visibility:hidden';
      const shadow = host.attachShadow({ mode: 'open' }), slot = document.createElement('slot'); slot.style.cssText = 'display:block;visibility:visible'; shadow.append(slot); fixture.append(host);
      const node = makeText(host, 'visible slot override'); return [{ node, owner: host, original: node.data }];
    }, { expectedInitial: [true], expectedAfter: [true], expectedGeometry: [[false, true, true]] });
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
    const positiveClip = (overflow, indent) => () => {
      const clip = document.createElement('div'); clip.style.cssText = `margin:100px 0 0 120px;width:100px;height:34px;overflow:${overflow};font:18px Arial;line-height:24px;white-space:nowrap`;
      const owner = document.createElement('div'); owner.style.cssText = `width:80px;height:24px;text-indent:${indent}px;white-space:nowrap`; owner.title = 'owner attribute';
      const node = makeText(owner, 'positive clip text'), attr = owner.getAttributeNode('title'); clip.append(owner); fixture.append(clip);
      return [{ node, owner, original: node.data, attr, originalAttr: attr.value, clips: [clip] }];
    };
    for (const overflow of ['hidden', 'clip', 'auto', 'scroll']) {
      await exercise(`${overflow}-ordinary-fully-clipped-positive-owner`, positiveClip(overflow, 150), {
        expectedInitial: [false], expectedAfter: [false], expectedInitialAttrs: [true], expectedAfterAttrs: [true],
        expectedGeometry: [[false, true, true]], expectedClipIntersection: [false], expectedRangeHitOwner: [false],
      });
      await exercise(`${overflow}-ordinary-partial-clip-positive-owner`, positiveClip(overflow, 20), {
        expectedInitial: [true], expectedAfter: [true], expectedInitialAttrs: [true], expectedAfterAttrs: [true],
        expectedGeometry: [[false, true, true]], expectedClipIntersection: [true], expectedRangeHitOwner: [true],
      });
    }
    await exercise('relative-offset-text-and-title-outside-clip', () => {
      const clip = document.createElement('div'); clip.style.cssText = 'position:relative;left:120px;top:100px;width:100px;height:34px;overflow:hidden';
      const owner = document.createElement('div'); owner.style.cssText = 'position:relative;left:140px;width:80px;height:24px'; owner.title = 'offset title';
      const node = makeText(owner, 'relative offset text'), attr = owner.getAttributeNode('title'); clip.append(owner); fixture.append(clip);
      return [{ node, owner, original: node.data, attr, originalAttr: attr.value, clips: [clip] }];
    }, { expectedInitial: [false], expectedAfter: [false], expectedInitialAttrs: [false], expectedAfterAttrs: [false], expectedGeometry: [[false, true, true]], expectedClipIntersection: [false], expectedRangeHitOwner: [false] });
    await exercise('positive-owner-box-overlaps-clip-text-outside-title-remains', positiveClip('hidden', 160), {
      expectedInitial: [false], expectedAfter: [false], expectedInitialAttrs: [true], expectedAfterAttrs: [true],
      expectedGeometry: [[false, true, true]], expectedClipIntersection: [false], expectedRangeHitOwner: [false],
    });
    await exercise('fixed-escapes-static-overflow-hidden', () => {
      const clip = document.createElement('div'); clip.style.cssText = 'margin:100px 0 0 120px;width:100px;height:34px;overflow:hidden';
      const owner = document.createElement('div'); owner.style.cssText = 'position:fixed;left:690px;top:320px;width:40px;height:28px;background:lime';
      const node = makeText(owner, 'fixed escape'); clip.append(owner); fixture.append(clip); return [{ node, owner, original: node.data, clips: [clip] }];
    }, { expectedInitial: [true], expectedAfter: [true], expectedGeometry: [[false, true, true]], expectedRangeHitOwner: [true] });
    await exercise('absolute-escapes-static-overflow-clip', () => {
      const clip = document.createElement('div'); clip.style.cssText = 'margin:100px 0 0 120px;width:100px;height:34px;overflow:clip';
      const owner = document.createElement('div'); owner.style.cssText = 'position:absolute;left:690px;top:320px;width:80px;height:28px;background:lime';
      const node = makeText(owner, 'absolute escape'); clip.append(owner); fixture.append(clip); return [{ node, owner, original: node.data, clips: [clip] }];
    }, { expectedInitial: [true], expectedAfter: [true], expectedGeometry: [[false, true, true]], expectedRangeHitOwner: [true] });
    await exercise('absolute-clipped-by-relative-containing-block-best-effort', () => {
      const clip = document.createElement('div'); clip.style.cssText = 'position:relative;left:120px;top:100px;width:100px;height:34px;overflow:hidden';
      const owner = document.createElement('div'); owner.style.cssText = 'position:absolute;left:130px;top:0;width:80px;height:24px';
      const node = makeText(owner, 'absolute clipped control'); clip.append(owner); fixture.append(clip); return [{ node, owner, original: node.data, clips: [clip] }];
    }, { expectedInitial: [true], expectedAfter: [true], expectedGeometry: [[false, true, true]], expectedClipIntersection: [false], expectedRangeHitOwner: [false] });
    await exercise('fixed-clipped-by-transformed-containing-block-best-effort', () => {
      const clip = document.createElement('div'); clip.style.cssText = 'position:relative;left:120px;top:100px;width:100px;height:34px;overflow:hidden;transform:translateZ(0)';
      const owner = document.createElement('div'); owner.style.cssText = 'position:fixed;left:130px;top:0;width:80px;height:24px';
      const node = makeText(owner, 'fixed clipped control'); clip.append(owner); fixture.append(clip); return [{ node, owner, original: node.data, clips: [clip] }];
    }, { expectedInitial: [true], expectedAfter: [true], expectedGeometry: [[false, true, true]], expectedClipIntersection: [false], expectedRangeHitOwner: [false] });
    await exercise('transformed-visible-positive-control', () => {
      const parent = document.createElement('div'); parent.style.cssText = 'position:relative;left:120px;top:100px;transform:translateZ(0)';
      const owner = document.createElement('div'); owner.style.cssText = 'width:120px;height:24px';
      const node = makeText(owner, 'transformed visible'); parent.append(owner); fixture.append(parent); return [{ node, owner, original: node.data }];
    }, { expectedInitial: [true], expectedAfter: [true], expectedGeometry: [[false, true, true]], expectedRangeHitOwner: [true] });
    await exercise('nested-positive-clip-partial', () => {
      const outer = document.createElement('div'); outer.style.cssText = 'margin:300px 0 0 120px;width:100px;height:40px;overflow-x:hidden;overflow-y:visible';
      const inner = document.createElement('div'); inner.style.cssText = 'width:90px;height:20px;overflow-x:visible;overflow-y:hidden;font:18px Arial;line-height:24px;white-space:nowrap';
      const owner = document.createElement('div'); owner.style.cssText = 'width:80px;height:24px;text-indent:20px'; owner.title = 'nested title';
      const node = makeText(owner, 'nested positive text'), attr = owner.getAttributeNode('title'); inner.append(owner); outer.append(inner); fixture.append(outer);
      return [{ node, owner, original: node.data, attr, originalAttr: attr.value, clips: [outer, inner] }];
    }, { expectedInitial: [true], expectedAfter: [true], expectedInitialAttrs: [true], expectedAfterAttrs: [true], expectedGeometry: [[false, true, true]], expectedClipIntersection: [true] });
    await exercise('nested-positive-clip-text-outside-title-remains', () => {
      const outer = document.createElement('div'); outer.style.cssText = 'margin:350px 0 0 120px;width:100px;height:40px;overflow-x:hidden;overflow-y:visible';
      const inner = document.createElement('div'); inner.style.cssText = 'width:90px;height:20px;overflow-x:visible;overflow-y:hidden;font:18px Arial;line-height:24px;white-space:nowrap';
      const owner = document.createElement('div'); owner.style.cssText = 'width:80px;height:24px;text-indent:160px'; owner.title = 'nested title';
      const node = makeText(owner, 'nested positive text'), attr = owner.getAttributeNode('title'); inner.append(owner); outer.append(inner); fixture.append(outer);
      return [{ node, owner, original: node.data, attr, originalAttr: attr.value, clips: [outer, inner] }];
    }, { expectedInitial: [false], expectedAfter: [false], expectedInitialAttrs: [true], expectedAfterAttrs: [true], expectedGeometry: [[false, true, true]], expectedClipIntersection: [false], expectedRangeHitOwner: [false] });
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
