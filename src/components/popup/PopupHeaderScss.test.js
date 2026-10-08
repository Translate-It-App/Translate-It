import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as sass from 'sass'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(here, '..', '..')
const scssPath = resolve(here, 'PopupHeader.scss')

const scssImporters = [{
  findFileUrl(url) {
    if (url.startsWith('@/')) {
      return new URL(`file://${resolve(srcDir, url.slice(2))}`)
    }
    return null
  }
}]

/**
 * PopupHeader.scss is a plain SCSS import (not `<style scoped>`, not
 * CSS-Modules), so theme hooks must be ordinary selectors. This pins the
 * selector contract without asserting computed styles.
 */
describe('PopupHeader.scss dark contract', () => {
  it('uses plain theme hooks (no :global() passthrough)', () => {
    const source = readFileSync(scssPath, 'utf8')

    expect(source).not.toContain(':global(')
    expect(source).toContain('.theme-dark &')
    // The hover token lives only in the base contract; the dark block
    // must not override it (theme value comes from the token itself).
    const hoverDeclarations = source.match(/--ti-action-icon-hover\s*:/g) || []
    expect(hoverDeclarations).toHaveLength(1)
  })

  it('compiles to reachable dark selectors carrying the contract', () => {
    const { css } = sass.compile(scssPath, { importers: scssImporters })

    expect(css).not.toContain(':global(')
    // Dark contract vars are declared on the toolbar root so both
    // .ti-header-left and .ti-header-actions inherit them.
    expect(css).toContain('.theme-dark .ti-header-toolbar')
    expect(css).toContain('--ti-action-icon: #fff')
    expect(css).toContain('--ti-action-icon-hover: var(--color-action-hover-accent)')
    expect(css).not.toContain('--ti-action-icon-hover: var(--color-warning)')
    expect(css).toContain('--ti-action-hover-bg: #424242')
    expect(css).toContain('--ti-action-active-bg: #555555')
    // The dead dark-theme chevron-divider override is gone with the chevron.
    expect(css).not.toContain('ti-btn-select-chevron')
    expect(css).not.toContain('border-inline-start-color: rgba(255, 255, 255, 0.1)')
  })

  it('defines the action hover accent token per theme', () => {
    const tokens = readFileSync(
      resolve(srcDir, 'assets/styles/base/_variables.scss'),
      'utf8'
    )

    expect(tokens).toContain('--color-action-hover-accent: #ff9800;')
    expect(tokens).toContain('--color-action-hover-accent: #ffb74d;')
  })

  it('exposes the action contract at .ti-header-toolbar scope (not only .ti-header-actions)', () => {
    const source = readFileSync(scssPath, 'utf8')
    const { css } = sass.compile(scssPath, { importers: scssImporters })

    // Light contract: the four vars appear at .ti-header-toolbar level.
    // The toolbar root block must declare --ti-action-hover-bg directly.
    const toolbarBlock = source.match(/\.ti-header-toolbar\s*\{([\s\S]*?)\/\*\s*Left group/)
    expect(toolbarBlock).toBeTruthy()
    expect(toolbarBlock[1]).toContain('--ti-action-hover-bg: rgba(0, 0, 0, 0.08)')

    // Compiled: dark contract lands on .theme-dark .ti-header-toolbar,
    // inherited by both .ti-header-left and .ti-header-actions.
    expect(css).toContain('.theme-dark .ti-header-toolbar')
  })

  it('pins the header actions spacing contract in source', () => {
    const source = readFileSync(scssPath, 'utf8')

    // Ordinary action gap + logical end inset on the actions boundary.
    expect(source).toContain('gap: 5px !important;')
    expect(source).toContain('padding-inline-end: 4px !important;')
    // Select+badge container keeps a LARGER explicit separation (gap + margin).
    expect(source).toContain('.ti-header-actions > .ti-select-action')
    expect(source).toContain('margin-inline-start: 7px;')
  })

  it('Select separation is larger than ordinary gap (hierarchy preserved)', () => {
    const source = readFileSync(scssPath, 'utf8')

    // Ordinary gap inside .ti-header-actions: 5px.
    // Select-action container margin-inline-start: 7px.
    // Total Select separation = 5 + 7 = 12px > ordinary 5px. Ratio = 2.4×.
    const actionsBlock = source.match(/\.ti-header-actions\s*\{[\s\S]*?\}/)
    expect(actionsBlock).toBeTruthy()
    const gapMatch = actionsBlock[0].match(/gap:\s*(\d+)px/)
    expect(gapMatch).toBeTruthy()
    const ordinaryGap = parseInt(gapMatch[1], 10)
    expect(ordinaryGap).toBe(5)

    const marginMatch = source.match(/margin-inline-start:\s*(\d+)px/)
    expect(marginMatch).toBeTruthy()
    const selectMargin = parseInt(marginMatch[1], 10)
    expect(selectMargin).toBe(7)

    const selectSeparation = ordinaryGap + selectMargin
    expect(selectSeparation).toBeGreaterThan(ordinaryGap)
    // Ratio ≥ 1.8× to keep hierarchy visible
    expect(selectSeparation / ordinaryGap).toBeGreaterThanOrEqual(1.8)
  })

  it('pins the More-menu hover contract per theme', () => {
    const source = readFileSync(scssPath, 'utf8')
    const { css } = sass.compile(scssPath, { importers: scssImporters })

    // Light hover unchanged: neutral black overlay only (no color shift).
    expect(source).toContain('background-color: rgba(0, 0, 0, 0.06) !important;')

    // Dark hover: reachable selector, distinguishable neutral background,
    // accent for text + currentColor icons.
    expect(css).toContain('.theme-dark .ti-header-toolbar .ti-header-menu-item:hover')
    expect(css).toContain('background-color: var(--ti-action-hover-bg, #424242) !important;')
    expect(css).toContain('color: var(--color-action-hover-accent) !important;')

    // focus-visible remains a separate state (blue ring preserved).
    expect(css).toContain('outline: 2px solid var(--color-primary, #1976d2) !important;')
  })
})

describe('PopupHeader.scss optical sizing contract', () => {
  it('global toolbar icon box remains 22×22 (shared rule intact)', () => {
    const source = readFileSync(scssPath, 'utf8')

    // The shared rule inside .ti-toolbar-button that covers all icon types.
    const sharedRule = source.match(
      /img,\s*\.ti-toolbar-icon,\s*\.ti-icon-button\s*\{[^}]*width:\s*22px\s*![i!]+mportant;[^}]*height:\s*22px\s*![i!]+mportant;[^}]*\}/
    )
    expect(sharedRule).toBeTruthy()
    expect(sharedRule[0]).toContain('width: 22px !important')
    expect(sharedRule[0]).toContain('height: 22px !important')
  })

  it('Settings has per-action optical mask-size override to 20px (box stays 22×22)', () => {
    const source = readFileSync(scssPath, 'utf8')

    // Match the combined selector block (settings + sidepanel) that carries mask-size.
    // The mask-size block is the only rule with .ti-btn-settings + .ti-btn-sidepanel together.
    const maskBlock = source.match(
      /\.ti-header-actions\s+\.ti-btn-settings[\s\S]*?\.ti-header-actions\s+\.ti-btn-sidepanel\s+\.ti-toolbar-icon\s*\{([^}]*)\}/
    )
    expect(maskBlock).toBeTruthy()
    // Glyph shrinks to 20×20 via mask-size only
    expect(maskBlock[1]).toContain('mask-size: 20px 20px')
    expect(maskBlock[1]).toContain('-webkit-mask-size: 20px 20px')
    // Layout box must NOT be overridden — shared 22×22 rule governs width/height
    expect(maskBlock[1]).not.toMatch(/width:\s*20px/)
    expect(maskBlock[1]).not.toMatch(/height:\s*20px/)
  })

  it('Sidepanel has per-action optical mask-size override to 20px (box stays 22×22)', () => {
    const source = readFileSync(scssPath, 'utf8')

    // Same combined block covers sidepanel; verify its properties too.
    const maskBlock = source.match(
      /\.ti-header-actions\s+\.ti-btn-settings[\s\S]*?\.ti-header-actions\s+\.ti-btn-sidepanel\s+\.ti-toolbar-icon\s*\{([^}]*)\}/
    )
    expect(maskBlock).toBeTruthy()
    // Glyph shrinks to 20×20 via mask-size only
    expect(maskBlock[1]).toContain('mask-size: 20px 20px')
    expect(maskBlock[1]).toContain('-webkit-mask-size: 20px 20px')
    // Layout box must NOT be overridden
    expect(maskBlock[1]).not.toMatch(/width:\s*20px/)
    expect(maskBlock[1]).not.toMatch(/height:\s*20px/)
  })

  it('Capture and Mouse Hover have NO per-action size or mask-size override (shared 22px)', () => {
    const source = readFileSync(scssPath, 'utf8')

    // Capture must not have a width override — it relies on the shared 22px.
    const captureOverride = source.match(
      /\.ti-header-actions\s+\.ti-btn-capture\s+\.ti-toolbar-icon\s*\{[^}]*width:/
    )
    expect(captureOverride).toBeFalsy()

    // Capture must not have a mask-size override.
    const captureMaskOverride = source.match(
      /\.ti-header-actions\s+\.ti-btn-capture\s+\.ti-toolbar-icon\s*\{[^}]*mask-size:/
    )
    expect(captureMaskOverride).toBeFalsy()

    // Mouse Hover must not have a width override either.
    const mouseHoverOverride = source.match(
      /\.ti-header-actions\s+\.ti-btn-mouse-hover\s+\.ti-toolbar-icon\s*\{[^}]*width:/
    )
    expect(mouseHoverOverride).toBeFalsy()

    // Mouse Hover must not have a mask-size override either.
    const mouseHoverMaskOverride = source.match(
      /\.ti-header-actions\s+\.ti-btn-mouse-hover\s+\.ti-toolbar-icon\s*\{[^}]*mask-size:/
    )
    expect(mouseHoverMaskOverride).toBeFalsy()
  })

  it('optical translateY correction for Settings/MouseHover/Capture is preserved', () => {
    const source = readFileSync(scssPath, 'utf8')

    const translateRule = source.match(
      /\.ti-header-actions\s+\.ti-btn-settings\s+\.ti-toolbar-icon,\s*\n\s*\.ti-header-actions\s+\.ti-btn-mouse-hover\s+\.ti-toolbar-icon,\s*\n\s*\.ti-header-actions\s+\.ti-btn-capture\s+\.ti-toolbar-icon\s*\{[^}]*translate:\s*0\s+-1px[^}]*\}/
    )
    expect(translateRule).toBeTruthy()
    expect(translateRule[0]).toContain('translate: 0 -1px')
  })

  it('ordinary header buttons are 24×24 hit targets (width/height/min-width/min-height)', () => {
    const source = readFileSync(scssPath, 'utf8')

    // The hit-target rule must exist scoped to .ti-header-actions so
    // Page Translate compact geometry is untouched.
    const hitTargetBlock = source.match(
      /\.ti-header-actions\s+\.ti-toolbar-button\s*\{([^}]*)\}/
    )
    expect(hitTargetBlock).toBeTruthy()
    expect(hitTargetBlock[1]).toContain('width: 24px')
    expect(hitTargetBlock[1]).toContain('height: 24px')
    expect(hitTargetBlock[1]).toContain('min-width: 24px')
    expect(hitTargetBlock[1]).toContain('min-height: 24px')
  })

  it('shared icon glyph remains 22px (not changed by hit-target)', () => {
    const source = readFileSync(scssPath, 'utf8')

    const sharedRule = source.match(
      /img,\s*\.ti-toolbar-icon,\s*\.ti-icon-button\s*\{[^}]*width:\s*22px\s*![i!]+mportant;[^}]*height:\s*22px\s*![i!]+mportant;[^}]*\}/
    )
    expect(sharedRule).toBeTruthy()
    expect(sharedRule[0]).toContain('width: 22px !important')
    expect(sharedRule[0]).toContain('height: 22px !important')
  })

  it('Settings and Sidepanel optical mask-size remains 20px', () => {
    const source = readFileSync(scssPath, 'utf8')

    const maskBlock = source.match(
      /\.ti-header-actions\s+\.ti-btn-settings[\s\S]*?\.ti-header-actions\s+\.ti-btn-sidepanel\s+\.ti-toolbar-icon\s*\{([^}]*)\}/
    )
    expect(maskBlock).toBeTruthy()
    expect(maskBlock[1]).toContain('mask-size: 20px 20px')
    expect(maskBlock[1]).toContain('-webkit-mask-size: 20px 20px')
    expect(maskBlock[1]).not.toMatch(/width:\s*20px/)
    expect(maskBlock[1]).not.toMatch(/height:\s*20px/)
  })

  it('More inner span remains 22×22 while button is 24×24', () => {
    const source = readFileSync(scssPath, 'utf8')

    const moreBlock = source.match(/\.ti-btn-more\s*\{([\s\S]*?)\n\s*\}/)
    expect(moreBlock).toBeTruthy()
    // Button hit target
    expect(moreBlock[1]).toContain('width: 24px !important')
    expect(moreBlock[1]).toContain('height: 24px !important')
    // Inner span unchanged
    expect(moreBlock[1]).toContain('width: 22px !important')
    expect(moreBlock[1]).toContain('height: 22px !important')
    // Typography unchanged
    expect(moreBlock[1]).toContain('font-size: 20px !important')
    expect(moreBlock[1]).toContain('letter-spacing: 1.5px !important')
    expect(moreBlock[1]).toContain('line-height: 1 !important')
  })

  it('Select is an ordinary button (no joined-pill geometry)', () => {
    const source = readFileSync(scssPath, 'utf8')

    // Select has no dedicated sizing/radius block — it consumes the shared
    // hit-target (24×24) and base border-radius (6px) rules like every
    // other header toolbar button.
    expect(source).not.toMatch(/\.ti-btn-select\s*\{/)
    expect(source).not.toContain('6px 0 0 6px')
    expect(source).not.toContain('border-inline-start')
  })

  it('Revert badge geometry: hit target top-left coincides with the visible surface; slack never steals Select clicks', () => {
    const source = readFileSync(scssPath, 'utf8')

    const badgeBlock = source.match(
      /\.ti-header-actions\s+\.ti-select-action\s+\.ti-btn-revert-badge\s*\{([^}]*)\}/
    )
    expect(badgeBlock).toBeTruthy()
    // Full 24×24 transparent hit target.
    expect(badgeBlock[1]).toContain('width: 24px')
    expect(badgeBlock[1]).toContain('min-width: 24px')
    expect(badgeBlock[1]).toContain('height: 24px')
    expect(badgeBlock[1]).toContain('min-height: 24px')
    expect(badgeBlock[1]).toContain('box-sizing: border-box')
    expect(badgeBlock[1]).toContain('position: absolute')
    // Surface flush at the button's TOP-LEFT (8px slack becomes the
    // inline-end/bottom tail, not an overlay on Select).
    expect(badgeBlock[1]).toContain('justify-content: flex-start')
    expect(badgeBlock[1]).toContain('align-items: flex-start')
    // Opt out of the shared .ti-toolbar-button rules entirely — no
    // transform declaration (native press only, badge never shifts).
    expect(badgeBlock[1]).not.toMatch(/transform\s*:/)
    // Old18px button sizing and shared class must be gone.
    expect(badgeBlock[1]).not.toMatch(/width:\s*18px/)
    expect(source).not.toContain('ti-toolbar-button ti-btn-revert')

    // Container: 24×24 relative anchor box, 7px start separation, 8px
    // inline-end reservation so the hit target clears Sidepanel.
    const containerBlock = source.match(
      /\.ti-header-actions\s+>\s+\.ti-select-action\s*\{([^}]*)\}/
    )
    expect(containerBlock).toBeTruthy()
    expect(containerBlock[1]).toContain('position: relative')
    expect(containerBlock[1]).toContain('width: 24px')
    expect(containerBlock[1]).toContain('height: 24px')
    expect(containerBlock[1]).toContain('margin-inline-start: 7px')
    expect(containerBlock[1]).toContain('margin-inline-end: 8px')
    expect(containerBlock[1]).toContain('flex-shrink: 0')

    const badgeWidth = parseInt(badgeBlock[1].match(/width:\s*(\d+)px/)[1], 10)
    const badgeHeight = parseInt(badgeBlock[1].match(/height:\s*(\d+)px/)[1], 10)
    const bottomOffset = parseInt(badgeBlock[1].match(/bottom:\s*-(\d+)px/)[1], 10)
    const rightOffset = parseInt(badgeBlock[1].match(/right:\s*-(\d+)px/)[1], 10)
    const containerWidth = parseInt(containerBlock[1].match(/width:\s*(\d+)px/)[1], 10)
    const containerHeight = parseInt(containerBlock[1].match(/height:\s*(\d+)px/)[1], 10)
    const reserve = parseInt(containerBlock[1].match(/margin-inline-end:\s*(\d+)px/)[1], 10)

    // Boxes relative to the container origin (Select occupies 0..24 × 0..24).
    const badgeLeft = containerWidth + rightOffset - badgeWidth  // 24 + 13 − 24 = 13
    const badgeTop = containerHeight + bottomOffset - badgeHeight // 24 + 13 − 24 = 13
    const badgeRight = badgeLeft + badgeWidth   // 37
    const badgeBottom = badgeTop + badgeHeight  // 37
    const surfaceSize = 16
    // Surface is flush at the button's top-left (flex-start/flex-start).
    const surfaceLeft = badgeLeft
    const surfaceTop = badgeTop
    const surfaceRight = surfaceLeft + surfaceSize   // 29
    const surfaceBottom = surfaceTop + surfaceSize   // 29

    // --- Contract 4: visible badge coordinates unchanged pre-fix ---
    expect([surfaceLeft, surfaceTop, surfaceRight, surfaceBottom]).toEqual([13, 13, 29, 29])

    // --- Contract 1: transparent hit slack does NOT overlap Select ---
    // Slack = button box minus the 16×16 top-left surface:
    //   right strip (x29..37 × y13..37) and bottom strip (x13..29 × y29..37).
    // Select box = x0..24 × y0..24. Both strips start past x24 or y24.
    const slackRegions = [
      { left: surfaceRight, top: badgeTop, right: badgeRight, bottom: badgeBottom },
      { left: badgeLeft, top: surfaceBottom, right: badgeRight, bottom: badgeBottom }
    ]
    for (const slack of slackRegions) {
      const overlapsSelect =
        slack.left < 24 && slack.right > 0 && slack.top < 24 && slack.bottom > 0
      expect(overlapsSelect).toBe(false)
    }

    // --- Contract 2: Revert ∩ Select is limited to the visible badge ---
    // Badge box ∩ Select = x13..24 × y13..24, fully inside the surface,
    // so the overlap area equals surface ∩ Select and never exceeds 16×16.
    const badgeSelectOverlap = {
      left: Math.max(badgeLeft, 0),
      top: Math.max(badgeTop, 0),
      right: Math.min(badgeRight, 24),
      bottom: Math.min(badgeBottom, 24)
    }
    const surfaceSelectOverlap = {
      left: Math.max(surfaceLeft, 0),
      top: Math.max(surfaceTop, 0),
      right: Math.min(surfaceRight, 24),
      bottom: Math.min(surfaceBottom, 24)
    }
    expect(badgeSelectOverlap).toEqual(surfaceSelectOverlap)
    const overlapArea =
      (badgeSelectOverlap.right - badgeSelectOverlap.left) *
      (badgeSelectOverlap.bottom - badgeSelectOverlap.top)
    expect(overlapArea).toBeLessThanOrEqual(surfaceSize * surfaceSize)
    expect(overlapArea).toBeGreaterThan(0) // visible badge does overlap, intentionally

    // --- Contract 3: hit target does not overlap the Sidepanel button ---
    // Sidepanel starts after container + inline-end reservation + 5px gap.
    const actionsBlock = source.match(/\.ti-header-actions\s*\{[\s\S]*?\}/)
    expect(actionsBlock).toBeTruthy()
    const gapMatch = actionsBlock[0].match(/gap:\s*(\d+)px/)
    expect(gapMatch).toBeTruthy()
    const actionsGap = parseInt(gapMatch[1], 10)
    const sidepanelLeft = containerWidth + reserve + actionsGap // 24 + 8 + 5 = 37
    expect(badgeRight).toBeLessThanOrEqual(sidepanelLeft) // 37 ≤ 37

    // Bottom drop still fits the header's ≥14px slack (no popup-body overflow).
    expect(bottomOffset).toBeLessThanOrEqual(14)
  })

  it('Revert native target remains a 24×24 min-size hit box', () => {
    const source = readFileSync(scssPath, 'utf8')

    const badgeBlock = source.match(
      /\.ti-header-actions\s+\.ti-select-action\s+\.ti-btn-revert-badge\s*\{([^}]*)\}/
    )
    expect(badgeBlock).toBeTruthy()
    expect(badgeBlock[1]).toContain('width: 24px')
    expect(badgeBlock[1]).toContain('min-width: 24px')
    expect(badgeBlock[1]).toContain('height: 24px')
    expect(badgeBlock[1]).toContain('min-height: 24px')
    expect(badgeBlock[1]).toContain('box-sizing: border-box')
  })

  it('Revert badge surface is a small opaque circle on Select’s corner', () => {
    const source = readFileSync(scssPath, 'utf8')

    const surfaceBlock = source.match(
      /\.ti-select-action\s+\.ti-btn-revert-badge\s+\.ti-revert-badge-surface\s*\{([^}]*)\}/
    )
    expect(surfaceBlock).toBeTruthy()
    // Visible circle lives in the 14–16px band.
    const surfaceWidth = parseInt(surfaceBlock[1].match(/width:\s*(\d+)px/)[1], 10)
    expect(surfaceWidth).toBeGreaterThanOrEqual(14)
    expect(surfaceWidth).toBeLessThanOrEqual(16)
    expect(surfaceBlock[1]).toContain(`height: ${surfaceWidth}px`)
    expect(surfaceBlock[1]).toContain('box-sizing: border-box')
    expect(surfaceBlock[1]).toContain('border-radius: 50%')
    // Quiet default: 1px theme-aware border + opaque header background
    // (opaque so Select's hover paint underneath never tints it).
    expect(surfaceBlock[1]).toContain('border: 1px solid var(--header-border-color')
    expect(surfaceBlock[1]).toContain('background-color: var(--header-bg-color')
    // No divider / joined-pill radius leftovers.
    expect(surfaceBlock[1]).not.toContain('border-inline-start')
    expect(surfaceBlock[1]).not.toContain('0 6px 6px 0')
  })

  it('Revert glyph is a small mask icon outside the shared 22px toolbar rule', () => {
    const source = readFileSync(scssPath, 'utf8')
    const vueSource = readFileSync(resolve(here, 'PopupHeader.vue'), 'utf8')

    // Shared icon rule inside .ti-toolbar-button governs the Select glyph.
    const sharedRule = source.match(
      /img,\s*\.ti-toolbar-icon,\s*\.ti-icon-button\s*\{[^}]*width:\s*22px[^}]*\}/
    )
    expect(sharedRule).toBeTruthy()

    // Badge glyph carries NO ti-toolbar-icon class (opts out of the shared
    // 22px rule) and is sized via the MaskIcon size prop in the 11–13 band.
    const badgeGlyph = vueSource.match(
      /class="ti-btn-revert-badge"[\s\S]*?class="ti-revert-badge-surface"[\s\S]*?:size="(\d+)"[\s\S]*?<\/button>/
    )
    expect(badgeGlyph).toBeTruthy()
    const glyphSize = parseInt(badgeGlyph[1], 10)
    expect(glyphSize).toBeGreaterThanOrEqual(11)
    expect(glyphSize).toBeLessThanOrEqual(13)
    expect(vueSource).not.toMatch(/ti-revert-badge-surface[\s\S]*?ti-toolbar-icon/)
    // SCSS must not force a different badge-glyph size either.
    expect(source).not.toMatch(/ti-btn-revert-badge[^{]*\.ti-toolbar-icon/)
  })

  it('badge quiet/hover contract: glyph-only opacity, no shared hover, no filter', () => {
    const source = readFileSync(scssPath, 'utf8')
    const { css } = sass.compile(scssPath, { importers: scssImporters })

    // Quiet default is glyph-only opacity on the badge mask (NOT surface
    // opacity — the opaque circle must not couple to Select hover underlay).
    const glyphQuiet = source.match(
      /\.ti-select-action\s+\.ti-btn-revert-badge\s+\.mask-icon\s*\{([^}]*)\}/
    )
    expect(glyphQuiet).toBeTruthy()
    expect(glyphQuiet[1]).toMatch(/opacity:\s*0\.\d+/)
    const surfaceBlock = source.match(
      /\.ti-select-action\s+\.ti-btn-revert-badge\s+\.ti-revert-badge-surface\s*\{([^}]*)\}/
    )
    expect(surfaceBlock[1]).not.toMatch(/opacity:/)
    // currentColor-driven: no filter/invert anywhere near the badge.
    expect(css).not.toMatch(/ti-btn-revert-badge[^{]*\{[^}]*filter:/)

    // No parent-level joined hover (controls stay independent).
    expect(source).not.toMatch(/\.ti-select-action\s*:hover/)
    expect(css).not.toMatch(/\.ti-select-action:hover\s/)

    // Badge owns explicit hover + focus rules targeting its surface + glyph.
    expect(source).toMatch(/\.ti-btn-revert-badge\s*:\s*hover\s+\.ti-revert-badge-surface/)
    expect(source).toMatch(/\.ti-btn-revert-badge\s*:\s*focus-visible\s+\.ti-revert-badge-surface/)
    expect(css).toContain('.ti-btn-revert-badge:hover .ti-revert-badge-surface')
    expect(css).toContain('.ti-btn-revert-badge:focus-visible .ti-revert-badge-surface')
    expect(source).toMatch(/\.ti-btn-revert-badge\s*:\s*hover\s+\.mask-icon/)
    expect(source).toMatch(/\.ti-btn-revert-badge\s*:\s*focus-visible\s+\.mask-icon/)

    // Hover emphasis paints the surface (opaque light-neutral hover bg +
    // accent border + dark readable glyph — see contrast test below).
    const hoverRule = source.match(
      /\.ti-header-actions\s+\.ti-select-action\s+\.ti-btn-revert-badge\s*:\s*hover\s+\.ti-revert-badge-surface[^{]*\{([^}]*)\}/
    )
    expect(hoverRule).toBeTruthy()
    expect(hoverRule[1]).toContain('var(--toolbar-link-hover-bg-color)')
    expect(hoverRule[1]).toContain('var(--ti-action-icon-hover)')
    expect(hoverRule[1]).toContain('var(--ti-action-icon)')

    // Badge has its own focus-visible outline (shared .ti-toolbar-button
    // rule never matches — badge is not a .ti-toolbar-button).
    expect(source).toMatch(/\.ti-btn-revert-badge\s*:\s*focus-visible\s*\{[^}]*outline:/)

    // Select (and every header action) keeps the ordinary per-button hover.
    expect(css).toContain('.ti-header-toolbar .ti-toolbar-button:hover')
    // Select active bg stays per-button; Revert never gets it in the template.
    expect(css).toContain('.ti-header-toolbar .ti-toolbar-button.ti-active')
    const vueSource = readFileSync(resolve(here, 'PopupHeader.vue'), 'utf8')
    const badgeButton = vueSource.match(/class="ti-btn-revert-badge"[\s\S]*?<\/button>/)
    expect(badgeButton).toBeTruthy()
    expect(badgeButton[0]).not.toContain('ti-active')
    expect(badgeButton[0]).not.toContain('menuitem')
    expect(badgeButton[0]).not.toContain('ti-toolbar-button')
  })

  it('Revert hover/focus contrast: light opaque surface + dark glyph; dark keeps accent appearance', () => {
    const source = readFileSync(scssPath, 'utf8')
    const { css } = sass.compile(scssPath, { importers: scssImporters })

    // --- Light/default theme (the top-level rule, before the @at-root block) ---
    const lightRule = source.match(
      /\.ti-header-actions\s+\.ti-select-action\s+\.ti-btn-revert-badge\s*:\s*hover\s+\.ti-revert-badge-surface[^{]*\{([^}]*)\}/
    )
    expect(lightRule).toBeTruthy()
    // 1. Opaque light-neutral hover surface (verified token, not the
    //    translucent dark overlay that killed glyph contrast).
    expect(lightRule[1]).toContain('background-color: var(--toolbar-link-hover-bg-color) !important')
    expect(lightRule[1]).not.toContain('var(--ti-action-hover-bg)')
    // 2. Glyph color stays the dark action icon (readable on the light surface).
    expect(lightRule[1]).toContain('color: var(--ti-action-icon) !important')
    // 3. Accent border signals interaction.
    expect(lightRule[1]).toContain('border-color: var(--ti-action-icon-hover) !important')
    // Focus-visible shares the exact same declaration block as hover.
    const lightFocusRule = source.match(
      /\.ti-header-actions\s+\.ti-select-action\s+\.ti-btn-revert-badge\s*:\s*focus-visible\s+\.ti-revert-badge-surface[^{]*\{([^}]*)\}/
    )
    expect(lightFocusRule).toBeTruthy()
    expect(lightFocusRule[1]).toEqual(lightRule[1])

    // The verified token resolves to an OPAQUE light neutral in light theme
    // and a dark neutral in dark theme (_variables.scss theme roots).
    const variables = readFileSync(
      resolve(srcDir, 'assets/styles/base/_variables.scss'),
      'utf8'
    )
    expect(variables).toMatch(/--toolbar-link-hover-bg-color:\s*#e2e6ea;/)
    expect(variables).toMatch(/--toolbar-link-hover-bg-color:\s*#404040;/)

    // --- Dark theme (inside the existing reachable @at-root block) ---
    // Reachable compiled selector covers BOTH .theme-dark and .ti-dark-mode
    // hooks (never :global()).
    expect(css).toContain('.theme-dark .ti-header-toolbar .ti-select-action .ti-btn-revert-badge:hover .ti-revert-badge-surface')
    expect(css).toContain('.ti-dark-mode .ti-header-toolbar .ti-select-action .ti-btn-revert-badge:hover .ti-revert-badge-surface')
    expect(css).toContain('.theme-dark .ti-header-toolbar .ti-select-action .ti-btn-revert-badge:focus-visible .ti-revert-badge-surface')
    expect(css).not.toContain(':global(')

    // 4. Dark hover background reasserts the dark action hover token.
    const darkBlock = source.match(
      /@at-root\s+\.theme-dark\s+&,\s*\.ti-dark-mode\s+&\s*\{([\s\S]*?)\n\s*\}\s*\n\}/
    )
    expect(darkBlock).toBeTruthy()
    const darkBadgeRule = darkBlock[1].match(
      /\.ti-select-action\s+\.ti-btn-revert-badge\s*:\s*hover\s+\.ti-revert-badge-surface[^{]*\{([^}]*)\}/
    )
    expect(darkBadgeRule).toBeTruthy()
    expect(darkBadgeRule[1]).toContain('background-color: var(--ti-action-hover-bg) !important')
    // 5. Dark icon/border keep the accent appearance (visually unchanged).
    expect(darkBadgeRule[1]).toContain('border-color: var(--ti-action-icon-hover) !important')
    expect(darkBadgeRule[1]).toContain('color: var(--ti-action-icon-hover) !important')
    // Dark focus shares the same block as dark hover.
    const darkFocusRule = darkBlock[1].match(
      /\.ti-select-action\s+\.ti-btn-revert-badge\s*:\s*focus-visible\s+\.ti-revert-badge-surface[^{]*\{([^}]*)\}/
    )
    expect(darkFocusRule).toBeTruthy()
    expect(darkFocusRule[1]).toEqual(darkBadgeRule[1])
  })

  it('removes dead split-menu/chevron styling while keeping More-menu panel ownership', () => {
    const source = readFileSync(scssPath, 'utf8')

    // Dead Select-menu selectors are gone entirely.
    expect(source).not.toContain('.ti-btn-select-split-menu')
    expect(source).not.toContain('.ti-btn-select-chevron')
    expect(source).not.toContain('.ti-chevron-icon')
    // Old joined split-control selectors are gone with the badge redesign.
    expect(source).not.toContain('.ti-select-split')
    expect(source).not.toContain('.ti-revert-surface')
    expect(source).not.toContain('.ti-btn-revert ')
    // More-menu panel variable ownership and item styles survive.
    expect(source).toContain('.ti-btn-more-menu')
    expect(source).toMatch(/\.ti-btn-more-menu\s*\{/)
    expect(source).toContain('--tm-panel-background')
    expect(source).toContain('.ti-header-menu-item')
  })

  it('dark-theme rules remain reachable after the split redesign', () => {
    const source = readFileSync(scssPath, 'utf8')
    const { css } = sass.compile(scssPath, { importers: scssImporters })

    expect(source).toContain('.theme-dark &')
    expect(css).toContain('.theme-dark .ti-header-toolbar')
    expect(css).toContain('--ti-action-hover-bg: #424242')
    expect(css).toContain('--ti-action-active-bg: #555555')
  })

  it('Select action margin-inline-start remains 7px', () => {
    const source = readFileSync(scssPath, 'utf8')

    expect(source).toContain('margin-inline-start: 7px;')
  })

  it('focus-visible outline contract is intact', () => {
    const source = readFileSync(scssPath, 'utf8')

    expect(source).toContain('.ti-toolbar-button:focus-visible')
    expect(source).toContain('outline: 2px solid var(--color-primary, #1976d2)')
    expect(source).toContain('outline-offset: 1px')
  })

  it('More keeps text ellipsis (⋯), final font-size 20px, letter-spacing 1.5px, line-height 1', () => {
    const source = readFileSync(scssPath, 'utf8')

    // The .ti-btn-more block must declare the expected typography values.
    const moreBlock = source.match(/\.ti-btn-more\s*\{([\s\S]*?)\n\s*\}/)
    expect(moreBlock).toBeTruthy()
    expect(moreBlock[1]).toContain('font-size: 20px !important')
    expect(moreBlock[1]).toContain('letter-spacing: 1.5px !important')
    expect(moreBlock[1]).toContain('line-height: 1 !important')

    // The span inside must keep the 22×22 box.
    expect(moreBlock[1]).toContain('width: 22px !important')
    expect(moreBlock[1]).toContain('height: 22px !important')

    // The Vue template uses the real ⋯ character (U+22EF), not an SVG/img.
    const vuePath = resolve(here, 'PopupHeader.vue')
    const vueSource = readFileSync(vuePath, 'utf8')
    expect(vueSource).toContain('⋯')
    // More specifically: inside the .ti-btn-more button's span.
    expect(vueSource).toContain('<span aria-hidden="true">⋯</span>')
  })
})

/**
 * Regression tests after deleting legacy _popup.scss.
 * PopupHeader.scss is the sole owner of popup header appearance.
 * These pin the contracts that the legacy rules used to cover.
 */
describe('PopupHeader.scss legacy popup audit regression', () => {
  it('owns .ti-header-toolbar with row direction (legacy row-reverse is gone)', () => {
    const source = readFileSync(scssPath, 'utf8')

    // PopupHeader.scss must declare flex-direction: row on .ti-header-toolbar.
    const toolbarBlock = source.match(/\.ti-header-toolbar\s*\{([\s\S]*?)\/\*\s*Left group/)
    expect(toolbarBlock).toBeTruthy()
    expect(toolbarBlock[1]).toContain('flex-direction: row !important')
    // Legacy row-reverse must not exist anywhere in this file.
    expect(source).not.toContain('row-reverse')
  })

  it('does not contain any body.popup-context selector', () => {
    const source = readFileSync(scssPath, 'utf8')
    expect(source).not.toContain('body.popup-context')
  })

  it('does not contain a body.popup-context img.ti-toolbar-icon filter rule', () => {
    const source = readFileSync(scssPath, 'utf8')
    // The legacy _popup.scss had: body.popup-context img.ti-toolbar-icon { filter: var(--icon-filter) }
    // This was dead (no <img> in the popup carries ti-toolbar-icon).
    expect(source).not.toMatch(/body\.popup-context\s+img\.ti-toolbar-icon/)
    expect(source).not.toMatch(/img\.ti-toolbar-icon\s*\{[^}]*filter/)
  })

  it('MaskIcon stays currentColor-driven (no filter or invert applied to .mask-icon)', () => {
    const source = readFileSync(scssPath, 'utf8')

    // The .mask-icon rule inside .ti-header-toolbar must NOT apply filter or invert.
    const maskIconMatch = source.match(/&\s*\.mask-icon\s*\{([^}]*)\}/)
    expect(maskIconMatch).toBeTruthy()
    expect(maskIconMatch[1]).not.toMatch(/filter\s*:/)
    expect(maskIconMatch[1]).not.toContain('invert')
    // It must set opacity: 1 (fully opaque, currentColor fill).
    expect(maskIconMatch[1]).toContain('opacity: 1 !important')
  })

  it('does not contain the legacy _popup.scss ti-revert-icon rule', () => {
    const source = readFileSync(scssPath, 'utf8')
    // IconButton.scss owns .ti-revert-icon; PopupHeader.scss must not redefine it.
    expect(source).not.toMatch(/^\.ti-revert-icon\s*\{/m)
  })

  it('does not contain dead legacy selectors from _popup.scss', () => {
    const source = readFileSync(scssPath, 'utf8')
    // All of these were dead or redundant; none should appear in PopupHeader.scss.
    expect(source).not.toContain('.ti-popup-container')
    expect(source).not.toContain('.ti-toolbar-right-group')
    expect(source).not.toContain('.ti-toolbar-left-group')
    expect(source).not.toContain('.ti-result')
    expect(source).not.toContain('.ti-spinner-overlay')
    expect(source).not.toContain('.ti-spinner-center')
  })
})

/**
 * Dark-theme icon exemption for Page Translate: the branded Translate icon
 * must stay colorful (filter: none) while the monochrome Restore icon under
 * the SAME .ti-page-translate-btn root inherits the shared base rule and its
 * dark --icon-filter token. Real DOM chain (PageTranslationButton.vue):
 *   .ti-page-translate-btn (root) > .is-translate-btn / .is-restore-btn
 *   (BaseButton) > .ti-btn-status-container > img.toolbar-icon
 */
describe('PopupHeader.scss dark Page Translate icon exemption', () => {
  const variables = readFileSync(
    resolve(srcDir, 'assets/styles/base/_variables.scss'),
    'utf8'
  )
  const ptbScss = readFileSync(
    resolve(srcDir, 'features/page-translation/components/PageTranslationButton.scss'),
    'utf8'
  )
  const source = readFileSync(scssPath, 'utf8')
  // Strip /* ... */ before selector assertions: comment prose must never
  // leak into selector captures (documented regression pattern).
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const { css } = sass.compile(scssPath, { importers: scssImporters })

  it('narrows the exemption to .is-translate-btn (source + compiled, both theme hooks)', () => {
    expect(bare).toMatch(
      /\.ti-page-translate-btn\s+\.is-translate-btn\s+\.toolbar-icon\s*\{[^}]*filter:\s*none\s*!important/
    )
    // Compiled under both plain theme hooks — never :global().
    expect(css).not.toContain(':global(')
    expect(css).toMatch(
      /[^{}]*\.theme-dark[^{}]*\.ti-page-translate-btn\s+\.is-translate-btn\s+\.toolbar-icon[^{}]*\{[^{}]*filter:\s*none\s*!important/
    )
    expect(css).toMatch(
      /[^{}]*\.ti-dark-mode[^{}]*\.ti-page-translate-btn\s+\.is-translate-btn\s+\.toolbar-icon[^{}]*\{[^{}]*filter:\s*none\s*!important/
    )
  })

  it('removes the old broad exemptions (.ti-page-translate-btn img / .ti-toolbar-icon)', () => {
    expect(bare).not.toContain('.ti-page-translate-btn img')
    expect(bare).not.toContain('.ti-page-translate-btn .ti-toolbar-icon')
    expect(css).not.toMatch(/\.ti-page-translate-btn\s+img[^{}]*\{[^{}]*filter:\s*none/)
    expect(css).not.toMatch(/\.ti-page-translate-btn\s+\.ti-toolbar-icon[^{}]*\{[^{}]*filter:\s*none/)
  })

  it('Restore (.is-restore-btn) is not covered by any filter: none rule in PopupHeader', () => {
    const filterNoneRules = [...bare.matchAll(/([^{}]+)\{[^{}]*filter:\s*none/g)]
    expect(filterNoneRules.length).toBeGreaterThan(0)
    for (const m of filterNoneRules) {
      // Every filter: none rule must REQUIRE the Translate state class.
      expect(m[1]).toContain('.is-translate-btn')
      expect(m[1]).not.toContain('.is-restore-btn')
    }
    // Compiled side: no filter: none rule may mention the Restore class.
    for (const m of css.matchAll(/([^{}]+)\{[^{}]*filter:\s*none/g)) {
      expect(m[1]).not.toContain('is-restore-btn')
    }
  })

  it('Translate icon still receives filter: none (colorful brand icon preserved)', () => {
    expect(css).toContain(
      '.theme-dark .ti-header-toolbar .ti-page-translate-btn .is-translate-btn .toolbar-icon'
    )
    expect(css).toContain(
      '.ti-dark-mode .ti-header-toolbar .ti-page-translate-btn .is-translate-btn .toolbar-icon'
    )
    const rule = css.match(
      /[^{}]*\.ti-page-translate-btn\s+\.is-translate-btn\s+\.toolbar-icon[^{}]*\{[^{}]*\}/
    )
    expect(rule).toBeTruthy()
    expect(rule[0]).toMatch(/filter:\s*none\s*!important/)
    expect(rule[0]).toMatch(/opacity:\s*1\s*!important/)
  })

  it('shared PTB toolbar-icon base rule still uses filter: var(--icon-filter) !important', () => {
    expect(ptbScss).toMatch(
      /:where\(\.page-translation-controls\)\s+\.toolbar-icon[^{]*\{[^}]*filter:\s*var\(--icon-filter\)\s*!important/
    )
  })

  it('dark --icon-filter token still defined (invert outline for Restore)', () => {
    const darkIdx = variables.indexOf(':root.theme-dark')
    const filterIdx = variables.indexOf('--icon-filter: invert(92%) hue-rotate(180deg) brightness(150%) contrast(150%);')
    expect(darkIdx).toBeGreaterThan(-1)
    expect(filterIdx).toBeGreaterThan(darkIdx)
  })

  it('light-theme behavior unchanged (filter: none lives only inside the dark @at-root block)', () => {
    const atRootIdx = source.indexOf('@at-root .theme-dark')
    expect(atRootIdx).toBeGreaterThan(-1)
    const occurrences = [...source.matchAll(/filter:\s*none/g)]
    expect(occurrences).toHaveLength(1)
    expect(occurrences[0].index).toBeGreaterThan(atRootIdx)
    // Light token untouched: base rule resolves to filter: none anyway.
    expect(variables).toMatch(/--icon-filter:\s*none;/)
  })

  it('no Sidepanel selector modified (exemption requires the Popup-only marker)', () => {
    const filterNoneRules = [...bare.matchAll(/([^{}]+)\{[^{}]*filter:\s*none/g)]
    expect(filterNoneRules).toHaveLength(1)
    expect(filterNoneRules[0][1]).toContain('.ti-page-translate-btn')
    expect(filterNoneRules[0][1]).not.toMatch(/side-toolbar|sidepanel|ti-btn-sidepanel/i)
    // The shared PTB rule Sidepanel also consumes stays token-driven.
    expect(ptbScss).toMatch(
      /:where\(\.page-translation-controls\)\s+\.toolbar-icon[^{]*\{[^}]*filter:\s*var\(--icon-filter\)/
    )
  })
})

/**
 * More menu modernization: compact action menu owned entirely by
 * PopupHeader.scss. ToolbarMenu shared defaults must stay untouched so
 * other consumers (PDF toolbar, etc.) regress nowhere.
 */
describe('PopupHeader.scss More menu modernization', () => {
  const source = readFileSync(scssPath, 'utf8')
  // Strip /* ... */ before structural assertions: comment prose must
  // never leak into captures (documented regression pattern).
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const { css } = sass.compile(scssPath, { importers: scssImporters })
  const toolbarMenuScss = readFileSync(
    resolve(srcDir, 'components/base/ToolbarMenu/ToolbarMenu.scss'),
    'utf8'
  )

  it('scopes the panel polish to the Popup More menu boundary', () => {
    // PopupHeader-owned override lives under the .ti-btn-more-menu boundary
    // (with .ti-header-actions so custom properties beat ToolbarMenu's
    // scoped defaults on the same root element — see the SCSS comment).
    const panelBlock = bare.match(/\.ti-header-actions\s+\.ti-btn-more-menu\s*\{([^}]*)/)
    expect(panelBlock).toBeTruthy()
    expect(panelBlock[1]).toContain('--tm-panel-background')
    expect(panelBlock[1]).toContain('--tm-panel-border')
    // Panel padding declared only under that boundary…
    expect(panelBlock[1]).toMatch(/\.toolbar-menu__panel\s*\{[^}]*padding:\s*6px/)
    // …the shared panel stays unpadded for every other consumer…
    expect(toolbarMenuScss).not.toMatch(/\.toolbar-menu__panel\s*\{[^}]*padding/)
    // …and the compiled padding rule carries the Popup boundary.
    expect(css).toMatch(/\.ti-btn-more-menu\s+\.toolbar-menu__panel\s*\{[^}]*padding:\s*6px/)
  })

  it('pins panel radius, padding, and soft shadow with no hardcoded width', () => {
    const panelBlock = bare.match(/\.ti-header-actions\s+\.ti-btn-more-menu\s*\{([^}]*)/)
    expect(panelBlock).toBeTruthy()

    const radius = panelBlock[1].match(/--tm-panel-radius:\s*(\d+)px/)
    expect(radius).toBeTruthy()
    const radiusPx = parseInt(radius[1], 10)
    expect(radiusPx).toBeGreaterThanOrEqual(10)
    expect(radiusPx).toBeLessThanOrEqual(12)

    expect(panelBlock[1]).toMatch(/padding:\s*6px/)

    const shadow = panelBlock[1].match(/--tm-panel-shadow:\s*([^;]+);/)
    expect(shadow).toBeTruthy()
    // Soft professional shadow: two layers with light alphas.
    expect(shadow[1]).toMatch(/rgba\(0, 0, 0, 0\.12\)/)
    expect(shadow[1]).toMatch(/rgba\(0, 0, 0, 0\.08\)/)

    // No width that could break translated labels — viewport/max-inline-size
    // stays owned by ToolbarMenu.
    expect(panelBlock[1]).not.toMatch(/\bwidth\s*:/)
    expect(panelBlock[1]).not.toContain('inline-size')
  })

  it('pins menu item geometry (min-height, padding, gap, radius, 13px, nowrap)', () => {
    const itemBlock = bare.match(/\.ti-header-menu-item\s*\{([^}]*)/)
    expect(itemBlock).toBeTruthy()
    expect(itemBlock[1]).toContain('min-height: 36px')
    expect(itemBlock[1]).toContain('padding: 0 10px')
    expect(itemBlock[1]).toContain('gap: 10px')
    expect(itemBlock[1]).toContain('border-radius: 8px')
    expect(itemBlock[1]).toContain('width: 100%')
    expect(itemBlock[1]).toContain('font-size: 13px')
    expect(itemBlock[1]).toContain('white-space: nowrap')
    // Subtle background/color transition (not a blanket `all`).
    expect(itemBlock[1]).toMatch(/transition:\s*background-color 0\.15s ease, color 0\.15s ease/)
  })

  it('keeps branded menu images unfiltered in an 18×18 visual box', () => {
    const iconBlock = bare.match(/img,\s*\.mask-icon\s*\{([^}]*)\}/)
    expect(iconBlock).toBeTruthy()
    expect(iconBlock[1]).toContain('width: 18px')
    expect(iconBlock[1]).toContain('height: 18px')

    // No filter on ANY rule mentioning a menu item: branded Subtitle/PDF
    // <img> assets stay as-is (multicolor, ADR-001); MaskIcons stay
    // currentColor-driven.
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (m[1].includes('ti-header-menu-item')) {
        expect(m[2]).not.toMatch(/filter/)
      }
    }
    expect(bare).not.toMatch(/ti-header-menu-item[^{}]*filter/)
  })

  it('renders the Subtitle launcher as a multicolor <img>, not a MaskIcon', () => {
    const vueSource = readFileSync(resolve(here, 'PopupHeader.vue'), 'utf8')

    // Subtitle points at the SVG asset through the menu icon helper…
    expect(vueSource).toMatch(/<img[\s\S]*?menuIcon\('subtitle\.svg'\)[\s\S]*?>/)
    // …is decorative (the menu button owns the accessible name)…
    const subtitleImg = vueSource.match(/<img[\s\S]*?menuIcon\('subtitle\.svg'\)[\s\S]*?>/)
    expect(subtitleImg[0]).toContain('alt=""')
    expect(subtitleImg[0]).toContain('aria-hidden="true"')
    // …and no MaskIcon still references the Subtitle asset (multicolor,
    // ADR-001, same as the PDF launcher).
    for (const m of vueSource.matchAll(/<MaskIcon[\s\S]*?\/>/g)) {
      expect(m[0]).not.toContain('subtitle.svg')
    }
    // PDF launcher stays a branded <img> (structure unchanged).
    expect(vueSource).toMatch(/<img[\s\S]*?menuIcon\('pdf_viewer\/pdf\.png'\)/)
  })

  it('keeps the hover contracts reachable (light neutral, dark action tokens)', () => {
    // Light: subtle neutral overlay.
    expect(bare).toContain('rgba(0, 0, 0, 0.06) !important;')
    // Dark: reachable compiled selector + neutral bg + accent text.
    expect(css).toContain('.theme-dark .ti-header-toolbar .ti-header-menu-item:hover')
    expect(css).toContain('background-color: var(--ti-action-hover-bg, #424242) !important;')
    expect(css).toContain('color: var(--color-action-hover-accent) !important;')
  })

  it('preserves visible focus-visible on menu items', () => {
    expect(css).toMatch(
      /\.ti-header-menu-item:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-primary/
    )
    expect(css).toMatch(
      /\.ti-header-menu-item:focus-visible\s*\{[^}]*outline-offset:\s*-2px/
    )
  })

  it('styles the More trigger open state from [aria-expanded="true"] only', () => {
    const openRule = bare.match(/\.ti-btn-more\[aria-expanded="true"\]\s*\{([^}]*)/)
    expect(openRule).toBeTruthy()
    expect(openRule[1]).toContain('background-color: var(--ti-action-active-bg) !important;')
    expect(openRule[1]).toContain('color: var(--ti-action-icon-hover) !important;')
    // Reachable compiled selector (nested under the toolbar root).
    // Sass normalizes attribute quotes, so accept both `[x=true]` forms.
    expect(css).toMatch(/\.ti-header-toolbar \.ti-btn-more\[aria-expanded="?true"?\]/)
    // No invented component state on the trigger.
    expect(source).not.toMatch(/\.ti-btn-more\.(is-open|is-expanded|ti-active-open)/)
  })

  it('styles the separator and the CSS site indicator (legacy check class gone)', () => {
    const separator = bare.match(/\.ti-header-menu-separator\s*\{([^}]*)/)
    expect(separator).toBeTruthy()
    expect(separator[1]).toContain('height: 1px')
    expect(separator[1]).toContain('background-color: var(--header-border-color')

    const indicator = bare.match(/\.ti-header-menu-site-indicator\s*\{([^}]*)/)
    expect(indicator).toBeTruthy()
    expect(indicator[1]).toContain('width: 18px')
    expect(indicator[1]).toContain('height: 18px')
    expect(indicator[1]).toContain('border-radius: 5px')
    // Excluded state: accent fill + border-drawn CSS check (no glyph/asset).
    expect(source).toMatch(
      /\.ti-header-menu-site-indicator\s*\{[\s\S]*?&\.is-excluded\s*\{[\s\S]*?--color-primary[\s\S]*?&::after\s*\{[\s\S]*?border-width:\s*0 2px 2px 0/
    )
    // Legacy unicode checkbox class is gone entirely.
    expect(source).not.toContain('ti-header-menu-check')
  })

  it('preserves the CSS-only responsive routing breakpoints exactly', () => {
    // Base: both duplicate classes hidden by default (no duplicate
    // visible actions at any width).
    expect(bare).toMatch(
      /\.ti-header-menu-item--narrow-only,\s*\.ti-header-menu-item--very-narrow-only\s*\{[^}]*display:\s*none/
    )

    const m380 = source.match(/@media \(max-width: 380px\)\s*\{([\s\S]*?)\n\}/)
    expect(m380).toBeTruthy()
    expect(m380[1]).toContain('.ti-btn-capture.ti-header-toolbar-button--narrow-hide')
    expect(m380[1]).toContain('.ti-btn-sidepanel.ti-header-toolbar-button--narrow-hide')
    expect(m380[1]).toMatch(/\.ti-header-menu-item--narrow-only\s*\{[^}]*display:\s*flex/)

    const m340 = source.match(/@media \(max-width: 340px\)\s*\{([\s\S]*?)\n\}/)
    expect(m340).toBeTruthy()
    expect(m340[1]).toContain('.ti-btn-mouse-hover.ti-header-toolbar-button--narrow-hide')
    expect(m340[1]).toMatch(/\.ti-header-menu-item--very-narrow-only\s*\{[^}]*display:\s*flex/)
  })

  it('leaves shared ToolbarMenu defaults untouched (no other-consumer regression)', () => {
    expect(toolbarMenuScss).toContain('--tm-panel-background: transparent;')
    expect(toolbarMenuScss).toContain('--tm-panel-border: none;')
    expect(toolbarMenuScss).toContain('--tm-panel-radius: 14px;')
    expect(toolbarMenuScss).toContain('--tm-panel-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);')
    expect(toolbarMenuScss).not.toMatch(/\.toolbar-menu__panel\s*\{[^}]*padding/)
    // PopupHeader owns exactly one panel rule, always behind the
    // More-menu boundary — never an unscoped top-level panel selector.
    expect(source.match(/toolbar-menu__panel/g)).toHaveLength(1)
    expect(source).not.toMatch(/^\.toolbar-menu__panel/m)
  })
})
