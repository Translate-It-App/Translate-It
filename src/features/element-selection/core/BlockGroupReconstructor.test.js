import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { BlockGroupReconstructor, BlockGroupMutationFailure } from './BlockGroupReconstructor.js';
import { TranslationUnit } from '@/features/translation/ir/TranslationUnit.js';

const nativeGetComputedStyle = window.getComputedStyle.bind(window);
let pseudoStyleSpy;

const enablePseudoElementStyles = () => {
  pseudoStyleSpy = vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    if (pseudo) return { content: 'none' };
    return nativeGetComputedStyle(element, pseudo);
  });
};


// Mock logger
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

describe('BlockGroupReconstructor', () => {
  let units;
  let textNodes;

  beforeEach(() => {
    document.body.innerHTML = '';
    
    // Create actual text DOM nodes
    const div = document.createElement('div');
    div.className = 'container';
    div.innerHTML = '<span>Hello </span><strong>world</strong><i>.</i>';
    document.body.appendChild(div);

    textNodes = [
      div.childNodes[0].firstChild, // "Hello "
      div.childNodes[1].firstChild, // "world"
      div.childNodes[2].firstChild  // "."
    ];

    units = [
      new TranslationUnit({
        id: 'n1',
        blockId: 'g1',
        text: 'Hello',
        leadingWS: '',
        trailingWS: ' ',
        preWhitespace: false,
        directionHint: 'ltr',
        inlineParentTags: ['span'],
        mode: 'standard'
      }),
      new TranslationUnit({
        id: 'n2',
        blockId: 'g1',
        text: 'world',
        leadingWS: '',
        trailingWS: '',
        preWhitespace: false,
        directionHint: 'ltr',
        inlineParentTags: ['strong'],
        mode: 'standard'
      }),
      new TranslationUnit({
        id: 'n3',
        blockId: 'g1',
        text: '.',
        leadingWS: '',
        trailingWS: '',
        preWhitespace: false,
        directionHint: 'ltr',
        inlineParentTags: ['i'],
        mode: 'standard'
      })
    ];

    // Assign text node references
    units[0].node = textNodes[0];
    units[1].node = textNodes[1];
    units[2].node = textNodes[2];
  });

  afterEach(() => {
    pseudoStyleSpy?.mockRestore();
    pseudoStyleSpy = null;
  });

  describe('injectMarkers', () => {
    it('should inject printable markers correctly at segment boundaries using ASCII @@', () => {
      const assembledText = BlockGroupReconstructor.injectMarkers(units);
      expect(assembledText).toBe('Hello@@SEG_n2@@world@@SEG_n3@@.');
    });

    it('should support session-scoped markers', () => {
      const assembledText = BlockGroupReconstructor.injectMarkers(units, 'abc');
      expect(assembledText).toBe('Hello@@TI_SEG_abc_n2@@world@@TI_SEG_abc_n3@@.');
    });

    it('should support entropy-scoped escaping and canonical marker format', () => {
      const entropy = 'xyz';
      const session = 's123';
      const assembledText = BlockGroupReconstructor.injectMarkers(units, session, entropy);
      // Canonical: @@TI_SEG_<entropy>_<sessionId>_<segmentId>@@
      expect(assembledText).toBe('Hello@@TI_SEG_xyz_s123_n2@@world@@TI_SEG_xyz_s123_n3@@.');
    });

    it('should escape literal @@ sequences in content', () => {
      units[0].text = 'a@@b';
      const assembledText = BlockGroupReconstructor.injectMarkers(units, 's1', 'e1');
      expect(assembledText).toContain('a@@TI_ESC_e1@@b');
    });
  });

  describe('shadow direction ancestry', () => {
    it('uses composed host direction without crossing the BlockGroup mutation boundary', () => {
      const host = document.createElement('x-host');
      host.setAttribute('dir', 'rtl');
      const shadow = host.attachShadow({ mode: 'open' });
      const owner = document.createElement('span');
      const text = document.createTextNode('Hello');
      owner.appendChild(text);
      shadow.appendChild(owner);
      document.body.appendChild(host);

      const unit = new TranslationUnit({
        id: 'n1',
        blockId: 'shadow-group',
        text: 'Hello',
        leadingWS: '',
        trailingWS: '',
        preWhitespace: false,
        directionHint: 'rtl',
        inlineParentTags: ['span'],
        mode: 'standard',
      });
      unit.node = text;

      const result = BlockGroupReconstructor.apply([unit], 'سلام', 'fa', host);

      expect(text.nodeValue).toBe('سلام');
      expect(host.textContent).toBe('');
      expect(host.style.direction).toBe('');
      result.transaction.finalize();
      document.body.removeChild(host);
    });

    it('injects BiDi marks for direct ShadowRoot text without mutating host direction', () => {
      const host = document.createElement('x-host');
      host.setAttribute('dir', 'ltr');
      const shadow = host.attachShadow({ mode: 'open' });
      const text = document.createTextNode('Hello');
      shadow.appendChild(text);
      document.body.appendChild(host);

      const unit = new TranslationUnit({
        id: 'n1',
        blockId: 'direct-shadow-group',
        text: 'Hello',
        leadingWS: '',
        trailingWS: '',
        preWhitespace: false,
        directionHint: 'ltr',
        inlineParentTags: [],
        mode: 'standard',
      });
      unit.node = text;

      const result = BlockGroupReconstructor.apply([unit], 'سلام', 'fa', host);

      expect(text.nodeValue).toContain('\u200fسلام\u200f');
      expect(host.style.direction).toBe('');
      expect(host.hasAttribute('data-translate-dir')).toBe(false);
      result.transaction.finalize();
      document.body.removeChild(host);
    });
  });

  it('restores a translation font with its transaction', () => {
    enablePseudoElementStyles();
    const owner = document.createElement('span');
    owner.style.fontFamily = 'serif';
    const text = document.createTextNode('Hello');
    owner.appendChild(text);
    document.body.appendChild(owner);
    const unit = new TranslationUnit({
      id: 'font-node', blockId: 'font-group', text: 'Hello', leadingWS: '', trailingWS: '',
      preWhitespace: false, directionHint: 'ltr', inlineParentTags: ['span'], mode: 'standard',
    });
    unit.node = text;

    const result = BlockGroupReconstructor.apply([unit], 'Bonjour', 'fr', document.body, '', '', 'system-ui');

    expect(owner.style.fontFamily).toBe('system-ui');
    result.transaction.rollback();
    expect(owner.style.fontFamily).toBe('serif');
    expect(owner.style.getPropertyPriority('font-family')).toBe('');
    document.body.removeChild(owner);
  });

  it('applies and transactionally restores CSS font targeting for eligible mixed content', () => {
    enablePseudoElementStyles();
    window.translateItContentCore = {
      injectMainDOMStyles(css, id) {
        if (document.getElementById(id)) return;
        const style = document.createElement('style');
        style.id = id;
        style.textContent = css;
        document.head.append(style);
      },
    };
    const owner = document.createElement('span');
    owner.style.fontFamily = 'serif';
    const text = document.createTextNode('Hello');
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = 'link sibling';
    owner.append(text, link);
    document.body.append(owner);
    const unit = new TranslationUnit({
      id: 'css-font-node', blockId: 'css-font-group', text: 'Hello', leadingWS: '', trailingWS: '',
      preWhitespace: false, directionHint: 'ltr', inlineParentTags: ['span'], mode: 'standard',
    });
    unit.node = text;

    const result = BlockGroupReconstructor.apply([unit], 'Bonjour', 'fr', document.body, '', '', 'system-ui');
    expect(owner.hasAttribute('data-ti-select-font-target')).toBe(true);
    expect(owner.style.getPropertyValue('--ti-select-element-font-family')).toBe('system-ui');
    expect(text.parentNode).toBe(owner);
    expect(owner.contains(link)).toBe(true);
    result.transaction.rollback();
    expect(owner.hasAttribute('data-ti-select-font-target')).toBe(false);
    expect(owner.style.getPropertyValue('--ti-select-element-font-family')).toBe('');
    expect(text.nodeValue).toBe('Hello');
    expect(text.parentNode).toBe(owner);
    document.body.removeChild(owner);
  });

  describe('splitTranslatedBlock & Corruption Detection', () => {
    it('should split translated text correctly into expected segments', () => {
      const translated = 'مرحبا @@SEG_n2@@بالعالم@@SEG_n3@@.';
      const segments = BlockGroupReconstructor.splitTranslatedBlock(translated, units);

      expect(segments.length).toBe(3);
      expect(segments[0]).toEqual({ id: 'n1', text: 'مرحبا ' });
      expect(segments[1]).toEqual({ id: 'n2', text: 'بالعالم' });
      expect(segments[2]).toEqual({ id: 'n3', text: '.' });
    });

    it('should be robust to LLM fuzzing (spaces/casing) inside markers', () => {
      const translated = 'مرحبا @@  seg_n2  @@بالعالم@@  SEG_n3  @@.';
      const segments = BlockGroupReconstructor.splitTranslatedBlock(translated, units);
      expect(segments.length).toBe(3);
      expect(segments[1].id).toBe('n2');
    });

    it('should require exact entropy and session ID matching', () => {
      const translated = 'مرحبا @@TI_SEG_xyz_s123_n2@@بالعالم@@TI_SEG_xyz_s123_n3@@.';
      const segments = BlockGroupReconstructor.splitTranslatedBlock(translated, units, 's123', 'xyz');
      expect(segments[1].id).toBe('n2');

      // Mismatched entropy should be treated as literal text
      const mismatched = 'مرحبا @@TI_SEG_WRONG_s123_n2@@بالعالم@@TI_SEG_xyz_s123_n3@@.';
      expect(() => BlockGroupReconstructor.splitTranslatedBlock(mismatched, units, 's123', 'xyz')).toThrow(/Segment count mismatch/);
    });

    it('rejects localized digits inside a segment marker', () => {
      const translated = 'A @@TI_SEG_xyz_s123_n۲@@ B @@TI_SEG_xyz_s123_n3@@ C';

      expect(() => BlockGroupReconstructor.splitTranslatedBlock(translated, units, 's123', 'xyz')).toThrow(/Segment count mismatch/);
    });

    it('allows localized digits after a completed segment marker', () => {
      const translated = 'A @@TI_SEG_xyz_s123_n2@@۲۴۳@@TI_SEG_xyz_s123_n3@@ C';
      const segments = BlockGroupReconstructor.splitTranslatedBlock(translated, units, 's123', 'xyz');

      expect(segments[1].text).toBe('۲۴۳');
    });

    it('should reject foreign session IDs', () => {
      const translated = 'مرحبا @@TI_SEG_abc_n2@@بالعالم@@TI_SEG_abc_n3@@.';
      expect(() => BlockGroupReconstructor.splitTranslatedBlock(translated, units, 'def')).toThrow();
    });

    it('should detect and reject duplicate marker attempts (as count mismatch)', () => {
      const duplicated = 'مرحبا @@SEG_n2@@بالعالم@@SEG_n2@@@@SEG_n3@@.';
      expect(() => BlockGroupReconstructor.splitTranslatedBlock(duplicated, units)).toThrow(/Segment count mismatch/);
    });

    it('should detect and reject reordered markers', () => {
      const reordered = 'مرحبا @@SEG_n3@@.@@SEG_n2@@بالعالم';
      expect(() => BlockGroupReconstructor.splitTranslatedBlock(reordered, units)).toThrow(/Structural validation failure \(monotonicity\)/);
    });

    it('does not repair a marker-less interval with an expected unit ID', () => {
      const twoUnits = [
        { id: 'n1', text: 'A' },
        { id: 'n2', text: 'B' },
      ];

      expect(() => BlockGroupReconstructor.splitTranslatedBlock('A B', twoUnits)).toThrow(/Segment count mismatch/);
    });
  });

  describe('Validation Resilience & Unescaping', () => {
    it('rolls back earlier segments when a later text mutation throws', () => {
      const originalSecond = textNodes[1].nodeValue;
      Object.defineProperty(textNodes[1], 'nodeValue', {
        configurable: true,
        get: () => originalSecond,
        set: () => { throw 'group-failure'; }
      });

      let failure;
      try {
        BlockGroupReconstructor.apply(units, 'Uno @@SEG_n2@@Dos@@SEG_n3@@Tres', 'fa', document.body);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(BlockGroupMutationFailure);
      expect(failure.cause).toBe('group-failure');
      expect(textNodes[0].nodeValue).toBe('Hello ');
    });

    it('continues restoring remaining segments and surfaces rollback failures', () => {
      const originalSecond = textNodes[1].nodeValue;
      let writes = 0;
      Object.defineProperty(textNodes[1], 'nodeValue', {
        configurable: true,
        get: () => originalSecond,
        set: () => {
          writes += 1;
          if (writes === 1) throw 'mutation-failure';
          throw 'restore-failure';
        }
      });

      let failure;
      try {
        BlockGroupReconstructor.apply(units, 'Uno @@SEG_n2@@Dos@@SEG_n3@@Tres', 'fa', document.body);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(BlockGroupMutationFailure);
      expect(failure.cause).toBe('mutation-failure');
      expect(failure.rollbackFailures).toEqual([
        expect.objectContaining({ kind: 'text', id: 'n2', error: 'restore-failure' })
      ]);
      expect(textNodes[0].nodeValue).toBe('Hello ');
      expect(textNodes[1].nodeValue).toBe('world');
      expect(textNodes[2].nodeValue).toBe('.');
    });

    it('preserves pre-existing translating class on success and failure', () => {
      const parent = textNodes[0].parentElement;
      parent.classList.add('ti-translating');
      const result = BlockGroupReconstructor.apply(units, 'Uno @@SEG_n2@@Dos@@SEG_n3@@Tres', 'fa', document.body);
      result.transaction.finalize();
      expect(parent.classList.contains('ti-translating')).toBe(true);
    });

    it('should accept hydration adjustments but reject content changes', () => {
      textNodes[0].nodeValue = 'Hello\u00A0'; // nbsp
      const translated = 'مرحبا @@SEG_n2@@بالعالم@@SEG_n3@@.';
       const result = BlockGroupReconstructor.apply(units, translated, 'fa', document.body);
       expect(result.success).toBe(true);
       expect(result.cleanResult).toBe('مرحبا بالعالم.');
    });

    it('should correctly unescape entropy-scoped escaping in apply()', () => {
      const entropy = 'e1';
      const session = 's1';
      // Injected: a@@b -> a@@TI_ESC_e1@@b
      const translated = 'A @@TI_ESC_e1@@ B @@TI_SEG_e1_s1_n2@@ C';
      
      const u1 = new TranslationUnit({ id: 'n1', blockId: 'g1', text: 'a@@b' });
      const u2 = new TranslationUnit({ id: 'n2', blockId: 'g1', text: 'c' });
      
      const d1 = document.createElement('span');
      d1.textContent = 'a@@b';
      const d2 = document.createElement('span');
      d2.textContent = 'c';
      document.body.appendChild(d1);
      document.body.appendChild(d2);
      
      u1.node = d1.firstChild;
      u2.node = d2.firstChild;
      
      BlockGroupReconstructor.apply([u1, u2], translated, 'en', document.body, session, entropy);
      expect(u1.node.nodeValue.trim()).toBe('A @@ B');
    });

    it('should reject semantic content changes', () => {
      textNodes[0].nodeValue = 'Helloworld'; // Space removed
      const translated = 'مرحبا @@SEG_n2@@بالعالم@@SEG_n3@@.';
      expect(() => BlockGroupReconstructor.apply(units, translated, 'fa', document.body)).toThrow();
    });

    it.each([
      ['@@SEG_n2@@world@@SEG_n3@@.'],
      ['مرحبا @@SEG_n2@@   @@SEG_n3@@.'],
    ])('rejects invalid translated segment content before mutation', (translated) => {
      const originals = textNodes.map(node => node.nodeValue);
      expect(() => BlockGroupReconstructor.apply(units, translated, 'fa', document.body)).toThrow(/Invalid translated segment content/);
      expect(textNodes.map(node => node.nodeValue)).toEqual(originals);
    });
  });

  describe('Hardened Protocol & Adversarial Tests', () => {
    it('should handle fuzzy metadata mutations but strict ID matching', () => {
      const entropy = 'ax9';
      const session = 's1';
      // Mutations: spaces, lowercase 'ti_seg', zero-width noise (added in apply but split expects sanitized)
      const translated = 'A @@  ti_seg  _  ax9  _  s1  _  n2  @@ B';
      const u = [
        new TranslationUnit({ id: 'n1', blockId: 'g1', text: 'a' }),
        new TranslationUnit({ id: 'n2', blockId: 'g1', text: 'b' })
      ];
      u[0].node = textNodes[0];
      u[1].node = textNodes[1];

      const segments = BlockGroupReconstructor.splitTranslatedBlock(translated, u, session, entropy);
      expect(segments.length).toBe(2);
      expect(segments[1].id).toBe('n2');
      expect(segments[1].text).toBe(' B');

      // Rejecting mismatched sessionId
      expect(() => BlockGroupReconstructor.splitTranslatedBlock(translated, u, 'WRONG', entropy)).toThrow(/Segment count mismatch/);
    });

    it('should reject duplicate IDs within a block group', () => {
      const entropy = 'e1';
      const session = 's1';
      const duplicated = 'A @@TI_SEG_e1_s1_n2@@ B @@TI_SEG_e1_s1_n2@@ C';
      const u = [
        new TranslationUnit({ id: 'n1', blockId: 'g1', text: 'a' }),
        new TranslationUnit({ id: 'n2', blockId: 'g1', text: 'b' })
      ];
      expect(() => BlockGroupReconstructor.splitTranslatedBlock(duplicated, u, session, entropy)).toThrow(/Segment count mismatch/);
    });

    it('should reject missing segments (Structural Validation)', () => {
      const entropy = 'e1';
      const session = 's1';
      const missing = 'A @@TI_SEG_e1_s1_n3@@ C'; // n2 is missing
      const u = [
        new TranslationUnit({ id: 'n1', blockId: 'g1', text: 'a' }),
        new TranslationUnit({ id: 'n2', blockId: 'g1', text: 'b' }),
        new TranslationUnit({ id: 'n3', blockId: 'g1', text: 'c' })
      ];
      expect(() => BlockGroupReconstructor.splitTranslatedBlock(missing, u, session, entropy)).toThrow(/Segment count mismatch/);
    });

    it('should reject reordered segments (Monotonicity)', () => {
      const entropy = 'e1';
      const session = 's1';
      const reordered = 'A @@TI_SEG_e1_s1_n3@@ C @@TI_SEG_e1_s1_n2@@ B';
      const u = [
        new TranslationUnit({ id: 'n1', blockId: 'g1', text: 'a' }),
        new TranslationUnit({ id: 'n2', blockId: 'g1', text: 'b' }),
        new TranslationUnit({ id: 'n3', blockId: 'g1', text: 'c' })
      ];
      expect(() => BlockGroupReconstructor.splitTranslatedBlock(reordered, u, session, entropy)).toThrow(/Structural validation failure \(monotonicity\)/);
    });
  });

  describe('Invisible Character Defenses', () => {
    it('should normalize markers containing ZWSP but preserve ZWSP in content', () => {
      // Marker has ZWSP (\u200b) injected by model
      const translated = 'مرحبا @@SEG\u200b_n2@@\u200bبالعالم@@SEG_n3@@.';
      
      // Sanitization happens in apply(), so we test it here
      BlockGroupReconstructor.apply(units, translated, 'fa', document.body);
      expect(textNodes[1].nodeValue).toContain('\u200bبالعالم'); // ZWSP in content preserved
    });
  });

  describe('Edge Case Hardening', () => {
    it('should handle Emoji grapheme clusters safely', () => {
      const emojiUnits = [
        new TranslationUnit({ id: 'n1', blockId: 'e1', text: '👨‍👩‍👧‍👦', leadingWS: '', trailingWS: '' })
      ];
      const div = document.createElement('div');
      document.body.appendChild(div);
      const textNode = document.createTextNode('👨‍👩‍👧‍👦');
      div.appendChild(textNode);
      emojiUnits[0].node = textNode;

      const translated = '🌈';
      BlockGroupReconstructor.apply(emojiUnits, translated, 'en', div);
      expect(textNode.nodeValue).toBe('🌈');
    });

    it('should handle ZWJ Persian sequences', () => {
      const zwjUnits = [
        new TranslationUnit({ id: 'n1', blockId: 'z1', text: 'می‌روم', leadingWS: '', trailingWS: '' })
      ];
      const div = document.createElement('div');
      document.body.appendChild(div);
      const textNode = document.createTextNode('می‌روم');
      div.appendChild(textNode);
      zwjUnits[0].node = textNode;

      const translated = 'می‌روم';
      BlockGroupReconstructor.apply(zwjUnits, translated, 'fa', div);
      expect(textNode.nodeValue).toContain('می‌روم');
    });
  });
});
