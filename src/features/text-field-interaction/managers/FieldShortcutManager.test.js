import { describe, it, expect, vi, beforeEach } from 'vitest';

// 1. Mock dependencies FIRST
vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {
      id: 'test-id'
    },
    storage: {
      local: {
        get: vi.fn(),
        set: vi.fn(),
        remove: vi.fn(),
        clear: vi.fn()
      }
    }
  }
}));

const {
  mockTranslateFieldViaSmartHandler,
  mockIsFieldTranslationRequestError,
  mockGetFieldTranslationErrorPresentation,
  errorHandler,
} = vi.hoisted(() => ({
  mockTranslateFieldViaSmartHandler: vi.fn(() => Promise.resolve()),
  mockIsFieldTranslationRequestError: vi.fn(() => false),
  mockGetFieldTranslationErrorPresentation: vi.fn(),
  errorHandler: { handle: vi.fn(() => Promise.resolve()) },
}));

// Mock dependencies
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    init: vi.fn()
  }))
}));

vi.mock('@/shared/error-management/ErrorHandler.js', () => ({
  ErrorHandler: {
    getInstance: vi.fn(() => errorHandler),
  },
}));

vi.mock('@/shared/managers/SettingsManager.js', () => ({
  settingsManager: {
    get: vi.fn((key, def) => {
      if (key === 'TEXT_FIELD_SHORTCUT') return 'Ctrl+/';
      if (key === 'EXTENSION_ENABLED') return true;
      if (key === 'ENABLE_SHORTCUT_FOR_TEXT_FIELDS') return true;
      return def;
    }),
    onChange: vi.fn(() => vi.fn())
  }
}));

vi.mock('@/handlers/smartTranslationIntegration.js', () => ({
  translateFieldViaSmartHandler: mockTranslateFieldViaSmartHandler
}));

vi.mock('@/handlers/smart-translation/translationErrorOwnership.js', () => ({
  isFieldTranslationRequestError: mockIsFieldTranslationRequestError,
}));

vi.mock('@/features/text-field-interaction/utils/FieldTranslationErrorPresenter.js', () => ({
  getFieldTranslationErrorPresentation: mockGetFieldTranslationErrorPresentation,
}));

vi.mock('@/shared/constants/detection.js', () => ({
  INPUT_TYPES: {
    ALL_TEXT_FIELDS: ['text', 'search', 'tel', 'url', 'email', 'password', 'number']
  }
}));

import { FieldShortcutManager } from './FieldShortcutManager.js';
import { settingsManager } from '@/shared/managers/SettingsManager.js';

describe('FieldShortcutManager', () => {
  let manager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTranslateFieldViaSmartHandler.mockResolvedValue(undefined);
    mockIsFieldTranslationRequestError.mockReturnValue(false);
    mockGetFieldTranslationErrorPresentation.mockResolvedValue(null);
    
    // Re-apply default mock implementations
    vi.mocked(settingsManager.get).mockImplementation((key, def) => {
      if (key === 'TEXT_FIELD_SHORTCUT') return 'Ctrl+/';
      if (key === 'EXTENSION_ENABLED') return true;
      if (key === 'ENABLE_SHORTCUT_FOR_TEXT_FIELDS') return true;
      return def;
    });
    
    manager = new FieldShortcutManager();
    manager.initialize({ featureManager: {} });
  });

  describe('parseShortcut', () => {
    it('should parse simple shortcut', () => {
      const parsed = manager.parseShortcut('Ctrl+/');
      expect(parsed).toEqual({
        ctrl: true,
        alt: false,
        shift: false,
        meta: false,
        key: '/'
      });
    });

    it('should parse complex shortcut', () => {
      const parsed = manager.parseShortcut('Ctrl+Alt+Shift+T');
      expect(parsed).toEqual({
        ctrl: true,
        alt: true,
        shift: true,
        meta: false,
        key: 't'
      });
    });

    it('should parse Cmd/Meta shortcut', () => {
      const parsed = manager.parseShortcut('Cmd+T');
      expect(parsed).toEqual({
        ctrl: false,
        alt: false,
        shift: false,
        meta: true,
        key: 't'
      });
    });

    it('matches picker Space against the browser space key', () => {
      manager.parsedShortcut = manager.parseShortcut('Ctrl+Space');
      expect(manager.isShortcutEvent(new KeyboardEvent('keydown', { key: ' ', ctrlKey: true }))).toBe(true);
    });
  });

  describe('initialize', () => {
    it('should set initialized to true and call updateShortcut', () => {
      const newManager = new FieldShortcutManager();
      const featureManager = { id: 'fm' };
      newManager.initialize({ featureManager });
      
      expect(newManager.initialized).toBe(true);
      expect(newManager.featureManager).toBe(featureManager);
      expect(newManager.currentShortcut).toBe('Ctrl+/');
    });

    it('should subscribe to settings changes', () => {
      const onChangeMock = vi.fn(() => vi.fn());
      vi.mocked(settingsManager.onChange).mockImplementation(onChangeMock);
      
      manager.initialize({ featureManager: {} });
      
      expect(onChangeMock).toHaveBeenCalledWith('ENABLE_SHORTCUT_FOR_TEXT_FIELDS', expect.any(Function), 'field-shortcut-manager');
      expect(onChangeMock).toHaveBeenCalledWith('TEXT_FIELD_SHORTCUT', expect.any(Function), 'field-shortcut-manager');
    });
  });

  describe('updateShortcut', () => {
    it('should update currentShortcut from settings', () => {
      vi.mocked(settingsManager.get).mockImplementation((key, def) => {
        if (key === 'TEXT_FIELD_SHORTCUT') return 'Alt+T';
        return def;
      });
      
      manager.updateShortcut();
      expect(manager.currentShortcut).toBe('Alt+T');
      expect(manager.parsedShortcut.key).toBe('t');
      expect(manager.parsedShortcut.alt).toBe(true);
    });
  });

  describe('isShortcutEvent', () => {
    it('should match Ctrl+/', () => {
      const event = new KeyboardEvent('keydown', {
        ctrlKey: true,
        key: '/'
      });
      expect(manager.isShortcutEvent(event)).toBe(true);
    });

    it('should NOT match if modifier missing', () => {
      const event = new KeyboardEvent('keydown', {
        ctrlKey: false,
        key: '/'
      });
      expect(manager.isShortcutEvent(event)).toBe(false);
    });

    it('should NOT match if key differs', () => {
      const event = new KeyboardEvent('keydown', {
        ctrlKey: true,
        key: 'a'
      });
      expect(manager.isShortcutEvent(event)).toBe(false);
    });

    it('should return false for repeat events', () => {
      const event = new KeyboardEvent('keydown', {
        ctrlKey: true,
        key: '/',
        repeat: true
      });
      expect(manager.isShortcutEvent(event)).toBe(false);
    });

    it('should return false for modifier keys by themselves', () => {
      const event = new KeyboardEvent('keydown', {
        ctrlKey: true,
        key: 'Control'
      });
      expect(manager.isShortcutEvent(event)).toBe(false);
    });
  });

  describe('shouldExecute', () => {
    it('should return true for valid event on textarea', async () => {
      const el = document.createElement('textarea');
      el.value = 'test content';
      document.body.appendChild(el);
      el.focus();

      const event = new KeyboardEvent('keydown', {
        ctrlKey: true,
        key: '/'
      });

      const result = await manager.shouldExecute(event);
      expect(result).toBe(true);

      document.body.removeChild(el);
    });

    it('should return false if event is not shortcut', async () => {
      const event = new KeyboardEvent('keydown', { key: 'a' });
      expect(await manager.shouldExecute(event)).toBe(false);
    });

    it('should return false if not initialized', async () => {
      const uninitManager = new FieldShortcutManager();
      const event = new KeyboardEvent('keydown', { ctrlKey: true, key: '/' });
      expect(await uninitManager.shouldExecute(event)).toBe(false);
    });

    it('should return false if extension is disabled', async () => {
      vi.mocked(settingsManager.get).mockImplementation((key, def) => {
        if (key === 'EXTENSION_ENABLED') return false;
        return def;
      });
      
      const event = new KeyboardEvent('keydown', { ctrlKey: true, key: '/' });
      expect(await manager.shouldExecute(event)).toBe(false);
    });

    it('should return false if shortcut feature is disabled', async () => {
      vi.mocked(settingsManager.get).mockImplementation((key, def) => {
        if (key === 'ENABLE_SHORTCUT_FOR_TEXT_FIELDS') return false;
        return def;
      });
      
      const event = new KeyboardEvent('keydown', { ctrlKey: true, key: '/' });
      expect(await manager.shouldExecute(event)).toBe(false);
    });

    it('should return false if active element is not editable', async () => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      el.focus();

      const event = new KeyboardEvent('keydown', { ctrlKey: true, key: '/' });
      expect(await manager.shouldExecute(event)).toBe(false);

      document.body.removeChild(el);
    });

    it('should return false if field is empty', async () => {
      const el = document.createElement('textarea');
      el.value = '';
      document.body.appendChild(el);
      el.focus();

      const event = new KeyboardEvent('keydown', {
        ctrlKey: true,
        key: '/'
      });

      const result = await manager.shouldExecute(event);
      expect(result).toBe(false);

      document.body.removeChild(el);
    });
  });

  describe('execute', () => {
    it('should use Smart Translation and return success', async () => {
      const el = document.createElement('textarea');
      el.value = 'hello';
      document.body.appendChild(el);
      el.focus();

      const result = await manager.execute();
      
      expect(result.success).toBe(true);
      expect(result.type).toBe('ctrl-slash');
      expect(mockTranslateFieldViaSmartHandler).toHaveBeenCalledWith({
        text: 'hello',
        target: el,
        selectionRange: null,
        sourceSnapshot: { scope: 'full', targetKind: 'native', expectedSourceText: 'hello' },
      });
      expect(errorHandler.handle).not.toHaveBeenCalled();
      
      document.body.removeChild(el);
    });

    it('sends only the selected substring with its request-time range (selection scope)', async () => {
      const el = document.createElement('textarea');
      el.value = 'Hello سلام world';
      document.body.appendChild(el);
      el.focus();
      // Select "سلام" (indices 6-10)
      el.setSelectionRange(6, 10);

      const result = await manager.execute();

      expect(result.success).toBe(true);
      expect(mockTranslateFieldViaSmartHandler).toHaveBeenCalledWith({
        text: 'سلام',
        target: el,
        selectionRange: { start: 6, end: 10 },
        sourceSnapshot: { scope: 'selection', targetKind: 'native', expectedSourceText: 'سلام' },
      });

      document.body.removeChild(el);
    });

    it('sends the full value with an explicit full scope when nothing is selected (full-field)', async () => {
      const el = document.createElement('textarea');
      el.value = 'Hello سلام world';
      document.body.appendChild(el);
      el.focus();
      el.setSelectionRange(0, 0);

      await manager.execute();

      expect(mockTranslateFieldViaSmartHandler).toHaveBeenCalledWith({
        text: 'Hello سلام world',
        target: el,
        selectionRange: null,
        sourceSnapshot: { scope: 'full', targetKind: 'native', expectedSourceText: 'Hello سلام world' },
      });

      document.body.removeChild(el);
    });

    it('sends only the contained contentEditable selection with a bookmarked CE scope', async () => {
      const el = document.createElement('div');
      el.setAttribute('contenteditable', 'true');
      el.setAttribute('tabindex', '0');
      // jsdom does not reflect contenteditable IDL attributes; stub the flag
      // the way real browsers expose it.
      Object.defineProperty(el, 'isContentEditable', { value: true, configurable: true });
      el.innerHTML = '<p>Hello <b>سلام</b> world</p>';
      document.body.appendChild(el);
      el.focus();

      const boldText = el.querySelector('b').firstChild;
      const range = document.createRange();
      range.setStart(boldText, 0);
      range.setEnd(boldText, 4);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);

      const result = await manager.execute();

      expect(result.success).toBe(true);
      expect(mockTranslateFieldViaSmartHandler).toHaveBeenCalledWith({
        text: 'سلام',
        target: el,
        selectionRange: null,
        sourceSnapshot: expect.objectContaining({
          scope: 'selection',
          targetKind: 'contenteditable',
          expectedSourceText: 'سلام',
        }),
      });
      const sentSnapshot = mockTranslateFieldViaSmartHandler.mock.calls.at(-1)[0].sourceSnapshot;
      expect(sentSnapshot.bookmark).toMatchObject({
        startPath: expect.any(Array),
        endPath: expect.any(Array),
      });
      // Serializable: no live refs survive the structured-clone round trip.
      expect(JSON.parse(JSON.stringify(sentSnapshot))).toEqual(sentSnapshot);

      selection.removeAllRanges();
      document.body.removeChild(el);
    });

    it('sends full canonical contentEditable text when nothing is selected', async () => {
      const el = document.createElement('div');
      el.setAttribute('contenteditable', 'true');
      el.setAttribute('tabindex', '0');
      Object.defineProperty(el, 'isContentEditable', { value: true, configurable: true });
      el.innerHTML = '<p>line1</p><p>line2</p>';
      document.body.appendChild(el);
      el.focus();
      window.getSelection().removeAllRanges();

      const result = await manager.execute();

      expect(result.success).toBe(true);
      expect(mockTranslateFieldViaSmartHandler).toHaveBeenCalledWith({
        text: 'line1\nline2',
        target: el,
        selectionRange: null,
        sourceSnapshot: {
          scope: 'full',
          targetKind: 'contenteditable',
          expectedSourceText: 'line1\nline2',
        },
      });

      document.body.removeChild(el);
    });

    it('presents marked request failures with safe message and canonical type', async () => {
      const el = document.createElement('textarea');
      el.value = 'hello';
      document.body.appendChild(el);
      el.focus();

      const rawError = Object.assign(new Error('raw provider setup details'), { type: 'API_CONFIG_INVALID' });
      const displayError = Object.assign(new Error('safe localized setup message'), { type: 'DISPLAY_TYPE' });
      mockIsFieldTranslationRequestError.mockReturnValue(true);
      mockGetFieldTranslationErrorPresentation.mockResolvedValue({
        canonicalError: rawError,
        displayError,
        canonicalType: 'API_CONFIG_INVALID',
      });
      mockTranslateFieldViaSmartHandler.mockRejectedValueOnce(rawError);

      const result = await manager.execute();
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('safe localized setup message');
      expect(result.error).not.toContain('raw provider setup details');
      expect(mockGetFieldTranslationErrorPresentation).toHaveBeenCalledWith(rawError);
      expect(errorHandler.handle).toHaveBeenCalledTimes(1);
      expect(errorHandler.handle).toHaveBeenCalledWith(displayError, {
        context: 'ctrl-slash-shortcut',
        showToast: true,
        type: 'API_CONFIG_INVALID',
      });
      expect(errorHandler.handle.mock.calls[0][0]).not.toBe(rawError);
      
      document.body.removeChild(el);
    });

    it.each([
      'API_ERROR',
      'HTTP_ERROR',
      'NETWORK_ERROR',
      'SERVER_ERROR',
      'TRANSLATION_TIMEOUT',
      'API_RESPONSE_INVALID',
      'JSON_PARSING_ERROR',
      'MODEL_MISSING',
      'API_KEY_INVALID',
      'RATE_LIMIT_REACHED',
      'CIRCUIT_BREAKER_OPEN',
      'UNKNOWN_REQUEST_ERROR',
    ])('keeps raw %s details out of marked failure output', async (type) => {
      const el = document.createElement('textarea');
      el.value = 'hello';
      document.body.appendChild(el);
      el.focus();

      const rawMessage = `raw ${type} provider details`;
      const rawError = Object.assign(new Error(rawMessage), { type });
      const displayError = new Error(`safe ${type} message`);
      mockIsFieldTranslationRequestError.mockReturnValue(true);
      mockGetFieldTranslationErrorPresentation.mockResolvedValue({
        canonicalError: rawError,
        displayError,
        canonicalType: type,
      });
      mockTranslateFieldViaSmartHandler.mockRejectedValueOnce(rawError);

      const result = await manager.execute();
      
      expect(result.success).toBe(false);
      expect(result.error).toBe(`safe ${type} message`);
      expect(result.error).not.toContain(rawMessage);
      expect(errorHandler).toBeDefined();
      expect(errorHandler.handle).toHaveBeenCalledWith(displayError, {
        context: 'ctrl-slash-shortcut',
        showToast: true,
        type,
      });
      
      document.body.removeChild(el);
    });

    it('does not present unmarked Field-owned errors', async () => {
      const el = document.createElement('textarea');
      el.value = 'hello';
      document.body.appendChild(el);
      el.focus();

      const fieldError = new Error('DOM mutation failed');
      mockTranslateFieldViaSmartHandler.mockRejectedValueOnce(fieldError);

      const result = await manager.execute();

      expect(result).toEqual({
        success: false,
        error: 'DOM mutation failed',
        type: 'ctrl-slash',
      });
      expect(mockGetFieldTranslationErrorPresentation).not.toHaveBeenCalled();
      expect(errorHandler.handle).toHaveBeenCalledWith(fieldError, {
        type: 'TRANSLATION_FAILED',
        context: 'ctrl-slash-shortcut',
        showToast: true,
      });

      document.body.removeChild(el);
    });

    it.each([
      { type: 'USER_CANCELLED', message: 'cancelled by user' },
      { type: 'TRANSLATION_CANCELLED', message: 'translation cancelled' },
      { type: 'CONTEXT', message: 'context invalidated' },
      { type: 'EXTENSION_CONTEXT_INVALIDATED', message: 'extension context invalidated' },
    ])('keeps $type failures silent', async (details) => {
      const el = document.createElement('textarea');
      el.value = 'hello';
      document.body.appendChild(el);
      el.focus();

      const cancellation = Object.assign(new Error(details.message), details);
      mockTranslateFieldViaSmartHandler.mockRejectedValueOnce(cancellation);

      const result = await manager.execute();

      expect(result).toEqual({
        success: false,
        error: details.message,
        type: 'ctrl-slash',
      });
      expect(mockGetFieldTranslationErrorPresentation).not.toHaveBeenCalled();
      expect(errorHandler.handle).not.toHaveBeenCalled();

      document.body.removeChild(el);
    });
  });

  describe('isEditableElement', () => {
    it('should return true for input text', () => {
      const el = document.createElement('input');
      el.type = 'text';
      expect(manager.isEditableElement(el)).toBe(true);
    });

    it('should return true for textarea', () => {
      const el = document.createElement('textarea');
      expect(manager.isEditableElement(el)).toBe(true);
    });

    it('should return true for contentEditable', () => {
      const el = document.createElement('div');
      el.contentEditable = 'true';
      expect(manager.isEditableElement(el)).toBe(true);
    });

    it('should return false for non-editable elements', () => {
      const el = document.createElement('div');
      expect(manager.isEditableElement(el)).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should unsubscribe and reset state', () => {
      const unsubscribe = vi.fn();
      vi.mocked(settingsManager.onChange).mockReturnValue(unsubscribe);
      
      manager.initialize({ featureManager: {} });
      manager.cleanup();
      
      expect(unsubscribe).toHaveBeenCalled();
      expect(manager.initialized).toBe(false);
      expect(manager.featureManager).toBeNull();
    });
  });

  describe('getInfo', () => {
    it('should return info object', () => {
      const info = manager.getInfo();
      expect(info.type).toBe('FieldShortcutManager');
      expect(info.initialized).toBe(true);
    });
  });
});
