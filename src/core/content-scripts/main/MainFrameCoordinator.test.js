import { beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';
import { pageEventBus } from '@/core/PageEventBus.js';
import { MainFrameCoordinator } from './MainFrameCoordinator.js';

vi.mock('webextension-polyfill', () => ({ default: { runtime: { sendMessage: vi.fn() } } }));

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
  MOUSE_HOVER_FRAME_FEEDBACK: 'MOUSE_HOVER_FRAME_FEEDBACK',
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

describe('MainFrameCoordinator trusted hover relay', () => {
  let emitSpy;
  let aggregator;
  let coordinator;

  beforeEach(() => {
    vi.clearAllMocks();
    browser.runtime.sendMessage.mockResolvedValue({ success: true });
    emitSpy = vi.spyOn(pageEventBus, 'emit');
    const frameProgressMap = new Map();
    aggregator = {
      frameProgressMap,
      clearAll: vi.fn(() => frameProgressMap.clear()),
      removeFrame: vi.fn(frameId => frameProgressMap.delete(frameId)),
      updateFrameData: vi.fn((frameId, newData) => {
        frameProgressMap.set(frameId, { ...frameProgressMap.get(frameId), ...newData });
      }),
      recordTerminalCause: vi.fn(),
      emitAggregateProgress: vi.fn()
    };
    coordinator = new MainFrameCoordinator(aggregator, MessageActions, null);
  });

  const dispatchIframeEvent = (type, data) => {
    window.dispatchEvent(new MessageEvent('message', {
      data,
      source: null
    }));
    return emitSpy.mock.calls.at(-1);
  };

  it('does not accept public READY, ERROR, or HIDE messages as hover authority', () => {
    for (const type of ['MOUSE_HOVER_TRANSLATION_READY', 'MOUSE_HOVER_TRANSLATION_ERROR', 'MOUSE_HOVER_HIDE_TOOLTIP']) {
      dispatchIframeEvent(type, { source: 'translate-it-iframe', type, data: { hoverId: 'forged' } });
    }
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('does not normalize unrelated iframe events', () => {
    const data = {
      error: 'legacy failure',
      errorDetails: { message: 'structured detail', type: 'MODEL_NOT_FOUND' }
    };

    dispatchIframeEvent('OTHER_IFRAME_EVENT', {
      source: 'translate-it-iframe',
      type: 'OTHER_IFRAME_EVENT',
      data
    });

    expect(emitSpy.mock.calls.at(-1)).toEqual(['OTHER_IFRAME_EVENT', data]);
  });

  it('uses trusted READY plus its public position hint and rejects stale sibling events', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    vi.spyOn(iframe, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 50 });
    const childWindow = iframe.contentWindow;
    window.dispatchEvent(new MessageEvent('message', { source: childWindow, data: { source: 'translate-it-iframe', type: 'MOUSE_HOVER_POSITION_HINT', hoverId: 'a' } }));
    expect(coordinator.handleHoverFrameEvent({ frameId: 4, type: 'MOUSE_HOVER_TRANSLATION_READY', detail: { hoverId: 'a', translatedText: 'text', position: { x: 2, y: 3 } } })).toEqual({ success: true });
    expect(emitSpy).toHaveBeenCalledWith('MOUSE_HOVER_TRANSLATION_READY', expect.objectContaining({ frameId: 4, position: expect.objectContaining({ x: 102, y: 53 }) }));
    coordinator._handleHoverFeedback('MOUSE_HOVER_TOOLTIP_POINTER_ENTER', 'enter', { frameId: 4, hoverId: 'a' });
    expect(coordinator.handleHoverFrameEvent({ frameId: 5, type: 'MOUSE_HOVER_TRANSLATION_READY', detail: { hoverId: 'b', translatedText: 'other', position: { x: 0, y: 0 } } })).toMatchObject({ ignored: true });
    expect(coordinator.handleHoverFrameEvent({ frameId: 5, type: 'MOUSE_HOVER_HIDE_TOOLTIP', detail: { hoverId: 'b' } })).toMatchObject({ ignored: true });
    expect(coordinator.hoverOwner).toMatchObject({ frameId: 4, hoverId: 'a', held: true });
    iframe.remove();
  });

  it('keeps a READY pending rather than showing it without a matching position hint', () => {
    const result = coordinator.handleHoverFrameEvent({ frameId: 2, type: 'MOUSE_HOVER_TRANSLATION_READY', detail: { hoverId: 'missing', translatedText: 'text', position: { x: 1, y: 1 } } });
    expect(result).toMatchObject({ success: true, pending: true });
    expect(coordinator.hoverOwner).toBeNull();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('admits a trusted READY when its matching direct iframe hint arrives afterward', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    vi.spyOn(iframe, 'getBoundingClientRect').mockReturnValue({ left: 30, top: 40 });
    expect(coordinator.handleHoverFrameEvent({ frameId: 10, type: 'MOUSE_HOVER_TRANSLATION_READY', detail: { hoverId: 'late-hint', translatedText: 'shown', position: { x: 2, y: 3 } } })).toMatchObject({ success: true, pending: true });

    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { source: 'translate-it-iframe', type: 'MOUSE_HOVER_POSITION_HINT', hoverId: 'late-hint' } }));

    expect(coordinator.hoverOwner).toMatchObject({ frameId: 10, hoverId: 'late-hint' });
    expect(emitSpy).toHaveBeenCalledWith('MOUSE_HOVER_TRANSLATION_READY', expect.objectContaining({ position: expect.objectContaining({ x: 32, y: 43 }) }));
    iframe.remove();
  });

  it('retires pending READY on HIDE and tombstones HIDE that arrives before READY', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const hint = hoverId => window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { source: 'translate-it-iframe', type: 'MOUSE_HOVER_POSITION_HINT', hoverId } }));
    const ready = hoverId => coordinator.handleHoverFrameEvent({ frameId: 11, type: 'MOUSE_HOVER_TRANSLATION_READY', detail: { hoverId, translatedText: 'late', position: { x: 0, y: 0 } } });

    expect(ready('hide-after')).toMatchObject({ pending: true });
    coordinator.handleHoverFrameEvent({ frameId: 11, type: 'MOUSE_HOVER_HIDE_TOOLTIP', detail: { hoverId: 'hide-after' } });
    hint('hide-after');
    expect(coordinator.hoverOwner).toBeNull();
    expect(emitSpy).not.toHaveBeenCalledWith('MOUSE_HOVER_TRANSLATION_READY', expect.anything());

    coordinator.handleHoverFrameEvent({ frameId: 11, type: 'MOUSE_HOVER_HIDE_TOOLTIP', detail: { hoverId: 'hide-before' } });
    hint('hide-before');
    expect(coordinator.hoverPositionHints.has('hide-before')).toBe(false);
    expect(ready('hide-before')).toMatchObject({ ignored: true, reason: 'retired-hover-token' });
    expect(coordinator.hoverOwner).toBeNull();
    iframe.remove();
  });

  it('does not queue a sibling READY while another frame owns a held tooltip', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const hint = hoverId => window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { source: 'translate-it-iframe', type: 'MOUSE_HOVER_POSITION_HINT', hoverId } }));
    hint('held-a');
    coordinator.handleHoverFrameEvent({ frameId: 12, type: 'MOUSE_HOVER_TRANSLATION_READY', detail: { hoverId: 'held-a', translatedText: 'a', position: { x: 0, y: 0 } } });
    coordinator._handleHoverFeedback('MOUSE_HOVER_TOOLTIP_POINTER_ENTER', 'enter', { frameId: 12, hoverId: 'held-a' });

    expect(coordinator.handleHoverFrameEvent({ frameId: 13, type: 'MOUSE_HOVER_TRANSLATION_READY', detail: { hoverId: 'held-b', translatedText: 'b', position: { x: 0, y: 0 } } })).toMatchObject({ ignored: true, reason: 'tooltip-held-by-other-hover' });
    hint('held-b');
    expect(coordinator.hoverOwner).toMatchObject({ frameId: 12, hoverId: 'held-a', held: true });
    expect(emitSpy).not.toHaveBeenCalledWith('MOUSE_HOVER_TRANSLATION_READY', expect.objectContaining({ hoverId: 'held-b' }));
    iframe.remove();
  });

  it('normalizes canonical ERROR details received through the trusted relay', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { source: 'translate-it-iframe', type: 'MOUSE_HOVER_POSITION_HINT', hoverId: 'error-hover' } }));
    coordinator.handleHoverFrameEvent({ frameId: 8, type: 'MOUSE_HOVER_TRANSLATION_READY', detail: { hoverId: 'error-hover', translatedText: 'ok', position: { x: 1, y: 1 } } });
    const errorDetails = {
      message: 'Provider unavailable', type: 'API_ERROR', originalType: 'ProviderError', statusCode: 503,
      context: 'hover', providerName: 'provider', providerId: 'provider-id', code: 'E1', errorCode: 12,
      operationAborted: false, cancellationReason: 'retry', translationOutcome: { retryable: true },
    };

    coordinator.handleHoverFrameEvent({ frameId: 8, type: 'MOUSE_HOVER_TRANSLATION_ERROR', detail: { hoverId: 'error-hover', error: errorDetails.message, errorDetails } });

    const emittedError = emitSpy.mock.calls.at(-1)[1].error;
    expect(emittedError).toBeInstanceOf(Error);
    expect(emittedError.message).toBe(errorDetails.message);
    expect(emittedError).toMatchObject(Object.fromEntries(Object.entries(errorDetails).filter(([key]) => key !== 'message')));
    iframe.remove();
  });

  it('displays a trusted ERROR before READY, retires its token, and ignores a sibling ERROR', () => {
    const errorDetails = { message: 'Hover provider failed', type: 'API_ERROR', statusCode: 503 };
    expect(coordinator.handleHoverFrameEvent({ frameId: 14, type: 'MOUSE_HOVER_TRANSLATION_ERROR', detail: { hoverId: 'error-first', error: errorDetails.message, errorDetails } })).toEqual({ success: true });
    expect(emitSpy).toHaveBeenCalledWith('MOUSE_HOVER_TRANSLATION_ERROR', expect.objectContaining({
      frameId: 14,
      hoverId: 'error-first',
      error: expect.objectContaining({ message: errorDetails.message, type: errorDetails.type, statusCode: 503 }),
    }));
    expect(coordinator.handleHoverFrameEvent({ frameId: 14, type: 'MOUSE_HOVER_TRANSLATION_READY', detail: { hoverId: 'error-first', translatedText: 'late', position: { x: 0, y: 0 } } })).toMatchObject({ ignored: true, reason: 'retired-hover-token' });

    emitSpy.mockClear();
    expect(coordinator.handleHoverFrameEvent({ frameId: 15, type: 'MOUSE_HOVER_TRANSLATION_ERROR', detail: { hoverId: 'sibling-error', error: 'stale' } })).toMatchObject({ ignored: true, reason: 'stale-hover-owner' });
    expect(emitSpy).not.toHaveBeenCalledWith('MOUSE_HOVER_TRANSLATION_ERROR', expect.anything());
    expect(coordinator.hoverOwner).toMatchObject({ frameId: 14, hoverId: 'error-first' });
  });

  it('uses the established iframe position basis for same-owner updates after hint expiry', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const rect = { left: 10, top: 20 };
    vi.spyOn(iframe, 'getBoundingClientRect').mockImplementation(() => rect);
    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { source: 'translate-it-iframe', type: 'MOUSE_HOVER_POSITION_HINT', hoverId: 'slow-hover' } }));
    const ready = { frameId: 9, type: 'MOUSE_HOVER_TRANSLATION_READY', detail: { hoverId: 'slow-hover', translatedText: 'first', position: { x: 1, y: 2 } } };
    expect(coordinator.handleHoverFrameEvent(ready)).toEqual({ success: true });

    vi.advanceTimersByTime(61_000);
    rect.left = 40;
    rect.top = 50;
    expect(coordinator.handleHoverFrameEvent({ ...ready, detail: { ...ready.detail, translatedText: 'later' } })).toEqual({ success: true });
    expect(emitSpy.mock.calls.at(-1)[1].position).toMatchObject({ x: 41, y: 52 });
    iframe.remove();
    vi.useRealTimers();
  });

  it('keeps the validated source iframe association for a first READY after 60 seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    vi.spyOn(iframe, 'getBoundingClientRect').mockReturnValue({ left: 70, top: 80 });
    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { source: 'translate-it-iframe', type: 'MOUSE_HOVER_POSITION_HINT', hoverId: 'slow-first-ready' } }));
    vi.advanceTimersByTime(61_000);

    const result = coordinator.handleHoverFrameEvent({ frameId: 24, type: 'MOUSE_HOVER_TRANSLATION_READY', detail: { hoverId: 'slow-first-ready', translatedText: 'late result', position: { x: 4, y: 5 } } });

    expect(result).toEqual({ success: true });
    expect(emitSpy).toHaveBeenCalledWith('MOUSE_HOVER_TRANSLATION_READY', expect.objectContaining({ frameId: 24, position: expect.objectContaining({ x: 74, y: 85 }) }));
    expect(coordinator.hoverOwner).toMatchObject({ frameId: 24, hoverId: 'slow-first-ready', iframe });
    iframe.remove();
    vi.useRealTimers();
  });

  it('keeps HIDE and replacement fences beyond 60 seconds despite stale hints and READY events', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    vi.spyOn(iframe, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20 });
    const hint = hoverId => window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { source: 'translate-it-iframe', type: 'MOUSE_HOVER_POSITION_HINT', hoverId } }));
    const ready = (frameId, hoverId) => coordinator.handleHoverFrameEvent({ frameId, type: 'MOUSE_HOVER_TRANSLATION_READY', detail: { hoverId, translatedText: hoverId, position: { x: 1, y: 1 } } });

    hint('cancel-long');
    ready(25, 'cancel-long');
    coordinator.handleHoverFrameEvent({ frameId: 25, type: 'MOUSE_HOVER_HIDE_TOOLTIP', detail: { hoverId: 'cancel-long' } });
    coordinator._handleHoverFeedback('MOUSE_HOVER_TOOLTIP_HIDDEN', 'hidden', { frameId: 25, hoverId: 'cancel-long' });

    hint('replace-long-a');
    ready(26, 'replace-long-a');
    hint('replace-long-b');
    ready(27, 'replace-long-b');
    expect(coordinator.hoverOwner).toMatchObject({ frameId: 27, hoverId: 'replace-long-b' });

    vi.advanceTimersByTime(61_000);
    hint('cancel-long');
    hint('replace-long-a');
    expect(coordinator.hoverPositionHints.has('cancel-long')).toBe(false);
    expect(coordinator.hoverPositionHints.has('replace-long-a')).toBe(false);
    expect(ready(25, 'cancel-long')).toMatchObject({ ignored: true, reason: 'retired-hover-token' });
    expect(ready(26, 'replace-long-a')).toMatchObject({ ignored: true, reason: 'retired-hover-token' });
    expect(coordinator.hoverOwner).toMatchObject({ frameId: 27, hoverId: 'replace-long-b' });
    iframe.remove();
    vi.useRealTimers();
  });

  it('clears a held child owner when the local top tooltip takes over', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    vi.spyOn(iframe, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20 });
    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { source: 'translate-it-iframe', type: 'MOUSE_HOVER_POSITION_HINT', hoverId: 'child-a' } }));
    coordinator.handleHoverFrameEvent({ frameId: 4, type: 'MOUSE_HOVER_TRANSLATION_READY', detail: { hoverId: 'child-a', translatedText: 'a', position: { x: 1, y: 1 } } });
    coordinator._handleHoverFeedback('MOUSE_HOVER_TOOLTIP_POINTER_ENTER', 'enter', { frameId: 4, hoverId: 'child-a' });

    pageEventBus.emit('MOUSE_HOVER_TRANSLATION_READY', { hoverId: 'top', frameId: 0, translatedText: 'local' });

    expect(coordinator.hoverOwner).toBeNull();
    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { source: 'translate-it-iframe', type: 'MOUSE_HOVER_POSITION_HINT', hoverId: 'child-b' } }));
    expect(coordinator.handleHoverFrameEvent({ frameId: 5, type: 'MOUSE_HOVER_TRANSLATION_READY', detail: { hoverId: 'child-b', translatedText: 'b', position: { x: 1, y: 1 } } })).toEqual({ success: true });
    expect(coordinator.hoverOwner).toMatchObject({ frameId: 5, hoverId: 'child-b' });
    iframe.remove();
  });

  it('sends exact-frame HIDDEN feedback when local READY replaces a held child owner', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const owner = { frameId: 21, hoverId: 'local-takeover-child' };
    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { source: 'translate-it-iframe', type: 'MOUSE_HOVER_POSITION_HINT', hoverId: owner.hoverId } }));
    coordinator.handleHoverFrameEvent({ ...owner, type: 'MOUSE_HOVER_TRANSLATION_READY', detail: { hoverId: owner.hoverId, translatedText: 'child', position: { x: 0, y: 0 } } });
    coordinator._handleHoverFeedback('MOUSE_HOVER_TOOLTIP_POINTER_ENTER', 'enter', owner);
    browser.runtime.sendMessage.mockClear();

    pageEventBus.emit('MOUSE_HOVER_TRANSLATION_READY', { frameId: 0, hoverId: 'local-ready', translatedText: 'local' });

    const retiringCalls = browser.runtime.sendMessage.mock.calls.filter(([message]) => message.data?.targetFrameId === owner.frameId && message.data?.hoverId === owner.hoverId && message.data?.state === 'hidden');
    expect(retiringCalls).toHaveLength(1);
    expect(coordinator.hoverOwner).toBeNull();
    iframe.remove();
  });

  it('sends HIDDEN once on child replacement, but not for same-token updates or stale events', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const hint = hoverId => window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { source: 'translate-it-iframe', type: 'MOUSE_HOVER_POSITION_HINT', hoverId } }));
    hint('replace-a');
    coordinator.handleHoverFrameEvent({ frameId: 22, type: 'MOUSE_HOVER_TRANSLATION_READY', detail: { hoverId: 'replace-a', translatedText: 'A', position: { x: 0, y: 0 } } });
    browser.runtime.sendMessage.mockClear();
    coordinator.handleHoverFrameEvent({ frameId: 22, type: 'MOUSE_HOVER_TRANSLATION_READY', detail: { hoverId: 'replace-a', translatedText: 'A update', position: { x: 1, y: 1 } } });
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled();

    hint('replace-b');
    coordinator.handleHoverFrameEvent({ frameId: 23, type: 'MOUSE_HOVER_TRANSLATION_READY', detail: { hoverId: 'replace-b', translatedText: 'B', position: { x: 0, y: 0 } } });
    const retiringCalls = browser.runtime.sendMessage.mock.calls.filter(([message]) => message.data?.targetFrameId === 22 && message.data?.hoverId === 'replace-a' && message.data?.state === 'hidden');
    expect(retiringCalls).toHaveLength(1);
    expect(coordinator.hoverOwner).toMatchObject({ frameId: 23, hoverId: 'replace-b' });
    expect(coordinator.hoverPositionHints.has('replace-a')).toBe(false);

    browser.runtime.sendMessage.mockClear();
    hint('replace-a');
    expect(coordinator.hoverPositionHints.has('replace-a')).toBe(false);
    expect(coordinator.handleHoverFrameEvent({ frameId: 22, type: 'MOUSE_HOVER_TRANSLATION_READY', detail: { hoverId: 'replace-a', translatedText: 'stale', position: { x: 0, y: 0 } } })).toMatchObject({ ignored: true, reason: 'retired-hover-token' });
    expect(coordinator.handleHoverFrameEvent({ frameId: 22, type: 'MOUSE_HOVER_HIDE_TOOLTIP', detail: { hoverId: 'replace-a' } })).toMatchObject({ ignored: true });
    coordinator._handleHoverFeedback('MOUSE_HOVER_TOOLTIP_HIDDEN', 'hidden', { frameId: 22, hoverId: 'replace-a' });
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    expect(coordinator.hoverOwner).toMatchObject({ frameId: 23, hoverId: 'replace-b' });
    iframe.remove();
  });

  it('ignores legacy Select Element deactivation window messages', () => {
    const manager = { deactivate: vi.fn() };
    const previousManager = window.selectElementManagerInstance;
    window.selectElementManagerInstance = manager;

    try {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'translate-it-deactivate-select-element' },
      }));

      expect(manager.deactivate).not.toHaveBeenCalled();
      expect(coordinator.broadcastDeactivation).toBeUndefined();
    } finally {
      window.selectElementManagerInstance = previousManager;
    }
  });

  it('keeps PAGE_TRANSLATE command intent out of aggregate state', () => {
    pageEventBus.emit(MessageActions.PAGE_TRANSLATE, { isAuto: false });

    expect(aggregator.updateFrameData).not.toHaveBeenCalled();
    expect(aggregator.clearAll).not.toHaveBeenCalled();
  });

  it('does not fan out page commands through iframe windows', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const postMessageSpy = vi.spyOn(iframe.contentWindow, 'postMessage').mockImplementation(() => {});

    try {
      pageEventBus.emit(MessageActions.PAGE_TRANSLATE, { isAuto: false });
      pageEventBus.emit(MessageActions.PAGE_RESTORE);
      pageEventBus.emit(MessageActions.PAGE_TRANSLATE_STOP_AUTO);

      expect(postMessageSpy).not.toHaveBeenCalled();
      expect(aggregator.clearAll).not.toHaveBeenCalled();
    } finally {
      postMessageSpy.mockRestore();
      iframe.remove();
    }
  });

  it('ignores forged Whole Page window lifecycle messages', () => {
    for (const type of [
      'TRANSLATE_IT_PAGE_EVENT',
      'TRANSLATE_IT_PAGE_PROGRESS',
      'TRANSLATE_IT_PAGE_COMPLETE',
      'TRANSLATE_IT_PAGE_STOPPED',
    ]) {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          source: 'translate-it-iframe',
          type,
          action: MessageActions.PAGE_TRANSLATE_PROGRESS,
          data: { translatedCount: 999, totalCount: 999, frameUrl: 'fake' },
        },
      }));
    }

    expect(aggregator.updateFrameData).not.toHaveBeenCalled();
    expect(aggregator.emitAggregateProgress).not.toHaveBeenCalled();
  });

  it('ignores forged top-frame PageEventBus lifecycle events for aggregation', () => {
    window.dispatchEvent(new CustomEvent(MessageActions.PAGE_TRANSLATE_PROGRESS, {
      detail: { translatedCount: 999, totalCount: 999 },
    }));

    expect(aggregator.updateFrameData).not.toHaveBeenCalled();
    expect(aggregator.emitAggregateProgress).not.toHaveBeenCalled();
  });

  it('retires only matching frame state on trusted restore completion', () => {
    pageEventBus.emit(MessageActions.PAGE_RESTORE);
    expect(aggregator.clearAll).not.toHaveBeenCalled();

    coordinator.handleTrustedPageLifecycle({
      frameId: 0,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { sessionId: 'main-session' },
    });
    vi.clearAllMocks();

    coordinator.handleTrustedPageLifecycle({
      frameId: 0,
      action: MessageActions.PAGE_RESTORE_COMPLETE,
      data: { sessionId: 'main-session' },
    });

    expect(aggregator.clearAll).not.toHaveBeenCalled();
    expect(aggregator.removeFrame).toHaveBeenCalledWith(0);
    expect(aggregator.emitAggregateProgress).toHaveBeenCalledWith(
      MessageActions.PAGE_RESTORE_COMPLETE,
      expect.objectContaining({ sessionId: 'main-session' })
    );
  });

  it('starts only main frame on trusted frame-zero START', () => {
    const data = { messageId: 'main-session', sessionId: 'main-session', isAutoTranslating: false };

    coordinator.handleTrustedPageLifecycle({
      frameId: 0,
      action: MessageActions.PAGE_TRANSLATE_START,
      data,
    });

    expect(aggregator.updateFrameData).toHaveBeenCalledWith(0, expect.objectContaining({
      isTranslating: true,
      isTranslated: false,
      isAutoTranslating: false,
      translatedCount: 0,
      failedCount: 0,
      totalCount: 0,
      status: 'translating'
    }));
    expect(aggregator.clearAll).not.toHaveBeenCalled();
  });

  it('uses trusted browser frame ID instead of payload frame identity', () => {
    const data = {
      frameUrl: 'https://frame.example/',
      frameId: 9,
      messageId: 'iframe-session',
      sessionId: 'iframe-session',
      isAutoTranslating: true
    };

    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_START,
      data
    });

    expect(aggregator.updateFrameData).toHaveBeenCalledWith(7, expect.objectContaining({
      isTranslating: true,
      isTranslated: false,
      isAutoTranslating: true,
      translatedCount: 0,
      failedCount: 0,
      totalCount: 0,
      status: 'translating'
    }));
    expect(aggregator.clearAll).not.toHaveBeenCalled();
  });

  it('updates aggregate exactly once per trusted lifecycle message', () => {
    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { sessionId: 'frame-session' },
    });
    vi.clearAllMocks();

    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_PROGRESS,
      data: { sessionId: 'frame-session', translatedCount: 2, totalCount: 3 },
    });

    expect(aggregator.updateFrameData).toHaveBeenCalledTimes(1);
    expect(aggregator.updateFrameData).toHaveBeenCalledWith(7, {
      translatedCount: 2,
      totalCount: 3,
    });
    expect(aggregator.emitAggregateProgress).toHaveBeenCalledTimes(1);
  });

  it('preserves trusted child completion semantics', () => {
    const data = { sessionId: 'frame-session', translatedCount: 3, totalCount: 3, frameUrl: 'fake' };
    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { sessionId: 'frame-session' },
    });
    vi.clearAllMocks();

    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_COMPLETE,
      data,
    });

    expect(aggregator.updateFrameData).toHaveBeenCalledWith(7, expect.objectContaining({
      isTranslating: false,
      isTranslated: true,
      status: 'idle',
    }));
    expect(aggregator.emitAggregateProgress).toHaveBeenCalledWith(
      MessageActions.PAGE_TRANSLATE_COMPLETE,
      data
    );
  });

  it('preserves structured completion error details through aggregation', () => {
    const errorDetails = {
      message: 'Model overloaded',
      type: 'MODEL_OVERLOADED',
    };
    const data = {
      sessionId: 'frame-session',
      translatedCount: 0,
      failedCount: 2,
      totalCount: 2,
      errorDetails,
    };
    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { sessionId: 'frame-session' },
    });
    vi.clearAllMocks();

    coordinator.handleTrustedPageLifecycle({
      frameId: 7,
      action: MessageActions.PAGE_TRANSLATE_COMPLETE,
      data,
    });

    expect(aggregator.emitAggregateProgress).toHaveBeenCalledWith(
      MessageActions.PAGE_TRANSLATE_COMPLETE,
      data
    );
  });

  it('reconciles trusted main-frame errors without clearing other frame state', () => {
    const data = { sessionId: 'main-session', error: 'translation failed', isFatal: true };
    coordinator.handleTrustedPageLifecycle({
      frameId: 0,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { sessionId: 'main-session' },
    });
    vi.clearAllMocks();

    coordinator.handleTrustedPageLifecycle({
      frameId: 0,
      action: MessageActions.PAGE_TRANSLATE_ERROR,
      data,
    });

    expect(aggregator.updateFrameData).toHaveBeenCalledWith(0, expect.objectContaining({
      isTranslating: false,
      status: 'error'
    }));
    expect(aggregator.emitAggregateProgress).toHaveBeenCalledWith(
      MessageActions.PAGE_TRANSLATE_ERROR,
      data
    );
    expect(aggregator.clearAll).not.toHaveBeenCalled();
  });

  it('keeps non-fatal main-frame errors out of aggregate fatal presentation', () => {
    const data = { sessionId: 'main-session', error: 'retryable failure', isFatal: false };
    coordinator.handleTrustedPageLifecycle({
      frameId: 0,
      action: MessageActions.PAGE_TRANSLATE_START,
      data: { sessionId: 'main-session' },
    });
    vi.clearAllMocks();

    coordinator.handleTrustedPageLifecycle({
      frameId: 0,
      action: MessageActions.PAGE_TRANSLATE_ERROR,
      data,
    });

    expect(aggregator.updateFrameData).toHaveBeenCalledWith(0, expect.objectContaining({
      isTranslating: true,
      status: 'translating'
    }));
    expect(aggregator.emitAggregateProgress).not.toHaveBeenCalledWith(
      MessageActions.PAGE_TRANSLATE_ERROR,
      data
    );
  });
});
