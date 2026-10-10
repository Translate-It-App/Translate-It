import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageNavigationTracker } from './PageNavigationTracker.js';
import browser from 'webextension-polyfill';

vi.mock('webextension-polyfill', () => ({ default: { webNavigation: { getFrame: vi.fn() } } }));

describe('Page navigation producer cursor', () => {
  let saved;
  let storage;
  let tracker;
  const frames = [{ frameId: 0, url: 'https://example.com/a' }, { frameId: 7, url: 'https://frame.example/a' }];

  beforeEach(() => {
    browser.webNavigation.getFrame.mockReset().mockResolvedValue({ url: frames[0].url });
    saved = {};
    storage = {
      get: vi.fn(async () => structuredClone(saved)),
      set: vi.fn(async value => { saved = structuredClone(value); }),
    };
    tracker = new PageNavigationTracker(storage);
  });

  it('repairs a stale first seed and later retries without requiring another native event', async () => {
    expect(await tracker.capture(42, 0, 'https://example.com/b')).toBeNull();
    await tracker.seed(42, frames);
    browser.webNavigation.getFrame.mockResolvedValue({ url: 'https://example.com/b' });
    const admitted = await tracker.getAdmissionCursor(42, 0);
    expect(admitted).toMatchObject({ routeRevision: 1, url: 'https://example.com/b' });
    await tracker.seed(42, frames);
    storage.set.mockClear();
    expect(await tracker.getAdmissionCursor(42, 0)).toEqual(admitted);
    expect(storage.set).not.toHaveBeenCalled();
  });

  it.each(['route', 'round trip', 'commit'])(
    'keeps newer captured %s evidence when a fresh-frame read resolves late', async change => {
      await tracker.seed(42, frames);
      let release;
      browser.webNavigation.getFrame.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      const admission = tracker.getAdmissionCursor(42, 0);
      await vi.waitFor(() => expect(browser.webNavigation.getFrame).toHaveBeenCalledOnce());
      if (change === 'commit') await tracker.committed(42, 0, 'https://example.com/new-document');
      else {
        await tracker.capture(42, 0, 'https://example.com/b');
        if (change === 'round trip') await tracker.capture(42, 0, frames[0].url);
      }
      const newer = await tracker.getCursor(42, 0);
      release({ url: change === 'round trip' ? 'https://example.com/b' : frames[0].url });
      expect(await admission).toEqual(newer);
    }
  );

  it.each(['tab removal', 'prune', 'top commit'])(
    'does not resurrect a frame removed by %s while its frame read is pending', async change => {
      await tracker.seed(42, frames);
      let release;
      browser.webNavigation.getFrame.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      const admission = tracker.getAdmissionCursor(42, 7);
      await vi.waitFor(() => expect(browser.webNavigation.getFrame).toHaveBeenCalledOnce());
      if (change === 'tab removal') await tracker.removeTab(42);
      else if (change === 'prune') await tracker.seed(42, [frames[0]]);
      else await tracker.committed(42, 0, frames[0].url);
      release({ url: frames[1].url });
      expect(await admission).toBeNull();
      expect(await tracker.getCursor(42, 7)).toBeNull();
    }
  );

  it('does not enroll an absent frame just to refresh admission', async () => {
    expect(await tracker.getAdmissionCursor(42, 0)).toBeNull();
    expect(browser.webNavigation.getFrame).not.toHaveBeenCalled();
    expect(storage.set).not.toHaveBeenCalled();
  });

  it.each([null, {}, { url: '' }, { url: {} }])('fails closed when the fresh-frame API returns %o', async frame => {
    await tracker.seed(42, frames);
    browser.webNavigation.getFrame.mockResolvedValue(frame);
    await expect(tracker.getAdmissionCursor(42, 0)).rejects.toThrow('Page frame unavailable');
  });

  it('does not block another tab or native route capture while the frame API is waiting', async () => {
    await tracker.seed(42, frames);
    let release;
    browser.webNavigation.getFrame.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const admission = tracker.getAdmissionCursor(42, 0);
    await vi.waitFor(() => expect(browser.webNavigation.getFrame).toHaveBeenCalledOnce());
    await tracker.seed(43, frames);
    expect(await tracker.capture(42, 0, 'https://example.com/b')).toMatchObject({ routeRevision: 1 });
    expect(await tracker.getCursor(43, 0)).toBeTruthy();
    release({ url: frames[0].url });
    expect((await admission).url).toBe('https://example.com/b');
  });

  it('rejects fresh-frame API and admission persistence failures without a stale baseline fallback', async () => {
    await tracker.seed(42, frames);
    browser.webNavigation.getFrame.mockRejectedValueOnce(new Error('frame API unavailable'));
    await expect(tracker.getAdmissionCursor(42, 0)).rejects.toThrow('frame API unavailable');
    browser.webNavigation.getFrame.mockResolvedValue({ url: 'https://example.com/b' });
    storage.set.mockRejectedValueOnce(new Error('write failed'));
    await expect(tracker.getAdmissionCursor(42, 0)).rejects.toThrow('write failed');
    expect((await tracker.getAdmissionCursor(42, 0)).url).toBe('https://example.com/b');
  });

  it('captures cumulative full-URL changes while state updates preserve identity', async () => {
    await tracker.seed(42, frames);
    const initial = await tracker.getCursor(42, 0);
    const away = await tracker.capture(42, 0, 'https://example.com/b');
    const state = await tracker.capture(42, 0, 'https://example.com/b');
    const back = await tracker.capture(42, 0, frames[0].url);
    const secondAway = await tracker.capture(42, 0, 'https://example.com/b');
    expect(away.routeRevision).toBe(initial.routeRevision + 1);
    expect(state).toEqual(away);
    expect(back.routeRevision).toBe(2);
    expect(secondAway.routeRevision).toBe(3);
    expect(away.routeRevision).toBe(1);
    expect((await tracker.capture(42, 0, 'https://example.com/b#section')).routeRevision).toBe(4);
  });

  it('does not persist unchanged state updates, seeds or untracked lifecycle events', async () => {
    await tracker.seed(42, frames);
    const initial = await tracker.getCursor(42, 0);
    storage.set.mockClear();
    for (let index = 0; index < 100; index++) {
      expect(await tracker.capture(42, 0, frames[0].url)).toEqual(initial);
    }
    await tracker.seed(42, frames);
    expect(await tracker.capture(42, 99, 'https://frame.example/untracked')).toBeNull();
    await tracker.committed(43, 0, 'https://example.com/untracked');
    await tracker.committed(42, 99, 'https://frame.example/untracked');
    await tracker.removeTab(43);
    expect(storage.set).not.toHaveBeenCalled();
    expect(await tracker.getCursor(42, 0)).toEqual(initial);
  });

  it('retries a dirty failed mutation even through an otherwise unchanged event', async () => {
    await tracker.seed(42, frames);
    storage.set.mockRejectedValueOnce(new Error('write failed'));
    await expect(tracker.capture(42, 0, 'https://example.com/b')).rejects.toThrow();
    storage.set.mockClear();
    const durable = await tracker.capture(42, 0, 'https://example.com/b');
    expect(storage.set).toHaveBeenCalledOnce();
    expect(durable.routeRevision).toBe(1);
    const restarted = new PageNavigationTracker(storage);
    expect(await restarted.getCursor(42, 0)).toEqual(durable);
  });

  it('hydrates counters and tracked frames across worker restart without cursor reuse', async () => {
    await tracker.seed(42, frames);
    await tracker.capture(42, 0, 'https://example.com/b');
    const before = await tracker.getCursor(42, 0);
    tracker = new PageNavigationTracker(storage);
    expect(await tracker.getCursor(42, 0)).toEqual(before);
    await tracker.committed(42, 0, frames[0].url);
    const committed = await tracker.getCursor(42, 0);
    expect(committed.documentEpoch).toBeGreaterThan(before.documentEpoch);
    expect(committed.routeRevision).toBe(0);
    expect(await tracker.getCursor(42, 7)).toBeNull();
  });

  it('resets only the committed child document and keeps other frame records', async () => {
    await tracker.seed(42, frames);
    const top = await tracker.getCursor(42, 0);
    const child = await tracker.getCursor(42, 7);
    await tracker.committed(42, 7, 'https://frame.example/new-document');
    expect(await tracker.getCursor(42, 0)).toEqual(top);
    expect((await tracker.getCursor(42, 7)).documentEpoch).toBeGreaterThan(child.documentEpoch);
  });

  it('prunes missing participating frames without overwriting a newer captured route snapshot', async () => {
    await tracker.seed(42, frames);
    const fresh = await tracker.capture(42, 0, 'https://example.com/b');
    await tracker.seed(42, [frames[0]]);
    expect(await tracker.getCursor(42, 0)).toEqual(fresh);
    expect(await tracker.getCursor(42, 7)).toBeNull();
  });

  it.each([
    { description: 'discovery falls back to a frame without a URL', discovered: [{ frameId: 0 }] },
    { description: 'a valid new frame precedes an invalid frame', discovered: [{ frameId: 9, url: 'https://new.example' }, { frameId: 0 }] },
    { description: 'a frame has an invalid ID', discovered: [{ frameId: 0, url: frames[0].url }, { frameId: -1, url: 'https://new.example' }] },
    { description: 'a frame entry is null', discovered: [null] },
    { description: 'a frame entry is missing', discovered: Array(1) },
    { description: 'the frame list is not an array', discovered: null },
  ])('preserves tracked frames and the epoch allocator when $description', async ({ discovered }) => {
    await tracker.seed(42, frames);
    const initial = structuredClone(saved);
    const child = await tracker.getCursor(42, 7);
    storage.set.mockClear();

    await expect(tracker.seed(42, discovered)).rejects.toThrow('Invalid Page frame');

    expect(await tracker.getCursor(42, 0)).toEqual(initial.pageTranslationNavigation.frames['42:0']);
    expect(await tracker.getCursor(42, 7)).toEqual(child);
    expect(await tracker.getCursor(42, 9)).toBeNull();
    expect(saved).toEqual(initial);
    expect(storage.set).not.toHaveBeenCalled();

    await tracker.seed(43, [frames[0]]);
    expect((await tracker.getCursor(43, 0)).documentEpoch).toBe(initial.pageTranslationNavigation.nextDocumentEpoch + 1);
    expect(await tracker.capture(42, 7, 'https://frame.example/b')).toEqual({ ...child, routeRevision: 1, url: 'https://frame.example/b' });
    const returned = await tracker.capture(42, 7, frames[1].url);
    expect(returned).toEqual({ ...child, routeRevision: 2 });
    const restarted = new PageNavigationTracker(storage);
    expect(await restarted.getCursor(42, 7)).toEqual(returned);
  });

  it('does not register arbitrary untracked history or committed frames', async () => {
    expect(await tracker.capture(42, 1234, 'https://frame.example/a')).toBeNull();
    await tracker.committed(42, 1234, 'https://frame.example/b');
    expect(saved).toEqual({});
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('removes only closed-tab records while keeping the epoch allocator monotonic', async () => {
    await tracker.seed(42, frames);
    await tracker.seed(43, [frames[0]]);
    const other = await tracker.getCursor(43, 0);
    await tracker.removeTab(42);
    expect(await tracker.getCursor(42, 0)).toBeNull();
    expect(await tracker.getCursor(43, 0)).toEqual(other);
    await tracker.seed(42, [frames[0]]);
    expect((await tracker.getCursor(42, 0)).documentEpoch).toBeGreaterThan(other.documentEpoch);
  });

  it('serializes capture and persistence even when storage initialization is pending', async () => {
    let release;
    storage.get.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const seed = tracker.seed(42, frames);
    const away = tracker.capture(42, 0, 'https://example.com/b');
    const back = tracker.capture(42, 0, frames[0].url);
    await Promise.resolve();
    release({});
    await seed;
    expect((await away).routeRevision).toBe(1);
    expect((await back).routeRevision).toBe(2);
    expect(storage.get).toHaveBeenCalledOnce();
  });

  it('does not publish a cursor when initialization or persistence fails', async () => {
    storage.get.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(tracker.seed(42, frames)).rejects.toThrow();
    await tracker.seed(42, frames);
    storage.set.mockRejectedValueOnce(new Error('write failed'));
    await expect(tracker.capture(42, 0, 'https://example.com/b')).rejects.toThrow();
    storage.set.mockRejectedValueOnce(new Error('still failed'));
    await expect(tracker.getCursor(42, 0)).rejects.toThrow();
    expect((await tracker.getCursor(42, 0)).routeRevision).toBe(1);
    expect((await tracker.capture(42, 0, frames[0].url)).routeRevision).toBe(2);
  });

  it('fails closed for corrupted persisted counters instead of reusing an epoch', async () => {
    saved = { pageTranslationNavigation: { nextDocumentEpoch: 0, frames: { '42:0': { documentEpoch: 9, routeRevision: 0, url: frames[0].url } } } };
    await expect(tracker.seed(42, frames)).rejects.toThrow('Invalid Page navigation storage');
    expect(storage.set).not.toHaveBeenCalled();
  });
});
