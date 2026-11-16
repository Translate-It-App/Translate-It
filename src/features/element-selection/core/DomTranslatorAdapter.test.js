import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';

const nativeGetComputedStyle = window.getComputedStyle.bind(window);
let fontPolicyComputedStyleSpy;

const enableFontPolicyStyles = () => {
  if (fontPolicyComputedStyleSpy) return;
  fontPolicyComputedStyleSpy = vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    if (pseudo) return { content: 'none' };
    return nativeGetComputedStyle(element, pseudo);
  });
};

// Mock dependencies
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    operation: vi.fn()
  }))
}));

vi.mock('@/config.js', () => ({
  getTranslationApiAsync: vi.fn(() => Promise.resolve('gemini')),
  getEffectiveProviderAsync: vi.fn(() => Promise.resolve('gemini')),
  getTargetLanguageAsync: vi.fn(() => Promise.resolve('fa')),
  getAIContextTranslationEnabledAsync: vi.fn(() => Promise.resolve(true)),
  getSourceLanguageAsync: vi.fn(() => Promise.resolve('en')),
  getFeatureSemanticBlockGroupingAsync: vi.fn(() => Promise.resolve(false)),
  getSelectElementUseTranslationFontAsync: vi.fn(() => Promise.resolve(false)),
  getTranslationFontFamilyAsync: vi.fn(() => Promise.resolve('auto'))
}));

vi.mock('@/shared/config/constants.js', () => ({
  AUTO_DETECT_VALUE: 'auto',
  TRANSLATION_STATUS: {
    TRANSLATING: 'translating',
    COMPLETED: 'completed',
    ERROR: 'error'
  }
}));

vi.mock('@/shared/config/config.js', () => ({
  getEffectiveProviderAsync: vi.fn(() => Promise.resolve('gemini')),
  TranslationMode: {
    Select_Element: 'select-element'
  }
}));

vi.mock('@/shared/fonts/TranslationFontResolver.js', () => ({
  resolveTranslationFontFamily: vi.fn(() => 'system-ui')
}));

vi.mock('@/shared/messaging/core/UnifiedMessaging.js', () => ({
  sendRegularMessage: vi.fn(() => Promise.resolve())
}));

vi.mock('@/shared/messaging/core/ContentScriptIntegration.js', () => ({
  registerTranslation: vi.fn(),
  contentScriptIntegration: {
    initialize: vi.fn(() => Promise.resolve()),
    sendTranslationRequest: vi.fn(() => Promise.resolve({ success: true, streaming: true })),
    cancelTranslationRequest: vi.fn(),
    streamingHandler: {
      cancelHandler: vi.fn()
    }
  }
}));

// Re-export mocked functions for easy access in tests
const { registerTranslation, contentScriptIntegration } = await import('@/shared/messaging/core/ContentScriptIntegration.js');
const { sendRegularMessage } = await import('@/shared/messaging/core/UnifiedMessaging.js');
const { resolveTranslationFontFamily } = await import('@/shared/fonts/TranslationFontResolver.js');

vi.mock('@/shared/error-management/ErrorHandler.js');
vi.mock('@/shared/error-management/ErrorMatcher.js');
vi.mock('@/shared/error-management/ErrorTypes.js', async () => {
  const actual = await vi.importActual('@/shared/error-management/ErrorTypes.js');
  return actual;
});

vi.mock('@/core/extensionContext.js', () => ({
  default: {
    isValidSync: vi.fn(() => true),
  },
}));

import { ErrorHandler } from '@/shared/error-management/ErrorHandler.js';
const errorHandlerMock = ErrorHandler.getInstance();
const { default: ExtensionContextManager } = await import('@/core/extensionContext.js');
const { isTransientError } = await import('@/shared/error-management/ErrorMatcher.js');

vi.mock('@/utils/dom/DomDirectionManager.js', () => ({
  detectDirectionFromContent: vi.fn(() => 'rtl'),
  applyNodeDirection: vi.fn(),
  captureNodeDirectionState: vi.fn(() => []),
  captureElementDirectionState: vi.fn(() => null),
  restoreNodeDirectionState: vi.fn(() => []),
  applyElementDirection: vi.fn(),
  BIDI_MARKS: { RLM: '\u200f', LRM: '\u200e' }
}));

vi.mock('./DomTranslatorUtils.js', () => ({
  collectTextNodes: vi.fn((el) => [
    { node: el.firstChild, text: 'Hello', uid: 'n1', blockId: 'b1', role: 'div' }
  ]),
  collectBlockGroups: vi.fn((el) => [
    { id: 'n1', blockId: 'g1', text: 'Hello', leadingWS: '', trailingWS: '', preWhitespace: false, directionHint: 'ltr', inlineParentTags: ['div'], mode: 'standard', node: el.firstChild }
  ]),
  generateElementId: vi.fn(() => 'test-el-id'),
  extractContextMetadata: vi.fn(() => ({ contextSummary: 'test context' }))
}));

vi.mock('./DomTranslatorState.js', async () => {
  const actual = await vi.importActual('./DomTranslatorState.js');
  return {
    ...actual,
    revertSelectElementTranslation: vi.fn(actual.revertSelectElementTranslation),
    getSelectElementTranslationState: vi.fn(actual.getSelectElementTranslationState)
  };
});

import { 
  globalSelectElementState 
} from './DomTranslatorState.js';

vi.mock('@/features/shared/hover-preview/HoverPreviewLookup.js', () => ({
  hoverPreviewLookup: {
    add: vi.fn(),
    get: vi.fn(),
    delete: vi.fn()
  }
}));

vi.mock('@/features/page-translation/PageTranslationConstants.js', () => ({
  PAGE_TRANSLATION_ATTRIBUTES: {
    HAS_ORIGINAL: 'data-has-original'
  }
}));

vi.mock('@/core/memory/ResourceTracker.js', () => ({
  default: class ResourceTracker {
    constructor() {
      this.resources = new Set();
    }
    trackResource() {}
    cleanup() {}
  }
}));

import { DomTranslatorAdapter } from './DomTranslatorAdapter.js';
import { hoverPreviewLookup } from '@/features/shared/hover-preview/HoverPreviewLookup.js';

describe('DomTranslatorAdapter', () => {
  let adapter;
  let testElement;

  beforeEach(() => {
    vi.clearAllMocks();
    ExtensionContextManager.isValidSync.mockReturnValue(true);
    globalSelectElementState.translationHistory = [];
    globalSelectElementState.auxiliaryOwnership = new Map();
    adapter = new DomTranslatorAdapter();
    testElement = document.createElement('div');    testElement.textContent = 'Hello';
    document.body.appendChild(testElement);
  });

  afterEach(() => {
    fontPolicyComputedStyleSpy?.mockRestore();
    fontPolicyComputedStyleSpy = null;
  });

  it('should initialize and load original settings', async () => {
    await adapter.initialize();
    expect(adapter.originalSettings).toEqual({ source: 'en', target: 'fa' });
  });

  it('logs rejected mapping fields as one readable warning string', () => {
    adapter._logRejectedMapping(4, 'uid-4', 'wrong-parent');

    expect(adapter.logger.warn).toHaveBeenCalledTimes(1);
    const [message, ...extraArguments] = adapter.logger.warn.mock.calls[0];
    expect(typeof message).toBe('string');
    expect(message).toContain('reason=wrong-parent');
    expect(message).toContain('resultIndex=4');
    expect(message).toContain('identityPresent=true');
    expect(message).toContain('identityKnown=true');
    expect(extraArguments).toHaveLength(0);
  });

  describe('translateElement', () => {
    it('should initiate a translation request', async () => {
      const onProgress = vi.fn();
      
      let streamCallbacks;
      registerTranslation.mockImplementation((id, callbacks) => {
        streamCallbacks = callbacks;
      });

      contentScriptIntegration.sendTranslationRequest.mockImplementation(async () => {
        // Simulate stream update after a short delay
        setTimeout(() => {
          streamCallbacks.onStreamUpdate({
            success: true,
            data: [{ t: 'سلام', i: 'n1' }]
          });
          streamCallbacks.onStreamEnd({ success: true });
        }, 10);
        return { success: true, streaming: true };
      });

      const result = await adapter.translateElement(testElement, { onProgress });

      expect(result.success).toBe(true);
      expect(testElement.textContent).toContain('سلام');
      const ownership = globalSelectElementState.translationHistory.at(-1).originalTextNodesData[0];
      expect(ownership.appliedText).toBe(testElement.firstChild.nodeValue);
      expect(Object.isFrozen(ownership)).toBe(true);
      expect(globalSelectElementState.translationHistory.at(-1).auxiliaryOwnershipRecords)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            element: testElement,
            property: 'attribute:data-has-original',
            original: { present: false, value: null },
            applied: { present: true, value: 'true' },
          }),
        ]));
      expect(contentScriptIntegration.sendTranslationRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sourceLanguage: 'auto'
          })
        })
      );
    });

    it('continues translation when font settings fail and does not read font family while disabled', async () => {
      const { getSelectElementUseTranslationFontAsync, getTranslationFontFamilyAsync } = await import('@/config.js');
      getSelectElementUseTranslationFontAsync.mockResolvedValueOnce(false);
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: JSON.stringify([{ t: 'سلام', i: 'n1' }])
      });

      const result = await adapter.translateElement(testElement);

      expect(result).toMatchObject({ success: true, committedParentCount: 1 });
      expect(testElement.style.getPropertyValue('font-family')).toBe('');
      expect(getTranslationFontFamilyAsync).not.toHaveBeenCalled();
    });

    it('continues translation when font toggle read fails', async () => {
      const { getSelectElementUseTranslationFontAsync, getTranslationFontFamilyAsync } = await import('@/config.js');
      getSelectElementUseTranslationFontAsync.mockRejectedValueOnce(new Error('font toggle unavailable'));
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: JSON.stringify([{ t: 'سلام', i: 'n1' }])
      });

      const result = await adapter.translateElement(testElement);

      expect(result).toMatchObject({ success: true, committedParentCount: 1 });
      expect(testElement.textContent).toContain('سلام');
      expect(getTranslationFontFamilyAsync).not.toHaveBeenCalled();
    });

    it('continues translation when font family read fails', async () => {
      const { getSelectElementUseTranslationFontAsync, getTranslationFontFamilyAsync } = await import('@/config.js');
      getSelectElementUseTranslationFontAsync.mockResolvedValueOnce(true);
      getTranslationFontFamilyAsync.mockRejectedValueOnce(new Error('font family unavailable'));
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: JSON.stringify([{ t: 'سلام', i: 'n1' }])
      });

      const result = await adapter.translateElement(testElement);

      expect(result).toMatchObject({ success: true, committedParentCount: 1 });
      expect(testElement.textContent).toContain('سلام');
      expect(testElement.style.getPropertyValue('font-family')).toBe('');
    });

    it('continues translation when font resolution fails', async () => {
      const { getSelectElementUseTranslationFontAsync, getTranslationFontFamilyAsync } = await import('@/config.js');
      getSelectElementUseTranslationFontAsync.mockResolvedValueOnce(true);
      getTranslationFontFamilyAsync.mockResolvedValueOnce('auto');
      resolveTranslationFontFamily.mockImplementationOnce(() => {
        throw new Error('font resolver unavailable');
      });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: JSON.stringify([{ t: 'سلام', i: 'n1' }])
      });

      const result = await adapter.translateElement(testElement);

      expect(result).toMatchObject({ success: true, committedParentCount: 1 });
      expect(testElement.textContent).toContain('سلام');
      expect(testElement.style.getPropertyValue('font-family')).toBe('');
    });

    it('applies and publishes V2 font ownership, then restores it without overwriting drift', async () => {
      const { getSelectElementUseTranslationFontAsync, getTranslationFontFamilyAsync } = await import('@/config.js');
      const { revertSelectElementTranslation } = await import('./DomTranslatorState.js');
      enableFontPolicyStyles();
      testElement.style.setProperty('font-family', 'serif');
      const bold = document.createElement('b');
      bold.textContent = 'independent child text';
      bold.style.fontFamily = 'Vazirmatn';
      const icon = document.createElement('i');
      icon.className = 'icon';
      icon.style.fontFamily = 'icons';
      const code = document.createElement('code');
      code.style.fontFamily = 'monospace';
      testElement.append(bold, icon, code);
      getSelectElementUseTranslationFontAsync.mockResolvedValueOnce(true);
      getTranslationFontFamilyAsync.mockResolvedValueOnce('auto');
      resolveTranslationFontFamily.mockReturnValueOnce('system-ui');
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: JSON.stringify([{ t: 'سلام', i: 'n1' }])
      });

      const result = await adapter.translateElement(testElement);
      const entry = globalSelectElementState.translationHistory.at(-1);
      const fontRecord = entry.auxiliaryOwnershipRecords.find(record => record.property === 'style:font-family');

      expect(result).toMatchObject({ success: true, committedParentCount: 1 });
      expect(testElement.style.fontFamily).toBe('system-ui');
      expect(bold.style.fontFamily).toBe('Vazirmatn');
      expect(icon.style.fontFamily).toBe('icons');
      expect(code.style.fontFamily).toBe('monospace');
      expect(fontRecord).toEqual(expect.objectContaining({
        original: { present: true, value: 'serif', priority: '' },
        applied: { present: true, value: 'system-ui', priority: '' },
      }));

      testElement.style.setProperty('font-family', 'monospace');
      await revertSelectElementTranslation(entry.sessionId);
      expect(testElement.style.fontFamily).toBe('monospace');
      expect(bold.style.fontFamily).toBe('Vazirmatn');
      expect(icon.style.fontFamily).toBe('icons');
      expect(code.style.fontFamily).toBe('monospace');
    });

    it('restores the original V2 font through normal Revert', async () => {
      const { getSelectElementUseTranslationFontAsync, getTranslationFontFamilyAsync } = await import('@/config.js');
      const { revertSelectElementTranslation } = await import('./DomTranslatorState.js');
      enableFontPolicyStyles();
      testElement.style.setProperty('font-family', 'serif');
      const originalTextNode = testElement.firstChild;
      const bold = document.createElement('b');
      bold.textContent = 'independent child text';
      bold.style.fontFamily = 'Vazirmatn';
      const icon = document.createElement('i');
      icon.className = 'icon';
      icon.style.fontFamily = 'icons';
      const code = document.createElement('code');
      code.style.fontFamily = 'monospace';
      testElement.append(bold, icon, code);
      getSelectElementUseTranslationFontAsync.mockResolvedValueOnce(true);
      getTranslationFontFamilyAsync.mockResolvedValueOnce('auto');
      resolveTranslationFontFamily.mockReturnValueOnce('system-ui');
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: JSON.stringify([{ t: 'سلام', i: 'n1' }])
      });

      const result = await adapter.translateElement(testElement);
      const entry = globalSelectElementState.translationHistory.at(-1);

      expect(result.success).toBe(true);
      expect(testElement.style.fontFamily).toBe('system-ui');
      expect(testElement.firstChild).toBe(originalTextNode);
      expect(bold.style.fontFamily).toBe('Vazirmatn');
      expect(icon.style.fontFamily).toBe('icons');
      expect(code.style.fontFamily).toBe('monospace');
      await revertSelectElementTranslation(entry.sessionId);
      expect(testElement.style.fontFamily).toBe('serif');
      expect(bold.style.fontFamily).toBe('Vazirmatn');
      expect(testElement.style.getPropertyPriority('font-family')).toBe('');
    });

    it('rejects direct internal shadow roots before extraction while shadow support is disabled', async () => {
      const host = document.createElement('x-host');
      const shadow = host.attachShadow({ mode: 'open' });
      const internal = document.createElement('div');
      internal.textContent = 'Shadow content';
      shadow.appendChild(internal);

      await expect(adapter.translateElement(internal)).rejects.toMatchObject({
        type: ErrorTypes.FEATURE_BLOCKED,
        reason: 'shadow-dom-disabled',
      });
      expect(contentScriptIntegration.sendTranslationRequest).not.toHaveBeenCalled();
    });

    it('rejects elements above the local segment limit with a typed error before requesting translation', async () => {
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      const { ErrorTypes } = await import('@/shared/error-management/ErrorTypes.js');
      const segments = Array.from({ length: 1001 }, (_, index) => ({
        node: testElement.firstChild,
        text: `Segment ${index}`,
        uid: `n${index}`,
        blockId: `b${index}`,
        role: 'div',
      }));
      collectTextNodes.mockReturnValueOnce(segments);

      const translation = adapter.translateElement(testElement);
      await expect(translation).rejects.toMatchObject({
        type: ErrorTypes.ELEMENT_TOO_LARGE,
        segmentCount: 1001,
        maxSegmentCount: 1000,
      });
      await expect(translation).rejects.toThrow('1001 text segments');
      expect(contentScriptIntegration.sendTranslationRequest).not.toHaveBeenCalled();
    });

    it('keeps overlapping roots blocked until owning translation releases the root', async () => {
      const { ErrorTypes } = await import('@/shared/error-management/ErrorTypes.js');
      let streamCallbacks;
      registerTranslation.mockImplementationOnce((_id, callbacks) => { streamCallbacks = callbacks; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });

      const firstTranslation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      const requestCount = contentScriptIntegration.sendTranslationRequest.mock.calls.length;

      await expect(adapter.translateElement(testElement)).rejects.toMatchObject({
        type: ErrorTypes.FEATURE_BLOCKED,
        translationOutcome: { committedParentCount: 0, totalParentCount: 0, cancelled: false },
      });
      expect(contentScriptIntegration.sendTranslationRequest).toHaveBeenCalledTimes(requestCount);
      expect(testElement.textContent).toBe('Hello');

      await expect(adapter.translateElement(testElement)).rejects.toMatchObject({
        type: ErrorTypes.FEATURE_BLOCKED,
        translationOutcome: { committedParentCount: 0, totalParentCount: 0, cancelled: false },
      });
      expect(contentScriptIntegration.sendTranslationRequest).toHaveBeenCalledTimes(requestCount);

      await adapter.cancelTranslation({ silent: true });
      streamCallbacks.onStreamEnd({ cancelled: true });
      await expect(firstTranslation).resolves.toMatchObject({ success: false, cancelled: true });

      let releasedCallbacks;
      registerTranslation.mockImplementationOnce((_id, callbacks) => { releasedCallbacks = callbacks; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });
      const releasedTranslation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(releasedCallbacks).toBeDefined());
      expect(contentScriptIntegration.sendTranslationRequest).toHaveBeenCalledTimes(requestCount + 1);
      releasedCallbacks.onStreamUpdate({ success: true, data: [{ t: 'Released', i: 'n1' }] });
      releasedCallbacks.onStreamEnd({ success: true });
      await expect(releasedTranslation).resolves.toMatchObject({ success: true });
      expect(testElement.textContent).toContain('Released');
    });

    it('allows two non-overlapping roots to translate concurrently', async () => {
      const firstAdapter = adapter;
      const secondAdapter = new DomTranslatorAdapter();
      const firstRoot = document.createElement('div');
      const secondRoot = document.createElement('div');
      firstRoot.textContent = 'First';
      secondRoot.textContent = 'Second';
      document.body.append(firstRoot, secondRoot);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes
        .mockReturnValueOnce([{ node: firstRoot.firstChild, text: 'First', uid: 'n1', blockId: 'b1', role: 'div' }])
        .mockReturnValueOnce([{ node: secondRoot.firstChild, text: 'Second', uid: 'n1', blockId: 'b1', role: 'div' }]);

      const callbacks = [];
      registerTranslation.mockImplementation((_id, registered) => { callbacks.push(registered); });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({ success: true, streaming: true });

      const firstTranslation = firstAdapter.translateElement(firstRoot);
      const secondTranslation = secondAdapter.translateElement(secondRoot);
      await vi.waitFor(() => expect(callbacks).toHaveLength(2));
      expect(contentScriptIntegration.sendTranslationRequest).toHaveBeenCalledTimes(2);

      callbacks[0].onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }] });
      callbacks[0].onStreamEnd({ success: true });
      callbacks[1].onStreamUpdate({ success: true, data: [{ t: 'Dos', i: 'n1' }] });
      callbacks[1].onStreamEnd({ success: true });

      await expect(firstTranslation).resolves.toMatchObject({ success: true });
      await expect(secondTranslation).resolves.toMatchObject({ success: true });
      expect(firstRoot.textContent).toContain('Uno');
      expect(secondRoot.textContent).toContain('Dos');
      document.body.removeChild(firstRoot);
      document.body.removeChild(secondRoot);
    });

    it('maps the non-grouping strategy to V2 extraction mode exactly once', async () => {
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockClear();
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'سلام', i: 'n1' }] });
      callbacks.onStreamEnd({ success: true });
      await translation;

      expect(collectTextNodes).toHaveBeenCalledTimes(1);
      expect(collectTextNodes).toHaveBeenCalledWith(testElement, {
        extractionMode: 'v2',
        includeOpenShadowRoots: false,
      });
    });

    it('maps the grouping strategy to V3 extraction mode exactly once', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      collectBlockGroups.mockClear();
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'سلام', i: 'n1' }] });
      callbacks.onStreamEnd({ success: true });
      await translation;

      expect(collectBlockGroups).toHaveBeenCalledTimes(1);
      expect(collectBlockGroups).toHaveBeenCalledWith(testElement, expect.any(Object), {
        extractionMode: 'v3',
        includeOpenShadowRoots: false,
      });
    });

    it('translates an explicitly selected BUTTON root through the normal flow', async () => {
      const button = document.createElement('button');
      button.textContent = 'Follow this account to see their updates';
      document.body.appendChild(button);

      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([{
        node: button.firstChild,
        text: button.firstChild.textContent,
        uid: 'n1',
        blockId: 'b1',
        role: 'button'
      }]);

      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockImplementationOnce(async () => {
        setTimeout(() => {
          callbacks.onStreamUpdate({ success: true, data: [{ t: 'دنبال کردن', i: 'n1' }] });
          callbacks.onStreamEnd({ success: true });
        }, 0);
        return { success: true, streaming: true };
      });

      const result = await adapter.translateElement(button);

      expect(result.success).toBe(true);
      expect(button.textContent).toContain('دنبال کردن');
    });

    it('A: returns zero-commit failure for rejected streaming result', async () => {
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockImplementationOnce(async () => {
        setTimeout(() => {
          callbacks.onStreamUpdate({ success: true, data: [{ t: '', i: 'n1' }] });
          callbacks.onStreamEnd({ success: true });
        }, 0);
        return { success: true, streaming: true };
      });

      const result = await adapter.translateElement(testElement);

      expect(result).toMatchObject({ success: false, committedParentCount: 0 });
      expect(globalSelectElementState.translationHistory).toHaveLength(0);
    });

    it('B: counts committed parent for accepted streaming result', async () => {
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockImplementationOnce(async () => {
        setTimeout(() => {
          callbacks.onStreamUpdate({ success: true, data: [{ t: 'سلام', i: 'n1' }] });
          callbacks.onStreamEnd({ success: true });
        }, 0);
        return { success: true, streaming: true };
      });

      const result = await adapter.translateElement(testElement);

      expect(result.success).toBe(true);
      expect(result.committedParentCount).toBeGreaterThanOrEqual(1);
    });

    it('accepts recovered logical parent identity in grouped streaming result', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockImplementationOnce(async () => {
        setTimeout(() => {
          callbacks.onStreamUpdate({
            success: true,
            data: [{ i: 'n1', blockId: 'g1', t: 'سلام', text: 'سلام' }],
          });
          callbacks.onStreamEnd({ success: true });
        }, 0);
        return { success: true, streaming: true };
      });

      const result = await adapter.translateElement(testElement);

      expect(result).toMatchObject({ success: true, committedParentCount: 1 });
      expect(testElement.textContent).toContain('سلام');
    });

    it('C: returns zero-commit failure when grouped results are silently rejected', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockImplementationOnce(async () => {
        setTimeout(() => {
          callbacks.onStreamUpdate({ success: true, data: [{ t: '', i: 'n1' }] });
          callbacks.onStreamEnd({ success: true });
        }, 0);
        return { success: true, streaming: true };
      });

      const result = await adapter.translateElement(testElement);

      expect(result).toMatchObject({ success: false, committedParentCount: 0 });
    });

    it('D: counts functionally identical direct result as committed', async () => {
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: JSON.stringify([{ t: 'Hello', i: 'n1' }])
      });

      const result = await adapter.translateElement(testElement);

      expect(result).toMatchObject({ success: true, committedParentCount: 1 });
    });

    it('E: commits non-grouping request after grouped request on same adapter', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      getFeatureSemanticBlockGroupingAsync
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      contentScriptIntegration.sendTranslationRequest
        .mockResolvedValueOnce({ success: true, streaming: false, translatedText: [{ t: 'اول', i: 'n1' }] })
        .mockResolvedValueOnce({ success: true, streaming: false, translatedText: JSON.stringify([{ t: 'دوم', i: 'n1' }]) });

      const first = await adapter.translateElement(testElement);
      testElement.textContent = 'Hello';
      const second = await adapter.translateElement(testElement);

      expect(first).toMatchObject({ success: true, committedParentCount: 1 });
      expect(second).toMatchObject({ success: true, committedParentCount: 1 });
      expect(testElement.textContent).toContain('دوم');
    });

    it('reports FULL_SUCCESS for direct 2/2 committed parents', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b2', role: 'div' }
      ]);
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }]
      });

      const result = await adapter.translateElement(testElement);

      expect(result).toMatchObject({
        success: true,
        partial: false,
        committedParentCount: 2,
        totalParentCount: 2,
      });
      const ownership = globalSelectElementState.translationHistory.at(-1).originalTextNodesData;
      expect(ownership.map(snapshot => snapshot.appliedText)).toEqual([first.nodeValue, second.nodeValue]);
    });

    it('keeps a falsy direct parent identity instead of dropping it', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(false);
      const node = document.createTextNode('A');
      testElement.replaceChildren(node);
      collectTextNodes.mockReturnValueOnce([
        { node, text: 'A', uid: 'n1', blockId: 0, role: 'div' },
      ]);
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Uno', i: 'n1' }],
      });

      const result = await adapter.translateElement(testElement);

      expect(result).toMatchObject({ success: true, committedParentCount: 1, totalParentCount: 1 });
      expect(contentScriptIntegration.sendTranslationRequest.mock.calls[0][0].data.conversationParents)
        .toEqual([{ parentId: 0, cleanSource: 'A' }]);
    });

    it('reports PARTIAL_SUCCESS for direct 1 committed + 1 invalid parent', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b2', role: 'div' }
      ]);
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Uno', i: 'n1' }, { t: '', i: 'n2' }]
      });

      const result = await adapter.translateElement(testElement);

      expect(result).toMatchObject({
        success: true,
        partial: true,
        committedParentCount: 1,
        totalParentCount: 2,
      });
      expect(first.nodeValue).toContain('Uno');
      expect(second.nodeValue).toBe('B');
      const ownership = globalSelectElementState.translationHistory.at(-1).originalTextNodesData;
      expect(ownership.find(snapshot => snapshot.node === first).appliedText).toBe(first.nodeValue);
      expect(ownership.find(snapshot => snapshot.node === second).appliedText).toBeUndefined();
    });

    it('reports PARTIAL_SUCCESS when a direct parent receives no accepted result', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b2', role: 'div' }
      ]);
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }] });
      callbacks.onStreamEnd({ success: true });

      const result = await translation;
      expect(result).toMatchObject({
        success: true,
        partial: true,
        committedParentCount: 1,
        totalParentCount: 2,
      });
      expect(first.nodeValue).toContain('Uno');
      expect(second.nodeValue).toBe('B');
    });

    it('reports PARTIAL_SUCCESS when a direct parent result is stale', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b2', role: 'div' }
      ]);
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      // Stale source drift: mutate the node so _isDirectSourceCurrent fails on apply
      second.nodeValue = 'Changed B';
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }] });
      callbacks.onStreamEnd({ success: true });

      const result = await translation;
      expect(result).toMatchObject({
        success: true,
        partial: true,
        committedParentCount: 1,
        totalParentCount: 2,
      });
      expect(first.nodeValue).toContain('Uno');
      expect(second.nodeValue).toBe('Changed B');
    });

    it('reports FULL_SUCCESS for grouped 2/2 applied groups', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      collectBlockGroups.mockReturnValueOnce([
        { id: 'n1', blockId: 'g1', text: 'A', leadingWS: '', trailingWS: '', preWhitespace: false, directionHint: 'ltr', inlineParentTags: ['div'], mode: 'standard', node: first },
        { id: 'n2', blockId: 'g2', text: 'B', leadingWS: '', trailingWS: '', preWhitespace: false, directionHint: 'ltr', inlineParentTags: ['div'], mode: 'standard', node: second },
      ]);
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }] });
      callbacks.onStreamEnd({ success: true });

      const result = await translation;
      expect(result).toMatchObject({
        success: true,
        partial: false,
        committedParentCount: 2,
        totalParentCount: 2,
      });
      const ownership = globalSelectElementState.translationHistory.at(-1).originalTextNodesData;
      expect(ownership.map(snapshot => snapshot.appliedText)).toEqual([first.nodeValue, second.nodeValue]);
    });

    it('publishes V3 font ownership through normal Revert', async () => {
      const { getFeatureSemanticBlockGroupingAsync, getSelectElementUseTranslationFontAsync, getTranslationFontFamilyAsync } = await import('@/config.js');
      const { revertSelectElementTranslation } = await import('./DomTranslatorState.js');
      enableFontPolicyStyles();
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      getSelectElementUseTranslationFontAsync.mockResolvedValueOnce(true);
      getTranslationFontFamilyAsync.mockResolvedValueOnce('auto');
      resolveTranslationFontFamily.mockReturnValueOnce('system-ui');

      const owner = document.createElement('span');
      const text = document.createTextNode('A');
      const bold = document.createElement('b');
      bold.textContent = 'independent child text';
      bold.style.fontFamily = 'Vazirmatn';
      const icon = document.createElement('i');
      icon.className = 'icon';
      icon.style.fontFamily = 'icons';
      const code = document.createElement('code');
      code.style.fontFamily = 'monospace';
      owner.append(text, bold, icon, code);
      testElement.replaceChildren(owner);
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      collectBlockGroups.mockReturnValueOnce([{
        id: 'n1',
        blockId: 'g1',
        text: 'A',
        leadingWS: '',
        trailingWS: '',
        preWhitespace: false,
        directionHint: 'ltr',
        inlineParentTags: ['span'],
        mode: 'standard',
        node: text,
      }]);
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }] });
      callbacks.onStreamEnd({ success: true });

      const result = await translation;
      const entry = globalSelectElementState.translationHistory.at(-1);

      expect(result).toMatchObject({ success: true, committedParentCount: 1 });
      expect(owner.style.fontFamily).toBe('system-ui');
      expect(bold.style.fontFamily).toBe('Vazirmatn');
      expect(icon.style.fontFamily).toBe('icons');
      expect(code.style.fontFamily).toBe('monospace');
      expect(entry.auxiliaryOwnershipRecords).toEqual(expect.arrayContaining([
        expect.objectContaining({ property: 'style:font-family', element: owner })
      ]));
      await revertSelectElementTranslation(entry.sessionId);
      expect(owner.style.fontFamily).toBe('');
      expect(bold.style.fontFamily).toBe('Vazirmatn');
      expect(icon.style.fontFamily).toBe('icons');
      expect(code.style.fontFamily).toBe('monospace');
      expect(text.nodeValue).toBe('A');
    });

    it('marks grouped non-passthrough rejected content invalid and reports PARTIAL_SUCCESS', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      collectBlockGroups.mockReturnValueOnce([
        { id: 'n1', blockId: 'g1', text: 'A', leadingWS: '', trailingWS: '', preWhitespace: false, directionHint: 'ltr', inlineParentTags: ['div'], mode: 'standard', node: first },
        { id: 'n2', blockId: 'g2', text: 'B', leadingWS: '', trailingWS: '', preWhitespace: false, directionHint: 'ltr', inlineParentTags: ['div'], mode: 'standard', node: second },
      ]);
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }, { t: '', i: 'n2' }] });
      callbacks.onStreamEnd({ success: true });

      const result = await translation;
      expect(result).toMatchObject({
        success: true,
        partial: true,
        committedParentCount: 1,
        totalParentCount: 2,
      });
      expect(adapter.groupMap.get('g2').invalid).toBe(true);
      expect(adapter.groupMap.get('g2').applied).toBe(false);
    });

    it('keeps an already-committed group when a later independent group mutation fails', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      collectBlockGroups.mockReturnValueOnce([
        { id: 'n1', blockId: 'g1', text: 'A', leadingWS: '', trailingWS: '', preWhitespace: false, directionHint: 'ltr', inlineParentTags: ['div'], mode: 'standard', node: first },
        { id: 'n2', blockId: 'g2', text: 'B', leadingWS: '', trailingWS: '', preWhitespace: false, directionHint: 'ltr', inlineParentTags: ['div'], mode: 'standard', node: second },
      ]);
      const { BlockGroupReconstructor } = await import('./BlockGroupReconstructor.js');
      const realApply = BlockGroupReconstructor.apply;
      const applySpy = vi.spyOn(BlockGroupReconstructor, 'apply')
        .mockImplementationOnce((...args) => realApply.call(BlockGroupReconstructor, ...args))
        .mockImplementationOnce(() => { throw new Error('group2 mutation failed'); });
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: true,
        conversationAcceptance: true,
      });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }] });
      callbacks.onStreamEnd({ success: true });

      const result = await translation;
      expect(result).toMatchObject({ success: true, partial: true, committedParentCount: 1, totalParentCount: 2 });
      applySpy.mockRestore();
      expect(first.nodeValue).toContain('Uno');
      expect(second.nodeValue).toBe('B');
      const ownership = globalSelectElementState.translationHistory.at(-1).originalTextNodesData;
      expect(ownership.find(snapshot => snapshot.node === first).appliedText).toBe(first.nodeValue);
      expect(ownership.find(snapshot => snapshot.node === second).appliedText).toBeUndefined();

      const accepted = sendRegularMessage.mock.calls
        .map(([message]) => message?.data)
        .filter(data => data?.accepted === true)
        .map(data => data.parentId);
      const rejected = sendRegularMessage.mock.calls
        .map(([message]) => message?.data)
        .filter(data => data?.accepted === false)
        .map(data => data.parentId);
      expect(accepted).toEqual(['g1']);
      expect(rejected).toEqual(['g2']);
    });

    it('settles remaining grouped parents after terminal reconstruction failure', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      const nodes = ['A', 'B', 'C'].map(text => document.createTextNode(text));
      testElement.replaceChildren(...nodes);
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      collectBlockGroups.mockReturnValueOnce(nodes.map((node, index) => ({
        id: `n${index + 1}`,
        blockId: `g${index + 1}`,
        text: node.nodeValue,
        leadingWS: '',
        trailingWS: '',
        preWhitespace: false,
        directionHint: 'ltr',
        inlineParentTags: ['div'],
        mode: 'standard',
        node,
      })));
      const { BlockGroupReconstructor } = await import('./BlockGroupReconstructor.js');
      const realApply = BlockGroupReconstructor.apply;
      const applySpy = vi.spyOn(BlockGroupReconstructor, 'apply')
        .mockImplementationOnce((...args) => realApply.call(BlockGroupReconstructor, ...args))
        .mockImplementationOnce(() => { throw new Error('group2 mutation failed'); });
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: true,
        conversationAcceptance: true,
      });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks.onStreamUpdate({ success: true, data: [
        { t: 'Uno', i: 'n1' },
        { t: 'Dos', i: 'n2' },
        { t: 'Tres', i: 'n3' },
      ] });
      callbacks.onStreamEnd({ success: true });

      const result = await translation;
      expect(result).toMatchObject({ success: true, partial: true, committedParentCount: 2, totalParentCount: 3 });
      applySpy.mockRestore();
      expect(nodes[0].nodeValue).toContain('Uno');
      expect(nodes[1].nodeValue).toBe('B');
      expect(nodes[2].nodeValue).toContain('Tres');
      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === true)
        .map(([message]) => message.data.parentId).sort()).toEqual(['g1', 'g3']);
      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === false)
        .map(([message]) => message.data.parentId).sort()).toEqual(['g2']);
    });

    it('reports PARTIAL_SUCCESS with one committed group and one invalid V2 passthrough group', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      collectBlockGroups.mockReturnValueOnce([
        { id: 'n1', blockId: 'g1', text: 'A', leadingWS: '', trailingWS: '', preWhitespace: false, directionHint: 'ltr', inlineParentTags: ['div'], mode: 'standard', node: first },
        { id: 'n2', blockId: 'g2', text: 'B', leadingWS: '', trailingWS: '', preWhitespace: false, directionHint: 'ltr', inlineParentTags: ['div'], mode: 'V2_PASSTHROUGH', node: second },
      ]);
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }, { t: '', i: 'n2' }] });
      callbacks.onStreamEnd({ success: true });

      const result = await translation;
      expect(result).toMatchObject({
        success: true,
        partial: true,
        committedParentCount: 1,
        totalParentCount: 2,
      });
      expect(adapter.groupMap.get('g2').invalid).toBe(true);
    });

    it('reports PARTIAL_SUCCESS when one grouped parent receives no accepted result', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      collectBlockGroups.mockReturnValueOnce([
        { id: 'n1', blockId: 'g1', text: 'A', leadingWS: '', trailingWS: '', preWhitespace: false, directionHint: 'ltr', inlineParentTags: ['div'], mode: 'standard', node: first },
        { id: 'n2', blockId: 'g2', text: 'B', leadingWS: '', trailingWS: '', preWhitespace: false, directionHint: 'ltr', inlineParentTags: ['div'], mode: 'standard', node: second },
      ]);
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }] });
      callbacks.onStreamEnd({ success: true });

      const result = await translation;
      expect(result).toMatchObject({
        success: true,
        partial: true,
        committedParentCount: 1,
        totalParentCount: 2,
      });
      expect(adapter.groupMap.get('g2').applied).toBe(false);
    });

    it('reports PARTIAL_SUCCESS when a grouped parent result is a suppressed fragment', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      collectBlockGroups.mockReturnValueOnce([
        { id: 'n1', blockId: 'g1', text: 'A', leadingWS: '', trailingWS: '', preWhitespace: false, directionHint: 'ltr', inlineParentTags: ['div'], mode: 'standard', node: first },
        { id: 'n2', blockId: 'g2', text: 'B', leadingWS: '', trailingWS: '', preWhitespace: false, directionHint: 'ltr', inlineParentTags: ['div'], mode: 'standard', node: second },
      ]);
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks.onStreamUpdate({ success: true, data: [
        { t: 'Uno', i: 'n1' },
        { isSplitFragment: true, t: 'Dos', i: 'n2' },
      ] });
      callbacks.onStreamEnd({ success: true });

      const result = await translation;
      expect(result).toMatchObject({
        success: true,
        partial: true,
        committedParentCount: 1,
        totalParentCount: 2,
      });
      expect(adapter.groupMap.get('g2').applied).toBe(false);
    });

    it('treats mutation rollback after a commit as PARTIAL_FAILURE, not PARTIAL_SUCCESS', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b2', role: 'div' }
      ]);
      const apply = vi.spyOn(adapter, '_applyTranslationToNode');
      apply.mockImplementationOnce((...args) => DomTranslatorAdapter.prototype._applyTranslationToNode.call(adapter, ...args));
      apply.mockImplementationOnce(() => { throw 'rollback-failure'; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }]
      });

      await expect(adapter.translateElement(testElement)).rejects.toMatchObject({
        message: 'rollback-failure',
        cause: 'rollback-failure',
        translationOutcome: { committedParentCount: 1, totalParentCount: 2, cancelled: false },
      });
      expect(first.nodeValue).toContain('Uno');
      expect(second.nodeValue).toBe('B');
      apply.mockRestore();
    });

    it('rolls back V2 font mutation when ownership publication fails', async () => {
      const { getSelectElementUseTranslationFontAsync, getTranslationFontFamilyAsync } = await import('@/config.js');
      enableFontPolicyStyles();
      testElement.style.setProperty('font-family', 'serif');
      getSelectElementUseTranslationFontAsync.mockResolvedValueOnce(true);
      getTranslationFontFamilyAsync.mockResolvedValueOnce('auto');
      resolveTranslationFontFamily.mockReturnValueOnce('system-ui');
      const publish = vi.spyOn(adapter, '_publishCommittedOwnership')
        .mockImplementationOnce(() => { throw new Error('ownership publication failed'); });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: JSON.stringify([{ t: 'سلام', i: 'n1' }])
      });

      await expect(adapter.translateElement(testElement)).rejects.toThrow('ownership publication failed');
      publish.mockRestore();

      expect(testElement.textContent).toBe('Hello');
      expect(testElement.style.fontFamily).toBe('serif');
      expect(testElement.style.getPropertyPriority('font-family')).toBe('');
      expect(globalSelectElementState.translationHistory.flatMap(entry => entry.auxiliaryOwnershipRecords || [])
        .some(record => record.property === 'style:font-family')).toBe(false);
      expect([...globalSelectElementState.auxiliaryOwnership.values()]
        .some(properties => properties.has('style:font-family'))).toBe(false);
    });

    it('should create one conversation parent and ACK once for shared blockId units', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b1', role: 'div' }
      ]);

      let streamCallbacks;
      registerTranslation.mockImplementationOnce((_id, callbacks) => { streamCallbacks = callbacks; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true, conversationAcceptance: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      const request = contentScriptIntegration.sendTranslationRequest.mock.calls[0][0];
      expect(request.data.conversationParents).toEqual([{ parentId: 'b1', cleanSource: 'AB' }]);

      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }] });
      expect(sendRegularMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ parentId: 'b1', accepted: true })
      }), { silent: true, timeout: 500 });
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'Dos', i: 'n2' }] });
      streamCallbacks.onStreamEnd({ success: true });
      await translation;

      const accepted = sendRegularMessage.mock.calls.filter(([message, options]) => (
        options?.silent === true && message?.data?.parentId === 'b1' && message?.data?.accepted === true
      ));
      expect(accepted).toHaveLength(1);
    });

    it('should reject a direct parent when an earlier pending node drifts', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b1', role: 'div' }
      ]);
      let streamCallbacks;
      registerTranslation.mockImplementationOnce((_id, callbacks) => { streamCallbacks = callbacks; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true, conversationAcceptance: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }] });
      expect(first.nodeValue).toBe('A');
      first.nodeValue = 'Changed A';
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'Dos', i: 'n2' }] });
      streamCallbacks.onStreamEnd({ success: true });
      await translation;

      expect(first.nodeValue).toBe('Changed A');
      expect(second.nodeValue).toBe('B');
      expect(sendRegularMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ parentId: 'b1', accepted: true })
      }), { silent: true, timeout: 500 });
      expect(sendRegularMessage.mock.calls.filter(([message]) => message?.data?.parentId === 'b1')
        .map(([message]) => message.data.accepted)).toEqual([false]);
    });

    it('should order unique conversation parents by earliest source unit', async () => {
      const nodes = ['A', 'B', 'C'].map(text => document.createTextNode(text));
      testElement.replaceChildren(...nodes);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: nodes[0], text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: nodes[1], text: 'B', uid: 'n2', blockId: 'b1', role: 'div' },
        { node: nodes[2], text: 'C', uid: 'n3', blockId: 'b2', role: 'div' }
      ]);
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: false, translatedText: 'invalid' });

      await adapter.translateElement(testElement);

      const request = contentScriptIntegration.sendTranslationRequest.mock.calls[0][0];
      expect(request.data.conversationParents).toEqual([
        { parentId: 'b1', cleanSource: 'AB' },
        { parentId: 'b2', cleanSource: 'C' }
      ]);
    });

    it('should ACK complete independent direct parents separately', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b2', role: 'div' }
      ]);

      let streamCallbacks;
      registerTranslation.mockImplementationOnce((_id, callbacks) => { streamCallbacks = callbacks; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true, conversationAcceptance: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }] });
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'Dos', i: 'n2' }] });
      streamCallbacks.onStreamEnd({ success: true });
      await translation;

      const acceptedParents = sendRegularMessage.mock.calls
        .filter(([message, options]) => options?.silent === true && message?.data?.accepted === true)
        .map(([message]) => message.data.parentId);
      expect(acceptedParents).toEqual(['b1', 'b2']);
    });

    it('keeps reverse parent completion attached to canonical parent identities', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b2', role: 'div' },
      ]);

      let streamCallbacks;
      registerTranslation.mockImplementationOnce((_id, callbacks) => { streamCallbacks = callbacks; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: true,
        conversationAcceptance: true,
      });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'Dos', i: 'n2' }] });
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }] });
      streamCallbacks.onStreamEnd({ success: true });

      await translation;

      expect(first.nodeValue).toContain('Uno');
      expect(second.nodeValue).toContain('Dos');
      expect(sendRegularMessage.mock.calls
        .filter(([message, options]) => options?.silent === true && message?.data?.accepted === true)
        .map(([message]) => message.data.parentId))
        .toEqual(['b2', 'b1']);
    });

    it('should apply complete direct parent only after all units pass preflight', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b1', role: 'div' }
      ]);
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }],
        conversationAcceptance: true
      });

      await adapter.translateElement(testElement);

      expect(first.nodeValue).toContain('Uno');
      expect(second.nodeValue).toContain('Dos');
      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === true)).toHaveLength(1);
    });

    it('should isolate invalid direct parent from valid parent in same response', async () => {
      const nodes = ['A', 'B', 'C'].map(text => document.createTextNode(text));
      testElement.replaceChildren(...nodes);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: nodes[0], text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: nodes[1], text: 'B', uid: 'n2', blockId: 'b1', role: 'div' },
        { node: nodes[2], text: 'C', uid: 'n3', blockId: 'b2', role: 'div' }
      ]);
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [
          { t: 'Uno', i: 'n1' },
          { t: '', i: 'n2' },
          { t: 'Tres', i: 'n3' }
        ],
        conversationAcceptance: true
      });

      await adapter.translateElement(testElement);

      expect(nodes[0].nodeValue).toBe('A');
      expect(nodes[1].nodeValue).toBe('B');
      expect(nodes[2].nodeValue).toContain('Tres');
      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === true)
        .map(([message]) => message.data.parentId)).toEqual(['b2']);
      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === false)
        .map(([message]) => message.data.parentId)).toEqual(['b1']);
    });

    it('settles failed parent before later accepted sibling', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b2', role: 'div' },
      ]);
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: '', i: 'n1' }, { t: 'Dos', i: 'n2' }],
        conversationAcceptance: true,
      });

      const result = await adapter.translateElement(testElement);

      expect(result).toMatchObject({ success: true, partial: true, committedParentCount: 1, totalParentCount: 2 });
      expect(first.nodeValue).toBe('A');
      expect(second.nodeValue).toContain('Dos');
      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === false)
        .map(([message]) => message.data.parentId)).toEqual(['b1']);
      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === true)
        .map(([message]) => message.data.parentId)).toEqual(['b2']);
    });

    it('settles failed middle parent without blocking later accepted sibling', async () => {
      const nodes = ['A', 'B', 'C'].map(text => document.createTextNode(text));
      testElement.replaceChildren(...nodes);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce(nodes.map((node, index) => ({
        node,
        text: node.nodeValue,
        uid: `n${index + 1}`,
        blockId: `b${index + 1}`,
        role: 'div',
      })));
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Uno', i: 'n1' }, { t: '', i: 'n2' }, { t: 'Tres', i: 'n3' }],
        conversationAcceptance: true,
      });

      const result = await adapter.translateElement(testElement);

      expect(result).toMatchObject({ success: true, partial: true, committedParentCount: 2, totalParentCount: 3 });
      expect(nodes[0].nodeValue).toContain('Uno');
      expect(nodes[1].nodeValue).toBe('B');
      expect(nodes[2].nodeValue).toContain('Tres');
      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === false)
        .map(([message]) => message.data.parentId)).toEqual(['b2']);
      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === true)
        .map(([message]) => message.data.parentId)).toEqual(['b1', 'b3']);
    });

    it('rejects every unapplied parent for zero-result completion', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b2', role: 'div' },
      ]);
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: '', i: 'n1' }, { t: '', i: 'n2' }],
        conversationAcceptance: true,
      });

      const result = await adapter.translateElement(testElement);

      expect(result).toMatchObject({ success: false, committedParentCount: 0, totalParentCount: 2 });
      expect(first.nodeValue).toBe('A');
      expect(second.nodeValue).toBe('B');
      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === true)).toHaveLength(0);
      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === false)
        .map(([message]) => message.data.parentId)).toEqual(['b1', 'b2']);
    });

    it('does not reject a parent while a later stream result can still complete it', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b2', role: 'div' },
      ]);
      let streamCallbacks;
      registerTranslation.mockImplementationOnce((_id, callbacks) => { streamCallbacks = callbacks; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: true,
        conversationAcceptance: true,
      });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }] });
      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.parentId === 'b2')).toHaveLength(0);
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'Dos', i: 'n2' }] });
      streamCallbacks.onStreamEnd({ success: true });

      await expect(translation).resolves.toMatchObject({ success: true, partial: false });
      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === false)).toHaveLength(0);
      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === true)
        .map(([message]) => message.data.parentId)).toEqual(['b1', 'b2']);
    });

    it('should reject duplicate UID before applying its parent', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b1', role: 'div' }
      ]);
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [
          { t: 'Uno', i: 'n1' },
          { t: 'Un autre', i: 'n1' },
          { t: 'Dos', i: 'n2' }
        ]
      });

      await adapter.translateElement(testElement);

      expect(first.nodeValue).toBe('A');
      expect(second.nodeValue).toBe('B');
      expect(sendRegularMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ parentId: 'b1', accepted: true })
      }), { silent: true, timeout: 500 });
    });

    it('should reject conflicting identity aliases without mutation', async () => {
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: testElement.firstChild, text: 'Hello', uid: 'n1', blockId: 'b1', role: 'div' }
      ]);
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Unsafe', i: 'n1', uid: 'n2' }]
      });

      await adapter.translateElement(testElement);

      expect(testElement.textContent).toBe('Hello');
      expect(sendRegularMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ accepted: true })
      }), expect.anything());
    });

    it('should accept equal identity aliases through parent lifecycle', async () => {
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: testElement.firstChild, text: 'Hello', uid: 'n1', blockId: 'b1', role: 'div' }
      ]);
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'سلام', i: 'n1', uid: 'n1', id: 'n1' }]
      });

      await adapter.translateElement(testElement);

      expect(testElement.textContent).toContain('سلام');
    });

    it('should ignore unknown identity without mutating another node', async () => {
      const nodes = [document.createTextNode('Hello'), document.createTextNode('World')];
      testElement.replaceChildren(...nodes);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: nodes[0], text: 'Hello', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: nodes[1], text: 'World', uid: 'n2', blockId: 'b2', role: 'div' }
      ]);
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Unknown', i: 'missing' }, { t: 'First', i: 'n1' }]
      });

      await adapter.translateElement(testElement);

      expect(nodes[0].nodeValue).toContain('First');
      expect(nodes[1].nodeValue).toBe('World');
    });

    it('should apply reordered exact IDs to matching nodes', async () => {
      const nodes = [document.createTextNode('Hello'), document.createTextNode('World')];
      testElement.replaceChildren(...nodes);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: nodes[0], text: 'Hello', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: nodes[1], text: 'World', uid: 'n2', blockId: 'b1', role: 'div' }
      ]);
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Second', i: 'n2' }, { t: 'First', i: 'n1' }]
      });

      await adapter.translateElement(testElement);

      expect(nodes[0].nodeValue).toContain('First');
      expect(nodes[1].nodeValue).toContain('Second');
    });

    it.each([
      [{ t: '' }, 'empty canonical field'],
      [{ t: '', text: 'Unsafe fallback' }, 'invalid canonical field'],
      [{ t: '   ' }, 'whitespace'],
      [{ t: null }, 'null'],
      [{ t: undefined }, 'undefined'],
      [{ t: 42 }, 'numeric'],
      [{}, 'missing translation']
    ])('should reject %s content without mutating parent', async (item) => {
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: testElement.firstChild, text: 'Hello', uid: 'n1', blockId: 'b1', role: 'div' }
      ]);
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ ...item, i: 'n1' }]
      });

      await adapter.translateElement(testElement);

      expect(testElement.textContent).toBe('Hello');
      expect(sendRegularMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ accepted: true })
      }), expect.anything());
    });

    it('should fallback to V2 node-by-node extraction for traditional providers even if Block Grouping is globally enabled', async () => {
      const { getFeatureSemanticBlockGroupingAsync, getEffectiveProviderAsync } = await import('@/config.js');
      const { collectTextNodes, collectBlockGroups } = await import('./DomTranslatorUtils.js');

      // Enable Block Grouping globally but use a traditional provider (google)
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      getEffectiveProviderAsync.mockResolvedValueOnce('google');
      
      collectBlockGroups.mockClear();
      collectTextNodes.mockClear();

      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
        success: true,
        streaming: false,
        translatedText: JSON.stringify([{ t: 'سلام', i: 'n1' }])
      });

      const result = await adapter.translateElement(testElement);

      expect(result.success).toBe(true);
      // Should NOT use Block Grouping (V3)
      expect(collectBlockGroups).not.toHaveBeenCalled();
      // Should use traditional node extraction (V2)
      expect(collectTextNodes).toHaveBeenCalledTimes(1);
    });

    it('should preserve literal whitespace on revert when using Block Grouping', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      const { revertSelectElementTranslation } = await import('./DomTranslatorState.js');

      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);

      const div = document.createElement('div');
      const textNode = document.createTextNode('Welcome to '); // Trailing space
      div.appendChild(textNode);
      document.body.appendChild(div);

      collectBlockGroups.mockReturnValueOnce([{
        id: 'n1',
        blockId: 'g1',
        text: 'Welcome to',
        leadingWS: '',
        trailingWS: ' ',
        preWhitespace: false,
        directionHint: 'ltr',
        inlineParentTags: ['div'],
        mode: 'standard',
        node: textNode
      }]);

      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
        success: true,
        streaming: false,
        translatedText: JSON.stringify([{ t: 'خوش آمدید', i: 'n1' }])
      });

      // Translate
      await adapter.translateElement(div);
      
      // Verify translation applied (contains the translated text and the trailing space)
      expect(textNode.nodeValue).toContain('خوش آمدید');
      expect(textNode.nodeValue.endsWith(' ')).toBe(true);

      // Revert
      await revertSelectElementTranslation();

      // Verify original literal text restored (including trailing space)
      expect(textNode.nodeValue).toBe('Welcome to ');
      
      document.body.removeChild(div);
    });

    it('preserves option value/selection through translate and restores the label on revert', async () => {
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      const { revertSelectElementTranslation } = await import('./DomTranslatorState.js');
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      // Reset queued once-implementations so this test runs a deterministic V2
      // (non-grouping) path; a preceding test short-circuits the block-grouping
      // read when it stubs a traditional provider, leaving a queued once behind.
      getFeatureSemanticBlockGroupingAsync.mockReset();
      getFeatureSemanticBlockGroupingAsync.mockResolvedValue(false);

      const select = document.createElement('select');
      select.innerHTML = `
        <option value="en" selected>English</option>
        <option value="fa">Persian</option>
      `;
      document.body.appendChild(select);

      const safeLabel = select.options[0].firstChild;
      collectTextNodes.mockReturnValueOnce([
        { node: safeLabel, text: 'English', uid: 'opt1', blockId: 'b1', role: 'option' }
      ]);

      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
        success: true,
        streaming: false,
        translatedText: JSON.stringify([{ t: 'انگلیسی', i: 'opt1' }])
      });

      await adapter.translateElement(select);

      // Translated label, but explicit value and selected state untouched.
      expect(select.options[0].text).toContain('انگلیسی');
      expect(select.options[0].value).toBe('en');
      expect(select.selectedIndex).toBe(0);

      // Generic revert restores the original label.
      await revertSelectElementTranslation();

      expect(select.options[0].text).toBe('English');
      expect(select.options[0].value).toBe('en');
      expect(select.selectedIndex).toBe(0);

      document.body.removeChild(select);
    });

    it('should route through collectBlockGroups when FEATURE_SEMANTIC_BLOCK_GROUPING is true', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectTextNodes, collectBlockGroups } = await import('./DomTranslatorUtils.js');
      
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      collectBlockGroups.mockClear();
      collectTextNodes.mockClear();

      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
        success: true,
        streaming: false,
        translatedText: JSON.stringify([{ t: 'سلام', i: 'n1' }])
      });

      const result = await adapter.translateElement(testElement);

      expect(result.success).toBe(true);
      expect(collectBlockGroups).toHaveBeenCalledTimes(1);
      expect(collectTextNodes).not.toHaveBeenCalledWith(testElement);
      expect(testElement.textContent).toContain('سلام');
    });

    it('should handle direct (non-streaming) response', async () => {
      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
        success: true,
        streaming: false,
        translatedText: JSON.stringify([{ t: 'سلام', i: 'n1' }])
      });

      const result = await adapter.translateElement(testElement);

      expect(result.success).toBe(true);
      expect(testElement.textContent).toContain('سلام');
    });

    it('should ACK non-fragmented parent after direct node acceptance', async () => {
      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
        success: true,
        streaming: false,
        translatedText: JSON.stringify([{ t: 'سلام', i: 'n1' }]),
        conversationAcceptance: true
      });

      await adapter.translateElement(testElement);

      expect(sendRegularMessage).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ parentId: 'b1', cleanResult: 'سلام', accepted: true })
      }), { silent: true, timeout: 500 });
    });

    it('should not ACK a parent when blockId is missing', async () => {
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: testElement.firstChild, text: 'Hello', uid: 'node-only', role: 'div' }
      ]);
      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
        success: true,
        streaming: false,
        translatedText: JSON.stringify([{ t: 'سلام', i: 'node-only' }])
      });

      await adapter.translateElement(testElement);

      expect(sendRegularMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ parentId: 'node-only' })
      }), { silent: true, timeout: 500 });
    });

    it('should suppress a raw V2 fragment without mutating its node', async () => {
      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
        success: true,
        streaming: false,
        translatedText: JSON.stringify([{ t: 'Partial translation', i: 'n1', isSplitFragment: true }])
      });

      await adapter.translateElement(testElement);

      expect(testElement.textContent).toContain('Hello');
      expect(testElement.textContent).not.toContain('Partial translation');
    });

    it('should keep traditional Select Element payload 1:1 for a paragraph-bearing node', async () => {
      testElement.textContent = 'Paragraph one\n\nParagraph two';
      const textNode = testElement.firstChild;

      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: textNode, text: textNode.nodeValue, uid: 'n1', blockId: 'b1', role: 'div' }
      ]);

      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
        success: true,
        streaming: false,
        translatedText: JSON.stringify([{ t: 'Translated paragraph one\n\nTranslated paragraph two', i: 'n1' }])
      });

      const result = await adapter.translateElement(testElement, { provider: 'googlev2' });
      const payload = JSON.parse(contentScriptIntegration.sendTranslationRequest.mock.calls[0][0].data.text);

      expect(result.success).toBe(true);
      expect(payload).toHaveLength(1);
      expect(payload[0]).toMatchObject({
        t: 'Paragraph one\n\nParagraph two',
        i: 'n1',
        b: 'b1',
        r: 'div'
      });
      expect(payload[0]).not.toHaveProperty('parentUid');
      expect(payload[0]).not.toHaveProperty('partIndex');
      expect(payload[0]).not.toHaveProperty('partCount');
      expect(textNode.nodeValue).toContain('Translated paragraph one\n\nTranslated paragraph two');
    });

    it('should keep a three-paragraph node as a single provider payload item', async () => {
      testElement.textContent = 'One\n\nTwo\n\nThree';
      const textNode = testElement.firstChild;

      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: textNode, text: textNode.nodeValue, uid: 'n1', blockId: 'b1', role: 'div' }
      ]);

      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
        success: true,
        streaming: false,
        translatedText: JSON.stringify([{ t: 'Translated one\n\nTranslated two\n\nTranslated three', i: 'n1' }])
      });

      const result = await adapter.translateElement(testElement, { provider: 'googlev2' });
      const payload = JSON.parse(contentScriptIntegration.sendTranslationRequest.mock.calls[0][0].data.text);

      expect(result.success).toBe(true);
      expect(payload).toHaveLength(1);
      expect(payload[0].t).toBe('One\n\nTwo\n\nThree');
      expect(textNode.nodeValue).toContain('Translated one\n\nTranslated two\n\nTranslated three');
    });

    it('should leave text without internal paragraph breaks unchanged in payload shape', async () => {
      testElement.textContent = 'Hello world';
      const textNode = testElement.firstChild;

      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: textNode, text: textNode.nodeValue, uid: 'n1', blockId: 'b1', role: 'div' }
      ]);

      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
        success: true,
        streaming: false,
        translatedText: JSON.stringify([{ t: 'Hello translated', i: 'n1' }])
      });

      const result = await adapter.translateElement(testElement, { provider: 'googlev2' });
      const payload = JSON.parse(contentScriptIntegration.sendTranslationRequest.mock.calls[0][0].data.text);

      expect(result.success).toBe(true);
      expect(payload).toHaveLength(1);
      expect(payload[0]).toMatchObject({ i: 'n1', t: 'Hello world', b: 'b1', r: 'div' });
      expect(textNode.nodeValue).toContain('Hello translated');
    });

    it('should keep multiple Select Element nodes in original 1:1 mapping even when one has paragraphs', async () => {
      const firstNode = document.createTextNode('First paragraph\n\nSecond line');
      const secondNode = document.createTextNode('Another segment');
      testElement.replaceChildren(firstNode, secondNode);

      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: firstNode, text: firstNode.nodeValue, uid: 'n1', blockId: 'b1', role: 'div' },
        { node: secondNode, text: secondNode.nodeValue, uid: 'n2', blockId: 'b2', role: 'div' }
      ]);

      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
        success: true,
        streaming: false,
        translatedText: JSON.stringify([
          { t: 'First translated\n\nSecond paragraph translated', i: 'n1' },
          { t: 'Second translated', i: 'n2' }
        ])
      });

      const result = await adapter.translateElement(testElement, { provider: 'googlev2' });
      const payload = JSON.parse(contentScriptIntegration.sendTranslationRequest.mock.calls[0][0].data.text);

      expect(result.success).toBe(true);
      expect(payload).toHaveLength(2);
      expect(payload[0]).toMatchObject({ i: 'n1', t: 'First paragraph\n\nSecond line' });
      expect(payload[1]).toMatchObject({ i: 'n2', t: 'Another segment' });
      expect(payload[0]).not.toHaveProperty('parentUid');
      expect(payload[1]).not.toHaveProperty('parentUid');
      expect(firstNode.nodeValue).toContain('First translated\n\nSecond paragraph translated');
      expect(secondNode.nodeValue).toContain('Second translated');
    });

    it('should not split AI provider payloads', async () => {
      const { getEffectiveProviderAsync } = await import('@/config.js');
      getEffectiveProviderAsync.mockResolvedValueOnce('gemini');

      testElement.textContent = 'Paragraph one\n\nParagraph two';
      const textNode = testElement.firstChild;

      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: textNode, text: textNode.nodeValue, uid: 'n1', blockId: 'b1', role: 'div' }
      ]);

      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
        success: true,
        streaming: false,
        translatedText: JSON.stringify([{ t: 'Translated text', i: 'n1' }])
      });

      await adapter.translateElement(testElement);
      const payload = JSON.parse(contentScriptIntegration.sendTranslationRequest.mock.calls[0][0].data.text);

      expect(payload).toHaveLength(1);
      expect(payload[0].t).toBe('Paragraph one\n\nParagraph two');
      expect(textNode.nodeValue).toContain('Translated text');
    });

    it('should handle translation errors', async () => {
      contentScriptIntegration.sendTranslationRequest.mockRejectedValue(new Error('Network error'));

      await expect(adapter.translateElement(testElement)).rejects.toThrow('Network error');
      
      // ErrorHandler should NOT be called in this layer (Single Red Log Policy)
      expect(errorHandlerMock.handle).not.toHaveBeenCalled();
    });

    it('should throw error if no translatable text found', async () => {
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([]);

      const { ErrorTypes } = await import('@/shared/error-management/ErrorTypes.js');
      try {
        await adapter.translateElement(testElement);
        expect.fail('translateElement should have thrown');
      } catch (error) {
        expect(error.message).toBe('No translatable text found');
        expect(error.type).toBe(ErrorTypes.NO_TRANSLATABLE_CONTENT);
        expect(error.type).not.toBe(ErrorTypes.VALIDATION);
      }
    });

    describe('mode capability preflight', () => {
      // Deterministically fix the block-grouping flag. mockReset also clears any
      // once-implementation leaked by earlier tests that short-circuit the
      // block-grouping read, so each preflight test observes the mode it requests.
      async function configureBlockGrouping(enabled) {
        const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
        getFeatureSemanticBlockGroupingAsync.mockReset();
        getFeatureSemanticBlockGroupingAsync.mockResolvedValue(false);
        if (enabled) getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      }

      async function expectUnsupportedModePreflight(tag, html) {
        const { collectTextNodes, collectBlockGroups } = await import('./DomTranslatorUtils.js');
        const { ErrorTypes } = await import('@/shared/error-management/ErrorTypes.js');
        const { SelectElementReason } = await import('./SelectElementPolicy.js');

        await configureBlockGrouping(false);

        const el = document.createElement(tag);
        el.textContent = html;
        document.body.appendChild(el);

        await expect(adapter.translateElement(el)).rejects.toMatchObject({
          type: ErrorTypes.NO_TRANSLATABLE_CONTENT,
          reason: SelectElementReason.UNSUPPORTED_MODE,
        });
        expect(collectTextNodes).not.toHaveBeenCalled();
        expect(collectBlockGroups).not.toHaveBeenCalled();
        expect(contentScriptIntegration.sendTranslationRequest).not.toHaveBeenCalled();
        document.body.removeChild(el);
      }

      it('rejects PRE root under V2 with UNSUPPORTED_MODE before extraction or request', async () => {
        await expectUnsupportedModePreflight('pre', 'const x = 1;');
      });

      it('rejects CODE root under V2 with UNSUPPORTED_MODE before extraction or request', async () => {
        await expectUnsupportedModePreflight('code', 'const x = 1;');
      });

      it('rejects a <pre><code> shape under V2 without special-casing the child', async () => {
        const { collectTextNodes, collectBlockGroups } = await import('./DomTranslatorUtils.js');
        const { ErrorTypes } = await import('@/shared/error-management/ErrorTypes.js');
        const { SelectElementReason } = await import('./SelectElementPolicy.js');

        await configureBlockGrouping(false);

        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = 'const x = 1;';
        pre.appendChild(code);
        document.body.appendChild(pre);

        await expect(adapter.translateElement(pre)).rejects.toMatchObject({
          type: ErrorTypes.NO_TRANSLATABLE_CONTENT,
          reason: SelectElementReason.UNSUPPORTED_MODE,
        });
        expect(collectTextNodes).not.toHaveBeenCalled();
        expect(collectBlockGroups).not.toHaveBeenCalled();
        expect(contentScriptIntegration.sendTranslationRequest).not.toHaveBeenCalled();
        document.body.removeChild(pre);
      });

      it('passes PRE root under V3 through block grouping unchanged', async () => {
        await configureBlockGrouping(true);
        const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
        collectBlockGroups.mockClear();

        const pre = document.createElement('pre');
        pre.textContent = 'const x = 1;';
        document.body.appendChild(pre);
        collectBlockGroups.mockReturnValueOnce([{
          id: 'n1',
          blockId: 'g1',
          text: 'const x = 1;',
          leadingWS: '',
          trailingWS: '',
          preWhitespace: true,
          directionHint: 'ltr',
          inlineParentTags: ['pre'],
          mode: 'V2_PASSTHROUGH',
          node: pre.firstChild
        }]);

        contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
          success: true,
          streaming: false,
          translatedText: JSON.stringify([{ t: 'x', i: 'n1' }])
        });

        const result = await adapter.translateElement(pre);
        expect(result.success).toBe(true);
        expect(collectBlockGroups).toHaveBeenCalledTimes(1);
        expect(collectBlockGroups).toHaveBeenCalledWith(pre, expect.any(Object), {
          extractionMode: 'v3',
          includeOpenShadowRoots: false,
        });
        expect(pre.textContent).toContain('x');
        document.body.removeChild(pre);
      });

      it('passes CODE root under V3 through block grouping unchanged', async () => {
        await configureBlockGrouping(true);
        const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
        collectBlockGroups.mockClear();

        const code = document.createElement('code');
        code.textContent = 'const y = 2;';
        document.body.appendChild(code);
        collectBlockGroups.mockReturnValueOnce([{
          id: 'n1',
          blockId: 'g1',
          text: 'const y = 2;',
          leadingWS: '',
          trailingWS: '',
          preWhitespace: true,
          directionHint: 'ltr',
          inlineParentTags: ['code'],
          mode: 'V2_PASSTHROUGH',
          node: code.firstChild
        }]);

        contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
          success: true,
          streaming: false,
          translatedText: JSON.stringify([{ t: 'y', i: 'n1' }])
        });

        const result = await adapter.translateElement(code);
        expect(result.success).toBe(true);
        expect(collectBlockGroups).toHaveBeenCalledTimes(1);
        expect(collectBlockGroups).toHaveBeenCalledWith(code, expect.any(Object), {
          extractionMode: 'v3',
          includeOpenShadowRoots: false,
        });
        expect(code.textContent).toContain('y');
        document.body.removeChild(code);
      });

      it('leaves an ordinary DIV root under V2 untouched by the preflight', async () => {
        await configureBlockGrouping(false);
        const { collectTextNodes } = await import('./DomTranslatorUtils.js');
        collectTextNodes.mockClear();

        const div = document.createElement('div');
        div.textContent = 'Ordinary paragraph text';
        document.body.appendChild(div);
        collectTextNodes.mockReturnValueOnce([{
          node: div.firstChild,
          text: div.firstChild.textContent,
          uid: 'n1',
          blockId: 'b1',
          role: 'div'
        }]);

        contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
          success: true,
          streaming: false,
          translatedText: JSON.stringify([{ t: 'پاراگراف', i: 'n1' }])
        });

        const result = await adapter.translateElement(div);
        expect(result.success).toBe(true);
        expect(collectTextNodes).toHaveBeenCalledWith(div, {
          extractionMode: 'v2',
          includeOpenShadowRoots: false,
        });
        expect(div.textContent).toContain('پاراگراف');
        document.body.removeChild(div);
      });
    });

    it('should handle fatal stream errors', async () => {
      let streamCallbacks;
      registerTranslation.mockImplementation((id, callbacks) => {
        streamCallbacks = callbacks;
      });

      const { isFatalError } = await import('@/shared/error-management/ErrorMatcher.js');
      isFatalError.mockReturnValueOnce(true);

      contentScriptIntegration.sendTranslationRequest.mockImplementation(async () => {
        setTimeout(() => {
          streamCallbacks.onStreamUpdate({
            success: false,
            error: {
              message: 'Fatal API Error',
              type: 'API_ERROR',
              originalType: 'UPSTREAM_ERROR',
              statusCode: 503,
              context: 'select-element',
              providerName: 'Provider',
              providerId: 'provider-id',
              code: 'UPSTREAM_FAILURE',
              errorCode: 'E_UPSTREAM',
              translationOutcome: { partial: true },
              cause: 'unsafe cause',
              arbitrary: { unsafe: true }
            }
          });
        }, 10);
        return { success: true, streaming: true };
      });

      const rejection = adapter.translateElement(testElement);
      await expect(rejection).rejects.toThrow('Fatal API Error');
      try {
        await rejection;
      } catch (error) {
        expect(error).toMatchObject({
          type: 'API_ERROR',
          originalType: 'UPSTREAM_ERROR',
          statusCode: 503,
          context: 'select-element',
          providerName: 'Provider',
          providerId: 'provider-id',
          code: 'UPSTREAM_FAILURE',
          errorCode: 'E_UPSTREAM',
          isFatal: true,
          translationOutcome: {
            committedParentCount: 0,
            totalParentCount: 1,
            cancelled: false
          }
        });
        expect(error).not.toHaveProperty('cause');
        expect(error).not.toHaveProperty('arbitrary');
      }
    });

    it('takes fatal path from canonical errorDetails over nonfatal legacy error on stream update', async () => {
      let streamCallbacks;
      registerTranslation.mockImplementation((id, callbacks) => {
        streamCallbacks = callbacks;
      });

      const { isFatalError } = await import('@/shared/error-management/ErrorMatcher.js');
      isFatalError.mockImplementation((err) => err?.type === 'FATAL_ERROR');

      contentScriptIntegration.sendTranslationRequest.mockImplementation(async () => {
        setTimeout(() => {
          streamCallbacks.onStreamUpdate({
            success: false,
            error: { message: 'legacy nonfatal', type: 'NONFATAL' },
            errorDetails: { message: 'canonical failure', type: 'FATAL_ERROR' }
          });
        }, 10);
        return { success: true, streaming: true };
      });

      const rejection = adapter.translateElement(testElement);
      await expect(rejection).rejects.toThrow('canonical failure');
      try {
        await rejection;
      } catch (error) {
        expect(error).toMatchObject({ type: 'FATAL_ERROR', isFatal: true });
      }
    });

    it('still takes fatal path from legacy error when errorDetails is malformed on stream update', async () => {
      let streamCallbacks;
      registerTranslation.mockImplementation((id, callbacks) => {
        streamCallbacks = callbacks;
      });

      const { isFatalError } = await import('@/shared/error-management/ErrorMatcher.js');
      isFatalError.mockImplementation((err) => err?.type === 'FATAL_ERROR');

      contentScriptIntegration.sendTranslationRequest.mockImplementation(async () => {
        setTimeout(() => {
          streamCallbacks.onStreamUpdate({
            success: false,
            error: { message: 'legacy fatal', type: 'FATAL_ERROR' },
            errorDetails: { arbitrary: true }
          });
        }, 10);
        return { success: true, streaming: true };
      });

      const rejection = adapter.translateElement(testElement);
      await expect(rejection).rejects.toThrow('legacy fatal');
      try {
        await rejection;
      } catch (error) {
        expect(error).toMatchObject({ type: 'FATAL_ERROR', isFatal: true });
      }
    });

    it('prefers canonical errorDetails over legacy error on stream end', async () => {
      let streamCallbacks;
      registerTranslation.mockImplementation((id, callbacks) => {
        streamCallbacks = callbacks;
      });

      contentScriptIntegration.sendTranslationRequest.mockImplementation(async () => {
        setTimeout(() => {
          streamCallbacks.onStreamEnd({
            success: false,
            error: { message: 'legacy failure', type: 'LEGACY_ERROR' },
            errorDetails: { message: 'canonical failure', type: 'MODEL_NOT_FOUND' }
          });
        }, 10);
        return { success: true, streaming: true };
      });

      const rejection = adapter.translateElement(testElement);
      await expect(rejection).rejects.toThrow('canonical failure');
      try {
        await rejection;
      } catch (error) {
        expect(error).toMatchObject({ type: 'MODEL_NOT_FOUND' });
      }
    });

    it('prefers canonical errorDetails over legacy error on direct response', async () => {
      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
        success: false,
        streaming: false,
        error: { message: 'legacy failure', type: 'LEGACY_ERROR' },
        errorDetails: { message: 'canonical failure', type: 'MODEL_NOT_FOUND' }
      });

      const rejection = adapter.translateElement(testElement);
      await expect(rejection).rejects.toThrow('canonical failure');
      try {
        await rejection;
      } catch (error) {
        expect(error).toMatchObject({ type: 'MODEL_NOT_FOUND' });
      }
    });

    it('reconstructs direct DTO errors canonically', async () => {
      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
        success: false,
        streaming: false,
        error: {
          message: 'Direct API Error',
          type: 'API_ERROR',
          originalType: 'UPSTREAM_ERROR',
          statusCode: 503,
          context: 'select-element',
          providerName: 'Provider',
          providerId: 'provider-id',
          code: 'UPSTREAM_FAILURE',
          errorCode: 'E_UPSTREAM',
          translationOutcome: { partial: true },
          cause: 'unsafe cause',
          arbitrary: { unsafe: true }
        }
      });

      const rejection = adapter.translateElement(testElement);
      await expect(rejection).rejects.toThrow('Direct API Error');
      try {
        await rejection;
      } catch (error) {
        expect(error).toMatchObject({
          type: 'API_ERROR',
          originalType: 'UPSTREAM_ERROR',
          statusCode: 503,
          context: 'select-element',
          providerName: 'Provider',
          providerId: 'provider-id',
          code: 'UPSTREAM_FAILURE',
          errorCode: 'E_UPSTREAM',
          translationOutcome: {
            committedParentCount: 0,
            totalParentCount: 1,
            cancelled: false
          }
        });
        expect(error).not.toHaveProperty('cause');
        expect(error).not.toHaveProperty('arbitrary');
        expect(error).not.toHaveProperty('isFatal');
      }
    });

    it('should handle stream cancellation', async () => {
      let streamCallbacks;
      registerTranslation.mockImplementation((id, callbacks) => {
        streamCallbacks = callbacks;
      });

      contentScriptIntegration.sendTranslationRequest.mockImplementation(async () => {
        setTimeout(() => {
          streamCallbacks.onStreamEnd({ cancelled: true });
        }, 10);
        return { success: true, streaming: true };
      });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      const cancelledSessionId = adapter.currentSessionId;
      streamCallbacks.onStreamEnd({ cancelled: true });
      const result = await translation;

      expect(result.success).toBe(false);
      expect(result.cancelled).toBe(true);
      expect(result.committedParentCount).toBe(0);
      expect(globalSelectElementState.translationHistory).not.toContain(
        expect.objectContaining({ sessionId: cancelledSessionId })
      );
      expect([...globalSelectElementState.snapshots.keys()]
        .some(key => key.startsWith(`${cancelledSessionId}:`))).toBe(false);
      expect(globalSelectElementState.currentTranslation?.sessionId).not.toBe(cancelledSessionId);
    });

    it('should update effective target language if provided in stream', async () => {
      let streamCallbacks;
      registerTranslation.mockImplementation((id, callbacks) => {
        streamCallbacks = callbacks;
      });

      contentScriptIntegration.sendTranslationRequest.mockImplementation(async () => {
        setTimeout(() => {
          streamCallbacks.onStreamUpdate({
            success: true,
            data: [{ t: 'こんにちは', i: 'n1' }],
            targetLanguage: 'ja'
          });
          streamCallbacks.onStreamEnd({ success: true, targetLanguage: 'ja' });
        }, 10);
        return { success: true, streaming: true };
      });

      const { applyElementDirection } = await import('@/utils/dom/DomDirectionManager.js');

      await adapter.translateElement(testElement);
      
      // Verify finalization used the detected language
      expect(applyElementDirection).toHaveBeenCalledWith(testElement, 'ja');
    });

    it('should retain successful batches when stream end fails after complete commit', async () => {
      let streamCallbacks;
      registerTranslation.mockImplementation((id, callbacks) => {
        streamCallbacks = callbacks;
      });

      contentScriptIntegration.sendTranslationRequest.mockImplementation(async () => {
        setTimeout(() => {
          streamCallbacks.onStreamUpdate({
            success: true,
            data: [{ t: 'سلام', i: 'n1' }]
          });
          streamCallbacks.onStreamEnd({
            success: false,
            error: { message: 'Batch failed', type: 'TRANSLATION_FAILED' }
          });
        }, 10);
        return { success: true, streaming: true };
      });

      await expect(adapter.translateElement(testElement)).resolves.toMatchObject({
        success: true,
        committedParentCount: 1,
      });
      expect(testElement.textContent).toContain('سلام');
    });

    it('keeps stream open after non-fatal update and rejects zero-commit success', async () => {
      let streamCallbacks;
      registerTranslation.mockImplementationOnce((_id, callbacks) => {
        streamCallbacks = callbacks;
      });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());

      streamCallbacks.onStreamUpdate({
        success: false,
        error: { message: 'Network failed', type: 'NETWORK_ERROR' }
      });
      expect(streamCallbacks).toBeDefined();
      streamCallbacks.onStreamEnd({ success: true });

      const result = await translation;
      expect(result).toMatchObject({
        success: false,
        committedParentCount: 0,
        error: { type: 'NO_ACCEPTED_TRANSLATION_RESULTS' }
      });
      expect(testElement.textContent).toBe('Hello');
      expect(sendRegularMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ accepted: true }) }),
        expect.anything()
      );
    });

    it('continues after non-fatal update and preserves later committed parent', async () => {
      let streamCallbacks;
      registerTranslation.mockImplementationOnce((_id, callbacks) => {
        streamCallbacks = callbacks;
      });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      streamCallbacks.onStreamUpdate({
        success: false,
        error: { message: 'Network failed', type: 'NETWORK_ERROR' }
      });
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'سلام', i: 'n1' }] });
      streamCallbacks.onStreamEnd({ success: true });

      const result = await translation;
      expect(result).toMatchObject({ success: true, committedParentCount: 1 });
      expect(testElement.textContent).toContain('سلام');
    });

    it('keeps committed parent when terminal stream failure follows non-fatal update', async () => {
      let streamCallbacks;
      registerTranslation.mockImplementationOnce((_id, callbacks) => {
        streamCallbacks = callbacks;
      });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      streamCallbacks.onStreamUpdate({
        success: false,
        error: { message: 'Network failed', type: 'NETWORK_ERROR' }
      });
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'سلام', i: 'n1' }] });
      streamCallbacks.onStreamEnd({
        success: false,
        error: { message: 'Terminal stream failure', type: 'TRANSLATION_FAILED' }
      });

      await expect(translation).resolves.toMatchObject({ success: true, committedParentCount: 1 });
      expect(testElement.textContent).toContain('سلام');
      expect(globalSelectElementState.translationHistory.at(-1).originalTextNodesData[0].appliedText)
        .toBe(testElement.firstChild.nodeValue);
    });

    it('keeps committed parent when cancellation follows non-fatal update', async () => {
      let streamCallbacks;
      registerTranslation.mockImplementationOnce((_id, callbacks) => {
        streamCallbacks = callbacks;
      });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      streamCallbacks.onStreamUpdate({
        success: false,
        error: { message: 'Network failed', type: 'NETWORK_ERROR' }
      });
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'سلام', i: 'n1' }] });
      streamCallbacks.onStreamEnd({ cancelled: true });

      const result = await translation;
      expect(result).toMatchObject({ success: false, cancelled: true });
      expect(testElement.textContent).toContain('سلام');
      const entry = globalSelectElementState.translationHistory.at(-1);
      expect(entry).toBeDefined();
      expect(entry.originalTextNodesData[0].appliedText).toBe(testElement.firstChild.nodeValue);

      const { revertSelectElementTranslation } = await import('./DomTranslatorState.js');
      await revertSelectElementTranslation(entry.sessionId);
      expect(testElement.textContent).toBe('Hello');
    });

    it.each([
      ['text drift', () => { testElement.firstChild.nodeValue = 'Changed'; }],
      ['whitespace drift', () => { testElement.firstChild.nodeValue = 'Hello '; }],
      ['detached node', () => { testElement.firstChild.remove(); }],
      ['replaced node', () => { testElement.replaceChildren(document.createTextNode('Hello')); }],
    ])('rejects direct result after %s without mutation or accepted ACK', async (_caseName, mutateSource) => {
      contentScriptIntegration.sendTranslationRequest.mockImplementation(async () => {
        mutateSource();
        return {
          success: true,
          streaming: false,
          translatedText: JSON.stringify([{ t: 'سلام', i: 'n1' }])
        };
      });

      await adapter.translateElement(testElement);

      expect(testElement.textContent).toBe(testElement.firstChild?.nodeValue || '');
      expect(testElement.textContent).not.toContain('سلام');
      expect(sendRegularMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ accepted: true })
      }), expect.anything());
    });

    it('rejects direct result when token is current but source changed', async () => {
      const originalNode = testElement.firstChild;
      contentScriptIntegration.sendTranslationRequest.mockImplementation(async () => {
        originalNode.nodeValue = 'Changed';
        return {
          success: true,
          streaming: false,
          translatedText: JSON.stringify([{ t: 'سلام', i: 'n1' }])
        };
      });

      await adapter.translateElement(testElement);

      expect(originalNode.nodeValue).toBe('Changed');
      expect(sendRegularMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ accepted: true })
      }), expect.anything());
    });

    it('rejects stale token with unchanged source through existing guard', async () => {
      let streamCallbacks;
      registerTranslation.mockImplementation((_id, callbacks) => { streamCallbacks = callbacks; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({ success: true, streaming: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      await adapter.cancelTranslation({ silent: true });
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'سلام', i: 'n1' }] });
      streamCallbacks.onStreamEnd({ success: true });
      await translation;

      expect(testElement.textContent).toBe('Hello');
      expect(sendRegularMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ accepted: true })
      }), expect.anything());
    });

    it('rejects direct streaming result after source drift without mutation or ACK', async () => {
      let streamCallbacks;
      registerTranslation.mockImplementation((_id, callbacks) => { streamCallbacks = callbacks; });
      contentScriptIntegration.sendTranslationRequest.mockImplementation(async () => {
        testElement.firstChild.nodeValue = 'Changed';
        setTimeout(() => {
          streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'سلام', i: 'n1' }] });
          streamCallbacks.onStreamEnd({ success: true });
        }, 0);
        return { success: true, streaming: true };
      });

      await adapter.translateElement(testElement);

      expect(testElement.textContent).toBe('Changed');
      expect(sendRegularMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ accepted: true })
      }), expect.anything());
    });

    it('requires canonical lifecycle for direct handler callers', async () => {
      const staleNode = document.createTextNode('A');
      const validNode = document.createTextNode('B');
      testElement.replaceChildren(staleNode, validNode);
      staleNode.nodeValue = 'Changed A';
      adapter.currentMessageId = 'mixed-direct';

      await expect(adapter._handleDirectResponse({
        success: true,
        translatedText: [
          { t: 'Translated A', i: 'n1' },
          { t: 'Translated B', i: 'n2' }
        ],
        targetLanguage: 'fa'
      }, [], new Map([
        ['n1', { node: staleNode, text: 'A', uid: 'n1', blockId: 'b1' }],
        ['n2', { node: validNode, text: 'B', uid: 'n2', blockId: 'b2' }]
      ]), 'fa', testElement)).rejects.toThrow('canonical parent lifecycle callbacks');

      expect(staleNode.nodeValue).toBe('Changed A');
      expect(validNode.nodeValue).toBe('B');
      expect(sendRegularMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ parentId: 'b2', accepted: true })
      }), { silent: true, timeout: 500 });
      expect(sendRegularMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ parentId: 'b1', accepted: true })
      }), { silent: true, timeout: 500 });
    });

    it('skips stale streaming unit while applying later valid unit', async () => {
      const staleNode = document.createTextNode('A');
      const validNode = document.createTextNode('B');
      testElement.replaceChildren(staleNode, validNode);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: staleNode, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: validNode, text: 'B', uid: 'n2', blockId: 'b2', role: 'div' }
      ]);

      let streamCallbacks;
      registerTranslation.mockImplementationOnce((_id, callbacks) => { streamCallbacks = callbacks; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true, conversationAcceptance: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      staleNode.nodeValue = 'Changed A';
      streamCallbacks.onStreamUpdate({
        success: true,
        data: [
          { t: 'Translated A', i: 'n1' },
          { t: 'Translated B', i: 'n2' }
        ]
      });
      streamCallbacks.onStreamEnd({ success: true });
      await translation;

      expect(staleNode.nodeValue).toBe('Changed A');
      expect(validNode.nodeValue).toContain('Translated B');
      expect(sendRegularMessage).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ parentId: 'b2', accepted: true })
      }), { silent: true, timeout: 500 });
      expect(sendRegularMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ parentId: 'b1', accepted: true })
      }), { silent: true, timeout: 500 });
    });

    it('should keep all units original while fragmented parent stream fails', async () => {
      const nodeA = document.createTextNode('Original A');
      const nodeB = document.createTextNode('Original B');
      const nodeC = document.createTextNode('Original C');
      testElement.replaceChildren(nodeA, nodeB, nodeC);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: nodeA, text: nodeA.nodeValue, uid: 'n1', blockId: 'b1', role: 'div' },
        { node: nodeB, text: nodeB.nodeValue, uid: 'n2', blockId: 'b1', role: 'div' },
        { node: nodeC, text: nodeC.nodeValue, uid: 'n3', blockId: 'b1', role: 'div' }
      ]);
      let streamCallbacks;
      registerTranslation.mockImplementation((_id, callbacks) => {
        streamCallbacks = callbacks;
      });
      contentScriptIntegration.sendTranslationRequest.mockImplementation(async () => {
        setTimeout(() => {
          streamCallbacks.onStreamUpdate({ success: true, data: [{ i: 'n1', t: 'Translated A' }] });
          streamCallbacks.onStreamUpdate({ success: true, data: [{ i: 'n3', t: 'Translated C' }] });
          streamCallbacks.onStreamEnd({ success: false, error: { message: 'B failed', type: 'TRANSLATION_FAILED' } });
        }, 10);
        return { success: true, streaming: true };
      });

      await expect(adapter.translateElement(testElement)).rejects.toThrow('B failed');

      expect(nodeA.nodeValue).toBe('Original A');
      expect(nodeB.nodeValue).toBe('Original B');
      expect(nodeC.nodeValue).toBe('Original C');
    });

    it('should ignore missing UID in stream without mutating or ACKing', async () => {
      let streamCallbacks;
      registerTranslation.mockImplementation((id, callbacks) => {
        streamCallbacks = callbacks;
      });

      contentScriptIntegration.sendTranslationRequest.mockImplementation(async () => {
        setTimeout(() => {
          streamCallbacks.onStreamUpdate({
            success: true,
            data: [{ t: 'سلام' }] // No UID
          });
          streamCallbacks.onStreamEnd({ success: true });
        }, 10);
        return { success: true, streaming: true };
      });

      await adapter.translateElement(testElement);
      expect(testElement.textContent).toContain('Hello');
      expect(sendRegularMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ accepted: true })
      }), expect.anything());
    });

    it('should ignore ambiguous aliases in stream without mutating or ACKing', async () => {
      let streamCallbacks;
      registerTranslation.mockImplementation((_id, callbacks) => {
        streamCallbacks = callbacks;
      });
      contentScriptIntegration.sendTranslationRequest.mockImplementation(async () => {
        setTimeout(() => {
          streamCallbacks.onStreamUpdate({
            success: true,
            data: [{ t: 'سلام', i: 'n1', uid: 'n2' }]
          });
          streamCallbacks.onStreamEnd({ success: true });
        }, 10);
        return { success: true, streaming: true };
      });

      await adapter.translateElement(testElement);

      expect(testElement.textContent).toContain('Hello');
      expect(sendRegularMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ accepted: true })
      }), expect.anything());
    });

    it('should send AI context when enabled', async () => {
      const { getAIContextTranslationEnabledAsync } = await import('@/config.js');
      getAIContextTranslationEnabledAsync.mockResolvedValue(true);

      await adapter.translateElement(testElement);

      expect(contentScriptIntegration.sendTranslationRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            contextMetadata: expect.any(Object),
            contextSummary: 'test context'
          })
        })
      );
    });

    it('should handle multiple stream updates with deduplication', async () => {
      let streamCallbacks;
      registerTranslation.mockImplementation((id, callbacks) => {
        streamCallbacks = callbacks;
      });

      contentScriptIntegration.sendTranslationRequest.mockImplementation(async () => {
        setTimeout(() => {
          // Batch 1
          streamCallbacks.onStreamUpdate({
            success: true,
            data: [{ t: 'سلام', i: 'n1' }]
          });
          // Batch 2 (Redundant update for n1, should be ignored)
          streamCallbacks.onStreamUpdate({
            success: true,
            data: [{ t: 'ignored', i: 'n1' }]
          });
          streamCallbacks.onStreamEnd({ success: true });
        }, 10);
        return { success: true, streaming: true };
      });

      await adapter.translateElement(testElement);
      expect(testElement.textContent).toContain('سلام');
      expect(testElement.textContent).not.toContain('ignored');
    });

    it('should cleanup session even if translation fails', async () => {
      const cleanupSpy = vi.spyOn(adapter, '_cleanupCurrentSession');
      contentScriptIntegration.sendTranslationRequest.mockRejectedValue(new Error('Fail'));

      try {
        await adapter.translateElement(testElement);
      } catch {
        // Expected
      }

      expect(cleanupSpy).toHaveBeenCalled();
    });

    it('should preserve original text when direct response has no identity', async () => {
      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
        success: true,
        streaming: false,
        translatedText: 'Plain text translation' // Not JSON
      });

      const result = await adapter.translateElement(testElement);
      expect(result.success).toBe(false);
      expect(result.committedParentCount).toBe(0);
      expect(testElement.textContent).toContain('Hello');
    });

    it('should handle error in onStreamEnd', async () => {
      let streamCallbacks;
      registerTranslation.mockImplementation((id, callbacks) => {
        streamCallbacks = callbacks;
      });

      contentScriptIntegration.sendTranslationRequest.mockImplementation(async () => {
        setTimeout(() => {
          streamCallbacks.onStreamEnd({ success: false, error: 'Final stream error' });
        }, 10);
        return { success: true, streaming: true };
      });

      await expect(adapter.translateElement(testElement)).rejects.toThrow('Final stream error');
    });

    it('attaches partial outcome to stream failures after a direct parent commit', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b2', role: 'div' }
      ]);
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }] });
      callbacks.onStreamEnd({ success: false, error: { message: 'Network failed', type: 'NETWORK_ERROR' } });

      await expect(translation).rejects.toMatchObject({
        translationOutcome: { committedParentCount: 1, totalParentCount: 2, cancelled: false }
      });
      expect(first.nodeValue).toContain('Uno');
      expect(second.nodeValue).toBe('B');
    });

    it('attaches grouped outcome to failures after an earlier BlockGroup commit', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      collectBlockGroups.mockReturnValueOnce([
        { id: 'n1', blockId: 'g1', text: 'A', leadingWS: '', trailingWS: '', preWhitespace: false, directionHint: 'ltr', inlineParentTags: ['div'], mode: 'standard', node: first },
        { id: 'n2', blockId: 'g2', text: 'B', leadingWS: '', trailingWS: '', preWhitespace: false, directionHint: 'ltr', inlineParentTags: ['div'], mode: 'standard', node: second },
      ]);
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }] });
      callbacks.onStreamEnd({ success: false, error: { message: 'V3 marker failure', type: 'VALIDATION' } });

      await expect(translation).rejects.toMatchObject({
        translationOutcome: { committedParentCount: 1, totalParentCount: 2, cancelled: false }
      });
      expect(first.nodeValue).toContain('Uno');
      expect(second.nodeValue).toBe('B');
    });

    it('suppresses a failed stream end after every direct parent committed', async () => {
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'سلام', i: 'n1' }] });
      callbacks.onStreamEnd({ success: false, error: { message: 'Late transport failure', type: 'NETWORK_ERROR' } });

      await expect(translation).resolves.toMatchObject({ success: true, committedParentCount: 1 });
      expect(testElement.textContent).toContain('سلام');
    });

    it('preserves committed parents and blocks late stream mutation and ACK after context loss', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b2', role: 'div' },
      ]);

      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: true,
        conversationAcceptance: true,
      });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }] });
      await vi.waitFor(() => expect(sendRegularMessage).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ parentId: 'b1', accepted: true }) }),
        { silent: true, timeout: 500 }
      ));

      ExtensionContextManager.isValidSync.mockReturnValue(false);
      adapter.invalidateContext();
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'Dos', i: 'n2' }] });
      callbacks.onStreamEnd({ success: true });

      await expect(translation).rejects.toMatchObject({ type: ErrorTypes.EXTENSION_CONTEXT_INVALIDATED });
      expect(first.nodeValue).toContain('Uno');
      expect(second.nodeValue).toBe('B');
      expect(sendRegularMessage.mock.calls.filter(([message]) => message?.data?.accepted === true))
        .toHaveLength(1);
      expect(sendRegularMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ parentId: 'b2' }) }),
        expect.anything()
      );
      expect(contentScriptIntegration.cancelTranslationRequest).not.toHaveBeenCalled();
    });

    it('rejects context loss after stream success but before finalization', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b2', role: 'div' },
      ]);

      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: true,
        conversationAcceptance: true,
      });

      const finalize = adapter._finalizeTranslation.bind(adapter);
      vi.spyOn(adapter, '_finalizeTranslation').mockImplementation(async (args) => {
        ExtensionContextManager.isValidSync.mockReturnValue(false);
        return finalize(args);
      });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks.onStreamUpdate({
        success: true,
        data: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }],
      });
      await vi.waitFor(() => {
        expect(testElement.textContent).toContain('Uno');
        expect(testElement.textContent).toContain('Dos');
      });
      const { applyElementDirection } = await import('@/utils/dom/DomDirectionManager.js');
      applyElementDirection.mockClear();
      const ackCount = sendRegularMessage.mock.calls.length;
      callbacks.onStreamEnd({ success: true });

      await expect(translation).rejects.toMatchObject({
        type: ErrorTypes.EXTENSION_CONTEXT_INVALIDATED,
      });
      expect(applyElementDirection).not.toHaveBeenCalled();
      expect(testElement.textContent).toContain('Uno');
      expect(testElement.textContent).toContain('Dos');
      expect(globalSelectElementState.currentTranslation.partial).toBe(true);
      expect(sendRegularMessage).toHaveBeenCalledTimes(ackCount);
      expect(adapter.isCurrentlyTranslating()).toBe(false);
    });

    it('settles before first commit when context is invalidated during streaming', async () => {
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: true,
        conversationAcceptance: true,
      });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      ExtensionContextManager.isValidSync.mockReturnValue(false);
      adapter.invalidateContext();
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'late', i: 'n1' }] });

      await expect(translation).rejects.toMatchObject({ type: ErrorTypes.EXTENSION_CONTEXT_INVALIDATED });
      expect(testElement.textContent).toBe('Hello');
      expect(sendRegularMessage).not.toHaveBeenCalled();
      expect(contentScriptIntegration.cancelTranslationRequest).not.toHaveBeenCalled();
    });

    it('releases the active root after context invalidation', async () => {
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      ExtensionContextManager.isValidSync.mockReturnValue(false);
      adapter.invalidateContext();
      await expect(translation).rejects.toMatchObject({ type: ErrorTypes.EXTENSION_CONTEXT_INVALIDATED });

      ExtensionContextManager.isValidSync.mockReturnValue(true);
      let retryCallbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { retryCallbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });
      const retry = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(retryCallbacks).toBeDefined());
      retryCallbacks.onStreamUpdate({ success: true, data: [{ t: 'Retry', i: 'n1' }] });
      retryCallbacks.onStreamEnd({ success: true });

      await expect(retry).resolves.toMatchObject({ success: true });
      expect(testElement.textContent).toContain('Retry');
    });

    it('rejects a direct response after context loss before DOM application', async () => {
      contentScriptIntegration.sendTranslationRequest.mockImplementationOnce(async () => {
        ExtensionContextManager.isValidSync.mockReturnValue(false);
        return {
          success: true,
          streaming: false,
          translatedText: [{ t: 'late', i: 'n1' }],
          conversationAcceptance: true,
        };
      });

      await expect(adapter.translateElement(testElement)).rejects.toMatchObject({
        type: ErrorTypes.EXTENSION_CONTEXT_INVALIDATED,
      });
      expect(testElement.textContent).toBe('Hello');
      expect(sendRegularMessage).not.toHaveBeenCalled();
      expect(contentScriptIntegration.cancelTranslationRequest).not.toHaveBeenCalled();
    });

    it('should not apply empty translation', () => {
      const textNode = testElement.firstChild;
      const originalValue = textNode.nodeValue;
      
      adapter._applyTranslationToNode(textNode, '   ', 'fa', testElement);
      
      expect(textNode.nodeValue).toBe(originalValue);
    });

    it('should throw error if direct response handling fails', async () => {
      // Mock error during node application
      const mutationError = new Error('Apply failed');
      vi.spyOn(adapter, '_applyTranslationToNode').mockImplementation(() => {
        throw mutationError;
      });

      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
        success: true,
        streaming: false,
        translatedText: JSON.stringify([{ t: 'Test', i: 'n1' }])
      });

      await expect(adapter.translateElement(testElement)).rejects.toBe(mutationError);
    });

    it('rolls back earlier direct unit writes when a later unit fails', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b1', role: 'div' }
      ]);
      const apply = vi.spyOn(adapter, '_applyTranslationToNode');
      apply.mockImplementationOnce((...args) => DomTranslatorAdapter.prototype._applyTranslationToNode.call(adapter, ...args));
      apply.mockImplementationOnce(() => { throw new Error('second write failed'); });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }]
      });

      await expect(adapter.translateElement(testElement)).rejects.toThrow('second write failed');
      expect(first.nodeValue).toBe('A');
      expect(second.nodeValue).toBe('B');
      expect(sendRegularMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ accepted: true })
      }), expect.anything());
      apply.mockRestore();
    });

    it('preserves primitive mutation failures after rollback', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b1', role: 'div' }
      ]);
      const apply = vi.spyOn(adapter, '_applyTranslationToNode');
      apply.mockImplementationOnce((...args) => DomTranslatorAdapter.prototype._applyTranslationToNode.call(adapter, ...args));
      apply.mockImplementationOnce(() => { throw 'mutation-failure'; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }]
      });

      await expect(adapter.translateElement(testElement)).rejects.toMatchObject({
        message: 'mutation-failure',
        cause: 'mutation-failure',
      });
      expect(first.nodeValue).toBe('A');
      expect(second.nodeValue).toBe('B');
      expect(sendRegularMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ parentId: 'b1', accepted: true })
      }), { silent: true, timeout: 500 });
      apply.mockRestore();
    });

    it('preserves streaming mutation failures after rollback', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b1', role: 'div' }
      ]);
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });
      const apply = vi.spyOn(adapter, '_applyTranslationToNode');
      apply.mockImplementationOnce((...args) => DomTranslatorAdapter.prototype._applyTranslationToNode.call(adapter, ...args));
      apply.mockImplementationOnce(() => { throw 'stream-mutation-failure'; });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }] });

      await expect(translation).rejects.toMatchObject({
        message: 'stream-mutation-failure',
      });
      expect(first.nodeValue).toBe('A');
      expect(second.nodeValue).toBe('B');
      expect(sendRegularMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ parentId: 'b1', accepted: true })
      }), { silent: true, timeout: 500 });
      apply.mockRestore();
    });

    it('does not leak streaming mutation classification to the next request', async () => {
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });
      const apply = vi.spyOn(adapter, '_applyTranslationToNode').mockImplementationOnce(() => { throw 'stream failure'; });

      const firstTranslation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }] });
      await expect(firstTranslation).rejects.toMatchObject({
        message: 'stream failure',
      });

      apply.mockRestore();
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Uno', i: 'n1' }]
      });
      vi.spyOn(adapter, '_getResultIdentity').mockImplementationOnce(() => { throw new Error('ordinary parse failure'); });

      await expect(adapter.translateElement(testElement)).rejects.toThrow('Invalid translation format');
    });

    it('restores shared parent marker after direct rollback', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b1', role: 'div' }
      ]);
      vi.spyOn(adapter, '_applyTranslationToNode')
        .mockImplementationOnce((...args) => DomTranslatorAdapter.prototype._applyTranslationToNode.call(adapter, ...args))
        .mockImplementationOnce(() => { throw new Error('marker failure'); });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }]
      });

      await expect(adapter.translateElement(testElement)).rejects.toThrow('marker failure');
      expect(testElement.hasAttribute('data-has-original')).toBe(false);
    });

    it('preserves existing shared parent marker after direct rollback', async () => {
      testElement.setAttribute('data-has-original', 'custom');
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b1', role: 'div' }
      ]);
      vi.spyOn(adapter, '_applyTranslationToNode')
        .mockImplementationOnce((...args) => DomTranslatorAdapter.prototype._applyTranslationToNode.call(adapter, ...args))
        .mockImplementationOnce(() => { throw new Error('existing marker failure'); });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }]
      });

      await expect(adapter.translateElement(testElement)).rejects.toThrow('existing marker failure');
      expect(testElement.getAttribute('data-has-original')).toBe('custom');
    });

    it('restores text when direction mutation fails after an earlier parent was accepted', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b2', role: 'div' }
      ]);
      const { applyNodeDirection } = await import('@/utils/dom/DomDirectionManager.js');
      applyNodeDirection
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => { throw new Error('direction failed'); });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }],
        conversationAcceptance: true
      });

      await expect(adapter.translateElement(testElement)).rejects.toThrow('direction failed');
      expect(first.nodeValue).toContain('Uno');
      expect(second.nodeValue).toBe('B');
      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === true)
        .map(([message]) => message.data.parentId)).toEqual(['b1']);
    });

    it('restores all units when direction mutation fails within one parent', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b1', role: 'div' }
      ]);
      const { applyNodeDirection, restoreNodeDirectionState } = await import('@/utils/dom/DomDirectionManager.js');
      applyNodeDirection
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => { throw new Error('same parent direction failed'); });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }]
      });

      await expect(adapter.translateElement(testElement)).rejects.toThrow('same parent direction failed');
      expect(first.nodeValue).toBe('A');
      expect(second.nodeValue).toBe('B');
      expect(restoreNodeDirectionState).toHaveBeenCalled();
      expect(sendRegularMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ parentId: 'b1', accepted: true })
      }), { silent: true, timeout: 500 });
    });

    it('logs direction rollback failures while preserving mutation error', async () => {
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: testElement.firstChild, text: 'Hello', uid: 'n1', blockId: 'b1', role: 'div' }
      ]);
      const { applyNodeDirection, restoreNodeDirectionState } = await import('@/utils/dom/DomDirectionManager.js');
      applyNodeDirection.mockImplementationOnce(() => { throw new Error('mutation error'); });
      restoreNodeDirectionState.mockReturnValueOnce([
        { kind: 'style', name: 'direction', error: new Error('rollback error') }
      ]);
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Uno', i: 'n1' }]
      });
      const errorSpy = vi.spyOn(adapter.logger, 'error');

      await expect(adapter.translateElement(testElement)).rejects.toThrow('mutation error');
      expect(errorSpy).toHaveBeenCalledWith(
        '[DomTranslatorAdapter] Direct direction rollback failed',
        expect.objectContaining({ name: 'direction' })
      );
    });

    it('removes transaction-only hover state after direct rollback', async () => {
      const lookup = new Map();
      hoverPreviewLookup.get.mockImplementation(node => lookup.get(node));
      hoverPreviewLookup.add.mockImplementation((node, value) => lookup.set(node, value));
      hoverPreviewLookup.delete.mockImplementation(node => lookup.delete(node));
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b1', role: 'div' }
      ]);
      vi.spyOn(adapter, '_applyTranslationToNode')
        .mockImplementationOnce((...args) => DomTranslatorAdapter.prototype._applyTranslationToNode.call(adapter, ...args))
        .mockImplementationOnce(() => { throw new Error('hover rollback failure'); });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }]
      });

      await expect(adapter.translateElement(testElement)).rejects.toThrow('hover rollback failure');
      expect(lookup.has(first)).toBe(false);
      expect(lookup.has(second)).toBe(false);
    });

    it('emits one rejection ACK on direct mutation failure and never a positive ACK', async () => {
      const textNode = testElement.firstChild;
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: textNode, text: 'Hello', uid: 'n1', blockId: 'b1', role: 'div' }
      ]);
      vi.spyOn(adapter, '_applyTranslationToNode').mockImplementationOnce(() => {
        throw new Error('mutation failure');
      });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Uno', i: 'n1' }],
        conversationAcceptance: true,
      });

      await expect(adapter.translateElement(testElement)).rejects.toThrow('mutation failure');

      const ackCalls = sendRegularMessage.mock.calls
        .map(([message]) => message?.data)
        .filter(data => data?.parentId === 'b1');
      expect(ackCalls).toEqual([
        expect.objectContaining({ parentId: 'b1', accepted: false })
      ]);
      expect(textNode.nodeValue).toBe('Hello');
    });

    it('aggregates direct rollback failures while preserving the original mutation error', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b1', role: 'div' }
      ]);
      let streamCallbacks;
      registerTranslation.mockImplementationOnce((_id, callbacks) => { streamCallbacks = callbacks; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: true,
        conversationAcceptance: true,
      });
      const { applyNodeDirection, restoreNodeDirectionState } = await import('@/utils/dom/DomDirectionManager.js');
      vi.spyOn(adapter, '_applyTranslationToNode')
        .mockImplementationOnce((...args) => DomTranslatorAdapter.prototype._applyTranslationToNode.call(adapter, ...args))
        .mockImplementationOnce(() => { throw new Error('second node mutation failed'); });
      applyNodeDirection.mockImplementation(() => {});
      restoreNodeDirectionState.mockReturnValueOnce([
        { kind: 'style', name: 'direction', error: new Error('direction restore failed') }
      ]);

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }] });
      streamCallbacks.onStreamEnd({ success: true });

      const rejection = await translation.catch(error => error);
      expect(rejection.cause).toBeInstanceOf(Object);
      expect(rejection.cause.rollbackFailures).toEqual([
        expect.objectContaining({ kind: 'style', name: 'direction' })
      ]);
      expect(rejection.cause.cause?.message).toBe('second node mutation failed');
      expect(first.nodeValue).toBe('A');
      expect(second.nodeValue).toBe('B');
      const b1Acks = sendRegularMessage.mock.calls
        .map(([message]) => message)
        .filter(message => message?.data?.parentId === 'b1');
      expect(b1Acks).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ accepted: false }) })
      ]);
    });

    it('continues text restorations past a failing restore and preserves the primary mutation error', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      const third = document.createTextNode('C');
      testElement.replaceChildren(first, second, third);
      const originalSecond = second.nodeValue;
      let currentSecond = originalSecond;
      let secondWrites = 0;
      Object.defineProperty(second, 'nodeValue', {
        configurable: true,
        get: () => currentSecond,
        set: (value) => {
          secondWrites += 1;
          if (secondWrites > 1) throw new Error('text rollback failure');
          currentSecond = value;
        }
      });
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b1', role: 'div' },
        { node: third, text: 'C', uid: 'n3', blockId: 'b1', role: 'div' }
      ]);
      let streamCallbacks;
      registerTranslation.mockImplementationOnce((_id, callbacks) => { streamCallbacks = callbacks; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: true,
        conversationAcceptance: true,
      });
      vi.spyOn(adapter, '_applyTranslationToNode')
        .mockImplementationOnce((...args) => DomTranslatorAdapter.prototype._applyTranslationToNode.call(adapter, ...args))
        .mockImplementationOnce((...args) => DomTranslatorAdapter.prototype._applyTranslationToNode.call(adapter, ...args))
        .mockImplementationOnce(() => { throw new Error('primary mutation failure'); });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }, { t: 'Tres', i: 'n3' }] });
      streamCallbacks.onStreamEnd({ success: true });

      const rejection = await translation.catch(error => error);
      expect(rejection.cause.cause?.message).toBe('primary mutation failure');
      expect(rejection.cause.rollbackFailures).toEqual([
        expect.objectContaining({ kind: 'text', node: second, error: expect.objectContaining({ message: 'text rollback failure' }) })
      ]);
      expect(third.nodeValue).toBe('C');
      expect(first.nodeValue).toBe('A');
      expect(second.nodeValue).toContain('Dos');

      const b1Acks = sendRegularMessage.mock.calls
        .map(([message]) => message)
        .filter(message => message?.data?.parentId === 'b1');
      expect(b1Acks).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ accepted: false }) })
      ]);
    });

    it('continues direction and hover rollback after attribute restoration fails', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const originalRemoveAttribute = testElement.removeAttribute.bind(testElement);
      vi.spyOn(testElement, 'removeAttribute').mockImplementation((name) => {
        if (name === 'data-has-original') throw new Error('attribute restore failure');
        return originalRemoveAttribute(name);
      });
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b1', role: 'div' }
      ]);
      const { restoreNodeDirectionState } = await import('@/utils/dom/DomDirectionManager.js');
      restoreNodeDirectionState.mockReturnValueOnce([]);
      const hoverDeletes = [];
      hoverPreviewLookup.delete.mockImplementation(node => hoverDeletes.push(node));
      let streamCallbacks;
      registerTranslation.mockImplementationOnce((_id, callbacks) => { streamCallbacks = callbacks; });
      vi.spyOn(adapter, '_applyTranslationToNode')
        .mockImplementationOnce((...args) => DomTranslatorAdapter.prototype._applyTranslationToNode.call(adapter, ...args))
        .mockImplementationOnce(() => { throw new Error('primary mutation failure'); });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: true,
      });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }] });
      streamCallbacks.onStreamEnd({ success: true });
      const rejection = await translation.catch(error => error);

      expect(rejection.cause.rollbackFailures).toEqual([
        expect.objectContaining({ kind: 'attribute', element: testElement, error: expect.objectContaining({ message: 'attribute restore failure' }) })
      ]);
      expect(restoreNodeDirectionState).toHaveBeenCalled();
      expect(hoverDeletes).toEqual([first, second]);
    });

    it('preserves multiple direction rollback failures in returned order', async () => {
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: testElement.firstChild, text: 'Hello', uid: 'n1', blockId: 'b1', role: 'div' }
      ]);
      const { restoreNodeDirectionState } = await import('@/utils/dom/DomDirectionManager.js');
      const firstFailure = { kind: 'style', name: 'direction', error: new Error('direction one') };
      const secondFailure = { kind: 'attribute', name: 'data-translate-dir', error: new Error('direction two') };
      restoreNodeDirectionState.mockReturnValueOnce([firstFailure, secondFailure]);
      let streamCallbacks;
      registerTranslation.mockImplementationOnce((_id, callbacks) => { streamCallbacks = callbacks; });
      vi.spyOn(adapter, '_applyTranslationToNode').mockImplementationOnce(() => {
        throw new Error('primary mutation failure');
      });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: true,
      });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }] });
      streamCallbacks.onStreamEnd({ success: true });
      const rejection = await translation.catch(error => error);

      expect(rejection.cause.rollbackFailures).toEqual([firstFailure, secondFailure]);
      expect(rejection.cause.cause).toEqual(expect.objectContaining({ message: 'primary mutation failure' }));
    });

    it('continues later hover rollback when an earlier hover restore fails', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b1', role: 'div' }
      ]);
      let deleteCalls = 0;
      hoverPreviewLookup.delete.mockImplementation(() => {
        deleteCalls++;
        if (deleteCalls === 1) throw new Error('hover restore failure');
      });
      let streamCallbacks;
      registerTranslation.mockImplementationOnce((_id, callbacks) => { streamCallbacks = callbacks; });
      vi.spyOn(adapter, '_applyTranslationToNode')
        .mockImplementationOnce((...args) => DomTranslatorAdapter.prototype._applyTranslationToNode.call(adapter, ...args))
        .mockImplementationOnce(() => { throw new Error('primary mutation failure'); });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: true,
      });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }] });
      streamCallbacks.onStreamEnd({ success: true });
      const rejection = await translation.catch(error => error);

      expect(deleteCalls).toBe(2);
      expect(rejection.cause.rollbackFailures).toEqual([
        expect.objectContaining({ kind: 'hover', node: first, error: expect.objectContaining({ message: 'hover restore failure' }) })
      ]);
      expect(rejection.cause.cause).toEqual(expect.objectContaining({ message: 'primary mutation failure' }));
    });

    it('commits independent parents around a failed middle parent', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      const third = document.createTextNode('C');
      testElement.replaceChildren(first, second, third);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b2', role: 'div' },
        { node: third, text: 'C', uid: 'n3', blockId: 'b3', role: 'div' }
      ]);
      vi.spyOn(adapter, '_applyTranslationToNode')
        .mockImplementationOnce((...args) => DomTranslatorAdapter.prototype._applyTranslationToNode.call(adapter, ...args))
        .mockImplementationOnce(() => { throw new Error('middle parent failed'); })
        .mockImplementationOnce((...args) => DomTranslatorAdapter.prototype._applyTranslationToNode.call(adapter, ...args));
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [
          { t: 'Uno', i: 'n1' },
          { t: 'Dos', i: 'n2' },
          { t: 'Tres', i: 'n3' }
        ],
        conversationAcceptance: true,
      });

      await expect(adapter.translateElement(testElement)).rejects.toThrow('middle parent failed');
      expect(first.nodeValue).toContain('Uno');
      expect(second.nodeValue).toBe('B');
      expect(third.nodeValue).toContain('Tres');

      const accepted = sendRegularMessage.mock.calls
        .map(([message]) => message?.data)
        .filter(data => data?.accepted === true)
        .map(data => data.parentId)
        .sort();
      const rejected = sendRegularMessage.mock.calls
        .map(([message]) => message?.data)
        .filter(data => data?.accepted === false)
        .map(data => data.parentId)
        .sort();
      expect(accepted).toEqual(['b1', 'b3']);
      expect(rejected).toEqual(['b2']);
    });

    it('settles unapplied direct siblings after terminal mutation failure', async () => {
      const nodes = ['A', 'B', 'C'].map(text => document.createTextNode(text));
      testElement.replaceChildren(...nodes);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce(nodes.map((node, index) => ({
        node,
        text: node.nodeValue,
        uid: `n${index + 1}`,
        blockId: `b${index + 1}`,
        role: 'div',
      })));
      vi.spyOn(adapter, '_applyTranslationToNode')
        .mockImplementationOnce(() => { throw new Error('middle parent failed'); })
        .mockImplementationOnce((...args) => DomTranslatorAdapter.prototype._applyTranslationToNode.call(adapter, ...args));
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [
          { t: '', i: 'n1' },
          { t: 'Dos', i: 'n2' },
          { t: 'Tres', i: 'n3' },
        ],
        conversationAcceptance: true,
      });

      await expect(adapter.translateElement(testElement)).rejects.toThrow('middle parent failed');

      expect(nodes[0].nodeValue).toBe('A');
      expect(nodes[1].nodeValue).toBe('B');
      expect(nodes[2].nodeValue).toContain('Tres');
      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === false)
        .map(([message]) => message.data.parentId).sort()).toEqual(['b1', 'b2']);
      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === true)
        .map(([message]) => message.data.parentId)).toEqual(['b3']);
    });

    it('removes introduced direction attributes when original dir was absent and rollback runs', async () => {
      const textNode = testElement.firstChild;
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: textNode, text: 'Hello', uid: 'n1', blockId: 'b1', role: 'div' }
      ]);
      const realDir = await vi.importActual('@/utils/dom/DomDirectionManager.js');
      const { applyNodeDirection, captureNodeDirectionState, restoreNodeDirectionState, detectDirectionFromContent } =
        await import('@/utils/dom/DomDirectionManager.js');
      applyNodeDirection.mockImplementationOnce((node, lang, root) => {
        realDir.applyNodeDirection(node, lang, root);
        throw new Error('direction state introduced before failure');
      });
      captureNodeDirectionState.mockImplementationOnce((node, root) => realDir.captureNodeDirectionState(node, root));
      restoreNodeDirectionState.mockImplementationOnce((snapshots) => realDir.restoreNodeDirectionState(snapshots));
      detectDirectionFromContent.mockReturnValue('rtl');
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'سلام', i: 'n1' }],
        conversationAcceptance: true,
      });

      await expect(adapter.translateElement(testElement)).rejects.toThrow('direction state introduced before failure');
      expect(testElement.hasAttribute('data-translate-dir')).toBe(false);
      expect(testElement.hasAttribute('data-dir-original-saved')).toBe(false);
      expect(testElement.style.direction).toBe('');
      expect(testElement.hasAttribute('dir')).toBe(false);
    });

    it('restores exact inline direction style value and priority on rollback', async () => {
      testElement.style.setProperty('direction', 'ltr', 'important');
      const textNode = testElement.firstChild;
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: textNode, text: 'Hello', uid: 'n1', blockId: 'b1', role: 'div' }
      ]);
      const realDir = await vi.importActual('@/utils/dom/DomDirectionManager.js');
      const { applyNodeDirection, captureNodeDirectionState, restoreNodeDirectionState, detectDirectionFromContent } =
        await import('@/utils/dom/DomDirectionManager.js');
      applyNodeDirection.mockImplementationOnce((node, lang, root) => {
        realDir.applyNodeDirection(node, lang, root);
        throw new Error('style mutation failed');
      });
      captureNodeDirectionState.mockImplementationOnce((node, root) => realDir.captureNodeDirectionState(node, root));
      restoreNodeDirectionState.mockImplementationOnce((snapshots) => realDir.restoreNodeDirectionState(snapshots));
      detectDirectionFromContent.mockReturnValue('rtl');
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'سلام', i: 'n1' }],
        conversationAcceptance: true,
      });

      await expect(adapter.translateElement(testElement)).rejects.toThrow('style mutation failed');
      expect(testElement.style.getPropertyValue('direction')).toBe('ltr');
      expect(testElement.style.getPropertyPriority('direction')).toBe('important');
    });

    it.each([
      ['authentication', 'API_KEY_INVALID'],
      ['network', 'NETWORK_ERROR'],
      ['rate limit', 'RATE_LIMIT_REACHED'],
      ['timeout', 'TRANSLATION_TIMEOUT'],
      ['cancellation', 'USER_CANCELLED'],
    ])('preserves typed %s errors during direct response handling', async (_label, type) => {
      vi.spyOn(adapter, '_applyTranslationToNode').mockImplementation(() => {
        const error = new Error(`${type} failure`);
        error.type = type;
        if (type === 'USER_CANCELLED') error.isCancelled = true;
        throw error;
      });

      const response = {
        success: true,
        streaming: false,
        translatedText: JSON.stringify([{ t: 'Translated', i: 'n1' }]),
      };
      contentScriptIntegration.sendTranslationRequest.mockResolvedValue(response);

      await expect(adapter.translateElement(testElement)).rejects.toMatchObject({
        message: `${type} failure`,
        type,
      });
    });
  });

  describe('cancelTranslation', () => {
    it('invalidates an operation cancelled while initial progress is pending', async () => {
      let releaseProgress;
      const translation = adapter.translateElement(testElement, {
        onProgress: () => new Promise(resolve => { releaseProgress = resolve; }),
      });
      await vi.waitFor(() => expect(releaseProgress).toBeDefined());
      const token = adapter.currentTranslationToken;
      expect(token).toMatchObject({ messageId: null, cancelled: false });

      await adapter.cancelTranslation({ silent: true });
      releaseProgress();

      await expect(translation).resolves.toMatchObject({ success: false, cancelled: true });
      expect(contentScriptIntegration.sendTranslationRequest).not.toHaveBeenCalled();
      expect(testElement.textContent).toBe('Hello');
      expect(adapter.currentTranslationToken).toBeNull();
    });

    it('does not let an old settings wait overwrite a newer operation', async () => {
      const { getSourceLanguageAsync } = await import('@/config.js');
      adapter.originalSettings = null;
      let releaseOldSettings;
      getSourceLanguageAsync
        .mockImplementationOnce(() => new Promise(resolve => { releaseOldSettings = resolve; }))
        .mockResolvedValueOnce('en');
      const old = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(releaseOldSettings).toBeDefined());
      await adapter.cancelTranslation({ silent: true });

      const newerElement = document.createElement('div');
      newerElement.textContent = 'New';
      document.body.appendChild(newerElement);
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true, streaming: false, translatedText: [{ t: 'Nouveau', i: 'n1' }],
      });
      await adapter.translateElement(newerElement);
      const newerSession = adapter.currentSessionId;
      const newerHistory = [...globalSelectElementState.translationHistory];
      releaseOldSettings('stale-source');

      await expect(old).resolves.toMatchObject({ success: false, cancelled: true });
      expect(adapter.currentSessionId).toBe(newerSession);
      expect(adapter.isTranslating).toBe(false);
      expect(globalSelectElementState.translationHistory).toEqual(newerHistory);
      expect(testElement.textContent).toBe('Hello');
    });

    it('locally cancels even when background cancellation throws, then allows explicit revert', async () => {
      let callbacks;
      registerTranslation.mockImplementation((_id, value) => { callbacks = value; });
      contentScriptIntegration.cancelTranslationRequest.mockImplementationOnce(() => { throw new Error('offline'); });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({ success: true, streaming: true });
      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'Hola', i: 'n1' }] });
      await adapter.cancelTranslation({ silent: true });
      const { revertSelectElementTranslation } = await vi.importActual('./DomTranslatorState.js');
      await revertSelectElementTranslation(globalSelectElementState.translationHistory.at(-1).sessionId);
      callbacks.onStreamEnd({ success: true });

      await expect(translation).resolves.toMatchObject({ success: false, cancelled: true });
      expect(testElement.textContent).toBe('Hello');
      expect(adapter.isTranslating).toBe(false);
    });

    it('ignores a late direct V2 response after cancellation', async () => {
      let resolveResponse;
      contentScriptIntegration.sendTranslationRequest.mockImplementation(() => new Promise(resolve => { resolveResponse = resolve; }));
      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(resolveResponse).toBeDefined());
      await adapter.cancelTranslation({ silent: true });
      resolveResponse({ success: true, streaming: false, translatedText: [{ t: 'late', i: 'n1' }] });

      await expect(translation).resolves.toMatchObject({ success: false, cancelled: true });
      expect(testElement.textContent).toBe('Hello');
      expect(globalSelectElementState.translationHistory).toHaveLength(0);
    });

    it('does not let a paused old finalizer alter a newer session', async () => {
      const callbacks = [];
      registerTranslation.mockImplementation((_id, value) => callbacks.push(value));
      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({ success: true, streaming: true });
      let finishOldComplete;
      const old = adapter.translateElement(testElement, {
        onComplete: () => new Promise(resolve => { finishOldComplete = resolve; }),
      });
      await vi.waitFor(() => expect(callbacks).toHaveLength(1));
      callbacks[0].onStreamUpdate({ success: true, data: [{ t: 'Old', i: 'n1' }] });
      callbacks[0].onStreamEnd({ success: true });
      await vi.waitFor(() => expect(finishOldComplete).toBeDefined());

      const newerElement = document.createElement('div');
      newerElement.textContent = 'New';
      document.body.appendChild(newerElement);
      const newer = adapter.translateElement(newerElement);
      await vi.waitFor(() => expect(callbacks).toHaveLength(2));
      const newerSession = adapter.currentSessionId;
      finishOldComplete();
      await expect(old).resolves.toMatchObject({ success: false, cancelled: true });
      expect(adapter.currentSessionId).toBe(newerSession);
      expect(adapter.isTranslating).toBe(true);

      callbacks[1].onStreamUpdate({ success: true, data: [{ t: 'Newer', i: 'n1' }] });
      callbacks[1].onStreamEnd({ success: true });
      await newer;
    });

    it('reverts a partially committed grouped operation before ignoring late V3 results', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValue(true);
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      collectBlockGroups.mockReturnValue([
        { id: 'n1', blockId: 'g1', text: 'A', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: first },
        { id: 'n2', blockId: 'g2', text: 'B', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: second },
      ]);
      let callbacks;
      registerTranslation.mockImplementation((_id, value) => { callbacks = value; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
        success: true, streaming: true, conversationAcceptance: true,
      });
      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1', b: 'g1' }] });
      await vi.waitFor(() => expect(sendRegularMessage).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ parentId: 'g1', accepted: true }) }),
        expect.anything()
      ));
      const acknowledgementsBeforeRevert = sendRegularMessage.mock.calls.length;

      await adapter.revertTranslation();
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'Dos', i: 'n2', b: 'g2' }] });
      callbacks.onStreamEnd({ success: true });
      await expect(translation).resolves.toMatchObject({ success: false, cancelled: true });

      expect(first.nodeValue).toBe('A');
      expect(second.nodeValue).toBe('B');
      expect(globalSelectElementState.translationHistory).toHaveLength(0);
      expect(globalSelectElementState.snapshots.size).toBe(0);
      expect(sendRegularMessage).toHaveBeenCalledTimes(acknowledgementsBeforeRevert);
      getFeatureSemanticBlockGroupingAsync.mockResolvedValue(false);
    });

    it('reverts before the first result without retaining history', async () => {
      let callbacks;
      registerTranslation.mockImplementation((_id, value) => { callbacks = value; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({ success: true, streaming: true });
      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      expect(await adapter.revertTranslation()).toBe(0);
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'late', i: 'n1' }] });
      callbacks.onStreamEnd({ success: true });
      await expect(translation).resolves.toMatchObject({ success: false, cancelled: true });
      expect(testElement.textContent).toBe('Hello');
      expect(globalSelectElementState.translationHistory).toHaveLength(0);
      expect(globalSelectElementState.snapshots.size).toBe(0);
    });

    it('keeps the token cancellable while onError is pending', async () => {
      let releaseError;
      contentScriptIntegration.sendTranslationRequest.mockRejectedValue(new Error('provider failure'));
      const translation = adapter.translateElement(testElement, {
        onError: () => new Promise(resolve => { releaseError = resolve; }),
      });
      await vi.waitFor(() => expect(releaseError).toBeDefined());
      const token = adapter.currentTranslationToken;
      expect(adapter.isCurrentlyTranslating()).toBe(true);
      await adapter.cancelTranslation({ silent: true });
      expect(token.cancelled).toBe(true);
      releaseError();
      await expect(translation).rejects.toMatchObject({ message: 'provider failure' });
      expect(adapter.currentTranslationToken).toBeNull();
    });

    it('should cancel an ongoing translation', async () => {
      adapter.isTranslating = true;
      adapter.currentMessageId = 'test-msg-id';
      
      const cancelSpy = contentScriptIntegration.cancelTranslationRequest;
      
      await adapter.cancelTranslation();
      
      expect(cancelSpy).toHaveBeenCalledWith('test-msg-id', expect.anything());
      expect(adapter.isTranslating).toBe(false);
      expect(adapter.currentMessageId).toBeNull();
    });

    it('should not do anything if not translating', async () => {
      const cancelSpy = contentScriptIntegration.cancelTranslationRequest;
      await adapter.cancelTranslation();
      expect(cancelSpy).not.toHaveBeenCalled();
    });

    it.each(['rejects', 'does not invalidate'])('fails closed when cancellation %s before revert', async (mode) => {
      const { revertSelectElementTranslation } = await import('./DomTranslatorState.js');
      const historyEntry = { sessionId: 'keep-history', element: testElement };
      globalSelectElementState.translationHistory = [historyEntry];
      const token = { messageId: 'active-request', cancelled: false };
      adapter.currentTranslationToken = token;
      adapter.isTranslating = true;
      vi.spyOn(adapter, 'cancelTranslation').mockImplementationOnce(() => {
        if (mode === 'rejects') return Promise.reject(new Error('cancel failed'));
        return Promise.resolve();
      });

      await expect(adapter.revertTranslation()).rejects.toThrow(
        mode === 'rejects' ? 'cancel failed' : 'Cannot revert while translation cancellation is still active'
      );
      expect(revertSelectElementTranslation).not.toHaveBeenCalled();
      expect(globalSelectElementState.translationHistory).toEqual([historyEntry]);
      expect(testElement.textContent).toBe('Hello');
      expect(adapter.currentTranslationToken).toBe(token);
    });

    it('does not let a pending old revert consume a newer operation history', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValue(true);
      collectBlockGroups.mockImplementation(element => [{
        id: 'n1', blockId: 'g1', text: element.textContent, leadingWS: '', trailingWS: '',
        inlineParentTags: ['div'], mode: 'standard', node: element.firstChild,
      }]);
      const callbacks = [];
      registerTranslation.mockImplementation((_id, value) => callbacks.push(value));
      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
        success: true, streaming: true, conversationAcceptance: true,
      });
      const oldTranslation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toHaveLength(1));
      const oldToken = adapter.currentTranslationToken;
      let releaseCancellation;
      vi.spyOn(adapter, 'cancelTranslation').mockImplementationOnce(() => {
        oldToken.cancelled = true;
        adapter._cleanupCurrentSession(false, oldToken);
        return new Promise(resolve => { releaseCancellation = resolve; });
      });
      const oldRevert = adapter.revertTranslation();
      await vi.waitFor(() => expect(releaseCancellation).toBeDefined());

      const newerElement = document.createElement('div');
      newerElement.textContent = 'New';
      document.body.appendChild(newerElement);
      const newTranslation = adapter.translateElement(newerElement);
      await vi.waitFor(() => expect(callbacks).toHaveLength(2));
      const newerToken = adapter.currentTranslationToken;
      const newerSession = newerToken.sessionId;
      callbacks[1].onStreamUpdate({ success: true, data: [{ t: 'Newer', i: 'n1' }] });
      await vi.waitFor(() => expect(globalSelectElementState.translationHistory.some(entry => entry.sessionId === newerSession)).toBe(true));
      const acknowledgements = sendRegularMessage.mock.calls.length;

      callbacks[0].onStreamEnd({ success: true });
      await expect(oldTranslation).resolves.toMatchObject({ success: false, cancelled: true });
      releaseCancellation();
      await expect(oldRevert).rejects.toThrow(/newer translation has started/);
      expect(adapter.currentTranslationToken).toBe(newerToken);
      expect(adapter.currentSessionId).toBe(newerSession);
      expect(newerElement.textContent).toContain('Newer');
      expect(globalSelectElementState.translationHistory.some(entry => entry.sessionId === newerSession)).toBe(true);
      expect(sendRegularMessage).toHaveBeenCalledTimes(acknowledgements);

      callbacks[1].onStreamEnd({ success: true });
      await newTranslation;
      getFeatureSemanticBlockGroupingAsync.mockResolvedValue(false);
    });

    it.each([
      { lateOutcome: 'resolve', networkCancel: 'normal' },
      { lateOutcome: 'reject', networkCancel: 'normal' },
      { lateOutcome: 'resolve', networkCancel: 'throws' },
      { lateOutcome: 'reject', networkCancel: 'throws' },
    ])('settles same-root revert/restart with late $lateOutcome and $networkCancel cancellation', async ({ lateOutcome, networkCancel }) => {
      let settleOldProvider;
      const oldProvider = new Promise((resolve, reject) => {
        settleOldProvider = lateOutcome === 'resolve'
          ? () => resolve({ success: true, streaming: false, translatedText: [{ t: 'stale', i: 'n1' }] })
          : () => reject(new Error('late provider failure'));
      });
      contentScriptIntegration.sendTranslationRequest
        .mockImplementationOnce(() => oldProvider)
        .mockResolvedValueOnce({ success: true, streaming: true });
      if (networkCancel === 'throws') {
        contentScriptIntegration.cancelTranslationRequest.mockImplementationOnce(() => { throw new Error('offline'); });
      }
      const callbacks = [];
      registerTranslation.mockImplementation((_id, value) => callbacks.push(value));
      const oldTranslation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(contentScriptIntegration.sendTranslationRequest).toHaveBeenCalledTimes(1));

      await expect(adapter.revertTranslation()).resolves.toBe(0);
      await expect(oldTranslation).resolves.toMatchObject({ success: false, cancelled: true });
      expect(globalSelectElementState.translationHistory).toHaveLength(0);

      const newTranslation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toHaveLength(2));
      const newToken = adapter.currentTranslationToken;
      callbacks[1].onStreamUpdate({ success: true, data: [{ t: 'fresh', i: 'n1' }] });
      callbacks[1].onStreamEnd({ success: true });
      await expect(newTranslation).resolves.toMatchObject({ success: true });
      const captureHistoryAndOwnership = () => ({
        history: globalSelectElementState.translationHistory.map(entry => ({
          sessionId: entry.sessionId,
          partial: entry.partial,
          units: entry.originalTextNodesData.map(({ node, originalText, appliedText }) => ({ node, originalText, appliedText })),
          ownership: (entry.auxiliaryOwnershipRecords || []).map(record => ({ ...record })),
        })),
        ownership: [...globalSelectElementState.auxiliaryOwnership].map(([key, value]) => [
          key,
          Array.isArray(value) ? value.map(record => ({ ...record })) : value,
        ]),
      });
      const newHistoryAndOwnership = captureHistoryAndOwnership();
      const acknowledgementsAfterB = sendRegularMessage.mock.calls.map(([message, options]) => [
        { ...message, data: message?.data ? { ...message.data } : message?.data },
        options ? { ...options } : options,
      ]);

      settleOldProvider();
      callbacks[0].onStreamUpdate({ success: true, data: [{ t: 'stale callback', i: 'n1' }] });
      callbacks[0].onStreamEnd({ success: true });
      await oldTranslation;

      expect(testElement.textContent).toContain('fresh');
      expect(captureHistoryAndOwnership()).toEqual(newHistoryAndOwnership);
      expect(sendRegularMessage.mock.calls.map(([message, options]) => [
        { ...message, data: message?.data ? { ...message.data } : message?.data },
        options ? { ...options } : options,
      ])).toEqual(acknowledgementsAfterB);
      expect(adapter.currentTranslationToken).toBeNull();
      expect(newToken.cancelled).toBe(false);
    });

    it('clears temporary translated segment state after session cleanup', () => {
      adapter.translatedSegmentMap.set('n1', 'translated');
      adapter.currentTranslationToken = { messageId: 'cleanup' };
      adapter.currentMessageId = 'cleanup';
      adapter.isTranslating = true;

      adapter._cleanupCurrentSession(false, adapter.currentTranslationToken);

      expect(adapter.translatedSegmentMap.size).toBe(0);
    });

    it('ignores late stream updates after cancellation without DOM mutation or ACK', async () => {
      let streamCallbacks;
      registerTranslation.mockImplementation((_id, callbacks) => {
        streamCallbacks = callbacks;
      });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({ success: true, streaming: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      await adapter.cancelTranslation({ silent: true });

      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'late', i: 'n1' }] });
      expect(testElement.textContent).toBe('Hello');
      expect(sendRegularMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ accepted: true })
      }), expect.anything());

      streamCallbacks.onStreamEnd({ success: true });
      await expect(translation).resolves.toMatchObject({ success: false, cancelled: true });
      expect(globalSelectElementState.translationHistory).toHaveLength(0);
    });

    it('preserves committed parents and blocks late DOM/ACK work after conflict-style cancellation', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b2', role: 'div' },
      ]);

      let streamCallbacks;
      registerTranslation.mockImplementationOnce((_id, callbacks) => { streamCallbacks = callbacks; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: true,
        conversationAcceptance: true,
      });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }] });
      await vi.waitFor(() => expect(sendRegularMessage).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ parentId: 'b1', accepted: true }) }),
        { silent: true, timeout: 500 }
      ));
      const acceptedBeforeConflict = sendRegularMessage.mock.calls.filter(([message]) => (
        message?.data?.accepted === true
      ));

      await adapter.cancelTranslation({ silent: true });
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'Dos', i: 'n2' }] });
      streamCallbacks.onStreamEnd({ success: true });

      await expect(translation).resolves.toMatchObject({ success: false, cancelled: true });
      expect(first.nodeValue).toContain('Uno');
      expect(second.nodeValue).toBe('B');
      expect(globalSelectElementState.translationHistory).toHaveLength(1);
      expect(sendRegularMessage.mock.calls.filter(([message]) => message?.data?.accepted === true))
        .toHaveLength(acceptedBeforeConflict.length);
      expect(sendRegularMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ parentId: 'b2' }) }),
        expect.anything()
      );
    });

    it('ignores callbacks from previous session after a new translation starts', async () => {
      const firstElement = testElement;
      const secondElement = document.createElement('div');
      secondElement.textContent = 'Hello';
      document.body.appendChild(secondElement);

      const callbacks = [];
      registerTranslation.mockImplementation((_id, registered) => {
        callbacks.push(registered);
      });
      contentScriptIntegration.sendTranslationRequest
        .mockResolvedValueOnce({ success: true, streaming: true })
        .mockResolvedValueOnce({
          success: true,
          streaming: true
        });

      const firstTranslation = adapter.translateElement(firstElement);
      await vi.waitFor(() => expect(callbacks).toHaveLength(1));
      await adapter.cancelTranslation({ silent: true });

      const secondTranslation = adapter.translateElement(secondElement);
      await vi.waitFor(() => expect(callbacks).toHaveLength(2));
      callbacks[1].onStreamUpdate({ success: true, data: [{ t: 'active', i: 'n1' }] });
      callbacks[1].onStreamEnd({ success: true });
      await secondTranslation;

      callbacks[0].onStreamUpdate({ success: true, conversationAcceptance: true, data: [{ t: 'stale', i: 'n1' }] });
      expect(firstElement.textContent).toBe('Hello');
      expect(secondElement.textContent).toContain('active');
      expect(adapter._conversationAcceptanceEnabled).toBe(false);

      callbacks[0].onStreamEnd({ success: true });
      await firstTranslation;
    });

    it('keeps newer session state when stale session cleanup runs', async () => {
      const firstCallbacks = [];
      registerTranslation.mockImplementation((_id, callbacks) => {
        firstCallbacks.push(callbacks);
      });
      contentScriptIntegration.sendTranslationRequest
        .mockResolvedValueOnce({ success: true, streaming: true })
        .mockResolvedValueOnce({
          success: true,
          streaming: true
        });

      const firstTranslation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(firstCallbacks).toHaveLength(1));
      const firstToken = adapter.currentTranslationToken;
      await adapter.cancelTranslation({ silent: true });

      const secondElement = document.createElement('div');
      secondElement.textContent = 'Hello';
      document.body.appendChild(secondElement);
      const secondTranslation = adapter.translateElement(secondElement);
      await vi.waitFor(() => expect(firstCallbacks).toHaveLength(2));
      firstCallbacks[1].onStreamUpdate({ success: true, data: [{ t: 'active', i: 'n1' }] });
      const secondMessageId = adapter.currentMessageId;
      const secondToken = adapter.currentTranslationToken;

      adapter._cleanupCurrentSession(true, firstToken);

      expect(adapter.currentMessageId).toBe(secondMessageId);
      expect(adapter.currentTranslationToken).toBe(secondToken);
      expect(adapter.isTranslating).toBe(true);
      expect(secondElement.textContent).toContain('active');

      firstCallbacks[0].onStreamEnd({ success: true });
      await firstTranslation;
      firstCallbacks[1].onStreamEnd({ success: true });
      await secondTranslation;
      adapter._cleanupCurrentSession(false, secondToken);
      expect(adapter.isTranslating).toBe(false);
    });
  });

  it('creates one distinct revert session per translated element', async () => {
    const secondElement = document.createElement('div');
    secondElement.textContent = 'World';
    document.body.appendChild(secondElement);
    const { collectTextNodes } = await import('./DomTranslatorUtils.js');
    collectTextNodes
      .mockReturnValueOnce([{ node: testElement.firstChild, text: 'Hello', uid: 'n1', blockId: 'b1', role: 'div' }])
      .mockReturnValueOnce([{ node: secondElement.firstChild, text: 'World', uid: 'n1', blockId: 'b1', role: 'div' }]);
    contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
      success: true,
      streaming: false,
      translatedText: JSON.stringify([{ t: 'Translated', i: 'n1' }])
    });

    await adapter.translateElement(testElement);
    await adapter.translateElement(secondElement);

    const entries = globalSelectElementState.translationHistory.slice(-2);
    expect(entries).toHaveLength(2);
    expect(entries[0].element).toBe(testElement);
    expect(entries[1].element).toBe(secondElement);
    expect(entries[0].sessionId).toBeTruthy();
    expect(entries[1].sessionId).toBeTruthy();
    expect(entries[0].sessionId).not.toBe(entries[1].sessionId);

    document.body.removeChild(secondElement);
  });

  it('captures exact metadata owners for later shadow-safe manual revert', async () => {
    const host = document.createElement('x-host');
    const shadow = host.attachShadow({ mode: 'open' });
    const firstOwner = document.createElement('span');
    const secondOwner = document.createElement('span');
    const firstNode = document.createTextNode('First translated');
    const secondNode = document.createTextNode('Second translated');
    firstOwner.appendChild(firstNode);
    secondOwner.appendChild(secondNode);
    secondOwner.setAttribute('data-has-original', 'existing');
    shadow.append(firstOwner, secondOwner);
    document.body.appendChild(host);

    adapter._storeTranslationState({
      element: host,
      originalTextNodesData: [
        { node: firstNode, originalText: 'First original', blockId: 'v2-parent' },
        { node: secondNode, originalText: 'Second original', blockId: 'v3-parent' },
        { node: firstNode, originalText: 'First original', blockId: 'v2-parent' },
      ],
      sessionId: 'shadow-state',
    });
    adapter.currentSessionId = 'shadow-state';
    adapter._publishCommittedOwnership([
      { node: firstNode, appliedText: firstNode.nodeValue },
      { node: secondNode, appliedText: secondNode.nodeValue },
    ]);
    firstOwner.setAttribute('data-has-original', 'true');
    secondOwner.setAttribute('data-has-original', 'true');

    const entry = globalSelectElementState.translationHistory.at(-1);
    expect(entry.originalMetadataSnapshots).toHaveLength(2);
    expect(entry.originalMetadataSnapshots.map(snapshot => snapshot.element)).toEqual([firstOwner, secondOwner]);
    expect(entry.originalMetadataSnapshots[0].present).toBe(false);
    expect(entry.originalMetadataSnapshots[1]).toMatchObject({ present: true, value: 'existing' });

    const { revertSelectElementTranslation } = await import('./DomTranslatorState.js');
    await revertSelectElementTranslation('shadow-state');

    expect(firstOwner.hasAttribute('data-has-original')).toBe(false);
    expect(secondOwner.getAttribute('data-has-original')).toBe('existing');
    document.body.removeChild(host);
  });

  it('restores connected shadow text in _rollbackBlockGroup and skips detached text', () => {
    const host = document.createElement('x-host');
    const shadow = host.attachShadow({ mode: 'open' });
    const connectedNode = document.createTextNode('Translated connected');
    const detachedNode = document.createTextNode('Translated detached');
    shadow.append(connectedNode, detachedNode);
    document.body.appendChild(host);
    globalSelectElementState.snapshots = new Map([
      ['shadow-session:block', [
        { node: connectedNode, originalText: 'Original connected' },
        { node: detachedNode, originalText: 'Original detached' },
      ]]
    ]);
    shadow.removeChild(detachedNode);

    adapter._rollbackBlockGroup('shadow-session', 'block');

    expect(connectedNode.nodeValue).toBe('Original connected');
    expect(detachedNode.nodeValue).toBe('Translated detached');
    document.body.removeChild(host);
  });

  describe('revertTranslation', () => {
    it('should call revertSelectElementTranslation', async () => {
      const { revertSelectElementTranslation } = await import('./DomTranslatorState.js');
      revertSelectElementTranslation.mockResolvedValue(5);
      
      const count = await adapter.revertTranslation();
      
      expect(count).toBe(5);
      expect(revertSelectElementTranslation).toHaveBeenCalled();
    });
  });

  describe('_handleDirectResponse', () => {
    it('requires canonical parent lifecycle callbacks for direct responses', async () => {
      await expect(adapter._handleDirectResponse(
        {
          success: true,
          translatedText: [{ t: 'Unsafe', i: 'n1' }],
          targetLanguage: 'fa'
        },
        [],
        new Map([['n1', { node: testElement.firstChild, text: 'Hello', uid: 'n1' }]]),
        'fa',
        testElement,
        null,
        null,
        null
      )).rejects.toThrow('canonical parent lifecycle callbacks');
      expect(testElement.textContent).toBe('Hello');
    });
  });

  describe('_commitBlockGroup', () => {
    it('rolls back DOM and exact adapter state when bookkeeping fails before ACK', async () => {
      const { BlockGroupReconstructor } = await import('./BlockGroupReconstructor.js');
      const node = testElement.firstChild;
      const unit = { id: 'n1', blockId: 'g1', text: 'Hello', leadingWS: '', trailingWS: '', node };
      const group = { blockId: 'g1', units: [unit] };
      const reconstruction = BlockGroupReconstructor.apply([unit], 'Translated', 'fa', testElement);
      const rollback = vi.spyOn(reconstruction.transaction, 'rollback');
      const finalize = vi.spyOn(reconstruction.transaction, 'finalize');
      adapter.translatedSegmentMap.set('n1', 'Previous');
      const processedUids = new Set();
      vi.spyOn(processedUids, 'add').mockImplementationOnce(() => {
        throw new Error('bookkeeping failed');
      });

      let failure;
      try {
        adapter._commitBlockGroup(group, reconstruction, 'Translated', processedUids, null);
      } catch (error) {
        failure = error;
      }

      expect(failure.cause).toMatchObject({ message: 'bookkeeping failed' });
      expect(rollback).toHaveBeenCalledOnce();
      expect(finalize).not.toHaveBeenCalled();
      expect(node.nodeValue).toBe('Hello');
      expect(adapter.translatedSegmentMap.get('n1')).toBe('Previous');
      expect(processedUids.has('n1')).toBe(false);
      expect(sendRegularMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ parentId: 'g1', accepted: true })
      }), { silent: true, timeout: 500 });
    });

    it('accepts canonical grouped result when optional shadow refinement fails', async () => {
      const { BlockGroupReconstructor } = await import('./BlockGroupReconstructor.js');
      const node = testElement.firstChild;
      const unit = { id: 'n1', blockId: 'g1', text: 'Hello', leadingWS: '', trailingWS: '', node };
      const group = { blockId: 'g1', isV2Passthrough: false, units: [unit] };
      const reconstruction = BlockGroupReconstructor.apply([unit], 'Translated', 'fa', testElement);
      const rollback = vi.spyOn(reconstruction.transaction, 'rollback');
      const finalize = vi.spyOn(reconstruction.transaction, 'finalize');
      const processedUids = new Set();
      adapter.currentMessageId = 'grouped-refinement';
      adapter._conversationAcceptanceEnabled = true;
      vi.spyOn(BlockGroupReconstructor, 'splitTranslatedBlock').mockImplementationOnce(() => {
        throw new Error('optional refinement failed');
      });

      adapter._commitBlockGroup(group, reconstruction, 'Translated', processedUids, null);

      expect(node.nodeValue).toContain('Translated');
      expect(adapter.translatedSegmentMap.get('n1')).toBe('Translated');
      expect(processedUids.has('n1')).toBe(true);
      expect(rollback).not.toHaveBeenCalled();
      expect(finalize).toHaveBeenCalledOnce();
      expect(sendRegularMessage).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ parentId: 'g1', accepted: true })
      }), { silent: true, timeout: 500 });
    });

    it('skips optional shadow refinement for V2 passthrough groups', async () => {
      const { BlockGroupReconstructor } = await import('./BlockGroupReconstructor.js');
      const node = testElement.firstChild;
      const unit = { id: 'n1', blockId: 'g1', text: 'Hello', leadingWS: '', trailingWS: '', node };
      const group = { blockId: 'g1', isV2Passthrough: true, units: [unit] };
      const reconstruction = BlockGroupReconstructor.apply([unit], 'Translated', 'fa', testElement);
      const split = vi.spyOn(BlockGroupReconstructor, 'splitTranslatedBlock');
      split.mockClear();
      const processedUids = new Set();
      adapter.currentMessageId = 'v2-passthrough';

      adapter._commitBlockGroup(group, reconstruction, 'Translated', processedUids, null);

      expect(split).not.toHaveBeenCalled();
      expect(node.nodeValue).toContain('Translated');
      expect(adapter.translatedSegmentMap.get('n1')).toBe('Translated');
    });
  });

  describe('_applyTranslationToNode', () => {
    it('uses composed dir ancestry for direct shadow BiDi decisions', async () => {
      const host = document.createElement('x-host');
      host.setAttribute('dir', 'rtl');
      const shadow = host.attachShadow({ mode: 'open' });
      const owner = document.createElement('span');
      const textNode = document.createTextNode('Original');
      owner.appendChild(textNode);
      shadow.appendChild(owner);
      document.body.appendChild(host);
      const { detectDirectionFromContent } = await import('@/utils/dom/DomDirectionManager.js');
      detectDirectionFromContent.mockReturnValue('rtl');

      expect(adapter._shouldInjectBidi(textNode, 'Translated')).toBe(false);
      owner.setAttribute('dir', 'ltr');
      expect(adapter._shouldInjectBidi(textNode, 'Translated')).toBe(true);
      document.body.removeChild(host);
    });

    it('uses host direction for direct ShadowRoot text and nested hosts', async () => {
      const outerHost = document.createElement('x-outer');
      outerHost.setAttribute('dir', 'ltr');
      const outerShadow = outerHost.attachShadow({ mode: 'open' });
      const innerHost = document.createElement('x-inner');
      const innerShadow = innerHost.attachShadow({ mode: 'open' });
      const textNode = document.createTextNode('Original');
      innerShadow.appendChild(textNode);
      outerShadow.appendChild(innerHost);
      document.body.appendChild(outerHost);
      const { detectDirectionFromContent } = await import('@/utils/dom/DomDirectionManager.js');
      detectDirectionFromContent.mockReturnValue('rtl');

      expect(adapter._shouldInjectBidi(textNode, 'Translated')).toBe(true);
      outerHost.setAttribute('dir', 'rtl');
      expect(adapter._shouldInjectBidi(textNode, 'Translated')).toBe(false);
      document.body.removeChild(outerHost);
    });

    it('should apply translation with BIDI marks and register for hover preview', () => {
      const textNode = testElement.firstChild;
      const originalText = textNode.textContent;
      
      adapter._applyTranslationToNode(textNode, 'سلام', 'fa', testElement);

      // RTL mark (\u200f) should be present
      expect(textNode.nodeValue).toContain('\u200fسلام\u200f');
      expect(hoverPreviewLookup.add).toHaveBeenCalledWith(textNode, originalText, textNode.nodeValue);
      expect(testElement.getAttribute('data-has-original')).toBe('true');
    });

    it('should apply LRM mark for LTR detection', async () => {
      const { detectDirectionFromContent } = await import('@/utils/dom/DomDirectionManager.js');
      detectDirectionFromContent.mockReturnValue('ltr');

      testElement.setAttribute('dir', 'rtl');

      const textNode = testElement.firstChild;
      adapter._applyTranslationToNode(textNode, 'Hello', 'en', testElement);

      // LRM mark (\u200e) should be present
      expect(textNode.nodeValue).toContain('\u200eHello\u200e');

      testElement.removeAttribute('dir');
      detectDirectionFromContent.mockReturnValue('rtl');
    });

    it('should reject object formatted translated text', () => {
      const textNode = testElement.firstChild;
      adapter._applyTranslationToNode(textNode, { text: 'سلام' }, 'fa', testElement);
      expect(textNode.nodeValue).toBe('Hello');
    });

    it('should preserve original ZWNJ if translation is functionally identical (cleaned ZWNJ)', () => {
      const textNode = testElement.firstChild;
      const originalWithZWNJ = 'می\u200cروم';
      textNode.nodeValue = originalWithZWNJ;
      
      const cleanedFromProvider = 'میروم';
      
      adapter._applyTranslationToNode(textNode, cleanedFromProvider, 'fa', testElement);
      
      // Should return the original text with ZWNJ, and BiDi marks (because it still applies markers)
      // Wait, let's check the code: it re-adds bidiMark
      expect(textNode.nodeValue).toContain(originalWithZWNJ);
      expect(textNode.nodeValue).toContain('\u200c');
    });
  });

  describe('Strategy X Subtree Exclusion and V3 Rollback integration tests', () => {
    it('sends standard V3 units without markers and reconstructs their parent locally', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      const { BlockGroupReconstructor } = await import('./BlockGroupReconstructor.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      const nodes = [document.createTextNode('A'), document.createTextNode('B')];
      testElement.replaceChildren(...nodes);
      collectBlockGroups.mockReturnValueOnce(nodes.map((node, index) => ({
        id: `n${index + 1}`,
        blockId: 'g1',
        text: node.nodeValue,
        leadingWS: '',
        trailingWS: '',
        inlineParentTags: ['span'],
        mode: 'standard',
        node,
      })));
      const injectMarkers = vi.spyOn(BlockGroupReconstructor, 'injectMarkers');
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }],
        conversationAcceptance: true,
      });

      await adapter.translateElement(testElement);

      const request = contentScriptIntegration.sendTranslationRequest.mock.calls[0][0].data;
      expect(JSON.parse(request.text)).toEqual([
        { t: 'A', i: 'n1', b: 'g1', r: 'span', group: 'g1', part: 0 },
        { t: 'B', i: 'n2', b: 'g1', r: 'span', group: 'g1', part: 1 },
      ]);
      expect(request.text).not.toContain('@@TI_SEG_');
      expect(injectMarkers.mock.calls[0][0].map(({ id, text }) => ({ id, text }))).toEqual([
        { id: 'n1', text: 'Uno' },
        { id: 'n2', text: 'Dos' },
      ]);
      expect(nodes.map(node => node.nodeValue)).toEqual(expect.arrayContaining(['\u200fUno\u200f', '\u200fDos\u200f']));
      expect(sendRegularMessage.mock.calls.filter(([message]) => (
        message.data?.parentId === 'g1' && message.data?.accepted === true
      ))).toHaveLength(1);
    });

    it('waits for all standard V3 units across streamed batches before committing', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      const nodes = [document.createTextNode('A'), document.createTextNode('B'), document.createTextNode('C')];
      testElement.replaceChildren(...nodes);
      collectBlockGroups.mockReturnValueOnce(nodes.map((node, index) => ({
        id: `n${index + 1}`,
        blockId: 'g1',
        text: node.nodeValue,
        leadingWS: '',
        trailingWS: '',
        inlineParentTags: ['span'],
        mode: 'standard',
        node,
      })));
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true, conversationAcceptance: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks.onStreamUpdate({
        success: true,
        batchIndex: 0,
        totalBatches: 2,
        data: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }],
      });
      expect(nodes.map(node => node.nodeValue)).toEqual(['A', 'B', 'C']);
      callbacks.onStreamUpdate({
        success: true,
        batchIndex: 1,
        totalBatches: 2,
        data: [{ t: 'Tres', i: 'n3' }],
      });
      callbacks.onStreamEnd({ success: true });
      await translation;

      expect(nodes.map(node => node.nodeValue)).toEqual(expect.arrayContaining(['\u200fUno\u200f', '\u200fDos\u200f', '\u200fTres\u200f']));
      expect(sendRegularMessage.mock.calls.filter(([message]) => (
        message.data?.parentId === 'g1' && message.data?.accepted === true
      ))).toHaveLength(1);
    });

    it('rejects a streamed V3 group before an unexpected item can commit it', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      const nodes = [document.createTextNode('A'), document.createTextNode('B')];
      testElement.replaceChildren(...nodes);
      collectBlockGroups.mockReturnValueOnce(nodes.map((node, index) => ({
        id: `n${index + 1}`,
        blockId: 'g1',
        text: node.nodeValue,
        leadingWS: '',
        trailingWS: '',
        inlineParentTags: ['span'],
        mode: 'standard',
        node,
      })));
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true, conversationAcceptance: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks.onStreamUpdate({
        success: true,
        data: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }, { t: 'Extra', i: 'foreign', b: 'g1' }],
      });
      callbacks.onStreamEnd({ success: true });

      await expect(translation).resolves.toMatchObject({ success: false, committedParentCount: 0, totalParentCount: 1 });
      expect(nodes.map(node => node.nodeValue)).toEqual(['A', 'B']);
      expect(sendRegularMessage.mock.calls.filter(([message]) => (
        message.data?.parentId === 'g1' && message.data?.accepted === false
      ))).toHaveLength(1);
    });

    it.each([
      ['duplicate', [{ t: 'Uno', i: 'n1' }, { t: 'Again', i: 'n1' }, { t: 'Dos', i: 'n2' }]],
      ['missing', [{ t: 'Uno', i: 'n1' }]],
      ['blank', [{ t: 'Uno', i: 'n1' }, { t: '', i: 'n2' }]],
      ['unexpected', [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }, { t: 'Extra', i: 'foreign', b: 'g1' }]],
    ])('leaves a standard V3 parent uncommitted for %s unit output', async (_label, translatedText) => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      const nodes = [document.createTextNode('A'), document.createTextNode('B')];
      testElement.replaceChildren(...nodes);
      collectBlockGroups.mockReturnValueOnce(nodes.map((node, index) => ({
        id: `n${index + 1}`,
        blockId: 'g1',
        text: node.nodeValue,
        leadingWS: '',
        trailingWS: '',
        inlineParentTags: ['span'],
        mode: 'standard',
        node,
      })));
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText,
        conversationAcceptance: true,
      });

      const result = await adapter.translateElement(testElement);

      expect(result).toMatchObject({ success: false, committedParentCount: 0, totalParentCount: 1 });
      expect(nodes.map(node => node.nodeValue)).toEqual(['A', 'B']);
      expect(sendRegularMessage.mock.calls.filter(([message]) => (
        message.data?.parentId === 'g1' && message.data?.accepted === false
      ))).toHaveLength(1);
    });

    it('commits a complete standard V3 sibling when another parent is invalid', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      const nodes = [document.createTextNode('A'), document.createTextNode('B'), document.createTextNode('C')];
      testElement.replaceChildren(...nodes);
      collectBlockGroups.mockReturnValueOnce([
        { id: 'n1', blockId: 'g1', text: 'A', leadingWS: '', trailingWS: '', inlineParentTags: ['span'], mode: 'standard', node: nodes[0] },
        { id: 'n2', blockId: 'g1', text: 'B', leadingWS: '', trailingWS: '', inlineParentTags: ['span'], mode: 'standard', node: nodes[1] },
        { id: 'n3', blockId: 'g2', text: 'C', leadingWS: '', trailingWS: '', inlineParentTags: ['span'], mode: 'standard', node: nodes[2] },
      ]);
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }, { t: '', i: 'n3' }],
        conversationAcceptance: true,
      });

      const result = await adapter.translateElement(testElement);

      expect(result).toMatchObject({ success: true, partial: true, committedParentCount: 1, totalParentCount: 2 });
      expect(nodes[0].nodeValue).toContain('Uno');
      expect(nodes[1].nodeValue).toContain('Dos');
      expect(nodes[2].nodeValue).toBe('C');
      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === true)
        .map(([message]) => message.data.parentId)).toEqual(['g1']);
    });

    it('aggregates shared-block V2 passthrough units into one parent and ACK', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      const nodes = [document.createTextNode('A'), document.createTextNode('B')];
      testElement.replaceChildren(...nodes);
      collectBlockGroups.mockReturnValueOnce(nodes.map((node, index) => ({
        id: `n${index + 1}`,
        blockId: 'g1',
        text: node.nodeValue,
        leadingWS: '',
        trailingWS: '',
        inlineParentTags: ['pre'],
        mode: 'V2_PASSTHROUGH',
        node,
      })));
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }],
        conversationAcceptance: true
      });

      await adapter.translateElement(testElement);

      const request = contentScriptIntegration.sendTranslationRequest.mock.calls[0][0].data;
      expect(JSON.parse(request.text)).toEqual([
        { t: 'A', i: 'n1', b: 'g1', r: 'pre' },
        { t: 'B', i: 'n2', b: 'g1', r: 'pre' },
      ]);
      expect(request.conversationParents).toEqual([{ parentId: 'g1', cleanSource: 'AB' }]);
      expect(nodes[0].nodeValue).toContain('Uno');
      expect(nodes[1].nodeValue).toContain('Dos');
      expect(sendRegularMessage.mock.calls.filter(([message]) => (
        message.data?.parentId === 'g1' && message.data?.accepted === true
      ))).toHaveLength(1);
    });

    it('keeps shared-block V2 passthrough parent original when one result is invalid', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      const nodes = [document.createTextNode('A'), document.createTextNode('B')];
      testElement.replaceChildren(...nodes);
      collectBlockGroups.mockReturnValueOnce(nodes.map((node, index) => ({
        id: `n${index + 1}`,
        blockId: 'g1',
        text: node.nodeValue,
        leadingWS: '',
        trailingWS: '',
        inlineParentTags: ['pre'],
        mode: 'V2_PASSTHROUGH',
        node,
      })));
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Uno', i: 'n1' }, { t: '', i: 'n2' }]
      });

      await adapter.translateElement(testElement);

      expect(nodes.map(node => node.nodeValue)).toEqual(['A', 'B']);
      expect(sendRegularMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ parentId: 'g1', accepted: true })
      }), { silent: true, timeout: 500 });
    });

    it('accepts distinct V2 passthrough block parents independently', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      const nodes = [document.createTextNode('A'), document.createTextNode('B')];
      testElement.replaceChildren(...nodes);
      collectBlockGroups.mockReturnValueOnce(nodes.map((node, index) => ({
        id: `n${index + 1}`,
        blockId: `g${index + 1}`,
        text: node.nodeValue,
        leadingWS: '',
        trailingWS: '',
        inlineParentTags: ['pre'],
        mode: 'V2_PASSTHROUGH',
        node,
      })));
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'Uno', i: 'n1' }, { t: 'Dos', i: 'n2' }],
        conversationAcceptance: true
      });

      await adapter.translateElement(testElement);

      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === true)
        .map(([message]) => message.data.parentId)).toEqual(['g1', 'g2']);
    });

    it('waits for all streamed V2 passthrough units in one block before applying', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      const nodes = [document.createTextNode('A'), document.createTextNode('B')];
      testElement.replaceChildren(...nodes);
      collectBlockGroups.mockReturnValueOnce(nodes.map((node, index) => ({
        id: `n${index + 1}`,
        blockId: 'g1',
        text: node.nodeValue,
        leadingWS: '',
        trailingWS: '',
        inlineParentTags: ['pre'],
        mode: 'V2_PASSTHROUGH',
        node,
      })));
      let callbacks;
      registerTranslation.mockImplementationOnce((_id, registered) => { callbacks = registered; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true, conversationAcceptance: true });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }] });
      expect(nodes.map(node => node.nodeValue)).toEqual(['A', 'B']);
      callbacks.onStreamUpdate({ success: true, data: [{ t: 'Dos', i: 'n2' }] });
      callbacks.onStreamEnd({ success: true });
      await translation;

      expect(nodes[0].nodeValue).toContain('Uno');
      expect(nodes[1].nodeValue).toContain('Dos');
      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === true)).toHaveLength(1);
    });

    it('should reject overlapping concurrent translation requests (Strategy X)', async () => {
      let resolveFirst;
      const firstPromise = new Promise((resolve) => {
        resolveFirst = resolve;
      });

      const { contentScriptIntegration } = await import('@/shared/messaging/core/ContentScriptIntegration.js');
      contentScriptIntegration.sendTranslationRequest.mockImplementationOnce(() => firstPromise);

      const firstCall = adapter.translateElement(testElement);

      const childElement = document.createElement('span');
      testElement.appendChild(childElement);

      await expect(adapter.translateElement(childElement)).rejects.toThrow(
        'Translation already in progress for this element'
      );

      resolveFirst({ success: true, streaming: false });
      await firstCall;
    });

    it('should rollback to original immutable values if pre-apply connection validation fails', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);

      const div = document.createElement('div');
      const span1 = document.createElement('span');
      span1.textContent = 'Hello ';
      const span2 = document.createElement('span');
      span2.textContent = 'world';
      div.appendChild(span1);
      div.appendChild(span2);
      document.body.appendChild(div);

      const unit1 = {
        id: 'n1',
        blockId: 'g1',
        text: 'Hello',
        leadingWS: '',
        trailingWS: ' ',
        preWhitespace: false,
        directionHint: 'ltr',
        inlineParentTags: ['span'],
        mode: 'standard',
        node: span1.firstChild
      };
      const unit2 = {
        id: 'n2',
        blockId: 'g1',
        text: 'world',
        leadingWS: '',
        trailingWS: '',
        preWhitespace: false,
        directionHint: 'ltr',
        inlineParentTags: ['span'],
        mode: 'standard',
        node: span2.firstChild
      };

      collectBlockGroups.mockReturnValueOnce([unit1, unit2]);

      const { contentScriptIntegration } = await import('@/shared/messaging/core/ContentScriptIntegration.js');
      
      let streamCallbacks;
      const { registerTranslation } = await import('@/shared/messaging/core/ContentScriptIntegration.js');
      registerTranslation.mockImplementationOnce((id, callbacks) => {
        streamCallbacks = callbacks;
      });

      contentScriptIntegration.sendTranslationRequest.mockImplementationOnce(async () => {
        setTimeout(() => {
          // Detach one node before applying translation
          span2.firstChild.remove();

          streamCallbacks.onStreamUpdate({
            success: true,
            data: [{ t: 'مرحبا', i: 'n1' }, { t: 'بالعالم', i: 'n2' }]
          });
          streamCallbacks.onStreamEnd({ success: true });
        }, 10);
        return { success: true, streaming: true };
      });

      const result = await adapter.translateElement(div);
      expect(result).toMatchObject({ success: false, committedParentCount: 0, totalParentCount: 1 });
      expect(result.error?.type).toBe(ErrorTypes.NO_ACCEPTED_TRANSLATION_RESULTS);

      expect(span1.firstChild.nodeValue).toBe('Hello ');
    });

    it('keeps a standard V3 parent original when one unit result is missing', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);

      const div = document.createElement('div');
      const span1 = document.createElement('span');
      span1.textContent = 'Hello ';
      const span2 = document.createElement('span');
      span2.textContent = 'world';
      div.appendChild(span1);
      div.appendChild(span2);
      document.body.appendChild(div);

      const unit1 = {
        id: 'n1',
        blockId: 'g1',
        text: 'Hello',
        leadingWS: '',
        trailingWS: ' ',
        preWhitespace: false,
        directionHint: 'ltr',
        inlineParentTags: ['span'],
        mode: 'standard',
        node: span1.firstChild
      };
      const unit2 = {
        id: 'n2',
        blockId: 'g1',
        text: 'world',
        leadingWS: '',
        trailingWS: '',
        preWhitespace: false,
        directionHint: 'ltr',
        inlineParentTags: ['span'],
        mode: 'standard',
        node: span2.firstChild
      };

      collectBlockGroups.mockReturnValueOnce([unit1, unit2]);

      const { contentScriptIntegration } = await import('@/shared/messaging/core/ContentScriptIntegration.js');
      
      let streamCallbacks;
      const { registerTranslation } = await import('@/shared/messaging/core/ContentScriptIntegration.js');
      registerTranslation.mockImplementationOnce((id, callbacks) => {
        streamCallbacks = callbacks;
      });

        contentScriptIntegration.sendTranslationRequest.mockImplementationOnce(async () => {
          setTimeout(() => {
            streamCallbacks.onStreamUpdate({
              success: true,
              data: [{ t: 'مرحبا', i: 'n1' }]
            });
            streamCallbacks.onStreamEnd({ success: true });
        }, 10);
        return { success: true, streaming: true };
      });

      const result = await adapter.translateElement(div);

      expect(result).toMatchObject({ success: false, committedParentCount: 0, totalParentCount: 1 });
      expect(span1.firstChild.nodeValue).toBe('Hello ');
      expect(span2.firstChild.nodeValue).toBe('world');
    });

    it('should run Shadow Mode validation and log debug on perfect equivalence', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);

      const div = document.createElement('div');
      const span1 = document.createElement('span');
      span1.textContent = 'Hello ';
      const span2 = document.createElement('span');
      span2.textContent = 'world';
      div.appendChild(span1);
      div.appendChild(span2);
      document.body.appendChild(div);

      const unit1 = {
        id: 'n1',
        blockId: 'g1',
        text: 'Hello',
        leadingWS: '',
        trailingWS: ' ',
        preWhitespace: false,
        directionHint: 'ltr',
        inlineParentTags: ['span'],
        mode: 'standard',
        node: span1.firstChild
      };
      const unit2 = {
        id: 'n2',
        blockId: 'g1',
        text: 'world',
        leadingWS: '',
        trailingWS: '',
        preWhitespace: false,
        directionHint: 'ltr',
        inlineParentTags: ['span'],
        mode: 'standard',
        node: span2.firstChild
      };

      collectBlockGroups.mockReturnValueOnce([unit1, unit2]);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockImplementationOnce((el) => [
        { node: el.firstChild.firstChild, text: 'Hello', uid: 'n1' },
        { node: el.lastChild.firstChild, text: 'world', uid: 'n2' }
      ]);

      const { contentScriptIntegration } = await import('@/shared/messaging/core/ContentScriptIntegration.js');
      
      let streamCallbacks;
      const { registerTranslation } = await import('@/shared/messaging/core/ContentScriptIntegration.js');
      registerTranslation.mockImplementationOnce((id, callbacks) => {
        streamCallbacks = callbacks;
      });

      contentScriptIntegration.sendTranslationRequest.mockImplementationOnce(async () => {
        setTimeout(() => {
          streamCallbacks.onStreamUpdate({
            success: true,
            data: [{ t: 'مرحبا', i: 'n1' }, { t: 'بالعالم', i: 'n2' }]
          });
          streamCallbacks.onStreamEnd({ success: true });
        }, 10);
        return { success: true, streaming: true };
      });

      const debugSpy = vi.spyOn(adapter.logger, 'debug');

      const result = await adapter.translateElement(div);

      expect(result.success).toBe(true);
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('Reconstruction perfectly validated'));
    });

    it('should run Shadow Mode validation and log error on reconstruction anomaly', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      const { ShadowComparisonEngine } = await import('./ShadowComparisonEngine.js');
      
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      vi.spyOn(ShadowComparisonEngine, 'compare').mockReturnValueOnce({ equivalent: false, reason: 'Mocked anomaly' });

      const div = document.createElement('div');
      const span1 = document.createElement('span');
      span1.textContent = 'Hello ';
      const span2 = document.createElement('span');
      span2.textContent = 'world';
      div.appendChild(span1);
      div.appendChild(span2);
      document.body.appendChild(div);

      const unit1 = {
        id: 'n1',
        blockId: 'g1',
        text: 'Hello',
        leadingWS: '',
        trailingWS: ' ',
        preWhitespace: false,
        directionHint: 'ltr',
        inlineParentTags: ['span'],
        mode: 'standard',
        node: span1.firstChild
      };
      const unit2 = {
        id: 'n2',
        blockId: 'g1',
        text: 'world',
        leadingWS: '',
        trailingWS: '',
        preWhitespace: false,
        directionHint: 'ltr',
        inlineParentTags: ['span'],
        mode: 'standard',
        node: span2.firstChild
      };

      collectBlockGroups.mockReturnValueOnce([unit1, unit2]);

      const { contentScriptIntegration } = await import('@/shared/messaging/core/ContentScriptIntegration.js');
      
      let streamCallbacks;
      const { registerTranslation } = await import('@/shared/messaging/core/ContentScriptIntegration.js');
      registerTranslation.mockImplementationOnce((id, callbacks) => {
        streamCallbacks = callbacks;
      });

      contentScriptIntegration.sendTranslationRequest.mockImplementationOnce(async () => {
        setTimeout(() => {
          streamCallbacks.onStreamUpdate({
            success: true,
            data: [{ t: 'مرحبا', i: 'n1' }, { t: 'بالعالم', i: 'n2' }]
          });
          streamCallbacks.onStreamEnd({ success: true });
        }, 10);
        return { success: true, streaming: true };
      });

      const errorSpy = vi.spyOn(adapter.logger, 'error');

      const resultPromise = adapter.translateElement(div);
      
      await new Promise(resolve => setTimeout(resolve, 5));
      adapter.translatedSegmentMap.set('n1', 'مختلف');

      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Reconstruction anomaly detected'));
    });

    it('should log debug message on non-fatal attribute anomaly', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      const { ShadowComparisonEngine } = await import('./ShadowComparisonEngine.js');
      
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      // Mock equivalent: true but with warnings
      vi.spyOn(ShadowComparisonEngine, 'compare').mockReturnValueOnce({ 
        equivalent: true, 
        reason: null, 
        warnings: ['Mocked attribute mismatch'] 
      });

      const div = document.createElement('div');
      const span1 = document.createElement('span');
      span1.textContent = 'Hello';
      div.appendChild(span1);
      document.body.appendChild(div);

      const unit1 = {
        id: 'n1',
        blockId: 'g1',
        text: 'Hello',
        leadingWS: '',
        trailingWS: '',
        node: span1.firstChild,
        inlineParentTags: ['span']
      };

      collectBlockGroups.mockReturnValueOnce([unit1]);

      const { contentScriptIntegration } = await import('@/shared/messaging/core/ContentScriptIntegration.js');
      const { registerTranslation } = await import('@/shared/messaging/core/ContentScriptIntegration.js');
      
      registerTranslation.mockImplementationOnce((id, callbacks) => {
        setTimeout(() => {
          callbacks.onStreamUpdate({
            success: true,
            data: [{ t: 'مرحبا', i: 'n1' }]
          });
          callbacks.onStreamEnd({ success: true });
        }, 10);
      });

      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });

      const debugSpy = vi.spyOn(adapter.logger, 'debug');
      const errorSpy = vi.spyOn(adapter.logger, 'error');

      await adapter.translateElement(div);

      expect(errorSpy).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('non-fatal attribute changes'));
    });
  });

  describe('Interactive Tag Exclusions', () => {
    it('should reject interactive elements in isValidTextElement', async () => {
      const { isValidTextElement } = await import('@/features/element-selection/utils/elementHelpers.js');
      
      const p = document.createElement('p');
      p.textContent = 'This is valid translatable text.';
      
      const textarea = document.createElement('textarea');
      textarea.value = 'Form input text area.';
      
      const input = document.createElement('input');
      input.value = 'Form input text.';
      
      const select = document.createElement('select');
      const option = document.createElement('option');
      option.textContent = 'Option text';
      select.appendChild(option);
      
      const button = document.createElement('button');
      button.textContent = 'Click me';

      // Mock getComputedStyle for valid check
      const originalGetComputedStyle = window.getComputedStyle;
      window.getComputedStyle = vi.fn().mockReturnValue({
        display: 'block',
        visibility: 'visible',
        opacity: '1'
      });

      try {
        expect(isValidTextElement(p)).toBe(true);
        expect(isValidTextElement(textarea)).toBe(false);
        expect(isValidTextElement(input)).toBe(false);
        expect(isValidTextElement(select)).toBe(false);
        expect(isValidTextElement(button)).toBe(true);
      } finally {
        window.getComputedStyle = originalGetComputedStyle;
      }
    });

    it('suppresses raw V3 fragment events without DOM mutation', async () => {
      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
        success: true,
        streaming: false,
        translatedText: JSON.stringify([{ t: 'Translated fragment', i: 'n1', blockId: 'g1', isV3Fragment: true, parentId: 'g1', fragmentIndex: 0, fragmentCount: 2 }])
      });

      await adapter.translateElement(testElement);

      expect(testElement.textContent).toContain('Hello');
      expect(testElement.textContent).not.toContain('Translated fragment');
    });
  });

  describe('conversation acceptance ACK gating', () => {
    it('A: emits no parent acceptance ACK when conversation acceptance is not registered (streaming)', async () => {
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: true,
        conversationAcceptance: false
      });
      let streamCallbacks;
      registerTranslation.mockImplementationOnce((_id, callbacks) => { streamCallbacks = callbacks; });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'سلام', i: 'n1' }] });
      streamCallbacks.onStreamEnd({ success: true });
      await translation;

      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === true)).toHaveLength(0);
    });

    it('latches acceptance from an early stream update before the request response', async () => {
      let streamCallbacks;
      let resolveRequest;
      registerTranslation.mockImplementationOnce((_id, callbacks) => { streamCallbacks = callbacks; });
      contentScriptIntegration.sendTranslationRequest.mockImplementationOnce(() => new Promise(resolve => {
        resolveRequest = resolve;
      }));

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());

      streamCallbacks.onStreamUpdate({
        success: true,
        conversationAcceptance: true,
        data: [{ t: 'سلام', i: 'n1' }],
      });
      await vi.waitFor(() => expect(
        sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === true)
      ).toHaveLength(1));

      streamCallbacks.onStreamEnd({ success: true });
      resolveRequest({ success: true, streaming: true });

      await expect(translation).resolves.toMatchObject({ success: true });
      expect(adapter._conversationAcceptanceEnabled).toBe(true);
    });

    it('ignores acceptance metadata from a stale final response', async () => {
      const firstElement = testElement;
      const secondElement = document.createElement('div');
      secondElement.textContent = 'Hello';
      document.body.appendChild(secondElement);

      let resolveFirstResponse;
      const firstResponse = new Promise(resolve => { resolveFirstResponse = resolve; });
      const streamCallbacks = [];
      registerTranslation.mockImplementation((_id, callbacks) => { streamCallbacks.push(callbacks); });
      contentScriptIntegration.sendTranslationRequest
        .mockImplementationOnce(() => firstResponse)
        .mockResolvedValueOnce({ success: true, streaming: true });

      const firstTranslation = adapter.translateElement(firstElement);
      await vi.waitFor(() => expect(streamCallbacks).toHaveLength(1));
      await adapter.cancelTranslation({ silent: true });

      const secondTranslation = adapter.translateElement(secondElement);
      await vi.waitFor(() => expect(streamCallbacks).toHaveLength(2));

      resolveFirstResponse({ success: true, streaming: true, conversationAcceptance: true });
      await Promise.resolve();

      expect(adapter._conversationAcceptanceEnabled).toBe(false);

      streamCallbacks[1].onStreamUpdate({ success: true, data: [{ t: 'active', i: 'n1' }] });
      streamCallbacks[1].onStreamEnd({ success: true });
      await expect(secondTranslation).resolves.toMatchObject({ success: true });
      expect(adapter._conversationAcceptanceEnabled).toBe(false);

      streamCallbacks[0].onStreamEnd({ success: true });
      await firstTranslation.catch(() => undefined);
      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === true)).toHaveLength(0);
      secondElement.remove();
    });

    it('A-direct: emits no parent acceptance ACK when conversation acceptance is not registered (direct)', async () => {
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'سلام', i: 'n1' }],
        conversationAcceptance: false
      });

      await adapter.translateElement(testElement);

      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === true)).toHaveLength(0);
    });

    it('B: emits parent acceptance ACK when conversation acceptance is registered', async () => {
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'سلام', i: 'n1' }],
        conversationAcceptance: true
      });

      await adapter.translateElement(testElement);

      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === true)).toHaveLength(1);
    });

    it('C: accepted ACK carries canonical messageId, parentId and clean result', async () => {
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'سلام', i: 'n1' }],
        conversationAcceptance: true
      });

      await adapter.translateElement(testElement);

      const request = contentScriptIntegration.sendTranslationRequest.mock.calls[0][0];
      const ack = sendRegularMessage.mock.calls.find(([message]) => message.data?.accepted === true)[0];
      expect(ack.messageId).toBe(request.messageId);
      expect(ack.data.parentId).toBe('b1');
      expect(ack.data.cleanResult).toBe('سلام');
    });

    it('D: rejection ACK is still emitted when conversation acceptance is registered', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      const { BlockGroupReconstructor } = await import('./BlockGroupReconstructor.js');
      getFeatureSemanticBlockGroupingAsync.mockResolvedValueOnce(true);
      collectBlockGroups.mockReturnValueOnce([
        { id: 'n1', blockId: 'g1', text: 'Hello', leadingWS: '', trailingWS: '', preWhitespace: false, directionHint: 'ltr', inlineParentTags: ['div'], mode: 'standard', node: testElement.firstChild }
      ]);
      vi.spyOn(BlockGroupReconstructor, 'apply').mockImplementationOnce(() => {
        throw new Error('apply failed');
      });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: true,
        conversationAcceptance: true
      });
      let streamCallbacks;
      registerTranslation.mockImplementationOnce((_id, callbacks) => { streamCallbacks = callbacks; });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'سلام', i: 'n1' }] });
      streamCallbacks.onStreamEnd({ success: true });
      const result = await translation;
      expect(result).toMatchObject({ success: false, committedParentCount: 0, totalParentCount: 1 });

      const rejection = sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === false);
      expect(rejection).toHaveLength(1);
      expect(rejection[0][0].data.parentId).toBe('g1');
    });

    it('E: emits exactly one ACK per parent across stream updates', async () => {
      const first = document.createTextNode('A');
      const second = document.createTextNode('B');
      testElement.replaceChildren(first, second);
      const { collectTextNodes } = await import('./DomTranslatorUtils.js');
      collectTextNodes.mockReturnValueOnce([
        { node: first, text: 'A', uid: 'n1', blockId: 'b1', role: 'div' },
        { node: second, text: 'B', uid: 'n2', blockId: 'b1', role: 'div' }
      ]);
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: true,
        conversationAcceptance: true
      });
      let streamCallbacks;
      registerTranslation.mockImplementationOnce((_id, callbacks) => { streamCallbacks = callbacks; });

      const translation = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'Uno', i: 'n1' }] });
      streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'Dos', i: 'n2' }] });
      streamCallbacks.onStreamEnd({ success: true });
      await translation;

      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === true)).toHaveLength(1);
    });

    it('retries transient accepted ACK delivery and awaits success', async () => {
      vi.useFakeTimers();
      try {
        sendRegularMessage
          .mockRejectedValueOnce(new Error('temporary transport failure'))
          .mockResolvedValueOnce({ status: 'ACCEPTED' });
        contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
          success: true,
          streaming: false,
          translatedText: [{ t: 'سلام', i: 'n1' }],
          conversationAcceptance: true
        });

        const translation = adapter.translateElement(testElement);
        await vi.waitFor(() => expect(sendRegularMessage).toHaveBeenCalledTimes(1));
        expect(testElement.textContent).toContain('سلام');
        await vi.advanceTimersByTimeAsync(25);
        await expect(translation).resolves.toMatchObject({ success: true });

        expect(sendRegularMessage).toHaveBeenCalledTimes(2);
        expect(sendRegularMessage.mock.calls[0][0]).toEqual(sendRegularMessage.mock.calls[1][0]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('bounds hung ACK attempts with the ACK-specific timeout', async () => {
      vi.useFakeTimers();
      try {
        isTransientError.mockReturnValue(true);
        sendRegularMessage.mockImplementation((_message, options) => new Promise((_, reject) => {
          expect(options.timeout).toBe(500);
          setTimeout(() => {
            const error = new Error('ACK attempt timed out');
            error.type = ErrorTypes.OPERATION_TIMEOUT;
            reject(error);
          }, options.timeout);
        }));
        contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
          success: true,
          streaming: false,
          translatedText: [{ t: 'سلام', i: 'n1' }],
          conversationAcceptance: true
        });

        const translation = adapter.translateElement(testElement);
        await vi.waitFor(() => expect(sendRegularMessage).toHaveBeenCalledTimes(1));
        await vi.advanceTimersByTimeAsync(500);
        await vi.advanceTimersByTimeAsync(25);
        await vi.advanceTimersByTimeAsync(500);
        await vi.advanceTimersByTimeAsync(50);
        await vi.advanceTimersByTimeAsync(500);
        await expect(translation).resolves.toMatchObject({ success: true });

        expect(sendRegularMessage).toHaveBeenCalledTimes(3);
        expect(testElement.textContent).toContain('سلام');
        expect(adapter._pendingAcceptanceAcks.size).toBe(0);
        expect(adapter._acceptanceAckControllers.size).toBe(0);
      } finally {
        isTransientError.mockReset();
        vi.useRealTimers();
      }
    });

    it('retries streaming parent ACK without delaying DOM commit', async () => {
      vi.useFakeTimers();
      try {
        sendRegularMessage
          .mockRejectedValueOnce(new Error('temporary transport failure'))
          .mockResolvedValueOnce({ status: 'ACCEPTED' });
        contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
          success: true,
          streaming: true,
          conversationAcceptance: true
        });
        let streamCallbacks;
        registerTranslation.mockImplementationOnce((_id, callbacks) => { streamCallbacks = callbacks; });

        const translation = adapter.translateElement(testElement);
        await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
        streamCallbacks.onStreamUpdate({ success: true, data: [{ t: 'سلام', i: 'n1' }] });
        await vi.waitFor(() => expect(sendRegularMessage).toHaveBeenCalledTimes(1));
        expect(testElement.textContent).toContain('سلام');
        streamCallbacks.onStreamEnd({ success: true });
        await vi.advanceTimersByTimeAsync(25);
        await expect(translation).resolves.toMatchObject({ success: true });

        expect(sendRegularMessage).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(['DUPLICATE', 'STALE', 'UNKNOWN_PARENT', 'CONFLICT'])(
      'stops retrying after terminal ACK status %s',
      async (status) => {
        vi.useFakeTimers();
        try {
          sendRegularMessage.mockResolvedValueOnce({ status });
          contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
            success: true,
            streaming: false,
            translatedText: [{ t: 'سلام', i: 'n1' }],
            conversationAcceptance: true
          });

          await adapter.translateElement(testElement);
          await vi.advanceTimersByTimeAsync(1000);

          expect(sendRegularMessage).toHaveBeenCalledOnce();
          expect(testElement.textContent).toContain('سلام');
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it('keeps committed DOM after accepted ACK retry exhaustion', async () => {
      vi.useFakeTimers();
      try {
        sendRegularMessage
          .mockRejectedValueOnce(new Error('transport unavailable'))
          .mockRejectedValueOnce(new Error('transport unavailable'))
          .mockRejectedValueOnce(new Error('transport unavailable'));
        contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
          success: true,
          streaming: false,
          translatedText: [{ t: 'سلام', i: 'n1' }],
          conversationAcceptance: true
        });

        const translation = adapter.translateElement(testElement);
        await vi.waitFor(() => expect(sendRegularMessage).toHaveBeenCalledTimes(1));
        await vi.advanceTimersByTimeAsync(75);
        await expect(translation).resolves.toMatchObject({ success: true });

        expect(sendRegularMessage).toHaveBeenCalledTimes(3);
        expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === false)).toHaveLength(0);
        expect(testElement.textContent).toContain('سلام');
        expect(adapter._pendingAcceptanceAcks.size).toBe(0);
        expect(adapter._acceptanceAckControllers.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops accepted ACK retry when translation is cancelled', async () => {
      vi.useFakeTimers();
      try {
        sendRegularMessage.mockImplementationOnce((_message, options) => new Promise((_, reject) => {
          setTimeout(() => {
            const error = new Error('ACK attempt timed out');
            error.type = ErrorTypes.OPERATION_TIMEOUT;
            reject(error);
          }, options.timeout);
        }));
        contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
          success: true,
          streaming: false,
          translatedText: [{ t: 'سلام', i: 'n1' }],
          conversationAcceptance: true
        });

        const translation = adapter.translateElement(testElement);
        await vi.waitFor(() => expect(sendRegularMessage).toHaveBeenCalledTimes(1));
        await adapter.cancelTranslation({ silent: true });
        await vi.advanceTimersByTimeAsync(500);
        await expect(translation).resolves.toMatchObject({ success: true });

        expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === true)).toHaveLength(1);
        expect(testElement.textContent).toContain('سلام');
        expect(adapter._pendingAcceptanceAcks.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops a timed-out ACK after context invalidation', async () => {
      vi.useFakeTimers();
      try {
        sendRegularMessage.mockImplementation((_message, options) => new Promise((_, reject) => {
          setTimeout(() => {
            const error = new Error('ACK attempt timed out');
            error.type = ErrorTypes.OPERATION_TIMEOUT;
            reject(error);
          }, options.timeout);
        }));
        contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
          success: true,
          streaming: false,
          translatedText: [{ t: 'سلام', i: 'n1' }],
          conversationAcceptance: true
        });

        const translation = adapter.translateElement(testElement);
        await vi.waitFor(() => expect(sendRegularMessage).toHaveBeenCalledTimes(1));
        ExtensionContextManager.isValidSync.mockReturnValue(false);
        adapter.invalidateContext();
        await vi.advanceTimersByTimeAsync(500);
        await expect(translation).resolves.toMatchObject({ success: true });

        expect(sendRegularMessage).toHaveBeenCalledTimes(1);
        expect(testElement.textContent).toContain('سلام');
        expect(adapter._pendingAcceptanceAcks.size).toBe(0);
        expect(adapter._acceptanceAckControllers.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('F: resets acceptance state between consecutive operations', async () => {
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'سلام', i: 'n1' }],
        conversationAcceptance: true
      });
      await adapter.translateElement(testElement);
      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === true)).toHaveLength(1);

      const secondElement = document.createElement('div');
      secondElement.textContent = 'Hello';
      document.body.appendChild(secondElement);
      vi.clearAllMocks();
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({
        success: true,
        streaming: false,
        translatedText: [{ t: 'مرحبا', i: 'n1' }]
      });
      await adapter.translateElement(secondElement);

      expect(sendRegularMessage.mock.calls.filter(([message]) => message.data?.accepted === true)).toHaveLength(0);
    });
  });

  describe('V3 grouped-unit lifecycle regression', () => {
    beforeEach(() => {
      globalSelectElementState.translationHistory = [];
      globalSelectElementState.snapshots = new Map();
      globalSelectElementState.auxiliaryOwnership = new Map();
      globalSelectElementState.auxiliaryInvalidations = new Map();
      globalSelectElementState.currentTranslation = null;
      document.body.innerHTML = '';
      document.body.appendChild(testElement);
      testElement.textContent = 'Hello';
      contentScriptIntegration.sendTranslationRequest.mockReset();
      registerTranslation.mockReset();
      sendRegularMessage.mockReset();
    });

    it('successful streamed V3 parent marks group.applied true', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      getFeatureSemanticBlockGroupingAsync.mockReset();
      collectBlockGroups.mockReset();
      getFeatureSemanticBlockGroupingAsync.mockResolvedValue(true);
      const n1 = document.createTextNode('Hello ');
      const n2 = document.createTextNode('world');
      testElement.replaceChildren(n1, n2);
      collectBlockGroups.mockReturnValueOnce([
        { id: 'n1', blockId: 'g1', text: 'Hello ', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n1 },
        { id: 'n2', blockId: 'g1', text: 'world', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n2 },
      ]);
      let cb;
      registerTranslation.mockImplementationOnce((_id, callbacks) => { cb = callbacks; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });
      const p = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(cb).toBeDefined());
      cb.onStreamUpdate({ success: true, data: [{ t: 'سلام ', i: 'n1' }, { t: 'دنیا', i: 'n2' }] });
      cb.onStreamEnd({ success: true });
      const result = await p;
      expect(result).toMatchObject({ success: true, committedParentCount: 1, totalParentCount: 1, partial: false });
      expect(adapter.groupMap.get('g1').applied).toBe(true);
      expect(n1.nodeValue).toContain('سلام');
      expect(n2.nodeValue).toContain('دنیا');
    });

    it('multi-parent streamed V3 commits all parents', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      getFeatureSemanticBlockGroupingAsync.mockReset();
      collectBlockGroups.mockReset();
      getFeatureSemanticBlockGroupingAsync.mockResolvedValue(true);
      const n1 = document.createTextNode('A');
      const n2 = document.createTextNode('B');
      const n3 = document.createTextNode('C');
      testElement.replaceChildren(n1, n2, n3);
      collectBlockGroups.mockReturnValueOnce([
        { id: 'n1', blockId: 'g1', text: 'A', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n1 },
        { id: 'n2', blockId: 'g1', text: 'B', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n2 },
        { id: 'n3', blockId: 'g2', text: 'C', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n3 },
      ]);
      let cb;
      registerTranslation.mockImplementationOnce((_id, callbacks) => { cb = callbacks; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });
      const p = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(cb).toBeDefined());
      cb.onStreamUpdate({ success: true, data: [{ t: 'TA', i: 'n1' }, { t: 'TB', i: 'n2' }, { t: 'TC', i: 'n3' }] });
      cb.onStreamEnd({ success: true });
      const result = await p;
      expect(result).toMatchObject({ success: true, committedParentCount: 2, totalParentCount: 2, partial: false });
      expect(adapter.groupMap.get('g1').applied).toBe(true);
      expect(adapter.groupMap.get('g2').applied).toBe(true);
    });

    it('commit failure keeps group.applied false', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      getFeatureSemanticBlockGroupingAsync.mockReset();
      collectBlockGroups.mockReset();
      getFeatureSemanticBlockGroupingAsync.mockResolvedValue(true);
      const n1 = document.createTextNode('Hello ');
      const n2 = document.createTextNode('world');
      testElement.replaceChildren(n1, n2);
      collectBlockGroups.mockReturnValueOnce([
        { id: 'n1', blockId: 'g1', text: 'Hello ', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n1 },
        { id: 'n2', blockId: 'g1', text: 'world', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n2 },
      ]);
      const commitSpy = vi.spyOn(adapter, '_commitBlockGroup').mockImplementation(() => { throw new Error('commit failed'); });
      let cb;
      registerTranslation.mockImplementationOnce((_id, callbacks) => { cb = callbacks; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });
      const p = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(cb).toBeDefined());
      cb.onStreamUpdate({ success: true, data: [{ t: 'سلام ', i: 'n1' }, { t: 'دنیا', i: 'n2' }] });
      cb.onStreamEnd({ success: true });
      const result = await p;
      expect(result).toMatchObject({ success: false, committedParentCount: 0, totalParentCount: 1 });
      expect(adapter.groupMap.get('g1').applied).toBe(false);
      expect(adapter.groupMap.get('g1').invalid).toBe(true);
      expect(n1.nodeValue).toBe('Hello ');
      expect(n2.nodeValue).toBe('world');
      commitSpy.mockRestore();
    });

    it('revert state survives successful grouped translation', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      const { revertSelectElementTranslation } = await vi.importActual('./DomTranslatorState.js');
      getFeatureSemanticBlockGroupingAsync.mockReset();
      collectBlockGroups.mockReset();
      contentScriptIntegration.sendTranslationRequest.mockReset();
      registerTranslation.mockReset();
      sendRegularMessage.mockReset();
      getFeatureSemanticBlockGroupingAsync.mockResolvedValue(true);
      const n1 = document.createTextNode('Hello ');
      const n2 = document.createTextNode('world');
      testElement.replaceChildren(n1, n2);
      collectBlockGroups.mockReturnValue([
        { id: 'n1', blockId: 'g1', text: 'Hello ', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n1 },
        { id: 'n2', blockId: 'g1', text: 'world', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n2 },
      ]);
      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
        success: true, streaming: false, translatedText: [{ t: 'سلام ', i: 'n1' }, { t: 'دنیا', i: 'n2' }]
      });
      const result = await adapter.translateElement(testElement);
      expect(result.success).toBe(true);
      expect(result.committedParentCount).toBe(1);
      const entry = globalSelectElementState.translationHistory.at(-1);
      expect(entry.sessionId).toBe(adapter.currentSessionId);
      expect(entry.originalTextNodesData.some(s => s.appliedText?.includes('سلام'))).toBe(true);
      const reverted = await revertSelectElementTranslation(entry.sessionId);
      expect(reverted).toBeGreaterThan(0);
      expect(n1.nodeValue).toBe('Hello ');
      expect(n2.nodeValue).toBe('world');
    });

    it('partial sibling retains committed ownership and revert', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      const { revertSelectElementTranslation } = await vi.importActual('./DomTranslatorState.js');
      getFeatureSemanticBlockGroupingAsync.mockReset();
      collectBlockGroups.mockReset();
      contentScriptIntegration.sendTranslationRequest.mockReset();
      registerTranslation.mockReset();
      sendRegularMessage.mockReset();
      getFeatureSemanticBlockGroupingAsync.mockResolvedValue(true);
      const n1 = document.createTextNode('A');
      const n2 = document.createTextNode('B');
      const n3 = document.createTextNode('C');
      testElement.replaceChildren(n1, n2, n3);
      collectBlockGroups.mockReturnValue([
        { id: 'n1', blockId: 'g1', text: 'A', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n1 },
        { id: 'n2', blockId: 'g1', text: 'B', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n2 },
        { id: 'n3', blockId: 'g2', text: 'C', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n3 },
      ]);
      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
        success: true, streaming: false, translatedText: [{ t: 'TA', i: 'n1' }, { t: 'TB', i: 'n2' }, { t: '', i: 'n3' }]
      });
      const result = await adapter.translateElement(testElement);
      expect(result).toMatchObject({ success: true, partial: true, committedParentCount: 1, totalParentCount: 2 });
      expect(adapter.groupMap.get('g1').applied).toBe(true);
      expect(adapter.groupMap.get('g2').applied).toBe(false);
      expect(n1.nodeValue).toContain('TA');
      expect(n3.nodeValue).toBe('C');
      const entry = globalSelectElementState.translationHistory.at(-1);
      expect(entry.originalTextNodesData.filter(s => typeof s.appliedText === 'string').some(s => s.appliedText.includes('TA'))).toBe(true);
      const reverted = await revertSelectElementTranslation(entry.sessionId);
      expect(reverted).toBeGreaterThan(0);
      expect(n1.nodeValue).toBe('A');
      expect(n2.nodeValue).toBe('B');
    });
  });

  describe('V3 grouped-unit partial application fix', () => {
    beforeEach(() => {
      globalSelectElementState.translationHistory = [];
      globalSelectElementState.snapshots = new Map();
      globalSelectElementState.auxiliaryOwnership = new Map();
      globalSelectElementState.auxiliaryInvalidations = new Map();
      globalSelectElementState.currentTranslation = null;
      document.body.innerHTML = '';
      document.body.appendChild(testElement);
      testElement.textContent = 'Hello';
      contentScriptIntegration.sendTranslationRequest.mockReset();
      registerTranslation.mockReset();
      sendRegularMessage.mockReset();
    });

    it('unknown result does not poison siblings', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      getFeatureSemanticBlockGroupingAsync.mockReset();
      collectBlockGroups.mockReset();
      getFeatureSemanticBlockGroupingAsync.mockResolvedValue(true);
      const n1 = document.createTextNode('A');
      const n2 = document.createTextNode('B');
      const n3 = document.createTextNode('C');
      testElement.replaceChildren(n1, n2, n3);
      collectBlockGroups.mockReturnValue([
        { id: 'n1', blockId: 'g1', text: 'A', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n1 },
        { id: 'n2', blockId: 'g2', text: 'B', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n2 },
        { id: 'n3', blockId: 'g3', text: 'C', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n3 },
      ]);
      let cb;
      registerTranslation.mockImplementationOnce((_id, c) => { cb = c; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });
      const p = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(cb).toBeDefined());
      // First update: one unknown (no i/b/group) – should only log, not invalidate g1,g2,g3
      cb.onStreamUpdate({ success: true, data: [{ t: 'unknown', id: 'unknown_id' }] });
      expect(adapter.groupMap.get('g1').invalid).toBe(false);
      expect(adapter.groupMap.get('g2').invalid).toBe(false);
      expect(adapter.groupMap.get('g3').invalid).toBe(false);
      // Later valid for all 3
      cb.onStreamUpdate({ success: true, data: [{ t: 'TA', i: 'n1', b: 'g1' }, { t: 'TB', i: 'n2', b: 'g2' }, { t: 'TC', i: 'n3', b: 'g3' }] });
      cb.onStreamEnd({ success: true });
      const result = await p;
      expect(result).toMatchObject({ success: true, committedParentCount: 3, totalParentCount: 3 });
      expect(adapter.groupMap.get('g1').applied).toBe(true);
      expect(globalSelectElementState.translationHistory.length).toBe(1);
      expect(globalSelectElementState.translationHistory[0].originalTextNodesData.filter(s=>s.appliedText).length).toBe(3);
    });

    it('large parent across multiple stream updates commits after final unit', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      getFeatureSemanticBlockGroupingAsync.mockReset();
      collectBlockGroups.mockReset();
      getFeatureSemanticBlockGroupingAsync.mockResolvedValue(true);
      const nodes = Array.from({ length: 50 }, (_, i) => document.createTextNode(`t${i}`));
      testElement.replaceChildren(...nodes);
      const units = nodes.map((node, idx) => {
        let blockId;
        if (idx < 20) blockId = 'g_big';
        else if (idx < 35) blockId = 'g2';
        else blockId = 'g3';
        return { id: `n${idx}`, blockId, text: `t${idx}`, leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node };
      });
      collectBlockGroups.mockReturnValue(units);
      let cb;
      registerTranslation.mockImplementationOnce((_id, c) => { cb = c; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });
      const p = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(cb).toBeDefined());
      // Out of order: send g2/g3 first, then g_big parts out of order
      const bigUnits = units.filter(u=>u.blockId==='g_big');
      // Batch1: first 10 of g_big
      cb.onStreamUpdate({ success: true, data: bigUnits.slice(0,10).map(u=>({ t:`TA${u.id}`, i:u.id, b:u.blockId })) });
      expect(adapter.groupMap.get('g_big').applied).toBe(false);
      // Batch2: g2 and g3 (siblings)
      const g2g3 = units.filter(u=>u.blockId!=='g_big');
      cb.onStreamUpdate({ success: true, data: g2g3.map(u=>({ t:`TA${u.id}`, i:u.id, b:u.blockId })) });
      expect(adapter.groupMap.get('g2').applied).toBe(true);
      expect(adapter.groupMap.get('g3').applied).toBe(true);
      expect(adapter.groupMap.get('g_big').applied).toBe(false);
      // Batch3: remaining 10 of g_big out of order (reverse)
      cb.onStreamUpdate({ success: true, data: bigUnits.slice(10,20).reverse().map(u=>({ t:`TA${u.id}`, i:u.id, b:u.blockId })) });
      expect(adapter.groupMap.get('g_big').applied).toBe(true);
      cb.onStreamEnd({ success: true });
      const result = await p;
      expect(result).toMatchObject({ success: true, committedParentCount: 3, totalParentCount: 3, partial: false });
      expect(nodes.filter(n=>n.nodeValue.includes('TA')).length).toBe(50);
    });

    it('one parent-local commit failure with pending siblings continues', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      getFeatureSemanticBlockGroupingAsync.mockReset();
      collectBlockGroups.mockReset();
      getFeatureSemanticBlockGroupingAsync.mockResolvedValue(true);
      const n1 = document.createTextNode('A');
      const n2 = document.createTextNode('B');
      const n3 = document.createTextNode('C');
      testElement.replaceChildren(n1, n2, n3);
      collectBlockGroups.mockReturnValue([
        { id: 'n1', blockId: 'g1', text: 'A', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n1 },
        { id: 'n2', blockId: 'g2', text: 'B', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n2 },
        { id: 'n3', blockId: 'g3', text: 'C', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n3 },
      ]);
      const orig = adapter._commitBlockGroup.bind(adapter);
      const spy = vi.spyOn(adapter, '_commitBlockGroup').mockImplementation((group, ...args) => {
        if (group.blockId === 'g1') throw new Error('commit failed g1');
        return orig(group, ...args);
      });
      let cb;
      registerTranslation.mockImplementationOnce((_id, c) => { cb = c; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });
      const p = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(cb).toBeDefined());
      // Same update contains g1 failure + valid siblings after
      cb.onStreamUpdate({ success: true, data: [{ t: 'TA', i: 'n1', b: 'g1' }, { t: 'TB', i: 'n2', b: 'g2' }, { t: 'TC', i: 'n3', b: 'g3' }] });
      // Should have processed g2,g3 despite g1 failure
      expect(adapter.groupMap.get('g1').invalid).toBe(true);
      expect(adapter.groupMap.get('g1').applied).toBe(false);
      // g2,g3 should be applied (since same batch, after failure we continue)
      expect(adapter.groupMap.get('g2').applied).toBe(true);
      expect(adapter.groupMap.get('g3').applied).toBe(true);
      cb.onStreamEnd({ success: true });
      const result = await p;
      expect(result).toMatchObject({ success: true, partial: true, committedParentCount: 2, totalParentCount: 3 });
      spy.mockRestore();
    });

    it('later batches after one parent failure still commit', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      getFeatureSemanticBlockGroupingAsync.mockReset();
      collectBlockGroups.mockReset();
      getFeatureSemanticBlockGroupingAsync.mockResolvedValue(true);
      const n1 = document.createTextNode('A');
      const n2 = document.createTextNode('B');
      const n3 = document.createTextNode('C');
      const n4 = document.createTextNode('D');
      testElement.replaceChildren(n1, n2, n3, n4);
      collectBlockGroups.mockReturnValue([
        { id: 'n1', blockId: 'g1', text: 'A', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n1 },
        { id: 'n2', blockId: 'g1', text: 'B', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n2 },
        { id: 'n3', blockId: 'g2', text: 'C', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n3 },
        { id: 'n4', blockId: 'g2', text: 'D', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n4 },
      ]);
      const orig = adapter._commitBlockGroup.bind(adapter);
      const spy = vi.spyOn(adapter, '_commitBlockGroup').mockImplementation((group, ...args) => {
        if (group.blockId === 'g1') throw new Error('fail g1');
        return orig(group, ...args);
      });
      let cb;
      registerTranslation.mockImplementationOnce((_id, c) => { cb = c; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });
      const p = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(cb).toBeDefined());
      // Batch1: completes g1 (fails) but g2 only partially (1/2 units)
      cb.onStreamUpdate({ success: true, data: [{ t: 'TA', i: 'n1', b: 'g1' }, { t: 'TB', i: 'n2', b: 'g1' }, { t: 'TC', i: 'n3', b: 'g2' }] });
      expect(adapter.groupMap.get('g1').invalid).toBe(true);
      expect(adapter.groupMap.get('g2').applied).toBe(false);
      // Batch2: completes g2
      cb.onStreamUpdate({ success: true, data: [{ t: 'TD', i: 'n4', b: 'g2' }] });
      expect(adapter.groupMap.get('g2').applied).toBe(true);
      cb.onStreamEnd({ success: true });
      const result = await p;
      expect(result).toMatchObject({ success: true, partial: true, committedParentCount: 1, totalParentCount: 2 });
      spy.mockRestore();
    });

    it('terminal settlement only at onStreamEnd', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      getFeatureSemanticBlockGroupingAsync.mockReset();
      collectBlockGroups.mockReset();
      getFeatureSemanticBlockGroupingAsync.mockResolvedValue(true);
      const n1 = document.createTextNode('A');
      const n2 = document.createTextNode('B');
      testElement.replaceChildren(n1, n2);
      collectBlockGroups.mockReturnValue([
        { id: 'n1', blockId: 'g1', text: 'A', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n1 },
        { id: 'n2', blockId: 'g2', text: 'B', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n2 },
      ]);
      let cb;
      registerTranslation.mockImplementationOnce((_id, c) => { cb = c; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });
      const p = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(cb).toBeDefined());
      // Only g1 completes, g2 remains pending
      cb.onStreamUpdate({ success: true, data: [{ t: 'TA', i: 'n1', b: 'g1' }] });
      expect(adapter.groupMap.get('g1').applied).toBe(true);
      expect(adapter.groupMap.get('g2').invalid).toBe(false);
      expect(adapter.groupMap.get('g2').applied).toBe(false);
      // Not yet terminal, so g2 should stay not invalid
      cb.onStreamEnd({ success: true });
      const result = await p;
      expect(result).toMatchObject({ success: true, partial: true, committedParentCount: 1, totalParentCount: 2 });
      expect(adapter.groupMap.get('g1').applied).toBe(true);
      expect(adapter.groupMap.get('g2').invalid).toBe(true);
    });

    it('revert after partial success retains committed ownership', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      const { revertSelectElementTranslation } = await vi.importActual('./DomTranslatorState.js');
      getFeatureSemanticBlockGroupingAsync.mockReset();
      collectBlockGroups.mockReset();
      contentScriptIntegration.sendTranslationRequest.mockReset();
      registerTranslation.mockReset();
      sendRegularMessage.mockReset();
      getFeatureSemanticBlockGroupingAsync.mockResolvedValue(true);
      const n1 = document.createTextNode('A');
      const n2 = document.createTextNode('B');
      const n3 = document.createTextNode('C');
      testElement.replaceChildren(n1, n2, n3);
      collectBlockGroups.mockReturnValue([
        { id: 'n1', blockId: 'g1', text: 'A', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n1 },
        { id: 'n2', blockId: 'g1', text: 'B', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n2 },
        { id: 'n3', blockId: 'g2', text: 'C', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n3 },
      ]);
      contentScriptIntegration.sendTranslationRequest.mockResolvedValue({
        success: true, streaming: false, translatedText: [{ t: 'TA', i: 'n1' }, { t: 'TB', i: 'n2' }, { t: '', i: 'n3' }]
      });
      const result = await adapter.translateElement(testElement);
      expect(result.partial).toBe(true);
      expect(result.committedParentCount).toBe(1);
      const entry = globalSelectElementState.translationHistory.at(-1);
      expect(entry.originalTextNodesData.filter(s=>s.appliedText).some(s=>s.appliedText.includes('TA'))).toBe(true);
      const reverted = await revertSelectElementTranslation(entry.sessionId);
      expect(reverted).toBeGreaterThan(0);
      expect(n1.nodeValue).toBe('A');
      expect(n2.nodeValue).toBe('B');
      expect(n3.nodeValue).toBe('C');
    });

    it('systemic error still aborts operation', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      getFeatureSemanticBlockGroupingAsync.mockReset();
      collectBlockGroups.mockReset();
      getFeatureSemanticBlockGroupingAsync.mockResolvedValue(true);
      const n1 = document.createTextNode('Hello ');
      const n2 = document.createTextNode('world');
      testElement.replaceChildren(n1, n2);
      collectBlockGroups.mockReturnValue([
        { id: 'n1', blockId: 'g1', text: 'Hello ', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n1 },
        { id: 'n2', blockId: 'g1', text: 'world', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n2 },
      ]);
      let cb;
      registerTranslation.mockImplementationOnce((_id, c) => { cb = c; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });
      const p = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(cb).toBeDefined());
      // Systemic via cancellation
      await adapter.cancelTranslation({ silent: true });
      cb.onStreamUpdate({ success: true, data: [{ t: 'TA', i: 'n1', b: 'g1' }] });
      cb.onStreamEnd({ success: true });
      await expect(p).resolves.toMatchObject({ success: false, cancelled: true });
      expect(n1.nodeValue).toBe('Hello ');
      expect(globalSelectElementState.translationHistory).toHaveLength(0);
      expect(sendRegularMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: expect.anything(), data: expect.objectContaining({ accepted: true }) }),
        expect.anything()
      );
    });

    it('operationAborted propagates as systemic not parent-local', async () => {
      const { getFeatureSemanticBlockGroupingAsync } = await import('@/config.js');
      const { collectBlockGroups } = await import('./DomTranslatorUtils.js');
      const { ErrorTypes } = await import('@/shared/error-management/ErrorTypes.js');
      getFeatureSemanticBlockGroupingAsync.mockReset();
      collectBlockGroups.mockReset();
      getFeatureSemanticBlockGroupingAsync.mockResolvedValue(true);
      const n1 = document.createTextNode('A');
      const n2 = document.createTextNode('B');
      const n3 = document.createTextNode('C');
      testElement.replaceChildren(n1, n2, n3);
      collectBlockGroups.mockReturnValue([
        { id: 'n1', blockId: 'g1', text: 'A', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n1 },
        { id: 'n2', blockId: 'g2', text: 'B', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n2 },
        { id: 'n3', blockId: 'g3', text: 'C', leadingWS: '', trailingWS: '', inlineParentTags: ['div'], mode: 'standard', node: n3 },
      ]);
      const operationAbortedError = Object.assign(new Error('Translation operation aborted'), {
        operationAborted: true,
        cancellationReason: 'lifecycle-cleanup',
        type: ErrorTypes.TRANSLATION_ERROR,
      });
      const orig = adapter._commitBlockGroup.bind(adapter);
      const spy = vi.spyOn(adapter, '_commitBlockGroup').mockImplementation((group, ...args) => {
        if (group.blockId === 'g1') throw operationAbortedError;
        return orig(group, ...args);
      });
      let cb;
      registerTranslation.mockImplementationOnce((_id, c) => { cb = c; });
      contentScriptIntegration.sendTranslationRequest.mockResolvedValueOnce({ success: true, streaming: true });
      const p = adapter.translateElement(testElement);
      await vi.waitFor(() => expect(cb).toBeDefined());
      // Same update contains g1 (will abort) + g2,g3 after – g2,g3 must NOT be processed
      cb.onStreamUpdate({ success: true, data: [{ t: 'TA', i: 'n1', b: 'g1' }, { t: 'TB', i: 'n2', b: 'g2' }, { t: 'TC', i: 'n3', b: 'g3' }] });
      cb.onStreamEnd({ success: true });
      await expect(p).rejects.toMatchObject({
        operationAborted: true,
        cancellationReason: 'lifecycle-cleanup',
        type: ErrorTypes.TRANSLATION_ERROR,
      });
      // Verify not parent-local partial: g2,g3 should not have committed
      expect(adapter.groupMap.get('g1').applied).toBe(false);
      expect(adapter.groupMap.get('g2').applied).toBe(false);
      expect(adapter.groupMap.get('g3').applied).toBe(false);
      expect(n2.nodeValue).toBe('B');
      expect(n3.nodeValue).toBe('C');
      // Verify not mapped to USER_CANCELLED
      await expect(p.catch(e=>e)).resolves.toMatchObject({ type: expect.not.stringContaining(ErrorTypes.USER_CANCELLED) });
      spy.mockRestore();
    });
  });
});
