import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as sass from 'sass'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(here, '..', '..', '..')
const scssPath = resolve(here, 'PageTranslationButton.scss')

const scssImporters = [{
  findFileUrl(url) {
    if (url.startsWith('@/')) {
      return new URL(`file://${resolve(srcDir, url.slice(2))}`)
    }
    return null
  }
}]

const compile = () => sass.compile(scssPath, { importers: scssImporters })

/**
 * Compute CSS specificity as [id, class, type].
 * Simplified — handles selectors used in this file (no complex :has/:is).
 */
function specificity(selector) {
  let ids = 0, classes = 0, types = 0
  // Strip :where(...) — contributes 0
  let s = selector.replace(/:where\([^)]*\)/g, '')
  // Strip the :not() pseudo-class name — :not itself contributes 0; only its
  // argument contributes specificity (counted via its own selectors below).
  s = s.replace(/:not\(/g, '(')
  // Count IDs
  ids += (s.match(/#[\w-]+/g) || []).length
  // Count classes, pseudo-classes, attribute selectors
  classes += (s.match(/\.[\w-]+/g) || []).length
  classes += (s.match(/:[\w-]+/g) || []).length
  // Count type selectors and pseudo-elements
  types += (s.match(/(?:^|[\s>+~])(?:div|span|a|button|img|svg|input|label|p|h[1-6]|ul|li|ol|table|tr|td|th|section|article|aside|nav|header|footer|main|body|html)\b/g) || []).length
  types += (s.match(/::[\w-]+/g) || []).length
  return [ids, classes, types]
}

/* ── Zero-specificity boundary ─────────────────────────────────────── */

describe('PageTranslationButton.scss :where() zero-specificity boundary', () => {
  it('uses :where(.page-translation-controls) for .toolbar-icon (specificity 0,1,0)', () => {
    const { css } = compile()
    const match = css.match(/:where\(\.page-translation-controls\)\s+\.toolbar-icon\s*\{/)
    expect(match).toBeTruthy()
    // Specificity of `:where(.page-translation-controls) .toolbar-icon` = [0,1,0]
    // because :where() contributes 0 and .toolbar-icon contributes 1 class.
    const spec = specificity(match[0])
    expect(spec).toEqual([0, 1, 0])
  })

  it('.side-toolbar .toolbar-icon has specificity (0,2,0) > PTB (0,1,0)', () => {
    // SidepanelToolbar uses `.side-toolbar .toolbar-icon` (no :where).
    // This is an external contract — PTB must not raise its own specificity.
    const sideSpec = specificity('.side-toolbar .toolbar-icon')
    expect(sideSpec).toEqual([0, 2, 0])
    const ptbSpec = specificity(':where(.page-translation-controls) .toolbar-icon')
    expect(ptbSpec).toEqual([0, 1, 0])
    // Sidepanel wins order-independently: 2 > 1 in the class tier
    expect(sideSpec[1]).toBeGreaterThan(ptbSpec[1])
  })

  it('uses :where() for .error-message', () => {
    const { css } = compile()
    expect(css).toContain(':where(.page-translation-controls) .error-message')
    const stripped = css.replaceAll(':where(.page-translation-controls) .error-message', '')
    expect(stripped).not.toMatch(/(^|[},])\s*\.error-message\s*\{/)
  })

  it('uses :where() for .toolbar-link and its pseudo-classes', () => {
    const { css } = compile()
    expect(css).toContain(':where(.page-translation-controls) .toolbar-link')
    expect(css).toContain(':where(.page-translation-controls) .toolbar-link:hover')
    expect(css).toContain(':where(.page-translation-controls) .toolbar-link.disabled')
    expect(css).toContain(':where(.page-translation-controls) .toolbar-link.loading')
    expect(css).toContain(':where(.page-translation-controls) .toolbar-link.is-active')
  })

  it('uses :where() for .ti-btn-status-container', () => {
    const { css } = compile()
    expect(css).toContain(':where(.page-translation-controls) .ti-btn-status-container')
    expect(css).toContain(':where(.page-translation-controls) .ti-btn-status-container .ti-base-loading-spinner')
  })

  it('uses :where() for .is-compact-icon', () => {
    const { css } = compile()
    expect(css).toContain(':where(.page-translation-controls) .is-compact-icon')
    expect(css).toContain(':where(.page-translation-controls) .is-compact-icon .ti-btn__text')
    expect(css).toContain(':where(.page-translation-controls) .is-compact-icon:disabled')
  })

  it('uses :where() for progress rules', () => {
    const { css } = compile()
    expect(css).toContain(':where(.page-translation-controls) .progress-bar')
    expect(css).toContain(':where(.page-translation-controls) .progress-bar.compact')
    expect(css).toContain(':where(.page-translation-controls) .progress-fill')
    expect(css).toContain(':where(.page-translation-controls) .progress-text')
  })

  it('uses :where() for .page-translate-star-btn', () => {
    const { css } = compile()
    expect(css).toContain(':where(.page-translation-controls) .page-translate-star-btn')
    expect(css).toContain(':where(.page-translation-controls) .page-translate-star-btn:hover')
    expect(css).toContain(':where(.page-translation-controls) .page-translate-star-btn.is-active')
    expect(css).toContain(':where(.page-translation-controls) .page-translate-star-btn.is-disabled')
  })

  it('uses :where() for .ti-btn-status-badge (base rule)', () => {
    const { css } = compile()
    expect(css).toContain(':where(.page-translation-controls) .ti-btn-status-badge')
  })

  it('uses :where() for .ti-text-status-wrapper', () => {
    const { css } = compile()
    expect(css).toContain(':where(.page-translation-controls) .ti-text-status-wrapper')
  })

  it('uses :where() for hover-related toolbar-icon rules', () => {
    const { css } = compile()
    expect(css).toContain(':where(.page-translation-controls) .ti-btn:hover .toolbar-icon')
    expect(css).toContain(':where(.page-translation-controls) .ti-btn.is-active .toolbar-icon')
  })

  it('emits no bare standalone rule for any scoped class', () => {
    const { css } = compile()
    const scopedClasses = [
      '.error-message',
      '.toolbar-icon',
      '.toolbar-link',
      '.ti-btn-status-container',
      '.is-compact-icon',
      '.progress-bar',
      '.progress-fill',
      '.progress-text',
      '.page-translate-star-btn',
      '.ti-text-status-wrapper',
    ]
    for (const cls of scopedClasses) {
      const re = new RegExp(`(^|[},])\\s*${cls.replace('.', '\\.')}\\s*\\{`)
      const stripped = css.replaceAll(`:where(.page-translation-controls) ${cls}`, '')
      // Also strip compound compact-wrapper rules for status classes
      const cleaned = stripped
        .replaceAll(':where(.page-translation-controls).compact-wrapper .ti-btn-status-container', '')
        .replaceAll(':where(.page-translation-controls).compact-wrapper .ti-btn-status-badge', '')
      expect(cleaned).not.toMatch(re)
    }
  })
})

/* ── Compact-mode status compound rules ────────────────────────────── */

describe('PageTranslationButton.scss compact-mode status rules', () => {
  const source = readFileSync(scssPath, 'utf8')

  it('no top-level bare .compact-wrapper .ti-btn-status-* rule exists in source', () => {
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(withoutComments).not.toMatch(/^\.compact-wrapper\s+\.ti-btn-status-container\s*\{/m)
    expect(withoutComments).not.toMatch(/^\.compact-wrapper\s+\.ti-btn-status-badge\s*\{/m)
  })

  it('uses compound :where(.page-translation-controls).compact-wrapper form', () => {
    expect(source).toContain(':where(.page-translation-controls).compact-wrapper .ti-btn-status-container')
    expect(source).toContain(':where(.page-translation-controls).compact-wrapper .ti-btn-status-badge')
  })

  it('compiled status container has 22×22 dimensions', () => {
    const { css } = compile()
    const match = css.match(
      /:where\(\.page-translation-controls\)\.compact-wrapper\s+\.ti-btn-status-container\s*\{[^}]*width:\s*22px[^}]*height:\s*22px/
    )
    expect(match).toBeTruthy()
  })

  it('generic compact rule remains for Sidepanel (previous bottom-right offsets)', () => {
    const { css } = compile()
    // Generic rule: EXACTLY the historical offsets — no top/right reset, no ring.
    const match = css.match(
      /:where\(\.page-translation-controls\)\.compact-wrapper\s+\.ti-btn-status-badge\s*\{([^}]*)\}/
    )
    expect(match).toBeTruthy()
    const block = match[1]
    expect(block).toContain('bottom: -1px !important;')
    expect(block).toContain('right: -1px !important;')
    expect(block).not.toContain('top:')
    expect(block).not.toContain('box-shadow')
    expect(block).not.toContain('bottom: auto')
    // Source keeps the generic rule verbatim.
    expect(source).toMatch(
      /:where\(\.page-translation-controls\)\.compact-wrapper\s+\.ti-btn-status-badge\s*\{\s*bottom: -1px !important;\s*right: -1px !important;/
    )
  })

  it('corner badge is anchored to the control root, not the 22×22 container', () => {
    const { css } = compile()
    // Strip comments so prose (which may mention the container) never
    // leaks into selector capture.
    const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const match = cssNoComments.match(
      /(?<=\}|^)\s*([^{}]+\.ti-compact-corner-status-badge[^{}]*)\{([^}]*)\}/
    )
    expect(match).toBeTruthy()
    const selector = match[1]
    const block = match[2]
    // Positioning context: the root (.page-translation-controls owns
    // position: relative) — never scoped to or translated from the
    // internal status container.
    expect(selector).toContain(':where(.page-translation-controls)')
    expect(selector).toContain('.compact-wrapper')
    expect(selector).not.toContain('.ti-btn-status-container')
    expect(block).toContain('position: absolute !important;')
    // Decorative: never intercepts pointer input from button/star.
    expect(block).toContain('pointer-events: none !important;')
  })

  it('corner badge uses top-right anchoring (top: -4px; right: 9px)', () => {
    const { css } = compile()
    const match = css.match(
      /(?<=\}|^)\s*([^{}]+\.ti-compact-corner-status-badge[^{}]*)\{([^}]*)\}/
    )
    expect(match).toBeTruthy()
    const block = match[2]
    expect(block).toContain('top: -4px !important;')
    expect(block).toContain('right: 9px !important;')
    // No bottom anchor: top+bottom would stretch the 5px dot.
    expect(block).not.toContain('bottom:')
    expect(block).toContain('z-index: 10 !important;')
  })

  it('corner badge carries the theme-aware 2px ring (verified token)', () => {
    const { css } = compile()
    const match = css.match(
      /(?<=\}|^)\s*([^{}]+\.ti-compact-corner-status-badge[^{}]*)\{([^}]*)\}/
    )
    expect(match).toBeTruthy()
    expect(match[2]).toContain('box-shadow: 0 0 0 2px var(--header-bg-color);')
    expect(match[2]).not.toMatch(/box-shadow:[^;]*#[0-9a-fA-F]{3,8}/)
    // Token verified: exists for BOTH light and dark theme roots.
    const variables = readFileSync(
      resolve(srcDir, 'assets/styles/base/_variables.scss'),
      'utf8'
    )
    expect(variables).toMatch(/--header-bg-color:\s*#e9ecef;/)
    expect(variables).toMatch(/--header-bg-color:\s*#303741;/)
    // The INTERNAL badge rules carry no ring anymore — only the corner badge does.
    const internalRings = [...css.matchAll(
      /(?<=\}|^)\s*([^{}]+\.ti-btn-status-badge[^{}]*)\{([^}]*)\}/g
    )].filter((m) => m[2].includes('box-shadow'))
    expect(internalRings).toHaveLength(0)
  })

  it('old Popup internal top-right override is gone; internal badges stay bottom-right', () => {
    // The former marker-coupled rule no longer exists anywhere.
    expect(source).not.toContain(
      ':where(.page-translation-controls).ti-page-translate-btn.compact-wrapper .ti-btn-status-badge',
    )
    // No internal .ti-btn-status-badge rule was moved to top-right / ringed.
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '')
    const internalRules = [...withoutComments.matchAll(
      /([^{}]+\.ti-btn-status-badge[^{}]*)\{([^}]*)\}/g
    )]
    expect(internalRules.length).toBeGreaterThanOrEqual(2)
    for (const rule of internalRules) {
      expect(rule[1]).not.toContain('ti-compact-corner-status-badge')
      expect(rule[2]).not.toContain('top:')
      expect(rule[2]).not.toContain('bottom: auto')
      expect(rule[2]).not.toContain('box-shadow')
    }
  })

  it('corner ownership: compound :where() rule, no bare standalone, not marker-coupled', () => {
    const { css } = compile()
    const match = css.match(
      /:where\(\.page-translation-controls\)\.compact-wrapper\s+\.ti-compact-corner-status-badge\s*\{/
    )
    expect(match).toBeTruthy()
    // Zero-specificity root boundary + (0,2,0) compound ownership.
    expect(specificity(match[0])).toEqual([0, 2, 0])
    expect(source).toContain(
      ':where(.page-translation-controls).compact-wrapper .ti-compact-corner-status-badge',
    )
    const withoutCompound = source.replaceAll(
      ':where(.page-translation-controls).compact-wrapper .ti-compact-corner-status-badge',
      '',
    )
    expect(withoutCompound).not.toMatch(
      /(^|[},])\s*\.ti-compact-corner-status-badge\s*\{/,
    )
    // Explicit-prop design: the rule must NOT couple to the Popup marker class.
    const rule = source.match(
      /:where\(\.page-translation-controls\)\.compact-wrapper \.ti-compact-corner-status-badge\s*\{[^}]*\}/,
    )
    expect(rule).toBeTruthy()
    expect(rule[0]).not.toContain('ti-page-translate-btn')
  })

  it('corner status ↔ Star alignment: horizontal pair pinned from Star geometry', () => {
    const { css } = compile()
    const corner = css.match(
      /(?<=\}|^)\s*([^{}]+\.ti-compact-corner-status-badge[^{}]*)\{([^}]*)\}/,
    )
    expect(corner).toBeTruthy()
    const star = css.match(
      /:where\(\.page-translation-controls\)\s+\.page-translate-star-btn\s*\{([^}]*)\}/,
    )
    expect(star).toBeTruthy()

    // Star geometry (unchanged): right: 0, padding: 5px, 14px glyph →
    // glyph center = 0 + 5 + 7 = 12px from the root's right edge.
    expect(star[1]).toContain('right: 0 !important;')
    expect(star[1]).toContain('padding: 5px !important;')
    const starGlyphCenter = 0 + 5 + 14 / 2

    // Corner badge: 5px wide (mode-compact), right: 9px → center at 11.5px.
    const cornerRight = parseInt(corner[2].match(/right:\s*(-?\d+)px/)[1], 10)
    const badgeWidth = 5
    const badgeCenter = cornerRight + badgeWidth / 2
    expect(Math.abs(starGlyphCenter - badgeCenter)).toBeLessThanOrEqual(0.5)
    // right pinned in the derived 9–10px band.
    expect(cornerRight).toBeGreaterThanOrEqual(9)
    expect(cornerRight).toBeLessThanOrEqual(10)

    // Vertical pair: status above the control's top edge, star below its
    // bottom edge — opposite halves, no overlap.
    expect(corner[2]).toContain('top: -4px !important;')
    expect(star[1]).toContain('bottom: -6px !important;')
  })

  it('corner badge uses no transform / large-translation hack', () => {
    const { css } = compile()
    const corner = css.match(
      /(?<=\}|^)\s*([^{}]+\.ti-compact-corner-status-badge[^{}]*)\{([^}]*)\}/,
    )
    expect(corner).toBeTruthy()
    const block = corner[2]
    expect(block).not.toMatch(/transform/)
    expect(block).not.toMatch(/translate\(/)
    expect(block).not.toMatch(/margin-/)
    // All pixel offsets are small anchoring values, not layout shifts.
    const pixels = [...block.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map(
      (m) => Math.abs(parseFloat(m[1])),
    )
    expect(pixels.length).toBeGreaterThanOrEqual(2)
    for (const px of pixels) {
      expect(px).toBeLessThanOrEqual(12)
    }
  })

  it('presentation prop wiring: Popup opts in, Sidepanel never does', () => {
    // Source-level discrimination (SidepanelToolbar.test.js does not exist):
    // PopupHeader passes the explicit prop; SidepanelToolbar passes nothing.
    const popupHeader = readFileSync(
      resolve(srcDir, 'components/popup/PopupHeader.vue'),
      'utf8',
    )
    const popupUsage = popupHeader.match(/<PageTranslationButton[\s\S]*?\/>/)
    expect(popupUsage).toBeTruthy()
    expect(popupUsage[0]).toContain('status-badge-position="corner"')
    expect(popupUsage[0]).toContain(':compact="true"')

    const sidepanelToolbar = readFileSync(
      resolve(srcDir, 'apps/sidepanel/components/SidepanelToolbar.vue'),
      'utf8',
    )
    const sidepanelUsage = sidepanelToolbar.match(/<PageTranslationButton[\s\S]*?\/>/)
    expect(sidepanelUsage).toBeTruthy()
    expect(sidepanelUsage[0]).toContain('compact')
    expect(sidepanelUsage[0]).not.toContain('status-badge-position')
    expect(sidepanelUsage[0]).not.toContain('corner')
    expect(sidepanelUsage[0]).not.toContain('class=')
  })

  it('badge z-index remains above the LoadingSpinner; spinner centering unchanged', () => {
    const sourceLocal = readFileSync(scssPath, 'utf8')
    // Base badge rule: position absolute + z-index 10.
    const badgeBase = sourceLocal.match(
      /:where\(\.page-translation-controls\)\s+\.ti-btn-status-badge\s*\{([^}]*)\}/
    )
    expect(badgeBase).toBeTruthy()
    expect(badgeBase[1]).toContain('position: absolute !important;')
    expect(badgeBase[1]).toContain('z-index: 10 !important;')
    // Spinner: centered in the container at z-index 5 (< 10).
    const spinner = sourceLocal.match(
      /\.ti-base-loading-spinner\s*\{([^}]*)\}/
    )
    expect(spinner).toBeTruthy()
    expect(spinner[1]).toContain('top: 50% !important;')
    expect(spinner[1]).toContain('left: 50% !important;')
    expect(spinner[1]).toContain('transform: translate(-50%, -50%) !important;')
    expect(spinner[1]).toContain('z-index: 5 !important;')
    expect(spinner[1]).toContain('pointer-events: none !important;')
    const badgeZ = parseInt(badgeBase[1].match(/z-index:\s*(\d+)/)[1], 10)
    const spinnerZ = parseInt(spinner[1].match(/z-index:\s*(\d+)/)[1], 10)
    expect(badgeZ).toBeGreaterThan(spinnerZ)
  })

  it('text-only status rules unchanged (top-left inside the toolbar link)', () => {
    const sourceLocal = readFileSync(scssPath, 'utf8')
    const textStatus = sourceLocal.match(
      /\.ti-text-status-badge\s*\{([^}]*)\}/
    )
    expect(textStatus).toBeTruthy()
    expect(textStatus[1]).toContain('top: 0px !important;')
    expect(textStatus[1]).toContain('left: 2px !important;')
    expect(textStatus[1]).toContain('z-index: 1 !important;')
    // Not touched by the compact top-right override (different class).
    expect(textStatus[1]).not.toContain('top: -4px')
    expect(textStatus[1]).not.toContain('right: -4px')
  })

  it('non-compact base status rule unchanged (bottom-right, z-index 10)', () => {
    const sourceLocal = readFileSync(scssPath, 'utf8')
    const badgeBase = sourceLocal.match(
      /:where\(\.page-translation-controls\)\s+\.ti-btn-status-badge\s*\{([^}]*)\}/
    )
    expect(badgeBase).toBeTruthy()
    expect(badgeBase[1]).toContain('bottom: -2px !important;')
    expect(badgeBase[1]).toContain('right: -2px !important;')
    expect(badgeBase[1]).toContain('z-index: 10 !important;')
    expect(badgeBase[1]).not.toContain('top:')
    expect(badgeBase[1]).not.toContain('box-shadow')
  })

  it('zero-specificity / ownership contracts intact for the compact badge rule', () => {
    const { css } = compile()
    const match = css.match(
      /:where\(\.page-translation-controls\)\.compact-wrapper\s+\.ti-btn-status-badge\s*\{/
    )
    expect(match).toBeTruthy()
    // :where() contributes 0 → (0,2,0), same as the old top-level form.
    expect(specificity(match[0])).toEqual([0, 2, 0])
    // Still compound-owned; no bare rewrite. Corner badge rule also owned.
    expect(source).toContain(':where(.page-translation-controls).compact-wrapper .ti-btn-status-badge')
    expect(source).toContain(':where(.page-translation-controls).compact-wrapper .ti-compact-corner-status-badge')
    // Old marker-coupled badge rule must not resurface.
    expect(source).not.toContain(':where(.page-translation-controls).ti-page-translate-btn.compact-wrapper .ti-btn-status-badge')
    // Base badge rule still flows through the :where() boundary.
    expect(css).toContain(':where(.page-translation-controls) .ti-btn-status-badge')
    // 22 uses of the zero-specificity boundary remain.
    const whereUses = (source.match(/:where\(\.page-translation-controls\)/g) || []).length
    expect(whereUses).toBeGreaterThanOrEqual(22)
  })

  it('no bare .compact-wrapper .ti-btn-status-* in compiled output', () => {
    const { css } = compile()
    // Strip all :where() compound occurrences
    const stripped = css
      .replace(/:where\(\.page-translation-controls\)\.compact-wrapper\s+\.ti-btn-status-\w+/g, '')
    expect(stripped).not.toMatch(/(^|[},])\s*\.compact-wrapper\s+\.ti-btn-status-\w+\s*\{/)
  })

  it('compound rules have specificity (0,2,0) = old top-level form', () => {
    const compoundSpec = specificity(':where(.page-translation-controls).compact-wrapper .ti-btn-status-container')
    expect(compoundSpec).toEqual([0, 2, 0])
    // Same as old `.compact-wrapper .ti-btn-status-container`
    const oldSpec = specificity('.compact-wrapper .ti-btn-status-container')
    expect(oldSpec).toEqual([0, 2, 0])
    expect(compoundSpec).toEqual(oldSpec)
  })
})

/* ── Popup compact geometry ───────────────────────────────────────── */

describe('PageTranslationButton.scss popup compact geometry', () => {
  const source = readFileSync(scssPath, 'utf8')

  it('popup compact padding is compound-root-scoped with :where()', () => {
    expect(source).toContain(':where(.page-translation-controls).ti-page-translate-btn.compact-wrapper .is-compact-icon')
    expect(source).toContain('padding-left: 2px !important;')
    expect(source).toContain('padding-right: 22px !important;')
  })

  it('popup hover rule uses Header action contract var', () => {
    expect(source).toContain(':where(.page-translation-controls).ti-page-translate-btn.compact-wrapper .is-compact-icon:hover:not(.ti-btn--disabled)')
    expect(source).toContain('background-color: var(--ti-action-hover-bg) !important;')
  })

  it('popup hover selector has specificity (0,5,0) — :not() contributes only its argument', () => {
    const { css } = compile()
    const match = css.match(
      /:where\(\.page-translation-controls\)\.ti-page-translate-btn\.compact-wrapper\s+\.is-compact-icon:hover:not\(\.ti-btn--disabled\)\s*\{/
    )
    expect(match).toBeTruthy()
    // :where()=0, .ti-page-translate-btn=1, .compact-wrapper=1,
    // .is-compact-icon=1, :hover=1, :not(.ti-btn--disabled)=1 (argument only)
    expect(specificity(match[0])).toEqual([0, 5, 0])
  })

  it('hover rule does NOT set standalone color (colored image icon stays unchanged)', () => {
    const hoverRule = source.match(
      /:where\(\.page-translation-controls\)\.ti-page-translate-btn\.compact-wrapper\s+\.is-compact-icon:hover:not\(\.ti-btn--disabled\)\s*\{[^}]*\}/
    )
    expect(hoverRule).toBeTruthy()
    const lines = hoverRule[0].split('\n').map(l => l.trim())
    const hasStandaloneColor = lines.some(l => /^color:/.test(l))
    expect(hasStandaloneColor).toBe(false)
    expect(hoverRule[0]).not.toContain('--ti-action-icon-hover')
  })

  it('popup compact padding compiles to correct selector', () => {
    const { css } = compile()
    const match = css.match(
      /:where\(\.page-translation-controls\)\.ti-page-translate-btn\.compact-wrapper\s+\.is-compact-icon\s*\{[^}]*padding-left:\s*2px[^}]*padding-right:\s*22px/
    )
    expect(match).toBeTruthy()
  })

  it('popup compound rule has specificity (0,3,0) — beats generic (0,1,0)', () => {
    const popupSpec = specificity(':where(.page-translation-controls).ti-page-translate-btn.compact-wrapper .is-compact-icon')
    expect(popupSpec).toEqual([0, 3, 0])
    const genericSpec = specificity(':where(.page-translation-controls) .is-compact-icon')
    expect(genericSpec).toEqual([0, 1, 0])
    expect(popupSpec[1]).toBeGreaterThan(genericSpec[1])
  })
})

/* ── Star geometry ─────────────────────────────────────────────────── */

describe('PageTranslationButton.scss star geometry', () => {
  const source = readFileSync(scssPath, 'utf8')

  it('star button has padding: 5px for a 24×24 interactive box', () => {
    const starSection = source.slice(
      source.indexOf('.page-translate-star-btn'),
    )
    expect(starSection).toContain('padding: 5px !important;')
  })

  it('star button is absolutely positioned at bottom: -6px; right: 0', () => {
    const starSection = source.slice(
      source.indexOf('.page-translate-star-btn'),
    )
    expect(starSection).toContain('bottom: -6px !important;')
    expect(starSection).toContain('right: 0 !important;')
  })
})

/* ── Hover/focus decoupling ────────────────────────────────────────── */

describe('PageTranslationButton.scss hover/focus decoupling', () => {
  const source = readFileSync(scssPath, 'utf8')

  it('does NOT couple .compact-wrapper:hover to .is-compact-icon background', () => {
    expect(source).not.toContain('.compact-wrapper:hover .is-compact-icon')
  })

  it('does NOT couple .compact-wrapper:focus-within to .is-compact-icon background', () => {
    expect(source).not.toContain('.compact-wrapper:focus-within .is-compact-icon')
  })

  it('star button has its own independent hover styling', () => {
    expect(source).toMatch(/\.page-translate-star-btn\s*\{[\s\S]*&:hover\s*\{/)
  })
})

/* ── Dark-mode selectors ───────────────────────────────────────────── */

describe('PageTranslationButton.scss dark-mode selectors', () => {
  const source = readFileSync(scssPath, 'utf8')
  const { css } = compile()

  it('does NOT contain any :global() selectors anywhere in the file', () => {
    expect(source).not.toMatch(/:global\(/)
  })

  it('dark theme star selectors compile through :where() zero-specificity root', () => {
    expect(css).toContain('.theme-dark :where(.page-translation-controls) .page-translate-star-btn')
    expect(css).toContain('.ti-dark-mode :where(.page-translation-controls) .page-translate-star-btn')
  })

  it('dark star selector has specificity (0,2,0) — same as pre-Patch-A .theme-dark .page-translate-star-btn', () => {
    const darkSpec = specificity('.theme-dark :where(.page-translation-controls) .page-translate-star-btn')
    expect(darkSpec).toEqual([0, 2, 0])
    const oldDarkSpec = specificity('.theme-dark .page-translate-star-btn')
    expect(oldDarkSpec).toEqual([0, 2, 0])
    expect(darkSpec).toEqual(oldDarkSpec)
  })
})

/* ── No :where() on root element's own rules ───────────────────────── */

describe('PageTranslationButton.scss root element rules', () => {
  const source = readFileSync(scssPath, 'utf8')

  it('root element layout uses bare .page-translation-controls (not :where())', () => {
    // The root element's OWN layout properties (position, display, etc.)
    // must use the real class, not :where(), so they have normal specificity.
    expect(source).toMatch(/^\.page-translation-controls\s*\{/m)
  })

  it('root compound variants use bare class (not :where())', () => {
    expect(source).toContain('&.compact-wrapper {')
    expect(source).toContain('&.text-only {')
  })
})

/* ── Compact disabled override contract ────────────────────────────── */

describe('PageTranslationButton.scss compact disabled override', () => {
  const source = readFileSync(scssPath, 'utf8')

  // The local `&:disabled` override inside the `.is-compact-icon` block.
  const localDisabledBlock = source.match(/&:disabled\s*\{[\s\S]*?\}/)?.[0]

  it('keeps the intentional `opacity: 0.5 !important` override', () => {
    expect(localDisabledBlock).toBeTruthy()
    expect(localDisabledBlock).toContain('opacity: 0.5 !important;')
  })

  it('does NOT re-declare a redundant `background: none` reset', () => {
    expect(localDisabledBlock).toBeTruthy()
    expect(localDisabledBlock).not.toContain('background: none')
    // No background declaration at all — `.ti-btn--ghost` (and the Sidepanel
    // `.side-toolbar .ti-btn` rule) already keep the background transparent.
    expect(localDisabledBlock).not.toMatch(/background\s*:/)
  })

  it('local disabled selector specificity is (0,2,0)', () => {
    const { css } = compile()
    const match = css.match(
      /:where\(\.page-translation-controls\)\s+\.is-compact-icon:disabled\s*\{/
    )
    expect(match).toBeTruthy()
    // :where()=0, .is-compact-icon=1, :disabled=1
    expect(specificity(match[0])).toEqual([0, 2, 0])
  })

  it('opacity override outranks BaseButton `.ti-btn--disabled` (0,1,0)', () => {
    const overrideSpec = specificity(':where(.page-translation-controls) .is-compact-icon:disabled')
    const baseSpec = specificity('.ti-btn--disabled')
    expect(overrideSpec).toEqual([0, 2, 0])
    expect(baseSpec).toEqual([0, 1, 0])
    expect(overrideSpec[1]).toBeGreaterThan(baseSpec[1])
  })
})

/* ── Auto-Translate broader-rule section ───────────────────────────── */

describe('PageTranslationButton.scss broader-rule scope section', () => {
  const css = compile().css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = (selectorPattern) => {
    const match = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .find(([, selector]) => selectorPattern.test(selector.trim()))
    expect(match, `missing compiled rule: ${selectorPattern}`).toBeTruthy()
    return { selector: match[1].trim(), declarations: match[2] }
  }

  it('keeps the divider subtle inside the scope menu', () => {
    const { selector, declarations } = rule(/:where\(\.page-translation-controls\) \.auto-translate-scope-menu \.auto-translate-scope-separator$/)
    expect(selector).toContain(':where(.page-translation-controls) .auto-translate-scope-menu')
    const opacity = Number.parseFloat(declarations.match(/opacity:\s*([\d.]+)/)?.[1])
    const borderColor = declarations.match(/border-(?:top-)?color:\s*([^;]+)/)?.[1] ?? ''
    const borderAlpha = Number.parseFloat(borderColor.match(/,\s*(0?\.\d+)\s*\)/)?.[1])
    expect(opacity < 1 || /--color-(?:border|muted|text-secondary)/i.test(borderColor) || borderAlpha <= 0.5).toBe(true)
  })

  it('uses a muted token for the noninteractive note and wraps long text', () => {
    const { declarations } = rule(/:where\(\.page-translation-controls\) \.auto-translate-scope-menu \.auto-translate-managed-note$/)
    expect(declarations).toContain('color: var(--tab-button-color, #5b6472) !important;')
    expect(declarations).toMatch(/overflow-wrap:\s*anywhere/)
  })

  it('keeps the Manage Rules link content-sized, wrapping, and blue in each theme', () => {
    const light = rule(/:where\(\.page-translation-controls\) \.auto-translate-scope-menu \.auto-translate-manage-link$/)
    expect(light.declarations).toMatch(/width:\s*fit-content/)
    expect(light.declarations).toMatch(/max-width:\s*100%/)
    expect(light.declarations).toMatch(/overflow-wrap:\s*anywhere/)
    expect(light.declarations).toMatch(/color:\s*#1a5fb4/i)
    expect(specificity(light.selector)).toEqual([0, 2, 0])

    const darkRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, selectors]) => selectors.split(',').some((selector) =>
        /^\.(?:theme-dark|ti-dark-mode)\s+:where\(\.page-translation-controls\) \.auto-translate-scope-menu \.auto-translate-manage-link$/.test(selector.trim()),
      ))
    for (const hook of ['theme-dark', 'ti-dark-mode']) {
      const dark = darkRules.find(([, selectors]) => selectors.split(',').some((selector) =>
        selector.trim().startsWith(`.${hook} `),
      ))
      expect(dark, `missing ${hook} Manage Rules selector`).toBeTruthy()
      expect(dark[2]).toMatch(/color:\s*#60a5fa/i)
      const themedSelector = dark[1].split(',').map((selector) => selector.trim())
        .find((selector) => selector.startsWith(`.${hook} `))
      expect(specificity(themedSelector)[1]).toBeGreaterThan(specificity(light.selector)[1])
    }

    const hover = rule(/:where\(\.page-translation-controls\) \.auto-translate-scope-menu \.auto-translate-manage-link:hover$/)
    expect(hover.declarations).toMatch(/text-decoration:\s*underline/)
  })

  it('retains the shared visible focus outline for scope-menu buttons', () => {
    const { declarations } = rule(/:where\(\.page-translation-controls\) \.auto-translate-scope-menu button:focus-visible$/)
    expect(declarations).toMatch(/outline:\s*2px solid/)
  })
})
