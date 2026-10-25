import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WindowsState } from './WindowsState.js';

// Mock logger
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

describe('WindowsState', () => {
  let state;
  const frameId = 'test-frame-123';

  beforeEach(() => {
    vi.clearAllMocks();
    state = new WindowsState(frameId);
  });

  it('should initialize with correct default values', () => {
    expect(state.frameId).toBe(frameId);
    expect(state.isVisible).toBe(false);
    expect(state.isIconMode).toBe(false);
    expect(state.pendingTranslationWindow).toBe(false);
    expect(state.isTranslationCancelled).toBe(false);
    expect(state.originalText).toBe(null);
    expect(state.provider).toBe(null);
  });

  it('should reset to initial state', () => {
    state.setVisible(true);
    state.setIconMode(true);
    state.setOriginalText('hello');
    state.setProvider('bing');
    
    state.reset();
    
    expect(state.isVisible).toBe(false);
    expect(state.isIconMode).toBe(false);
    expect(state.originalText).toBe(null);
    expect(state.provider).toBe(null);
  });

  it('tracks initial loading by window ID and ignores stale clears', () => {
    state.setActiveWindowId('window-1');
    state.setInitialLoadingWindow('window-1');
    expect(state.isInitialLoadingWindow()).toBe(true);
    state.setInitialLoadingWindow('window-2');
    expect(state.clearInitialLoadingWindow('window-1')).toBe(false);
    expect(state.isInitialLoadingWindow('window-2')).toBe(true);
    state.reset();
    expect(state.isInitialLoadingWindow('window-2')).toBe(false);
  });

  it('should update visibility and log changes', () => {
    state.setVisible(true);
    expect(state.isVisible).toBe(true);
    
    state.setVisible(false);
    expect(state.isVisible).toBe(false);
  });

  it('should update icon mode', () => {
    state.setIconMode(true);
    expect(state.isIconMode).toBe(true);
  });

  it('should manage translation cancellation', () => {
    state.setTranslationCancelled(true);
    expect(state.isTranslationCancelled).toBe(true);
  });

  it('should manage dragging state', () => {
    const offset = { x: 10, y: 20 };
    state.startDragging(offset);
    expect(state.isDragging).toBe(true);
    expect(state.dragOffset).toEqual(offset);
    
    state.stopDragging();
    expect(state.isDragging).toBe(false);
    expect(state.dragOffset).toEqual({ x: 0, y: 0 });
  });

  it('should compute canShowWindow correctly', () => {
    expect(state.canShowWindow).toBe(true);
    
    state.setTranslationCancelled(true);
    expect(state.canShowWindow).toBe(false);
    
    state.setTranslationCancelled(false);
    state.setPendingTranslationWindow(true);
    expect(state.canShowWindow).toBe(false);
  });

  it('should compute hasActiveElements correctly', () => {
    expect(state.hasActiveElements).toBe(false);
    
    state.setVisible(true);
    expect(state.hasActiveElements).toBe(true);
    
    state.setVisible(false);
    state.setIconMode(true);
    expect(state.hasActiveElements).toBe(true);
  });

  it('should validate state and identify issues', () => {
    // Both visible and icon mode is an issue
    state.setVisible(true);
    state.setIconMode(true);
    expect(state.validateState()).toBe(false);
    
    state.reset();
    // Dragging when not visible is an issue
    state.startDragging({ x: 0, y: 0 });
    expect(state.validateState()).toBe(false);
    
    state.reset();
    expect(state.validateState()).toBe(true);
  });

  it('should provide a snapshot of current state', () => {
    state.setVisible(true);
    state.setOriginalText('test');
    
    const snapshot = state.getSnapshot();
    expect(snapshot.isVisible).toBe(true);
    expect(snapshot.hasOriginalText).toBe(true);
    expect(snapshot.frameId).toBe(frameId);
  });

  it('records successful snapshots, deduplicates the current result, and truncates forward history on a new branch', () => {
    const first = state.commitTranslation('one', {
      translatedText: 'uno', provider: 'p1', sourceLanguage: 'en', targetLanguage: 'es', mode: 'selection',
    });
    expect(state.commitTranslation('one', {
      translatedText: 'uno', provider: 'p1', sourceLanguage: 'en', targetLanguage: 'es', mode: 'selection',
    })).toBe(first);
    state.commitTranslation('two', { translatedText: 'dos', provider: 'p2', targetLanguage: 'fr' });
    expect(state.navigateHistory('previous')).toMatchObject({ sourceText: 'one', translatedText: 'uno' });
    state.commitTranslation('branch', { translatedText: 'branche', provider: 'p3' });
    expect(state.translationHistory.map(({ sourceText }) => sourceText)).toEqual(['one', 'branch']);
    expect(state.historyIndex).toBe(1);
  });

  it('restores provider, source, languages and mode when navigating history', () => {
    state.commitTranslation('source', {
      translatedText: 'result', provider: 'chosen', sourceLanguage: 'de', targetLanguage: 'it', mode: 'selection',
    });
    state.commitTranslation('later', { translatedText: 'later result', provider: 'other' });
    state.setProvider('another');
    const restored = state.navigateHistory('previous');
    expect(restored).toMatchObject({
      sourceText: 'source', translatedText: 'result', provider: 'chosen',
      sourceLanguage: 'de', targetLanguage: 'it', mode: 'selection',
    });
    expect(state.originalText).toBe('source');
    expect(state.provider).toBe('chosen');
  });
});
