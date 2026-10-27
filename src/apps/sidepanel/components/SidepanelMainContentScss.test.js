import { describe, expect, it } from 'vitest'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as sass from 'sass'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(here, '..', '..', '..')
const scssPath = resolve(here, 'SidepanelMainContent.scss')
const languageSelectorScssPath = resolve(srcDir, 'components', 'shared', 'LanguageSelector.scss')

const compile = (path = scssPath) => sass.compile(path, {
  importers: [{
    findFileUrl(url) {
      if (url.startsWith('@/')) {
        return new URL(`file://${resolve(srcDir, url.slice(2))}`)
      }
      return null
    }
  }]
})

const findRule = (css, selectorPart) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .find(([, selector]) => selector.trim().includes(selectorPart))

const expectDeclaration = (css, selectorPart, declaration) => {
  const rule = findRule(css, selectorPart)
  expect(rule, `compiled rule containing ${selectorPart}`).toBeDefined()
  expect(rule[2]).toContain(declaration)
}

const mobileRules = (css) => {
  const query = '@media (max-width: 480px)'
  const start = css.indexOf(query)
  if (start === -1) return []

  const open = css.indexOf('{', start)
  let depth = 1
  let close = open + 1
  while (depth && close < css.length) {
    if (css[close] === '{') depth++
    if (css[close] === '}') depth--
    close++
  }

  return [...css.slice(open + 1, close - 1).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, declarations]) => ({ selector: selector.trim(), declarations }))
}

const classSpecificity = (selector) => (selector.match(/\.[\w-]+/g) || []).length
const selectorSpecificity = (selector) => classSpecificity(selector) + (selector.match(/:(?!:)[\w-]+/g) || []).length

/**
 * Sidepanel CSS is bundled into shared CSS loaded by other surfaces
 * (cssCodeSplit: false), so Sidepanel toolbar rules must be scoped under
 * the Sidepanel body context — never standalone globals. Pins the compiled
 * contract, not colors.
 */
describe('SidepanelMainContent.scss toolbar scoping', () => {
  it('scopes .ti-toolbar-icon under the sidepanel root', () => {
    const { css } = compile()
    expect(css).toContain('body.sidepanel-context .ti-toolbar-icon')
  })

  it('emits no standalone global .ti-toolbar-icon rule', () => {
    const { css } = compile()
    const stripped = css.replaceAll('body.sidepanel-context .ti-toolbar-icon', '')
    expect(stripped).not.toMatch(/(^|[},])\s*\.ti-toolbar-icon\s*\{/)
  })

  it('routes the legacy image filter to img toolbar icons', () => {
    const { css } = compile()
    const imageRule = css.match(
      /body\.sidepanel-context img\.ti-toolbar-icon\s*\{([^}]*)\}/
    )
    expect(imageRule).not.toBeNull()
    expect(imageRule[1]).toContain('filter: var(--icon-filter, none)')
    // Positive contract replaced the negative guard: no :not() needed.
    expect(css).not.toContain(':not(.mask-icon)')
  })
})

describe('SidepanelMainContent.scss selector ownership', () => {
  /* ---------------------------------------------------------------
   *  .ti-icon-button — must be scoped under .sidepanel-wrapper,
   *  never a bare global that could match Popup/shared IconButtons.
   * --------------------------------------------------------------- */
  it('owns .ti-icon-button under .sidepanel-wrapper (not global)', () => {
    const { css } = compile()

    // Scoped rule exists
    expect(css).toContain('.sidepanel-wrapper .ti-icon-button')

    // No bare global `.ti-icon-button {` selector remains.
    // Strip every scoped occurrence, then verify no bare rule-start.
    const stripped = css
      .replace(/\.sidepanel-wrapper\s+\.ti-icon-button/g, 'SCOPE')
      .replace(/body\.sidepanel-context\s+\.ti-icon-button/g, 'SCOPE')
      .replace(/\.theme-dark[^{]*\.ti-icon-button/g, 'SCOPE')
      .replace(/:root\.theme-dark[^{]*\.ti-icon-button/g, 'SCOPE')
    expect(stripped).not.toMatch(/(^|[}\n])\s*\.ti-icon-button\s*[{,]/m)
  })

  /* ---------------------------------------------------------------
   *  Main layout rules — must all be owned by .sidepanel-wrapper.
   * --------------------------------------------------------------- */
  it('owns .language-controls under .sidepanel-wrapper', () => {
    const { css } = compile()
    expect(css).toContain('.sidepanel-wrapper .language-controls')

    const stripped = css.replace(/\.sidepanel-wrapper\s+\.language-controls/g, '')
    expect(stripped).not.toMatch(/(^|[}\n])\s*\.language-controls\s*\{/)
  })

  it('owns .language-controls--wide under .sidepanel-wrapper', () => {
    const { css } = compile()
    expect(css).toContain('.sidepanel-wrapper .language-controls--wide')
  })

  it('owns .language-selector-row under .sidepanel-wrapper', () => {
    const { css } = compile()
    expect(css).toContain('.sidepanel-wrapper .language-selector-row')
  })

  it('owns .translate-button-row under .sidepanel-wrapper', () => {
    const { css } = compile()
    expect(css).toContain('.sidepanel-wrapper .translate-button-row')
  })

  it('owns .translation-form under .sidepanel-wrapper', () => {
    const { css } = compile()
    expect(css).toContain('.sidepanel-wrapper .translation-form')
  })

  it('owns .output-container under .sidepanel-wrapper', () => {
    const { css } = compile()
    expect(css).toContain('.sidepanel-wrapper .output-container')
  })

  it('owns .center-spacer under .sidepanel-wrapper', () => {
    const { css } = compile()
    expect(css).toContain('.sidepanel-wrapper .center-spacer')
  })

  it('owns .end-spacer under .sidepanel-wrapper', () => {
    const { css } = compile()
    expect(css).toContain('.sidepanel-wrapper .end-spacer')
  })

  /* ---------------------------------------------------------------
   *  Root compound selector: .sidepanel-wrapper.main-content
   *  The root element carries BOTH classes — must use compound form.
   * --------------------------------------------------------------- */
  it('uses compound .sidepanel-wrapper.main-content for root element', () => {
    const { css } = compile()

    // Compound selector present
    expect(css).toMatch(/\.sidepanel-wrapper\.main-content\s*\{/)
    // Descendant form must NOT exist
    expect(css).not.toMatch(/\.sidepanel-wrapper\s+\.main-content\s*\{/)

    // Verify key declarations survive in the compound rule
    const match = css.match(/\.sidepanel-wrapper\.main-content\s*\{([^}]*)\}/)
    expect(match).not.toBeNull()
    expect(match[1]).toContain('display: flex')
    expect(match[1]).toContain('flex: 1')
  })

  /* ---------------------------------------------------------------
   *  body.sidepanel-context protections remain intact.
   * --------------------------------------------------------------- */
  it('preserves body.sidepanel-context toolbar icon protections', () => {
    const { css } = compile()
    expect(css).toContain('body.sidepanel-context .ti-toolbar-icon')
    expect(css).toContain('body.sidepanel-context img.ti-toolbar-icon')
    expect(css).toContain('body.sidepanel-context .ti-icon-button:hover .ti-toolbar-icon')
  })

  /* ---------------------------------------------------------------
   *  Dark theme block stays top-level (not nested under .sidepanel-wrapper)
   *  because .theme-dark is on html/body, an ancestor of .sidepanel-wrapper.
   * --------------------------------------------------------------- */
  it('keeps dark theme block outside .sidepanel-wrapper nesting', () => {
    const { css } = compile()
    // Dark theme selectors must still be present
    expect(css).toContain('.theme-dark .ti-icon-button.row-clear-btn')
    expect(css).toContain('.theme-dark .ti-icon-button.inline-clear-btn')
  })
})

describe('compiled Phase 1 language-control styles', () => {
  it('keeps the inline provider at inline-end with or without the inline clear button', () => {
    const { css } = compile()

    expectDeclaration(css, '.language-controls--wide .translate-button-inline', 'justify-content: flex-start')
    const providerRule = findRule(css, '.language-controls--wide .translate-button-inline .ti-sidepanel-split-selector')
    expect(providerRule).toBeDefined()
    expect(providerRule[1]).toContain('.sidepanel-wrapper .language-controls--wide .translate-button-inline .ti-sidepanel-split-selector')
    expect(providerRule[1]).not.toContain(':deep(')
    expect(providerRule[2]).toContain('margin-inline-start: auto')
    expect(css).not.toContain('.translate-button-inline :deep(.ti-sidepanel-split-selector)')
    expect(css).not.toMatch(/\.language-controls--wide\s+\.inline-clear-btn\s*\{[^}]*margin-(?:left|right):/)
  })

  it('keeps language-control rules scoped and free of :deep while preserving unrelated deep selectors', () => {
    const { css } = compile()

    expect(css).toContain('.sidepanel-wrapper .language-selector-row .ti-language-controls')
    expect(css).toContain('.sidepanel-wrapper .language-selector-row .ti-language-select')
    expect(css).toContain('.sidepanel-wrapper .language-selector-row .ti-swap-button')
    expect(css).not.toMatch(/[^{}]*(?:\.ti-language-select|\.ti-swap-button|\.ti-default-action-button)[^{}]*:deep/)
    expect(css).toContain(':deep(.provider-selector)')
    expect(css).toContain(':deep(.textarea-container)')
  })

  it('compiles compact sizing, narrow vertical guard, wide sizing, and swap focus/image rules', () => {
    const { css } = compile()

    expectDeclaration(css, '.sidepanel-wrapper .language-selector-row .ti-language-select', 'height: 32px !important')
    expectDeclaration(css, '.sidepanel-wrapper .language-selector-row .ti-language-select', 'border-radius: 6px !important')
    expectDeclaration(css, '.sidepanel-wrapper .language-selector-row .ti-language-select', 'font-size: 13px !important')
    expect(css).toMatch(/@media \(max-width: 480px\)[\s\S]*?\.ti-language-controls:not\(\.ti-language-controls--vertical\)/)
    expectDeclaration(css, '.language-controls--wide .language-selector-row .ti-language-select', 'max-width: 100px !important')
    expectDeclaration(css, '.sidepanel-wrapper .language-selector-row .ti-language-select:focus-visible', 'outline: 2px solid var(--color-primary, #1976d2) !important')
    expectDeclaration(css, '.sidepanel-wrapper .language-selector-row .ti-swap-button:focus-visible', 'outline: 2px solid var(--color-primary, #1976d2) !important')
    expectDeclaration(css, '.sidepanel-wrapper .language-selector-row .ti-swap-button img', 'width: 18px !important')
  })

  it('compiles star resting, reveal, hover, disabled, and keyboard-focus behavior', () => {
    const { css } = compile()

    expectDeclaration(css, '.ti-default-action-button.is-active', 'opacity: 0 !important')
    expectDeclaration(css, '.ti-language-control-group:hover', 'opacity: 1 !important')
    expectDeclaration(css, '.ti-language-control-group .ti-default-action-button.is-active:where(:hover:not(:disabled))', 'color: var(--color-primary, #1976d2) !important')
    expectDeclaration(css, '.ti-language-control-group .ti-default-action-button:not(.is-active):where(:hover:not(:disabled))', 'color: var(--tab-button-color, #5f6368) !important')
    expectDeclaration(css, '.ti-default-action-button.is-active:where(:disabled)', 'opacity: 0 !important')
    expectDeclaration(css, ':focus-within) .ti-default-action-button.is-active:where(:disabled)', 'opacity: 0.45 !important')
    expectDeclaration(css, '.ti-default-action-button:where(:focus-visible)', 'outline: 2px solid var(--color-primary, #1976d2) !important')
  })

  it('compiles shared narrow/vertical, dark-theme, RTL logical, and swap-image rules', () => {
    const { css } = compile(languageSelectorScssPath)

    expect(css).toMatch(/@media \(max-width: 480px\)[\s\S]*?\.ti-language-controls:not\(\.ti-compact-mode\):not\(\.ti-language-controls--vertical\)/)
    expectDeclaration(css, '.ti-language-controls.ti-language-controls--vertical', 'flex-direction: column !important')
    expectDeclaration(css, '.ti-language-controls.ti-language-controls--dark', '--bg-disabled: rgba(255, 255, 255, 0.04)')
    expectDeclaration(css, ':is([dir=rtl], html[dir=rtl]) .ti-language-select', 'padding-inline-start: 25px !important')
    expectDeclaration(css, '.ti-swap-button--mirrored img', 'transform: scaleX(-1) !important')
    expect(css).toContain('filter: var(--icon-filter, none) !important')
  })

  it('keeps narrow horizontal Sidepanel swap dimensions above shared mobile overrides', () => {
    const sidepanelCss = compile().css
    const sharedCss = compile(languageSelectorScssPath).css
    const sidepanelRules = mobileRules(sidepanelCss)
    const sharedRules = mobileRules(sharedCss)
    const sharedButton = sharedRules.find(({ selector }) =>
      selector.includes('.ti-language-controls:not(.ti-compact-mode):not(.ti-language-controls--vertical) .ti-swap-button'))
    const sharedImage = sharedRules.find(({ selector }) =>
      selector.includes('.ti-language-controls:not(.ti-compact-mode):not(.ti-language-controls--vertical) .ti-swap-button img'))
    const sidepanelButton = sidepanelRules.find(({ selector, declarations }) =>
      selector.includes('.sidepanel-wrapper .language-selector-row .ti-language-controls:not(.ti-language-controls--vertical) > .ti-swap-button') &&
      declarations.includes('width: 32px !important'))
    const sidepanelImage = sidepanelRules.find(({ selector, declarations }) =>
      selector.includes('.sidepanel-wrapper .language-selector-row .ti-language-controls:not(.ti-language-controls--vertical) > .ti-swap-button img') &&
      declarations.includes('width: 18px !important'))

    expect(sharedButton?.declarations).toContain('width: 44px !important')
    expect(sharedButton?.declarations).toContain('height: 30px !important')
    expect(sharedImage?.declarations).toContain('width: 24px !important')
    expect(sharedImage?.declarations).toContain('height: 24px !important')
    expect(sidepanelButton?.declarations).toContain('width: 32px !important')
    expect(sidepanelButton?.declarations).toContain('height: 32px !important')
    expect(sidepanelImage?.declarations).toContain('width: 18px !important')
    expect(sidepanelImage?.declarations).toContain('height: 18px !important')
    expect(classSpecificity(sidepanelButton.selector)).toBeGreaterThan(classSpecificity(sharedButton.selector))
    expect(classSpecificity(sidepanelImage.selector)).toBeGreaterThan(classSpecificity(sharedImage.selector))
    expect(sidepanelButton.selector).toContain(':not(.ti-language-controls--vertical)')
    expect(sidepanelImage.selector).toContain(':not(.ti-language-controls--vertical)')
  })

  it('keeps clear-button focus visible above reset styles and preserves mask styling', () => {
    const { css } = compile()
    const resetRule = findRule(css, '.sidepanel-wrapper .ti-icon-button')
    const clearFocusRules = [
      '.inline-clear-btn:focus-visible',
      '.row-clear-btn:focus-visible'
    ]

    for (const selector of clearFocusRules) {
      const rule = findRule(css, selector)
      expect(rule, `compiled rule containing ${selector}`).toBeDefined()
      expect(rule[2]).toMatch(/outline:\s*2px solid .* !important/)
      expect(rule[2]).toContain('outline-offset: 1px !important')
      expect(selectorSpecificity(rule[1])).toBeGreaterThan(selectorSpecificity(resetRule[1]))
    }

    expect(css).toContain('.sidepanel-wrapper .ti-icon-button.inline-clear-btn')
    expect(css).toContain('.sidepanel-wrapper .ti-icon-button.row-clear-btn')
    for (const button of ['inline-clear-btn', 'row-clear-btn']) {
      expect(css).toMatch(new RegExp(`\\.theme-dark \\.ti-icon-button\\.${button}[^{}]*\\{[^}]*filter: none !important`))
    }
    const clearMaskRule = findRule(css, '.ti-icon-button .clear-mask-icon')
    expect(clearMaskRule).toBeDefined()
    expect(clearMaskRule[2]).toContain('color: inherit')
    expect(clearMaskRule[2]).not.toMatch(/filter\s*:/)
  })
})
