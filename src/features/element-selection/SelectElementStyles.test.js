import { describe, expect, it } from 'vitest'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as sass from 'sass'

const here = dirname(fileURLToPath(import.meta.url))
const scssPath = resolve(here, 'SelectElement.scss')

/**
 * SelectElement.scss is injected into the host page (Main DOM) by
 * SelectElementManager._ensureStylesInjected() via
 * ContentScriptCore.injectMainDOMStyles(). Because it styles host-page
 * elements, it must stay paint-only: no `position`/`z-index`, otherwise the
 * highlighted element's positioning, stacking context, containing block and
 * hit testing are altered by the extension.
 */
describe('SelectElement.scss host-page safety contract', () => {
  const compile = () => sass.compile(scssPath).css

  it('emits no position declaration (host layout must not change)', () => {
    expect(compile()).not.toMatch(/position:/)
  })

  it('emits no z-index declaration (host stacking must not change)', () => {
    expect(compile()).not.toMatch(/z-index:/)
  })

  it('keeps the highlight visual hierarchy (outline + glow)', () => {
    const css = compile()
    expect(css).toMatch(/outline:\s*var\(--translate-highlight-width\)/)
    expect(css).toMatch(/outline-offset:\s*var\(--translate-highlight-offset\)/)
    expect(css).toMatch(/box-shadow:\s*0 0 10px/)
  })

  it('keeps the select-mode crosshair cursor', () => {
    expect(compile()).toMatch(/cursor:\s*crosshair/)
  })
})
