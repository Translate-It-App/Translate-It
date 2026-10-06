import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nextTick } from 'vue';
import { HIGHLIGHT_ELEMENT_TIMEOUT_MS, useHighlightManager } from './useHighlightManager.js';

// Router doubles: the query object is read fresh on every checkAndHighlight
// call, so tests configure it per test before invoking the composable.
const routerMocks = vi.hoisted(() => ({
  query: {},
  replace: vi.fn()
}));
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routerMocks.query }),
  useRouter: () => ({ replace: routerMocks.replace })
}));

// Logger doubles to observe timeout warnings without console noise.
const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}));
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => loggerMocks
}));

const addTarget = (id) => {
  const el = document.createElement('div');
  el.id = id;
  document.body.appendChild(el);
  return el;
};

describe('useHighlightManager - readiness detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    routerMocks.query = {};
    document.body.innerHTML = '';
    // jsdom does not implement scrollIntoView; stub it per test.
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    delete window.HTMLElement.prototype.scrollIntoView;
    vi.useRealTimers();
  });

  it('highlights an already-present target and cleans the query', async () => {
    expect(HIGHLIGHT_ELEMENT_TIMEOUT_MS).toBe(1500);
    const el = addTarget('ALREADY_HERE');
    routerMocks.query = { highlight: 'ALREADY_HERE', keep: '1' };

    await useHighlightManager().checkAndHighlight();

    expect(routerMocks.replace).toHaveBeenCalledWith({ query: { keep: '1' } });
    expect(loggerMocks.warn).not.toHaveBeenCalled();
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(el.classList.contains('is-highlighting')).toBe(true);
    vi.advanceTimersByTime(3600);
    expect(el.classList.contains('is-highlighting')).toBe(false);
  });

  it('waits for a late-inserted target via MutationObserver without polling', async () => {
    const observeSpy = vi.spyOn(MutationObserver.prototype, 'observe');
    routerMocks.query = { highlight: 'LATE_TARGET' };

    const pending = useHighlightManager().checkAndHighlight();
    await nextTick();
    await nextTick();
    expect(routerMocks.replace).not.toHaveBeenCalled();

    const el = addTarget('LATE_TARGET');
    await pending;

    expect(observeSpy).toHaveBeenCalled();
    expect(routerMocks.replace).toHaveBeenCalledWith({ query: {} });
    expect(loggerMocks.warn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(el.classList.contains('is-highlighting')).toBe(true);
    observeSpy.mockRestore();
  });

  it('warns, disconnects, and still cleans the query when the target never appears', async () => {
    const disconnectSpy = vi.spyOn(MutationObserver.prototype, 'disconnect');
    routerMocks.query = { highlight: 'NEVER_HERE', keep: '1' };

    const pending = useHighlightManager().checkAndHighlight();
    await nextTick();
    await nextTick();
    expect(routerMocks.replace).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HIGHLIGHT_ELEMENT_TIMEOUT_MS);
    await pending;

    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
    expect(loggerMocks.warn).toHaveBeenCalledWith(expect.stringContaining('NEVER_HERE'));
    expect(disconnectSpy).toHaveBeenCalled();
    expect(routerMocks.replace).toHaveBeenCalledWith({ query: { keep: '1' } });
    disconnectSpy.mockRestore();
  });

  it('preserves the accordion reveal flow before highlighting', async () => {
    const seen = [];
    window.addEventListener('options-reveal-accordion', (e) => seen.push(e.detail), { once: true });
    const el = addTarget('PROXY_SOME_SETTING');
    routerMocks.query = { highlight: 'PROXY_SOME_SETTING' };

    const pending = useHighlightManager().checkAndHighlight();
    await vi.advanceTimersByTimeAsync(300);
    await pending;

    expect(seen).toEqual(['proxy']);
    expect(routerMocks.replace).toHaveBeenCalledWith({ query: {} });
    vi.advanceTimersByTime(500);
    expect(el.classList.contains('is-highlighting')).toBe(true);
  });

  it('reveals the legacy whole-page rules target with only the accordion event', async () => {
    const accordion = vi.fn();
    const intent = vi.fn();
    window.addEventListener('options-reveal-accordion', accordion);
    window.addEventListener('options-reveal-intent', intent);
    const el = addTarget('WHOLE_PAGE_AUTO_TRANSLATE_RULES');
    routerMocks.query = { highlight: 'WHOLE_PAGE_AUTO_TRANSLATE_RULES', keep: '1' };

    const pending = useHighlightManager().checkAndHighlight();
    await vi.advanceTimersByTimeAsync(300);
    await pending;
    window.removeEventListener('options-reveal-accordion', accordion);
    window.removeEventListener('options-reveal-intent', intent);

    expect(accordion).toHaveBeenCalledTimes(1);
    expect(accordion.mock.calls[0][0].detail).toBe('wholePageRules');
    expect(intent).not.toHaveBeenCalled();
    expect(routerMocks.replace).toHaveBeenCalledWith({ query: { keep: '1' } });
    vi.advanceTimersByTime(500);
    expect(el.classList.contains('is-highlighting')).toBe(true);
  });

  it('emits the drawer intent and highlights its target after it mounts', async () => {
    const events = [];
    const onAccordion = (event) => events.push(`accordion:${event.detail}`);
    const onIntent = (event) => {
      events.push(`intent:${event.detail}`);
      addTarget('WHOLE_PAGE_AUTO_TRANSLATE_RULES_DRAWER');
    };
    window.addEventListener('options-reveal-accordion', onAccordion);
    window.addEventListener('options-reveal-intent', onIntent, { once: true });
    routerMocks.query = { highlight: 'WHOLE_PAGE_AUTO_TRANSLATE_RULES_DRAWER', keep: '1', other: '2' };

    const pending = useHighlightManager().checkAndHighlight();
    await vi.advanceTimersByTimeAsync(300);
    await pending;
    window.removeEventListener('options-reveal-accordion', onAccordion);
    window.removeEventListener('options-reveal-intent', onIntent);

    expect(events).toEqual(['accordion:wholePageRules', 'intent:wholePageRulesDrawer']);
    expect(routerMocks.replace).toHaveBeenCalledWith({ query: { keep: '1', other: '2' } });
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    const el = document.getElementById('WHOLE_PAGE_AUTO_TRANSLATE_RULES_DRAWER');
    vi.advanceTimersByTime(500);
    expect(el.classList.contains('is-highlighting')).toBe(true);
  });

  it('does not emit the drawer intent or clean the query if the accordion event makes the run stale', async () => {
    const intent = vi.fn();
    const onAccordion = () => {
      routerMocks.query.highlight = 'NEWER_TARGET';
    };
    window.addEventListener('options-reveal-accordion', onAccordion, { once: true });
    window.addEventListener('options-reveal-intent', intent);
    routerMocks.query = { highlight: 'WHOLE_PAGE_AUTO_TRANSLATE_RULES_DRAWER', keep: '1' };

    await useHighlightManager().checkAndHighlight();

    window.removeEventListener('options-reveal-accordion', onAccordion);
    window.removeEventListener('options-reveal-intent', intent);
    expect(intent).not.toHaveBeenCalled();
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(routerMocks.query).toEqual({ highlight: 'NEWER_TARGET', keep: '1' });
  });

  it('does nothing when no highlight is requested', async () => {
    routerMocks.query = {};

    await useHighlightManager().checkAndHighlight();

    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(loggerMocks.warn).not.toHaveBeenCalled();
  });

  it('lets a newer navigation win: the stale run neither highlights nor clears the newer target', async () => {
    // Run A starts while its target is still absent (async panel loading).
    routerMocks.query = { highlight: 'STALE_A' };
    const runA = useHighlightManager().checkAndHighlight();
    await nextTick();
    await nextTick();
    expect(routerMocks.replace).not.toHaveBeenCalled();

    // Navigation A→B mid-wait: the newer run takes ownership.
    routerMocks.query = { highlight: 'NEWER_B' };
    const runB = useHighlightManager().checkAndHighlight();
    await nextTick();
    await nextTick();

    // A's target appears late: stale A must go inert before its visual
    // highlight and must not delete highlight=B on cleanup.
    const elA = addTarget('STALE_A');
    await nextTick();
    await nextTick();
    await runA;

    expect(window.HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(elA.classList.contains('is-highlighting')).toBe(false);
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(routerMocks.query).toEqual({ highlight: 'NEWER_B' });
    expect(loggerMocks.warn).not.toHaveBeenCalled();

    // The newer run completes normally, cleaning only its own query.
    const elB = addTarget('NEWER_B');
    await runB;

    expect(routerMocks.replace).toHaveBeenCalledWith({ query: {} });
    vi.advanceTimersByTime(500);
    expect(elB.classList.contains('is-highlighting')).toBe(true);
    expect(elA.classList.contains('is-highlighting')).toBe(false);
  });
});
