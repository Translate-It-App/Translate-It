import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('ContentApp transcript preference gate', () => {
  it('does not mount the async transcript renderer when both displays are disabled', () => {
    const source = readFileSync('src/apps/content/ContentApp.vue', 'utf8');

    expect(source).toContain('v-if="isTopFrame && (showTranslatedTranscript || showOriginalTranscript)"');
    expect(source).toContain(':show-translated-transcript="showTranslatedTranscript"');
    expect(source).toContain(':show-original-transcript="showOriginalTranscript"');
  });

  it('resolves and passes the optional shared translation font at the content boundary', () => {
    const source = readFileSync('src/apps/content/ContentApp.vue', 'utf8');

    expect(source).toContain("import { resolveTranslationFontFamily } from '@/shared/fonts/TranslationFontResolver.js';");
    expect(source).toContain('settings?.LIVE_DUBBING_USE_TRANSLATION_FONT !== true');
    expect(source).toContain('settings.LIVE_DUBBING_TARGET_LANGUAGE || CONFIG.LIVE_DUBBING_TARGET_LANGUAGE');
    expect(source).toContain(':font-family="liveDubbingFontFamily"');
    expect(source).toContain('normalizeLiveDubbingSubtitleSize');
    expect(source).toContain('settingsStore.settings?.LIVE_DUBBING_SUBTITLE_SIZE');
    expect(source).toContain(':subtitle-size="liveDubbingSubtitleSize"');
    expect(source).not.toContain('TRANSLATION_FONT_SIZE');
  });
});

describe('ContentApp desktop FAB visibility gate', () => {
  it('keeps the desktop FAB absent until exclusion state is ready and allowed', () => {
    const source = readFileSync('src/apps/content/ContentApp.vue', 'utf8');

    expect(source).toContain('settingsStore.isInitialized && isExtensionEnabled && !isMobileUI && showDesktopFab && desktopFabVisibility.isReady.value && !desktopFabVisibility.isDismissed.value && isTopFrame');
    expect(source).not.toContain('!isMobileUI && !isFullscreen && showDesktopFab');
    expect(source).toContain('@dismiss="handleDesktopFabDismiss"');
    expect(source).toContain('@presence="desktopFabVisibility.setChildPresence"');
    expect(source).toContain('core.desktopFabController = desktopFabController');
    expect(source).toContain('registeredDesktopFabCore?.desktopFabController === desktopFabController');
  });
});

describe('ContentApp translation window history props', () => {
  it('passes window-owned history position to the floating window', () => {
    const source = readFileSync('src/apps/content/ContentApp.vue', 'utf8');
    expect(source).toContain(':history-index="window.historyIndex"');
    expect(source).toContain(':history-length="window.historyLength"');
  });
});
