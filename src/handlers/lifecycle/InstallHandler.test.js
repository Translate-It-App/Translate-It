import { describe, it, expect, vi, beforeEach } from 'vitest';
import { storageManager } from '@/shared/storage/core/StorageCore.js';
import { runSettingsMigrations } from '@/shared/config/settingsMigrations.js';
import { PROMPT_REGISTRY } from '@/shared/config/PromptRegistry.js';
import { getPersistedDefaultSettings } from '@/shared/config/settingsDefaults.js';
import {
  runIncrementalSettingsMigrations,
  handleInstallationEvent
} from '@/handlers/lifecycle/InstallHandler.js';

vi.mock('@/shared/storage/core/StorageCore.js', () => ({
  storageManager: {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(true),
    remove: vi.fn().mockResolvedValue(true),
    on: vi.fn(),
    clear: vi.fn()
  }
}));

vi.mock('@/shared/config/settingsMigrations.js', () => ({
  runSettingsMigrations: vi.fn()
}));

vi.mock('@/utils/UtilsFactory.js', () => ({
  utilsFactory: {}
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    info: vi.fn(),
    init: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: { getManifest: () => ({ version: '0.0.0' }), getURL: (s) => 'chrome-extension://x/' + s },
    contextMenus: { removeAll: vi.fn().mockResolvedValue(true) },
    tabs: { create: vi.fn().mockResolvedValue(true) },
    notifications: { clear: vi.fn().mockResolvedValue(true), create: vi.fn().mockResolvedValue(true) }
  }
}));

const NON_EDITABLE_KEYS = Object.values(PROMPT_REGISTRY)
  .filter(p => !p.editable)
  .map(p => p.key);

describe('InstallHandler migration persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should remove reported legacy wrapper keys from storage', async () => {
    storageManager.get.mockResolvedValue({
      THEME: 'dark',
      PROMPT_BASE_AI_BATCH: 'stale wrapper'
    });
    runSettingsMigrations.mockResolvedValue({
      updates: {},
      removals: ['PROMPT_BASE_AI_BATCH'],
      logs: ['Removing obsolete stored prompt wrapper: PROMPT_BASE_AI_BATCH']
    });

    await runIncrementalSettingsMigrations();

    expect(storageManager.remove).toHaveBeenCalledWith(['PROMPT_BASE_AI_BATCH']);
    expect(storageManager.set).not.toHaveBeenCalled();
  });

  it('should persist normal updates and skip removal when removals is empty', async () => {
    storageManager.get.mockResolvedValue({ THEME: 'dark' });
    runSettingsMigrations.mockResolvedValue({
      updates: { APP_NAME: 'Translate It' },
      removals: [],
      logs: ['Added missing setting: APP_NAME']
    });

    await runIncrementalSettingsMigrations();

    expect(storageManager.set).toHaveBeenCalledWith({ APP_NAME: 'Translate It' });
    expect(storageManager.remove).not.toHaveBeenCalled();
  });

  it('should apply updates and removals together', async () => {
    storageManager.get.mockResolvedValue({
      THEME: 'dark',
      PROMPT_SUBTITLE_BASE: 'stale wrapper'
    });
    runSettingsMigrations.mockResolvedValue({
      updates: { APP_NAME: 'Translate It' },
      removals: ['PROMPT_SUBTITLE_BASE'],
      logs: []
    });

    await runIncrementalSettingsMigrations();

    expect(storageManager.set).toHaveBeenCalledWith({ APP_NAME: 'Translate It' });
    expect(storageManager.remove).toHaveBeenCalledWith(['PROMPT_SUBTITLE_BASE']);
  });

  it('should persist legacy Gemini thinking conversion and remove the old key', async () => {
    storageManager.get.mockResolvedValue({ GEMINI_THINKING_ENABLED: true });
    runSettingsMigrations.mockResolvedValue({
      updates: { GEMINI_THINKING_MODE: 'minimal' },
      removals: ['GEMINI_THINKING_ENABLED'],
      logs: []
    });

    await runIncrementalSettingsMigrations();

    expect(storageManager.set).toHaveBeenCalledWith({ GEMINI_THINKING_MODE: 'minimal' });
    expect(storageManager.remove).toHaveBeenCalledWith(['GEMINI_THINKING_ENABLED']);
  });
});

describe('InstallHandler fresh-install persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No existing data → truly fresh installation
    storageManager.get.mockResolvedValue({});
    runSettingsMigrations.mockResolvedValue({ updates: {}, removals: [], logs: [] });
  });

  it('should persist exactly canonical defaults', async () => {
    await handleInstallationEvent({ reason: 'install' });

    expect(storageManager.set).toHaveBeenCalledTimes(1);
    const persisted = storageManager.set.mock.calls[0][0];

    expect(Object.keys(persisted).sort()).toEqual(
      Object.keys(getPersistedDefaultSettings()).sort()
    );
    expect(persisted).toHaveProperty('THEME');
    expect(persisted).toHaveProperty('PROMPT_TEMPLATE');
    expect(persisted.TRANSLATION_API).toBe('edge');
    expect(persisted.GEMINI_MODEL).toBe('gemini-3.5-flash-lite');
    expect(persisted.WEBAI_API_MODEL).toBe('gemini-auto');
  });
});

describe('InstallHandler legacy migration persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should not reintroduce wrapper prompts and should preserve normal + editable settings', async () => {
    const legacyStorage = {
      API_KEY: 'legacy-key',          // triggers legacy migration
      THEME: 'dark',
      TRANSLATION_API: 'googlev2',
      CUSTOM_API_URL: 'https://x',
      CHANGELOG_URL: 'stale runtime constant',
      PROMPT_TEMPLATE: 'custom user $_{TEXT}', // editable custom — survives
      PROMPT_SUBTITLE_USER: 'subtitle $_{SOURCE} $_{TARGET}', // editable
      PROMPT_BASE_AI_BATCH: 'stale wrapper'     // legacy wrapper — must not be re-added
    };
    storageManager.get.mockResolvedValue(legacyStorage);
    runSettingsMigrations.mockResolvedValue({ updates: {}, removals: [], logs: [] });

    await handleInstallationEvent({ reason: 'update' });

    // performLegacyMigration persists a single merged object (clear + set).
    expect(storageManager.set).toHaveBeenCalled();
    const persisted = storageManager.set.mock.calls[0][0];

    // Old wrapper not reintroduced by the CONFIG-default fill step.
    NON_EDITABLE_KEYS.forEach(key => {
      expect(persisted).not.toHaveProperty(key);
    });

    // Normal persisted settings survive migration.
    expect(persisted.THEME).toBe('dark');
    expect(persisted.TRANSLATION_API).toBe('googlev2');
    expect(persisted.API_KEY).toBe('legacy-key');
    expect(persisted.CUSTOM_API_URL).toBe('https://x');
    expect(persisted.CHANGELOG_URL).toBeUndefined();

    // Editable customized prompts survive.
    expect(persisted.PROMPT_TEMPLATE).toBe('custom user $_{TEXT}');
    expect(persisted.PROMPT_SUBTITLE_USER).toBe('subtitle $_{SOURCE} $_{TARGET}');
  });
});
