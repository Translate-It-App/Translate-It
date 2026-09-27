import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isSelectableTextRoot } from './utils/elementHelpers.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';

// Mock dependencies
vi.mock('@/shared/logging/logConstants.js', () => ({
  LOG_COMPONENTS: {
    ELEMENT_SELECTION: 'ElementSelection'
  }
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    operation: vi.fn()
  }))
}));

vi.mock('@/core/PageEventBus.js', () => ({
  pageEventBus: {
    on: vi.fn(),
    emit: vi.fn(),
    off: vi.fn()
  },
  WINDOWS_MANAGER_EVENTS: {
    SHOW_WINDOW: 'SHOW_WINDOW'
  }
}));

vi.mock('@/shared/messaging/core/UnifiedMessaging.js', () => ({
  sendMessage: vi.fn(() => Promise.resolve()),
  sendRegularMessage: vi.fn(() => Promise.resolve())
}));

vi.mock('@/core/extensionContext.js', () => ({
  default: {
    isTabActive: vi.fn(() => true),
    isValidSync: vi.fn(() => true),
    isContextError: vi.fn(() => false),
    handleContextError: vi.fn()
  }
}));
vi.mock('@/shared/error-management/ErrorHandler.js', () => ({
  ErrorHandler: {
    getInstance: vi.fn()
  }
}));
vi.mock('@/shared/error-management/PublicTranslationErrorPolicy.js', () => ({
  mapCanonicalTranslationError: vi.fn((error) => ({
    type: {
      API_ERROR: 'API_FAILURE',
      VALIDATION: 'INVALID_INPUT',
      ELEMENT_TOO_LARGE: 'ELEMENT_TOO_LARGE',
      GEMINI_QUOTA_REGION: 'GEMINI_QUOTA_REGION',
      DEEPL_QUOTA_EXCEEDED: 'DEEPL_QUOTA_EXCEEDED',
      API_RESPONSE_INVALID: 'INVALID_RESPONSE',
      JSON_PARSING_ERROR: 'INVALID_RESPONSE',
      UNEXPECTED_RESPONSE_FORMAT: 'INVALID_RESPONSE',
      HTML_RESPONSE_ERROR: 'TRANSLATION_FAILED',
      TRANSLATION_ERROR: 'TRANSLATION_FAILED',
      CONNECTION_LOST: 'TRANSLATION_FAILED',
      NO_ACCEPTED_TRANSLATION_RESULTS: 'TRANSLATION_FAILED',
      API_URL_MISSING: 'API_URL_MISSING',
      API_CONFIG_INVALID: 'CONFIGURATION_INVALID',
      API_ENDPOINT_INVALID: 'ENDPOINT_INVALID',
      BROWSER_API_UNAVAILABLE: 'BROWSER_API_UNAVAILABLE',
      FORBIDDEN_ERROR: 'ACCESS_DENIED',
      TEXT_EMPTY: 'TEXT_EMPTY',
      TEXT_TOO_LONG: 'TEXT_TOO_LONG',
      PROMPT_INVALID: 'PROMPT_INVALID',
      LANGUAGE_PAIR_NOT_SUPPORTED: 'LANGUAGE_PAIR_UNSUPPORTED',
      CIRCUIT_BREAKER_OPEN: 'PROVIDER_TEMPORARILY_UNAVAILABLE',
      TRANSLATION_NOT_FOUND: 'TRANSLATION_NOT_FOUND',
      MODEL_MISSING: 'MODEL_UNAVAILABLE',
      API_KEY_MISSING: 'API_KEY_MISSING',
      API_KEY_INVALID: 'API_KEY_INVALID',
      QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
      INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
      RATE_LIMIT_REACHED: 'RATE_LIMITED',
      MODEL_OVERLOADED: 'MODEL_OVERLOADED',
      NETWORK_ERROR: 'NETWORK_ERROR',
      SERVER_ERROR: 'SERVER_ERROR',
      TRANSLATION_TIMEOUT: 'TRANSLATION_TIMEOUT',
      OPERATION_TIMEOUT: 'TRANSLATION_TIMEOUT',
      INVALID_REQUEST: 'INVALID_REQUEST',
      TRANSLATION_FAILED: 'TRANSLATION_FAILED',
      HTTP_ERROR: error?.originalType === 'MODEL_MISSING' ? 'MODEL_UNAVAILABLE' : 'REQUEST_FAILURE',
      UNKNOWN: 'TRANSLATION_FAILED',
     }[error?.type] || 'TRANSLATION_FAILED',
     messageKey: {
      API_ERROR: 'ERRORS_API_ERROR',
      VALIDATION: 'ERRORS_INVALID_INPUT',
      ELEMENT_TOO_LARGE: 'ERRORS_ELEMENT_TOO_LARGE',
      GEMINI_QUOTA_REGION: 'ERRORS_GEMINI_QUOTA_REGION',
      DEEPL_QUOTA_EXCEEDED: 'ERRORS_DEEPL_QUOTA_EXCEEDED',
      API_RESPONSE_INVALID: 'ERRORS_API_RESPONSE_INVALID',
      JSON_PARSING_ERROR: 'ERRORS_API_RESPONSE_INVALID',
      UNEXPECTED_RESPONSE_FORMAT: 'ERRORS_API_RESPONSE_INVALID',
      API_URL_MISSING: 'ERRORS_API_URL_MISSING',
      API_CONFIG_INVALID: 'ERRORS_API_CONFIG_INVALID',
      API_ENDPOINT_INVALID: 'ERRORS_API_ENDPOINT_INVALID',
      BROWSER_API_UNAVAILABLE: 'ERRORS_BROWSER_API_UNAVAILABLE',
      FORBIDDEN_ERROR: 'ERRORS_FORBIDDEN_ERROR',
      TEXT_EMPTY: 'ERRORS_TEXT_EMPTY',
      TEXT_TOO_LONG: 'ERRORS_TEXT_TOO_LONG',
      PROMPT_INVALID: 'ERRORS_PROMPT_INVALID',
      LANGUAGE_PAIR_NOT_SUPPORTED: 'ERRORS_LANGUAGE_PAIR_NOT_SUPPORTED',
      CIRCUIT_BREAKER_OPEN: 'ERRORS_CIRCUIT_BREAKER_OPEN',
      TRANSLATION_NOT_FOUND: 'ERRORS_TRANSLATION_NOT_FOUND',
      MODEL_MISSING: 'ERRORS_MODEL_MISSING',
      API_KEY_MISSING: 'ERRORS_API_KEY_MISSING',
      API_KEY_INVALID: 'ERRORS_API_KEY_INVALID',
      QUOTA_EXCEEDED: 'ERRORS_QUOTA_EXCEEDED',
      INSUFFICIENT_BALANCE: 'ERRORS_INSUFFICIENT_BALANCE',
      RATE_LIMIT_REACHED: 'ERRORS_RATE_LIMIT_REACHED',
      MODEL_OVERLOADED: 'ERRORS_MODEL_OVERLOADED',
      NETWORK_ERROR: 'ERRORS_NETWORK_ERROR',
      SERVER_ERROR: 'ERRORS_SERVER_ERROR',
      TRANSLATION_TIMEOUT: 'ERRORS_TRANSLATION_TIMEOUT',
      INVALID_REQUEST: 'ERRORS_INVALID_REQUEST',
      TRANSLATION_FAILED: 'ERRORS_TRANSLATION_FAILED',
      HTTP_ERROR: error?.originalType === 'MODEL_MISSING' ? 'ERRORS_MODEL_MISSING' : 'ERRORS_HTTP_ERROR',
      }[error?.type] || 'ERRORS_TRANSLATION_FAILED',
     severity: error?.type === 'CIRCUIT_BREAKER_OPEN'
       ? 'warning'
       : error?.type === 'TRANSLATION_NOT_FOUND' ? 'error' : undefined,
     silent: false,
  }))
}));
vi.mock('@/shared/error-management/PublicTranslationErrorAdapter.js', () => ({
  createLegacyDisplayError: vi.fn(async (canonicalError, publicError) => {
    const legacyType = {
      API_FAILURE: 'API_ERROR',
      MODEL_UNAVAILABLE: 'MODEL_MISSING',
      INVALID_INPUT: 'TRANSLATION_FAILED',
      ELEMENT_TOO_LARGE: 'ELEMENT_TOO_LARGE',
      GEMINI_QUOTA_REGION: 'GEMINI_QUOTA_REGION',
       DEEPL_QUOTA_EXCEEDED: 'DEEPL_QUOTA_EXCEEDED',
       REQUEST_FAILURE: 'HTTP_ERROR',
       API_URL_MISSING: 'API_URL_MISSING',
       CONFIGURATION_INVALID: 'API_CONFIG_INVALID',
       ENDPOINT_INVALID: 'API_ENDPOINT_INVALID',
       BROWSER_API_UNAVAILABLE: 'BROWSER_API_UNAVAILABLE',
       ACCESS_DENIED: 'FORBIDDEN_ERROR',
       TEXT_EMPTY: 'TEXT_EMPTY',
       TEXT_TOO_LONG: 'TEXT_TOO_LONG',
       PROMPT_INVALID: 'PROMPT_INVALID',
        LANGUAGE_PAIR_UNSUPPORTED: 'LANGUAGE_PAIR_NOT_SUPPORTED',
        PROVIDER_TEMPORARILY_UNAVAILABLE: 'CIRCUIT_BREAKER_OPEN',
        TRANSLATION_NOT_FOUND: 'TRANSLATION_NOT_FOUND',
        API_KEY_MISSING: 'API_KEY_MISSING',
        API_KEY_INVALID: 'API_KEY_INVALID',
        QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
        INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
        RATE_LIMITED: 'RATE_LIMIT_REACHED',
        MODEL_OVERLOADED: 'MODEL_OVERLOADED',
        NETWORK_ERROR: 'NETWORK_ERROR',
        SERVER_ERROR: 'SERVER_ERROR',
        TRANSLATION_TIMEOUT: 'TRANSLATION_TIMEOUT',
        INVALID_REQUEST: 'INVALID_REQUEST',
        TRANSLATION_FAILED: 'TRANSLATION_FAILED',
    }[publicError?.type] || publicError?.type || 'TRANSLATION_FAILED';
    const message = {
      ERRORS_API_ERROR: 'Translation service API error.',
      ERRORS_ELEMENT_TOO_LARGE: 'This element is too large to translate at once.',
      ERRORS_GEMINI_QUOTA_REGION: 'You reached the Gemini quota. (Region issue)',
      ERRORS_DEEPL_QUOTA_EXCEEDED: 'DeepL quota exceeded. Please check your plan.',
       ERRORS_API_RESPONSE_INVALID: 'Invalid API response format',
       ERRORS_MODEL_MISSING: 'AI Model is missing or invalid',
       ERRORS_HTTP_ERROR: 'HTTP error',
       ERRORS_TRANSLATION_FAILED: 'Translation failed',
       ERRORS_API_URL_MISSING: 'API URL is missing. Please enter it in settings.',
       ERRORS_API_CONFIG_INVALID: 'Invalid API configuration. Please check your settings.',
       ERRORS_API_ENDPOINT_INVALID: 'API Endpoint not found (404). Please check your URL.',
       ERRORS_BROWSER_API_UNAVAILABLE: 'The translation API is not available or supported in this browser',
       ERRORS_FORBIDDEN_ERROR: 'Access denied. Check permissions or potential content moderation.',
       ERRORS_TEXT_EMPTY: 'Text is empty',
       ERRORS_TEXT_TOO_LONG: 'Text is too long',
       ERRORS_PROMPT_INVALID: 'Prompt is invalid',
        ERRORS_LANGUAGE_PAIR_NOT_SUPPORTED: 'Language pair not supported by the selected translation service',
        ERRORS_CIRCUIT_BREAKER_OPEN: 'Circuit breaker is open. This provider is temporarily disabled due to too many failures.',
        ERRORS_TRANSLATION_NOT_FOUND: 'Translation not found',
     }[publicError?.messageKey] || 'Translation failed';
    const displayError = new Error(message);
    displayError.type = legacyType;
    displayError.cause = canonicalError;
    return displayError;
  })
}));

vi.mock('@/shared/error-management/ErrorMatcher.js', () => ({
  isFatalError: vi.fn(() => false),
  isCancellationError: vi.fn(() => false),
  isSilentError: vi.fn(() => false),
  matchErrorToType: vi.fn((error) => error?.type || 'TRANSLATION_ERROR')
}));

vi.mock('@/shared/constants/ui.js', () => ({
  NOTIFICATION_TIME: {
    WARNING_PROVIDER: 3000
  }
}));

vi.mock('@/shared/constants/translation.js', () => ({
  TRANSLATION_STATUS: {
    TRANSLATING: 'translating',
    COMPLETED: 'completed',
    ERROR: 'error'
  }
}));

vi.mock('@/shared/config/config.js', () => ({
  getSelectElementShowOriginalOnHoverAsync: vi.fn(() => Promise.resolve(true)),
  getSourceLanguageAsync: vi.fn(() => Promise.resolve('en')),
  getTargetLanguageAsync: vi.fn(() => Promise.resolve('fa')),
  getTranslationApiAsync: vi.fn(() => Promise.resolve('google')),
  getEffectiveProviderAsync: vi.fn(() => Promise.resolve('google')),
  getAIContextTranslationEnabledAsync: vi.fn(() => Promise.resolve(true)),
  TranslationMode: {
    Select_Element: 'select_element'
  }
}));

vi.mock('@/shared/config/constants.js', () => ({
  NOTIFICATION_TIME: {
    WARNING_PROVIDER: 3000
  },
  TRANSLATION_STATUS: {
    TRANSLATING: 'translating',
    COMPLETED: 'completed',
    ERROR: 'error'
  },
  UI_HOST_IDS: {
    MAIN: 'translate-it-ui-host'
  }
}));

vi.mock('@/utils/i18n/i18n.js', () => ({
  getTranslationString: vi.fn((key) => ({
    ERRORS_SELECT_ELEMENT_PARTIAL_TRANSLATION_FAILED: 'Some content could not be translated.',
    ERRORS_TRANSLATION_FAILED: 'Translation failed',
    SELECT_ELEMENT_NO_TRANSLATABLE_CONTENT: 'No translatable text was found in this element.',
    SELECT_ELEMENT_UNSUPPORTED_TRANSLATION_MODE: 'This content cannot be translated with the current translation mode.',
  }[key] || key))
}));

vi.mock('@/shared/utils/warning-manager.js', () => ({
  shouldShowProviderWarning: vi.fn(() => Promise.resolve(false))
}));

vi.mock('@/features/shared/hover-preview/HoverPreviewManager.js', () => ({
  hoverPreviewManager: {
    initialize: vi.fn(),
    deactivate: vi.fn()
  }
}));

vi.mock('./SelectElement.scss?inline', () => ({
  default: '.mock-styles {}'
}));

vi.mock('./core/DomTranslatorAdapter.js', () => ({
  DomTranslatorAdapter: class {
    initialize = vi.fn(() => Promise.resolve());
    translateElement = vi.fn(() => Promise.resolve({ success: true }));
    cleanup = vi.fn();
    cancelTranslation = vi.fn();
    revertTranslation = vi.fn();
  }
}));

vi.mock('./core/ElementSelector.js', () => ({
  ElementSelector: class {
    initialize = vi.fn(() => Promise.resolve());
    activate = vi.fn();
    deactivate = vi.fn();
    cleanup = vi.fn();
    handleMouseOver = vi.fn();
    handleMouseOut = vi.fn();
    clearHighlight = vi.fn();
    getHighlightedElement = vi.fn();
    findBestTextElement = vi.fn(element => element);
    isOurElement = vi.fn(() => false);
  }
}));

vi.mock('./utils/elementHelpers.js', () => ({
  extractTextFromElement: vi.fn(() => 'test text'),
  isSelectableTextRoot: vi.fn(() => true)
}));

vi.mock('./SelectElementNotificationManager.js', () => ({
  getSelectElementNotificationManager: vi.fn(() => Promise.resolve({
    showActivationNotification: vi.fn(),
    showProgress: vi.fn(),
    showSuccess: vi.fn(),
    showError: vi.fn(),
    hide: vi.fn(),
    cleanup: vi.fn()
  }))
}));

vi.mock('@/core/managers/core/NotificationManager.js', () => ({
  default: class NotificationManager {
    constructor() {}
  }
}));

vi.mock('@/core/memory/ResourceTracker.js', () => ({
  default: class ResourceTracker {
    constructor() {
      this.resources = new Set();
    }
    trackResource() {}
    cleanup() {}
    addEventListener(target, event, handler) {
      if (target && target.on) {
        target.on(event, handler);
      } else if (target && target.addEventListener) {
        target.addEventListener(event, handler);
      }
    }
    removeEventListener() {}
  }
}));

vi.mock('@/features/translation/providers/ProviderConstants.js', () => ({
  ProviderRegistryIds: {
    GOOGLE: 'google',
    GOOGLE_V2: 'googlev2'
  },
  ProviderNames: {
    GOOGLE_TRANSLATE: 'GoogleTranslate',
    GOOGLE_TRANSLATE_V2: 'GoogleTranslateV2'
  },
  ProviderTypes: {
    TRANSLATE: 'translate'
  }
}));

vi.mock('@/utils/browser/compatibility.js', () => ({
  deviceDetector: {
    isMobile: vi.fn(() => false)
  }
}));

vi.mock('@/shared/messaging/core/MessageActions.js', () => ({
  MessageActions: {
    ACTIVATE_SELECT_ELEMENT_MODE: 'ACTIVATE_SELECT_ELEMENT_MODE',
    DEACTIVATE_SELECT_ELEMENT_MODE: 'DEACTIVATE_SELECT_ELEMENT_MODE',
    SET_SELECT_ELEMENT_STATE: 'SET_SELECT_ELEMENT_STATE',
    IFRAME_SELECT_ELEMENT_FINISHED: 'IFRAME_SELECT_ELEMENT_FINISHED',
    TRANSLATE: 'TRANSLATE'
  }
}));

let SelectElementManager;

describe('SelectElementManager Escape fallback event dispatch', () => {
  async function createActiveManager() {
    vi.clearAllMocks();
    isSelectableTextRoot.mockReturnValue(true);
    const module = await import('./SelectElementManager.js');
    const manager = new module.SelectElementManager();
    await manager.initialize();
    await manager.activateSelectElementMode();
    return manager;
  }

  it('cancels through keyup when a website stops capture-phase keydown', async () => {
    const websiteHandler = vi.fn(event => {
      if (event.key === 'Escape') event.stopImmediatePropagation();
    });
    let manager;

    window.addEventListener('keydown', websiteHandler, true);
    try {
      manager = await createActiveManager();
      const deactivate = vi.spyOn(manager, 'deactivate');
      const { sendMessage } = await import('@/shared/messaging/core/UnifiedMessaging.js');
      sendMessage.mockClear();

      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }));

      expect(websiteHandler).toHaveBeenCalledTimes(1);
      expect(deactivate).not.toHaveBeenCalled();
      expect(manager.isActive).toBe(true);

      window.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }));

      await vi.waitFor(() => expect(manager.isActive).toBe(false));
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({
        action: 'DEACTIVATE_SELECT_ELEMENT_MODE',
      }));
      expect(deactivate).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', websiteHandler, true);
      if (manager?.isActive) await manager.deactivate({ reason: 'manual' });
      manager?.removeEventListeners();
    }
  });

  it('does not retain keyup cancellation listener after listeners are removed', async () => {
    const manager = await createActiveManager();
    const deactivate = vi.spyOn(manager, 'deactivate');

    try {
      manager.removeEventListeners();
      manager.isActive = true;

      window.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }));

      expect(deactivate).not.toHaveBeenCalled();
    } finally {
      if (manager.isActive) await manager.deactivate({ reason: 'manual' });
    }
  });
});

describe('SelectElementManager', () => {
  let manager;
  let errorHandler;

  beforeEach(async () => {
    vi.clearAllMocks();
    isSelectableTextRoot.mockReturnValue(true);
    if (!SelectElementManager) {
      const module = await import('./SelectElementManager.js');
      SelectElementManager = module.SelectElementManager;
    }
    manager = new SelectElementManager();
    const { ErrorHandler } = await import('@/shared/error-management/ErrorHandler.js');
    errorHandler = { handle: vi.fn(() => Promise.resolve()) };
    ErrorHandler.getInstance.mockReturnValue(errorHandler);
  });

  it('should be instantiable', () => {
    expect(manager).toBeDefined();
    expect(manager.isActive).toBe(false);
  });

  it('should initialize services', async () => {
    await manager.initialize();
    expect(manager.isInitialized).toBe(true);
    expect(manager.domTranslatorAdapter.initialize).toHaveBeenCalled();
    expect(manager.elementSelector.initialize).toHaveBeenCalled();
  });

  it('should activate select element mode', async () => {
    await manager.initialize();
    await manager.activateSelectElementMode();
    
    const { pageEventBus } = await import('@/core/PageEventBus.js');
    
    expect(manager.isActive).toBe(true);
    expect(manager.elementSelector.activate).toHaveBeenCalled();
    expect(pageEventBus.emit).toHaveBeenCalledWith('show-select-element-notification', expect.any(Object));
  });

  it('publishes canonical active state on direct activation', async () => {
    await manager.initialize();
    await manager.activateSelectElementMode();

    const { sendMessage } = await import('@/shared/messaging/core/UnifiedMessaging.js');
    expect(sendMessage).toHaveBeenCalledWith({
      action: 'SET_SELECT_ELEMENT_STATE',
      data: { active: true },
    });
  });

  it('resolves Whole Page conflict before activating Select Element', async () => {
    const resolveFeatureConflict = vi.fn().mockImplementation(async () => {
      expect(manager.isActive).toBe(false);
    });
    manager = new SelectElementManager({ featureManager: { resolveFeatureConflict } });
    await manager.initialize();

    await manager.activateSelectElementMode();

    expect(resolveFeatureConflict).toHaveBeenCalledWith('selectElement');
    expect(manager.isActive).toBe(true);
  });

  it('fails activation when trusted Whole Page conflict resolution fails', async () => {
    const error = new Error('restore failed');
    manager = new SelectElementManager({
      featureManager: { resolveFeatureConflict: vi.fn().mockRejectedValue(error) },
    });
    await manager.initialize();

    await expect(manager.activateSelectElementMode()).rejects.toBe(error);
    expect(manager.isActive).toBe(false);
  });

  it('ignores forged DOM conflict events', async () => {
    await manager.initialize();
    manager.isActive = true;
    const deactivate = vi.spyOn(manager, 'deactivate');

    window.dispatchEvent(new CustomEvent('STOP_CONFLICTING_FEATURES', {
      detail: { source: 'malicious-page' },
    }));

    expect(deactivate).not.toHaveBeenCalled();
  });

  it('should deactivate select element mode', async () => {
    await manager.initialize();
    await manager.activateSelectElementMode();
    await manager.deactivate();
    
    const { pageEventBus } = await import('@/core/PageEventBus.js');
    
    expect(manager.isActive).toBe(false);
    expect(manager.elementSelector.deactivate).toHaveBeenCalled();
    expect(pageEventBus.emit).toHaveBeenCalledWith('dismiss-select-element-notification', expect.any(Object));
  });

  it('returns a successful cleanup ACK after deactivation', async () => {
    manager.isActive = true;

    await expect(manager.deactivate({ fromBackground: true })).resolves.toEqual({
      success: true,
      cleanupCompleted: true,
    });
  });

  it('returns an idempotent cleanup ACK when already inactive', async () => {
    await expect(manager.deactivate()).resolves.toEqual({
      success: true,
      cleanupCompleted: true,
      alreadyInactive: true,
    });
  });

  it('returns a failed cleanup ACK after emergency cleanup', async () => {
    manager.isActive = true;
    manager.elementSelector.deactivate.mockImplementationOnce(() => {
      throw new Error('internal cleanup detail');
    });
    const emergencyCleanup = vi.spyOn(manager, 'emergencyCleanup');

    const result = await manager.deactivate({ fromBackground: true });

    expect(result).toEqual({
      success: false,
      cleanupCompleted: false,
      error: 'Could not deactivate Select Element mode.',
    });
    expect(emergencyCleanup).toHaveBeenCalledTimes(1);
    expect(result.error).not.toContain('internal cleanup detail');
  });

  it('waits for adapter cancellation before continuing cleanup', async () => {
    manager.isActive = true;
    let resolveCancellation;
    manager.domTranslatorAdapter.cancelTranslation.mockImplementation(() => new Promise((resolve) => {
      resolveCancellation = resolve;
    }));

    const deactivation = manager.deactivate({ reason: 'cancel', fromBackground: true });
    await vi.waitFor(() => expect(manager.domTranslatorAdapter.cancelTranslation).toHaveBeenCalled());

    expect(manager.elementSelector.deactivate).not.toHaveBeenCalled();

    resolveCancellation();
    await expect(deactivation).resolves.toEqual({
      success: true,
      cleanupCompleted: true,
    });
    expect(manager.elementSelector.deactivate).toHaveBeenCalledTimes(1);
  });

  it('serializes local deactivation before a queued activation', async () => {
    manager.isInitialized = true;
    manager.isActive = true;
    let resolveCancellation;
    manager.domTranslatorAdapter.cancelTranslation.mockImplementation(() => new Promise(resolve => {
      resolveCancellation = resolve;
    }));

    const deactivation = manager.deactivate({ reason: 'cancel', fromBackground: true });
    await vi.waitFor(() => expect(manager.domTranslatorAdapter.cancelTranslation).toHaveBeenCalled());

    const activation = manager.activateSelectElementMode();
    expect(manager.elementSelector.activate).not.toHaveBeenCalled();

    resolveCancellation();
    await expect(deactivation).resolves.toMatchObject({ success: true, cleanupCompleted: true });
    await expect(activation).resolves.toMatchObject({ isActive: true });
    expect(manager.isActive).toBe(true);
  });

  it('serializes local deactivation after an in-flight activation', async () => {
    manager.isInitialized = true;
    let resolveServices;
    manager._ensureServicesAvailable = vi.fn(() => new Promise(resolve => {
      resolveServices = resolve;
    }));

    const activation = manager.activateSelectElementMode();
    await vi.waitFor(() => expect(manager._ensureServicesAvailable).toHaveBeenCalled());

    const deactivation = manager.deactivate({ fromBackground: true });
    expect(manager.elementSelector.deactivate).not.toHaveBeenCalled();

    resolveServices(true);
    await expect(activation).resolves.toMatchObject({ isActive: true });
    await expect(deactivation).resolves.toMatchObject({ success: true, cleanupCompleted: true });
    expect(manager.isActive).toBe(false);
  });

  it('recovers manager lifecycle queue after a rejected operation', async () => {
    const firstOperation = manager.enqueueSelectElementLifecycle(() => {
      throw new Error('first lifecycle failure');
    });
    const secondOperation = manager.enqueueSelectElementLifecycle(() => 'second operation');

    await expect(firstOperation).rejects.toThrow('first lifecycle failure');
    await expect(secondOperation).resolves.toBe('second operation');
  });

  it('should handle click on element to translate', async () => {
    await manager.initialize();
    await manager.activateSelectElementMode();
    manager.activationTime = 0; // Bypass cooldown
    
    const mockElement = document.createElement('div');
    mockElement.textContent = 'test text';
    manager.elementSelector.getHighlightedElement.mockReturnValue(mockElement);
    
    // Simulate click
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.body.appendChild(mockElement);
    
    await manager.handleClick(event);
    
    expect(manager.domTranslatorAdapter.translateElement).toHaveBeenCalledWith(mockElement, expect.any(Object));
    expect(manager.isActive).toBe(false); // Should deactivate after translation
    expect(document.documentElement.getAttribute('data-translate-it-select-mode')).toBeNull();
  });

  describe('click-time revalidation', () => {
    beforeEach(() => {
      manager.isActive = true;
      manager.activationTime = 0;
      isSelectableTextRoot.mockReturnValue(true);
    });

    it('revalidates the target even after highlight', async () => {
      const el = document.createElement('div');
      manager.elementSelector.getHighlightedElement.mockReturnValue(el);
      isSelectableTextRoot.mockReturnValue(false);

      await manager.handleClick(new MouseEvent('click'));

      expect(manager.domTranslatorAdapter.translateElement).not.toHaveBeenCalled();
      expect(manager.elementSelector.deactivate).not.toHaveBeenCalled();
    });

    it('lets an eligible target reach translateElement', async () => {
      const el = document.createElement('div');
      manager.elementSelector.getHighlightedElement.mockReturnValue(el);

      await manager.handleClick(new MouseEvent('click'));

      expect(manager.domTranslatorAdapter.translateElement).toHaveBeenCalledWith(el, expect.any(Object));
    });

    it('does not translate a target that became invalid between hover and click', async () => {
      const el = document.createElement('div');
      manager.elementSelector.getHighlightedElement.mockReturnValue(el);
      isSelectableTextRoot.mockReturnValue(false);

      await manager.handleClick(new MouseEvent('click'));

      expect(manager.domTranslatorAdapter.translateElement).not.toHaveBeenCalled();
    });

    it('rejects SELECT/OPTION roots silently through the root-eligibility contract', async () => {
      // The real policy (getSelectElementRootEligibility) now returns
      // selectableRoot:false for SELECT/OPTION, so isSelectableTextRoot is
      // false and the manager must never reach the adapter — no toast, no
      // NO_TRANSLATABLE_CONTENT outcome.
      for (const tag of ['select', 'option']) {
        const el = document.createElement(tag);
        el.textContent = 'English Persian';
        manager.elementSelector.getHighlightedElement.mockReturnValue(el);
        isSelectableTextRoot.mockReturnValue(false);

        await manager.handleClick(new MouseEvent('click'));

        expect(manager.domTranslatorAdapter.translateElement).not.toHaveBeenCalled();
        expect(manager.elementSelector.deactivate).not.toHaveBeenCalled();
      }
    });

    it('applies the same eligibility rule to the event.target fallback', async () => {
      const el = document.createElement('div');
      manager.elementSelector.getHighlightedElement.mockReturnValue(null);
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'target', { value: el });

      isSelectableTextRoot.mockReturnValue(true);
      await manager.handleClick(event);
      expect(manager.domTranslatorAdapter.translateElement).toHaveBeenCalledWith(el, expect.any(Object));

      manager.domTranslatorAdapter.translateElement.mockClear();
      isSelectableTextRoot.mockReturnValue(false);
      await manager.handleClick(event);
      expect(manager.domTranslatorAdapter.translateElement).not.toHaveBeenCalled();
    });

    it('falls back to retargeted host while shadow translation is disabled', async () => {
      const host = document.createElement('x-host');
      const shadow = host.attachShadow({ mode: 'open' });
      const internal = document.createElement('button');
      internal.textContent = 'Translate this button';
      shadow.appendChild(internal);
      manager.elementSelector.getHighlightedElement.mockReturnValue(null);
      manager.elementSelector.isOurElement.mockReturnValue(false);
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'target', { value: host });
      event.composedPath = () => [internal, shadow, host, document, window];

      await manager.handleClick(event);

      expect(manager.domTranslatorAdapter.translateElement).toHaveBeenCalledWith(host, expect.any(Object));
    });

    it('still forwards BUTTON to the adapter', async () => {
      const btn = document.createElement('button');
      manager.elementSelector.getHighlightedElement.mockReturnValue(btn);

      await manager.handleClick(new MouseEvent('click'));

      expect(manager.domTranslatorAdapter.translateElement).toHaveBeenCalledWith(btn, expect.any(Object));
    });

    it('returns silently for an invalid root', async () => {
      const el = document.createElement('div');
      manager.elementSelector.getHighlightedElement.mockReturnValue(el);
      isSelectableTextRoot.mockReturnValue(false);

      await manager.handleClick(new MouseEvent('click'));

      expect(manager.domTranslatorAdapter.translateElement).not.toHaveBeenCalled();
      expect(errorHandler.handle).not.toHaveBeenCalled();
      expect(manager.isProcessingClick).toBe(false);
    });

    it('does not consult provider/config during click validation', async () => {
      const { getEffectiveProviderAsync } = await import('@/shared/config/config.js');
      getEffectiveProviderAsync.mockClear();
      const el = document.createElement('div');
      manager.elementSelector.getHighlightedElement.mockReturnValue(el);
      isSelectableTextRoot.mockReturnValue(false);

      await manager.handleClick(new MouseEvent('click'));

      expect(getEffectiveProviderAsync).not.toHaveBeenCalled();
    });
  });

  describe('translation failure classification', () => {
    let cleanupSpy;

    beforeEach(() => {
      manager.isActive = true;
      cleanupSpy = vi.spyOn(manager, 'performPostTranslationCleanup').mockImplementation(() => {});
    });

    it('shows validation failures as visible errors', async () => {
      const error = Object.assign(new Error('V3 marker contract violation'), { type: 'VALIDATION' });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      expect(errorHandler.handle).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Translation failed',
        type: 'TRANSLATION_FAILED',
        cause: error,
      }), expect.objectContaining({ context: 'select-element', showToast: true }));
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'error' });
      expect(manager.logger.warn).toHaveBeenCalledWith('Select Element translation failed:', error);
    });

    it('shows V3 empty interval failures as visible errors', async () => {
      const error = Object.assign(new Error('V3_EMPTY_TRANSLATED_INTERVAL'), { type: 'VALIDATION' });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      expect(errorHandler.handle).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Translation failed',
        type: 'TRANSLATION_FAILED',
        cause: error,
      }), expect.objectContaining({ showToast: true }));
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'error' });
    });

    it('shows one informational message for no-content; not an error or cancellation', async () => {
      const error = Object.assign(new Error('No translatable text found'), { type: ErrorTypes.NO_TRANSLATABLE_CONTENT });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      expect(errorHandler.handle).not.toHaveBeenCalled();
      const ExtensionContextManager = (await import('@/core/extensionContext.js')).default;
      expect(ExtensionContextManager.handleContextError).not.toHaveBeenCalled();
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'no-content' });
      expect(manager.logger.debug).toHaveBeenCalledWith('Select Element translation completed with no translatable content:', error.message);

      const { pageEventBus } = await import('@/core/PageEventBus.js');
      const infoCalls = pageEventBus.emit.mock.calls.filter(([event]) => event === 'show-select-element-info');
      expect(infoCalls).toHaveLength(1);
      expect(infoCalls[0][1]).toEqual(expect.objectContaining({
        message: 'No translatable text was found in this element.',
      }));
    });

    it('shows the capability-specific message for UNSUPPORTED_MODE; still no error pipeline', async () => {
      const { SelectElementReason } = await import('./core/SelectElementPolicy.js');
      const error = Object.assign(new Error('Selected content is not supported by the current extraction mode'), {
        type: ErrorTypes.NO_TRANSLATABLE_CONTENT,
        reason: SelectElementReason.UNSUPPORTED_MODE,
      });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      expect(errorHandler.handle).not.toHaveBeenCalled();
      const ExtensionContextManager = (await import('@/core/extensionContext.js')).default;
      expect(ExtensionContextManager.handleContextError).not.toHaveBeenCalled();
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'no-content' });

      const { pageEventBus } = await import('@/core/PageEventBus.js');
      const infoCalls = pageEventBus.emit.mock.calls.filter(([event]) => event === 'show-select-element-info');
      expect(infoCalls).toHaveLength(1);
      expect(infoCalls[0][1]).toEqual(expect.objectContaining({
        message: 'This content cannot be translated with the current translation mode.',
      }));
      expect(infoCalls[0][1].message).not.toBe('No translatable text was found in this element.');
    });

    it('shows the same informational UX regardless of the diagnostic message', async () => {
      const error = Object.assign(new Error('different diagnostic text'), { type: ErrorTypes.NO_TRANSLATABLE_CONTENT });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      expect(errorHandler.handle).not.toHaveBeenCalled();
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'no-content' });
      const { pageEventBus } = await import('@/core/PageEventBus.js');
      const infoCalls = pageEventBus.emit.mock.calls.filter(([event]) => event === 'show-select-element-info');
      expect(infoCalls).toHaveLength(1);
    });

    it('keeps unrelated VALIDATION failures visible (message is not the discriminator)', async () => {
      const error = Object.assign(new Error('some unrelated validation failure'), { type: 'VALIDATION' });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      expect(errorHandler.handle).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Translation failed',
        type: 'TRANSLATION_FAILED',
        cause: error,
      }), expect.objectContaining({ showToast: true }));
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'error' });
      const { pageEventBus } = await import('@/core/PageEventBus.js');
      expect(pageEventBus.emit).not.toHaveBeenCalledWith('show-select-element-info', expect.anything());
      const ExtensionContextManager = (await import('@/core/extensionContext.js')).default;
      expect(ExtensionContextManager.handleContextError).not.toHaveBeenCalled();
    });

    it('keeps user cancellation silent', async () => {
      const { isCancellationError } = await import('@/shared/error-management/ErrorMatcher.js');
      isCancellationError.mockReturnValueOnce(true);
      const error = Object.assign(new Error('cancelled'), { type: 'USER_CANCELLED' });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      expect(errorHandler.handle).not.toHaveBeenCalled();
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'cancel' });
      const { pageEventBus } = await import('@/core/PageEventBus.js');
      expect(pageEventBus.emit).not.toHaveBeenCalledWith('show-select-element-info', expect.anything());
      const ExtensionContextManager = (await import('@/core/extensionContext.js')).default;
      expect(ExtensionContextManager.handleContextError).not.toHaveBeenCalled();
    });

    it.each(['operation-abort', 'System cleanup', 'lifecycle-cleanup', 'document-replaced', 'replacement'])('keeps internal operation abort silent for %s', async (cancellationReason) => {
        const error = Object.assign(new Error('Translation operation aborted'), {
          operationAborted: true,
          cancellationReason,
          translationOutcome: {
            committedParentCount: 0,
            totalParentCount: 1,
            cancelled: false,
          },
        });
        manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

        await manager.startTranslation(document.createElement('div'));

        expect(errorHandler.handle).not.toHaveBeenCalled();
        expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'cancel' });
        const ExtensionContextManager = (await import('@/core/extensionContext.js')).default;
        expect(ExtensionContextManager.handleContextError).not.toHaveBeenCalled();
      });

    it.each([ErrorTypes.TRANSLATION_ERROR, ErrorTypes.TRANSLATION_FAILED, ErrorTypes.UNKNOWN])('keeps operation abort silent with generic placeholder type %s', async (type) => {
        const error = Object.assign(new Error('Translation operation aborted'), {
          type,
          operationAborted: true,
          cancellationReason: 'operation-abort',
          translationOutcome: {
            committedParentCount: 0,
            totalParentCount: 1,
            cancelled: false,
          },
        });
        manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

        await manager.startTranslation(document.createElement('div'));

        expect(errorHandler.handle).not.toHaveBeenCalled();
        expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'cancel' });
      });

    it('keeps internal operation abort silent after positive commit', async () => {
      const error = Object.assign(new Error('Translation operation aborted'), {
        operationAborted: true,
        cancellationReason: 'System cleanup',
        translationOutcome: {
          committedParentCount: 1,
          totalParentCount: 2,
          cancelled: false,
        },
      });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      expect(errorHandler.handle).not.toHaveBeenCalled();
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'cancel' });
    });

    it('keeps typed timeout visible when operation abort provenance is present', async () => {
      const error = Object.assign(new Error('Timed out'), {
        name: 'AbortError',
        type: ErrorTypes.TRANSLATION_TIMEOUT,
        operationAborted: true,
        cancellationReason: 'operation-abort',
        translationOutcome: {
          committedParentCount: 0,
          totalParentCount: 1,
          cancelled: false,
        },
      });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      expect(errorHandler.handle).toHaveBeenCalledTimes(1);
      expect(errorHandler.handle).toHaveBeenCalledWith(expect.objectContaining({ cause: error }), expect.objectContaining({ showToast: true }));
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'error' });
    });

    it.each([ErrorTypes.NETWORK_ERROR, ErrorTypes.HTTP_ERROR, ErrorTypes.API_CONFIG_INVALID])('keeps typed terminal error visible with operation abort provenance: %s', async (type) => {
        const error = Object.assign(new Error('Typed terminal failure'), {
          name: 'AbortError',
          type,
          operationAborted: true,
          cancellationReason: 'operation-abort',
          translationOutcome: {
            committedParentCount: 0,
            totalParentCount: 1,
            cancelled: false,
          },
        });
        manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

        await manager.startTranslation(document.createElement('div'));

        expect(errorHandler.handle).toHaveBeenCalledTimes(1);
        expect(errorHandler.handle).toHaveBeenCalledWith(expect.objectContaining({ cause: error }), expect.objectContaining({ showToast: true }));
        expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'error' });
      });

    it('keeps a bare AbortError visible without operation abort provenance', async () => {
      const error = Object.assign(new Error('Aborted request'), {
        name: 'AbortError',
        translationOutcome: {
          committedParentCount: 0,
          totalParentCount: 1,
          cancelled: false,
        },
      });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      expect(errorHandler.handle).toHaveBeenCalledTimes(1);
      expect(errorHandler.handle).toHaveBeenCalledWith(expect.objectContaining({ cause: error }), expect.objectContaining({ showToast: true }));
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'error' });
    });

    it('keeps stale cancellation results silent', async () => {
      const deactivateSpy = vi.spyOn(manager, 'deactivate').mockImplementation(() => {});
      manager.domTranslatorAdapter.translateElement.mockResolvedValue({ success: false, cancelled: true });

      await manager.startTranslation(document.createElement('div'));

      expect(errorHandler.handle).not.toHaveBeenCalled();
      expect(deactivateSpy).toHaveBeenCalledWith({ reason: 'cancel', silent: true });
    });

    it('respects a central silent policy without skipping cleanup', async () => {
      const error = Object.assign(new Error('Already translated'), { type: 'NODE_ALREADY_TRANSLATED' });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      const { mapCanonicalTranslationError } = await import('@/shared/error-management/PublicTranslationErrorPolicy.js');
      const { createLegacyDisplayError } = await import('@/shared/error-management/PublicTranslationErrorAdapter.js');
      expect(errorHandler.handle).not.toHaveBeenCalled();
      expect(mapCanonicalTranslationError).not.toHaveBeenCalled();
      expect(createLegacyDisplayError).not.toHaveBeenCalled();
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'error' });
    });

    it('keeps provider failures visible', async () => {
      const error = Object.assign(new Error('Network failed'), { type: 'NETWORK_ERROR' });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      const { mapCanonicalTranslationError } = await import('@/shared/error-management/PublicTranslationErrorPolicy.js');
      const { createLegacyDisplayError } = await import('@/shared/error-management/PublicTranslationErrorAdapter.js');
      const ExtensionContextManager = (await import('@/core/extensionContext.js')).default;
      expect(mapCanonicalTranslationError).toHaveBeenCalledWith(error);
      expect(createLegacyDisplayError).toHaveBeenCalledWith(error, expect.objectContaining({ type: 'NETWORK_ERROR' }));
      expect(errorHandler.handle).toHaveBeenCalledWith(expect.objectContaining({ cause: error }), expect.objectContaining({ showToast: true }));
      expect(errorHandler.handle).toHaveBeenCalledTimes(1);
      expect(ExtensionContextManager.handleContextError).not.toHaveBeenCalled();
      const { pageEventBus } = await import('@/core/PageEventBus.js');
      expect(pageEventBus.emit).not.toHaveBeenCalledWith('show-select-element-info', expect.anything());
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'error' });
    });

    it.each([
      [ErrorTypes.API_URL_MISSING, 'API_URL_MISSING', 'API URL is missing. Please enter it in settings.'],
      [ErrorTypes.API_CONFIG_INVALID, 'API_CONFIG_INVALID', 'Invalid API configuration. Please check your settings.'],
      [ErrorTypes.API_ENDPOINT_INVALID, 'API_ENDPOINT_INVALID', 'API Endpoint not found (404). Please check your URL.'],
      [ErrorTypes.BROWSER_API_UNAVAILABLE, 'BROWSER_API_UNAVAILABLE', 'The translation API is not available or supported in this browser'],
      [ErrorTypes.FORBIDDEN_ERROR, 'FORBIDDEN_ERROR', 'Access denied. Check permissions or potential content moderation.'],
      [ErrorTypes.CIRCUIT_BREAKER_OPEN, 'CIRCUIT_BREAKER_OPEN', 'Circuit breaker is open. This provider is temporarily disabled due to too many failures.'],
    ])('preserves localized config/access display for %s', async (type, legacyType, message) => {
      const error = Object.assign(new Error(`raw canonical detail for ${type}`), { type });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);
      const { isFatalError } = await import('@/shared/error-management/ErrorMatcher.js');
      isFatalError.mockReturnValueOnce(true);

      await manager.startTranslation(document.createElement('div'));

      const { mapCanonicalTranslationError } = await import('@/shared/error-management/PublicTranslationErrorPolicy.js');
      const { createLegacyDisplayError } = await import('@/shared/error-management/PublicTranslationErrorAdapter.js');
      expect(mapCanonicalTranslationError).toHaveBeenCalledWith(error);
      expect(createLegacyDisplayError).toHaveBeenCalled();
      expect(errorHandler.handle).toHaveBeenCalledWith(
        expect.objectContaining({ type: legacyType, message, cause: error }),
        expect.objectContaining({ context: 'select-element', showToast: true })
      );
      expect(errorHandler.handle.mock.calls[0][0].message).not.toContain('raw canonical detail');
      expect(errorHandler.handle).toHaveBeenCalledTimes(1);
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'error' });
    });

    it('migrates circuit-breaker failures without copying reason metadata', async () => {
      const error = Object.assign(new Error('raw provider detail'), {
        type: ErrorTypes.CIRCUIT_BREAKER_OPEN,
        originalType: ErrorTypes.NETWORK_ERROR,
        statusCode: 503,
        providerName: 'Provider',
      });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);
      const { isFatalError } = await import('@/shared/error-management/ErrorMatcher.js');
      isFatalError.mockReturnValueOnce(true);

      await manager.startTranslation(document.createElement('div'));

      const { mapCanonicalTranslationError } = await import('@/shared/error-management/PublicTranslationErrorPolicy.js');
      const { createLegacyDisplayError } = await import('@/shared/error-management/PublicTranslationErrorAdapter.js');
      expect(mapCanonicalTranslationError).toHaveBeenCalledWith(error);
      expect(createLegacyDisplayError).toHaveBeenCalledWith(error, expect.objectContaining({
        type: 'PROVIDER_TEMPORARILY_UNAVAILABLE',
        messageKey: 'ERRORS_CIRCUIT_BREAKER_OPEN',
        severity: 'warning',
        silent: false,
      }));
      const displayError = errorHandler.handle.mock.calls[0][0];
      expect(displayError).toMatchObject({
        type: ErrorTypes.CIRCUIT_BREAKER_OPEN,
        message: 'Circuit breaker is open. This provider is temporarily disabled due to too many failures.',
        cause: error,
      });
      expect(displayError).not.toHaveProperty('originalType');
      expect(displayError).not.toHaveProperty('statusCode');
      expect(displayError).not.toHaveProperty('providerName');
      expect(displayError.message).not.toContain('raw provider detail');
      expect(errorHandler.handle).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ context: 'select-element', showToast: true })
      );
      expect(errorHandler.handle).toHaveBeenCalledTimes(1);
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'error' });
    });

    it('migrates translation-not-found without retry or fatal deactivation', async () => {
      const error = Object.assign(new Error('raw provider detail'), {
        type: ErrorTypes.TRANSLATION_NOT_FOUND,
        originalType: ErrorTypes.NETWORK_ERROR,
        statusCode: 404,
        providerName: 'Provider',
        translationOutcome: { committedParentCount: 0 },
      });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);
      const deactivateSpy = vi.spyOn(manager, 'deactivate').mockResolvedValue(undefined);

      await manager.startTranslation(document.createElement('div'));

      const { mapCanonicalTranslationError } = await import('@/shared/error-management/PublicTranslationErrorPolicy.js');
      const { createLegacyDisplayError } = await import('@/shared/error-management/PublicTranslationErrorAdapter.js');
      const { getErrorDisplayStrategy } = await import('@/shared/error-management/ErrorDisplayStrategies.js');
      expect(mapCanonicalTranslationError).toHaveBeenCalledWith(error);
      expect(createLegacyDisplayError).toHaveBeenCalledWith(error, expect.objectContaining({
        type: 'TRANSLATION_NOT_FOUND',
        messageKey: 'ERRORS_TRANSLATION_NOT_FOUND',
        severity: 'error',
        silent: false,
      }));
      const displayError = errorHandler.handle.mock.calls[0][0];
      expect(displayError).toMatchObject({
        type: ErrorTypes.TRANSLATION_NOT_FOUND,
        message: 'Translation not found',
        cause: error,
      });
      expect(displayError).not.toHaveProperty('originalType');
      expect(displayError).not.toHaveProperty('statusCode');
      expect(displayError).not.toHaveProperty('providerName');
      expect(displayError).not.toHaveProperty('translationOutcome');
      expect(displayError.message).not.toContain('raw provider detail');
      expect(getErrorDisplayStrategy('select-element', ErrorTypes.TRANSLATION_NOT_FOUND)).toMatchObject({
        showToast: true,
        supportRetry: false,
        supportSettings: true,
      });
      expect(errorHandler.handle).toHaveBeenCalledTimes(1);
      expect(deactivateSpy).not.toHaveBeenCalled();
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'error' });
    });

    it.each([
      [ErrorTypes.TEXT_EMPTY, 'TEXT_EMPTY', 'Text is empty'],
      [ErrorTypes.TEXT_TOO_LONG, 'TEXT_TOO_LONG', 'Text is too long'],
      [ErrorTypes.PROMPT_INVALID, 'PROMPT_INVALID', 'Prompt is invalid'],
    ])('preserves localized input display for %s', async (type, legacyType, message) => {
      const error = Object.assign(new Error(`raw canonical detail for ${type}`), { type });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      const { mapCanonicalTranslationError } = await import('@/shared/error-management/PublicTranslationErrorPolicy.js');
      const { createLegacyDisplayError } = await import('@/shared/error-management/PublicTranslationErrorAdapter.js');
      expect(mapCanonicalTranslationError).toHaveBeenCalledWith(error);
      expect(createLegacyDisplayError).toHaveBeenCalled();
      expect(errorHandler.handle).toHaveBeenCalledWith(
        expect.objectContaining({ type: legacyType, message, cause: error }),
        expect.objectContaining({ context: 'select-element', showToast: true })
      );
      expect(errorHandler.handle.mock.calls[0][0].message).not.toContain('raw canonical detail');
      expect(errorHandler.handle).toHaveBeenCalledTimes(1);
    });

    it('preserves language-pair guidance and fatal cleanup', async () => {
      const error = Object.assign(new Error('raw language-pair detail'), {
        type: ErrorTypes.LANGUAGE_PAIR_NOT_SUPPORTED,
      });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);
      const { isFatalError } = await import('@/shared/error-management/ErrorMatcher.js');
      isFatalError.mockReturnValueOnce(true);

      await manager.startTranslation(document.createElement('div'));

      const { mapCanonicalTranslationError } = await import('@/shared/error-management/PublicTranslationErrorPolicy.js');
      const { createLegacyDisplayError } = await import('@/shared/error-management/PublicTranslationErrorAdapter.js');
      const { getErrorDisplayStrategy } = await import('@/shared/error-management/ErrorDisplayStrategies.js');
      expect(mapCanonicalTranslationError).toHaveBeenCalledWith(error);
      expect(createLegacyDisplayError).toHaveBeenCalledWith(error, expect.objectContaining({
        type: 'LANGUAGE_PAIR_UNSUPPORTED',
        messageKey: 'ERRORS_LANGUAGE_PAIR_NOT_SUPPORTED',
        silent: false,
      }));
      expect(errorHandler.handle).toHaveBeenCalledWith(
        expect.objectContaining({
          type: ErrorTypes.LANGUAGE_PAIR_NOT_SUPPORTED,
          message: 'Language pair not supported by the selected translation service',
          cause: error,
        }),
        expect.objectContaining({ context: 'select-element', showToast: true })
      );
      expect(errorHandler.handle.mock.calls[0][0].message).not.toContain('raw language-pair detail');
      expect(getErrorDisplayStrategy('select-element', ErrorTypes.LANGUAGE_PAIR_NOT_SUPPORTED)).toMatchObject({
        supportSettings: true,
        supportRetry: false,
        suggestAction: 'change-provider',
      });
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'error' });
      expect(errorHandler.handle).toHaveBeenCalledTimes(1);
    });

    it.each([
      ErrorTypes.MODEL_MISSING,
      ErrorTypes.API_ERROR,
      ErrorTypes.API_KEY_MISSING,
      ErrorTypes.API_KEY_INVALID,
      ErrorTypes.QUOTA_EXCEEDED,
      ErrorTypes.VALIDATION,
      ErrorTypes.ELEMENT_TOO_LARGE,
      ErrorTypes.GEMINI_QUOTA_REGION,
      ErrorTypes.DEEPL_QUOTA_EXCEEDED,
      ErrorTypes.INSUFFICIENT_BALANCE,
      ErrorTypes.RATE_LIMIT_REACHED,
      ErrorTypes.MODEL_OVERLOADED,
      ErrorTypes.NETWORK_ERROR,
      ErrorTypes.SERVER_ERROR,
      ErrorTypes.TRANSLATION_TIMEOUT,
      ErrorTypes.OPERATION_TIMEOUT,
      ErrorTypes.INVALID_REQUEST,
      ErrorTypes.TRANSLATION_FAILED,
      ErrorTypes.UNKNOWN,
      ErrorTypes.API_RESPONSE_INVALID,
      ErrorTypes.JSON_PARSING_ERROR,
      ErrorTypes.UNEXPECTED_RESPONSE_FORMAT,
      ErrorTypes.HTML_RESPONSE_ERROR,
      ErrorTypes.TRANSLATION_ERROR,
      ErrorTypes.CONNECTION_LOST,
      ErrorTypes.NO_ACCEPTED_TRANSLATION_RESULTS,
      ErrorTypes.API_URL_MISSING,
      ErrorTypes.API_CONFIG_INVALID,
      ErrorTypes.API_ENDPOINT_INVALID,
      ErrorTypes.BROWSER_API_UNAVAILABLE,
      ErrorTypes.FORBIDDEN_ERROR,
      ErrorTypes.TEXT_EMPTY,
      ErrorTypes.TEXT_TOO_LONG,
      ErrorTypes.PROMPT_INVALID,
      ErrorTypes.LANGUAGE_PAIR_NOT_SUPPORTED,
      ErrorTypes.CIRCUIT_BREAKER_OPEN,
      ErrorTypes.TRANSLATION_NOT_FOUND,
    ])('uses new public contract for safe type %s', async (type) => {
      const error = Object.assign(new Error(`raw internal detail for ${type}`), { type });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      const { mapCanonicalTranslationError } = await import('@/shared/error-management/PublicTranslationErrorPolicy.js');
      const { createLegacyDisplayError } = await import('@/shared/error-management/PublicTranslationErrorAdapter.js');
      const expectedPublicType = {
        API_ERROR: 'API_FAILURE',
        VALIDATION: 'INVALID_INPUT',
        UNKNOWN: 'TRANSLATION_FAILED',
        API_RESPONSE_INVALID: 'INVALID_RESPONSE',
        JSON_PARSING_ERROR: 'INVALID_RESPONSE',
        UNEXPECTED_RESPONSE_FORMAT: 'INVALID_RESPONSE',
        HTML_RESPONSE_ERROR: 'TRANSLATION_FAILED',
        TRANSLATION_ERROR: 'TRANSLATION_FAILED',
        CONNECTION_LOST: 'TRANSLATION_FAILED',
        NO_ACCEPTED_TRANSLATION_RESULTS: 'TRANSLATION_FAILED',
        API_URL_MISSING: 'API_URL_MISSING',
        API_CONFIG_INVALID: 'CONFIGURATION_INVALID',
        API_ENDPOINT_INVALID: 'ENDPOINT_INVALID',
        BROWSER_API_UNAVAILABLE: 'BROWSER_API_UNAVAILABLE',
        FORBIDDEN_ERROR: 'ACCESS_DENIED',
        TEXT_EMPTY: 'TEXT_EMPTY',
        TEXT_TOO_LONG: 'TEXT_TOO_LONG',
        PROMPT_INVALID: 'PROMPT_INVALID',
        LANGUAGE_PAIR_NOT_SUPPORTED: 'LANGUAGE_PAIR_UNSUPPORTED',
        MODEL_MISSING: 'MODEL_UNAVAILABLE',
        API_KEY_MISSING: 'API_KEY_MISSING',
        API_KEY_INVALID: 'API_KEY_INVALID',
        QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
        INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
        RATE_LIMIT_REACHED: 'RATE_LIMITED',
        MODEL_OVERLOADED: 'MODEL_OVERLOADED',
        NETWORK_ERROR: 'NETWORK_ERROR',
        SERVER_ERROR: 'SERVER_ERROR',
        TRANSLATION_TIMEOUT: 'TRANSLATION_TIMEOUT',
        OPERATION_TIMEOUT: 'TRANSLATION_TIMEOUT',
        INVALID_REQUEST: 'INVALID_REQUEST',
        CIRCUIT_BREAKER_OPEN: 'PROVIDER_TEMPORARILY_UNAVAILABLE',
        TRANSLATION_NOT_FOUND: 'TRANSLATION_NOT_FOUND',
       }[type] || type;
      expect(mapCanonicalTranslationError).toHaveBeenCalledWith(error);
      expect(createLegacyDisplayError).toHaveBeenCalledWith(error, expect.objectContaining({ type: expectedPublicType }));
      expect(errorHandler.handle).toHaveBeenCalledTimes(1);
      if ([
        ErrorTypes.HTML_RESPONSE_ERROR,
        ErrorTypes.TRANSLATION_ERROR,
        ErrorTypes.CONNECTION_LOST,
        ErrorTypes.NO_ACCEPTED_TRANSLATION_RESULTS,
      ].includes(type)) {
        expect(errorHandler.handle.mock.calls[0][0].type).toBe(ErrorTypes.TRANSLATION_FAILED);
        expect(errorHandler.handle.mock.calls[0][0].message).toBe('Translation failed');
        expect(errorHandler.handle.mock.calls[0][0].message).not.toContain('raw internal detail');
      }
    });

    it.each([
      [ErrorTypes.HTTP_ERROR, { statusCode: 400 }],
      [ErrorTypes.HTTP_ERROR, { statusCode: 401 }],
      [ErrorTypes.HTTP_ERROR, { statusCode: 429 }],
      [ErrorTypes.HTTP_ERROR, { statusCode: 500 }],
      [ErrorTypes.HTTP_ERROR, { statusCode: 400, originalType: 'UNRELATED_TYPE' }],
    ])('routes generic HTTP type %s through new public policy', async (type, fields) => {
      const error = Object.assign(new Error(type), { type, ...fields });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      const { mapCanonicalTranslationError } = await import('@/shared/error-management/PublicTranslationErrorPolicy.js');
      const { createLegacyDisplayError } = await import('@/shared/error-management/PublicTranslationErrorAdapter.js');
      expect(mapCanonicalTranslationError).toHaveBeenCalledWith(error);
      expect(createLegacyDisplayError).toHaveBeenCalledWith(error, expect.objectContaining({
        type: 'REQUEST_FAILURE',
        messageKey: 'ERRORS_HTTP_ERROR',
      }));
      expect(errorHandler.handle).toHaveBeenCalledWith(
        expect.objectContaining({
          type: ErrorTypes.HTTP_ERROR,
          message: 'HTTP error',
          cause: error,
        }),
        expect.objectContaining({ context: 'select-element', showToast: true })
      );
      expect(errorHandler.handle).toHaveBeenCalledTimes(1);
    });

    it('migrates trusted unknown-model HTTP failures', async () => {
      const error = Object.assign(new Error('Unknown model name; available models: secret-model'), {
        type: ErrorTypes.HTTP_ERROR,
        originalType: ErrorTypes.MODEL_MISSING,
        statusCode: 400,
      });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      const { mapCanonicalTranslationError } = await import('@/shared/error-management/PublicTranslationErrorPolicy.js');
      const { createLegacyDisplayError } = await import('@/shared/error-management/PublicTranslationErrorAdapter.js');
      expect(mapCanonicalTranslationError).toHaveBeenCalledWith(error);
      expect(mapCanonicalTranslationError.mock.results[0].value).toMatchObject({
        type: 'MODEL_UNAVAILABLE',
        messageKey: 'ERRORS_MODEL_MISSING',
      });
      expect(createLegacyDisplayError).toHaveBeenCalledWith(error, expect.objectContaining({
        type: 'MODEL_UNAVAILABLE',
        messageKey: 'ERRORS_MODEL_MISSING',
      }));
      expect(errorHandler.handle).toHaveBeenCalledWith(
        expect.objectContaining({
          type: ErrorTypes.MODEL_MISSING,
          message: 'AI Model is missing or invalid',
          cause: error,
        }),
        expect.objectContaining({ context: 'select-element', showToast: true })
      );
      expect(errorHandler.handle.mock.calls[0][0].message).not.toContain('available models');
    });

    it('preserves committed content while routing non-context fatal errors through error deactivation', async () => {
      const error = Object.assign(new Error('API key is invalid'), {
        type: ErrorTypes.API_KEY_INVALID,
      });
      const { mapCanonicalTranslationError } = await import('@/shared/error-management/PublicTranslationErrorPolicy.js');
      const { createLegacyDisplayError } = await import('@/shared/error-management/PublicTranslationErrorAdapter.js');
      const { isFatalError } = await import('@/shared/error-management/ErrorMatcher.js');
      isFatalError.mockReturnValueOnce(true);
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      expect(mapCanonicalTranslationError).toHaveBeenCalledWith(error);
      expect(createLegacyDisplayError).toHaveBeenCalledWith(error, expect.objectContaining({ type: ErrorTypes.API_KEY_INVALID }));
      expect(errorHandler.handle).toHaveBeenCalledTimes(1);
      expect(errorHandler.handle).toHaveBeenCalledWith(
        expect.objectContaining({ type: ErrorTypes.API_KEY_INVALID, cause: error }),
        expect.objectContaining({ context: 'select-element', showToast: true })
      );
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'error' });
      expect(manager.domTranslatorAdapter.cancelTranslation).not.toHaveBeenCalled();
      expect(manager.domTranslatorAdapter.revertTranslation).not.toHaveBeenCalled();
      const ExtensionContextManager = (await import('@/core/extensionContext.js')).default;
      expect(ExtensionContextManager.handleContextError).not.toHaveBeenCalled();
      const { pageEventBus } = await import('@/core/PageEventBus.js');
      expect(pageEventBus.emit).not.toHaveBeenCalledWith('show-select-element-info', expect.anything());
      expect(pageEventBus.emit).not.toHaveBeenCalledWith('cancel-select-element-mode');
    });

    it('keeps context failures on ExtensionContextManager instead of the generic fatal branch', async () => {
      const ExtensionContextManager = (await import('@/core/extensionContext.js')).default;
      const error = Object.assign(new Error('Extension context invalidated'), {
        type: ErrorTypes.EXTENSION_CONTEXT_INVALIDATED,
      });
      const deactivateSpy = vi.spyOn(manager, 'deactivate').mockResolvedValue(undefined);
      ExtensionContextManager.isContextError.mockReturnValue(true);
      const { isFatalError } = await import('@/shared/error-management/ErrorMatcher.js');

      try {
        isFatalError.mockReturnValue(true);
        manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

        await manager.startTranslation(document.createElement('div'));

        expect(ExtensionContextManager.handleContextError).toHaveBeenCalledWith(error, 'element-selection');
        expect(errorHandler.handle).not.toHaveBeenCalled();
        expect(deactivateSpy).not.toHaveBeenCalled();
        expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'cancel' });
      } finally {
        ExtensionContextManager.isContextError.mockReturnValue(false);
        isFatalError.mockReturnValue(false);
      }
    });

    it('keeps FEATURE_BLOCKED as a silent defensive skip', async () => {
      const error = Object.assign(new Error('Translation already in progress for this element'), {
        type: ErrorTypes.FEATURE_BLOCKED,
      });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      expect(errorHandler.handle).not.toHaveBeenCalled();
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'cancel' });
      expect(manager.domTranslatorAdapter.revertTranslation).not.toHaveBeenCalled();
      expect(manager.logger.debug).toHaveBeenCalledWith(
        'Select Element translation skipped:',
        error.message
      );
      const { pageEventBus } = await import('@/core/PageEventBus.js');
      expect(pageEventBus.emit).not.toHaveBeenCalledWith('show-select-element-info', expect.anything());
      const ExtensionContextManager = (await import('@/core/extensionContext.js')).default;
      expect(ExtensionContextManager.handleContextError).not.toHaveBeenCalled();
    });

    it.each([
      ['API key', 'API_KEY_INVALID'],
      ['rate limit', 'RATE_LIMIT_REACHED'],
    ])('preserves actionable %s handling', async (_label, type) => {
      const error = Object.assign(new Error(type), { type });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      const { mapCanonicalTranslationError } = await import('@/shared/error-management/PublicTranslationErrorPolicy.js');
      const { createLegacyDisplayError } = await import('@/shared/error-management/PublicTranslationErrorAdapter.js');
      expect(mapCanonicalTranslationError).toHaveBeenCalledWith(error);
      expect(createLegacyDisplayError).toHaveBeenCalledWith(error, expect.objectContaining({
        type: type === 'RATE_LIMIT_REACHED' ? 'RATE_LIMITED' : type,
      }));
      expect(errorHandler.handle).toHaveBeenCalledWith(expect.objectContaining({ cause: error }), expect.objectContaining({ showToast: true }));
    });

    it('preserves total timeout handling while hiding raw timeout text', async () => {
      const error = Object.assign(new Error('Batch translation timed out after 60000ms'), { type: 'TRANSLATION_TIMEOUT' });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      const { mapCanonicalTranslationError } = await import('@/shared/error-management/PublicTranslationErrorPolicy.js');
      const { createLegacyDisplayError } = await import('@/shared/error-management/PublicTranslationErrorAdapter.js');
      expect(mapCanonicalTranslationError).toHaveBeenCalledWith(error);
      expect(createLegacyDisplayError).toHaveBeenCalledWith(error, expect.objectContaining({ type: 'TRANSLATION_TIMEOUT' }));
      expect(errorHandler.handle).toHaveBeenCalledWith(expect.objectContaining({ cause: error }), expect.objectContaining({ showToast: true }));
    });

    it('routes typed element-too-large through the central public-error boundary', async () => {
      const error = Object.assign(new Error('Element is too large to translate (1001 text segments). Please select a smaller element.'), {
        type: ErrorTypes.ELEMENT_TOO_LARGE,
      });
      const { mapCanonicalTranslationError } = await import('@/shared/error-management/PublicTranslationErrorPolicy.js');
      const { createLegacyDisplayError } = await import('@/shared/error-management/PublicTranslationErrorAdapter.js');
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      expect(mapCanonicalTranslationError).toHaveBeenCalledWith(error);
      expect(createLegacyDisplayError).toHaveBeenCalledWith(error, expect.objectContaining({
        type: 'ELEMENT_TOO_LARGE',
        messageKey: 'ERRORS_ELEMENT_TOO_LARGE',
      }));
      expect(errorHandler.handle).toHaveBeenCalledWith(
        expect.objectContaining({ type: ErrorTypes.ELEMENT_TOO_LARGE }),
        expect.objectContaining({ context: 'select-element', showToast: true })
      );
      expect(errorHandler.handle).toHaveBeenCalledTimes(1);
      expect(errorHandler.handle.mock.calls[0][0]).toMatchObject({
        type: ErrorTypes.ELEMENT_TOO_LARGE,
        message: 'This element is too large to translate at once.',
        cause: error,
      });
      expect(errorHandler.handle.mock.calls[0][0]).not.toBe(error);
      expect(errorHandler.handle.mock.calls[0][0].message).not.toContain('1001');
      expect(errorHandler.handle.mock.calls[0][0].message).not.toContain('text segments');
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'error' });
      const { pageEventBus } = await import('@/core/PageEventBus.js');
      expect(pageEventBus.emit).not.toHaveBeenCalledWith('show-select-element-info', expect.anything());
      const ExtensionContextManager = (await import('@/core/extensionContext.js')).default;
      expect(ExtensionContextManager.handleContextError).not.toHaveBeenCalled();
    });

    it('routes untyped errors through generic new public mapping', async () => {
      const error = new Error('Element is too large to translate (1001 text segments). Please select a smaller element.');
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      const { mapCanonicalTranslationError } = await import('@/shared/error-management/PublicTranslationErrorPolicy.js');
      const { createLegacyDisplayError } = await import('@/shared/error-management/PublicTranslationErrorAdapter.js');
      expect(mapCanonicalTranslationError).toHaveBeenCalledWith(error);
      expect(createLegacyDisplayError).toHaveBeenCalledWith(error, expect.objectContaining({
        messageKey: 'ERRORS_TRANSLATION_FAILED',
        silent: false,
      }));
      expect(errorHandler.handle).toHaveBeenCalledWith(expect.objectContaining({
        type: 'TRANSLATION_FAILED',
        cause: error,
      }), expect.objectContaining({ showToast: true }));
      expect(errorHandler.handle.mock.calls[0][0].message).toBe('Translation failed');
      expect(errorHandler.handle.mock.calls[0][0].message).not.toContain(error.message);
      expect(errorHandler.handle).toHaveBeenCalledTimes(1);
      expect(errorHandler.handle.mock.calls[0][0]).not.toBe(error);
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'error' });
    });

    it('routes unrecognized explicit types through generic new public mapping', async () => {
      const error = Object.assign(new Error('raw unrecognized detail'), { type: 'UNRECOGNIZED_TYPE' });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      const { mapCanonicalTranslationError } = await import('@/shared/error-management/PublicTranslationErrorPolicy.js');
      const { createLegacyDisplayError } = await import('@/shared/error-management/PublicTranslationErrorAdapter.js');
      expect(mapCanonicalTranslationError).toHaveBeenCalledWith(error);
      expect(createLegacyDisplayError).toHaveBeenCalledWith(error, expect.objectContaining({
        type: 'TRANSLATION_FAILED',
        messageKey: 'ERRORS_TRANSLATION_FAILED',
        silent: false,
      }));
      expect(errorHandler.handle).toHaveBeenCalledWith(expect.objectContaining({
        type: 'TRANSLATION_FAILED',
        message: 'Translation failed',
        cause: error,
      }), expect.objectContaining({ context: 'select-element', showToast: true }));
      expect(errorHandler.handle.mock.calls[0][0].message).not.toContain('raw unrecognized detail');
      expect(errorHandler.handle).toHaveBeenCalledTimes(1);
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'error' });
    });

    it.each([
      { mode: 'throw', value: Object.assign(new Error('Duplicate identity in batch: n1'), { type: 'VALIDATION' }) },
      { mode: 'resolve', value: Object.assign(new Error('No translation results were accepted'), { type: 'NO_ACCEPTED_TRANSLATION_RESULTS' }) },
    ])('normalizes internal failures consistently for $mode paths', async ({ mode, value }) => {
      if (mode === 'throw') manager.domTranslatorAdapter.translateElement.mockRejectedValue(value);
      else manager.domTranslatorAdapter.translateElement.mockResolvedValue({ success: false, error: value });

      await manager.startTranslation(document.createElement('div'));

      expect(errorHandler.handle).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Translation failed',
        type: 'TRANSLATION_FAILED',
        cause: value,
      }), expect.objectContaining({ context: 'select-element', showToast: true }));
      expect(errorHandler.handle.mock.calls[0][0].message).not.toContain('Duplicate');
      expect(errorHandler.handle.mock.calls[0][0].message).not.toContain('accepted');
    });

    it.each([
      ['V3 failure', Object.assign(new Error('V3 marker contract violation'), { type: 'VALIDATION' })],
      ['timeout', Object.assign(new Error('Batch translation timed out'), { type: 'TRANSLATION_TIMEOUT' })],
      ['provider failure', Object.assign(new Error('Network failed'), { type: 'NETWORK_ERROR' })],
    ])('suppresses partial-failure display when committed output exists for %s', async (_label, error) => {
      error.translationOutcome = { committedParentCount: 1, totalParentCount: 2, cancelled: false };
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      expect(errorHandler.handle).not.toHaveBeenCalled();
      const { pageEventBus } = await import('@/core/PageEventBus.js');
      expect(pageEventBus.emit).not.toHaveBeenCalledWith('show-select-element-info', expect.anything());
      const ExtensionContextManager = (await import('@/core/extensionContext.js')).default;
      expect(ExtensionContextManager.handleContextError).not.toHaveBeenCalled();
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'error' });
    });

    it('keeps committed translations and suppresses partial error on cancellation', async () => {
      const error = Object.assign(new Error('cancelled'), { type: 'USER_CANCELLED' });
      error.translationOutcome = { committedParentCount: 1, totalParentCount: 2, cancelled: true };
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      expect(errorHandler.handle).not.toHaveBeenCalled();
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'cancel' });
      const { pageEventBus } = await import('@/core/PageEventBus.js');
      expect(pageEventBus.emit).not.toHaveBeenCalledWith('show-select-element-info', expect.anything());
      const ExtensionContextManager = (await import('@/core/extensionContext.js')).default;
      expect(ExtensionContextManager.handleContextError).not.toHaveBeenCalled();
    });

    it('keeps successful translation cleanup unchanged', async () => {
      manager.domTranslatorAdapter.translateElement.mockResolvedValue({ success: true });

      await manager.startTranslation(document.createElement('div'));

      expect(errorHandler.handle).not.toHaveBeenCalled();
      const { pageEventBus } = await import('@/core/PageEventBus.js');
      expect(pageEventBus.emit).not.toHaveBeenCalledWith('show-select-element-info', expect.anything());
      const ExtensionContextManager = (await import('@/core/extensionContext.js')).default;
      expect(ExtensionContextManager.handleContextError).not.toHaveBeenCalled();
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'success' });
    });

    it.each([
      undefined,
      {},
      { success: false, error: Object.assign(new Error('No translation results were accepted'), {
        type: 'NO_ACCEPTED_TRANSLATION_RESULTS'
      }) }
    ])('classifies resolved non-success result as visible failure: %o', async (result) => {
      manager.domTranslatorAdapter.translateElement.mockResolvedValue(result);

      await manager.startTranslation(document.createElement('div'));

      expect(errorHandler.handle).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Translation failed', type: 'TRANSLATION_FAILED' }),
        expect.objectContaining({ context: 'select-element', showToast: true })
      );
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'error' });
    });

    it('keeps FULL_SUCCESS cleanup unchanged without partial message', async () => {
      manager.domTranslatorAdapter.translateElement.mockResolvedValue({
        success: true,
        partial: false,
        committedParentCount: 2,
        totalParentCount: 2
      });

      await manager.startTranslation(document.createElement('div'));

      expect(errorHandler.handle).not.toHaveBeenCalled();
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'success' });
      const { pageEventBus } = await import('@/core/PageEventBus.js');
      expect(pageEventBus.emit).toHaveBeenCalledWith('ELEMENT_TRANSLATIONS_AVAILABLE');
      expect(pageEventBus.emit).not.toHaveBeenCalledWith('show-select-element-info', expect.anything());
      const ExtensionContextManager = (await import('@/core/extensionContext.js')).default;
      expect(ExtensionContextManager.handleContextError).not.toHaveBeenCalled();
    });

    it('suppresses partial message and keeps success cleanup for PARTIAL_SUCCESS', async () => {
      const failureSpy = vi.spyOn(manager, '_handleTranslationFailure').mockImplementation(() => Promise.resolve());
      manager.domTranslatorAdapter.translateElement.mockResolvedValue({
        success: true,
        partial: true,
        committedParentCount: 1,
        totalParentCount: 2
      });

      await manager.startTranslation(document.createElement('div'));

      expect(errorHandler.handle).not.toHaveBeenCalled();
      expect(failureSpy).not.toHaveBeenCalled();
      const ExtensionContextManager = (await import('@/core/extensionContext.js')).default;
      expect(ExtensionContextManager.handleContextError).not.toHaveBeenCalled();
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'success' });
      const { pageEventBus } = await import('@/core/PageEventBus.js');
      expect(pageEventBus.emit).toHaveBeenCalledWith('hide-translation', expect.any(Object));
      expect(pageEventBus.emit).toHaveBeenCalledWith('ELEMENT_TRANSLATIONS_AVAILABLE');
      expect(manager.domTranslatorAdapter.revertTranslation).not.toHaveBeenCalled();
      expect(pageEventBus.emit).not.toHaveBeenCalledWith('show-select-element-info', expect.anything());
      failureSpy.mockRestore();
    });

    it('keeps one terminal presentation for zero committed output', async () => {
      const error = Object.assign(new Error('No translation results were accepted'), {
        type: ErrorTypes.NO_ACCEPTED_TRANSLATION_RESULTS,
        translationOutcome: { committedParentCount: 0, totalParentCount: 2, cancelled: false },
      });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      expect(errorHandler.handle).toHaveBeenCalledTimes(1);
      expect(errorHandler.handle).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Translation failed', type: 'TRANSLATION_FAILED' }),
        expect.objectContaining({ context: 'select-element', showToast: true })
      );
      expect(errorHandler.handle.mock.calls[0][0].message).not.toContain('No translation results were accepted');
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'error' });
    });

    it('preserves terminal presentation when outcome metadata is missing', async () => {
      const error = Object.assign(new Error('Network failed'), { type: ErrorTypes.NETWORK_ERROR });
      manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

      await manager.startTranslation(document.createElement('div'));

      expect(errorHandler.handle).toHaveBeenCalledTimes(1);
      expect(errorHandler.handle).toHaveBeenCalledWith(
        expect.objectContaining({ cause: error }),
        expect.objectContaining({ context: 'select-element', showToast: true })
      );
      expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'error' });
    });
  });

  describe('event handling', () => {
    beforeEach(async () => {
      await manager.initialize();
      await manager.activateSelectElementMode();
      manager.activationTime = 0; // Bypass cooldown
    });

    it('should handle ESC key to deactivate', async () => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      const preventDefault = vi.spyOn(event, 'preventDefault');
      const stopPropagation = vi.spyOn(event, 'stopPropagation');
      const stopImmediatePropagation = vi.spyOn(event, 'stopImmediatePropagation');
      const deactivate = vi.spyOn(manager, 'deactivate');
      manager.handleKeyDown(event);
      await vi.waitFor(() => expect(manager.isActive).toBe(false));
      expect(deactivate).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalled();
      expect(stopPropagation).toHaveBeenCalled();
      expect(stopImmediatePropagation).toHaveBeenCalled();
    });

    it('ignores keyup Escape after keydown has started cancellation', async () => {
      const deactivate = vi.spyOn(manager, 'deactivate');

      manager.handleKeyDown(new KeyboardEvent('keydown', { key: 'Escape' }));
      manager.handleKeyUp(new KeyboardEvent('keyup', { key: 'Escape' }));

      await vi.waitFor(() => expect(manager.isActive).toBe(false));
      expect(deactivate).toHaveBeenCalledTimes(1);
    });

    it('cancels on keyup Escape when keydown was not received', async () => {
      const deactivate = vi.spyOn(manager, 'deactivate');
      const event = new KeyboardEvent('keyup', { key: 'Escape', bubbles: true, cancelable: true });
      const preventDefault = vi.spyOn(event, 'preventDefault');
      const stopPropagation = vi.spyOn(event, 'stopPropagation');
      const stopImmediatePropagation = vi.spyOn(event, 'stopImmediatePropagation');

      manager.handleKeyUp(event);

      await vi.waitFor(() => expect(manager.isActive).toBe(false));
      expect(deactivate).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalled();
      expect(stopPropagation).toHaveBeenCalled();
      expect(stopImmediatePropagation).toHaveBeenCalled();
    });

    it('ignores keyup Escape while inactive', () => {
      manager.isActive = false;
      const deactivate = vi.spyOn(manager, 'deactivate');

      manager.handleKeyUp(new KeyboardEvent('keyup', { key: 'Escape' }));

      expect(deactivate).not.toHaveBeenCalled();
    });

    it('ignores repeated Escape while cancellation is in progress', async () => {
      const deactivate = vi.spyOn(manager, 'deactivate');

      manager.handleKeyDown(new KeyboardEvent('keydown', { key: 'Escape', repeat: true }));
      manager.handleKeyDown(new KeyboardEvent('keydown', { key: 'Escape', repeat: true }));

      await vi.waitFor(() => expect(manager.isActive).toBe(false));
      expect(deactivate).toHaveBeenCalledTimes(1);
    });

    it('coalesces movement, ignores stale event targets, and uses the current shadow-disabled hit target', () => {
      const staleEventTarget = document.createElement('span');
      const hitTestedTarget = document.createElement('x-shadow-host');
      let runFrame;
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
        runFrame = callback;
        return 42;
      });
      document.elementFromPoint = vi.fn(() => hitTestedTarget);
      const firstEvent = new MouseEvent('mouseover', { clientX: 100, clientY: 100 });
      Object.defineProperty(firstEvent, 'target', { value: staleEventTarget });
      const latestEvent = new MouseEvent('mousemove', { clientX: 120, clientY: 120 });
      Object.defineProperty(latestEvent, 'target', { value: staleEventTarget });
      manager.handleMouseOver(firstEvent);
      manager.handleMouseMove(new MouseEvent('mousemove', { clientX: 110, clientY: 110 }));
      manager.handleMouseMove(latestEvent);

      expect(manager.elementSelector.handleMouseOver).not.toHaveBeenCalled();
      runFrame();
      expect(document.elementFromPoint).toHaveBeenCalledWith(120, 120);
      expect(manager.elementSelector.handleMouseOver).toHaveBeenCalledWith(hitTestedTarget);
    });

    it('starts tracking on the first mousemove and hit-tests the current target', () => {
      const latestTarget = document.createElement('section');
      let runFrame;
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
        runFrame = callback;
        return 43;
      });
      document.elementFromPoint = vi.fn(() => latestTarget);

      manager.handleMouseMove(new MouseEvent('mousemove', { clientX: 20, clientY: 20 }));
      expect(runFrame).toBeTypeOf('function');
      runFrame();

      expect(document.elementFromPoint).toHaveBeenCalledWith(20, 20);
      expect(manager.elementSelector.handleMouseOver).toHaveBeenCalledWith(latestTarget);
    });

    it('uses the click target instead of a stale highlight when its movement frame has not run', async () => {
      const staleHighlight = document.createElement('div');
      const clickTarget = document.createElement('section');
      manager.elementSelector.getHighlightedElement.mockReturnValue(staleHighlight);
      vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(45);
      const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame');
      manager.handleMouseMove(new MouseEvent('mousemove', { clientX: 30, clientY: 40 }));

      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      Object.defineProperty(click, 'target', { value: clickTarget });
      await manager.handleClick(click);

      expect(manager.elementSelector.findBestTextElement).toHaveBeenCalledWith(clickTarget);
      expect(manager.domTranslatorAdapter.translateElement).toHaveBeenCalledWith(clickTarget, expect.any(Object));
      expect(manager.domTranslatorAdapter.translateElement).not.toHaveBeenCalledWith(staleHighlight, expect.any(Object));
      expect(cancelFrame).toHaveBeenCalledWith(45);
    });

    it('does not select from stationary mouseover events before genuine movement', () => {
      const target = document.createElement('div');
      let runFrame;
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
        runFrame = callback;
        return 44;
      });
      document.elementFromPoint = vi.fn(() => target);

      manager.handleMouseOver(new MouseEvent('mouseover', { clientX: 10, clientY: 10 }));
      manager.handleMouseOver(new MouseEvent('mouseover', { clientX: 10, clientY: 10 }));
      expect(runFrame).toBeUndefined();
      expect(manager.elementSelector.handleMouseOver).not.toHaveBeenCalled();

      manager.handleMouseOver(new MouseEvent('mouseover', { clientX: 11, clientY: 10 }));
      runFrame();
      expect(manager.elementSelector.handleMouseOver).toHaveBeenCalledWith(target);
    });

    it('cancels queued pointer work when listeners are removed', () => {
      vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(42);
      const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame');
      manager.handleMouseOver(new MouseEvent('mouseover', { clientX: 1, clientY: 1 }));
      manager.handleMouseMove(new MouseEvent('mousemove', { clientX: 2, clientY: 2 }));

      manager.removeEventListeners();

      expect(cancelFrame).toHaveBeenCalledWith(42);
      expect(manager.mouseSelectionFrame).toBeNull();
    });

    it('forwards mouseout transitions within the highlighted subtree to cancel a pending clear', () => {
      const root = document.createElement('div');
      const child = document.createElement('span');
      root.appendChild(child);
      manager.elementSelector.getHighlightedElement.mockReturnValue(root);

      manager.handleMouseOut({ relatedTarget: child });

      expect(manager.elementSelector.handleMouseOut).toHaveBeenCalledWith(child);
    });

    it('should handle touch events', () => {
      const mockElement = document.createElement('div');
      const touch = { clientX: 100, clientY: 100, target: mockElement };
      const event = new TouchEvent('touchstart', { touches: [touch] });
      
      manager.handleTouchStart(event);
      expect(manager.isActive).toBe(true);

      const moveEvent = new TouchEvent('touchmove', { touches: [touch] });
      // Mock document.elementFromPoint
      document.elementFromPoint = vi.fn(() => mockElement);
      
      manager.handleTouchMove(moveEvent);
      expect(manager.elementSelector.handleMouseOver).toHaveBeenCalledWith(mockElement);
    });

    it('translates the touch-move highlight when touchend retains the touch-start target', async () => {
      const touchStartTarget = document.createElement('div');
      const touchMoveTarget = document.createElement('section');
      let highlighted = null;
      manager.elementSelector.handleMouseOver.mockImplementation(element => {
        highlighted = element;
      });
      manager.elementSelector.getHighlightedElement.mockImplementation(() => highlighted);
      document.elementFromPoint = vi.fn(() => touchMoveTarget);

      manager.handleTouchStart(new TouchEvent('touchstart', {
        touches: [{ clientX: 1, clientY: 1, target: touchStartTarget }],
        cancelable: true,
      }));
      manager.handleTouchMove(new TouchEvent('touchmove', {
        touches: [{ clientX: 20, clientY: 30, target: touchStartTarget }],
        cancelable: true,
      }));
      const touchEnd = new TouchEvent('touchend', { cancelable: true });
      Object.defineProperty(touchEnd, 'target', { value: touchStartTarget });
      manager.handleTouchEnd(touchEnd);

      await vi.waitFor(() => expect(manager.domTranslatorAdapter.translateElement)
        .toHaveBeenCalledWith(touchMoveTarget, expect.any(Object)));
      expect(manager.domTranslatorAdapter.translateElement)
        .not.toHaveBeenCalledWith(touchStartTarget, expect.any(Object));
      expect(isSelectableTextRoot).toHaveBeenCalledWith(touchMoveTarget);
    });

    it('should block auxclick (middle-click) interaction', () => {
      const event = new MouseEvent('auxclick', { bubbles: true, cancelable: true });
      vi.spyOn(event, 'preventDefault');
      vi.spyOn(event, 'stopImmediatePropagation');
      
      manager.handleInteraction(event);
      
      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopImmediatePropagation).toHaveBeenCalled();
    });

    it('should block interactions on highlighted elements', () => {
      const mockElement = document.createElement('div');
      mockElement.setAttribute('data-translate-highlighted', 'true');
      
      // Mock isOurElement to return false for highlighted elements (the fix)
      manager.elementSelector.isOurElement.mockReturnValue(false);
      
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      vi.spyOn(event, 'preventDefault');
      vi.spyOn(event, 'stopImmediatePropagation');
      
      manager.handleInteraction(event);
      
      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopImmediatePropagation).toHaveBeenCalled();
    });

    it('should NOT block interactions on extension UI elements', () => {
      const mockElement = document.createElement('div');
      manager.elementSelector.isOurElement.mockImplementation((el) => el === mockElement);
      
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'target', { value: mockElement, writable: false });
      event.composedPath = vi.fn(() => [mockElement]);
      
      vi.spyOn(event, 'preventDefault');
      
      manager.handleInteraction(event);
      
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe('cross-frame and notifications', () => {
    it('should show notification in top frame', async () => {
      manager.isTopFrame = true;
      await manager.initialize();
      await manager.activateSelectElementMode();
      
      const { pageEventBus } = await import('@/core/PageEventBus.js');
      expect(pageEventBus.emit).toHaveBeenCalledWith('show-select-element-notification', expect.any(Object));
    });

    it('should ignore legacy global deactivation messages', async () => {
      await manager.initialize();
      await manager.activateSelectElementMode();
      
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'DEACTIVATE_ALL_SELECT_MANAGERS' }
      }));
      
      expect(manager.isActive).toBe(true);
    });
  });

  describe('conflict deactivation', () => {
    it('exits silently and uses safe no-request cancellation before translation starts', async () => {
      manager.isActive = true;

      await manager.deactivate({ reason: 'conflict', silent: true });

      expect(manager.isActive).toBe(false);
      expect(manager.domTranslatorAdapter.cancelTranslation).toHaveBeenCalledTimes(1);
      expect(manager.domTranslatorAdapter.cancelTranslation).toHaveBeenCalledWith({ silent: true });
      expect(manager.domTranslatorAdapter.revertTranslation).not.toHaveBeenCalled();
      expect(errorHandler.handle).not.toHaveBeenCalled();
      const { pageEventBus } = await import('@/core/PageEventBus.js');
      expect(pageEventBus.emit).not.toHaveBeenCalledWith('show-select-element-info', expect.anything());
      const ExtensionContextManager = (await import('@/core/extensionContext.js')).default;
      expect(ExtensionContextManager.handleContextError).not.toHaveBeenCalled();
    });

    it('cancels active adapter work without changing conflict UX or cleanup semantics', async () => {
      manager.isActive = true;
      manager.domTranslatorAdapter.isTranslating = true;

      await manager.deactivate({ reason: 'conflict', silent: false });

      expect(manager.domTranslatorAdapter.cancelTranslation).toHaveBeenCalledWith({ silent: true });
      expect(manager.domTranslatorAdapter.revertTranslation).not.toHaveBeenCalled();
      expect(errorHandler.handle).not.toHaveBeenCalled();
      expect(manager.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Reason: conflict'),
        expect.objectContaining({ reason: 'conflict' })
      );
    });

    it('does not repeat conflict cancellation after the manager is inactive', async () => {
      manager.isActive = true;

      await manager.deactivate({ reason: 'conflict', silent: true });
      await manager.deactivate({ reason: 'conflict', silent: true });

      expect(manager.domTranslatorAdapter.cancelTranslation).toHaveBeenCalledTimes(1);
      expect(errorHandler.handle).not.toHaveBeenCalled();
    });

    it('does not turn already-terminal work into conflict cancellation', async () => {
      manager.isActive = false;

      await manager.deactivate({ reason: 'conflict', silent: true });

      expect(manager.domTranslatorAdapter.cancelTranslation).not.toHaveBeenCalled();
      expect(manager.domTranslatorAdapter.revertTranslation).not.toHaveBeenCalled();
    });
  });

  describe('emergency cleanup', () => {
    it('should perform emergency cleanup if context becomes invalid', async () => {
      vi.useFakeTimers();
      await manager.initialize();
      await manager.activateSelectElementMode();
      
      const ExtensionContextManager = (await import('@/core/extensionContext.js')).default;
      ExtensionContextManager.isValidSync.mockReturnValue(false);
      
      vi.advanceTimersByTime(2500);
      
      expect(manager.isActive).toBe(false);
      expect(document.documentElement.getAttribute('data-translate-it-select-mode')).toBeNull();
      vi.useRealTimers();
    });

    it('should route watchdog context invalidation to the canonical context-error owner', async () => {
      vi.useFakeTimers();
      await manager.initialize();
      await manager.activateSelectElementMode();

      const ExtensionContextManager = (await import('@/core/extensionContext.js')).default;
      ExtensionContextManager.isValidSync.mockReturnValue(false);

      vi.advanceTimersByTime(2500);

      expect(ExtensionContextManager.handleContextError).toHaveBeenCalledTimes(1);
      const [contextError, context] = ExtensionContextManager.handleContextError.mock.calls[0];
      expect(context).toBe('element-selection-watchdog');
      expect(contextError.type).toBe(ErrorTypes.EXTENSION_CONTEXT_INVALIDATED);
      expect(String(contextError.message).toLowerCase()).toContain('extension context invalidated');
      vi.useRealTimers();
    });

    it('should not repeat context handling on subsequent watchdog ticks', async () => {
      vi.useFakeTimers();
      await manager.initialize();
      await manager.activateSelectElementMode();

      const ExtensionContextManager = (await import('@/core/extensionContext.js')).default;
      ExtensionContextManager.isValidSync.mockReturnValue(false);

      vi.advanceTimersByTime(2500);
      expect(ExtensionContextManager.handleContextError).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(10000);
      expect(ExtensionContextManager.handleContextError).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('should not emit a generic error toast for watchdog context invalidation', async () => {
      vi.useFakeTimers();
      await manager.initialize();
      await manager.activateSelectElementMode();

      const ExtensionContextManager = (await import('@/core/extensionContext.js')).default;
      ExtensionContextManager.isValidSync.mockReturnValue(false);

      vi.advanceTimersByTime(2500);

      expect(errorHandler.handle).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('should not emit a no-content info notification for watchdog context invalidation', async () => {
      vi.useFakeTimers();
      await manager.initialize();
      await manager.activateSelectElementMode();

      const { pageEventBus } = await import('@/core/PageEventBus.js');
      pageEventBus.emit.mockClear();

      const ExtensionContextManager = (await import('@/core/extensionContext.js')).default;
      ExtensionContextManager.isValidSync.mockReturnValue(false);

      vi.advanceTimersByTime(2500);

      expect(pageEventBus.emit).not.toHaveBeenCalledWith('show-select-element-info', expect.anything());
      vi.useRealTimers();
    });

    it('keeps the existing translation-failure context path intact', async () => {
      const ExtensionContextManager = (await import('@/core/extensionContext.js')).default;
      const cleanupSpy = vi.spyOn(manager, 'performPostTranslationCleanup').mockImplementation(() => {});
      ExtensionContextManager.isContextError.mockReturnValue(true);
      try {
        manager.isActive = true;
        const error = Object.assign(new Error('Extension context invalidated'), {
          type: ErrorTypes.EXTENSION_CONTEXT_INVALIDATED,
        });
        manager.domTranslatorAdapter.translateElement.mockRejectedValue(error);

        await manager.startTranslation(document.createElement('div'));

        expect(ExtensionContextManager.handleContextError).toHaveBeenCalledTimes(1);
        expect(ExtensionContextManager.handleContextError).toHaveBeenCalledWith(error, 'element-selection');
        expect(errorHandler.handle).not.toHaveBeenCalled();
        const { pageEventBus } = await import('@/core/PageEventBus.js');
        expect(pageEventBus.emit).not.toHaveBeenCalledWith('show-select-element-info', expect.anything());
        expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'cancel' });
      } finally {
        ExtensionContextManager.isContextError.mockReturnValue(false);
      }
    });

    it('should not cleanup or notify while context remains valid', async () => {
      vi.useFakeTimers();
      await manager.initialize();
      await manager.activateSelectElementMode();

      const ExtensionContextManager = (await import('@/core/extensionContext.js')).default;
      ExtensionContextManager.isValidSync.mockReturnValue(true);
      const cleanupSpy = vi.spyOn(manager, 'emergencyCleanup');

      vi.advanceTimersByTime(9000);

      expect(manager.isActive).toBe(true);
      expect(cleanupSpy).not.toHaveBeenCalled();
      expect(ExtensionContextManager.handleContextError).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe('advanced interactions', () => {
    beforeEach(async () => {
      await manager.initialize();
      await manager.activateSelectElementMode();
      manager.activationTime = 0;
    });

    it('should ignore mouseover on our own UI elements', () => {
      const mockElement = document.createElement('div');
      manager.elementSelector.isOurElement.mockReturnValue(true);
      
      const event = new MouseEvent('mouseover');
      Object.defineProperty(event, 'target', { value: mockElement });
      manager.hasInitialMovementOccurred = true;
      
      manager.handleMouseOver(event);
      expect(manager.elementSelector.handleMouseOver).not.toHaveBeenCalled();
    });

    it('should ignore legacy iframe deactivation messages', async () => {
      manager.isTopFrame = true;
      await manager.initialize();
      await manager.activateSelectElementMode();
      
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'translate-it-deactivate-select-element' }
      }));
      
      expect(manager.isActive).toBe(true);
      expect(manager.domTranslatorAdapter.cancelTranslation).not.toHaveBeenCalled();
      const { sendMessage } = await import('@/shared/messaging/core/UnifiedMessaging.js');
      expect(sendMessage).not.toHaveBeenCalledWith({
        action: 'DEACTIVATE_SELECT_ELEMENT_MODE',
      });
    });

    it('reports child-frame terminal cleanup through runtime messaging', async () => {
      const { sendRegularMessage } = await import('@/shared/messaging/core/UnifiedMessaging.js');
      manager.isTopFrame = false;

      manager.performPostTranslationCleanup({ reason: 'success' });
      await Promise.resolve();

      expect(sendRegularMessage).toHaveBeenCalledWith({
        action: 'IFRAME_SELECT_ELEMENT_FINISHED',
        data: { reason: 'success' },
      }, { silent: true });
    });

    it('keeps local cleanup successful when runtime completion reporting fails', async () => {
      const { sendRegularMessage } = await import('@/shared/messaging/core/UnifiedMessaging.js');
      sendRegularMessage.mockRejectedValueOnce(new Error('Background unavailable'));
      manager.isTopFrame = false;

      expect(() => manager.performPostTranslationCleanup({ reason: 'success' })).not.toThrow();
      await Promise.resolve();
      expect(manager.isProcessingClick).toBe(false);
    });

    it('keeps plain manual deactivation local regardless of frame position', async () => {
      const { sendMessage, sendRegularMessage } = await import('@/shared/messaging/core/UnifiedMessaging.js');
      manager.isTopFrame = true;
      manager.isActive = true;

      await manager.deactivate({ reason: 'manual' });

      expect(sendMessage).not.toHaveBeenCalledWith({
        action: 'DEACTIVATE_SELECT_ELEMENT_MODE',
      });
      expect(sendMessage).toHaveBeenCalledWith({
        action: 'SET_SELECT_ELEMENT_STATE',
        data: { active: false },
      });
      expect(sendRegularMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'IFRAME_SELECT_ELEMENT_FINISHED' }),
        expect.anything(),
      );
    });

    it('should emit progress events during translation', async () => {
      let progressCallback;
      manager.domTranslatorAdapter.translateElement.mockImplementation((el, opts) => {
        progressCallback = opts.onProgress;
        return Promise.resolve({ success: true });
      });

      const mockElement = document.createElement('div');
      mockElement.textContent = 'test';
      manager.elementSelector.getHighlightedElement.mockReturnValue(mockElement);
      
      await manager.handleClick(new MouseEvent('click'));
      
      const { pageEventBus } = await import('@/core/PageEventBus.js');
      await progressCallback();
      
      expect(pageEventBus.emit).toHaveBeenCalledWith('ELEMENT_TRANSLATIONS_AVAILABLE');
    });

    it('should unlock page interaction immediately after click', async () => {
      const mockElement = document.createElement('div');
      mockElement.textContent = 'test';
      manager.elementSelector.getHighlightedElement.mockReturnValue(mockElement);
      
      const removeSpy = vi.spyOn(manager, 'removeEventListeners');
      
      await manager.handleClick(new MouseEvent('click'));
      
      expect(document.documentElement.getAttribute('data-translate-it-select-mode')).toBeNull();
      expect(removeSpy).toHaveBeenCalled();
    });
  });
});

describe('explicit tab-wide deactivation ownership', () => {
  let manager;
  let sendMessage;
  let sendRegularMessage;

  const GLOBAL_DEACTIVATE = { action: 'DEACTIVATE_SELECT_ELEMENT_MODE' };
  const STATE_REPORT = { action: 'SET_SELECT_ELEMENT_STATE', data: { active: false } };

  beforeEach(async () => {
    vi.clearAllMocks();
    isSelectableTextRoot.mockReturnValue(true);
    const module = await import('./SelectElementManager.js');
    manager = new module.SelectElementManager();
  });

  async function activateManager(isTopFrame) {
    ({ sendMessage, sendRegularMessage } = await import('@/shared/messaging/core/UnifiedMessaging.js'));
    manager.isTopFrame = isTopFrame;
    await manager.initialize();
    await manager.activateSelectElementMode();
    sendMessage.mockClear();
  }

  it('requests tab-wide deactivation once when keydown and keyup Escape fire in a child frame', async () => {
    await activateManager(false);

    manager.handleKeyDown(new KeyboardEvent('keydown', { key: 'Escape' }));
    manager.handleKeyUp(new KeyboardEvent('keyup', { key: 'Escape' }));

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(GLOBAL_DEACTIVATE));
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('requests tab-wide deactivation when Escape fires in the top frame', async () => {
    await activateManager(true);

    manager.handleKeyDown(new KeyboardEvent('keydown', { key: 'Escape' }));

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(GLOBAL_DEACTIVATE));
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('sends the global request only when the explicit flag is set in a child frame', async () => {
    await activateManager(false);
    manager.isActive = true;

    await manager.deactivate({ reason: 'cancel', requestGlobalDeactivation: true });

    expect(sendMessage).toHaveBeenCalledWith(GLOBAL_DEACTIVATE);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('reports unconfirmed Background authority when the global request fails', async () => {
    await activateManager(false);
    manager.isActive = true;
    sendMessage.mockRejectedValueOnce(new Error('Background unavailable'));

    await expect(manager.deactivate({ reason: 'manual', requestGlobalDeactivation: true })).resolves.toMatchObject({
      success: true,
      cleanupCompleted: true,
      globalDeactivationRequested: true,
      globalDeactivationSucceeded: false,
    });
  });

  it('releases local lifecycle cleanup before waiting for global deactivation', async () => {
    await activateManager(true);
    let resolveGlobalRequest;
    sendMessage.mockImplementationOnce(() => new Promise(resolve => {
      resolveGlobalRequest = resolve;
    }));
    const cleanupSpy = manager.elementSelector.deactivate;

    const localDeactivation = manager.deactivate({ reason: 'cancel', requestGlobalDeactivation: true });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(GLOBAL_DEACTIVATE));

    await expect(manager.deactivate({ fromBackground: true })).resolves.toMatchObject({
      success: true,
      alreadyInactive: true,
    });
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    resolveGlobalRequest();
    await expect(localDeactivation).resolves.toMatchObject({ success: true });
  });

  it('never derives propagation from the reason string alone', async () => {
    await activateManager(false);
    manager.isActive = true;

    await manager.deactivate({ reason: 'cancel' });

    expect(sendMessage).not.toHaveBeenCalledWith(GLOBAL_DEACTIVATE);
    expect(sendMessage).toHaveBeenCalledWith(STATE_REPORT);
  });

  it.each([true, false])('keeps conflict cleanup local (isTopFrame=%s)', async (isTopFrame) => {
    await activateManager(isTopFrame);
    manager.isActive = true;

    await manager.deactivate({ reason: 'conflict', silent: true });

    expect(sendMessage).not.toHaveBeenCalledWith(GLOBAL_DEACTIVATE);
  });

  it('suppresses every outbound request for trusted background receivers even with the flag present', async () => {
    await activateManager(true);
    manager.isActive = true;

    await manager.deactivate({ fromBackground: true, requestGlobalDeactivation: true });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('keeps top-frame internal cleanup local despite frame position', async () => {
    await activateManager(true);
    manager.isActive = true;

    await manager.cleanup();

    expect(sendMessage).not.toHaveBeenCalledWith(GLOBAL_DEACTIVATE);
    expect(manager.isActive).toBe(false);
  });

  it('keeps child-frame internal cleanup local with state bookkeeping only', async () => {
    await activateManager(false);
    manager.isActive = true;

    await manager.cleanup();

    expect(sendMessage).not.toHaveBeenCalledWith(GLOBAL_DEACTIVATE);
    expect(sendMessage).toHaveBeenCalledWith(STATE_REPORT);
  });

  it('requests tab-wide exit from the notification cancel action', async () => {
    await activateManager(true);
    const { pageEventBus } = await import('@/core/PageEventBus.js');
    const emitCall = pageEventBus.emit.mock.calls.find(([event]) => event === 'show-select-element-notification');
    expect(emitCall).toBeDefined();

    emitCall[1].actions.cancel();

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(GLOBAL_DEACTIVATE));
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('requests tab-wide exit from the shared cancel bus event', async () => {
    await activateManager(true);
    const { pageEventBus } = await import('@/core/PageEventBus.js');
    const registration = pageEventBus.on.mock.calls.find(([event]) => event === 'cancel-select-element-mode');
    expect(registration).toBeDefined();

    registration[1]();

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(GLOBAL_DEACTIVATE));
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'error'])('keeps terminal child completion single-owner via IFRAME_FINISHED (%s)', async (reason) => {
    await activateManager(false);
    manager.isActive = true;

    manager.performPostTranslationCleanup({ reason });
    await Promise.resolve();
    await Promise.resolve();

    expect(sendRegularMessage).toHaveBeenCalledTimes(1);
    expect(sendRegularMessage).toHaveBeenCalledWith(
      { action: 'IFRAME_SELECT_ELEMENT_FINISHED', data: { reason } },
      { silent: true },
    );
    expect(sendMessage).not.toHaveBeenCalledWith(GLOBAL_DEACTIVATE);
  });

  it.each(['success', 'error', 'no-content'])('requests one trusted global deactivation for top terminal outcomes (%s)', async (reason) => {
    await activateManager(true);

    manager.performPostTranslationCleanup({ reason });

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(GLOBAL_DEACTIVATE));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendRegularMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'IFRAME_SELECT_ELEMENT_FINISHED' }),
      expect.anything(),
    );
  });

  it('routes fatal child translation failures through terminal cleanup ownership', async () => {
    await activateManager(false);
    const { isFatalError } = await import('@/shared/error-management/ErrorMatcher.js');
    isFatalError.mockReturnValueOnce(true);
    manager.domTranslatorAdapter.translateElement.mockRejectedValue(
      Object.assign(new Error('fatal provider failure'), { type: ErrorTypes.API_KEY_INVALID })
    );
    const cleanupSpy = vi.spyOn(manager, 'performPostTranslationCleanup');

    await manager.startTranslation(document.createElement('div'));

    expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'error' });
    expect(sendRegularMessage).toHaveBeenCalledWith(
      { action: 'IFRAME_SELECT_ELEMENT_FINISHED', data: { reason: 'error' } },
      { silent: true },
    );
    expect(sendMessage).not.toHaveBeenCalledWith(GLOBAL_DEACTIVATE);
  });

  it('routes fatal top translation failures through one terminal global request', async () => {
    await activateManager(true);
    const { isFatalError } = await import('@/shared/error-management/ErrorMatcher.js');
    isFatalError.mockReturnValueOnce(true);
    manager.domTranslatorAdapter.translateElement.mockRejectedValue(
      Object.assign(new Error('fatal provider failure'), { type: ErrorTypes.API_KEY_INVALID })
    );
    const cleanupSpy = vi.spyOn(manager, 'performPostTranslationCleanup');

    await manager.startTranslation(document.createElement('div'));

    expect(cleanupSpy).toHaveBeenCalledWith({ reason: 'error' });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(GLOBAL_DEACTIVATE));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendRegularMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'IFRAME_SELECT_ELEMENT_FINISHED' }),
      expect.anything(),
    );
  });

  it('keeps adapter result.cancelled an internal echo without global requests', async () => {
    await activateManager(false);
    manager.domTranslatorAdapter.translateElement.mockResolvedValue({ success: false, cancelled: true });

    await manager.startTranslation(document.createElement('div'));

    expect(sendMessage).not.toHaveBeenCalledWith(GLOBAL_DEACTIVATE);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(STATE_REPORT));
  });

  it('ignores duplicate background broadcasts when already inactive', async () => {
    await activateManager(false);
    manager.isActive = false;

    await manager.deactivate({ fromBackground: true });

    expect(sendMessage).not.toHaveBeenCalled();
  });
});
