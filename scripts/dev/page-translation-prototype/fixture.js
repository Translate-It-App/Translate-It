(() => {
  'use strict';

  const api = {
    create({ root = document.querySelector('main#benchmark-root[data-benchmark-fixture="page-translation-prototype"]'), branches = 2500, depth = 4, visibleCount = 24 } = {}) {
      if (!root || root.nodeType !== 1 || root.tagName !== 'MAIN' || root.id !== 'benchmark-root' || root.dataset.benchmarkFixture !== 'page-translation-prototype' || root.ownerDocument !== document || root === document.body || root === document.documentElement || !document.body.contains(root)) {
        throw new TypeError('Refusing to modify DOM: pass the dedicated #benchmark-root[data-benchmark-fixture="page-translation-prototype"] fixture container.');
      }
      if (!Number.isInteger(branches) || branches < 0 || branches > 10000 || !Number.isInteger(depth) || depth < 1 || depth > 8 || !Number.isInteger(visibleCount) || visibleCount < 1 || visibleCount > 1000) throw new RangeError('Invalid fixture size');
      root.replaceChildren();
      const originals = new Map();
      const record = (node, key, value) => originals.set({ node, key }, value);
      const text = (parent, value) => {
        const node = document.createTextNode(value);
        parent.append(node);
        record(node, 'text', value);
        return node;
      };
      const attr = (node, name, value) => {
        node.setAttribute(name, value);
        record(node, name, value);
      };
      const makeBranch = (index) => {
        let parent = root;
        for (let level = 0; level < depth; level += 1) {
          const section = document.createElement('section');
          section.className = 'fixture-offscreen';
          parent.append(section);
          parent = section;
        }
        const paragraph = document.createElement('p');
        parent.append(paragraph);
        text(paragraph, `fixture branch ${index} deterministic source text`);
        attr(paragraph, 'title', `fixture branch ${index} title`);
        attr(paragraph, 'aria-label', `fixture branch ${index} label`);
        return paragraph;
      };

      for (let index = 0; index < branches; index += 1) makeBranch(index);
      const visible = document.createElement('main');
      visible.id = 'fixture-visible';
      root.append(visible);
      const visibleNodes = [];
      for (let index = 0; index < visibleCount; index += 1) {
        const paragraph = document.createElement('p');
        visible.append(paragraph);
        visibleNodes.push(text(paragraph, `visible fixture ${index} deterministic source text`));
        attr(paragraph, 'title', `visible fixture ${index} title`);
        attr(paragraph, 'alt', `visible fixture ${index} alternate`);
        attr(paragraph, 'placeholder', `visible fixture ${index} placeholder`);
      }

      const excluded = document.createElement('textarea');
      excluded.value = 'editable source must not be translated';
      visible.append(excluded);
      const excludedText = document.createElement('input');
      excludedText.value = 'input source must not be translated';
      visible.append(excludedText);
      const excludedNode = document.createElement('p');
      excludedNode.className = 'benchmark-excluded';
      visible.append(excludedNode);
      text(excludedNode, 'excluded source must not be translated');

      const shadowHost = document.createElement('div');
      shadowHost.id = 'fixture-shadow-host';
      visible.append(shadowHost);
      const shadow = shadowHost.attachShadow({ mode: 'open' });
      const shadowParagraph = document.createElement('p');
      shadow.append(shadowParagraph);
      const shadowText = text(shadowParagraph, 'open shadow source deterministic text');
      attr(shadowParagraph, 'title', 'open shadow title');
      // Put the visible section in view before timing; all preceding nested branches stay offscreen.
      visible.scrollIntoView?.({ block: 'center' });

      const addDynamic = (phase) => {
        const node = document.createElement('p');
        node.dataset.fixturePhase = phase;
        text(node, `dynamic ${phase} deterministic source text`);
        attr(node, 'title', `dynamic ${phase} title`);
        visible.append(node);
        const shadowDynamic = document.createElement('p');
        text(shadowDynamic, `dynamic shadow ${phase} deterministic source text`);
        shadow.append(shadowDynamic);
        return [node, shadowDynamic];
      };
      const mutateExternally = () => {
        const externalText = visibleNodes[0];
        externalText.data = 'external page edit must be preserved';
        const externalAttr = visible.querySelector('p');
        externalAttr.setAttribute('title', 'external page title edit must be preserved');
        return { externalText, externalAttr };
      };
      const snapshot = () => [...originals].map(([identity, value]) => ({ ...identity, value }));
      return { root, visible, visibleNodes, shadowText, shadowParagraph, addDynamic, mutateExternally, snapshot };
    },
    mockTranslate(value) { return `⟦${String(value)}⟧`; },
  };

  globalThis.TranslateItBenchmarkFixture = api;
})();
