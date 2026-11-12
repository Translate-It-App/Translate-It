import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runProductionFixture } from './page-translation-production-benchmark/fixture.js';

const LRM = '\u200e';

const makeBridge = ({ incomplete = false, restoreError = null, cleanupError = null } = {}) => {
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
      const targets = [...root.querySelectorAll('[data-bench-id]')];
      this.originals = new Map(targets.map(node => [node, node.textContent]));
      this.work = Promise.all(targets.map(async node => {
        const settlement = await this.provider(node.textContent, null, null, node);
        node.textContent = `${LRM}${settlement.text}`;
        settlement.settle('accepted');
      })).then(() => this.callbacks.onDiscoveryStateChange(false));
    }

    restore(root) {
      if (restoreError) throw restoreError;
      const targets = [...root.querySelectorAll('[data-bench-id]')];
      for (const node of targets) {
        if (incomplete && node.dataset.benchId === 'visible-15') continue;
        node.textContent = this.originals.get(node);
      }
    }
  }

  return { Bridge: FixtureBridge, instances };
};

describe('production benchmark fixture restore invariant', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
