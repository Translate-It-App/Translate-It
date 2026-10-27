import { describe, expect, it } from 'vitest'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as sass from 'sass'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(here, '..', '..')
const scssPath = resolve(here, 'TranslationView.scss')

const scssImporters = [{
  findFileUrl(url) {
    if (url.startsWith('@/')) {
      return new URL(`file://${resolve(srcDir, url.slice(2))}`)
    }
    return null
  }
}]

const compile = () => sass.compile(scssPath, { importers: scssImporters })

/** Body of the first compiled rule whose selector matches `re`. */
const rule = (css, re) => {
  const match = css.match(re)
  expect(match, `expected compiled rule matching ${re}`).toBeTruthy()
  return match[1]
}

const selectorSpecificity = (selector) => {
  const effectiveSelector = selector.replace(/:where\([^)]*\)/g, '')
  return (effectiveSelector.match(/\.[\w-]+/g) || []).length +
    (effectiveSelector.match(/:(?!:)[\w-]+/g) || []).length
}

/**
 * Text Popup language toolbar consumes the Popup Header visual contract:
 * 44px band · 32px primary controls · 6px radius · 13px labels ·
 * 28×28 actions with 18px glyphs · 6px gaps. Everything stays scoped to
 * .translation-view so Sidepanel/Mobile/select-element are untouched.
 */
describe('TranslationView.scss language toolbar contract', () => {
  const css = compile().css

  it('holds a 44px toolbar band with 6px gaps on a single centered row', () => {
    const body = rule(css, /(\.translation-view \.language-controls\s*\{[^}]*\})/)
    expect(body).toMatch(/min-height:\s*44px/)
    expect(body).toMatch(/gap:\s*6px/)
    expect(body).toMatch(/align-items:\s*center/)
    expect(body).toMatch(/flex-wrap:\s*nowrap/)
  })

  it('declares the Header action contract on the toolbar root', () => {
    const body = rule(css, /(\.translation-view \.language-controls\s*\{[^}]*\})/)
    expect(body).toMatch(/--ti-action-icon:\s*var\(--tab-button-color/)
    expect(body).toMatch(/--ti-action-icon-hover:\s*var\(--color-action-hover-accent/)
    expect(body).toMatch(/--ti-action-hover-bg:\s*rgba\(0, 0, 0, 0\.08\)/)
  })

  it('reaches dark mode through the documented plain-selector @at-root hook', () => {
    expect(css).not.toContain(':global(')
    expect(css).toMatch(
      /\.theme-dark \.translation-view \.language-controls,\s*\.ti-dark-mode \.translation-view \.language-controls\s*\{[^}]*--ti-action-icon:\s*#fff/
    )
  })

  it('sizes the Provider control to the shared 32px / 6px radius', () => {
    const body = rule(css, /(\.translation-view \.language-controls \.ti-split-translate-button\s*\{[^}]*\})/)
    expect(body).toMatch(/height:\s*32px/)
    expect(body).toMatch(/border-radius:\s*6px/)
  })

  it('sizes Source/Target selects to 32px / 6px / 13px with balanced inline padding', () => {
    const body = rule(css, /(\.translation-view \.language-controls \.ti-language-controls \.ti-language-select\s*\{[^}]*\})/)
    expect(body).toMatch(/height:\s*32px/)
    expect(body).toMatch(/border-radius:\s*6px/)
    expect(body).toMatch(/font-size:\s*13px/)
    expect(body).toMatch(/padding-inline-start:\s*8px/)
    expect(body).toMatch(/padding-inline-end:\s*44px/)
  })

  it('keeps the star quiet, 6px clear of the arrow, accent only when active', () => {
    const base = rule(css, /(\.translation-view \.language-controls \.ti-language-controls \.ti-default-action-button\s*\{[^}]*\})/)
    expect(base).toMatch(/inset-inline-end:\s*24px/)
    expect(base).toMatch(/width:\s*18px/)
    expect(base).toMatch(/color:\s*var\(--tab-button-color/)
    expect(base).toMatch(/opacity:\s*1\s*!important/)
    // All three properties must transition so hover background/color changes do
    // not become abrupt when the idle-hide opacity transition was added.
    expect(base).toMatch(/transition:[^;]*background-color\s+0\.2s\s+ease/)
    expect(base).toMatch(/,\s*color\s+0\.2s\s+ease/)
    expect(base).toMatch(/,\s*opacity\s+0\.14s\s+ease\s+!important/)

    const hover = rule(css, /(\.translation-view \.language-controls \.ti-language-controls \.ti-default-action-button:hover:not\(:disabled\)\s*\{[^}]*\})/)
    expect(hover).not.toContain('var(--color-primary')
    expect(hover).not.toContain('--ti-action-icon-hover')

    expect(css).toMatch(
      /\.translation-view \.language-controls \.ti-language-controls \.ti-default-action-button\.is-active[^{]*\{[^}]*color:\s*var\(--color-primary/
    )
  })

  it('hides only the active star at idle and reveals it from group or star focus', () => {
    expect(css).toMatch(
      /\.translation-view \.language-controls \.ti-language-controls \.ti-default-action-button\.is-active\s*\{[^}]*opacity:\s*0/
    )
    expect(css).toMatch(
      /\.translation-view \.language-controls \.ti-language-controls\s+\.ti-language-control-group:hover \.ti-default-action-button\.is-active[^{]*\{[^}]*opacity:\s*1\s*!important/
    )
    expect(css).toMatch(
      /\.translation-view \.language-controls \.ti-language-controls\s+\.ti-language-control-group:focus-within \.ti-default-action-button\.is-active[^{]*\{[^}]*opacity:\s*1\s*!important/
    )
    expect(css).toMatch(
      /\.translation-view \.language-controls \.ti-language-controls\s+\.ti-language-control-group \.ti-default-action-button\.is-active:focus(?:-visible)?[^{]*\{[^}]*opacity:\s*1\s*!important/
    )
  })

  it('gives Swap a 28×28 neutral currentColor mask glyph with Header hover', () => {
    const body = rule(css, /(\.translation-view \.language-controls \.ti-language-controls \.ti-swap-button\s*\{[^}]*\})/)
    expect(body).toMatch(/width:\s*28px/)
    expect(body).toMatch(/height:\s*28px/)
    expect(body).toMatch(/border-radius:\s*6px/)
    expect(body).toMatch(/color:\s*var\(--ti-action-icon\)/)
    /* No brand-green remnant: no hue filter, no opacity ladder on the button. */
    expect(body).not.toMatch(/filter:/)

    const glyph = rule(css, /(\.translation-view \.language-controls \.ti-language-controls \.ti-swap-button::after\s*\{[^}]*\})/)
    expect(glyph).toMatch(/mask-image:\s*url\("@\/icons\/ui\/swap\.png"\)/)
    expect(glyph).toMatch(/background-color:\s*currentColor/)
    expect(glyph).toMatch(/mask-size:\s*18px 18px/)

    const img = rule(css, /(\.translation-view \.language-controls \.ti-language-controls \.ti-swap-button img\s*\{[^}]*\})/)
    expect(img).toMatch(/opacity:\s*0/)

    const hover = rule(css, /(\.translation-view \.language-controls \.ti-language-controls \.ti-swap-button:hover:not\(:disabled\)\s*\{[^}]*\})/)
    expect(hover).toMatch(/background-color:\s*var\(--ti-action-hover-bg\)/)
    expect(hover).toMatch(/color:\s*var\(--ti-action-icon-hover\)/)
    expect(hover).toMatch(/translateY\(-1px\)/)
  })

  it('gives Clear the same 28×28 / 18px neutral Header-hover treatment', () => {
    const body = rule(css, /(\.translation-view \.language-controls \.ti-btn-min-clear\s*\{[^}]*\})/)
    expect(body).toMatch(/width:\s*28px/)
    expect(body).toMatch(/height:\s*28px/)
    expect(body).toMatch(/border-radius:\s*6px/)
    expect(body).toMatch(/color:\s*var\(--ti-action-icon\)/)
    expect(body).toMatch(/opacity:\s*1/)
    expect(body).not.toMatch(/opacity:\s*1\s*!important/)
    // Layout reset properties must remain on the button itself, independent of
    // global button defaults, so styles do not depend on browser resets.
    expect(body).toMatch(/display:\s*flex/)
    expect(body).toMatch(/align-items:\s*center/)
    expect(body).toMatch(/justify-content:\s*center/)
    expect(body).toMatch(/padding:\s*0/)
    expect(body).toMatch(/border:\s*none/)
    expect(body).toMatch(/background:\s*transparent/)

    const glyph = rule(css, /(\.translation-view \.language-controls \.ti-btn-min-clear \.mask-icon\s*\{[^}]*\})/)
    expect(glyph).toMatch(/width:\s*18px/)
    expect(glyph).toMatch(/height:\s*18px/)

    const hover = rule(css, /(\.translation-view \.language-controls \.ti-btn-min-clear:hover\s*\{[^}]*\})/)
    expect(hover).toMatch(/background-color:\s*var\(--ti-action-hover-bg\)/)
    expect(hover).toMatch(/color:\s*var\(--ti-action-icon-hover\)/)
    expect(hover).toMatch(/translateY\(-1px\)/)
    const active = rule(css, /(\.translation-view \.language-controls \.ti-btn-min-clear:active\s*\{[^}]*\})/)
    expect(active).toMatch(/transform:\s*translateY\(0\) scale\(0\.95\) !important/)
  })

  it('fades Clear out before hiding it and respects reduced motion', () => {
    const visible = rule(css, /(\.translation-view \.language-controls \.ti-btn-min-clear\s*\{[^}]*\})/)
    const hidden = rule(css, /(\.ti-btn-min-clear\.ti-clear-hidden:disabled\s*\{[^}]*\})/)
    const baseMatch = css.match(/(\.translation-view \.language-controls \.ti-btn-min-clear)\s*\{([^}]*)\}/)
    const hiddenMatch = css.match(/(\.ti-btn-min-clear\.ti-clear-hidden:disabled)\s*\{([^}]*)\}/)
    expect(visible).toMatch(/opacity 180ms ease-in-out,\s*visibility 0s linear 0s/)
    expect(visible).toMatch(/background-color 0\.2s cubic-bezier\(0\.4, 0, 0\.2, 1\)/)
    expect(visible).toMatch(/color 0\.2s cubic-bezier\(0\.4, 0, 0\.2, 1\)/)
    expect(visible).toMatch(/transform 0\.2s cubic-bezier\(0\.4, 0, 0\.2, 1\)/)
    expect(visible).not.toMatch(/transition:\s*all/)
    expect(visible).toMatch(/opacity: 1;/)
    expect(visible).not.toMatch(/opacity: 1 !important/)
    expect(hidden).toMatch(/opacity: 0;/)
    expect(hidden).not.toMatch(/opacity: 0 !important/)
    expect(hidden).toMatch(/visibility: hidden/)
    expect(hidden).toMatch(/pointer-events: none/)
    expect(hidden).toMatch(/opacity 180ms ease-in-out,\s*visibility 0s linear 180ms/)
    expect(hidden).toMatch(/background-color 0\.2s cubic-bezier\(0\.4, 0, 0\.2, 1\)/)
    expect(hidden).toMatch(/color 0\.2s cubic-bezier\(0\.4, 0, 0\.2, 1\)/)
    expect(hidden).toMatch(/transform 0\.2s cubic-bezier\(0\.4, 0, 0\.2, 1\)/)
    expect(selectorSpecificity(hiddenMatch[1])).toBe(selectorSpecificity(baseMatch[1]))
    expect(css.indexOf(hiddenMatch[0])).toBeGreaterThan(css.indexOf(baseMatch[0]))

    const reducedMotion = css.match(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*([^{}]+)\{([^{}]*)\}/
    )
    expect(reducedMotion).not.toBeNull()
    const reducedSelectors = reducedMotion[1].split(',').map((selector) => selector.trim())
    expect(reducedMotion[2]).toContain('transition: none')
    expect(reducedSelectors).toEqual([
      '.translation-view .language-controls .ti-btn-min-clear',
      '.translation-view .language-controls .ti-btn-min-clear:where(.ti-clear-hidden):disabled'
    ])
    expect(selectorSpecificity(reducedSelectors[0])).toBeGreaterThanOrEqual(selectorSpecificity(baseMatch[1]))
    expect(selectorSpecificity(reducedSelectors[1])).toBeGreaterThanOrEqual(selectorSpecificity(hiddenMatch[1]))
    expect(css.indexOf(reducedMotion[0])).toBeGreaterThan(css.indexOf(hiddenMatch[0]))
  })

  it('keeps the row unwrapped at narrow popup widths', () => {
    expect(css).toMatch(/@media \(max-width: 340px\)/)
    expect(css).toMatch(
      /@media \(max-width: 340px\)\s*\{\s*\.translation-view \.language-controls\s*\{[^}]*gap:\s*4px/
    )
  })

  it('never paints the toolbar outside .translation-view', () => {
    for (const hook of ['.ti-language-select', '.ti-swap-button', '.ti-btn-min-clear', '.ti-default-action-button']) {
      const selectors = css
        .split('}')
        .map((chunk) => chunk.split('{')[0])
        .join('}')
        .split(',')
        .map((selector) => selector.trim())
        .filter((selector) => selector.includes(hook))

      for (const selector of selectors) {
        if (selector.includes('.translation-view')) {
          expect(selector).toContain('.translation-view')
        } else if (selector.includes('.ti-clear-hidden')) {
          expect(selector).toMatch(/^(?:\.ti-[\w-]+(?::[\w-]+)?)+$/)
        } else {
          expect(selector, `selector must stay scoped: ${selector}`).toContain('.translation-view')
        }
      }
    }
  })
})
