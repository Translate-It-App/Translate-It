import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() })),
}));

vi.mock('@/utils/dom/DomDirectionManager.js', () => ({
  applyNodeDirection: vi.fn(),
  isRTL: vi.fn(() => false),
  restoreElementDirection: vi.fn(),
  BIDI_MARKS: { RLM: '\u200f', LRM: '\u200e' },
}));

const settings = {
  targetLanguage: 'en',
  lazyLoading: false,
  showOriginalOnHover: false,
  autoTranslateOnDOMChanges: false,
  attributesToTranslate: ['title', 'alt', 'placeholder'],
};

const loadBridge = async (sliced, viewport, caps = {}) => {
  vi.resetModules();
  vi.doMock('./PageTranslationConstants.js', async () => ({
    ...await vi.importActual('./PageTranslationConstants.js'),
    PAGE_TRANSLATION_SLICED_DISCOVERY: sliced,
    PAGE_TRANSLATION_VIEWPORT_FIRST_DISCOVERY: viewport,
    PAGE_TRANSLATION_DISCOVERY_SLICE_MAX_STEPS: caps.sliceSteps ?? 1,
    PAGE_TRANSLATION_DISCOVERY_SLICE_BUDGET_MS: caps.sliceBudget ?? 1000,
    PAGE_TRANSLATION_VIEWPORT_WINDOW_ENUMERATION_STEPS: caps.windowEnumeration ?? 100,
    PAGE_TRANSLATION_VIEWPORT_WINDOW_MAX_CANDIDATES: caps.windowCandidates ?? 100,
    PAGE_TRANSLATION_VIEWPORT_WINDOW_MAX_GEOMETRY_CHECKS: caps.geometryChecks ?? 100,
  }));
  return (await import('./PageTranslationBridge.js')).PageTranslationBridge;
};

const accepted = text => ({
  __pageTranslationSettlement: true,
  text: `Translated ${text}`,
  state: 'pending',
  settle(outcome) { this.state = outcome; },
});

const makeElement = (parent, tagName, text, attributes = {}) => {
  const element = document.createElement(tagName);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  if (text) element.appendChild(document.createTextNode(text));
  parent.appendChild(element);
  return element;
};

describe('Page Translation viewport-first discovery', () => {
  let bridge;

  afterEach(() => {
    bridge?.cleanup();
    bridge = null;
    vi.restoreAllMocks();
    vi.doUnmock('./PageTranslationConstants.js');
    document.body.replaceChildren();
  });

  it.each([
    [false, false, false],
    [false, true, false],
    [true, false, false],
    [true, true, true],
  ])('captures sliced=%s viewport=%s as effective=%s for the session', async (sliced, viewport, effective) => {
    const Bridge = await loadBridge(sliced, viewport);
    bridge = new Bridge();
    await bridge.initialize(settings, vi.fn());
    expect(bridge.session.slicedDiscoveryEnabled).toBe(sliced);
    expect(bridge.session.viewportFirstDiscoveryEnabled).toBe(effective);
  });

  it('prioritizes visible primitives in the initial canonical window without losing parity', async () => {
    const Bridge = await loadBridge(true, true);
    bridge = new Bridge();
    const offscreen = makeElement(document.body, 'p', 'Earlier offscreen', { title: 'Earlier title' });
    makeElement(document.body, 'div', 'Middle content');
    const visible = makeElement(document.body, 'button', 'Late visible', {
      title: 'Visible title', alt: 'Visible alt', placeholder: 'Visible placeholder',
    });
    const visiblePrimitives = [visible.getAttributeNode('title'), visible.getAttributeNode('alt'),
      visible.getAttributeNode('placeholder'), visible.firstChild];
    vi.spyOn(visible, 'getBoundingClientRect').mockReturnValue({
      top: 10, left: 10, right: 100, bottom: 40, width: 90, height: 30,
    });

    const admitted = [];
    const states = [];
    const errors = [];
    await bridge.initialize(settings, (text, _context, _score, node) => {
      admitted.push({ text, node });
      return Promise.resolve(accepted(text));
    }, null, {
      onDiscoveryStateChange: pending => states.push(pending),
      onDiscoveryError: error => errors.push(error.message),
    });
    const timers = [];
    vi.spyOn(bridge, 'trackTimeout').mockImplementation(callback => {
      timers.push(callback);
      return timers.length;
    });
    bridge.translate(document.body);
    expect(bridge.session.viewportWindowStarted).toBe(true);
    expect(errors).toEqual([]);
    while (bridge.session.discovery.pending) timers.shift()();
    await Promise.resolve();
    expect(errors).toEqual([]);
    expect({ states, pending: bridge.session.discovery.pending, failed: bridge.session.discovery.failed })
      .toEqual({ states: [true, false], pending: false, failed: false });
    await vi.waitFor(() => expect(visible.textContent).toContain('Translated Late visible'));

    expect(visible.getBoundingClientRect).toHaveBeenCalled();
    expect(admitted[0].text).toBe('Visible title');
    expect(admitted[0].node).toBe(visiblePrimitives[0]);
    expect(admitted.some(({ node }) => node === offscreen.firstChild)).toBe(true);
    expect(admitted).toHaveLength(7);
    for (const primitive of visiblePrimitives) {
      expect(admitted.filter(({ node }) => node === primitive)).toHaveLength(1);
    }
    expect(admitted.map(({ node }) => node)).toContain(offscreen.getAttributeNode('title'));
    bridge.restore(document.body);
    expect(visible.textContent).toBe('Late visible');
    expect(visible.title).toBe('Visible title');
    expect(visible.getAttribute('alt')).toBe('Visible alt');
    expect(visible.getAttribute('placeholder')).toBe('Visible placeholder');

    const viewportTargets = admitted.map(({ node }) => node);
    const SlicedBridge = await loadBridge(true, false);
    bridge = new SlicedBridge();
    const canonicalTargets = [];
    await bridge.initialize(settings, (text, _context, _score, node) => {
      canonicalTargets.push(node);
      return Promise.resolve(accepted(text));
    });
    bridge.translate(document.body);
    await vi.waitFor(() => expect(canonicalTargets).toHaveLength(viewportTargets.length));
    await vi.waitFor(() => expect(visible.textContent).toContain('Translated Late visible'));
    expect(canonicalTargets).toHaveLength(viewportTargets.length);
    expect(viewportTargets.every(node => canonicalTargets.includes(node))).toBe(true);
  });

  it('falls back to canonical admission when optional geometry throws', async () => {
    const owners = [];
    for (let index = 0; index < 120; index++) {
      owners.push(makeElement(document.body, 'p', `Geometry candidate ${index}`));
    }
    vi.spyOn(owners[0], 'getBoundingClientRect')
      .mockImplementationOnce(() => { throw new Error('layout geometry unavailable'); })
      .mockReturnValue({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
    vi.spyOn(owners[1], 'getBoundingClientRect').mockReturnValue({
      top: 1, left: 1, right: 20, bottom: 20, width: 19, height: 19,
    });

    const run = async (viewport) => {
      const Bridge = await loadBridge(true, viewport);
      bridge = new Bridge();
      const calls = [];
      const states = [];
      const errors = [];
      const timers = [];
      vi.spyOn(bridge, 'trackTimeout').mockImplementation(callback => {
        timers.push(callback);
        return timers.length;
      });
      await bridge.initialize({ ...settings, attributesToTranslate: [] }, (text, _context, _score, node) => {
        calls.push({ text, node });
        return Promise.resolve(accepted(text));
      }, null, {
        onDiscoveryStateChange: pending => states.push(pending),
        onDiscoveryError: error => errors.push(error.message),
      });
      bridge.session.nodesTranslator.config.nodeImportanceScore = () => 1;
      bridge.translate(document.body);
      const task = bridge.session.discovery.queue[0];
      if (viewport) {
        while (task.viewportWindow) timers.shift()();
        expect(states).toEqual([true]);
        expect(bridge.session.discovery.pending).toBe(true);
      }
      while (bridge.session.discovery.pending) timers.shift()();
      expect(errors).toEqual([]);
      expect(states).toEqual([true, false]);
      await vi.waitFor(() => expect(calls).toHaveLength(owners.length));
      return { calls, snapshot: owners.map(owner => owner.textContent) };
    };

    const viewport = await run(true);
    expect(viewport.calls[0].node).toBe(owners[1].firstChild);
    expect(viewport.calls.some(({ node }) => node === owners[0].firstChild)).toBe(true);
    bridge.restore(document.body);
    expect(owners.map(owner => owner.textContent)).toEqual(owners.map((_, index) => `Geometry candidate ${index}`));

    owners[0].getBoundingClientRect.mockClear();
    owners[1].getBoundingClientRect.mockClear();
    const slicedOnly = await run(false);
    expect(owners[0].getBoundingClientRect).not.toHaveBeenCalled();
    expect(owners[1].getBoundingClientRect).not.toHaveBeenCalled();
    expect(viewport.calls.map(({ node }) => node).every(node => slicedOnly.calls.some(call => call.node === node))).toBe(true);
    expect(viewport.snapshot).toEqual(slicedOnly.snapshot);
    bridge.restore(document.body);
    expect(owners.map(owner => owner.textContent)).toEqual(owners.map((_, index) => `Geometry candidate ${index}`));
  });

  it('still reports a real primitive-admission failure outside the geometry fallback', async () => {
    const Bridge = await loadBridge(true, true);
    bridge = new Bridge();
    makeElement(document.body, 'p', 'Translation failure');
    const translationError = new Error('primitive admission failed');
    const errors = [];
    const states = [];
    await bridge.initialize(settings, vi.fn(), null, {
      onDiscoveryStateChange: pending => states.push(pending),
      onDiscoveryError: error => errors.push(error.message),
    });
    bridge.session.nodesTranslator.translate = () => { throw translationError; };
    bridge.translate(document.body);
    await vi.waitFor(() => expect(errors).toEqual(['primitive admission failed']));

    expect(states).toEqual([true]);
    expect(bridge.session.discovery.failed).toBe(true);
  });

  it('still reports a real canonical traversal failure outside the geometry fallback', async () => {
    const Bridge = await loadBridge(true, true);
    bridge = new Bridge();
    makeElement(document.body, 'p', 'Traversal failure');
    const traversalError = new Error('canonical iterator failed');
    const errors = [];
    const states = [];
    vi.spyOn(document, 'createNodeIterator').mockReturnValue({
      nextNode: () => { throw traversalError; },
    });
    await bridge.initialize(settings, vi.fn(), null, {
      onDiscoveryStateChange: pending => states.push(pending),
      onDiscoveryError: error => errors.push(error.message),
    });
    bridge.translate(document.body);

    expect(errors).toEqual(['canonical iterator failed']);
    expect(states).toEqual([true]);
    expect(bridge.session.discovery.failed).toBe(true);
  });

  it('keeps one lazy action per window primitive and does not reprioritize on scroll', async () => {
    const PreviousIntersectionObserver = globalThis.IntersectionObserver;
    const observers = [];
    globalThis.IntersectionObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.observe = vi.fn();
        this.unobserve = vi.fn();
        this.disconnect = vi.fn();
        observers.push(this);
      }
    };
    try {
      const Bridge = await loadBridge(true, true);
      bridge = new Bridge();
      const offscreen = makeElement(document.body, 'p', 'Offscreen', { title: 'Offscreen title' });
      const visible = makeElement(document.body, 'p', 'Visible lazy', { title: 'Visible lazy title' });
      const geometry = vi.spyOn(visible, 'getBoundingClientRect').mockReturnValue({
        top: 10, left: 10, right: 100, bottom: 40, width: 90, height: 30,
      });
      const calls = [];
      const states = [];
      await bridge.initialize({ ...settings, lazyLoading: true }, (text, _context, _score, node) => {
        calls.push({ text, node });
        return Promise.resolve(accepted(text));
      }, null, { onDiscoveryStateChange: pending => states.push(pending) });
      bridge.translate(document.body);
      await vi.waitFor(() => expect(states).toEqual([true, false]));
      expect(calls.map(({ text }) => text).sort()).toEqual(['Offscreen title', 'Visible lazy title']);

      const geometryCalls = geometry.mock.calls.length;
      window.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
      expect(geometry).toHaveBeenCalledTimes(geometryCalls);
      observers[0].callback([
        { target: visible, isIntersecting: true },
        { target: offscreen, isIntersecting: false },
      ], observers[0]);
      await vi.waitFor(() => expect(calls).toHaveLength(3));

      expect(calls.map(({ text }) => text).sort()).toEqual([
        'Offscreen title', 'Visible lazy', 'Visible lazy title',
      ]);
      expect(calls.every(({ text, node }) => text === 'Offscreen title'
        ? node.ownerElement === offscreen
        : node.nodeType === Node.ATTRIBUTE_NODE
          ? node.ownerElement === visible
          : node.parentElement === visible)).toBe(true);
      expect(offscreen.textContent).toBe('Offscreen');
    } finally {
      if (PreviousIntersectionObserver) globalThis.IntersectionObserver = PreviousIntersectionObserver;
      else delete globalThis.IntersectionObserver;
    }
  });

  it('retains open-shadow traversal and persistent updates in the reordered window', async () => {
    const Bridge = await loadBridge(true, true);
    bridge = new Bridge();
    const host = makeElement(document.body, 'div', '');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(document.createTextNode('Unsupported direct shadow text'));
    const nestedHost = makeElement(shadow, 'section', '');
    const nestedShadow = nestedHost.attachShadow({ mode: 'open' });
    const owner = makeElement(nestedShadow, 'p', 'Nested shadow source', { title: 'Nested title' });
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      top: 10, left: 10, right: 100, bottom: 40, width: 90, height: 30,
    });
    const calls = [];
    await bridge.initialize({ ...settings, autoTranslateOnDOMChanges: true }, (text, _context, _score, node) => {
      calls.push({ text, node });
      return Promise.resolve(accepted(text));
    });
    bridge.translate(document.body);
    await vi.waitFor(() => expect(owner.textContent).toContain('Translated Nested shadow source'));
    await vi.waitFor(() => expect(owner.title).toContain('Translated Nested title'));
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(shadow.firstChild.nodeValue).toBe('Unsupported direct shadow text');
    expect(calls.filter(({ text }) => text === 'Nested shadow source')).toHaveLength(1);
    expect(calls.filter(({ text }) => text === 'Nested title')).toHaveLength(1);

    const added = makeElement(nestedShadow, 'span', 'Later shadow source');
    await vi.waitFor(() => expect(added.textContent).toContain('Translated Later shadow source'));
    added.firstChild.nodeValue = 'Updated shadow source';
    await vi.waitFor(() => expect(added.textContent).toContain('Translated Updated shadow source'));
    expect(calls.filter(({ text }) => text === 'Updated shadow source')).toHaveLength(1);

    const lightAdded = makeElement(document.body, 'span', 'Later light source');
    await vi.waitFor(() => expect(lightAdded.textContent).toContain('Translated Later light source'));
    lightAdded.firstChild.nodeValue = 'Updated light source';
    await vi.waitFor(() => expect(lightAdded.textContent).toContain('Translated Updated light source'));
    expect(calls.filter(({ text }) => text === 'Updated light source')).toHaveLength(1);
    bridge.restore(document.body);
    expect(added.textContent).toBe('Updated shadow source');
    expect(lightAdded.textContent).toBe('Updated light source');
  });

  it('uses current text when a buffered viewport-window candidate changes before admission', async () => {
    const Bridge = await loadBridge(true, true);
    bridge = new Bridge();
    const owner = makeElement(document.body, 'p', 'Source A');
    vi.spyOn(owner, 'getBoundingClientRect').mockReturnValue({
      top: 10, left: 10, right: 100, bottom: 40, width: 90, height: 30,
    });
    const timers = [];
    vi.spyOn(bridge, 'trackTimeout').mockImplementation(callback => {
      timers.push(callback);
      return timers.length;
    });
    const requests = [];
    await bridge.initialize(settings, text => {
      requests.push(text);
      return Promise.resolve(accepted(text));
    });
    bridge.translate(document.body);
    const task = bridge.session.discovery.queue[0];
    while (task.viewportWindow?.phase === 'collect') timers.shift()();

    owner.firstChild.nodeValue = 'Source B';
    while (bridge.session.discovery.pending) timers.shift()();

    expect(requests).toEqual(['Source B']);
    await vi.waitFor(() => expect(owner.textContent).toContain('Translated Source B'));
  });

  it('routes an edit during a pending window provider through a new update generation', async () => {
    const Bridge = await loadBridge(true, true);
    bridge = new Bridge();
    const owner = makeElement(document.body, 'p', 'Generation A');
    vi.spyOn(owner, 'getBoundingClientRect').mockReturnValue({
      top: 10, left: 10, right: 100, bottom: 40, width: 90, height: 30,
    });
    const timers = [];
    vi.spyOn(bridge, 'trackTimeout').mockImplementation(callback => {
      timers.push(callback);
      return timers.length;
    });
    let resolveA;
    const requests = [];
    await bridge.initialize(settings, text => {
      requests.push(text);
      if (text === 'Generation A') return new Promise(resolve => { resolveA = resolve; });
      return Promise.resolve(accepted(text));
    });
    bridge.translate(document.body);
    const node = owner.firstChild;
    while (!resolveA) timers.shift()();

    node.nodeValue = 'Generation B';
    bridge.session.domTranslator.update(node, vi.fn());
    await vi.waitFor(() => expect(owner.textContent).toContain('Translated Generation B'));
    resolveA(accepted('Generation A'));
    await Promise.resolve();
    await Promise.resolve();

    expect(requests).toEqual(['Generation A', 'Generation B']);
    expect(owner.textContent).toContain('Translated Generation B');
  });

  it('rejects a replaced buffered attribute while admitting the current Attr identity', async () => {
    const Bridge = await loadBridge(true, true);
    bridge = new Bridge();
    const owner = makeElement(document.body, 'p', 'Attribute owner', {
      'data-prefix': 'Removed prefix', title: 'Old title', alt: 'Alt text',
    });
    vi.spyOn(owner, 'getBoundingClientRect').mockReturnValue({
      top: 10, left: 10, right: 100, bottom: 40, width: 90, height: 30,
    });
    const oldAttribute = owner.getAttributeNode('title');
    const attributeLookup = vi.spyOn(owner, 'getAttributeNode');
    const timers = [];
    vi.spyOn(bridge, 'trackTimeout').mockImplementation(callback => {
      timers.push(callback);
      return timers.length;
    });
    const requests = [];
    await bridge.initialize({ ...settings, attributesToTranslate: ['data-prefix', 'title', 'alt'] }, text => {
      requests.push(text);
      return Promise.resolve(accepted(text));
    });
    bridge.translate(document.body);
    while (!attributeLookup.mock.calls.some(([name]) => name === 'data-prefix')) timers.shift()();

    owner.removeAttribute('data-prefix');
    owner.removeAttribute('title');
    owner.setAttribute('title', 'Current title');
    const currentAttribute = owner.getAttributeNode('title');
    while (bridge.session.discovery.pending) timers.shift()();
    await vi.waitFor(() => expect(owner.title).toContain('Translated Current title'));
    await vi.waitFor(() => expect(owner.getAttribute('alt')).toContain('Translated Alt text'));

    expect(requests).toContain('Current title');
    expect(requests).toContain('Alt text');
    expect(requests).not.toContain('Old title');
    expect(requests).not.toContain('Removed prefix');
    expect(oldAttribute.value).toBe('Old title');
    bridge.restore(document.body);
    expect(currentAttribute.value).toBe('Current title');
  });

  it('preserves both callbacks when a direct lazy primitive admission overlaps the window', async () => {
    const PreviousIntersectionObserver = globalThis.IntersectionObserver;
    const observers = [];
    globalThis.IntersectionObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.observe = vi.fn();
        this.unobserve = vi.fn();
        this.disconnect = vi.fn();
        observers.push(this);
      }
    };
    try {
      const Bridge = await loadBridge(true, true);
      bridge = new Bridge();
      const owner = makeElement(document.body, 'p', 'Lazy overlap');
      vi.spyOn(owner, 'getBoundingClientRect').mockReturnValue({
        top: 10, left: 10, right: 100, bottom: 40, width: 90, height: 30,
      });
      const timers = [];
      vi.spyOn(bridge, 'trackTimeout').mockImplementation(callback => {
        timers.push(callback);
        return timers.length;
      });
      const requests = [];
      const callbackA = vi.fn();
      const callbackB = vi.fn();
      await bridge.initialize({ ...settings, lazyLoading: true }, text => {
        requests.push(text);
        return Promise.resolve(accepted(text));
      });
      bridge.translate(document.body);
      bridge.session.domTranslator.translate(document.body, callbackA);
      while (!observers[0].observe.mock.calls.some(([target]) => target === owner)) timers.shift()();

      bridge.session.domTranslator.translate(owner.firstChild, callbackB);
      bridge.session.domTranslator.translate(owner.firstChild, callbackB);
      observers[0].callback([{ target: owner, isIntersecting: true }], observers[0]);
      await vi.waitFor(() => expect(requests).toEqual(['Lazy overlap']));
      await vi.waitFor(() => expect(owner.textContent).toContain('Translated Lazy overlap'));

      expect([callbackA.mock.calls.length, callbackB.mock.calls.length]).toEqual([1, 1]);
    } finally {
      if (PreviousIntersectionObserver) globalThis.IntersectionObserver = PreviousIntersectionObserver;
      else delete globalThis.IntersectionObserver;
    }
  });

  it('preserves a callback added by a direct primitive admission while the window provider is pending', async () => {
    const Bridge = await loadBridge(true, true);
    bridge = new Bridge();
    const owner = makeElement(document.body, 'p', 'Pending callback');
    vi.spyOn(owner, 'getBoundingClientRect').mockReturnValue({
      top: 10, left: 10, right: 100, bottom: 40, width: 90, height: 30,
    });
    const timers = [];
    vi.spyOn(bridge, 'trackTimeout').mockImplementation(callback => {
      timers.push(callback);
      return timers.length;
    });
    let settleProvider;
    const callbackA = vi.fn();
    const callbackB = vi.fn();
    await bridge.initialize(settings, () => new Promise(resolve => { settleProvider = resolve; }));
    bridge.translate(document.body);
    bridge.session.domTranslator.translate(document.body, callbackA);
    while (!settleProvider) timers.shift()();

    bridge.session.domTranslator.translate(owner.firstChild, callbackB);
    settleProvider(accepted('Pending callback'));
    await vi.waitFor(() => expect(callbackA).toHaveBeenCalledOnce());

    expect(callbackB).toHaveBeenCalledOnce();
  });

  it('uses the live task callback group when a root coalesces after provider start', async () => {
    const Bridge = await loadBridge(true, true);
    bridge = new Bridge();
    const first = makeElement(document.body, 'p', 'Pending first');
    for (let index = 0; index < 60; index++) makeElement(document.body, 'p', `Later ${index}`);
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue({
      top: 10, left: 10, right: 100, bottom: 40, width: 90, height: 30,
    });
    const timers = [];
    vi.spyOn(bridge, 'trackTimeout').mockImplementation(callback => {
      timers.push(callback);
      return timers.length;
    });
    let resolveFirst;
    const callbackBefore = vi.fn();
    const callbackDuring = vi.fn();
    await bridge.initialize({ ...settings, attributesToTranslate: [] }, text => {
      if (text === 'Pending first') return new Promise(resolve => { resolveFirst = resolve; });
      return Promise.resolve(accepted(text));
    });
    bridge.translate(document.body);
    bridge.session.domTranslator.translate(document.body, callbackBefore);
    while (!resolveFirst) timers.shift()();

    bridge.session.domTranslator.translate(document.body, callbackDuring);
    resolveFirst(accepted('Pending first'));
    await vi.waitFor(() => expect(callbackBefore).toHaveBeenCalledWith(first.firstChild));

    expect(callbackDuring).toHaveBeenCalledOnce();
    expect(callbackDuring).toHaveBeenCalledWith(first.firstChild);
  });

  it('suppresses same-source failures, but admits a changed update generation', async () => {
    const Bridge = await loadBridge(true, true);
    bridge = new Bridge();
    const owner = makeElement(document.body, 'p', 'Initial failure');
    const requests = [];
    const failed = text => ({
      __pageTranslationSettlement: true,
      text,
      state: 'failed',
      settle: vi.fn(),
    });
    const translate = vi.fn(text => {
      requests.push(text);
      return Promise.resolve(text === 'Initial failure' ? failed(text) : accepted(text));
    });
    await bridge.initialize(settings, translate);
    bridge.translate(document.body);
    await vi.waitFor(() => expect(bridge.session.nodesTranslator.nodeStorage.get(owner.firstChild)
      ?.pageTranslationFailure?.sourceValue).toBe('Initial failure'));
    bridge.session.domTranslator.translate(owner.firstChild);
    await Promise.resolve();

    expect(requests).toEqual(['Initial failure']);
    owner.firstChild.nodeValue = 'Changed after failure';
    bridge.session.domTranslator.update(owner.firstChild);
    await vi.waitFor(() => expect(owner.textContent).toContain('Translated Changed after failure'));
    expect(requests).toEqual(['Initial failure', 'Changed after failure']);
  });

  it('marks failure against the attempted source when the DOM was edited before settlement', async () => {
    const Bridge = await loadBridge(true, true);
    bridge = new Bridge();
    const owner = makeElement(document.body, 'p', 'Attempt A');
    const timers = [];
    vi.spyOn(bridge, 'trackTimeout').mockImplementation(callback => {
      timers.push(callback);
      return timers.length;
    });
    let failAttemptA;
    const requests = [];
    const failed = text => ({
      __pageTranslationSettlement: true,
      text,
      state: 'failed',
      settle: vi.fn(),
    });
    await bridge.initialize(settings, text => {
      requests.push(text);
      if (text === 'Attempt A') return new Promise(resolve => { failAttemptA = resolve; });
      return Promise.resolve(accepted(text));
    });
    bridge.translate(document.body);
    const node = owner.firstChild;
    while (!failAttemptA) timers.shift()();

    node.nodeValue = 'Edited B';
    failAttemptA(failed('Attempt A'));
    await vi.waitFor(() => expect(bridge.session.nodesTranslator.nodeStorage.get(node)
      ?.pageTranslationFailure?.sourceValue).toBe('Attempt A'));
    bridge.session.domTranslator.update(node);
    await vi.waitFor(() => expect(owner.textContent).toContain('Translated Edited B'));

    expect(requests).toEqual(['Attempt A', 'Edited B']);
    expect(bridge.session.nodesTranslator.nodeStorage.get(node).pageTranslationFailure).toBeUndefined();
  });

  it('does not retry a failed update over an older accepted translation', async () => {
    const Bridge = await loadBridge(true, true);
    bridge = new Bridge();
    const owner = makeElement(document.body, 'p', 'Accepted source');
    const requests = [];
    const failed = text => ({
      __pageTranslationSettlement: true,
      text,
      state: 'failed',
      settle: vi.fn(),
    });
    const translate = vi.fn(text => {
      requests.push(text);
      return Promise.resolve(text === 'Failed update' ? failed(text) : accepted(text));
    });
    await bridge.initialize(settings, translate);
    bridge.translate(document.body);
    await vi.waitFor(() => expect(owner.textContent).toContain('Translated Accepted source'));
    owner.firstChild.nodeValue = 'Failed update';
    bridge.session.domTranslator.update(owner.firstChild);
    await vi.waitFor(() => expect(bridge.session.nodesTranslator.nodeStorage.get(owner.firstChild)
      ?.pageTranslationFailure?.sourceValue).toBe('Failed update'));
    bridge.session.domTranslator.translate(owner.firstChild);
    await Promise.resolve();

    expect(requests).toEqual(['Accepted source', 'Failed update']);
    expect(owner.textContent).toBe('Failed update');
    const nodeData = bridge.session.nodesTranslator.nodeStorage.get(owner.firstChild);
    expect(nodeData.acceptedTranslation.text).toContain('Translated Accepted source');
    expect(nodeData.acceptedTranslation.updateId).toBeLessThan(nodeData.updateId);
  });

  it('records rejected provider source identity and retains the rejection', async () => {
    const Bridge = await loadBridge(true, true);
    bridge = new Bridge();
    const owner = makeElement(document.body, 'p', 'Rejected source');
    const rejection = new Error('provider rejected');
    const requests = [];
    await bridge.initialize(settings, text => {
      requests.push(text);
      return Promise.reject(rejection);
    });
    const translator = bridge.session.nodesTranslator;
    const translateNodeContent = translator.translateNodeContent;
    let providerResult;
    vi.spyOn(translator, 'translateNodeContent').mockImplementation(function translateWithObservedRejection(node, callback) {
      providerResult = translateNodeContent.call(this, node, callback);
      providerResult.catch(() => {});
      return providerResult;
    });
    bridge.translate(document.body);
    await vi.waitFor(() => expect(providerResult).toBeDefined());
    await expect(providerResult).rejects.toBe(rejection);
    await vi.waitFor(() => expect(translator.nodeStorage.get(owner.firstChild)
      ?.pageTranslationFailure?.sourceValue).toBe('Rejected source'));
    bridge.session.domTranslator.translate(owner.firstChild);

    expect(requests).toEqual(['Rejected source']);
  });

  it('keeps equal text on distinct primitives as separate translation actions', async () => {
    const Bridge = await loadBridge(true, true);
    bridge = new Bridge();
    const first = makeElement(document.body, 'p', 'Same text', { title: 'Same title' });
    const second = makeElement(document.body, 'p', 'Same text', { title: 'Same title' });
    const calls = [];
    await bridge.initialize(settings, (text, _context, _score, node) => {
      calls.push({ text, node });
      return Promise.resolve(accepted(text));
    });
    bridge.translate(document.body);
    await vi.waitFor(() => expect(calls).toHaveLength(4));

    expect(calls.filter(({ text }) => text === 'Same text').map(({ node }) => node))
      .toEqual([first.firstChild, second.firstChild]);
    expect(calls.filter(({ text }) => text === 'Same title').map(({ node }) => node.ownerElement))
      .toEqual([first, second]);
  });

  it('keeps discovery pending through window reorder and canonical completion', async () => {
    const Bridge = await loadBridge(true, true);
    bridge = new Bridge();
    for (let index = 0; index < 60; index++) {
      makeElement(document.body, 'p', `Window ${index}`, { title: `Window title ${index}` });
    }
    const timers = [];
    vi.spyOn(bridge, 'trackTimeout').mockImplementation(callback => {
      timers.push(callback);
      return timers.length;
    });
    const states = [];
    await bridge.initialize(settings, text => Promise.resolve(accepted(text)), null, {
      onDiscoveryStateChange: pending => states.push(pending),
    });
    bridge.translate(document.body);
    const task = bridge.session.discovery.queue[0];
    while (task.viewportWindow) timers.shift()();

    expect(states).toEqual([true]);
    expect(bridge.session.discovery.pending).toBe(true);
    while (bridge.session.discovery.pending) timers.shift()();
    expect(states).toEqual([true, false]);
  });

  it.each(['geometry', 'partition', 'admit'])(
    'tombstones a retired window candidate during %s without shifting a sibling', async (phase) => {
      const Bridge = await loadBridge(true, true);
      bridge = new Bridge();
      const removed = makeElement(document.body, 'section', '');
      makeElement(removed, 'p', 'Retired candidate');
      const retained = makeElement(document.body, 'p', 'Unaffected candidate');
      const timers = [];
      vi.spyOn(bridge, 'trackTimeout').mockImplementation(callback => {
        timers.push(callback);
        return timers.length;
      });
      const requests = [];
      await bridge.initialize({ ...settings, attributesToTranslate: [] }, text => {
        requests.push(text);
        return Promise.resolve(accepted(text));
      });
      bridge.translate(document.body);
      const task = bridge.session.discovery.queue[0];
      while (task.viewportWindow?.phase !== phase) timers.shift()();

      removed.remove();
      bridge.session.cancelDiscoveryUnder(removed);
      while (bridge.session.discovery.pending) timers.shift()();
      await vi.waitFor(() => expect(retained.textContent).toContain('Translated Unaffected candidate'));

      expect(requests).not.toContain('Retired candidate');
      expect(requests.filter(text => text === 'Unaffected candidate')).toHaveLength(1);
    }
  );

  it('visits only configured attributes instead of copying a large live attribute collection', async () => {
    const Bridge = await loadBridge(true, true);
    bridge = new Bridge();
    const owner = makeElement(document.body, 'p', 'Many attributes', { title: 'Sample title' });
    for (let index = 0; index < 300; index++) owner.setAttribute(`data-crowded-${index}`, `${index}`);
    const nativeAttributes = Array.from(owner.attributes);
    let enumeratedAttributes = 0;
    Object.defineProperty(owner, 'attributes', {
      configurable: true,
      get: () => new Proxy({ length: nativeAttributes.length }, {
        get(target, property, receiver) {
          if (property === 'length') return nativeAttributes.length;
          const index = Number(property);
          if (Number.isInteger(index) && index >= 0 && index < nativeAttributes.length) {
            enumeratedAttributes++;
            return nativeAttributes[index];
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    });
    vi.spyOn(owner, 'getBoundingClientRect').mockReturnValue({
      top: 10, left: 10, right: 100, bottom: 40, width: 90, height: 30,
    });
    const timers = [];
    vi.spyOn(bridge, 'trackTimeout').mockImplementation(callback => {
      timers.push(callback);
      return timers.length;
    });
    await bridge.initialize(settings, text => Promise.resolve(accepted(text)));
    bridge.translate(document.body);
    while (bridge.session.discovery.pending) timers.shift()();
    await vi.waitFor(() => expect(owner.title).toContain('Translated Sample title'));

    expect(enumeratedAttributes).toBe(0);
  });

  it('caps the reorder window at 100 canonical enumeration steps', async () => {
    const Bridge = await loadBridge(true, true, { sliceSteps: 20, windowEnumeration: 100 });
    bridge = new Bridge();
    for (let index = 0; index < 80; index++) makeElement(document.body, 'p', `Enumeration ${index}`);
    const timers = [];
    vi.spyOn(bridge, 'trackTimeout').mockImplementation(callback => {
      timers.push(callback);
      return timers.length;
    });
    await bridge.initialize({ ...settings, attributesToTranslate: [] }, vi.fn());
    bridge.translate(document.body);
    const task = bridge.session.discovery.queue[0];
    while (task.viewportWindow?.phase === 'collect') timers.shift()();

    expect(task.viewportWindow.enumerationSteps).toBe(100);
    expect(task.viewportWindow.candidates.length).toBeLessThanOrEqual(100);
    bridge.cleanup();
  });

  it('caps candidates and geometry work, and yields after the slice time budget', async () => {
    const Bridge = await loadBridge(true, true, {
      sliceSteps: 100,
      sliceBudget: 8,
      windowEnumeration: 400,
      windowCandidates: 100,
      geometryChecks: 100,
    });
    bridge = new Bridge();
    const owners = [];
    for (let index = 0; index < 130; index++) {
      owners.push(makeElement(document.body, 'p', `Geometry ${index}`));
    }
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const geometry = owners.map(owner => vi.spyOn(owner, 'getBoundingClientRect').mockImplementation(() => {
      clock += 8;
      return { top: 1, left: 1, right: 10, bottom: 10, width: 9, height: 9 };
    }));
    const timers = [];
    vi.spyOn(bridge, 'trackTimeout').mockImplementation(callback => {
      timers.push(callback);
      return timers.length;
    });
    await bridge.initialize({ ...settings, attributesToTranslate: [] }, vi.fn());
    bridge.translate(document.body);
    const task = bridge.session.discovery.queue[0];
    while (task.viewportWindow?.phase === 'collect') timers.shift()();
    while (task.viewportWindow?.phase === 'geometry' && task.viewportWindow.geometryIndex < 100) {
      const before = task.viewportWindow.geometryIndex;
      timers.shift()();
      expect(task.viewportWindow.geometryIndex - before).toBeLessThanOrEqual(1);
    }

    expect(task.viewportWindow.candidates).toHaveLength(100);
    expect(task.viewportWindow.geometryIndex).toBe(100);
    expect(geometry.reduce((total, spy) => total + spy.mock.calls.length, 0)).toBe(100);
    bridge.cleanup();
  });

  it('still filters excluded and editable targets during viewport reorder and canonical discovery', async () => {
    const Bridge = await loadBridge(true, true);
    bridge = new Bridge();
    const excluded = makeElement(document.body, 'p', 'Excluded viewport', { class: 'blocked', title: 'Excluded title' });
    const editable = makeElement(document.body, 'p', 'Editable viewport', { contenteditable: 'true' });
    const visible = makeElement(document.body, 'p', 'Eligible viewport');
    vi.spyOn(visible, 'getBoundingClientRect').mockReturnValue({
      top: 10, left: 10, right: 100, bottom: 40, width: 90, height: 30,
    });
    const requests = [];
    await bridge.initialize({ ...settings, excludedSelectors: ['.blocked'] }, text => {
      requests.push(text);
      return Promise.resolve(accepted(text));
    });
    bridge.translate(document.body);
    await vi.waitFor(() => expect(visible.textContent).toContain('Translated Eligible viewport'));

    expect(requests).toContain('Eligible viewport');
    expect(requests).not.toContain('Excluded viewport');
    expect(requests).not.toContain('Excluded title');
    expect(requests).not.toContain('Editable viewport');
    expect(excluded.textContent).toBe('Excluded viewport');
    expect(editable.textContent).toBe('Editable viewport');
  });

  it.each(['stop', 'restore', 'cleanup', 'replacement', 'url'])(
    'releases buffered priority state when a pending session ends through %s', async (ending) => {
      const PreviousIntersectionObserver = globalThis.IntersectionObserver;
      const observers = [];
      globalThis.IntersectionObserver = class {
        constructor(callback) {
          this.callback = callback;
          this.observe = vi.fn();
          this.unobserve = vi.fn();
          this.disconnect = vi.fn();
          observers.push(this);
        }
      };
      const originalUrl = window.location.href;
      try {
        const Bridge = await loadBridge(true, true);
        bridge = new Bridge();
        const owner = makeElement(document.body, 'p', `Pending ${ending}`);
        for (let index = 0; index < 60; index++) {
          makeElement(document.body, 'p', `Offscreen ${index}`);
        }
        vi.spyOn(owner, 'getBoundingClientRect').mockReturnValue({
          top: 10, left: 10, right: 100, bottom: 40, width: 90, height: 30,
        });
        const timers = [];
        vi.spyOn(bridge, 'trackTimeout').mockImplementation(callback => {
          timers.push(callback);
          return timers.length;
        });
        const states = [];
        const translate = vi.fn();
        const callbackA = vi.fn();
        await bridge.initialize({ ...settings, attributesToTranslate: [], lazyLoading: true }, translate, null, {
          onDiscoveryStateChange: pending => states.push(pending),
        });
        bridge.translate(document.body);
        bridge.session.domTranslator.translate(document.body, callbackA);
        const oldDiscovery = bridge.session.discovery;
        const oldSession = bridge.session;
        const oldTask = oldDiscovery.queue[0];
        while (!observers[0].observe.mock.calls.some(([target]) => target === owner)) timers.shift()();
        expect(oldDiscovery.pending).toBe(true);
        const ioRecord = oldSession.intersectionScheduler.intersectionObserver
          .nodeCallbacksMap.get(owner.firstChild).pageTranslationAdmission;

        if (ending === 'stop') bridge.stopPersistence();
        else if (ending === 'restore') bridge.restore(document.body);
        else if (ending === 'cleanup') bridge.cleanup();
        else if (ending === 'replacement') await bridge.initialize(settings, vi.fn());
        else {
          window.history.replaceState({}, '', '/viewport-window-route-change');
          timers.shift()();
        }

        observers[0].callback([{ target: owner, isIntersecting: true }], observers[0]);
        await Promise.resolve();

        expect(oldDiscovery.queue).toHaveLength(0);
        expect(oldTask.viewportWindow).toBeNull();
        expect(oldDiscovery.pending).toBe(false);
        expect(states).toEqual([true, false]);
        expect(oldSession.admissionDisposers.size).toBe(0);
        expect(ioRecord.callbackGroups.size).toBe(0);
        expect(ioRecord.directCallbacks.size).toBe(0);
        expect(translate).not.toHaveBeenCalled();
        expect(callbackA).not.toHaveBeenCalled();
      } finally {
        window.history.replaceState(null, '', originalUrl);
        if (PreviousIntersectionObserver) globalThis.IntersectionObserver = PreviousIntersectionObserver;
        else delete globalThis.IntersectionObserver;
      }
    }
  );

  it('disposes direct callback payloads for a pending provider without deleting restore storage', async () => {
    const Bridge = await loadBridge(true, true);
    bridge = new Bridge();
    const owner = makeElement(document.body, 'p', 'Pending provider cleanup');
    let resolveProvider;
    const callback = vi.fn();
    await bridge.initialize(settings, () => new Promise(resolve => { resolveProvider = resolve; }));
    bridge.translate(document.body);
    bridge.session.domTranslator.translate(owner.firstChild, callback);
    await vi.waitFor(() => expect(resolveProvider).toBeDefined());
    const session = bridge.session;
    const nodeData = session.nodesTranslator.nodeStorage.get(owner.firstChild);
    const admission = nodeData.pageTranslationAdmission;
    expect(admission.directCallbacks.size).toBe(1);

    bridge.stopPersistence();

    expect(session.admissionDisposers.size).toBe(0);
    expect(session.nodesTranslator.nodeStorage.get(owner.firstChild)).toBe(nodeData);
    expect(nodeData.pageTranslationAdmission).toBeUndefined();
    expect(admission.directCallbacks.size).toBe(0);
    resolveProvider(accepted('Pending provider cleanup'));
    await Promise.resolve();
    await Promise.resolve();
    expect(owner.textContent).toBe('Pending provider cleanup');
    expect(callback).not.toHaveBeenCalled();
  });
});
