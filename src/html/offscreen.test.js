import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  messages: [],
  listener: null,
  audios: [],
  utterances: [],
  mediaDevices: null,
  previousMediaDevices: undefined,
  hadMediaDevices: false,
}));

class FakeAudio {
  constructor(src = '') {
    this.src = src;
    this.paused = true;
    this.currentTime = 0;
    this.listeners = new Map();
    state.audios.push(this);
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  removeEventListener(type) {
    this.listeners.delete(type);
  }

  dispatch(type, event = {}) {
    this.listeners.get(type)?.(event);
  }

  play() {
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }

  load() {}
}

class FakeUtterance {
  constructor(text) {
    this.text = text;
    state.utterances.push(this);
  }
}

async function loadOffscreen({ mediaDevices = null } = {}) {
  vi.resetModules();
  if (mediaDevices) {
    state.hadMediaDevices = 'mediaDevices' in navigator;
    state.previousMediaDevices = navigator.mediaDevices;
    state.mediaDevices = mediaDevices;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: mediaDevices,
    });
  }
  globalThis.chrome = {
    runtime: {
      id: 'extension-id',
      getURL: (path = '') => `chrome-extension://extension-id/${path}`,
      sendMessage: vi.fn((message) => {
        state.messages.push(message);
        return Promise.resolve();
      }),
      onMessage: {
        addListener: vi.fn((listener) => {
          state.listener = listener;
        }),
      },
    },
  };
  globalThis.Audio = FakeAudio;
  globalThis.SpeechSynthesisUtterance = FakeUtterance;
  globalThis.speechSynthesis = {
    pending: false,
    speaking: false,
    paused: false,
    cancel: vi.fn(),
    speak: vi.fn((utterance) => {
      state.lastUtterance = utterance;
    }),
  };
  window.speechSynthesis = globalThis.speechSynthesis;
  globalThis.fetch = vi.fn();
  globalThis.URL.createObjectURL = vi.fn(() => `blob:test-${state.audios.length}`);
  globalThis.URL.revokeObjectURL = vi.fn();
  await import('./offscreen.js');
}

function sendMessage(message, sender = {
  id: 'extension-id',
  url: 'chrome-extension://extension-id/background.js',
}) {
  return new Promise((resolve) => {
    state.listener(message, sender, resolve);
  });
}

function terminalMessages() {
  return state.messages.filter(({ action }) => action === 'INTERNAL_TTS_CHUNK_FINISHED');
}

beforeEach(() => {
  vi.useFakeTimers();
  state.messages = [];
  state.listener = null;
  state.audios = [];
  state.utterances = [];
  state.lastUtterance = null;
  state.mediaDevices = null;
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  delete globalThis.chrome;
  delete globalThis.Audio;
  delete globalThis.SpeechSynthesisUtterance;
  delete globalThis.speechSynthesis;
  if (state.mediaDevices) {
    if (state.hadMediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: state.previousMediaDevices,
      });
    } else {
      delete navigator.mediaDevices;
    }
  }
  vi.restoreAllMocks();
});

describe('offscreen TTS terminal playback lifecycle', () => {
  it('emits one completed token for URL audio', async () => {
    await loadOffscreen();
    fetch.mockResolvedValue({ ok: true, blob: async () => new Blob(['audio']) });

    const response = sendMessage({
      target: 'offscreen',
      action: 'playOffscreenAudio',
      url: 'https://example.test/audio',
      text: 'actual text',
      language: 'fr-FR',
      playbackToken: 'url-token',
    });
    await Promise.resolve();
    await Promise.resolve();
    await response;
    state.audios[0].dispatch('ended');

    expect(terminalMessages()).toEqual([{
      action: 'INTERNAL_TTS_CHUNK_FINISHED',
      playbackToken: 'url-token',
      reason: 'completed',
    }]);
  });

  it('emits one completed token for cached audio', async () => {
    await loadOffscreen();

    const response = sendMessage({
      target: 'offscreen',
      action: 'playCachedAudio',
      audioData: [1, 2, 3],
      playbackToken: 'cached-token',
    });
    await Promise.resolve();
    await response;
    state.audios[0].dispatch('ended');

    expect(terminalMessages()).toHaveLength(1);
    expect(terminalMessages()[0]).toMatchObject({
      playbackToken: 'cached-token',
      reason: 'completed',
    });
  });

  it('emits tokenized Web Speech completion after retry', async () => {
    await loadOffscreen();
    fetch.mockRejectedValue(new Error('network failure'));

    const response = sendMessage({
      target: 'offscreen',
      action: 'playOffscreenAudio',
      url: 'https://example.test/audio',
      text: 'fallback text',
      language: 'de-DE',
      playbackToken: 'speech-token',
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    state.utterances[0].onerror({ error: 'synthesis-failed' });
    vi.advanceTimersByTime(500);
    state.utterances[1].onend();
    await response;

    expect(state.utterances[0].text).toBe('fallback text');
    expect(state.utterances[0].lang).toBe('de-DE');
    expect(terminalMessages()).toEqual([expect.objectContaining({
      playbackToken: 'speech-token',
      reason: 'completed',
    })]);
  });

  it('does not falsely fail long Web Speech playback', async () => {
    await loadOffscreen();
    fetch.mockRejectedValue(new Error('network failure'));

    const response = sendMessage({
      target: 'offscreen',
      action: 'playOffscreenAudio',
      url: 'https://example.test/audio',
      text: 'long speech',
      playbackToken: 'long-speech-token',
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const utterance = state.utterances[0];
    speechSynthesis.speaking = true;
    utterance.onstart();
    await response;
    vi.advanceTimersByTime(60_000);

    expect(terminalMessages()).toHaveLength(0);

    utterance.onend();
    expect(terminalMessages()).toEqual([expect.objectContaining({
      playbackToken: 'long-speech-token',
      reason: 'completed',
    })]);
  });

  it('emits one error token for terminal Web Speech failure', async () => {
    await loadOffscreen();
    fetch.mockRejectedValue(new Error('network failure'));

    const response = sendMessage({
      target: 'offscreen',
      action: 'playOffscreenAudio',
      url: 'https://example.test/audio',
      text: 'fallback text',
      language: 'es',
      playbackToken: 'error-token',
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    state.utterances[0].onerror({ error: 'language-unavailable' });
    await response;

    expect(terminalMessages()).toEqual([expect.objectContaining({
      playbackToken: 'error-token',
      reason: 'error',
    })]);
  });

  it('ignores stale stop and suppresses stopped playback callbacks', async () => {
    await loadOffscreen();
    fetch.mockRejectedValue(new Error('network failure'));

    sendMessage({
      target: 'offscreen',
      action: 'playOffscreenAudio',
      url: 'https://example.test/audio',
      text: 'fallback text',
      playbackToken: 'active-token',
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const utterance = state.utterances[0];

    const staleResponse = await sendMessage({
      target: 'offscreen',
      action: 'TTS_STOP',
      playbackToken: 'old-token',
    });
    expect(staleResponse).toEqual({
      success: true,
      skipped: true,
      currentPlaybackToken: 'active-token',
    });

    const stopResponse = await sendMessage({
      target: 'offscreen',
      action: 'TTS_STOP',
      playbackToken: 'active-token',
    });
    utterance.onend?.();

    expect(stopResponse).toEqual({
      success: true,
      stopped: true,
      playbackToken: 'active-token',
    });
    expect(terminalMessages()).toHaveLength(0);
  });

  it('settles pre-ACK playback request when stopped', async () => {
    await loadOffscreen();
    fetch.mockImplementation(() => new Promise(() => {}));

    const playbackResponse = sendMessage({
      target: 'offscreen',
      action: 'playOffscreenAudio',
      url: 'https://example.test/audio',
      text: 'pending audio',
      playbackToken: 'pending-token'
    });
    await Promise.resolve();

    await sendMessage({
      target: 'offscreen',
      action: 'TTS_STOP',
      playbackToken: 'pending-token'
    });

    await expect(playbackResponse).resolves.toEqual(expect.objectContaining({
      success: false,
      playbackToken: 'pending-token',
      reason: 'stopped'
    }));
  });

  it('rejects late playback for token canceled before start', async () => {
    await loadOffscreen();

    await sendMessage({
      target: 'offscreen',
      action: 'TTS_STOP',
      playbackToken: 'late-token'
    });

    const response = await sendMessage({
      target: 'offscreen',
      action: 'playCachedAudio',
      audioData: [1, 2, 3],
      playbackToken: 'late-token'
    });

    expect(response).toEqual(expect.objectContaining({
      success: false,
      playbackToken: 'late-token',
      reason: 'stopped'
    }));
    expect(state.audios).toHaveLength(0);
  });

  it('prunes canceled playback tokens after late-start protection window', async () => {
    await loadOffscreen();

    await sendMessage({
      target: 'offscreen',
      action: 'TTS_STOP',
      playbackToken: 'expired-token',
    });
    vi.advanceTimersByTime(30_000);

    const response = await sendMessage({
      target: 'offscreen',
      action: 'playCachedAudio',
      audioData: [1, 2, 3],
      playbackToken: 'expired-token',
    });

    expect(response).toEqual(expect.objectContaining({
      success: true,
      message: 'Cached audio playback started',
    }));
    expect(state.audios).toHaveLength(1);
  });

  it('removes tracked audio listeners during terminal cleanup', async () => {
    await loadOffscreen();

    const response = sendMessage({
      target: 'offscreen',
      action: 'playCachedAudio',
      audioData: [1, 2, 3],
      playbackToken: 'listener-cleanup-token',
    });
    await response;

    const audio = state.audios[0];
    expect(audio.listeners.size).toBe(3);
    audio.dispatch('ended');

    expect(audio.listeners.size).toBe(0);
  });

  it('settles superseded pre-ACK request as interrupted', async () => {
    await loadOffscreen();
    fetch.mockImplementation(() => new Promise(() => {}));

    const oldResponse = sendMessage({
      target: 'offscreen',
      action: 'playOffscreenAudio',
      url: 'https://example.test/audio',
      text: 'old audio',
      playbackToken: 'old-token'
    });
    await Promise.resolve();

    const newResponse = sendMessage({
      target: 'offscreen',
      action: 'playCachedAudio',
      audioData: [1, 2, 3],
      playbackToken: 'new-token'
    });

    await expect(oldResponse).resolves.toEqual(expect.objectContaining({
      success: false,
      playbackToken: 'old-token',
      reason: 'interrupted'
    }));
    await expect(newResponse).resolves.toEqual(expect.objectContaining({ success: true }));
  });

  it('emits only error when timeout cancel synchronously fires onend', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadOffscreen();
    fetch.mockRejectedValue(new Error('network failure'));
    speechSynthesis.cancel.mockImplementation(() => state.lastUtterance?.onend?.());

    const response = sendMessage({
      target: 'offscreen',
      action: 'playOffscreenAudio',
      url: 'https://example.test/audio',
      text: 'timeout text',
      language: 'en',
      playbackToken: 'timeout-token'
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await response;

    vi.advanceTimersByTime(5000);

    expect(terminalMessages()).toEqual([expect.objectContaining({
      playbackToken: 'timeout-token',
      reason: 'error'
    })]);
    expect(warnSpy).toHaveBeenCalledWith(
      '[Offscreen]',
      'Web Speech TTS startup timeout, cancelling',
    );
  });
});

describe('offscreen live-dubbing route', () => {
  it('ignores untargeted Popup live-dubbing broadcasts before authorization', async () => {
    await loadOffscreen();
    const { liveDubbingController } = await import('../features/live-dubbing/offscreen/LiveDubbingController.js');
    const handle = vi.spyOn(liveDubbingController, 'handle');
    const sendResponse = vi.fn();
    const popupSender = {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/popup.html',
      frameId: 0,
    };

    expect(state.listener({ action: 'START_LIVE_DUBBING' }, popupSender, sendResponse)).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects untrusted, tab-bound, and unlisted offscreen actions before routing', async () => {
    await loadOffscreen();

    await expect(sendMessage({
      target: 'offscreen',
      action: 'LIVE_DUBBING_PREPARE',
      data: { sessionId: 'attacker-session', providerId: 'gemini' },
    }, {
      id: 'extension-id',
      url: 'https://example.test/page',
      tab: { id: 1 },
    })).resolves.toEqual({ success: false, error: 'OFFSCREEN_UNAUTHORIZED' });

    await expect(sendMessage({
      target: 'offscreen',
      action: 'UNLISTED_OFFSCREEN_ACTION',
    })).resolves.toEqual({ success: false, error: 'OFFSCREEN_UNAUTHORIZED' });
  });

  it('coexists with TTS and does not log or expose stream IDs', async () => {
    const track = {
      kind: 'audio',
      readyState: 'live',
      listeners: new Map(),
      stop: vi.fn(() => {
        track.readyState = 'ended';
      }),
      addEventListener: vi.fn((type, handler) => track.listeners.set(type, handler)),
      removeEventListener: vi.fn((type, handler) => {
        if (track.listeners.get(type) === handler) track.listeners.delete(type);
      }),
    };
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    };
    const mediaDevices = {
      getUserMedia: vi.fn(() => Promise.resolve(stream)),
    };
    const logSpy = vi.spyOn(console, 'log');
    await loadOffscreen({ mediaDevices });

    await expect(sendMessage({
      target: 'offscreen',
      action: 'LIVE_DUBBING_PREPARE',
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 0 },
    })).resolves.toMatchObject({
      success: true,
      ack: 'READY',
    });

    await expect(sendMessage({
      target: 'offscreen',
      action: 'LIVE_DUBBING_CONSUME',
      data: { sessionId: 'session-1', providerId: 'gemini', streamId: 'stream-secret', eventSequence: 1 },
    })).resolves.toMatchObject({
      success: true,
      ack: 'MEDIA_ACQUIRED',
    });

    await expect(sendMessage({
      target: 'offscreen',
      action: 'TTS_TEST',
    })).resolves.toEqual({ success: true, message: 'Offscreen TTS ready' });

    const status = await sendMessage({
      target: 'offscreen',
      action: 'LIVE_DUBBING_STATUS',
      data: { sessionId: 'session-1', providerId: 'gemini' },
    });
    expect(status).toMatchObject({
      success: true,
      sessionId: 'session-1',
      status: 'CAPTURING',
    });
    expect(status).not.toHaveProperty('streamId');
    expect(logSpy.mock.calls.some(args => JSON.stringify(args).includes('stream-secret'))).toBe(false);

    await expect(sendMessage({
      target: 'offscreen',
      action: 'LIVE_DUBBING_DISPOSE',
      data: { sessionId: 'session-1', providerId: 'gemini', reason: 'STOP' },
    })).resolves.toMatchObject({
      success: true,
      ack: 'DISPOSED',
    });
    expect(track.stop).toHaveBeenCalledOnce();
  });
});

describe('offscreen live-dubbing control sender authorization', () => {
  // Document senders always carry browser-generated documentId on supported
  // Chromium; the SW carries none. Fixtures mirror those platform shapes.
  const swSender = { id: 'extension-id', url: 'chrome-extension://extension-id/background.js' };
  const swSenderNoUrl = { id: 'extension-id' };
  const popupSender = { id: 'extension-id', url: 'chrome-extension://extension-id/src/html/popup.html', documentId: 'doc-popup' };
  const optionsSender = { id: 'extension-id', url: 'chrome-extension://extension-id/src/html/options.html', documentId: 'doc-options' };
  const sidepanelSender = { id: 'extension-id', url: 'chrome-extension://extension-id/src/html/sidepanel.html', documentId: 'doc-sidepanel' };
  const contentScriptSender = { id: 'extension-id', url: 'https://example.test/page', tab: { id: 1 }, frameId: 0, documentId: 'doc-content' };
  const offscreenSelfSender = { id: 'extension-id', url: 'chrome-extension://extension-id/src/html/offscreen.html', documentId: 'doc-offscreen' };
  const arbitraryDocumentSender = { id: 'extension-id', url: 'chrome-extension://extension-id/src/html/arbitrary.html', documentId: 'doc-arbitrary' };

  function liveDubbingMessage(action, sessionId = 'auth-session', extraData = {}) {
    return {
      target: 'offscreen',
      action,
      data: { sessionId, providerId: 'gemini', eventSequence: 0, ...extraData },
    };
  }

  it('accepts SW/background PREPARE/CONNECT/DISPOSE lifecycle', async () => {
    const track = {
      kind: 'audio',
      readyState: 'live',
      listeners: new Map(),
      stop: vi.fn(() => {
        track.readyState = 'ended';
      }),
      addEventListener: vi.fn((type, handler) => track.listeners.set(type, handler)),
      removeEventListener: vi.fn(),
    };
    const mediaDevices = {
      getUserMedia: vi.fn(() => Promise.resolve({
        getAudioTracks: () => [track],
        getTracks: () => [track],
      })),
    };
    await loadOffscreen({ mediaDevices });

    await expect(sendMessage(
      liveDubbingMessage('LIVE_DUBBING_PREPARE', 'sw-session'),
      swSender,
    )).resolves.toMatchObject({ success: true, ack: 'READY' });

    // The URL-less Service Worker shape drives the same session idempotently.
    await expect(sendMessage(
      liveDubbingMessage('LIVE_DUBBING_PREPARE', 'sw-session'),
      swSenderNoUrl,
    )).resolves.toMatchObject({ success: true, ack: 'READY' });

    // CONNECT reaches the controller (sequence fence, not authorization):
    // any non-UNAUTHORIZED controller response proves router acceptance.
    const connectResponse = await sendMessage(
      liveDubbingMessage('LIVE_DUBBING_CONNECT_PROVIDER', 'unknown-session', { eventSequence: 2 }),
      swSender,
    );
    expect(connectResponse.error).not.toBe('OFFSCREEN_UNAUTHORIZED');

    await expect(sendMessage(
      liveDubbingMessage('LIVE_DUBBING_CONSUME', 'sw-session', { streamId: 'stream-secret', eventSequence: 1 }),
      swSender,
    )).resolves.toMatchObject({ success: true, ack: 'MEDIA_ACQUIRED' });

    await expect(sendMessage({
      target: 'offscreen',
      action: 'LIVE_DUBBING_DISPOSE',
      data: { sessionId: 'sw-session', providerId: 'gemini', reason: 'STOP' },
    }, swSender)).resolves.toMatchObject({ success: true, ack: 'DISPOSED' });
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it('routes original-volume control only from the background service worker', async () => {
    await loadOffscreen();
    const { liveDubbingController } = await import('../features/live-dubbing/offscreen/LiveDubbingController.js');
    const { LIVE_DUBBING_ACTIONS } = await import('../features/live-dubbing/constants.js');
    const handle = vi.spyOn(liveDubbingController, 'handle');
    const action = LIVE_DUBBING_ACTIONS.SET_ORIGINAL_VOLUME_OFFSCREEN;
    const data = {
      sessionId: 'volume-session',
      providerId: 'gemini',
      volume: 0.4,
      eventSequence: 0,
    };

    await expect(sendMessage({
      target: 'offscreen',
      action: 'LIVE_DUBBING_PREPARE',
      data: { sessionId: data.sessionId, providerId: data.providerId, eventSequence: 0 },
    }, swSender)).resolves.toMatchObject({ success: true, ack: 'READY' });
    handle.mockClear();

    await expect(sendMessage({ target: 'offscreen', action, data }, swSender)).resolves.toEqual({
      success: true,
      sessionId: data.sessionId,
      providerId: data.providerId,
      eventSequence: 0,
      status: 'PREPARING_CAPTURE',
      originalVolume: 0.4,
    });
    expect(handle).toHaveBeenCalledOnce();
    expect(liveDubbingController.currentSession.originalVolume).toBe(0.4);
    handle.mockClear();

    const rejectedSenders = [
      popupSender,
      optionsSender,
      sidepanelSender,
      contentScriptSender,
      offscreenSelfSender,
      arbitraryDocumentSender,
      { id: 'other-extension', url: 'chrome-extension://other-extension/background.js' },
    ];
    for (const sender of rejectedSenders) {
      await expect(sendMessage({
        target: 'offscreen',
        action,
        data: { ...data, volume: 0.8 },
      }, sender)).resolves.toEqual({ success: false, error: 'OFFSCREEN_UNAUTHORIZED' });
    }
    expect(handle).not.toHaveBeenCalled();
    expect(liveDubbingController.currentSession.originalVolume).toBe(0.4);
  });

  it.each([
    ['popup', popupSender],
    ['options', optionsSender],
    ['sidepanel', sidepanelSender],
  ])('rejects %s UI senders for control commands', async (_label, sender) => {
    await loadOffscreen();
    const { liveDubbingController } = await import('../features/live-dubbing/offscreen/LiveDubbingController.js');
    const handle = vi.spyOn(liveDubbingController, 'handle');

    for (const action of ['LIVE_DUBBING_PREPARE', 'LIVE_DUBBING_CONNECT_PROVIDER', 'LIVE_DUBBING_DISPOSE']) {
      await expect(sendMessage(liveDubbingMessage(action, `ui-attack-${action}`), sender))
        .resolves.toEqual({ success: false, error: 'OFFSCREEN_UNAUTHORIZED' });
    }
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects content-script/tab and offscreen-self control invocation', async () => {
    await loadOffscreen();
    const { liveDubbingController } = await import('../features/live-dubbing/offscreen/LiveDubbingController.js');
    const handle = vi.spyOn(liveDubbingController, 'handle');

    const rejectedSenders = [
      contentScriptSender,
      { id: 'extension-id', url: 'chrome-extension://extension-id/src/html/options.html', tab: { id: 42 }, frameId: 0, documentId: 'doc-options-tab' },
      offscreenSelfSender,
      arbitraryDocumentSender,
    ];
    for (const sender of rejectedSenders) {
      for (const action of ['LIVE_DUBBING_PREPARE', 'LIVE_DUBBING_CONNECT_PROVIDER', 'LIVE_DUBBING_DISPOSE']) {
        await expect(sendMessage(liveDubbingMessage(action, `self-attack-${action}`), sender))
          .resolves.toEqual({ success: false, error: 'OFFSCREEN_UNAUTHORIZED' });
      }
    }
    expect(handle).not.toHaveBeenCalled();
  });

  it('fails closed on missing/malformed sender metadata', async () => {
    await loadOffscreen();
    const { liveDubbingController } = await import('../features/live-dubbing/offscreen/LiveDubbingController.js');
    const handle = vi.spyOn(liveDubbingController, 'handle');
    // Bypass the sendMessage helper default sender so undefined/null are
    // delivered verbatim and must still fail closed.
    const rawSend = (message, sender) => new Promise((resolve) => {
      state.listener(message, sender, resolve);
    });

    const malformedSenders = [
      undefined,
      null,
      {},
      { id: 'other-extension', url: 'chrome-extension://other-extension/background.js' },
      { id: 'extension-id', url: 'not a valid url %%' },
      { id: 'extension-id', tab: { id: 1 } },
      'string-sender',
    ];
    for (const sender of malformedSenders) {
      await expect(rawSend(liveDubbingMessage('LIVE_DUBBING_PREPARE', 'malformed-attack'), sender))
        .resolves.toEqual({ success: false, error: 'OFFSCREEN_UNAUTHORIZED' });
    }
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejection mutates no session/provider/capture/lease state', async () => {
    const getUserMedia = vi.fn(() => Promise.resolve({
      getAudioTracks: () => [],
      getTracks: () => [],
    }));
    await loadOffscreen({ mediaDevices: { getUserMedia } });
    const { liveDubbingController } = await import('../features/live-dubbing/offscreen/LiveDubbingController.js');
    const handle = vi.spyOn(liveDubbingController, 'handle');

    for (const sender of [popupSender, optionsSender, contentScriptSender, offscreenSelfSender]) {
      await expect(sendMessage(liveDubbingMessage('LIVE_DUBBING_PREPARE', 'untouched-session'), sender))
        .resolves.toEqual({ success: false, error: 'OFFSCREEN_UNAUTHORIZED' });
    }
    expect(handle).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();

    // No session was created: a trusted STATUS probe observes IDLE/inactive.
    await expect(sendMessage({
      target: 'offscreen',
      action: 'LIVE_DUBBING_STATUS',
      data: { sessionId: 'untouched-session', providerId: 'gemini' },
    }, swSender)).resolves.toMatchObject({
      success: true,
      active: false,
      sessionId: 'untouched-session',
      status: 'IDLE',
    });

    // The attacked identity remains fully usable by its rightful owner.
    await expect(sendMessage(
      liveDubbingMessage('LIVE_DUBBING_PREPARE', 'untouched-session'),
      swSender,
    )).resolves.toMatchObject({ success: true, ack: 'READY' });
  });

  it('rejects arbitrary same-extension documents by document context, not path', async () => {
    await loadOffscreen();
    const { liveDubbingController } = await import('../features/live-dubbing/offscreen/LiveDubbingController.js');
    const handle = vi.spyOn(liveDubbingController, 'handle');

    // chrome-extension://.../arbitrary.html appears in no allowlist or
    // denylist: rejection must come from its document metadata alone.
    for (const action of ['LIVE_DUBBING_PREPARE', 'LIVE_DUBBING_CONNECT_PROVIDER', 'LIVE_DUBBING_DISPOSE']) {
      await expect(sendMessage(liveDubbingMessage(action, 'arbitrary-attack'), arbitraryDocumentSender))
        .resolves.toEqual({ success: false, error: 'OFFSCREEN_UNAUTHORIZED' });
    }
    expect(handle).not.toHaveBeenCalled();

    // Foreign extensions fail closed even with document metadata present.
    await expect(sendMessage(
      liveDubbingMessage('LIVE_DUBBING_PREPARE', 'arbitrary-attack'),
      { id: 'other-extension', url: 'chrome-extension://other-extension/src/html/arbitrary.html', documentId: 'doc-foreign' },
    )).resolves.toEqual({ success: false, error: 'OFFSCREEN_UNAUTHORIZED' });
    expect(handle).not.toHaveBeenCalled();
  });
});

describe('offscreen logging contract', () => {
  it('keeps ordinary INFO/DEBUG activity out of normal test output', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    await loadOffscreen();

    // Every targeted message emits debug + info traces through the gated logger.
    await expect(sendMessage({
      target: 'offscreen',
      action: 'TTS_TEST',
    })).resolves.toEqual({ success: true, message: 'Offscreen TTS ready' });

    expect(logSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('still routes the WARN failure path to the diagnostic channel', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadOffscreen();

    // Authorized action without its required payload falls through to the
    // unknown-action WARN branch.
    await expect(sendMessage({
      target: 'offscreen',
      action: 'TTS_SPEAK',
    })).resolves.toEqual({ success: false, error: 'Unknown offscreen action: TTS_SPEAK' });

    expect(warnSpy).toHaveBeenCalledWith('[Offscreen]', 'Unknown offscreen action', 'TTS_SPEAK');
  });

  it('still routes the ERROR failure path to the diagnostic channel', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await loadOffscreen();

    // The test double provides speechSynthesis without getVoices, so voice
    // lookup throws into the ERROR branch deterministically.
    const response = await sendMessage({
      target: 'offscreen',
      action: 'TTS_GET_VOICES',
    });

    expect(response).toEqual(expect.objectContaining({ success: false }));
    expect(errorSpy).toHaveBeenCalledWith(
      '[Offscreen]',
      'Failed to get TTS voices',
      expect.any(String),
    );
  });
});
