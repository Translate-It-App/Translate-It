import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runProductionFixture } from './production-benchmark/fixture.js';
import { createAttributeHeavyFixture } from './production-benchmark/fixture.js';

const LRM = '\u200e';

const makeBridge = ({ incomplete = false, restoreError = null, cleanupError = null, duplicateAdmission = false, missingAdmission = false, duplicateMutationRecords = false } = {}) => {
  const instances = [];
  class FixtureBridge {
    constructor() {
      this.cleanup = vi.fn(() => {
        if (cleanupError) throw cleanupError;
      });
      this.originals = new Map();
      instances.push(this);
    }

    async initialize(_settings, provider, _context, callbacks) {
      this.provider = provider;
      this.callbacks = callbacks;
    }

    translate(root) {
      const textElements = [...root.querySelectorAll('*')].filter(node => node.dataset.benchId || node.dataset.benchIdText);
      const attributes = [...root.querySelectorAll('*')].flatMap(element => Object.keys(element.dataset)
        .filter(key => key.startsWith('benchId') && !['benchId', 'benchIdText'].includes(key))
        .map(key => ({ element, name: key.slice('benchId'.length).replace(/[A-Z]/g, (char, index) => `${index ? '-' : ''}${char.toLowerCase()}`) })));
      this.originals = new Map(textElements.map(node => [node, node.textContent]));
      this.attributeOriginals = new Map(attributes.map(({ element, name }) => [`${element.dataset[`benchId${name.replace(/(^|-)(.)/g, (_, _dash, char) => char.toUpperCase())}`]}:${name}`, element.getAttribute(name)]));
      const work = textElements.map(async element => {
        const id = element.dataset.benchIdText ?? element.dataset.benchId;
        const textNode = element.firstChild;
        if (missingAdmission && id === 'attribute-0-text') {
          textNode.data = `${LRM}T:${textNode.data}`;
          return;
        }
        const settlement = await this.provider(element.textContent, null, null, textNode);
        if (duplicateMutationRecords && id === 'attribute-0-text') textNode.data = 'temporary text';
        textNode.data = `${LRM}${settlement.text}`;
        settlement.settle('accepted');
        if (duplicateAdmission && id?.startsWith('attribute-0-')) await this.provider(element.textContent, null, null, textNode);
      });
      work.push(...attributes.map(async ({ element, name }) => {
        const idKey = `benchId${name.replace(/(^|-)(.)/g, (_, _dash, char) => char.toUpperCase())}`;
        const id = element.dataset[idKey];
        const original = element.getAttribute(name);
        const settlement = await this.provider(original, null, null, element.getAttributeNode(name));
        if (duplicateMutationRecords && id === 'attribute-0-title') element.setAttribute(name, 'temporary title');
        element.setAttribute(name, `${LRM}${settlement.text}`);
        settlement.settle('accepted');
        if (duplicateAdmission && id === 'attribute-0-title') await this.provider(original, null, null, element.getAttributeNode(name));
      }));
      this.work = Promise.all(work).then(() => this.callbacks.onDiscoveryStateChange(false));
    }

    restore(root) {
      if (restoreError) throw restoreError;
      const targets = [...root.querySelectorAll('*')].filter(node => node.dataset.benchId || node.dataset.benchIdText);
      for (const node of targets) {
        if (incomplete && node.dataset.benchId === 'visible-15') continue;
        node.textContent = this.originals.get(node);
      }
      for (const [key, value] of this.attributeOriginals ?? []) {
        const [id, name] = key.split(':');
        const element = [...root.querySelectorAll('*')].find(node => Object.values(node.dataset).includes(id));
        if (element) element.setAttribute(name, value);
      }
    }
  }

  return { Bridge: FixtureBridge, instances };
};

describe('production benchmark fixture restore invariant', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  beforeEach(() => {
    vi.stubGlobal('PerformanceObserver', { supportedEntryTypes: [] });
  });

  const run = Bridge => runProductionFixture({
    Bridge,
    mode: 'legacy',
    fixture: 'flat',
    latency: 0,
    prefixCount: 1,
    longTaskCaptureValid: false,
  });

  const runAttributes = Bridge => runProductionFixture({
    Bridge, mode: 'legacy', fixture: 'attribute-heavy', latency: 0, prefixCount: 1, longTaskCaptureValid: false,
  });

  it('classifies only present allow-listed attributes and text in the attribute-heavy fixture', () => {
    const { fragment, targets } = createAttributeHeavyFixture();
    expect(targets).toHaveLength(240);
    expect(new Set(targets.map(target => target.id)).size).toBe(240);
    expect(targets.filter(target => target.kind === 'attribute').map(target => target.name).reduce((counts, name) => {
      counts[name] = (counts[name] ?? 0) + 1;
      return counts;
    }, {})).toEqual({ title: 48, alt: 48, placeholder: 48, 'aria-label': 48 });
    expect(fragment.querySelectorAll('input:not([readonly])')).toHaveLength(0);
    expect(fragment.querySelectorAll('input[value]')).toHaveLength(0);
    expect(fragment.querySelectorAll('img[title]')).toHaveLength(0);
    expect(targets.filter(target => target.kind === 'text' && target.element.dataset.benchId).length).toBe(48);
    expect(targets.some(target => target.name === 'data-bench-excluded')).toBe(false);
  });

  it('validates mixed text and attribute writes and restores all original values before cleanup', async () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function() {
      const visible = this.localName === 'input' || this.localName === 'button' || (this.localName === 'p' && !this.hasAttribute('title'));
      return { left: 0, top: 0, right: visible ? 100 : 0, bottom: visible ? 20 : 0, width: visible ? 100 : 0, height: visible ? 20 : 0 };
    });
    const { Bridge, instances } = makeBridge({ duplicateMutationRecords: true });
    const result = await runAttributes(Bridge);
    expect(result.translatedTargets).toBe(240);
    expect(result.observedTargetWrites).toBe(240);
    expect(observe.mock.calls.find(([target]) => target === document.body)[1]).toEqual({
      subtree: true, childList: true, characterData: true, attributes: true,
    });
    expect(result.visibleTargets).toBeGreaterThan(0);
    expect(result.visibleTargets).toBeLessThan(result.expectedEligibleTargets);
    expect(result.providerAdmissions).toBe(240);
    expect(result.settlementCalls).toBe(240);
    expect(instances[0].cleanup).toHaveBeenCalledOnce();
    expect([...document.querySelectorAll('[data-bench-id$="-text"]')].every(node => node.textContent === instances[0].originals.get(node))).toBe(true);
    expect([...document.querySelectorAll('[data-bench-id-title], [data-bench-id-alt], [data-bench-id-placeholder], [data-bench-id-aria-label]')]
      .every(node => ['title', 'alt', 'placeholder', 'aria-label'].every(name => !instances[0].attributeOriginals.has(`${node.dataset[`benchId${name.replace(/(^|-)(.)/g, (_, _dash, char) => char.toUpperCase())}`]}:${name}`)
        || node.getAttribute(name) === instances[0].attributeOriginals.get(`${node.dataset[`benchId${name.replace(/(^|-)(.)/g, (_, _dash, char) => char.toUpperCase())}`]}:${name}`)))).toBe(true);
  });

  it('keeps the text-only observer configuration for the existing fixtures', async () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const { Bridge } = makeBridge();

    await run(Bridge);

    const bodyObservation = observe.mock.calls.find(([target]) => target === document.body);
    expect(bodyObservation[1]).toEqual({ subtree: true, childList: true, characterData: true });
  });

  it('rejects duplicate provider coverage', async () => {
    const { Bridge, instances } = makeBridge({ duplicateAdmission: true });
    await expect(runAttributes(Bridge)).rejects.toThrow(/Fixture invariant failed/);
    expect(instances[0].cleanup).toHaveBeenCalledOnce();
  });

  it('rejects a translated target with missing provider admission', async () => {
    const { Bridge, instances } = makeBridge({ missingAdmission: true });
    await expect(runAttributes(Bridge)).rejects.toThrow(/missingAdmissionIds.*attribute-0-text/);
    expect(instances[0].cleanup).toHaveBeenCalledOnce();
  });

  it('restores every target to its captured pre-translation content before cleanup', async () => {
    const { Bridge, instances } = makeBridge();

    const result = await run(Bridge);

    expect(result.translatedTargets).toBe(result.expectedEligibleTargets);
    expect(instances[0].cleanup).toHaveBeenCalledOnce();
    expect([...document.querySelectorAll('[data-bench-id]')].every(node => (
      node.textContent === instances[0].originals.get(node)
    ))).toBe(true);
  });

  it('reports incomplete restore and still cleans up the Bridge', async () => {
    const { Bridge, instances } = makeBridge({ incomplete: true });

    await expect(run(Bridge)).rejects.toThrow(/Restore invariant failed: restored=80 expected=81; mismatched IDs=visible-15/);

    expect(instances[0].cleanup).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-bench-id="visible-15"]').textContent).toContain(`${LRM}T:Visible item 15`);
  });

  it('reports restore and cleanup failures together without masking either', async () => {
    const restoreError = new Error('restore failed');
    const cleanupError = new Error('cleanup failed');
    const { Bridge, instances } = makeBridge({ restoreError, cleanupError });

    let caught;
    try {
      await run(Bridge);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const nestedMessages = caught.errors.flatMap(error => (
      error instanceof AggregateError ? error.errors.map(nested => nested.message) : [error.message]
    ));
    expect(nestedMessages).toContain('restore failed');
    expect(nestedMessages).toContain('cleanup failed');
    expect(instances[0].cleanup).toHaveBeenCalledOnce();
  });
});
