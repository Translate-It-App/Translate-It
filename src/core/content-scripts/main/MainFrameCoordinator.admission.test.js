import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pageEventBus } from '@/core/PageEventBus.js';
import { MainFrameAggregator } from './MainFrameAggregator.js';
import { MainFrameCoordinator } from './MainFrameCoordinator.js';

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    init: vi.fn()
  }))
}));

const MessageActions = {
  PAGE_TRANSLATE: 'PAGE_TRANSLATE',
  PAGE_RESTORE: 'PAGE_RESTORE',
  PAGE_TRANSLATE_START: 'PAGE_TRANSLATE_START',
  PAGE_TRANSLATE_PROGRESS: 'PAGE_TRANSLATE_PROGRESS',
  PAGE_TRANSLATE_COMPLETE: 'PAGE_TRANSLATE_COMPLETE',
  PAGE_TRANSLATE_IDLE: 'PAGE_TRANSLATE_IDLE',
  PAGE_AUTO_RESTORE_COMPLETE: 'PAGE_AUTO_RESTORE_COMPLETE',
  PAGE_RESTORE_COMPLETE: 'PAGE_RESTORE_COMPLETE',
  PAGE_TRANSLATE_ERROR: 'PAGE_TRANSLATE_ERROR',
  PAGE_TRANSLATE_STOP_AUTO: 'PAGE_TRANSLATE_STOP_AUTO',
  PAGE_TRANSLATE_CANCELLED: 'PAGE_TRANSLATE_CANCELLED',
  PAGE_RESTORE_ERROR: 'PAGE_RESTORE_ERROR',
  PAGE_TRANSLATION_FRAME_RETIRED: 'PAGE_TRANSLATION_FRAME_RETIRED',
  PAGE_TRANSLATION_FRAME_LIFECYCLE_ACTIONS: [
    'PAGE_TRANSLATE_START',
    'PAGE_TRANSLATE_PROGRESS',
    'PAGE_TRANSLATE_COMPLETE',
    'PAGE_TRANSLATE_IDLE',
    'PAGE_TRANSLATE_ERROR',
    'PAGE_RESTORE_COMPLETE',
    'PAGE_AUTO_RESTORE_COMPLETE',
    'PAGE_TRANSLATE_CANCELLED',
    'PAGE_RESTORE_ERROR',
    'PAGE_TRANSLATION_FRAME_RETIRED',
  ],
  PAGE_TRANSLATION_AGGREGATE_ACTIONS: [
    'PAGE_TRANSLATE_START',
    'PAGE_TRANSLATE_PROGRESS',
    'PAGE_TRANSLATE_COMPLETE',
    'PAGE_TRANSLATE_IDLE',
    'PAGE_TRANSLATE_ERROR',
    'PAGE_RESTORE_COMPLETE',
    'PAGE_AUTO_RESTORE_COMPLETE',
  ],
};

describe('MainFrameCoordinator per-frame admission', () => {
  let aggregator;

  beforeAll(() => {
    aggregator = new MainFrameAggregator(MessageActions);
    new MainFrameCoordinator(aggregator, MessageActions, null);
  });

  beforeEach(() => {
    aggregator.clearAll();
  });

  it('preserves existing aggregate state when PAGE_TRANSLATE is only intent', () => {
    aggregator.updateFrameData(0, {
      isTranslated: true,
      isTranslating: false,
      translatedCount: 5,
      failedCount: 0,
      totalCount: 5,
      status: 'idle'
    });

    pageEventBus.emit(MessageActions.PAGE_TRANSLATE, { isAuto: false });

    expect(aggregator.getGlobalPageTranslationStatus()).toMatchObject({
      isTranslated: true,
      isTranslating: false,
      translatedCount: 5
    });
  });

  it('assigns an increasing document-scoped revision that frame data cannot override', () => {
    const first = aggregator.emitAggregateProgress(MessageActions.PAGE_TRANSLATE_PROGRESS, {
      aggregateScope: 'frame-spoof',
      aggregateRevision: -1,
      url: 'https://frame.example/child',
      topLevelUrl: 'https://spoof.example/',
    });
    aggregator.clearAll();
    const second = aggregator.emitAggregateProgress(MessageActions.PAGE_TRANSLATE_IDLE, {
      aggregateScope: 'frame-spoof',
      aggregateRevision: -1,
    });

    expect(first.aggregateScope).not.toBe('frame-spoof');
    expect(first.url).toBe('https://frame.example/child');
    expect(first.topLevelUrl).toBe(window.location.href);
    expect(second.aggregateScope).toBe(first.aggregateScope);
    expect(first.aggregateRevision).toBeGreaterThan(0);
    expect(second.aggregateRevision).toBeGreaterThan(first.aggregateRevision);
  });

  it('preserves main state when iframe accepts after main rejection', () => {
    aggregator.updateFrameData(0, {
      isTranslated: true,
      isTranslating: false,
      translatedCount: 5,
      failedCount: 0,
      totalCount: 5,
      status: 'idle'
    });

    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: {
        frameUrl: 'https://frame.example/',
        messageId: 'iframe-session',
        sessionId: 'iframe-session',
        isAutoTranslating: false,
      },
    });

    expect(aggregator.getGlobalPageTranslationStatus()).toMatchObject({
      isTranslated: true,
      isTranslating: true,
      translatedCount: 5
    });
  });

  it('stores trusted lifecycle state under numeric browser frame ID', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { sessionId: 'frame-session' },
    });

    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_PROGRESS,
      data: {
        sessionId: 'frame-session',
        translatedCount: 2,
        totalCount: 3,
        frameId: 99,
        frameUrl: 'https://other-frame.example',
      },
    });

    expect(aggregator.frameProgressMap.get(7)).toMatchObject({
      translatedCount: 2,
      totalCount: 3,
    });
    expect(aggregator.frameProgressMap.has(99)).toBe(false);
    expect(aggregator.frameProgressMap.has('https://other-frame.example')).toBe(false);
  });

  it('keeps idle manual continuity independent of DOM watching and Restore', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    for (const frameId of [0, 7]) {
      const sessionId = `manual-${frameId}`;
      coordinator.handleTrustedPageLifecycle({
        frameId, action: MessageActions.PAGE_TRANSLATE_START,
        data: { sessionId, hasManualContinuity: true, manualContinuityGeneration: 1 },
      });
      coordinator.handleTrustedPageLifecycle({
        frameId, action: MessageActions.PAGE_TRANSLATE_IDLE,
        data: { sessionId, translatedCount: 0, isTranslated: frameId === 7 },
      });
    }
    expect(aggregator.getGlobalPageTranslationStatus()).toMatchObject({
      hasManualContinuity: true, isAutoTranslating: false, isTranslating: false, isTranslated: true,
    });
    for (const frameId of [0, 7]) {
      coordinator.handleTrustedPageLifecycle({
        frameId, action: MessageActions.PAGE_AUTO_RESTORE_COMPLETE,
        data: { sessionId: `manual-${frameId}`, hasManualContinuity: false },
      });
      expect(aggregator.getGlobalPageTranslationStatus()).toMatchObject({
        hasManualContinuity: frameId === 0, isTranslated: true,
      });
    }
  });

  it('does not display continuity from a frame that missed durable Stop', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    for (const frameId of [0, 7]) {
      coordinator.handleTrustedPageLifecycle({
        frameId, action: MessageActions.PAGE_TRANSLATE_START,
        data: { sessionId: `manual-${frameId}`, hasManualContinuity: true, manualContinuityGeneration: 1 },
      });
    }
    coordinator.handleTrustedPageLifecycle({
      frameId: 0, action: MessageActions.PAGE_AUTO_RESTORE_COMPLETE,
      data: { sessionId: 'manual-0', hasManualContinuity: false, manualContinuityGeneration: 2 },
    });
    coordinator.handleTrustedPageLifecycle({
      frameId: 7, action: MessageActions.PAGE_TRANSLATE_IDLE,
      data: { sessionId: 'manual-7', hasManualContinuity: true, manualContinuityGeneration: 1, isTranslated: true },
    });
    expect(aggregator.getGlobalPageTranslationStatus()).toMatchObject({
      hasManualContinuity: false, manualContinuityGeneration: 2, isTranslated: true,
    });
  });

  it('retires owner and aggregate row on trusted frame retirement', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { sessionId: 'old-session' },
    });

    const result = coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATION_FRAME_RETIRED,
    });

    expect(result).toEqual({ success: true, retired: true });
    expect(coordinator.frameSessionOwners.has(7)).toBe(false);
    expect(aggregator.frameProgressMap.has(7)).toBe(false);
  });

  it('makes repeated frame retirement idempotent', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { sessionId: 'old-session' },
    });

    expect(coordinator.retireFrame(7)).toEqual({ success: true, retired: true });
    expect(coordinator.retireFrame(7)).toEqual({ success: true, retired: true });
    expect(coordinator.frameSessionOwners.has(7)).toBe(false);
    expect(aggregator.frameProgressMap.has(7)).toBe(false);
  });

  it('retires frame for matching session-scoped unload retirement', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { sessionId: 'session-a' },
    });

    expect(coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATION_FRAME_RETIRED,
      data: { sessionId: 'session-a' },
    })).toEqual({ success: true, retired: true });
    expect(coordinator.frameSessionOwners.has(7)).toBe(false);
    expect(aggregator.frameProgressMap.has(7)).toBe(false);
  });

  it('ignores late unload retirement from replaced session', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { sessionId: 'session-a' },
    });
    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { sessionId: 'session-b' },
    });

    expect(coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATION_FRAME_RETIRED,
      data: { sessionId: 'session-a' },
    })).toEqual({ success: true, ignored: true, reason: 'stale-session' });
    expect(coordinator.frameSessionOwners.get(7)).toBe('session-b');
    expect(aggregator.frameProgressMap.has(7)).toBe(true);
  });

  it('keeps browser navigation retirement unconditional after replacement', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { sessionId: 'session-a' },
    });
    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { sessionId: 'session-b' },
    });

    expect(coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATION_FRAME_RETIRED,
    })).toEqual({ success: true, retired: true });
    expect(coordinator.frameSessionOwners.has(7)).toBe(false);
    expect(aggregator.frameProgressMap.has(7)).toBe(false);
  });

  it('keeps navigation and unload retirement idempotent', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { sessionId: 'old-session' },
    });

    expect(coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATION_FRAME_RETIRED,
    })).toEqual({ success: true, retired: true });
    expect(coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATION_FRAME_RETIRED,
    })).toEqual({ success: true, retired: true });
    expect(coordinator.frameSessionOwners.has(7)).toBe(false);
    expect(aggregator.frameProgressMap.has(7)).toBe(false);
  });

  it('allows replacement session to register on retired numeric frame ID', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { sessionId: 'old-session' },
    });
    coordinator.retireFrame(7);

    const result = coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { sessionId: 'replacement-session' },
    });

    expect(result).toMatchObject({ success: true, aggregated: true });
    expect(coordinator.frameSessionOwners.get(7)).toBe('replacement-session');
    expect(aggregator.frameProgressMap.has(7)).toBe(true);
  });

  it('ignores late lifecycle from retired session', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { sessionId: 'old-session' },
    });
    coordinator.retireFrame(7);

    const result = coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_PROGRESS,
      data: { sessionId: 'old-session', translatedCount: 99 },
    });

    expect(result).toEqual({ success: true, ignored: true, reason: 'stale-session' });
    expect(coordinator.frameSessionOwners.has(7)).toBe(false);
    expect(aggregator.frameProgressMap.has(7)).toBe(false);
  });

  it('marks aggregate stopped only after trusted Stop lifecycle from every active frame', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({ frameId: 0, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'main-session' } });
    coordinator.handleTrustedPageLifecycle({ frameId: 1, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'child-session' } });
    aggregator.updateFrameData(0, {
      isTranslated: true,
      isTranslating: true,
      isAutoTranslating: true,
      translatedCount: 2,
      totalCount: 3,
      status: 'translating',
    });
    aggregator.updateFrameData(1, {
      isTranslated: true,
      isTranslating: true,
      isAutoTranslating: true,
      translatedCount: 1,
      totalCount: 2,
      status: 'translating',
    });

    coordinator.handleTrustedPageLifecycle({
      frameId: 0,
      action: MessageActions.PAGE_AUTO_RESTORE_COMPLETE,
      data: { sessionId: 'main-session', translatedCount: 2, isTranslated: true, isAutoTranslating: false },
    });
    coordinator.handleTrustedPageLifecycle({
      frameId: 1,
      action: MessageActions.PAGE_AUTO_RESTORE_COMPLETE,
      data: { sessionId: 'child-session', translatedCount: 1, isTranslated: true, isAutoTranslating: false },
    });

    expect(aggregator.getGlobalPageTranslationStatus()).toMatchObject({
      isTranslating: false,
      isAutoTranslating: false,
      isTranslated: true,
      translatedCount: 3,
    });
  });

  it('keeps Restore available for an interrupted replacement before any retained nodes are counted', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    const emitSpy = vi.spyOn(pageEventBus, 'emit');
    coordinator.handleTrustedPageLifecycle({ frameId: 0, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'replacement' } });
    coordinator.handleTrustedPageLifecycle({ frameId: 1, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'child' } });
    coordinator.handleTrustedPageLifecycle({
      frameId: 0,
      action: MessageActions.PAGE_AUTO_RESTORE_COMPLETE,
      data: { sessionId: 'replacement', translatedCount: 0, isTranslated: true, isAutoTranslating: false },
    });
    coordinator.handleTrustedPageLifecycle({
      frameId: 1,
      action: MessageActions.PAGE_AUTO_RESTORE_COMPLETE,
      data: { sessionId: 'child', translatedCount: 0, isTranslated: false, isAutoTranslating: false },
    });

    const aggregate = emitSpy.mock.calls.at(-1);
    emitSpy.mockRestore();
    expect(aggregate).toEqual([
      MessageActions.PAGE_AUTO_RESTORE_COMPLETE,
      expect.objectContaining({ isTranslated: true, isTranslating: false, translatedCount: 0 }),
    ]);
  });

  it.each([
    ['PAGE_TRANSLATE_COMPLETE', MessageActions.PAGE_TRANSLATE_COMPLETE],
    ['PAGE_TRANSLATE_IDLE', MessageActions.PAGE_TRANSLATE_IDLE],
    ['PAGE_TRANSLATE_ERROR', MessageActions.PAGE_TRANSLATE_ERROR],
    ['PAGE_AUTO_RESTORE_COMPLETE', MessageActions.PAGE_AUTO_RESTORE_COMPLETE],
  ])('preserves Restore availability through %s when progress is zero', (label, action) => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    const emitAggregate = vi.spyOn(aggregator, 'emitAggregateProgress');
    coordinator.handleTrustedPageLifecycle({
      frameId: 0,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { sessionId: `${label}-session` },
    });

    const data = {
      sessionId: `${label}-session`,
      translatedCount: 0,
      failedCount: 0,
      totalCount: 0,
      isTranslated: true,
      isTranslating: false,
      isAutoTranslating: false,
    };
    coordinator.handleTrustedPageLifecycle({ frameId: 0, action, data });

    expect(aggregator.getGlobalPageTranslationStatus()).toMatchObject({
      isTranslated: true,
      translatedCount: 0,
    });
    expect(emitAggregate).toHaveBeenLastCalledWith(action, data);
    expect(emitAggregate.mock.results.at(-1).value).toMatchObject({
      isTranslated: true,
      translatedCount: 0,
    });
    emitAggregate.mockRestore();
  });

  it('preserves retained content when a replacement START resets progress counters', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    const emitAggregate = vi.spyOn(aggregator, 'emitAggregateProgress');

    coordinator.handleTrustedPageLifecycle({
      frameId: 0,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { sessionId: 'replacement-start', isTranslated: true },
    });

    expect(aggregator.getGlobalPageTranslationStatus()).toMatchObject({
      isTranslated: true,
      translatedCount: 0,
    });
    expect(emitAggregate.mock.results.at(-1).value).toMatchObject({
      isTranslated: true,
      translatedCount: 0,
    });
    emitAggregate.mockRestore();
  });

  it('preserves iframe state when main frame accepts a new cycle', () => {
    aggregator.updateFrameData(1, {
      isTranslated: true,
      isTranslating: false,
      translatedCount: 2,
      failedCount: 0,
      totalCount: 2,
      status: 'idle'
    });

    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({
      frameId: 0,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: {
        messageId: 'main-session',
        sessionId: 'main-session',
        isAutoTranslating: false,
      },
    });

    expect(aggregator.getGlobalPageTranslationStatus()).toMatchObject({
      isTranslated: true,
      isTranslating: true,
      translatedCount: 2
    });
  });

  it('keeps iframe state when main START is followed by main ERROR', () => {
    aggregator.updateFrameData(1, {
      isTranslated: true,
      isTranslating: false,
      translatedCount: 3,
      failedCount: 0,
      totalCount: 3,
      status: 'idle'
    });

    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({
      frameId: 0,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { messageId: 'main-session', sessionId: 'main-session', isAutoTranslating: false },
    });
    coordinator.handleTrustedPageLifecycle({
      frameId: 0,
      action: MessageActions.PAGE_TRANSLATE_ERROR,
      data: { sessionId: 'main-session', error: 'main failure', isFatal: true },
    });

    expect(aggregator.getGlobalPageTranslationStatus()).toMatchObject({
      isTranslated: true,
      isTranslating: false,
      translatedCount: 3
    });
  });

  it('keeps a translating frame active through a nonfatal error until its session completes', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    const emitSpy = vi.spyOn(pageEventBus, 'emit');
    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { sessionId: 'child-session' },
    });

    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_ERROR,
      data: { sessionId: 'child-session', error: 'batch failed', isFatal: false, failedCount: 1, totalCount: 3 },
    });

    const errorAggregate = emitSpy.mock.calls
      .filter(([action]) => action === MessageActions.PAGE_TRANSLATE_ERROR)
      .at(-1)?.[1];
    expect(errorAggregate).toMatchObject({
      isAggregated: true,
      isTranslating: true,
      failedCount: 1,
      totalCount: 3,
      isFatal: false,
    });
    expect(aggregator.frameProgressMap.get(7)).toMatchObject({ isTranslating: true, status: 'translating' });

    expect(coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_PROGRESS,
      data: { sessionId: 'child-session', translatedCount: 1, failedCount: 1, totalCount: 3 },
    })).toMatchObject({ success: true, aggregated: true });
    expect(aggregator.getGlobalPageTranslationStatus().isTranslating).toBe(true);

    expect(coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_COMPLETE,
      data: { sessionId: 'child-session', translatedCount: 2, failedCount: 1, totalCount: 3 },
    })).toMatchObject({ success: true, aggregated: true });
    expect(aggregator.frameProgressMap.get(7)).toMatchObject({ isTranslating: false, status: 'idle', translatedCount: 2 });
    expect(aggregator.getGlobalPageTranslationStatus().isTranslating).toBe(false);
    emitSpy.mockRestore();
  });

  it('stops only the fatal frame when another frame is still translating', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'failed-session' } });
    coordinator.handleTrustedPageLifecycle({ frameId: 8, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'active-session' } });

    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_ERROR,
      data: { sessionId: 'failed-session', error: 'fatal failure', isFatal: true },
    });

    expect(aggregator.frameProgressMap.get(7)).toMatchObject({ isTranslating: false, status: 'error' });
    expect(aggregator.frameProgressMap.get(8)).toMatchObject({ isTranslating: true, status: 'translating' });
    expect(aggregator.getGlobalPageTranslationStatus().isTranslating).toBe(true);
  });

  it('clears auto-translating only on the fatal frame when another frame is idle and auto-translating', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { sessionId: 'failed-auto-session', isAutoTranslating: true },
    });
    aggregator.updateFrameData(8, { isTranslating: false, isAutoTranslating: true, status: 'idle' });

    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_ERROR,
      data: { sessionId: 'failed-auto-session', error: 'fatal failure', isFatal: true },
    });

    expect(aggregator.frameProgressMap.get(7)).toMatchObject({ isTranslating: false, isAutoTranslating: false });
    expect(aggregator.frameProgressMap.get(8)).toMatchObject({ isTranslating: false, isAutoTranslating: true, status: 'idle' });
    expect(aggregator.getGlobalPageTranslationStatus()).toMatchObject({ isTranslating: false, isAutoTranslating: true });
  });

  it('clears aggregate auto-translating when the sole auto-translating frame fails fatally', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { sessionId: 'sole-auto-session', isAutoTranslating: true },
    });

    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_ERROR,
      data: { sessionId: 'sole-auto-session', error: 'fatal failure', isFatal: true },
    });

    expect(aggregator.frameProgressMap.get(7)).toMatchObject({ isTranslating: false, isAutoTranslating: false });
    expect(aggregator.getGlobalPageTranslationStatus()).toMatchObject({ isTranslating: false, isAutoTranslating: false });
  });

  it('does not reactivate an explicitly idle frame for a nonfatal error', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'idle-session' } });
    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_IDLE, data: { sessionId: 'idle-session' } });

    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_ERROR,
      data: { sessionId: 'idle-session', error: 'late batch failure', isFatal: false },
    });

    expect(aggregator.frameProgressMap.get(7)).toMatchObject({ isTranslating: false, status: 'idle' });
    expect(aggregator.getGlobalPageTranslationStatus().isTranslating).toBe(false);
  });

  it('emits main fatal errors with aggregate counts and frame error identity', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({ frameId: 0, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'main-session' } });
    aggregator.updateFrameData(0, {
      isTranslated: false,
      isTranslating: true,
      translatedCount: 0,
      failedCount: 0,
      totalCount: 3,
      status: 'translating'
    });
    aggregator.updateFrameData(1, {
      isTranslated: true,
      isTranslating: false,
      translatedCount: 3,
      failedCount: 0,
      totalCount: 3,
      status: 'idle'
    });

    const emitSpy = vi.spyOn(pageEventBus, 'emit');
    const errorDetails = { type: 'NETWORK_ERROR', message: 'network failure' };

    coordinator.handleTrustedPageLifecycle({
      frameId: 0,
      action: MessageActions.PAGE_TRANSLATE_ERROR,
      data: {
        sessionId: 'main-session',
        error: 'network failure',
        errorDetails,
        errorType: 'NETWORK_ERROR',
        isFatal: true,
      },
    });

    const aggregateCall = emitSpy.mock.calls.find(([, data]) => (
      data?.isAggregated === true && data.errorDetails === errorDetails
    ));
    expect(aggregateCall?.[0]).toBe(MessageActions.PAGE_TRANSLATE_ERROR);
    expect(aggregateCall?.[1]).toMatchObject({
      isAggregated: true,
      errorDetails,
      translatedCount: 3,
      failedCount: 0,
      totalCount: 6,
      isTranslating: false,
      isFatal: true
    });

    emitSpy.mockRestore();
  });

  it('emits a fatal discovery error aggregate with stopped and partial translation counts', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({ frameId: 0, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'A0', isAutoTranslating: true } });
    aggregator.updateFrameData(0, {
      isTranslated: true,
      isTranslating: true,
      isAutoTranslating: true,
      translatedCount: 2,
      failedCount: 1,
      totalCount: 3,
      status: 'translating',
    });

    const emitSpy = vi.spyOn(pageEventBus, 'emit');
    coordinator.handleTrustedPageLifecycle({
      frameId: 0,
      action: MessageActions.PAGE_TRANSLATE_ERROR,
      data: {
        sessionId: 'A0',
        error: 'enumeration failed',
        errorDetails: { type: 'TRANSLATION_FAILED', message: 'enumeration failed' },
        translatedCount: 2,
        failedCount: 1,
        totalCount: 3,
        isTranslated: true,
        isTranslating: false,
        isAutoTranslating: false,
      },
    });

    const errorAggregate = emitSpy.mock.calls
      .filter(([action]) => action === MessageActions.PAGE_TRANSLATE_ERROR)
      .at(-1)?.[1];
    expect(errorAggregate).toMatchObject({
      isAggregated: true,
      error: 'enumeration failed',
      translatedCount: 2,
      failedCount: 1,
      totalCount: 3,
      isTranslating: false,
      isAutoTranslating: false,
      isTranslated: true,
    });
    emitSpy.mockRestore();

    const status = aggregator.getGlobalPageTranslationStatus();
    expect(status.isTranslating).toBe(false);
    expect(status.isAutoTranslating).toBe(false);
    expect(status.isTranslated).toBe(true);
    expect(status.translatedCount).toBe(2);
    expect(status.failedCount).toBe(1);
    expect(status.totalCount).toBe(3);
    // Restore stays available while the retained partial translation is kept.
    expect(status.isTranslated && !status.isTranslating).toBe(true);
  });

  it('keeps main committed output in an iframe fatal aggregate error', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({ frameId: 1, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'child-session' } });
    aggregator.updateFrameData(0, {
      isTranslated: true,
      isTranslating: false,
      translatedCount: 5,
      failedCount: 0,
      totalCount: 5,
      status: 'idle'
    });
    aggregator.updateFrameData(1, {
      isTranslated: false,
      isTranslating: true,
      translatedCount: 0,
      failedCount: 0,
      totalCount: 1,
      status: 'translating'
    });

    const emitSpy = vi.spyOn(pageEventBus, 'emit');
    const errorDetails = { type: 'NETWORK_ERROR', message: 'iframe failure' };

    coordinator.handleTrustedPageLifecycle({
      frameId: 1,
      action: MessageActions.PAGE_TRANSLATE_ERROR,
      data: {
        sessionId: 'child-session',
        frameUrl: 'frame-1',
        error: 'iframe failure',
        errorDetails,
        errorType: 'NETWORK_ERROR',
        translatedCount: 0,
        isFatal: true,
      },
    });

    const aggregateCall = emitSpy.mock.calls.find(([, data]) => (
      data?.isAggregated === true && data.errorDetails === errorDetails
    ));
    expect(aggregateCall?.[1]).toMatchObject({
      translatedCount: 5,
      isFatal: true,
      errorDetails
    });

    emitSpy.mockRestore();
  });

  it('keeps Restore available when an iframe fails after the main frame translated', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({ frameId: 1, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'child-session' } });
    aggregator.updateFrameData(0, {
      isTranslated: true,
      isTranslating: false,
      translatedCount: 5,
      failedCount: 0,
      totalCount: 5,
      status: 'idle'
    });
    aggregator.updateFrameData(1, {
      isTranslated: false,
      isTranslating: true,
      translatedCount: 0,
      failedCount: 0,
      totalCount: 1,
      status: 'translating'
    });

    const emitSpy = vi.spyOn(pageEventBus, 'emit');

    coordinator.handleTrustedPageLifecycle({
      frameId: 1,
      action: MessageActions.PAGE_TRANSLATE_ERROR,
      data: {
        sessionId: 'child-session',
        error: 'iframe failure',
        errorDetails: { type: 'NETWORK_ERROR', message: 'iframe failure' },
        translatedCount: 0,
        isTranslated: false,
        isFatal: true,
      },
    });

    const errorAggregate = emitSpy.mock.calls
      .filter(([action]) => action === MessageActions.PAGE_TRANSLATE_ERROR)
      .at(-1)?.[1];
    expect(errorAggregate).toMatchObject({
      isAggregated: true,
      translatedCount: 5,
      isTranslated: true,
      isTranslating: false,
    });
    emitSpy.mockRestore();

    const status = aggregator.getGlobalPageTranslationStatus();
    expect(status.isTranslated && !status.isTranslating).toBe(true);
  });

  it('replaces only one frame owner and rejects stale lifecycle before aggregation', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'A7' } });
    coordinator.handleTrustedPageLifecycle({ frameId: 8, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'A8' } });
    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'B7' } });

    const stale = coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_COMPLETE,
      data: { sessionId: 'A7', translatedCount: 99, totalCount: 99 },
    });
    coordinator.handleTrustedPageLifecycle({
      frameId: 8,
      action: MessageActions.PAGE_TRANSLATE_PROGRESS,
      data: { sessionId: 'A8', translatedCount: 2, totalCount: 3 },
    });
    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_PROGRESS,
      data: { sessionId: 'B7', translatedCount: 1, totalCount: 2 },
    });

    expect(stale).toMatchObject({ ignored: true, reason: 'stale-session' });
    expect(coordinator.frameSessionOwners).toEqual(new Map([[7, 'B7'], [8, 'A8']]));
    expect(aggregator.frameProgressMap.get(7)).toMatchObject({ translatedCount: 1 });
    expect(aggregator.frameProgressMap.get(8)).toMatchObject({ translatedCount: 2 });
  });

  it('retains ownership through COMPLETE and IDLE', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'A7' } });
    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_COMPLETE, data: { sessionId: 'A7', translatedCount: 2 } });
    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_IDLE, data: { sessionId: 'A7', translatedCount: 2 } });

    expect(coordinator.frameSessionOwners.get(7)).toBe('A7');
  });

  it('uses an earlier current-frame terminal cause when another frame completes last', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    const emitSpy = vi.spyOn(pageEventBus, 'emit');
    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'A7' } });
    coordinator.handleTrustedPageLifecycle({ frameId: 8, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'A8' } });
    emitSpy.mockClear();

    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_COMPLETE,
      data: {
        sessionId: 'A7',
        translatedCount: 0,
        failedCount: 1,
        totalCount: 1,
        errorDetails: { message: 'Rate limited', type: 'RATE_LIMIT_REACHED' },
      },
    });
    coordinator.handleTrustedPageLifecycle({
      frameId: 8,
      action: MessageActions.PAGE_TRANSLATE_COMPLETE,
      data: { sessionId: 'A8', translatedCount: 0, failedCount: 1, totalCount: 1 },
    });

    const completion = emitSpy.mock.calls
      .filter(([action]) => action === MessageActions.PAGE_TRANSLATE_COMPLETE).at(-1)?.[1];
    expect(completion).toMatchObject({ translatedCount: 0, failedCount: 2 });
    expect(completion.errorDetails).toMatchObject({ type: 'RATE_LIMIT_REACHED' });
    emitSpy.mockRestore();
  });

  it('uses the latest structured terminal cause across current frames', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    const emitSpy = vi.spyOn(pageEventBus, 'emit');
    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'A7' } });
    coordinator.handleTrustedPageLifecycle({ frameId: 8, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'A8' } });
    emitSpy.mockClear();

    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_COMPLETE,
      data: {
        sessionId: 'A7',
        translatedCount: 0,
        failedCount: 1,
        totalCount: 1,
        errorDetails: { message: 'Rate limited', type: 'RATE_LIMIT_REACHED' },
      },
    });
    coordinator.handleTrustedPageLifecycle({
      frameId: 8,
      action: MessageActions.PAGE_TRANSLATE_COMPLETE,
      data: {
        sessionId: 'A8',
        translatedCount: 0,
        failedCount: 1,
        totalCount: 1,
        errorDetails: { message: 'Model overloaded', type: 'MODEL_OVERLOADED' },
      },
    });

    const completion = emitSpy.mock.calls
      .filter(([action]) => action === MessageActions.PAGE_TRANSLATE_COMPLETE).at(-1)?.[1];
    expect(completion.errorDetails).toMatchObject({ type: 'MODEL_OVERLOADED' });
    emitSpy.mockRestore();
  });

  it('omits terminal causes from partial-success aggregate completion', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    const emitSpy = vi.spyOn(pageEventBus, 'emit');
    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'A7' } });
    coordinator.handleTrustedPageLifecycle({ frameId: 8, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'A8' } });
    emitSpy.mockClear();

    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_COMPLETE,
      data: {
        sessionId: 'A7',
        translatedCount: 0,
        failedCount: 1,
        totalCount: 1,
        errorDetails: { message: 'Rate limited', type: 'RATE_LIMIT_REACHED' },
      },
    });
    coordinator.handleTrustedPageLifecycle({
      frameId: 8,
      action: MessageActions.PAGE_TRANSLATE_COMPLETE,
      data: { sessionId: 'A8', translatedCount: 1, failedCount: 0, totalCount: 1 },
    });

    const completion = emitSpy.mock.calls
      .filter(([action]) => action === MessageActions.PAGE_TRANSLATE_COMPLETE).at(-1)?.[1];
    expect(completion).toMatchObject({ translatedCount: 1, failedCount: 1 });
    expect(completion).not.toHaveProperty('errorDetails');
    emitSpy.mockRestore();
  });

  it('clears a replaced frame session terminal cause before its next completion', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    const emitSpy = vi.spyOn(pageEventBus, 'emit');
    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'A7' } });
    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_COMPLETE,
      data: {
        sessionId: 'A7',
        translatedCount: 0,
        failedCount: 1,
        totalCount: 1,
        errorDetails: { message: 'Rate limited', type: 'RATE_LIMIT_REACHED' },
      },
    });
    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'B7' } });
    emitSpy.mockClear();

    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_COMPLETE,
      data: { sessionId: 'B7', translatedCount: 0, failedCount: 1, totalCount: 1 },
    });

    const completion = emitSpy.mock.calls
      .filter(([action]) => action === MessageActions.PAGE_TRANSLATE_COMPLETE).at(-1)?.[1];
    expect(completion).not.toHaveProperty('errorDetails');
    expect(aggregator.frameProgressMap.get(7)).toMatchObject({
      terminalErrorDetails: null,
      terminalCauseSequence: 0,
    });
    emitSpy.mockRestore();
  });

  it('removes a retired frame terminal cause from final aggregation', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    const emitSpy = vi.spyOn(pageEventBus, 'emit');
    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'A7' } });
    coordinator.handleTrustedPageLifecycle({ frameId: 8, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'A8' } });
    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_COMPLETE,
      data: {
        sessionId: 'A7',
        translatedCount: 0,
        failedCount: 1,
        totalCount: 1,
        errorDetails: { message: 'Rate limited', type: 'RATE_LIMIT_REACHED' },
      },
    });
    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATION_FRAME_RETIRED,
      data: { sessionId: 'A7' },
    });
    emitSpy.mockClear();

    coordinator.handleTrustedPageLifecycle({
      frameId: 8,
      action: MessageActions.PAGE_TRANSLATE_COMPLETE,
      data: { sessionId: 'A8', translatedCount: 0, failedCount: 1, totalCount: 1 },
    });

    const completion = emitSpy.mock.calls
      .filter(([action]) => action === MessageActions.PAGE_TRANSLATE_COMPLETE).at(-1)?.[1];
    expect(completion).toMatchObject({ translatedCount: 0, failedCount: 1 });
    expect(completion).not.toHaveProperty('errorDetails');
    emitSpy.mockRestore();
  });

  it('keeps existing aggregate state when a new attempt errors before START', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'A7' } });
    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_PROGRESS, data: { sessionId: 'A7', translatedCount: 2, totalCount: 3 } });

    const result = coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_ERROR,
      data: { error: 'pre-start failure', isFatal: true },
    });

    expect(result).toMatchObject({ ignored: true, reason: 'missing-session' });
    expect(coordinator.frameSessionOwners.get(7)).toBe('A7');
    expect(aggregator.frameProgressMap.get(7)).toMatchObject({ translatedCount: 2, totalCount: 3 });
  });

  it('ignores stale cancelled and restore error presentation', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    const emitSpy = vi.spyOn(pageEventBus, 'emit');
    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'A7' } });
    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'B7' } });
    emitSpy.mockClear();

    const cancelled = coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_CANCELLED, data: { sessionId: 'A7' } });
    const restoreError = coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_RESTORE_ERROR, data: { sessionId: 'A7', error: 'old restore failed' } });

    expect(cancelled).toMatchObject({ ignored: true });
    expect(restoreError).toMatchObject({ ignored: true });
    expect(emitSpy).not.toHaveBeenCalled();
    expect(coordinator.frameSessionOwners.get(7)).toBe('B7');
    emitSpy.mockRestore();
  });

  it('settles restore per frame and emits canonical restore only on final retirement', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    const emitSpy = vi.spyOn(pageEventBus, 'emit');
    coordinator.handleTrustedPageLifecycle({ frameId: 0, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'A0' } });
    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'A7' } });
    coordinator.handleTrustedPageLifecycle({ frameId: 0, action: MessageActions.PAGE_TRANSLATE_IDLE, data: { sessionId: 'A0' } });
    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_IDLE, data: { sessionId: 'A7' } });
    aggregator.updateFrameData(0, { translatedCount: 2, failedCount: 1, totalCount: 4 });
    aggregator.updateFrameData(7, { translatedCount: 5, failedCount: 3, totalCount: 9 });
    emitSpy.mockClear();

    coordinator.handleTrustedPageLifecycle({ frameId: 0, action: MessageActions.PAGE_RESTORE_COMPLETE, data: { sessionId: 'A0' } });
    expect(coordinator.frameSessionOwners).toEqual(new Map([[7, 'A7']]));
    expect(aggregator.frameProgressMap.has(0)).toBe(false);
    const partialRestoreProgress = emitSpy.mock.calls.find(([action]) => action === MessageActions.PAGE_TRANSLATE_PROGRESS)?.[1];
    expect(partialRestoreProgress).toMatchObject({
      isAggregated: true,
      translatedCount: 5,
      failedCount: 3,
      totalCount: 9,
    });
    expect(partialRestoreProgress.sessionId).toBeUndefined();
    expect(emitSpy).not.toHaveBeenCalledWith(MessageActions.PAGE_RESTORE_COMPLETE, expect.anything());

    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_RESTORE_COMPLETE, data: { sessionId: 'A7' } });
    expect(coordinator.frameSessionOwners.size).toBe(0);
    expect(emitSpy.mock.calls.filter(([action]) => action === MessageActions.PAGE_RESTORE_COMPLETE)).toHaveLength(1);
    emitSpy.mockRestore();
  });

  it('preserves replacement and failed restore owners without false global settlement', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    const emitSpy = vi.spyOn(pageEventBus, 'emit');
    coordinator.handleTrustedPageLifecycle({ frameId: 0, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'A0' } });
    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'A7' } });
    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'B7' } });
    emitSpy.mockClear();

    const staleRestore = coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_RESTORE_COMPLETE, data: { sessionId: 'A7' } });
    coordinator.handleTrustedPageLifecycle({ frameId: 0, action: MessageActions.PAGE_RESTORE_COMPLETE, data: { sessionId: 'A0' } });
    const failedRestore = coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_RESTORE_ERROR, data: { sessionId: 'B7', error: 'restore failed' } });

    expect(staleRestore).toMatchObject({ ignored: true });
    expect(failedRestore).toMatchObject({ aggregated: false });
    expect(coordinator.frameSessionOwners).toEqual(new Map([[7, 'B7']]));
    expect(aggregator.frameProgressMap.has(7)).toBe(true);
    expect(emitSpy).not.toHaveBeenCalledWith(MessageActions.PAGE_RESTORE_COMPLETE, expect.anything());
    emitSpy.mockRestore();
  });

  it('settles child-only restore without requiring a top-frame owner', () => {
    const coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
    const emitSpy = vi.spyOn(pageEventBus, 'emit');
    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_TRANSLATE_START, data: { sessionId: 'A7' } });
    emitSpy.mockClear();

    coordinator.handleTrustedPageLifecycle({ frameId: 7, action: MessageActions.PAGE_RESTORE_COMPLETE, data: { sessionId: 'A7' } });

    expect(coordinator.frameSessionOwners.size).toBe(0);
    expect(emitSpy).toHaveBeenCalledWith(MessageActions.PAGE_RESTORE_COMPLETE, expect.anything());
    emitSpy.mockRestore();
  });
});
