import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, nextTick, ref } from 'vue';
import { getActivePinia, createPinia, setActivePinia, defineStore } from 'pinia';
import { useUnifiedTranslation } from './useUnifiedTranslation.js';

// --- Mocks ---

const sessionMocks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  clear: vi.fn(),
}));

const contentIntegrationMocks = vi.hoisted(() => ({
  registerTranslation: vi.fn(),
  handleMessage: vi.fn(() => false),
}));

vi.mock("webextension-polyfill", () => ({
  default: {
    runtime: {
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  },
}));

vi.mock('@/features/translation/storage/TranslationUiSessionState.js', () => ({
  translationUiSessionState: sessionMocks,
}));

vi.mock('@/shared/messaging/core/ContentScriptIntegration.js', () => contentIntegrationMocks);

vi.mock("@/shared/logging/logger.js", () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Create real stores for the test to ensure reactivity
const useSettingsStore = defineStore('settings', {
  state: () => ({
    settings: {
      ENABLE_DICTIONARY: true,
      TRANSLATION_API: "google_v2",
    }
  })
});

const useTranslationStore = defineStore('translation', {
  state: () => ({
    uiTargetLanguage: "fa",
    currentTranslation: null,
  })
});

vi.mock("@/features/settings/stores/settings.js", () => ({
  useSettingsStore: () => useSettingsStore()
}));

vi.mock("@/features/translation/stores/translation.js", () => ({
  useTranslationStore: () => useTranslationStore()
}));

vi.mock("@/composables/core/useBrowserAPI.js", () => ({
  useBrowserAPI: vi.fn(() => ({
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  })),
}));

vi.mock("@/shared/messaging/core/UnifiedMessaging.js", () => ({
  sendMessage: vi.fn(),
}));

const mockErrorManager = {
  errorMessage: ref(""),
  errorType: ref(null),
  hasError: ref(false),
  canRetry: ref(false),
  canOpenSettings: ref(false),
  handleError: vi.fn(),
  clearError: vi.fn(),
  getRetryCallback: vi.fn(),
  getSettingsCallback: vi.fn(),
};

vi.mock("@/features/translation/composables/useTranslationError.js", () => ({
  useTranslationError: vi.fn(() => mockErrorManager),
}));

vi.mock("@/utils/messaging/messageId.js", () => ({
  generateMessageId: vi.fn(() => "test-msg-id"),
}));

vi.mock("@/shared/config/config.js", () => ({
  CONFIG: {
    TRANSLATION_API: "edge",
    POPUP_MAX_CHARS: 5000,
    SIDEPANEL_MAX_CHARS: 10000,
    SELECTION_MAX_CHARS: 5000,
    SELECT_ELEMENT_MAX_CHARS: 300000,
  },
  getSourceLanguageAsync: vi.fn().mockResolvedValue("auto"),
  getTargetLanguageAsync: vi.fn().mockResolvedValue("en"),
  getPopupMaxCharsAsync: vi.fn().mockResolvedValue(5000),
  getSidepanelMaxCharsAsync: vi.fn().mockResolvedValue(10000),
  getSourceLanguage: vi.fn().mockReturnValue("auto"),
  getTargetLanguage: vi.fn().mockReturnValue("en"),
  TranslationMode: {
    Popup_Translate: "popup_translate",
    Sidepanel_Translate: "sidepanel_translate",
    Dictionary_Translation: "dictionary_translation",
  },
}));

vi.mock("@/shared/config/constants.js", () => ({
  AUTO_DETECT_VALUE: "auto",
  DEFAULT_TARGET_LANGUAGE: "fa",
}));

vi.mock("@/utils/UtilsFactory.js", () => ({
  utilsFactory: {
    getI18nUtils: vi.fn().mockResolvedValue({
      findLanguageCode: vi.fn((lang) => Promise.resolve(lang)),
    }),
  },
}));

function withSetup(composable) {
  let result;
  const app = createApp({
    setup() {
      result = composable();
      return () => {};
    },
  });
  app.use(getActivePinia());
  const host = document.createElement("div");
  app.mount(host);
  return [result, app];
}

describe("useUnifiedTranslation", () => {
  let translationStore;

  beforeEach(() => {
    setActivePinia(createPinia());
    translationStore = useTranslationStore();
    vi.useFakeTimers();
    vi.clearAllMocks();
    sessionMocks.load.mockResolvedValue(null);
    sessionMocks.save.mockResolvedValue(true);
    sessionMocks.clear.mockResolvedValue(true);
    contentIntegrationMocks.handleMessage.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should initialize with default values", async () => {
    const [composable] = withSetup(() => useUnifiedTranslation("popup"));
    await nextTick();
    await vi.runAllTimersAsync();
    expect(composable.sourceText.value).toBe("");
    expect(composable.translatedText.value).toBe("");
  });

  it("should trigger translation and handle success", async () => {
    const [composable] = withSetup(() => useUnifiedTranslation("popup"));
    const { sendMessage } = await import("@/shared/messaging/core/UnifiedMessaging.js");
    
    sendMessage.mockResolvedValue({
      success: true,
      translatedText: "سلام دنیا",
      sourceLanguage: "en",
      targetLanguage: "fa",
    });

    composable.sourceText.value = "Hello world";
    const resultPromise = composable.triggerTranslation();
    expect(composable.isTranslating.value).toBe(true);
    
    await resultPromise;
    expect(composable.translatedText.value).toBe("سلام دنیا");
    expect(composable.isTranslating.value).toBe(false);
  });

  it("should handle translation error", async () => {
    const [composable] = withSetup(() => useUnifiedTranslation("popup"));
    const { sendMessage } = await import("@/shared/messaging/core/UnifiedMessaging.js");
    sendMessage.mockRejectedValue(new Error("Network error"));

    composable.sourceText.value = "Error test";
    await composable.triggerTranslation();

    expect(composable.isTranslating.value).toBe(false);
    expect(mockErrorManager.handleError).toHaveBeenCalled();
  });

  it("should prefer canonical errorDetails over raw error for direct failures", async () => {
    const [composable] = withSetup(() => useUnifiedTranslation("popup"));
    const { sendMessage } = await import("@/shared/messaging/core/UnifiedMessaging.js");

    sendMessage.mockResolvedValue({
      success: false,
      error: "RAW PROVIDER BODY",
      errorDetails: {
        message: "provider diagnostic",
        type: "MODEL_NOT_FOUND",
        statusCode: 404,
        providerName: "Provider",
      },
    });

    composable.sourceText.value = "Hello world";
    await composable.triggerTranslation();

    expect(mockErrorManager.handleError).toHaveBeenCalledTimes(1);
    const handled = mockErrorManager.handleError.mock.calls[0][0];
    expect(handled).toBeInstanceOf(Error);
    expect(handled.type).toBe("MODEL_NOT_FOUND");
    expect(handled.statusCode).toBe(404);
    expect(handled.providerName).toBe("Provider");
    expect(handled.message).not.toContain("RAW PROVIDER BODY");
    expect(composable.isTranslating.value).toBe(false);
  });

  it("should handle failures with only valid errorDetails present", async () => {
    const [composable] = withSetup(() => useUnifiedTranslation("popup"));
    const { sendMessage } = await import("@/shared/messaging/core/UnifiedMessaging.js");

    sendMessage.mockResolvedValue({
      success: false,
      errorDetails: {
        message: "provider diagnostic",
        type: "NETWORK_ERROR",
      },
    });

    composable.sourceText.value = "Hello world";
    await composable.triggerTranslation();

    expect(mockErrorManager.handleError).toHaveBeenCalledTimes(1);
    expect(mockErrorManager.handleError.mock.calls[0][0].type).toBe("NETWORK_ERROR");
    expect(composable.isTranslating.value).toBe(false);
  });

  it("should preserve structured cancellation identity", async () => {
    const [composable] = withSetup(() => useUnifiedTranslation("popup"));
    const { sendMessage } = await import("@/shared/messaging/core/UnifiedMessaging.js");

    sendMessage.mockResolvedValue({
      success: false,
      error: "Operation cancelled",
      errorDetails: {
        message: "Operation cancelled",
        type: "USER_CANCELLED",
      },
    });

    composable.sourceText.value = "Hello world";
    await composable.triggerTranslation();

    expect(mockErrorManager.handleError).toHaveBeenCalledTimes(1);
    const handled = mockErrorManager.handleError.mock.calls[0][0];
    expect(handled.type).toBe("USER_CANCELLED");
    expect(handled.message).toContain("cancelled");
  });

  it("should preserve structured context-invalidation identity", async () => {
    const [composable] = withSetup(() => useUnifiedTranslation("popup"));
    const { sendMessage } = await import("@/shared/messaging/core/UnifiedMessaging.js");

    sendMessage.mockResolvedValue({
      success: false,
      error: "Extension context invalidated: Receiving end does not exist",
      errorDetails: {
        message: "Extension context invalidated: Receiving end does not exist",
        type: "EXTENSION_CONTEXT_INVALIDATED",
      },
    });

    composable.sourceText.value = "Hello world";
    await composable.triggerTranslation();

    expect(mockErrorManager.handleError).toHaveBeenCalledTimes(1);
    const handled = mockErrorManager.handleError.mock.calls[0][0];
    expect(handled.type).toBe("EXTENSION_CONTEXT_INVALIDATED");
    expect(handled.message.toLowerCase()).toContain("extension context invalidated");
  });

  it("should preserve structured timeout identity", async () => {
    const [composable] = withSetup(() => useUnifiedTranslation("popup"));
    const { sendMessage } = await import("@/shared/messaging/core/UnifiedMessaging.js");

    sendMessage.mockResolvedValue({
      success: false,
      error: "Timed out",
      errorDetails: {
        message: "Timed out",
        type: "TRANSLATION_TIMEOUT",
      },
    });

    composable.sourceText.value = "Hello world";
    await composable.triggerTranslation();

    expect(mockErrorManager.handleError).toHaveBeenCalledTimes(1);
    expect(mockErrorManager.handleError.mock.calls[0][0].type).toBe("TRANSLATION_TIMEOUT");
  });

  it("should route legacy error-only failures through canonical handling", async () => {
    const [composable] = withSetup(() => useUnifiedTranslation("popup"));
    const { sendMessage } = await import("@/shared/messaging/core/UnifiedMessaging.js");

    sendMessage.mockResolvedValue({
      success: false,
      error: "legacy raw message",
    });

    composable.sourceText.value = "Hello world";
    await composable.triggerTranslation();

    expect(mockErrorManager.handleError).toHaveBeenCalledTimes(1);
    const handled = mockErrorManager.handleError.mock.calls[0][0];
    expect(handled).toBeInstanceOf(Error);
    expect(handled.message).toBe("legacy raw message");
    expect(handled.type).toBe("UNKNOWN");
  });

  it("should not let malformed errorDetails override a valid fallback error", async () => {
    const [composable] = withSetup(() => useUnifiedTranslation("popup"));
    const { sendMessage } = await import("@/shared/messaging/core/UnifiedMessaging.js");

    sendMessage.mockResolvedValue({
      success: false,
      error: "safer fallback",
      errorDetails: "not-an-object",
    });

    composable.sourceText.value = "Hello world";
    await composable.triggerTranslation();

    expect(mockErrorManager.handleError).toHaveBeenCalledTimes(1);
    expect(mockErrorManager.handleError.mock.calls[0][0].message).toBe("safer fallback");
  });

  it("should fall back to a safe generic error for unusable failure payloads", async () => {
    const [composable] = withSetup(() => useUnifiedTranslation("popup"));
    const { sendMessage } = await import("@/shared/messaging/core/UnifiedMessaging.js");

    sendMessage.mockResolvedValue({
      success: false,
      errorDetails: { statusCode: 500 },
    });

    composable.sourceText.value = "Hello world";
    await composable.triggerTranslation();

    expect(mockErrorManager.handleError).toHaveBeenCalledTimes(1);
    expect(mockErrorManager.handleError.mock.calls[0][0].message).toBe("Translation failed");
  });

  it("should clear translation", async () => {
    const [composable] = withSetup(() => useUnifiedTranslation("popup"));
    await composable.initializeSessionState();
    composable.sourceText.value = "Some text";
    composable.translatedText.value = "Some translation";
    await composable.clearTranslation();
    expect(composable.sourceText.value).toBe("");
    expect(composable.translatedText.value).toBe("");
    expect(sessionMocks.clear).toHaveBeenCalledWith('popup', expect.any(Number));
  });

  it('restores a context-local draft and provider', async () => {
    const provider = ref('default');
    sessionMocks.load.mockResolvedValue({
      draftSource: 'Popup draft',
      sourceLanguage: 'de',
      targetLanguage: 'fr',
      provider: 'deepl',
      revision: 4,
      completedTranslation: null,
    });
    const [composable] = withSetup(() => useUnifiedTranslation('popup', { provider }));

    await composable.initializeSessionState();

    expect(composable.sourceText.value).toBe('Popup draft');
    expect(composable.translatedText.value).toBe('');
    expect(composable.sourceLanguage.value).toBe('auto');
    expect(composable.targetLanguage.value).toBe('en');
    expect(provider.value).toBe('deepl');
  });

  it('restores same-as-default manual selection and marks ordinary requests non-explicit', async () => {
    const provider = ref('google_v2');
    const isExplicitProvider = ref(false);
    sessionMocks.load.mockResolvedValue({
      draftSource: 'hello',
      provider: 'google_v2',
      isExplicitProvider: true,
      revision: 1,
      completedTranslation: null,
    });
    const [composable] = withSetup(() => useUnifiedTranslation('popup', { provider, isExplicitProvider }));
    const { sendMessage } = await import('@/shared/messaging/core/UnifiedMessaging.js');
    sendMessage.mockResolvedValue({
      success: true,
      translatedText: 'bonjour',
      sourceLanguage: 'en',
      targetLanguage: 'fr',
    });

    await composable.initializeSessionState();
    expect(isExplicitProvider.value).toBe(true);
    await composable.triggerTranslation();
    expect(sendMessage.mock.calls[0][0].data).toMatchObject({
      provider: 'google_v2',
      isExplicitProvider: true,
    });

    const [automatic] = withSetup(() => useUnifiedTranslation('popup'));
    automatic.sourceText.value = 'hello';
    await automatic.triggerTranslation();
    expect(sendMessage.mock.calls[1][0].data.isExplicitProvider).toBe(false);
  });

  it('persists and restores manual intent when the selected provider is unchanged', async () => {
    const provider = ref('google_v2');
    const isExplicitProvider = ref(false);
    sessionMocks.load.mockResolvedValue({
      draftSource: 'hello',
      provider: 'google_v2',
      isExplicitProvider: false,
      revision: 1,
      completedTranslation: null,
    });
    const [composable] = withSetup(() => useUnifiedTranslation('popup', { provider, isExplicitProvider }));
    await composable.initializeSessionState();

    isExplicitProvider.value = true;
    await nextTick();
    await Promise.resolve();

    const snapshot = sessionMocks.save.mock.lastCall[1];
    expect(snapshot).toMatchObject({
      provider: 'google_v2',
      isExplicitProvider: true,
    });

    sessionMocks.load.mockResolvedValue(snapshot);
    const restoredProvider = ref('google_v2');
    const restoredExplicitProvider = ref(false);
    const [restored] = withSetup(() => useUnifiedTranslation('popup', {
      provider: restoredProvider,
      isExplicitProvider: restoredExplicitProvider,
    }));
    await restored.initializeSessionState();
    expect(restoredExplicitProvider.value).toBe(true);
  });

  it('restores inherited provider intent using the current global provider', async () => {
    const provider = ref('google_v2');
    const isExplicitProvider = ref(false);
    sessionMocks.load.mockResolvedValue({
      draftSource: 'hello',
      provider: 'google_v2',
      isExplicitProvider: false,
      revision: 1,
      completedTranslation: null,
    });
    const [composable] = withSetup(() => useUnifiedTranslation('sidepanel', { provider, isExplicitProvider }));
    useSettingsStore().settings.TRANSLATION_API = 'edge';

    await composable.initializeSessionState();

    expect(provider.value).toBe('edge');
    expect(isExplicitProvider.value).toBe(false);
  });

  it('restores sidepanel session languages from its snapshot', async () => {
    sessionMocks.load.mockResolvedValue({
      draftSource: 'Sidepanel draft',
      sourceLanguage: 'de',
      targetLanguage: 'fr',
      revision: 4,
      completedTranslation: null,
    });
    const [composable] = withSetup(() => useUnifiedTranslation('sidepanel'));

    await composable.initializeSessionState();

    expect(composable.sourceText.value).toBe('Sidepanel draft');
    expect(composable.sourceLanguage.value).toBe('de');
    expect(composable.targetLanguage.value).toBe('fr');
  });

  it('restores a completed translation only when it matches saved draft source', async () => {
    sessionMocks.load.mockResolvedValue({
      draftSource: 'Hello',
      sourceLanguage: 'de',
      targetLanguage: 'fr',
      revision: 2,
      completedTranslation: {
        source: 'Hello',
        displayTranslatedText: 'سلام',
        translationTarget: 'سلام',
        sourceLanguage: 'en',
        targetLanguage: 'fa',
        provider: 'google_v2',
        actualSourceLanguage: 'en',
        actualTargetLanguage: 'fa',
        timestamp: 1,
      },
    });
    const [composable] = withSetup(() => useUnifiedTranslation('popup'));

    await composable.initializeSessionState();

    expect(composable.sourceText.value).toBe('Hello');
    expect(composable.translatedText.value).toBe('سلام');
    expect(composable.lastTranslation.value).toMatchObject({ source: 'Hello', target: 'سلام' });
    expect(composable.sourceLanguage.value).toBe('auto');
    expect(composable.targetLanguage.value).toBe('en');
    expect(composable.lastTranslation.value).toMatchObject({
      sourceLanguage: 'en',
      targetLanguage: 'fa',
    });
  });

  it('persists draft-only after source edit following a restored result', async () => {
    sessionMocks.load.mockResolvedValue({
      draftSource: 'Hello',
      revision: 2,
      completedTranslation: {
        source: 'Hello',
        displayTranslatedText: 'سلام',
        translationTarget: 'سلام',
        sourceLanguage: 'en',
        targetLanguage: 'fa',
        timestamp: 1,
      },
    });
    const [composable] = withSetup(() => useUnifiedTranslation('popup'));
    await composable.initializeSessionState();

    composable.sourceText.value = 'Hello again';
    await nextTick();

    expect(sessionMocks.save).toHaveBeenLastCalledWith('popup', expect.objectContaining({
      draftSource: 'Hello again',
      completedTranslation: null,
    }));
  });

  it('clears only its session snapshot when source becomes empty', async () => {
    const [composable] = withSetup(() => useUnifiedTranslation('sidepanel'));
    await composable.initializeSessionState();
    composable.sourceText.value = 'draft';
    await nextTick();
    composable.sourceText.value = '';
    await nextTick();

    expect(sessionMocks.clear).toHaveBeenCalledWith('sidepanel', expect.any(Number));
    expect(sessionMocks.clear).not.toHaveBeenCalledWith('popup', expect.any(Number));
  });

  it('persists and restores same-language display text without rewriting canonical target', async () => {
    const [composable] = withSetup(() => useUnifiedTranslation('popup'));
    await composable.initializeSessionState();
    const { sendMessage } = await import("@/shared/messaging/core/UnifiedMessaging.js");
    sendMessage.mockResolvedValue({
      success: true,
      translatedText: null,
      originalText: 'Hello',
      sourceLanguage: 'en',
      targetLanguage: 'en',
    });
    composable.sourceText.value = 'Hello';

    await composable.triggerTranslation();

    expect(composable.translatedText.value).toBe('Hello');
    const snapshot = sessionMocks.save.mock.lastCall[1];
    expect(snapshot.completedTranslation).toMatchObject({
      source: 'Hello',
      displayTranslatedText: 'Hello',
      translationTarget: null,
    });
    expect(snapshot.completedTranslation).not.toHaveProperty('sameLanguage');

    setActivePinia(createPinia());
    sessionMocks.load.mockResolvedValue(snapshot);
    const [restored] = withSetup(() => useUnifiedTranslation('popup'));
    await restored.initializeSessionState();

    expect(restored.translatedText.value).toBe('Hello');
    expect(restored.lastTranslation.value.target).toBeNull();
  });

  it('persists and restores a reversed Popup translation pair', async () => {
    sessionMocks.load.mockResolvedValue({
      draftSource: 'Hello',
      revision: 2,
      completedTranslation: {
        source: 'Hello',
        displayTranslatedText: 'سلام',
        translationTarget: 'سلام',
        sourceLanguage: 'en',
        targetLanguage: 'fa',
        provider: 'google_v2',
        actualSourceLanguage: 'en',
        actualTargetLanguage: 'fa',
        timestamp: 1,
      },
    });
    const [composable] = withSetup(() => useUnifiedTranslation('popup'));
    await composable.initializeSessionState();

    composable.revertTranslation();
    await nextTick();

    const snapshot = sessionMocks.save.mock.lastCall[1];
    expect(snapshot.completedTranslation).toMatchObject({
      source: 'سلام',
      displayTranslatedText: 'Hello',
      translationTarget: 'Hello',
    });

    setActivePinia(createPinia());
    sessionMocks.load.mockResolvedValue(snapshot);
    const [restored] = withSetup(() => useUnifiedTranslation('popup'));
    await restored.initializeSessionState();

    expect(restored.sourceText.value).toBe('سلام');
    expect(restored.translatedText.value).toBe('Hello');
  });

  it('invalidates a same-source revert on the next real source edit', async () => {
    sessionMocks.load.mockResolvedValue({
      draftSource: 'OpenAI',
      revision: 2,
      completedTranslation: {
        source: 'OpenAI',
        displayTranslatedText: 'OpenAI',
        translationTarget: 'OpenAI',
        sourceLanguage: 'en',
        targetLanguage: 'en',
        provider: 'google_v2',
        actualSourceLanguage: 'en',
        actualTargetLanguage: 'en',
        timestamp: 1,
      },
    });
    const [composable] = withSetup(() => useUnifiedTranslation('popup'));
    await composable.initializeSessionState();

    composable.revertTranslation();
    expect(composable.sourceText.value).toBe('OpenAI');

    composable.sourceText.value = 'OpenAI test';
    await nextTick();

    expect(composable.lastTranslation.value).toBeNull();
    expect(sessionMocks.save).toHaveBeenLastCalledWith('popup', expect.objectContaining({
      draftSource: 'OpenAI test',
      completedTranslation: null,
    }));
  });

  it('persists draft-only while streaming and after cancellation or failure', async () => {
    let resolveRequest;
    const [composable] = withSetup(() => useUnifiedTranslation('popup'));
    await composable.initializeSessionState();
    const { sendMessage } = await import("@/shared/messaging/core/UnifiedMessaging.js");
    sendMessage
      .mockImplementationOnce(() => new Promise(resolve => { resolveRequest = resolve; }))
      .mockResolvedValueOnce(undefined);
    composable.sourceText.value = 'draft';

    const request = composable.triggerTranslation();
    await nextTick();
    contentIntegrationMocks.registerTranslation.mock.calls[0][1].onStreamUpdate({ data: 'partial' });

    expect(sessionMocks.save).toHaveBeenLastCalledWith('popup', expect.objectContaining({
      draftSource: 'draft',
      completedTranslation: null,
    }));

    await composable.cancelTranslation();
    await nextTick();
    expect(sessionMocks.save).toHaveBeenLastCalledWith('popup', expect.objectContaining({
      draftSource: 'draft',
      completedTranslation: null,
    }));

    resolveRequest({ success: false, error: 'failed' });
    await request;

    expect(sessionMocks.save).toHaveBeenLastCalledWith('popup', expect.objectContaining({
      draftSource: 'draft',
      completedTranslation: null,
    }));
  });

  it('does not let an older completion overwrite a newer draft snapshot', async () => {
    let resolveRequest;
    const [composable] = withSetup(() => useUnifiedTranslation('popup'));
    await composable.initializeSessionState();
    const { sendMessage } = await import("@/shared/messaging/core/UnifiedMessaging.js");
    sendMessage.mockImplementation(() => new Promise(resolve => { resolveRequest = resolve; }));
    composable.sourceText.value = 'old draft';

    const request = composable.triggerTranslation();
    composable.sourceText.value = 'new draft';
    await nextTick();
    resolveRequest({
      success: true,
      translatedText: 'old result',
      originalText: 'old draft',
      sourceLanguage: 'en',
      targetLanguage: 'fa',
    });
    await request;

    expect(composable.sourceText.value).toBe('new draft');
    expect(sessionMocks.save).toHaveBeenLastCalledWith('popup', expect.objectContaining({
      draftSource: 'new draft',
      completedTranslation: null,
    }));
  });

  it("should update when translationStore.currentTranslation changes", async () => {
    const [composable] = withSetup(() => useUnifiedTranslation("popup"));
    
    const newTranslation = {
      sourceText: "Store source",
      translatedText: "Store translation",
      sourceLanguage: "en",
      targetLanguage: "fa"
    };

    translationStore.currentTranslation = newTranslation;
    
    // Use a loop to wait for the value to change, as it's async
    let attempts = 0;
    while (composable.sourceText.value === "" && attempts < 10) {
      await nextTick();
      await vi.runAllTimersAsync();
      attempts++;
    }

    expect(composable.sourceText.value).toBe("Store source");
    expect(composable.translatedText.value).toBe("Store translation");
  });

  it("should handle minimum loading duration in sidepanel", async () => {
    const [composable] = withSetup(() => useUnifiedTranslation("sidepanel"));
    const { sendMessage } = await import("@/shared/messaging/core/UnifiedMessaging.js");
    
    sendMessage.mockResolvedValue({ success: true, translatedText: "Result" });
    composable.sourceText.value = "Sidepanel test";

    const triggerPromise = composable.triggerTranslation();
    
    vi.advanceTimersByTime(50);
    expect(composable.isTranslating.value).toBe(true);
    
    vi.advanceTimersByTime(100);
    await triggerPromise;
    expect(composable.isTranslating.value).toBe(false);
  });
});
