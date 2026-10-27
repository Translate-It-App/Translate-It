import { describe, it, expect } from 'vitest';
import { 
  shouldApplyRtl, 
  isRTLStrongCharacter, 
  isLTRStrongCharacter 
} from './textAnalysis.js';

describe('textAnalysis - Direction Detection', () => {
  describe('isRTLStrongCharacter', () => {
    it('should identify Arabic/Persian characters as RTL strong', () => {
      expect(isRTLStrongCharacter('س'.charCodeAt(0))).toBe(true);
      expect(isRTLStrongCharacter('ا'.charCodeAt(0))).toBe(true);
      expect(isRTLStrongCharacter('پ'.charCodeAt(0))).toBe(true);
    });

    it('should identify Hebrew characters as RTL strong', () => {
      expect(isRTLStrongCharacter('א'.charCodeAt(0))).toBe(true);
    });

    it('should return false for Latin characters', () => {
      expect(isRTLStrongCharacter('A'.charCodeAt(0))).toBe(false);
    });
  });

  describe('isLTRStrongCharacter', () => {
    it('should identify Latin characters as LTR strong', () => {
      expect(isLTRStrongCharacter('A'.charCodeAt(0))).toBe(true);
      expect(isLTRStrongCharacter('z'.charCodeAt(0))).toBe(true);
    });

    it('should identify Cyrillic characters as LTR strong', () => {
      expect(isLTRStrongCharacter('Я'.charCodeAt(0))).toBe(true);
    });

    it('should return false for Arabic characters', () => {
      expect(isLTRStrongCharacter('س'.charCodeAt(0))).toBe(false);
    });
  });

  describe('shouldApplyRtl', () => {
    it('should return true for purely Persian text', () => {
      expect(shouldApplyRtl('سلام دنیا')).toBe(true);
    });

    it('should return false for purely English text', () => {
      expect(shouldApplyRtl('Hello World')).toBe(false);
    });

    it('should apply RTL for mixed text with > 40% RTL content', () => {
      // "سلام World" -> 4 RTL chars (س ل ا م) + 1 space + 5 LTR chars (W o r l d) = 10 total
      // 4/9 strong chars = 44% > 40% -> should be true
      expect(shouldApplyRtl('سلام World')).toBe(true);
    });

    it('keeps the default threshold strict at exactly 40%', () => {
      expect(shouldApplyRtl('ابabc')).toBe(false);
    });

    it('uses custom thresholds with a strict greater-than comparison', () => {
      expect(shouldApplyRtl('سلامabcd', 0.5)).toBe(false);
      expect(shouldApplyRtl('ابتab', 0.5)).toBe(true);
    });

    it('should apply LTR for mixed text with mostly English', () => {
      // "Hi سلام" -> 2 LTR + 1 space + 4 RTL = 4/6 = 66% RTL -> actually this would be true
      // Let's try "English is much longer than سلام"
      expect(shouldApplyRtl('English is much longer than سلام')).toBe(false);
    });

    it('should handle numbers and punctuation (neutral characters)', () => {
      // Neutral characters shouldn't count towards the majority but shouldn't break detection
      expect(shouldApplyRtl('سلام 123!')).toBe(true);
      expect(shouldApplyRtl('Hello 123!')).toBe(false);
    });
  });
});
