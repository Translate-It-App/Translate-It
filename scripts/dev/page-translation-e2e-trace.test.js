import { describe, expect, it, vi } from 'vitest';
import { installCallThrough, installTimedCallThrough, makeTrace } from './page-translation-e2e-benchmark/trace.mjs';

describe('benchmark call-through instrumentation', () => {
  it('preserves receiver, arguments, return value, and one original call', () => {
    const original = vi.fn(function (amount) { return this.value + amount; });
    const receiver = { value: 4, method: original };
    const events = [];
    expect(installCallThrough(receiver, 'method', function (args) { events.push([this.value, ...args]); })).toBe(true);
    expect(receiver.method(3)).toBe(7);
    expect(original).toHaveBeenCalledTimes(1);
    expect(events).toEqual([[4, 3]]);
  });

  it('preserves synchronous exceptions and exact async promise identity/rejection', async () => {
    const failure = new Error('original failure');
    const sync = { method() { throw failure; } };
    installCallThrough(sync, 'method', () => {});
    expect(() => sync.method()).toThrow(failure);

    const rejected = Promise.reject(failure);
    const original = vi.fn(() => rejected);
    const asyncTarget = { method: original };
    const observations = [];
    installTimedCallThrough(asyncTarget, 'method', () => 'token', (token, error) => observations.push([token, error]));
    expect(asyncTarget.method()).toBe(rejected);
    await expect(rejected).rejects.toBe(failure);
    await Promise.resolve();
    expect(original).toHaveBeenCalledTimes(1);
    expect(observations).toEqual([['token', failure]]);
  });

  it('provides serializable timestamped trace snapshots', () => {
    const trace = makeTrace('test');
    trace.record('milestone', { count: 2 });
    expect(trace.snapshot()).toMatchObject({ scope: 'test', events: [{ name: 'milestone', count: 2 }] });
    expect(() => JSON.stringify(trace.snapshot())).not.toThrow();
  });
});
