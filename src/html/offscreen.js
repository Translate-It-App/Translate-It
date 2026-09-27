// src/public/offscreen.js
// Chrome-specific offscreen script

import { liveDubbingController } from '../features/live-dubbing/offscreen/LiveDubbingController.js';
import {
  LIVE_DUBBING_OFFSCREEN_ACTIONS,
} from '../features/live-dubbing/constants.js';
import { isAuthorizedOffscreenRouterSender, isAuthorizedLiveDubbingOffscreenControlSender } from '../features/live-dubbing/contracts.js';
import { getScopedLogger } from '../shared/logging/logger.js';
import { LOG_COMPONENTS } from '../shared/logging/logConstants.js';

// Centralized scoped logger: INFO/DEBUG are gated by component level (default WARN),
// warn/error remain functional. 'Offscreen' scope keeps logs identifiable.
const logger = getScopedLogger(LOG_COMPONENTS.BACKGROUND, 'Offscreen');

function getSafeAction(action) {
  return typeof action === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(action)
    ? action
    : 'UNSAFE_ACTION';
}

function getSafeErrorName(error) {
  return /^[A-Za-z]+Error$/.test(error?.name || '') ? error.name : 'UnknownError';
}

const OFFSCREEN_ALLOWED_ACTIONS = new Set([
  ...LIVE_DUBBING_OFFSCREEN_ACTIONS,
  'TTS_SPEAK',
  'TTS_STOP',
  'handleTTSStop',
  'TTS_PAUSE',
  'handleTTSPause',
  'TTS_RESUME',
  'handleTTSResume',
  'handleTTSGetStatus',
  'TTS_TEST',
  'playOffscreenAudio',
  'stopOffscreenAudio',
  'TTS_GET_VOICES',
  'playCachedAudio',
  'OCR_PROCESS',
  'GENERATE_COMPOSITE_ICON',
  'GENERATE_SIMPLE_OVERLAY_ICON',
]);

function isAuthorizedOffscreenMessage(message, sender) {
  return message?.target === 'offscreen'
    && OFFSCREEN_ALLOWED_ACTIONS.has(message?.action)
    && isAuthorizedOffscreenRouterSender(sender, globalThis.chrome);
}

// Import ResourceTracker for memory management
// Note: Since this is an offscreen document, we'll create a simple tracker
class OffscreenResourceTracker {
  constructor() {
    this.timeouts = new Set();
    this.intervals = new Set();
    this.eventListeners = new Map(); // Track event listeners: element -> {event, handler, options}
  }

  trackTimeout(callback, delay) {
    const timeoutId = setTimeout(() => {
      this.timeouts.delete(timeoutId);
      callback();
    }, delay);
    this.timeouts.add(timeoutId);
    return timeoutId;
  }

  clearTimeout(timeoutId) {
    if (this.timeouts.has(timeoutId)) {
      clearTimeout(timeoutId);
      this.timeouts.delete(timeoutId);
    }
  }

  addEventListener(element, event, handler, options = {}) {
    // Store the listener info for cleanup
    if (!this.eventListeners.has(element)) {
      this.eventListeners.set(element, []);
    }
    this.eventListeners.get(element).push({ event, handler, options });

    // Add the actual listener
    element.addEventListener(event, handler, options);
  }

  removeEventListeners(element) {
    const listeners = this.eventListeners.get(element);
    if (!listeners) return;

    for (const { event, handler, options } of listeners) {
      element.removeEventListener(event, handler, options);
    }
    this.eventListeners.delete(element);
  }

  cleanup() {
    // Clear all tracked timeouts
    for (const timeoutId of this.timeouts) {
      clearTimeout(timeoutId);
    }
    this.timeouts.clear();

    // Clear all tracked intervals
    for (const intervalId of this.intervals) {
      clearInterval(intervalId);
    }
    this.intervals.clear();

    // Clear all tracked event listeners
    for (const element of this.eventListeners.keys()) {
      this.removeEventListeners(element);
    }
  }
}

// Create global resource tracker for offscreen
const resourceTracker = new OffscreenResourceTracker();

let currentAudio = null;
let currentUtterance = null;
let currentFetchController = null;
let currentPlayback = null;
const canceledPlaybackTokens = new Set();
const canceledPlaybackTokenTimeouts = new Map();
// Retain canceled tokens only long enough to reject delayed cross-context playback commands.
const CANCELED_PLAYBACK_TOKEN_TTL = 30_000;

function rememberCanceledPlaybackToken(playbackToken) {
  if (playbackToken === undefined || playbackToken === null) return;

  canceledPlaybackTokens.add(playbackToken);
  const existingTimeout = canceledPlaybackTokenTimeouts.get(playbackToken);
  if (existingTimeout !== undefined) resourceTracker.clearTimeout(existingTimeout);

  const timeoutId = resourceTracker.trackTimeout(() => {
    canceledPlaybackTokens.delete(playbackToken);
    canceledPlaybackTokenTimeouts.delete(playbackToken);
  }, CANCELED_PLAYBACK_TOKEN_TTL);
  canceledPlaybackTokenTimeouts.set(playbackToken, timeoutId);
}

function isCurrentPlayback(playback) {
  return currentPlayback === playback && !playback.stopped;
}

function sendPlaybackTerminal(playback, reason) {
  if (!isCurrentPlayback(playback) || playback.terminalSent) return false;

  playback.terminalSent = true;
  Promise.resolve(chrome.runtime.sendMessage({
    action: 'INTERNAL_TTS_CHUNK_FINISHED',
    playbackToken: playback.playbackToken,
    reason
  })).catch((error) => {
    logger.debug('Failed to send internal chunk ended notification', getSafeErrorName(error));
  });
  return true;
}

function clearPlayback(playback) {
  if (currentPlayback !== playback) return;

  if (playback.audio) resourceTracker.removeEventListeners(playback.audio);
  currentPlayback = null;
  if (currentAudio === playback.audio) currentAudio = null;
  if (currentUtterance === playback.utterance) currentUtterance = null;
  if (currentFetchController === playback.fetchController) currentFetchController = null;
  if (playback.speechTimeout !== null) resourceTracker.clearTimeout(playback.speechTimeout);
  if (playback.retryTimeout !== null) resourceTracker.clearTimeout(playback.retryTimeout);
}

function finishPlayback(playback, reason, response = null) {
  if (!isCurrentPlayback(playback)) return false;

  sendPlaybackTerminal(playback, reason);
  clearPlayback(playback);
  sendResponseOnce(playback, response || createTerminalResponse(playback, reason));
  return true;
}

function createTerminalResponse(playback, reason, error = null) {
  if (reason === 'completed') {
    return { success: true, playbackToken: playback.playbackToken, reason };
  }

  return {
    success: false,
    playbackToken: playback.playbackToken,
    reason,
    ...(error ? { error } : {})
  };
}

function stopPlayback(playback, reason = 'stopped') {
  if (!isCurrentPlayback(playback)) return false;

  playback.stopped = true;
  playback.terminalIntent = reason;
  rememberCanceledPlaybackToken(playback.playbackToken);

  // Settle request before cancellation; browser speech cancellation can fire onend synchronously.
  sendResponseOnce(playback, createTerminalResponse(playback, reason));
  const fetchController = playback.fetchController;
  if (playback.fetchController) {
    playback.fetchController.abort();
    playback.fetchController = null;
  }
  if (currentFetchController === fetchController) currentFetchController = null;

  if (playback.utterance && typeof speechSynthesis !== 'undefined') {
    speechSynthesis.cancel();
  }

  if (playback.audio) {
    playback.audio.pause();
    try {
      playback.audio.src = '';
    } catch { /* ignore */ }
  }

  if (playback.audioUrl) {
    URL.revokeObjectURL(playback.audioUrl);
    playback.audioUrl = null;
  }

  clearPlayback(playback);
  return true;
}

function createPlayback(playbackToken, sendResponse) {
  const playback = {
    playbackToken: playbackToken ?? null,
    audio: null,
    audioUrl: null,
    utterance: null,
    fetchController: null,
    terminalSent: false,
    stopped: false,
    fallbackStarted: false,
    retryScheduled: false,
    speechStarted: false,
    speechTimeout: null,
    retryTimeout: null,
    responseSent: false,
    responseSettlement: {
      sendResponse,
      settled: false
    },
    terminalIntent: null
  };

  if (playbackToken !== undefined && playbackToken !== null && canceledPlaybackTokens.has(playbackToken)) {
    playback.stopped = true;
    sendResponseOnce(playback, createTerminalResponse(playback, 'stopped', 'Playback was stopped'));
    return null;
  }

  if (currentPlayback) stopPlayback(currentPlayback, 'interrupted');
  currentPlayback = playback;
  return playback;
}

function sendResponseOnce(playback, sendResponse, response) {
  if (response === undefined) {
    response = sendResponse;
    sendResponse = playback.responseSettlement?.sendResponse;
  }
  if (!playback.responseSettlement) {
    playback.responseSettlement = {
      sendResponse,
      settled: false
    };
  }
  if (playback.responseSettlement.settled || playback.responseSent) return;
  playback.responseSettlement.settled = true;
  playback.responseSent = true;
  try {
    sendResponse(response);
  } catch (error) {
    logger.debug('Playback response settlement failed', getSafeErrorName(error));
  }
}

logger.info("TTS script loaded - Version 1.6 - Tokenized playback lifecycle");

// Signal readiness immediately to parent
if (chrome.runtime) {
  chrome.runtime.sendMessage({ action: "OFFSCREEN_READY" }).catch(() => {});
  // Try multiple times to ensure readiness is sent
  resourceTracker.trackTimeout(() => chrome.runtime.sendMessage({ action: "OFFSCREEN_READY" }).catch(() => {}), 100);
  resourceTracker.trackTimeout(() => chrome.runtime.sendMessage({ action: "OFFSCREEN_READY" }).catch(() => {}), 500);
}


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;
  if (LIVE_DUBBING_OFFSCREEN_ACTIONS.includes(message?.action)
    && !isAuthorizedLiveDubbingOffscreenControlSender(sender, globalThis.chrome)) {
    // Live Dubbing lifecycle/control commands are Background-SW-only. UI
    // documents, content-script/tab senders, and offscreen-self invocation
    // are rejected here before any session/provider/capture state is touched.
    sendResponse?.({ success: false, error: 'OFFSCREEN_UNAUTHORIZED' });
    return false;
  }
  if (!isAuthorizedOffscreenMessage(message, sender)) {
    sendResponse?.({ success: false, error: 'OFFSCREEN_UNAUTHORIZED' });
    return false;
  }

  logger.debug('Received message', {
    action: getSafeAction(message?.action),
    targeted: message?.target === 'offscreen',
    hasData: Boolean(message?.data),
  });
  

  // Remove forwardedFromBackground flag if present (clean up)
  const cleanMessage = { ...message };
  delete cleanMessage.forwardedFromBackground;
  delete cleanMessage.target;

  logger.info('Processing message targeted for offscreen', {
    action: getSafeAction(cleanMessage.action),
  });

  // Handle different TTS and audio actions
  const action = cleanMessage.action;

  if (liveDubbingController.handles(action)) {
    try {
      Promise.resolve(liveDubbingController.handle(cleanMessage))
        .then(sendResponse)
        .catch(() => sendResponse({
          success: false,
          error: 'LIVE_DUBBING_OFFSCREEN_FAILED',
        }));
    } catch {
      sendResponse({ success: false, error: 'LIVE_DUBBING_OFFSCREEN_FAILED' });
    }
    return true;
  }
  
  if (action === "TTS_SPEAK" && cleanMessage.data) {
    handleTTSSpeak(cleanMessage.data, sendResponse);
    return true; // keep async channel open
  }
  else if (action === "TTS_STOP" || action === "handleTTSStop") {
    handleTTSStop(sendResponse, cleanMessage.playbackToken);
    return true;
  }
  else if (action === "TTS_PAUSE" || action === "handleTTSPause") {
    handleTTSPause(sendResponse);
    return true;
  }
  else if (action === "TTS_RESUME" || action === "handleTTSResume") {
    handleTTSResume(sendResponse);
    return true;
  }
  else if (action === "handleTTSGetStatus") {
    handleTTSGetStatus(sendResponse);
    return true;
  }
  else if (action === "TTS_TEST") {
    sendResponse({ success: true, message: "Offscreen TTS ready" });
    return false; // synchronous response
  }
  else if (action === "playOffscreenAudio" && cleanMessage.url) {
    const ttsData = {
      text: cleanMessage.text || "TTS Audio",
      language: cleanMessage.language || "en"
    };
    handleAudioPlaybackWithFallback(cleanMessage.url, ttsData, sendResponse, cleanMessage.playbackToken);
    return true;
  }
  else if (action === "stopOffscreenAudio") {
    handleAudioStop(sendResponse);
    return true;
  }
  else if (action === "TTS_GET_VOICES") {
    handleTTSGetVoices(sendResponse);
    return true;
  }
  else if (action === "playCachedAudio" && cleanMessage.audioData) {
    handleCachedAudioPlayback(cleanMessage.audioData, sendResponse, cleanMessage.playbackToken);
    return true;
  }
  else if (action === "OCR_PROCESS" && cleanMessage.data) {
    handleOCRProcess(cleanMessage.data, sendResponse);
    return true; // keep async channel open
  }
  else if (action === "GENERATE_COMPOSITE_ICON" && cleanMessage.data) {
    // Handle composite icon generation inline
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = 32;
      canvas.height = 32;

      const baseImg = new Image();
      const overlayImg = new Image();

      let loadedCount = 0;
      let totalImages = cleanMessage.data.overlayBlob ? 2 : 1;

      const onLoad = () => {
        loadedCount++;
        if (loadedCount === totalImages) {
          // Draw base icon
          ctx.drawImage(baseImg, 0, 0, 32, 32);

          // Draw provider icon as small overlay in bottom-right corner if available
          if (cleanMessage.data.overlayBlob) {
            const overlaySize = 20;
            const overlayX = 32 - overlaySize - 2;
            const overlayY = 32 - overlaySize - 2;

            // Draw provider icon directly without background
            ctx.drawImage(overlayImg, overlayX, overlayY, overlaySize, overlaySize);
          }

          // Convert to ImageData
          const imageData = ctx.getImageData(0, 0, 32, 32);
          
          // Convert ImageData to transferable format
          sendResponse({ 
            success: true, 
            imageData: {
              width: imageData.width,
              height: imageData.height,
              data: Array.from(imageData.data)
            }
          });
        }
      };

      const onError = () => {
        sendResponse({ success: false, error: 'Failed to load image' });
      };

      baseImg.onload = onLoad;
      baseImg.onerror = onError;
      overlayImg.onload = onLoad;
      overlayImg.onerror = onError;

      baseImg.crossOrigin = 'anonymous';
      overlayImg.crossOrigin = 'anonymous';

      baseImg.src = cleanMessage.data.baseBlob;
      if (cleanMessage.data.overlayBlob) {
        overlayImg.src = cleanMessage.data.overlayBlob;
      }
      
    } catch {
      sendResponse({ success: false, error: 'Composite icon generation failed' });
    }
    return true;
  }
  else if (action === "GENERATE_SIMPLE_OVERLAY_ICON" && cleanMessage.data) {
    // Handle simple overlay icon generation
    logger.info('Generating simple overlay icon', {
      hasProvider: typeof cleanMessage.data.provider === 'string',
    });
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = 32;
      canvas.height = 32;

      // Create a simple base icon (blue square)
      ctx.fillStyle = '#4285f4';
      ctx.fillRect(0, 0, 32, 32);

      // Add provider-specific color overlay
      const providerColors = {
        'google': '#4285f4',
        'gemini': '#8e44ad',
        'bing': '#00BCF2',
        'yandex': '#FF0000',
        'openai': '#412991',
        'openrouter': '#FF6B35',
        'requesty': '#34D399',
        'deepseek': '#00A67E',
        'webai': '#FF9500',
        'custom': '#9CA3AF',
        'browserapi': '#4CAF50'
      };

      const overlayColor = providerColors[cleanMessage.data.provider] || '#9CA3AF';
      
      // Draw small colored square in bottom-right
      ctx.fillStyle = overlayColor;
      ctx.fillRect(20, 20, 10, 10);

      // Add white border
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1;
      ctx.strokeRect(20, 20, 10, 10);

      // Convert to ImageData
      const imageData = ctx.getImageData(0, 0, 32, 32);
      
      sendResponse({ 
        success: true, 
        imageData: {
          width: imageData.width,
          height: imageData.height,
          data: Array.from(imageData.data)
        }
      });
    } catch {
      sendResponse({ success: false, error: 'Simple overlay icon generation failed' });
    }
    return true;
  }
  else {
    logger.warn('Unknown offscreen action', getSafeAction(action));
    sendResponse({ success: false, error: `Unknown offscreen action: ${action}` });
    return false;
  }
});

/**
 * Handle TTS speak using Web Speech API
 */
function handleTTSSpeak(data, sendResponse) {
  try {
    logger.info('Starting TTS speak', {
      hasText: typeof data?.text === 'string',
      hasLanguage: typeof (data?.language || data?.lang) === 'string',
    });

    // Convert language code to simple format for Google TTS
    let langCode = data.language || data.lang || "en"; // Support both 'language' and 'lang' parameters
    if (langCode.includes("-")) {
      langCode = langCode.split("-")[0]; // Convert 'en-US' to 'en'
    }
    
    logger.debug('Language parameter debug', {
      hasLanguage: Boolean(data.language),
      hasLegacyLanguage: Boolean(data.lang),
      finalLanguage: /^[A-Za-z-]{1,20}$/.test(langCode) ? langCode : 'unknown',
    });

    // Try Google TTS first, then fallback to Web Speech API
    logger.debug('Trying Google TTS', {
      language: /^[A-Za-z-]{1,20}$/.test(langCode) ? langCode : 'unknown',
    });
    const googleTTSUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(langCode)}&q=${encodeURIComponent(data.text)}&client=gtx&ttsspeed=1&total=1&idx=0&tk=1`;
    
    // Attempt Google TTS with fallback
    handleAudioPlaybackWithFallback(googleTTSUrl, data, sendResponse, data.playbackToken);
  } catch (error) {
    logger.error('TTS speak failed', getSafeErrorName(error));
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Handle TTS get voices
 */
function handleTTSGetVoices(sendResponse) {
  try {
    logger.info("Getting available TTS voices");
    
    if ("speechSynthesis" in window) {
      // Get available voices
      let voices = speechSynthesis.getVoices();
      
      // If voices array is empty, wait for voiceschanged event
      if (voices.length === 0) {
        let responseAlreadySent = false;
        
        const voicesChangedHandler = () => {
          if (responseAlreadySent) return;
          responseAlreadySent = true;
          
          voices = speechSynthesis.getVoices();
          logger.info("Voices loaded:", voices.length);
          sendResponse({ 
            success: true, 
            voices: voices.map(voice => ({
              name: voice.name,
              lang: voice.lang,
              default: voice.default,
              localService: voice.localService
            }))
          });
        };
        
        speechSynthesis.addEventListener('voiceschanged', voicesChangedHandler, { once: true });
        
        // Set a timeout in case voiceschanged doesn't fire
        resourceTracker.trackTimeout(() => {
          if (responseAlreadySent) return;
          responseAlreadySent = true;
          
          voices = speechSynthesis.getVoices();
          logger.info("Timeout reached, voices available:", voices.length);
          sendResponse({ 
            success: true, 
            voices: voices.map(voice => ({
              name: voice.name,
              lang: voice.lang,
              default: voice.default,
              localService: voice.localService
            }))
          });
        }, 1000);
      } else {
        logger.info("Voices available:", voices.length);
        sendResponse({ 
          success: true, 
          voices: voices.map(voice => ({
            name: voice.name,
            lang: voice.lang,
            default: voice.default,
            localService: voice.localService
          }))
        });
      }
    } else {
      logger.warn("Speech synthesis not available");
      sendResponse({ success: true, voices: [] });
    }
  } catch (error) {
    logger.error('Failed to get TTS voices', getSafeErrorName(error));
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Handle TTS stop
 */
function handleTTSStop(sendResponse, playbackToken) {
  // Create safe response wrapper to prevent duplicate calls
  let responseSent = false;
  const safeResponse = (response) => {
    if (!responseSent) {
      responseSent = true;
      try {
        sendResponse(response);
      } catch (error) {
        logger.debug('Response already sent or connection closed', getSafeErrorName(error));
      }
    } else {
      logger.debug("Duplicate response attempt blocked");
    }
  };

  try {
    const hasPlaybackToken = playbackToken !== undefined && playbackToken !== null;
    if (hasPlaybackToken) {
      rememberCanceledPlaybackToken(playbackToken);
    } else if (currentPlayback?.playbackToken !== undefined && currentPlayback?.playbackToken !== null) {
      rememberCanceledPlaybackToken(currentPlayback.playbackToken);
    }

    if (
      hasPlaybackToken &&
      (!currentPlayback || currentPlayback.playbackToken !== playbackToken)
    ) {
      // Token-scoped stop against a non-current playback token. Return the
      // CURRENT physical playback identity so the caller can reconcile
      // whether its captured predecessor is still active (B), already
      // displaced by something else (C-null), or replaced by a newer
      // generation (C-different). Playback tokens are internal generation
      // identifiers, safe to surface across the background/offscreen boundary.
      const currentPhysical = currentPlayback?.playbackToken ?? null;
      safeResponse({
        success: true,
        skipped: true,
        currentPlaybackToken: currentPhysical,
      });
      return;
    }

    const stopped = currentPlayback ? stopPlayback(currentPlayback) : false;
    // When the supplied token matched the current physical playback, include
    // the stopped token so the caller can confirm exact identity without
    // round-tripping to read StateManager state.
    safeResponse({
      success: true,
      stopped,
      playbackToken: hasPlaybackToken ? playbackToken : (currentPlayback?.playbackToken ?? null),
    });
  } catch (error) {
    logger.error('TTS stop failed', getSafeErrorName(error));
    safeResponse({ success: false, error: error.message });
  }
}

/**
 * Handle TTS pause
 * Note: Currently unused in the project, added for future extensibility.
 */
function handleTTSPause(sendResponse) {
  try {
    let paused = false;

    if (currentUtterance && speechSynthesis.speaking && !speechSynthesis.paused) {
      speechSynthesis.pause();
      paused = true;
      logger.info("TTS speech paused");
    }

    if (currentAudio && !currentAudio.paused) {
      currentAudio.pause();
      paused = true;
      logger.info("TTS audio paused");
    }

    sendResponse({ success: true, paused });
  } catch (error) {
    logger.error('TTS pause failed', getSafeErrorName(error));
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Handle TTS resume
 * Note: Currently unused in the project, added for future extensibility.
 */
function handleTTSResume(sendResponse) {
  try {
    let resumed = false;

    if (currentUtterance && speechSynthesis.paused) {
      speechSynthesis.resume();
      resumed = true;
      logger.info("TTS speech resumed");
    }

    if (currentAudio && currentAudio.paused) {
      currentAudio.play().catch(error => {
        logger.error('TTS audio resume failed', getSafeErrorName(error));
      });
      resumed = true;
      logger.info("TTS audio resumed");
    }

    sendResponse({ success: true, resumed });
  } catch (error) {
    logger.error('TTS resume failed', getSafeErrorName(error));
    sendResponse({ success: false, error: error.message });
  }
}


/**
 * Handle TTS get status
 */
function handleTTSGetStatus(sendResponse) {
  try {
    let status = 'idle';
    
    // Check speech synthesis status
    if (currentUtterance) {
      if (speechSynthesis.paused) {
        status = 'paused';
      } else if (speechSynthesis.speaking) {
        status = 'playing';
      }
    }
    
    // Check audio playback status
    if (currentAudio) {
      if (currentAudio.paused) {
        status = currentAudio.currentTime > 0 ? 'paused' : 'idle';
      } else {
        status = 'playing';
      }
    }
    
    sendResponse({ success: true, status });
  } catch (error) {
    logger.error('TTS get status failed', getSafeErrorName(error));
    sendResponse({ success: false, error: error.message, status: 'error' });
  }
}

/**
 * Handle audio playback with fallback to Web Speech API
 * @param {string} url - Audio URL
 * @param {Object} ttsData - TTS fallback data
 * @param {Function} sendResponse - Response callback
 * @param {string} playbackToken - Playback generation token
 */
function handleAudioPlaybackWithFallback(url, ttsData, sendResponse, playbackToken) {
  try {
    const playback = createPlayback(playbackToken, sendResponse);
    if (!playback) return;
    const newAudio = new Audio();
    playback.audio = newAudio;
    currentAudio = newAudio;
    newAudio.crossOrigin = "anonymous";
    playback.fetchController = new AbortController();
    currentFetchController = playback.fetchController;

    const fetchTimeout = resourceTracker.trackTimeout(() => {
      if (!isCurrentPlayback(playback) || playback.fallbackStarted) return;

      playback.fallbackStarted = true;
      playback.fetchController?.abort();
      playback.fetchController = null;
      currentFetchController = null;
      handleWebSpeechFallback(ttsData, sendResponse, playback);
    }, 3000);

    fetch(url, {
      method: 'GET',
      signal: playback.fetchController.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://translate.google.com/',
        'Accept': 'audio/*,*/*;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    })
      .then(response => {
        resourceTracker.clearTimeout(fetchTimeout);
        if (!isCurrentPlayback(playback)) return null;
        playback.fetchController = null;
        currentFetchController = null;
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        return response.blob();
      })
      .then(audioBlob => {
        if (!audioBlob || !isCurrentPlayback(playback)) return null;

        const audioUrl = URL.createObjectURL(audioBlob);
        playback.audioUrl = audioUrl;
        playback.audio.src = audioUrl;

        resourceTracker.addEventListener(playback.audio, "ended", () => {
          URL.revokeObjectURL(audioUrl);
          playback.audioUrl = null;
          finishPlayback(playback, 'completed');
        });

        resourceTracker.addEventListener(playback.audio, "error", () => {
          URL.revokeObjectURL(audioUrl);
          playback.audioUrl = null;
          if (!isCurrentPlayback(playback) || playback.fallbackStarted) return;
          resourceTracker.removeEventListeners(playback.audio);
          playback.audio = null;
          currentAudio = null;
          playback.fallbackStarted = true;
          handleWebSpeechFallback(ttsData, sendResponse, playback);
        });

        return playback.audio.play();
      })
      .then(() => {
        if (isCurrentPlayback(playback)) {
          sendResponseOnce(playback, sendResponse, { success: true, message: "Audio playback started" });
        }
      })
      .catch((error) => {
        resourceTracker.clearTimeout(fetchTimeout);
        if (!isCurrentPlayback(playback) || playback.fallbackStarted) return;

        if (error.name === 'AbortError') return;
        playback.fetchController = null;
        currentFetchController = null;
        resourceTracker.removeEventListeners(playback.audio);
        playback.audio = null;
        currentAudio = null;
        playback.fallbackStarted = true;
        logger.debug('Google TTS failed, using Web Speech fallback', getSafeErrorName(error));
        handleWebSpeechFallback(ttsData, sendResponse, playback);
      });
  } catch (error) {
    logger.error('TTS setup failed', getSafeErrorName(error));
    if (currentPlayback && isCurrentPlayback(currentPlayback)) {
      currentPlayback.fallbackStarted = true;
      handleWebSpeechFallback(ttsData, sendResponse, currentPlayback);
    }
  }
}

/**
 * Fallback to Web Speech API with improved reliability
 */
function handleWebSpeechFallback(data, sendResponse, playback) {
  const activePlayback = playback || currentPlayback;
  if (!activePlayback || !isCurrentPlayback(activePlayback)) return;

  const respond = (response) => sendResponseOnce(activePlayback, sendResponse, response);

  const fail = (message, { cancelSpeech = false } = {}) => {
    if (!isCurrentPlayback(activePlayback)) return;
    activePlayback.terminalIntent = 'error';
    activePlayback.utterance = null;
    if (currentUtterance) currentUtterance = null;
    if (cancelSpeech) {
      // Detach record before cancel; some engines invoke onend synchronously.
      speechSynthesis.cancel();
    }
    finishPlayback(activePlayback, 'error', {
      success: false,
      playbackToken: activePlayback.playbackToken,
      reason: 'error',
      error: message
    });
  };

  const clearSpeechTimeout = () => {
    if (activePlayback.speechTimeout !== null) {
      resourceTracker.clearTimeout(activePlayback.speechTimeout);
      activePlayback.speechTimeout = null;
    }
  };

  const startWebSpeech = (retry = false) => {
    if (!isCurrentPlayback(activePlayback)) return;

    const utterance = new SpeechSynthesisUtterance(data.text);
    activePlayback.utterance = utterance;
    activePlayback.speechStarted = false;
    currentUtterance = utterance;

    const voiceLang = data.language || data.lang;
    if (voiceLang) utterance.lang = voiceLang;
    utterance.rate = retry ? 1 : (data.rate ? Math.max(0.1, Math.min(10, data.rate)) : 1);
    utterance.pitch = retry ? 1 : (data.pitch ? Math.max(0, Math.min(2, data.pitch)) : 1);
    utterance.volume = retry ? 1 : (data.volume ? Math.max(0, Math.min(1, data.volume)) : 1);

    const isActiveUtterance = () => isCurrentPlayback(activePlayback) && activePlayback.utterance === utterance;

    utterance.onend = () => {
      clearSpeechTimeout();
      if (!isActiveUtterance()) return;
      finishPlayback(activePlayback, 'completed');
      respond({ success: true });
    };

    utterance.onerror = (error) => {
      clearSpeechTimeout();
      if (!isActiveUtterance()) return;

      activePlayback.utterance = null;
      currentUtterance = null;
      const errorType = error.error || 'unknown';
      if (!retry && (errorType === 'synthesis-failed' || errorType === 'synthesis-unavailable')) {
        activePlayback.retryScheduled = true;
        activePlayback.retryTimeout = resourceTracker.trackTimeout(() => {
          activePlayback.retryTimeout = null;
          if (!isCurrentPlayback(activePlayback)) return;
          speechSynthesis.cancel();
          startSafely(true);
        }, 500);
        return;
      }

      fail(retry ? `Web Speech retry failed: ${errorType}` : `Web Speech API failed: ${errorType}`);
    };

    utterance.onstart = () => {
      activePlayback.speechStarted = true;
      clearSpeechTimeout();
      logger.info("Web Speech TTS started");
    };

    // Keep startup failure bounded, but never terminate speech solely because utterance is long.
    activePlayback.speechTimeout = resourceTracker.trackTimeout(() => {
      activePlayback.speechTimeout = null;
      if (!isActiveUtterance()) return;
      if (activePlayback.speechStarted || speechSynthesis.speaking) return;
      logger.warn("Web Speech TTS startup timeout, cancelling");
      fail("Web Speech API timeout", { cancelSpeech: true });
    }, 5000);

    speechSynthesis.speak(utterance);
    sendResponseOnce(activePlayback, sendResponse, { success: true, message: "Web Speech playback started" });
  };

  const startSafely = (retry = false) => {
    try {
      startWebSpeech(retry);
    } catch (error) {
      fail(`All TTS methods failed: ${error.message}`);
    }
  };

  try {
    logger.info("Using Web Speech API fallback");
    if (!("speechSynthesis" in window)) {
      throw new Error("Web Speech API not available");
    }

    activePlayback.fallbackStarted = true;
    if (speechSynthesis.pending || speechSynthesis.speaking) {
      speechSynthesis.cancel();
      activePlayback.retryTimeout = resourceTracker.trackTimeout(() => {
        activePlayback.retryTimeout = null;
        startSafely();
      }, 100);
    } else {
      startSafely();
    }
  } catch (error) {
    logger.error('Web Speech API fallback failed', getSafeErrorName(error));
    fail(`All TTS methods failed: ${error.message}`);
  }
}

/**
 * Handle audio stop (legacy support)
 */
function handleAudioStop(sendResponse) {
  sendResponse({ success: true, stopped: currentPlayback ? stopPlayback(currentPlayback) : false });
}

/**
 * Handle cached audio blob playback
 * @param {Array} audioData - Audio data as byte array
 * @param {Function} sendResponse - Response callback
 * @param {string} playbackToken - Playback generation token
 */
function handleCachedAudioPlayback(audioData, sendResponse, playbackToken) {
  let playback = null;
  try {
    logger.info("Playing cached audio blob (bytes):", audioData.length);

    playback = createPlayback(playbackToken, sendResponse);
    if (!playback) return;

    // Convert byte array back to Blob
    const uint8Array = new Uint8Array(audioData);
    const audioBlob = new Blob([uint8Array], { type: 'audio/mpeg' });
    const audioUrl = URL.createObjectURL(audioBlob);
    
    logger.debug('Created cached audio blob');

    // Create and setup audio element
    playback.audioUrl = audioUrl;
    playback.audio = new Audio(audioUrl);
    currentAudio = playback.audio;
    
    // NO crossOrigin needed for local Blobs, can cause issues in some environments
    // currentAudio.crossOrigin = "anonymous";

    resourceTracker.addEventListener(playback.audio, "ended", () => {
      logger.info("Cached audio playback ended");
      URL.revokeObjectURL(audioUrl); // Clean up memory
      playback.audioUrl = null;
      finishPlayback(playback, 'completed');
    });

    resourceTracker.addEventListener(playback.audio, "error", () => {
      logger.error('Cached audio playback error');
      URL.revokeObjectURL(audioUrl); // Clean up memory
      playback.audioUrl = null;
      if (!isCurrentPlayback(playback)) return;
      finishPlayback(playback, 'error', {
        success: false,
        playbackToken: playback.playbackToken,
        reason: 'error',
        error: "Audio playback failed"
      });
    });

    resourceTracker.addEventListener(playback.audio, "loadstart", () => {
      logger.debug("Cached audio loading started");
    });

    // Start playback
    playback.audio
      .play()
      .then(() => {
        logger.info("Cached audio playback started successfully");
        if (isCurrentPlayback(playback)) {
          sendResponseOnce(playback, sendResponse, { success: true, message: "Cached audio playback started" });
        }
      })
      .catch((err) => {
        logger.error('Cached audio play failed', getSafeErrorName(err));
        URL.revokeObjectURL(audioUrl);
        playback.audioUrl = null;
        if (isCurrentPlayback(playback)) {
          finishPlayback(playback, 'error', {
            success: false,
            playbackToken: playback.playbackToken,
            reason: 'error',
            error: err.message
          });
        }
      });
      
  } catch (error) {
    logger.error('Cached audio setup failed', getSafeErrorName(error));
    if (currentPlayback) {
      finishPlayback(currentPlayback, 'error', {
        success: false,
        playbackToken: currentPlayback.playbackToken,
        reason: 'error',
        error: error.message
      });
    } else {
      sendResponse({ success: false, error: error.message });
    }
  }
}

let ocrEngine = null;

/**
 * Handle OCR processing with lazy loading
 */
async function handleOCRProcess(data, sendResponse) {
  logger.info('handleOCRProcess started', {
    hasLanguage: typeof data?.lang === 'string',
  });
  try {
    if (!ocrEngine) {
      logger.info("Loading OCR engine module...");
      const module = await import('../features/screen-capture/services/ocrEngine.js');
      ocrEngine = module;
      logger.info("OCR engine module loaded");
    }

    const { image, lang, coordinates } = data;

    logger.info('Starting recognition', {
      hasLanguage: typeof lang === 'string',
    });
    const text = await ocrEngine.recognize(image, lang, coordinates);
    logger.info("Recognition successful, extracted text length:", text?.length);
    sendResponse({ success: true, text });
  } catch (error) {
    logger.error('OCR process failed', getSafeErrorName(error));

    // Extract as much info as possible
    let errorMessage = "Unknown OCR error";
    if (typeof error === 'string') {
      errorMessage = error;
    } else if (error && typeof error === 'object') {
      errorMessage = error.message || error.statusText || JSON.stringify(error);
    }

    sendResponse({
      success: false,
      error: errorMessage,
      stack: error?.stack || new Error().stack
    });
  }
}
// Phase D OpenAI spike listener (DEV ONLY): shaken out of production builds.
// Internal dev listener for START/STOP/STATUS; exposes nothing on
// globalThis. No production wiring: non-spike traffic is never matched.
if (typeof __IS_DEVELOPMENT__ !== 'undefined' && __IS_DEVELOPMENT__) {
  import('../features/live-dubbing/spikes/openai/spikeDevOffscreen.js').then(
    (module) => {
      try {
        module.installOpenAISpikeDevOffscreenListener?.();
      } catch { /* dev-only install is best effort */ }
    },
  ).catch(() => {});
}

// Cleanup resources when page unloads
resourceTracker.addEventListener(window, 'beforeunload', () => {
  logger.debug('Offscreen document unloading, cleaning up resources...');
  resourceTracker.cleanup();
  
  if (currentPlayback) stopPlayback(currentPlayback);
  
  logger.debug('Offscreen cleanup completed');
});
