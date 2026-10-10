import { describe, it, expect, vi, beforeEach } from 'vitest';

// 1. Mock domtranslator FIRST
vi.mock('domtranslator', () => {
  class MockNodesTranslator {
    constructor(callback) {
      this.callback = callback;
      this.has = vi.fn(() => false);
      this.translate = vi.fn(function(node, cb) { if (cb) cb(node); });
      this.update = vi.fn(function(node, cb) { if (cb) cb(node); });
    }
  }
  
  class MockDOMTranslator {
    constructor(nodesTranslator, options) {
      this.nodesTranslator = nodesTranslator;
      this.options = options;
      this.translate = vi.fn();
      this.restore = vi.fn();
    }
  }

  class MockPersistentDOMTranslator {
    constructor(domTranslator) {
      this.domTranslator = domTranslator;
      this.translate = vi.fn();
      this.restore = vi.fn();
      this.observedNodesStorage = new Map();
    }
  }

  class MockIntersectionScheduler {
    constructor(options) {
      this.options = options;
      this.intersectionObserver = {
        intersectionObserver: { disconnect: vi.fn() }
      };
    }
  }

  return {
    NodesTranslator: MockNodesTranslator,
    DOMTranslator: MockDOMTranslator,
    PersistentDOMTranslator: MockPersistentDOMTranslator,
    IntersectionScheduler: MockIntersectionScheduler
  };
});

vi.mock('domtranslator/utils/nodes', () => ({
  createNodesFilter: vi.fn(() => ({ show: vi.fn() }))
}));

// 2. Mock DomDirectionManager
vi.mock('@/utils/dom/DomDirectionManager.js', () => ({
  applyNodeDirection: vi.fn(),
  isRTL: vi.fn((lang) => lang === 'fa' || lang === 'ar'),
  restoreElementDirection: vi.fn(),
  BIDI_MARKS: {
    RLM: '\u200f',
    LRM: '\u200e'
  }
}));

// 3. Mock HoverPreviewLookup
vi.mock('@/features/shared/hover-preview/HoverPreviewLookup.js', () => ({
  hoverPreviewLookup: {
    add: vi.fn(),
    clear: vi.fn()
  }
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn()
  }))
}));

import { PageTranslationBridge } from './PageTranslationBridge.js';
import { BIDI_MARKS, applyNodeDirection } from '@/utils/dom/DomDirectionManager.js';
import { hoverPreviewLookup } from '@/features/shared/hover-preview/HoverPreviewLookup.js';

describe('PageTranslationBridge', () => {
  let bridge;
  let mockSettings;
  let onTranslateCallback;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new PageTranslationBridge();
    mockSettings = {
      targetLanguage: 'fa',
      lazyLoading: true,
      rootMargin: '100px',
      showOriginalOnHover: true,
      autoTranslateOnDOMChanges: true
    };
    onTranslateCallback = vi.fn(async (text) => `Translated: ${text}`);
  });

  describe('Initialization', () => {
    it('should initialize with correct settings', async () => {
      await bridge.initialize(mockSettings, onTranslateCallback);
      
      expect(bridge.session).toBeDefined();
      expect(bridge.session.intersectionScheduler).toBeDefined();
      expect(bridge.session.domTranslator).toBeDefined();
      expect(bridge.session.persistentTranslator).toBeDefined();
      expect(hoverPreviewLookup.clear).toHaveBeenCalled();
    });

    it('should disable lazy loading if setting is false', async () => {
      mockSettings.lazyLoading = false;
      await bridge.initialize(mockSettings, onTranslateCallback);
      expect(bridge.session.intersectionScheduler).toBeNull();
    });
  });

  describe('Translation Logic (Monkey-Patching)', () => {
    it('should preserve whitespace and inject BiDi marks', async () => {
      await bridge.initialize(mockSettings, onTranslateCallback);
      
      // Access the internal callback passed to NodesTranslator
      const translateWithContext = bridge.session.nodesTranslator.callback;
      
      const originalText = '  Hello  ';
      const result = await translateWithContext(originalText, 1);
      
      // targetLanguage is 'fa' (RTL), so should use RLM
      expect(onTranslateCallback).toHaveBeenCalledWith('Hello', null, 1, undefined);
      expect(result).toBe(`  ${BIDI_MARKS.RLM}Translated: Hello  `);
    });

    it('should use LRM for non-RTL target languages', async () => {
      mockSettings.targetLanguage = 'en';
      await bridge.initialize(mockSettings, onTranslateCallback);
      
      const translateWithContext = bridge.session.nodesTranslator.callback;
      const result = await translateWithContext('Hello', 1);
      
      expect(result).toBe(`${BIDI_MARKS.LRM}Translated: Hello`);
    });

    it('should not inject marks if translation is same as original', async () => {
      onTranslateCallback.mockResolvedValue('Hello');
      await bridge.initialize(mockSettings, onTranslateCallback);
      
      const translateWithContext = bridge.session.nodesTranslator.callback;
      const result = await translateWithContext('Hello', 1);
      
      expect(result).toBe('Hello');
    });

    it('should preserve original ZWNJ if translation is functionally identical (cleaned ZWNJ)', async () => {
      // Original has ZWNJ, but provider returns version without it
      const originalWithZWNJ = 'می\u200cروم';
      const cleanedFromProvider = 'میروم';
      onTranslateCallback.mockResolvedValue(cleanedFromProvider);
      
      await bridge.initialize(mockSettings, onTranslateCallback);
      const translateWithContext = bridge.session.nodesTranslator.callback;
      const result = await translateWithContext(originalWithZWNJ, 1);
      
      // Should return the original text with ZWNJ, and NO BiDi marks (because functionally identical)
      expect(result).toBe(originalWithZWNJ);
      expect(result).toContain('\u200c');
      expect(result).not.toContain(BIDI_MARKS.RLM);
    });
  });

  describe('DOM Marking and Direction', () => {
    it('should apply direction and marks to translated nodes', async () => {
      await bridge.initialize(mockSettings, onTranslateCallback);
      
      const nodesTranslator = bridge.session.nodesTranslator;
      const mockElement = document.createElement('div');
      const mockTextNode = document.createTextNode(`${BIDI_MARKS.RLM}سلام`);
      mockElement.appendChild(mockTextNode);
      
      // Simulate translate call which triggers wrapWithDirection
      nodesTranslator.translate(mockTextNode);
      
      expect(applyNodeDirection).toHaveBeenCalledWith(mockTextNode, 'fa');
      expect(mockElement.getAttribute('data-page-translated')).toBe('true');
      expect(mockElement.getAttribute('data-has-original')).toBe('true');
    });

    it('should add original text to hover lookup', async () => {
      await bridge.initialize(mockSettings, onTranslateCallback);
      
      const nodesTranslator = bridge.session.nodesTranslator;
      const mockTextNode = document.createTextNode('Original Text');
      
      nodesTranslator.translate(mockTextNode);
      
      expect(hoverPreviewLookup.add).toHaveBeenCalledWith(mockTextNode, 'Original Text', 'Original Text');
    });

    it('should capture currentNode during translate and update', async () => {
      await bridge.initialize(mockSettings, onTranslateCallback);
      const nodesTranslator = bridge.session.nodesTranslator;
      const mockNode = document.createElement('div');
      
      nodesTranslator.translate(mockNode);
      expect(nodesTranslator.currentNode).toBe(mockNode);
      
      const mockNode2 = document.createElement('span');
      nodesTranslator.update(mockNode2);
      expect(nodesTranslator.currentNode).toBe(mockNode2);
    });
  });

  describe('Restore and Cleanup', () => {
    it('should restore element correctly', async () => {
      await bridge.initialize(mockSettings, onTranslateCallback);
      const mockElement = document.createElement('div');
      
      bridge.restore(mockElement);
      
      expect(bridge.session).toBeNull(); // cleanup is called in finally
    });

    it('should cleanup observers on cleanup', async () => {
      await bridge.initialize(mockSettings, onTranslateCallback);
      const scheduler = bridge.session.intersectionScheduler;
      
      bridge.cleanup();
      
      expect(scheduler.intersectionObserver.intersectionObserver.disconnect).toHaveBeenCalled();
      expect(bridge.session).toBeNull();
    });
  });
});
