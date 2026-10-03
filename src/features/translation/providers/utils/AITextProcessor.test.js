import { describe, it, expect, vi } from 'vitest';
import { AITextProcessor } from './AITextProcessor.js';

// Mock dependencies
vi.mock('../../core/ProviderConfigurations.js', () => ({
  getProviderBatching: vi.fn(() => ({
    strategy: 'smart',
    optimalSize: 10,
    maxComplexity: 500
  }))
}));

// Mock Logger
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

describe('AITextProcessor', () => {
  it('estimates source length when a structured request carries scalar text', () => {
    expect(AITextProcessor.estimateOriginalChars('Who are you?')).toBe(12);
  });

  describe('calculateTextComplexity', () => {
    it('should calculate higher complexity for long and structured text', () => {
      const simple = 'Hello world.';
      const complex = 'This is a longer sentence with more words, and it should have higher complexity because of its length and structure!';
      
      const simpleScore = AITextProcessor.calculateTextComplexity(simple);
      const complexScore = AITextProcessor.calculateTextComplexity(complex);
      
      expect(complexScore).toBeGreaterThan(simpleScore);
    });

    it('should return 0 for empty or non-string input', () => {
      expect(AITextProcessor.calculateTextComplexity('')).toBe(0);
      expect(AITextProcessor.calculateTextComplexity(null)).toBe(0);
    });
  });

  describe('createSmartBatches', () => {
    it('should put small number of short texts into a single batch', () => {
      const texts = ['Text 1', 'Text 2', 'Text 3'];
      const batches = AITextProcessor.createSmartBatches(texts, 'TestProvider', 10, 500);
      
      expect(batches).toHaveLength(1);
      expect(batches[0]).toEqual(texts);
    });

    it('should split texts into multiple batches when complexity limit is exceeded', () => {
      // Create many long texts to exceed complexity
      const longText = 'A very long text sentence that repeats many times to increase complexity. '.repeat(10);
      const texts = Array(10).fill(longText);
      
      // With maxComplexity = 100, it should definitely split
      const batches = AITextProcessor.createSmartBatches(texts, 'TestProvider', 20, 100);
      
      expect(batches.length).toBeGreaterThan(1);
    });
  });

  describe('Placeholder Protection', () => {
    it('should detect placeholders correctly', () => {
      expect(AITextProcessor.hasPlaceholders(['Normal text'])).toBe(false);
      expect(AITextProcessor.hasPlaceholders(['Text with [[AIWC-1]] placeholder'])).toBe(true);
      expect(AITextProcessor.hasPlaceholders([{ t: '[[AIWC-2]] inside object' }])).toBe(true);
    });

    it('should force atomic (single) batching when placeholders are present', () => {
      const texts = ['[[AIWC-1]]', 'Text 2', '[[AIWC-3]]'];
      // Even with optimalSize=1, it should keep them together
      const batches = AITextProcessor.createOptimalBatches(texts, 'TestProvider', null, { 
        strategy: 'fixed', 
        optimalSize: 1 
      });
      
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(3);
    });

    it('should validate placeholder boundaries', () => {
      const original = 'Part 1 [[AIWC-1]] Part 2';
      const safeChunks = ['Part 1 [[AIWC-1]]', 'Part 2'];
      const brokenChunks = ['Part 1 [[AIWC-', '1]] Part 2'];
      
      expect(AITextProcessor.validatePlaceholderBoundaries(safeChunks, original)).toBe(true);
      expect(AITextProcessor.validatePlaceholderBoundaries(brokenChunks, original)).toBe(false);
    });
  });

  describe('splitIntoSentences', () => {
    it('should split English sentences correctly', () => {
      const text = 'Hello world. How are you? Fine!';
      const sentences = AITextProcessor.splitIntoSentences(text, 'en');
      
      // Note: Intl.Segmenter might include the spaces in segments
      expect(sentences.length).toBe(3);
      expect(sentences[0]).toMatch(/Hello world/);
    });

    it('should split Persian/Arabic sentences correctly', () => {
      const text = 'سلام. خوبی؟ من خوبم!';
      const sentences = AITextProcessor.splitIntoSentences(text, 'fa');
      
      expect(sentences.length).toBe(3);
      expect(sentences[0]).toMatch(/سلام/);
    });
  });

  describe('calculatePayloadChars', () => {
    it('should calculate OpenAI-style message chars', () => {
      const messages = [
        { role: 'system', content: 'You are a translator' },
        { role: 'user', content: 'Hello' }
      ];
      const count = AITextProcessor.calculatePayloadChars(messages);
      expect(count).toBe(20 + 5); // 25
    });

    it('should calculate Gemini-style parts chars', () => {
      const msg = {
        parts: [{ text: 'Part 1' }, { text: 'Part 2' }]
      };
      const count = AITextProcessor.calculatePayloadChars(msg);
      expect(count).toBe(6 + 6); // 12
    });
  });
});
