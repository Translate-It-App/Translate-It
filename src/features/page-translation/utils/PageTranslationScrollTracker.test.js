import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PageTranslationScrollTracker } from './PageTranslationScrollTracker.js';

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn()
  }))
}));

describe('PageTranslationScrollTracker', () => {
  let tracker;
  let startCallback;
  let stopCallback;
  let viewportActivityCallback;

  beforeEach(() => {
    vi.useFakeTimers();
    startCallback = vi.fn();
    stopCallback = vi.fn();
    viewportActivityCallback = vi.fn();
    tracker = new PageTranslationScrollTracker(stopCallback, startCallback, viewportActivityCallback);
  });

  afterEach(() => {
    tracker.destroy();
    vi.useRealTimers();
  });

  it('should start and stop listening for scroll events', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    addSpy.mockClear();
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    tracker.start(500);
    expect(addSpy).toHaveBeenCalledWith('scroll', expect.any(Function), { passive: true, capture: true });
    expect(addSpy).toHaveBeenCalledWith('resize', expect.any(Function), { passive: true });

    tracker.stop();
    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function));
  });

  it('should trigger callbacks on scroll and debounce stop', () => {
    tracker.start(500);

    // Simulate scroll event
    window.dispatchEvent(new Event('scroll'));
    expect(startCallback).toHaveBeenCalled();
    expect(stopCallback).not.toHaveBeenCalled();

    // Advance time slightly
    vi.advanceTimersByTime(250);
    window.dispatchEvent(new Event('scroll')); // Reset timer
    
    vi.advanceTimersByTime(250);
    expect(stopCallback).not.toHaveBeenCalled(); // 250+250 = 500 but second scroll reset it

    vi.advanceTimersByTime(250);
    expect(stopCallback).toHaveBeenCalled();
  });

  it('should handle notifyActivity', () => {
    tracker.start(500);
    tracker.notifyActivity();
    
    expect(startCallback).toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(stopCallback).toHaveBeenCalled();
  });

  it('should throttle notifyActivity', () => {
    tracker.start(500);
    const resetSpy = vi.spyOn(tracker, '_resetTimer');
    
    tracker.notifyActivity();
    tracker.notifyActivity(); // Should be throttled (< 50ms)
    
    expect(resetSpy).toHaveBeenCalledTimes(1);
  });

  it('tracks non-bubbling nested scroll events and keeps OnStop debouncing each scroll', () => {
    tracker.start(100);
    const nested = document.createElement('div');
    document.body.append(nested);

    nested.dispatchEvent(new Event('scroll'));
    expect(startCallback).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(75);
    nested.dispatchEvent(new Event('scroll'));
    expect(startCallback).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(99);
    expect(stopCallback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stopCallback).toHaveBeenCalledTimes(1);
  });

  it('coalesces scroll and resize viewport activity at 50ms', () => {
    tracker.start();
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    expect(viewportActivityCallback).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(49);
    window.dispatchEvent(new Event('resize'));
    expect(viewportActivityCallback).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    window.dispatchEvent(new Event('resize'));
    expect(viewportActivityCallback).toHaveBeenCalledTimes(2);
  });

  it('does not let resize move the OnStop deadline or trigger scroll callbacks', () => {
    tracker.start(100);
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(75);
    window.dispatchEvent(new Event('resize'));
    expect(startCallback).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(25);
    expect(stopCallback).toHaveBeenCalledTimes(1);
  });

  it('removes listeners on stop and starts a fresh viewport activity window on restart', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    addSpy.mockClear();
    tracker.start(100);
    tracker.start(200);
    expect(addSpy.mock.calls.filter(([type]) => type === 'scroll')).toHaveLength(1);
    window.dispatchEvent(new Event('resize'));
    tracker.stop();
    window.dispatchEvent(new Event('resize'));
    expect(viewportActivityCallback).toHaveBeenCalledTimes(1);

    tracker.start(100);
    window.dispatchEvent(new Event('resize'));
    expect(viewportActivityCallback).toHaveBeenCalledTimes(2);
    tracker.destroy();
    window.dispatchEvent(new Event('resize'));
    expect(viewportActivityCallback).toHaveBeenCalledTimes(2);
  });
});
