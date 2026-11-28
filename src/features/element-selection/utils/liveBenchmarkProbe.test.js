import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emitBenchmarkAcceptedClick,
  emitBenchmarkRequestDispatch,
  emitBenchmarkTerminal,
} from './liveBenchmarkProbe.js';

const eventNames = [
  'translate-it:select-element-benchmark:accepted-click',
  'translate-it:select-element-benchmark:request-dispatch',
  'translate-it:select-element-benchmark:operation-terminal',
];
const fixtureRoot = () => {
  const root = document.createElement('section');
  root.setAttribute('data-translate-it-live-benchmark-root', 'true');
  root.setAttribute('data-translate-it-live-benchmark-trial', 'trial-one');
  document.body.append(root);
  return root;
};

afterEach(() => {
  document.documentElement.removeAttribute('data-translate-it-live-benchmark');
  document.querySelector('[data-translate-it-live-benchmark-root]')?.remove();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('development live benchmark probe', () => {
  it('does not emit unless development and explicitly opted in', () => {
    vi.stubEnv('DEV', false);
    document.documentElement.setAttribute('data-translate-it-live-benchmark', 'true');
    const root = fixtureRoot();
    const now = vi.spyOn(performance, 'now');
    const listener = vi.fn();
    document.addEventListener(eventNames[0], listener);
    emitBenchmarkAcceptedClick({ timeStamp: 12 }, root);
    document.removeEventListener(eventNames[0], listener);
    expect(listener).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });

  it('does not collect timestamps when development is enabled without root opt-in', () => {
    vi.stubEnv('DEV', true);
    const root = fixtureRoot();
    const now = vi.spyOn(performance, 'now');
    const listener = vi.fn();
    document.addEventListener(eventNames[2], listener);

    emitBenchmarkTerminal(root, 'successful', 'trial-one');

    document.removeEventListener(eventNames[2], listener);
    expect(now).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('emits only allowlisted timestamps and terminal enums after opt-in', () => {
    vi.stubEnv('DEV', true);
    document.documentElement.setAttribute('data-translate-it-live-benchmark', 'true');
    const root = fixtureRoot();
    const received = [];
    const listeners = eventNames.map((name) => {
      const listener = (event) => received.push([name, JSON.parse(event.detail)]);
      document.addEventListener(name, listener);
      return listener;
    });
    emitBenchmarkAcceptedClick({ timeStamp: 12, secret: 'not forwarded' }, root);
    emitBenchmarkRequestDispatch(root);
    emitBenchmarkTerminal(root, 'successful', 'trial-one');
    emitBenchmarkTerminal(root, 'raw error', 'trial-one');
    eventNames.forEach((name, index) => document.removeEventListener(name, listeners[index]));
    expect(received).toHaveLength(3);
    expect(received[0][1]).toMatchObject({ clickTimeStamp: 12 });
    expect(Object.keys(received[0][1]).sort()).toEqual(['acceptedAt', 'clickTimeStamp', 'trialId']);
    expect(received[2][1]).toMatchObject({ status: 'successful' });
  });

  it('does not correlate unmarked or disconnected targets', () => {
    vi.stubEnv('DEV', true);
    document.documentElement.setAttribute('data-translate-it-live-benchmark', 'true');
    const listener = vi.fn();
    document.addEventListener(eventNames[1], listener);
    const root = fixtureRoot();
    root.removeAttribute('data-translate-it-live-benchmark-root');
    emitBenchmarkRequestDispatch(root);
    root.setAttribute('data-translate-it-live-benchmark-root', 'true');
    root.remove();
    emitBenchmarkRequestDispatch(root);
    document.removeEventListener(eventNames[1], listener);
    expect(listener).not.toHaveBeenCalled();
  });
});
