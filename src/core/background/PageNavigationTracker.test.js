import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageNavigationTracker } from './PageNavigationTracker.js';
import browser from 'webextension-polyfill';

vi.mock('webextension-polyfill', () => ({ default: { webNavigation: { getFrame: vi.fn() } } }));

describe('Page navigation producer cursor', () => {
  let saved;
  let storage;
  let tracker;
  const frames = [{ frameId: 0, url: 'https://example.com/a' }, { frameId: 7, url: 'https://frame.example/a' }];
  const grantManual = (operationRevision, options = {}) => tracker.grantManualContinuity(
    42, operationRevision, { topDocumentToken: 'top-document-token', ...options },
  );

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

  it('mints volatile restart fences and bootstraps only the requested top frame cursor', async () => {
    const firstFence = tracker.mintRestartFence(42);
    const secondFence = tracker.mintRestartFence(42);
    expect(firstFence).not.toBe(secondFence);
    expect(tracker.getRestartFence(42)).toBe(secondFence);

    const cursor = await tracker.captureTopNavigation(42, 'https://example.com/first-rule-route');
    expect(cursor).toMatchObject({ routeRevision: 0, url: 'https://example.com/first-rule-route' });
    expect(await tracker.getCursor(42, 7)).toBeNull();
    tracker.revokeRestartFence(42);
    expect(tracker.getRestartFence(42)).not.toBe(secondFence);
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

  it('persists a document-scoped manual grant and restores it after worker restart', async () => {
    await tracker.seed(42, frames);
    const grant = await grantManual();
    await tracker.armManualContinuity(42, grant.generation);
    const armedGrant = await tracker.getManualContinuity(42);
    expect(grant).toMatchObject({
      generation: 1,
      revoked: false,
      topDocumentEpoch: (await tracker.getCursor(42, 0)).documentEpoch,
      frames: { 0: (await tracker.getCursor(42, 0)).documentEpoch, 7: (await tracker.getCursor(42, 7)).documentEpoch },
    });

    tracker = new PageNavigationTracker(storage);
    expect(await tracker.getManualContinuity(42)).toEqual(armedGrant);
    expect(await tracker.getManualContinuityStatus(42)).toMatchObject({
      hasManualContinuity: true,
      manualContinuityGeneration: 1,
    });
  });

  it('revokes an unarmed persisted grant during worker restart hydration', async () => {
    await tracker.seed(42, frames);
    const grant = await grantManual();
    expect(grant).toMatchObject({ generation: 1, armed: false, revoked: false });

    tracker = new PageNavigationTracker(storage);
    expect(await tracker.getManualContinuity(42)).toBeNull();
    expect(await tracker.getManualContinuityStatus(42)).toMatchObject({
      hasManualContinuity: false,
      manualContinuityGeneration: grant.generation + 1,
    });
    expect(saved.pageTranslationNavigation.manualContinuity[42]).toEqual({
      generation: grant.generation + 1,
      revoked: true,
    });
  });

  it('reuses an accepted manual grant for a duplicate start instead of rotating its generation', async () => {
    await tracker.seed(42, frames);
    const first = await grantManual();
    await tracker.armManualContinuity(42, first.generation);
    const duplicate = await grantManual();

    expect(duplicate).toMatchObject({ ...first, armed: true });
    expect(saved.pageTranslationNavigation.manualContinuity[42]).toEqual(duplicate);
  });

  it('does not reuse an unarmed provisional grant for a new start owner', async () => {
    await tracker.seed(42, frames);
    const provisional = await grantManual();
    const replacement = await grantManual();

    expect(provisional).toMatchObject({ generation: 1, armed: false });
    expect(replacement).toMatchObject({ generation: 2, armed: false, revoked: false });
    expect(replacement.generation).toBeGreaterThan(provisional.generation);
  });

  it('durably arms an accepted grant and enrolls a new child without changing generation', async () => {
    await tracker.seed(42, [{ frameId: 0, url: frames[0].url }]);
    const grant = await grantManual(undefined, { provider: 'deepL', targetLanguage: 'fr', isExplicitProvider: true });
    expect(await tracker.admitManualFrame(
      42, 9, grant.generation, grant.topDocumentEpoch, grant.topDocumentToken, 'https://nested.example/', 'token'
    ))
      .toBeNull();
    expect(await tracker.armManualContinuity(42, grant.generation)).toBe(true);
    const admission = await tracker.admitManualFrame(
      42, 9, grant.generation, grant.topDocumentEpoch, grant.topDocumentToken, 'https://nested.example/', 'token'
    );
    expect(admission).toMatchObject({
      alreadyAdmitted: false,
      grant: { generation: grant.generation, provider: 'deepL', targetLanguage: 'fr', isExplicitProvider: true },
      cursor: { url: 'https://nested.example/' },
    });
    expect((await tracker.admitManualFrame(
      42, 9, grant.generation, grant.topDocumentEpoch, grant.topDocumentToken, 'https://nested.example/', 'token'
    )).alreadyAdmitted).toBe(true);
    expect(await tracker.getManualContinuity(42)).toMatchObject({ generation: grant.generation, armed: true });
  });

  it('fails closed when Stop races with a pending child admission', async () => {
    await tracker.seed(42, [{ frameId: 0, url: frames[0].url }]);
    const grant = await grantManual();
    await tracker.armManualContinuity(42, grant.generation);
    const revision = tracker.blockManualContinuity(42);
    expect(await tracker.admitManualFrame(
      42, 9, grant.generation, grant.topDocumentEpoch, grant.topDocumentToken, 'https://nested.example/', 'token'
    )).toBeNull();
    await tracker.revokeManualContinuity(42, grant.generation, revision);
    expect(await tracker.getManualContinuity(42)).toBeNull();
  });

  it('rehydrates an armed grant and its exact child-document ticket across worker restart', async () => {
    await tracker.seed(42, [{ frameId: 0, url: frames[0].url }]);
    const grant = await grantManual();
    await tracker.armManualContinuity(42, grant.generation);
    const admission = await tracker.admitManualFrame(
      42, 9, grant.generation, grant.topDocumentEpoch, grant.topDocumentToken, 'https://nested.example/', 'doc-1'
    );
    tracker = new PageNavigationTracker(storage);
    expect(await tracker.getManualContinuity(42)).toMatchObject({ armed: true, generation: grant.generation });
    expect(await tracker.claimManualFrameStart(
      42, 9, grant.generation, grant.topDocumentEpoch, grant.topDocumentToken, admission.cursor, 'doc-1'
    )).toBe(true);
    expect((await tracker.getManualContinuity(42)).startedDocuments).toBeUndefined();
    expect(await tracker.completeManualFrameStart(
      42, 9, grant.generation, grant.topDocumentEpoch, grant.topDocumentToken, admission.cursor, 'doc-1', true
    )).toBe(true);
    expect(await tracker.claimManualFrameStart(
      42, 9, grant.generation, grant.topDocumentEpoch, grant.topDocumentToken, admission.cursor, 'doc-1'
    )).toBe(false);
    expect((await tracker.getManualContinuity(42)).startedDocuments).toEqual({ 9: 'doc-1' });
  });

  it('releases a rejected start claim so the same document can retry', async () => {
    await tracker.seed(42, [{ frameId: 0, url: frames[0].url }]);
    const grant = await grantManual();
    await tracker.armManualContinuity(42, grant.generation);
    const admission = await tracker.admitManualFrame(
      42, 9, grant.generation, grant.topDocumentEpoch, grant.topDocumentToken, 'https://nested.example/', 'doc-1'
    );
    const claim = () => tracker.claimManualFrameStart(
      42, 9, grant.generation, grant.topDocumentEpoch, grant.topDocumentToken, admission.cursor, 'doc-1'
    );
    expect(await claim()).toBe(true);
    expect(await tracker.completeManualFrameStart(
      42, 9, grant.generation, grant.topDocumentEpoch, grant.topDocumentToken, admission.cursor, 'doc-1', false
    )).toBe(false);
    expect((await tracker.getManualContinuity(42)).startedDocuments).toBeUndefined();
    expect(await claim()).toBe(true);
  });

  it('tracks a committed untracked nested child for admission without rotating the parent grant', async () => {
    await tracker.seed(42, [{ frameId: 0, url: frames[0].url }]);
    const grant = await grantManual();
    await tracker.armManualContinuity(42, grant.generation);
    await tracker.committed(42, 19, 'https://nested.example/');
    const committed = await tracker.getCursor(42, 19);
    expect(committed).toBeTruthy();
    const admission = await tracker.admitManualFrame(
      42, 19, grant.generation, grant.topDocumentEpoch, grant.topDocumentToken, committed.url, 'nested-token'
    );
    expect(admission.cursor).toEqual(committed);
    expect(admission.grant.generation).toBe(grant.generation);
    await tracker.committed(42, 0, 'https://example.com/replaced');
    expect(await tracker.getManualContinuity(42)).toBeNull();
  });

  it.each(['reload', 'removal'])('retains an active grant across child %s while frame authorization stays scoped', async change => {
    await tracker.seed(42, frames);
    const grant = await grantManual();
    await tracker.armManualContinuity(42, grant.generation);
    const topCursor = await tracker.getCursor(42, 0);
    const oldChildCursor = await tracker.getCursor(42, 7);
    if (change === 'reload') await tracker.committed(42, 7, 'https://frame.example/reloaded');
    else await tracker.seed(42, [frames[0]]);

    const duplicate = await grantManual();
    const changedChildCursor = await tracker.getCursor(42, 7) || oldChildCursor;

    expect(duplicate.generation).toBe(grant.generation);
    expect(duplicate.frames[7]).toBeUndefined();
    expect(await tracker.validateManualContinuityBatch(
      42, 0, grant.generation, grant.topDocumentEpoch, topCursor
    )).toBe(true);
    expect(await tracker.validateManualContinuityBatch(
      42, 7, grant.generation, grant.topDocumentEpoch, changedChildCursor
    )).toBe(false);
  });

  it('keeps another tab batch-valid while its unrelated storage mutation is dirty', async () => {
    await tracker.seed(42, frames);
    const grant = await grantManual();
    const cursor = await tracker.getCursor(42, 0);
    await tracker.seed(43, frames);
    let releaseWrite;
    storage.set.mockImplementationOnce(value => new Promise(resolve => {
      releaseWrite = () => {
        saved = structuredClone(value);
        resolve();
      };
    }));

    const unrelatedMutation = tracker.capture(43, 0, 'https://other.example/route');
    await vi.waitFor(() => expect(releaseWrite).toBeTypeOf('function'));
    expect(tracker.dirty).toBe(true);
    const storageReads = storage.get.mock.calls.length;
    const storageWrites = storage.set.mock.calls.length;
    const frameReads = browser.webNavigation.getFrame.mock.calls.length;

    expect(await tracker.validateManualContinuityBatch(
      42, 0, grant.generation, grant.topDocumentEpoch, cursor
    )).toBe(true);
    expect(storage.get).toHaveBeenCalledTimes(storageReads);
    expect(storage.set).toHaveBeenCalledTimes(storageWrites);
    expect(browser.webNavigation.getFrame).toHaveBeenCalledTimes(frameReads);

    releaseWrite();
    await unrelatedMutation;
  });

  it('keeps revocation closed on storage failure in-worker and documents the uncommitted restart boundary', async () => {
    await tracker.seed(42, frames);
    const provisional = await grantManual();
    await tracker.armManualContinuity(42, provisional.generation);
    const grant = await tracker.getManualContinuity(42);
    const revision = tracker.blockManualContinuity(42);
    storage.set.mockRejectedValueOnce(new Error('write rejected'));
    await expect(tracker.revokeManualContinuity(42, grant.generation, revision)).rejects.toThrow('write rejected');
    expect(await tracker.getManualContinuity(42)).toBeNull();
    expect(await tracker.getManualContinuityStatus(42)).toMatchObject({
      hasManualContinuity: true,
      manualContinuityRevocationPending: true,
    });

    tracker = new PageNavigationTracker(storage);
    expect(await tracker.getManualContinuity(42)).toEqual(grant);
  });

  it('does not let an old-generation internal revoke block a newer manual grant', async () => {
    await tracker.seed(42, frames);
    const oldGrant = await grantManual();
    tracker.blockManualContinuity(42, oldGrant.generation);
    const newGrant = await grantManual();
    expect(newGrant.generation).toBeGreaterThan(oldGrant.generation);
    expect(await tracker.revokeManualContinuity(42, oldGrant.generation)).toBeNull();
    expect(await tracker.getManualContinuity(42)).toEqual(newGrant);
  });

  it('durably revokes a restored grant when its operation revision is uninitialized', async () => {
    await tracker.seed(42, frames);
    const provisional = await grantManual();
    await tracker.armManualContinuity(42, provisional.generation);
    const grant = await tracker.getManualContinuity(42);
    const restartedTracker = new PageNavigationTracker(storage);
    const revision = restartedTracker.blockManualContinuity(42, grant.generation);

    expect(revision).toBe(0);
    await expect(restartedTracker.revokeManualContinuity(42, grant.generation, revision))
      .resolves.toBe(grant.generation + 1);

    const replacementTracker = new PageNavigationTracker(storage);
    expect(await replacementTracker.getManualContinuity(42)).toBeNull();
    expect(await replacementTracker.getManualContinuityStatus(42)).toMatchObject({
      hasManualContinuity: false,
      manualContinuityGeneration: grant.generation + 1,
    });
  });

  it('does not let an older reserved Manual Start commit after a newer start', async () => {
    await tracker.seed(42, frames);
    const olderStart = tracker.reserveManualContinuityStart(42);
    const newerStart = tracker.reserveManualContinuityStart(42);
    const grant = await grantManual(newerStart);

    await expect(grantManual(olderStart)).rejects.toThrow('Manual continuity start superseded');
    expect(await tracker.getManualContinuity(42)).toEqual(grant);
  });

  it('rejects a manual grant after a top document commit and after a child document replacement', async () => {
    await tracker.seed(42, frames);
    const grant = await grantManual();
    await tracker.committed(42, 7, 'https://frame.example/new-document');
    const newChildCursor = await tracker.getCursor(42, 7);
    expect(await tracker.validateManualContinuity(42, 7, grant.generation, grant.topDocumentEpoch, newChildCursor)).toBe(false);

    await tracker.committed(42, 0, 'https://example.com/reloaded');
    expect(await tracker.getManualContinuity(42)).toBeNull();
  });

  it('fails closed for a missing or malformed persisted manual grant', async () => {
    await tracker.seed(42, frames);
    expect(await tracker.getManualContinuity(42)).toBeNull();

    saved = {
      pageTranslationNavigation: {
        nextDocumentEpoch: 1,
        frames: { '42:0': { documentEpoch: 1, routeRevision: 0, url: frames[0].url } },
        manualContinuity: { 42: { generation: 1, revoked: false, topDocumentEpoch: 1, frames: { 0: 'bad' } } },
      },
    };
    tracker = new PageNavigationTracker(storage);
    await expect(tracker.getManualContinuity(42)).rejects.toThrow('Invalid Page navigation storage');
  });

  it('revokes legacy grants that cannot prove the bound top-document identity', async () => {
    saved = {
      pageTranslationNavigation: {
        nextDocumentEpoch: 1,
        frames: { '42:0': { documentEpoch: 1, routeRevision: 0, url: frames[0].url } },
        manualContinuity: { 42: { generation: 4, revoked: false, topDocumentEpoch: 1, frames: { 0: 1 } } },
      },
    };
    tracker = new PageNavigationTracker(storage);

    expect(await tracker.getManualContinuity(42)).toBeNull();
    expect(saved.pageTranslationNavigation.manualContinuity[42]).toEqual({ generation: 5, revoked: true });
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
