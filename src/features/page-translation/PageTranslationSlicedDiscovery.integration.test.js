import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  attributesToTranslate: ['title'],
};

const loadBridge = async (sliced) => {
  vi.resetModules();
  vi.doMock('./PageTranslationConstants.js', async () => ({
    ...await vi.importActual('./PageTranslationConstants.js'),
    PAGE_TRANSLATION_SLICED_DISCOVERY: sliced,
    PAGE_TRANSLATION_DISCOVERY_SLICE_MAX_STEPS: 1,
    PAGE_TRANSLATION_DISCOVERY_SLICE_BUDGET_MS: 1000,
  }));
  return (await import('./PageTranslationBridge.js')).PageTranslationBridge;
};

const appendElement = (parent, tagName, text = '', attributes = {}) => {
  const element = document.createElement(tagName);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  if (text) element.textContent = text;
  parent.appendChild(element);
  return element;
};

const setBody = (...elements) => document.body.replaceChildren(...elements);

const acceptedTranslation = (text) => ({
  __pageTranslationSettlement: true,
  text: `Translated ${text}`,
  state: 'pending',
  settle(outcome) { this.state = outcome; },
});

describe('Page Translation sliced discovery integration', () => {
  let bridge;
  let PageTranslationBridgeClass;

  beforeEach(async () => {
    PageTranslationBridgeClass = await loadBridge(true);
  });

  afterEach(() => {
    bridge?.cleanup();
    bridge = null;
    vi.restoreAllMocks();
    vi.doUnmock('./PageTranslationConstants.js');
      document.body.replaceChildren();
  });

  const start = async (translate = (text) => Promise.resolve(acceptedTranslation(text)), options = {}) => {
    bridge = new PageTranslationBridgeClass();
    await bridge.initialize({ ...settings, ...options.settings }, translate, options.context, options.callbacks);
    bridge.translate(document.body);
  };

  const bridgeGroupSize = () => bridge.memoryManager.groups.get('page-translation-bridge')?.size ?? 0;

  // Starts discovery and returns while a slice timer is still pending, so
  // cleanup assertions observe a real registered timer.
  const startWithPendingTimer = async (count = 40) => {
    const fixture = document.createDocumentFragment();
    for (let index = 0; index < count; index++) appendElement(fixture, 'p', `Text ${index}`, { title: `Title ${index}` });
    setBody(...Array.from(fixture.childNodes));
    bridge = new PageTranslationBridgeClass();
    await bridge.initialize(settings, (text) => Promise.resolve(acceptedTranslation(text)));
    bridge.translate(document.body);
  };

  // Runs the queued scheduled callbacks one at a time until the expected number
  // of primitives has been admitted, with a bounded iteration guard.
  const advanceToAdmissions = async (seen, scheduledSlices, target) => {
    for (let step = 0; step < 20 && seen.length < target; step++) {
      const next = scheduledSlices.shift();
      // No scheduled slice left means the walk ended before the target.
      if (!next) return;
      next();
      const admitted = seen.length;
      for (let attempt = 0; attempt < 10 && seen.length === admitted; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  };

  it('discovers eligible text, attributes, controls, and nested open shadow roots in slices', async () => {
    const fixture = document.createDocumentFragment();
    appendElement(fixture, 'p', 'First text', { title: 'First title' });
    appendElement(fixture, 'button', 'Button text', { title: 'Button title' });
    appendElement(fixture, 'p', 'Excluded text', { class: 'excluded', title: 'Excluded title' });
    appendElement(fixture, 'p', 'Editable text', { contenteditable: 'true', title: 'Editable title' });
    const shadowHost = appendElement(fixture, 'div', '', { id: 'host' });
    setBody(...Array.from(fixture.childNodes));
    const shadow = shadowHost.attachShadow({ mode: 'open' });
    shadow.appendChild(document.createTextNode('Direct shadow-root text'));
    appendElement(shadow, 'span', 'Shadow text', { title: 'Shadow title' });
    const nestedHost = appendElement(shadow, 'div');
    const nestedShadow = nestedHost.attachShadow({ mode: 'open' });
    appendElement(nestedShadow, 'span', 'Nested text', { title: 'Nested title' });
    const seen = [];
    const states = [];
    await start((text, _context, _score, node) => {
      seen.push({ text, node });
      return Promise.resolve(acceptedTranslation(text));
    }, {
      settings: { excludedSelectors: ['.excluded'] },
      callbacks: { onDiscoveryStateChange: pending => states.push(pending) },
    });

    await vi.waitFor(() => expect(states).toEqual([true, false]));
    expect(seen.map(({ node }) => node?.nodeType)).toEqual([2, 3, 2, 3, 2, 2, 3, 2, 3]);
    await vi.waitFor(() => expect(shadow.querySelector('span').textContent).toContain('Translated Shadow text'));
    await vi.waitFor(() => expect(nestedShadow.querySelector('span').textContent).toContain('Translated Nested text'));

    expect(seen.map(({ text }) => text)).toEqual([
      'First title', 'First text', 'Button title', 'Button text',
      'Editable title', 'Shadow title', 'Shadow text', 'Nested title', 'Nested text',
    ]);
    expect(seen[2].node.ownerElement.tagName).toBe('BUTTON');
    expect(document.querySelector('.excluded').textContent).toBe('Excluded text');
    expect(document.querySelector('[contenteditable]').textContent).toBe('Editable text');
    expect(shadow.querySelector('span').textContent).toContain('Translated Shadow text');
    expect(nestedShadow.querySelector('span').textContent).toContain('Translated Nested text');
    expect(shadow.firstChild.nodeValue).toBe('Direct shadow-root text');
  });

  it('matches the actual legacy traversal on the same fixture, including target identities and restore', async () => {
    const fixture = document.createDocumentFragment();
    const paragraph = appendElement(fixture, 'p', 'First text', { title: 'First title' });
    const button = appendElement(fixture, 'button', 'Button text', { title: 'Button title' });
    const excluded = appendElement(fixture, 'p', 'Excluded text', { class: 'excluded', title: 'Excluded title' });
    const editable = appendElement(fixture, 'p', 'Editable text', { contenteditable: 'true', title: 'Editable title' });
    const host = appendElement(fixture, 'div');
    setBody(...Array.from(fixture.childNodes));
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(document.createTextNode('Direct shadow-root text'));
    const shadowNode = appendElement(shadow, 'span', 'Shadow text', { title: 'Shadow title' });
    const nestedHost = appendElement(shadow, 'div');
    const nestedShadow = nestedHost.attachShadow({ mode: 'open' });
    const nestedNode = appendElement(nestedShadow, 'span', 'Nested text', { title: 'Nested title' });
    const targetNodes = [
      paragraph.getAttributeNode('title'), paragraph.firstChild,
      button.getAttributeNode('title'), button.firstChild,
      editable.getAttributeNode('title'), shadowNode.getAttributeNode('title'), shadowNode.firstChild,
      nestedNode.getAttributeNode('title'), nestedNode.firstChild,
    ];
    const snapshot = () => [
      paragraph.title, paragraph.textContent, button.title, button.textContent,
      excluded.title, excluded.textContent, editable.title, editable.textContent,
      shadow.textContent, shadowNode.title, nestedShadow.textContent, nestedNode.title,
    ];
    const originalState = snapshot();

    const run = async (sliced) => {
      const Bridge = await loadBridge(sliced);
      bridge = new Bridge();
      const calls = [];
      await bridge.initialize({ ...settings, excludedSelectors: ['.excluded'] }, (text, _context, _score, node) => {
        calls.push({ text, node });
        return Promise.resolve(acceptedTranslation(text));
      });
      bridge.translate(document.body);
      await vi.waitFor(() => expect(calls).toHaveLength(targetNodes.length));
      await vi.waitFor(() => expect(calls.every(({ node, text }) => {
        const value = node.nodeType === Node.ATTRIBUTE_NODE ? node.value : node.nodeValue;
        return value.includes(`Translated ${text}`);
      })).toBe(true));
      const finalState = snapshot();
      bridge.restore(document.body);
      const restoredState = snapshot();
      return { calls, finalState, restoredState };
    };

    const legacy = await run(false);
    legacy.calls.forEach(({ node }, index) => expect(node).toBe(targetNodes[index]));
    expect(legacy.restoredState).toEqual(originalState);
    const sliced = await run(true);

    sliced.calls.forEach(({ node }, index) => expect(node).toBe(legacy.calls[index].node));
    expect(sliced.calls.map(({ text }) => text)).toEqual(legacy.calls.map(({ text }) => text));
    expect(sliced.finalState).toEqual(legacy.finalState);
    expect(sliced.restoredState).toEqual(legacy.restoredState);
  });

  it('starts initial work synchronously, lets provider settlement overlap later slices, and drains once', async () => {
    setBody(appendElement(document.createDocumentFragment(), 'p', 'First'));
    appendElement(document.body, 'p', 'Second');
    appendElement(document.body, 'p', 'Third');
    const pending = [];
    const states = [];
    const translate = vi.fn((text, _context, _score, node) => new Promise(resolve => {
      pending.push({ text, node, resolve });
      if (pending.length > 1) queueMicrotask(() => resolve(acceptedTranslation(text)));
    }));
    await start(translate, { callbacks: { onDiscoveryStateChange: value => states.push(value) } });

    expect(states[0]).toBe(true);
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    pending[0].resolve(acceptedTranslation(pending[0].text));
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(1));
    await vi.waitFor(() => expect(states).toEqual([true, false]));
    await vi.waitFor(() => expect(document.body.textContent).toContain('Translated First'));

    expect(document.body.textContent).toContain('Translated First');
    expect(document.body.textContent).toContain('Translated Third');
    expect(states.filter(value => value === false)).toHaveLength(1);
  });

  it('cancels queued discovery before restore', async () => {
    setBody(appendElement(document.createDocumentFragment(), 'p', 'First'));
    appendElement(document.body, 'p', 'Never admitted');
    const pending = [];
    const states = [];
    const translate = vi.fn((text, _context, _score, node) => new Promise(resolve => {
      pending.push({ text, node, resolve });
    }));
    await start(translate, { callbacks: { onDiscoveryStateChange: value => states.push(value) } });

    bridge.restore(document.body);
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(document.body.textContent).toBe('FirstNever admitted');
    expect(translate).not.toHaveBeenCalled();
    expect(states).toEqual([true, false]);
  });

  it('cancels queued admission when persistence stops', async () => {
    setBody(appendElement(document.createDocumentFragment(), 'p', 'Never admitted'));
    const states = [];
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    await start(translate, { callbacks: { onDiscoveryStateChange: pending => states.push(pending) } });

    bridge.stopPersistence();
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(translate).not.toHaveBeenCalled();
    expect(states).toEqual([true, false]);
    expect(document.body.textContent).toBe('Never admitted');
  });

  it('retires queued dynamic-subtree discovery when that subtree is removed', async () => {
    setBody(appendElement(document.createDocumentFragment(), 'p', 'Initial'));
    const states = [];
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    await start(translate, {
      settings: { autoTranslateOnDOMChanges: true },
      callbacks: { onDiscoveryStateChange: pending => states.push(pending) },
    });
    await vi.waitFor(() => expect(states).toEqual([true, false]));
    await vi.waitFor(() => expect(document.querySelector('p').textContent).toContain('Translated Initial'));
    translate.mockClear();
    vi.useFakeTimers();
    try {
      const dynamic = document.createElement('div');
      dynamic.textContent = 'Retired before admission';
      document.body.appendChild(dynamic);
      await Promise.resolve();
      await Promise.resolve();
      expect(states).toEqual([true, false, true]);

      dynamic.remove();
      await Promise.resolve();
      await Promise.resolve();

      expect(states).toEqual([true, false, true, false]);
      await vi.runOnlyPendingTimersAsync();
      expect(translate.mock.calls.map(([text]) => text)).toEqual([]);
      expect(dynamic.textContent).toBe('Retired before admission');
    } finally {
      vi.useRealTimers();
    }
  });

  it('revalidates candidates removed between slices while continuing owned discovery', async () => {
    const removed = appendElement(document.createDocumentFragment(), 'p', 'Retired text', { id: 'removed' });
    const owned = appendElement(document.createDocumentFragment(), 'p', 'Owned text');
    setBody(removed, owned);
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    await start(translate);

    removed.remove();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Translated Owned text'));

    expect(translate.mock.calls.map(([text]) => text)).toEqual(['Owned text']);
    expect(removed.textContent).toBe('Retired text');
  });

  it('prevents a provider result from writing after restoring its accepted pending target', async () => {
    const owner = appendElement(document.createDocumentFragment(), 'p', 'Pending');
    setBody(owner);
    const node = owner.firstChild;
    const pending = [];
    bridge = new PageTranslationBridgeClass();
    await bridge.initialize(settings, text => new Promise(resolve => pending.push({ text, resolve })));
    bridge.translate(document.body);
    await vi.waitFor(() => expect(pending).toHaveLength(1));

    bridge.restore(document.body);
    pending[0].resolve(acceptedTranslation('Late translation'));
    await Promise.resolve();
    await Promise.resolve();

    expect(node.nodeValue).toBe('Pending');
  });

  it('keeps discovery responsive to persistent light-DOM and shadow mutations without self-retranslation', async () => {
    const host = appendElement(document.createDocumentFragment(), 'div', '', { id: 'host' });
    setBody(appendElement(document.createDocumentFragment(), 'p', 'Initial'), host);
    const shadow = host.attachShadow({ mode: 'open' });
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    const states = [];
    await start(translate, {
      settings: { autoTranslateOnDOMChanges: true },
      callbacks: { onDiscoveryStateChange: pending => states.push(pending) },
    });
    await vi.waitFor(() => expect(states).toEqual([true, false]));

    const addedLight = document.createElement('p');
    addedLight.textContent = 'Dynamic light';
    document.body.appendChild(addedLight);
    await vi.waitFor(() => expect(addedLight.textContent).toContain('Translated Dynamic light'));
    await vi.waitFor(() => expect(states).toEqual([true, false, true, false]));
    const addedShadow = document.createElement('span');
    addedShadow.textContent = 'Dynamic shadow';
    shadow.appendChild(addedShadow);
    await vi.waitFor(() => expect(addedShadow.textContent).toContain('Translated Dynamic shadow'));
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(translate.mock.calls.filter(([text]) => text.startsWith('Dynamic'))).toHaveLength(2);
    expect(states).toEqual([true, false, true, false, true, false]);
  });

  it('admits newly added light and shadow attributes during initial discovery and after drain', async () => {
    const paragraph = appendElement(document.createDocumentFragment(), 'p', 'Light text');
    const host = appendElement(document.createDocumentFragment(), 'div');
    setBody(paragraph, host);
    const shadow = host.attachShadow({ mode: 'open' });
    const shadowOwner = appendElement(shadow, 'span', 'Shadow text');
    const translated = [];
    const translate = vi.fn((text, _context, _score, node) => {
      translated.push({ text, node });
      return Promise.resolve(acceptedTranslation(text));
    });
    await start(translate, { settings: { autoTranslateOnDOMChanges: true } });

    paragraph.setAttribute('title', 'Light during initial scan');
    shadowOwner.setAttribute('title', 'Shadow during initial scan');
    await vi.waitFor(() => expect(paragraph.title).toContain('Translated Light during initial scan'));
    await vi.waitFor(() => expect(shadowOwner.title).toContain('Translated Shadow during initial scan'));
    await vi.waitFor(() => expect(bridge.session.discovery.pending).toBe(false));

    paragraph.removeAttribute('title');
    paragraph.setAttribute('title', 'Light replacement after drain');
    shadowOwner.removeAttribute('title');
    shadowOwner.setAttribute('title', 'Shadow replacement after drain');
    await vi.waitFor(() => expect(paragraph.title).toContain('Translated Light replacement after drain'));
    await vi.waitFor(() => expect(shadowOwner.title).toContain('Translated Shadow replacement after drain'));
    const currentLightAttribute = paragraph.getAttributeNode('title');
    const currentShadowAttribute = shadowOwner.getAttributeNode('title');

    bridge.restore(document.body);

    expect(currentLightAttribute.value).toBe('Light replacement after drain');
    expect(currentShadowAttribute.value).toBe('Shadow replacement after drain');
    expect(translated.some(({ node }) => node === currentLightAttribute)).toBe(true);
    expect(translated.some(({ node }) => node === currentShadowAttribute)).toBe(true);
  });

  it('preserves discovery candidates when the same queued subtree is promoted to translation', async () => {
    const host = appendElement(document.createDocumentFragment(), 'div');
    setBody(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const translated = [];
    const lateResults = [];
    const translate = vi.fn((text, _context, _score, node) => {
      translated.push({ text, node });
      if (text === 'Candidate 59') return new Promise(resolve => lateResults.push(resolve));
      return Promise.resolve(acceptedTranslation(text));
    });
    await start(translate, { settings: { autoTranslateOnDOMChanges: true } });
    await vi.waitFor(() => expect(bridge.session.discovery.pending).toBe(false));

    const subtree = document.createElement('section');
    const owners = [];
    for (let index = 0; index < 60; index++) {
      owners.push(appendElement(subtree, 'p', `Candidate ${index}`, { title: `Title ${index}` }));
    }
    const timers = [];
    vi.spyOn(bridge, 'trackTimeout').mockImplementation(callback => {
      timers.push(callback);
      return timers.length;
    });
    vi.spyOn(bridge, 'clearTimer').mockImplementation(() => {});
    vi.useFakeTimers();
    const enqueueDiscovery = bridge.session.enqueueDiscovery;
    vi.spyOn(bridge.session, 'enqueueDiscovery').mockImplementation((root, callback, options) => {
      enqueueDiscovery(root, callback, options);
      if (root !== subtree || options?.translateNodes !== false) return;
      const task = bridge.session.discovery.queuedRoots.get(root);
      while (task.backlog.length === 0) timers.shift()();
    });
    document.body.appendChild(subtree);
    await Promise.resolve();
    await Promise.resolve();
    const task = bridge.session.discovery.queuedRoots.get(subtree);
    expect(task.backlog.length).toBeGreaterThan(0);
    expect(task.translateNodes).toBe(true);
    while (bridge.session.discovery.pending) timers.shift()();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await vi.waitFor(() => expect(owners[0].textContent).toContain('Translated Candidate 0'));
    await vi.waitFor(() => expect(owners.at(-1).title).toContain('Translated Title 59'));

    expect(translated).toHaveLength(owners.length * 2);
    expect(translated.filter(({ text }) => text === 'Title 0' || text === 'Candidate 0')).toHaveLength(2);
    expect(translated.filter(({ text }) => text === 'Title 59' || text === 'Candidate 59')).toHaveLength(2);
    expect(lateResults).toHaveLength(1);
    for (const owner of owners) {
      if (owner !== owners.at(-1)) expect(owner.textContent).toContain('Translated Candidate');
      expect(owner.title).toContain('Translated Title');
    }

    const later = appendElement(shadow, 'p', 'Later shadow mutation', { title: 'Later title' });
    await vi.waitFor(() => expect(later.textContent).toContain('Translated Later shadow mutation'));
    await vi.waitFor(() => expect(later.title).toContain('Translated Later title'));
    bridge.restore(document.body);

    expect(owners[0].textContent).toBe('Candidate 0');
    expect(owners[0].title).toBe('Title 0');
    expect(owners.at(-1).textContent).toBe('Candidate 59');
    expect(owners.at(-1).title).toBe('Title 59');
    expect(later.textContent).toBe('Later shadow mutation');
    expect(later.title).toBe('Later title');
    lateResults[0](acceptedTranslation('Candidate 59'));
    await Promise.resolve();
    await Promise.resolve();
    expect(owners.at(-1).textContent).toBe('Candidate 59');
  });

  it('ends sliced discovery while lazy nodes wait and rejects stale intersection callbacks', async () => {
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
      const owner = appendElement(document.createDocumentFragment(), 'p', 'Original text', { title: 'Original title' });
      const untouched = appendElement(document.createDocumentFragment(), 'p', 'Unmodified offscreen text');
      setBody(owner, untouched);
      const states = [];
      const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
      await start(translate, {
        settings: { lazyLoading: true },
        callbacks: { onDiscoveryStateChange: pending => states.push(pending) },
      });
      await vi.waitFor(() => expect(states).toEqual([true, false]));
      expect(translate).toHaveBeenCalledExactlyOnceWith('Original title', null, expect.any(Number), owner.getAttributeNode('title'));
      expect(observers[0].observe).toHaveBeenCalledWith(owner);
      expect(observers[0].observe).toHaveBeenCalledWith(untouched);

      owner.firstChild.nodeValue = 'Externally edited';
      observers[0].callback([{ target: owner, isIntersecting: true }], observers[0]);
      observers[0].callback([{ target: untouched, isIntersecting: true }], observers[0]);
      await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(untouched.textContent).toContain('Translated Unmodified offscreen text'));
      await vi.waitFor(() => expect(owner.getAttribute('title')).toContain('Translated Original title'));
      expect(owner.textContent).toBe('Externally edited');
      expect(translate.mock.calls.map(([text]) => text)).toEqual(['Original title', 'Unmodified offscreen text']);
    } finally {
      if (PreviousIntersectionObserver) globalThis.IntersectionObserver = PreviousIntersectionObserver;
      else delete globalThis.IntersectionObserver;
    }
  });

  it.each(['contenteditable', 'excluded-ancestor', 'translate-no'])(
    'rechecks current %s eligibility at a sliced lazy intersection', async (eligibility) => {
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
        const container = appendElement(document.createDocumentFragment(), 'div');
        const owner = appendElement(container, 'p', 'Initially eligible');
        setBody(container);
        const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
        await start(translate, {
          settings: { lazyLoading: true, attributesToTranslate: [], excludedSelectors: ['.blocked'] },
        });
        await vi.waitFor(() => expect(bridge.session.discovery.pending).toBe(false));

        if (eligibility === 'contenteditable') container.setAttribute('contenteditable', 'true');
        else if (eligibility === 'excluded-ancestor') container.classList.add('blocked');
        else container.setAttribute('translate', 'no');
        observers[0].callback([{ target: owner, isIntersecting: true }], observers[0]);
        await Promise.resolve();
        await Promise.resolve();

        expect(translate).not.toHaveBeenCalled();
        expect(owner.textContent).toBe('Initially eligible');
      } finally {
        if (PreviousIntersectionObserver) globalThis.IntersectionObserver = PreviousIntersectionObserver;
        else delete globalThis.IntersectionObserver;
      }
    }
  );

  it('preserves legacy offscreen admission when the default-off sliced flag is disabled', async () => {
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
      const owner = appendElement(document.createDocumentFragment(), 'p', 'Original offscreen text');
      setBody(owner);
      const LegacyBridge = await loadBridge(false);
      bridge = new LegacyBridge();
      const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
      await bridge.initialize({ ...settings, lazyLoading: true }, translate);
      expect(bridge.session.slicedDiscoveryEnabled).toBe(false);
      bridge.translate(document.body);

      owner.firstChild.nodeValue = 'Current host edit';
      observers[0].callback([{ target: owner, isIntersecting: true }], observers[0]);
      await vi.waitFor(() => expect(owner.textContent).toContain('Translated Current host edit'));

      expect(translate.mock.calls.map(([text]) => text)).toEqual(['Current host edit']);
    } finally {
      if (PreviousIntersectionObserver) globalThis.IntersectionObserver = PreviousIntersectionObserver;
      else delete globalThis.IntersectionObserver;
    }
  });

  it('cancels the old session timer when a replacement session starts', async () => {
    setBody(appendElement(document.createDocumentFragment(), 'p', 'First'));
    const oldStates = [];
    const oldTranslate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    bridge = new PageTranslationBridgeClass();
    await bridge.initialize(settings, oldTranslate, 'old', {
      onDiscoveryStateChange: pending => oldStates.push(pending),
    });
    bridge.translate(document.body);
    expect(oldStates).toEqual([true]);

    const newStates = [];
    const newTranslate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    await bridge.initialize(settings, newTranslate, 'new', {
      onDiscoveryStateChange: pending => newStates.push(pending),
    });
    bridge.translate(document.body);
    await vi.waitFor(() => expect(newStates).toEqual([true, false]));
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(oldStates).toEqual([true, false]);
    expect(oldTranslate).not.toHaveBeenCalled();
    expect(newTranslate).toHaveBeenCalledOnce();
  });

  it('invalidates all old discovery on URL mismatch before another cursor step or shadow registration', async () => {
    const originalUrl = window.location.href;
    const host = appendElement(document.createDocumentFragment(), 'div');
    setBody(host);
    const shadow = host.attachShadow({ mode: 'open' });
    appendElement(shadow, 'span', 'Old route text');
    const states = [];
    const translate = vi.fn((text) => Promise.resolve(acceptedTranslation(text)));
    const nativeCreateNodeIterator = document.createNodeIterator.bind(document);
    const iteratorSteps = [];
    vi.spyOn(document, 'createNodeIterator').mockImplementation((...args) => {
      const iterator = nativeCreateNodeIterator(...args);
      return {
        nextNode: () => {
          iteratorSteps.push(true);
          return iterator.nextNode();
        },
      };
    });
    try {
      await start(translate, {
        settings: { autoTranslateOnDOMChanges: true },
        callbacks: { onDiscoveryStateChange: pending => states.push(pending) },
      });
      expect(iteratorSteps).toHaveLength(1);
      window.history.replaceState({}, '', '/sliced-discovery-other-route');
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(iteratorSteps).toHaveLength(1);
      expect(bridge.session.shadowRoots.size).toBe(0);
      expect(translate).not.toHaveBeenCalled();
      expect(states).toEqual([true, false]);

      appendElement(document.body, 'div');
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(iteratorSteps).toHaveLength(1);
      expect(bridge.session.shadowRoots.size).toBe(0);
      expect(translate).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState(null, '', originalUrl);
    }
  });

  it('prevents an old provider completion from writing into its replacement session', async () => {
    const owner = appendElement(document.createDocumentFragment(), 'p', 'Original');
    setBody(owner);
    const node = owner.firstChild;
    const oldPending = [];
    bridge = new PageTranslationBridgeClass();
    await bridge.initialize(settings, text => new Promise(resolve => oldPending.push({ text, resolve })), 'old');
    bridge.translate(document.body);
    await vi.waitFor(() => expect(oldPending).toHaveLength(1));

    const newTranslate = vi.fn((text) => Promise.resolve(acceptedTranslation(`New ${text}`)));
    await bridge.initialize(settings, newTranslate, 'new');
    bridge.translate(document.body);
    await vi.waitFor(() => expect(node.nodeValue).toContain('New Original'));
    oldPending[0].resolve(acceptedTranslation('Old translation'));
    await Promise.resolve();
    await Promise.resolve();

    expect(node.nodeValue).toContain('New Original');
    expect(node.nodeValue).not.toContain('Old translation');
  });

  it('retains a source-equal accepted node and restores it under sliced discovery', async () => {
    const owner = appendElement(document.createDocumentFragment(), 'p', 'Same source');
    setBody(owner);
    const node = owner.firstChild;
    const firstTranslate = vi.fn(() => Promise.resolve({
      __pageTranslationSettlement: true,
      text: 'Same source',
      state: 'pending',
      settle(outcome) { this.state = outcome; },
    }));
    bridge = new PageTranslationBridgeClass();
    await bridge.initialize(settings, firstTranslate);
    bridge.translate(document.body);
    await vi.waitFor(() => expect(bridge.session.nodesTranslator.nodeStorage.get(node)?.acceptedTranslation).toBeDefined());
    bridge.stopPersistence();

    const retained = vi.fn();
    const secondTranslate = vi.fn();
    await bridge.initialize(settings, secondTranslate, 'replacement', {
      preserveAcceptedTranslations: true,
      onRetainedTranslation: retained,
    });
    bridge.translate(document.body);
    await vi.waitFor(() => expect(retained).toHaveBeenCalledOnce());
    bridge.restore(document.body);

    expect(secondTranslate).not.toHaveBeenCalled();
    expect(node.nodeValue).toBe('Same source');
  });

  it('reports a traversal error once without signaling a successful drain', async () => {
    setBody(appendElement(document.createDocumentFragment(), 'p', 'Text'));
    const states = [];
    const errors = [];
    vi.spyOn(document, 'createNodeIterator').mockImplementation(() => ({
      nextNode: () => { throw new Error('iterator failed'); },
    }));
    await start(undefined, {
      callbacks: {
        onDiscoveryStateChange: pending => states.push(pending),
        onDiscoveryError: error => errors.push(error.message),
      },
    });

    expect(errors).toEqual(['iterator failed']);
    expect(states).toEqual([true]);
    expect(document.body.textContent).toBe('Text');
  });

  it('reports an idle-slice failure after preserving accepted writes, with no successful drain', async () => {
    const first = appendElement(document.createDocumentFragment(), 'p', 'Accepted before failure');
    const second = appendElement(document.createDocumentFragment(), 'p', 'Never admitted');
    setBody(first, second);
    const node = first.firstChild;
    const states = [];
    const errors = [];
    const nativeCreateNodeIterator = document.createNodeIterator.bind(document);
    let nextNodeCalls = 0;
    vi.spyOn(document, 'createNodeIterator').mockImplementation((...args) => {
      const iterator = nativeCreateNodeIterator(...args);
      return {
        nextNode: () => {
          nextNodeCalls++;
          if (nextNodeCalls === 4) throw new Error('idle iterator failed');
          return iterator.nextNode();
        },
      };
    });
    await start((text) => Promise.resolve(acceptedTranslation(text)), {
      callbacks: {
        onDiscoveryStateChange: pending => states.push(pending),
        onDiscoveryError: error => errors.push(error.message),
      },
    });
    await vi.waitFor(() => expect(errors).toEqual(['idle iterator failed']));
    await vi.waitFor(() => expect(node.nodeValue).toContain('Translated Accepted before failure'));

    expect(states).toEqual([true]);
    expect(second.textContent).toBe('Never admitted');
    bridge.restore(document.body);
    expect(node.nodeValue).toBe('Accepted before failure');
  });

  it('unregisters completed slice timers across repeated slices', async () => {
    const fixture = document.createDocumentFragment();
    for (let index = 0; index < 25; index++) appendElement(fixture, 'p', `Text ${index}`, { title: `Title ${index}` });
    setBody(...Array.from(fixture.childNodes));
    const states = [];
    await start((text) => Promise.resolve(acceptedTranslation(text)), {
      callbacks: { onDiscoveryStateChange: pending => states.push(pending) },
    });

    await vi.waitFor(() => expect(states.at(-1)).toBe(false));
    expect(bridgeGroupSize()).toBe(0);
  });

  it('releases a pending slice timer on stopPersistence', async () => {
    await startWithPendingTimer();

    expect(bridgeGroupSize()).toBeGreaterThan(0);
    bridge.stopPersistence();
    expect(bridgeGroupSize()).toBe(0);
  });

  it('releases timer resources on restore', async () => {
    await startWithPendingTimer();

    expect(bridgeGroupSize()).toBeGreaterThan(0);
    bridge.restore(document.body);
    expect(bridgeGroupSize()).toBe(0);
  });

  it('releases timer resources when a replacement session starts', async () => {
    await startWithPendingTimer();

    expect(bridgeGroupSize()).toBeGreaterThan(0);
    await bridge.initialize(settings, (text) => Promise.resolve(acceptedTranslation(text)));
    expect(bridgeGroupSize()).toBe(0);
  });

  it('enumerates an attribute-heavy element within the slice budget without viewport-first discovery', async () => {
    const fixture = document.createDocumentFragment();
    const heavy = appendElement(fixture, 'div', 'Heavy text', { title: 'Heavy title' });
    for (let attrIndex = 0; attrIndex < 60; attrIndex++) heavy.setAttribute(`data-unrelated-${attrIndex}`, `value-${attrIndex}`);
    setBody(heavy);
    const seen = [];
    const states = [];
    const nativeAttributes = Array.from(heavy.attributes);
    let enumeratedAttributes = 0;
    Object.defineProperty(heavy, 'attributes', {
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

    vi.useFakeTimers();
    try {
      await start(async (text, _context, _score, node) => {
        seen.push({ text, node });
        return Promise.resolve(acceptedTranslation(text));
      }, { callbacks: { onDiscoveryStateChange: pending => states.push(pending) } });

      // Bounded enumeration: one eligible attribute per slice, no unrelated
      // primitive admitted, and the final sequence is exactly the eligible set.
      await vi.waitFor(() => expect(seen).toHaveLength(2));
      expect(seen.map(({ text }) => text)).toEqual(['Heavy title', 'Heavy text']);
      expect(seen.every(({ text }) => !text.startsWith('data-unrelated'))).toBe(true);
      await vi.waitFor(() => expect(heavy.textContent).toContain('Translated Heavy text'));
      expect(states).toEqual([true, false]);
      // Bounded enumeration: the configured allow-list drives discovery instead
      // of scanning the live attribute collection.
      expect(enumeratedAttributes).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('requires multiple discovery slices for an attribute-heavy element', async () => {
    const fixture = document.createDocumentFragment();
    const heavy = appendElement(fixture, 'div', 'Heavy text', { title: 'Heavy title', alt: 'Heavy alt', placeholder: 'Heavy placeholder' });
    for (let attrIndex = 0; attrIndex < 60; attrIndex++) heavy.setAttribute(`data-unrelated-${attrIndex}`, `value-${attrIndex}`);
    setBody(heavy);
    const seen = [];
    const states = [];
    const expectedTexts = ['Heavy title', 'Heavy alt', 'Heavy placeholder', 'Heavy text'];

    bridge = new PageTranslationBridgeClass();
    await bridge.initialize({ ...settings, attributesToTranslate: ['title', 'alt', 'placeholder'] }, async (text, _context, _score, node) => {
      seen.push({ text, node });
      return Promise.resolve(acceptedTranslation(text));
    }, undefined, { onDiscoveryStateChange: pending => states.push(pending) });

    // Collect the scheduled slice callbacks instead of letting timers fire.
    const scheduledSlices = [];
    vi.spyOn(bridge, 'trackTimeout').mockImplementation(callback => {
      scheduledSlices.push(callback);
      return scheduledSlices.length;
    });
    bridge.translate(document.body);

    // Only the first eligible attribute is admitted so far and the next slice is
    // still pending.
    await advanceToAdmissions(seen, scheduledSlices, 1);
    expect(seen.map(({ text }) => text)).toEqual(expectedTexts.slice(0, 1));
    expect(scheduledSlices.length).toBeGreaterThan(0);

    // Advance one scheduled slice at a time and verify the ordered sequence.
    for (let admitted = 2; admitted <= expectedTexts.length; admitted++) {
      await advanceToAdmissions(seen, scheduledSlices, admitted);
      expect(seen.map(({ text }) => text)).toEqual(expectedTexts.slice(0, admitted));
    }
    expect(seen.length).toBe(expectedTexts.length);
  });

  it('translates each eligible attribute exactly once', async () => {
    const fixture = document.createDocumentFragment();
    appendElement(fixture, 'p', 'First text', { title: 'First title', alt: 'First alt' });
    appendElement(fixture, 'p', 'Second text', { title: 'Second title' });
    setBody(...Array.from(fixture.childNodes));
    const seen = [];
    const states = [];
    await start((text, _context, _score, node) => {
      seen.push({ text, node });
      return Promise.resolve(acceptedTranslation(text));
    }, {
      settings: { ...settings, attributesToTranslate: ['title', 'alt'] },
      callbacks: { onDiscoveryStateChange: pending => states.push(pending) },
    });

    await vi.waitFor(() => expect(states).toEqual([true, false]));
    expect(seen.map(({ text }) => text)).toEqual(['First title', 'First alt', 'First text', 'Second title', 'Second text']);
    expect(new Set(seen.map(({ text }) => text)).size).toBe(seen.length);
  });

  it('does not skip eligible attributes when an earlier attribute is removed between slices', async () => {
    const fixture = document.createDocumentFragment();
    const heavy = document.createElement('div');
    heavy.textContent = 'Heavy text';
    heavy.setAttribute('data-unrelated-0', 'value-0');
    heavy.setAttribute('title', 'Heavy title');
    heavy.setAttribute('alt', 'Heavy alt');
    fixture.appendChild(heavy);
    setBody(heavy);
    const seen = [];
    const states = [];
    const expectedTexts = ['Heavy title', 'Heavy alt', 'Heavy text'];

    bridge = new PageTranslationBridgeClass();
    await bridge.initialize({ ...settings, attributesToTranslate: ['title', 'alt'] }, async (text, _context, _score, node) => {
      seen.push({ text, node });
      return Promise.resolve(acceptedTranslation(text));
    }, undefined, { onDiscoveryStateChange: pending => states.push(pending) });

    // Collect the scheduled slice callbacks instead of letting timers fire.
    const scheduledSlices = [];
    vi.spyOn(bridge, 'trackTimeout').mockImplementation(callback => {
      scheduledSlices.push(callback);
      return scheduledSlices.length;
    });
    bridge.translate(document.body);

    // Advance until the first eligible attribute is admitted.
    await advanceToAdmissions(seen, scheduledSlices, 1);
    expect(seen.map(({ text }) => text)).toEqual(expectedTexts.slice(0, 1));
    // The next eligible attribute has not been admitted yet and a continuation
    // is pending.
    expect(seen.map(({ text }) => text)).not.toContain('Heavy alt');
    expect(scheduledSlices.length).toBeGreaterThan(0);

    // Remove the earlier unrelated attribute while the continuation is pending.
    heavy.removeAttribute('data-unrelated-0');

    // Resume the remaining slices and verify nothing was skipped or duplicated.
    await advanceToAdmissions(seen, scheduledSlices, 2);
    await advanceToAdmissions(seen, scheduledSlices, 3);
    expect(seen.map(({ text }) => text)).toEqual(expectedTexts);
    expect(seen.length).toBe(expectedTexts.length);
    expect(seen.filter(({ text }) => text === 'Heavy alt')).toHaveLength(1);
  });
});
