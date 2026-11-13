// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

const runSource = await readFile(new URL('./page-translation-production-benchmark/run.mjs', import.meta.url), 'utf8');
const bridgeSource = await readFile(new URL('../../src/features/page-translation/PageTranslationBridge.js', import.meta.url), 'utf8');

function loadMockResourceTracker() {
  const match = runSource.match(/'\/mock\/resource\.js':\s*`([^`]*)`/);
  expect(match, 'ResourceTracker mock source not found in run.mjs').not.toBeNull();
  const moduleFactory = new Function(match[1].replace('export default ', 'return '));
  return moduleFactory();
}

describe('production benchmark ResourceTracker mock', () => {
  it('provides the timer lifecycle the production Bridge cleanup requires', () => {
    const ResourceTracker = loadMockResourceTracker();
    const tracker = new ResourceTracker();

    for (const method of ['trackTimeout', 'clearTimer', 'clearAllTimers', 'cleanup']) {
      expect(typeof tracker[method], `mock is missing ${method}()`).toBe('function');
    }
    expect(bridgeSource).toContain('this.clearAllTimers();');
  });

  it('clears pending timers without running them', async () => {
    const ResourceTracker = loadMockResourceTracker();
    const tracker = new ResourceTracker();
    let fired = 0;

    tracker.trackTimeout(() => { fired += 1; }, 5);
    tracker.clearAllTimers();
    await delay(40);

    expect(fired).toBe(0);
  });

  it('keeps completed timers out of the cleanup path', async () => {
    const ResourceTracker = loadMockResourceTracker();
    const tracker = new ResourceTracker();
    let fired = 0;

    tracker.trackTimeout(() => { fired += 1; }, 1);
    await delay(20);
    expect(fired).toBe(1);

    tracker.clearAllTimers();
    await delay(20);

    expect(fired).toBe(1);
  });

  it('clears a pending timer registered after a completed one', async () => {
    const ResourceTracker = loadMockResourceTracker();
    const tracker = new ResourceTracker();
    let fired = 0;

    tracker.trackTimeout(() => { fired += 1; }, 1);
    await delay(20);
    tracker.trackTimeout(() => { fired += 1; }, 5);
    tracker.clearAllTimers();
    await delay(40);

    expect(fired).toBe(1);
  });
});
