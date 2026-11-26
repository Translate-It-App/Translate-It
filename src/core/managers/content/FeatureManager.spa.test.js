import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  exclusionChecker: { updateUrl: vi.fn(), isFeatureAllowed: vi.fn().mockResolvedValue(true), refreshSettings: vi.fn() },
  settingsManager: { get: vi.fn((k, fb) => fb), isExtensionEnabled: vi.fn(() => false) },
  loadFeature: vi.fn().mockResolvedValue(null),
  sendRegularMessage: vi.fn().mockResolvedValue({ success: true }),
  matchesAutoTranslateRule: vi.fn(() => false),
}));

vi.mock('@/features/exclusion/core/ExclusionChecker.js', () => ({ ExclusionChecker: { getInstance: () => mocks.exclusionChecker, resetInstance: vi.fn() } }));
vi.mock('@/shared/managers/SettingsManager.js', () => ({ default: mocks.settingsManager }));
vi.mock('@/core/content-scripts/chunks/lazy-features.js', () => ({ loadFeature: mocks.loadFeature }));
vi.mock('@/shared/messaging/core/UnifiedMessaging.js', () => ({ sendRegularMessage: mocks.sendRegularMessage }));
vi.mock('@/utils/ui/exclusion.js', () => ({ matchesAutoTranslateRule: mocks.matchesAutoTranslateRule }));
vi.mock('@/shared/logging/logger.js', () => ({ getScopedLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), init: vi.fn() }) }));
vi.mock('@/shared/error-management/ErrorHandler.js', () => ({ ErrorHandler: { getInstance: () => ({ handle: vi.fn() }) } }));
vi.mock('@/shared/error-management/ErrorTypes.js', () => ({ ErrorTypes: {} }));
vi.mock('@/shared/storage/core/StorageCore.js', () => ({ storageManager: { on: vi.fn(), off: vi.fn() } }));
vi.mock('@/features/windows/managers/WindowsManager.js', () => ({ WindowsManager: { resetInstance: vi.fn() } }));

import { FeatureManager } from './FeatureManager.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve=res; reject=rej; });
  return { promise, resolve, reject };
}

describe('SPA navigation behavioral deterministic', () => {
  let manager;
  beforeEach(async () => {
    vi.clearAllMocks();
    await FeatureManager.resetInstance();
    manager = new FeatureManager();
    manager._lifecycleRevision = 0;
    manager._navigationRevision = 0;
    manager.initialized = true;
    manager.exclusionChecker = mocks.exclusionChecker;
    mocks.settingsManager.isExtensionEnabled.mockReturnValue(true);
    mocks.settingsManager.get.mockImplementation((k, fb) => {
      if (k === 'WHOLE_PAGE_TRANSLATION_ENABLED') return true;
      if (k === 'WHOLE_PAGE_AUTO_TRANSLATE_RULES') return [{ pattern: 'example' }];
      return fb;
    });
    mocks.matchesAutoTranslateRule.mockReturnValue(true);
    mocks.exclusionChecker.isFeatureAllowed.mockResolvedValue(true);
    mocks.loadFeature.mockResolvedValue({ userRestoredOverride: false, autoStartCancelledUrls: new Set(), isActive: false, activate: vi.fn().mockResolvedValue() });
    mocks.sendRegularMessage.mockResolvedValue({ success: true });
    vi.spyOn(manager, 'reevaluateFeatures').mockResolvedValue();
  });

  it('stale A sends no PAGE_TRANSLATE after B becomes authoritative', async () => {
    const enteredA = deferred();
    const allowA = deferred();
    let aEntered = false;
    mocks.exclusionChecker.isFeatureAllowed.mockImplementation(() => {
      if (!aEntered) {
        aEntered = true;
        enteredA.resolve();
        return allowA.promise;
      }
      return Promise.resolve(true);
    });

    const originalUrl = window.location.href;
    const navigate = (path, routeRevision) => {
      window.history.replaceState({}, '', path);
      return manager.checkForUrlChange({
        navigationCursor: { documentEpoch: 1, routeRevision, url: window.location.href },
        restartFence: 'same-tab-fence',
      });
    };

    try {
      const navA = navigate('/pageA', 1);
      await enteredA.promise;
      expect(mocks.exclusionChecker.isFeatureAllowed).toHaveBeenCalledTimes(1);

      await navigate('/pageB', 2);
      const urlB = window.location.href;
      expect(mocks.sendRegularMessage).toHaveBeenCalledOnce();
      expect(manager._lastDetectedUrl).toBe(urlB);

      allowA.resolve(true);
      await navA;
      expect(mocks.sendRegularMessage).toHaveBeenCalledOnce();
      expect(manager._lastDetectedUrl).toBe(urlB);
    } finally {
      allowA.resolve(true);
      window.history.replaceState({}, '', originalUrl);
    }
  });
});
