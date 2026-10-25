import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WindowsManagerHandler } from './WindowsManagerHandler.js';
import { WindowsManager } from '@/features/windows/managers/WindowsManager.js';
import { TranslationHandler } from '@/features/windows/managers/translation/TranslationHandler.js';

// Mock dependencies
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

vi.mock('@/features/windows/managers/WindowsManager.js', () => {
  const mockInstance = {
    dismiss: vi.fn().mockResolvedValue(),
    ensureInitialized: vi.fn().mockResolvedValue(),
    state: { isVisible: false, isIconMode: false }
  };
  return {
    WindowsManager: {
      getInstance: vi.fn().mockReturnValue(mockInstance),
      resetInstance: vi.fn()
    }
  };
});

vi.mock('@/features/windows/managers/translation/TranslationHandler.js', () => ({
  TranslationHandler: vi.fn()
}));

vi.mock('@/features/windows/managers/interaction/ClickManager.js', () => ({
  ClickManager: vi.fn().mockImplementation(function() {
    this.setHandlers = vi.fn();
    this.addOutsideClickListener = vi.fn();
    this.cleanup = vi.fn();
    return this;
  })
}));

vi.mock('@/features/windows/managers/core/WindowsState.js', () => ({
  WindowsState: vi.fn()
}));

vi.mock('@/features/windows/managers/crossframe/CrossFrameManager.js', () => ({
  CrossFrameManager: vi.fn().mockImplementation(function() {
    this.messageRouter = {
      broadcastOutsideClick: vi.fn()
    };
    return this;
  })
}));

vi.mock('@/core/memory/ResourceTracker.js', () => ({
  default: class {
    constructor() {}
    cleanup() {}
  }
}));

describe('WindowsManagerHandler', () => {
  let handler;
  let mockFeatureManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFeatureManager = {};
    handler = new WindowsManagerHandler({ featureManager: mockFeatureManager });
    
    // Setup window with proper location for top-frame detection
    const mockWindow = {
      location: { href: 'http://example.com' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
    mockWindow.top = mockWindow;
    
    global.window = mockWindow;
  });

  it('should activate WindowsManager in top frame', async () => {
    const success = await handler.activate();

    expect(success).toBe(true);
    expect(handler.getIsActive()).toBe(true);
    expect(WindowsManager.getInstance).toHaveBeenCalledWith();
    expect(TranslationHandler).not.toHaveBeenCalled();
    expect(global.window.windowsManagerInstance).toBeDefined();
  });

  it('should only activate ClickManager in iframe', async () => {
    // Mock iframe context
    const mockParent = { location: { href: 'http://parent.com' } };
    const mockWindow = {
      location: { href: 'http://iframe.com' },
      top: mockParent,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
    global.window = mockWindow;

    const success = await handler.activate();

    expect(success).toBe(true);
    expect(handler.getIsActive()).toBe(true);
    expect(WindowsManager.getInstance).not.toHaveBeenCalled();
    expect(global.window.iframeClickManager).toBeDefined();
  });

  it('should deactivate and cleanup', async () => {
    await handler.activate();
    
    // In this test, we need to ensure they are the same
    const instance = WindowsManager.getInstance();
    handler.windowsManager = instance;
    global.window.windowsManagerInstance = instance;
    
    await handler.deactivate();

    expect(handler.getIsActive()).toBe(false);
    expect(WindowsManager.resetInstance).toHaveBeenCalled();
    expect(global.window.windowsManagerInstance).toBeUndefined();
  });

  it('should return correct status', async () => {
    await handler.activate();
    const status = handler.getStatus();

    expect(status.isActive).toBe(true);
    expect(status.hasWindowsManager).toBe(true);
    expect(status.isInIframe).toBe(false);
  });
});
