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
    expect(css).toMatch(/outline:\s*3px solid #ff8800/)
    expect(css).toMatch(/outline-offset:\s*2px/)
    expect(css).toMatch(/box-shadow:\s*0 0 10px/)
  })

  it('does not declare page-root highlight tokens', () => {
    const css = compile()
    expect(css).not.toMatch(/:root\s*\{/)
    expect(css).not.toMatch(/--translate-highlight-(color|width|offset)/)
  })

  it('scopes class and attribute highlights to active Select Element mode', () => {
    const css = compile()
    expect(css).toMatch(/html\[data-translate-it-select-mode=true\]\s+body\s+\[data-translate-highlighted=true\]/)
    expect(css).toMatch(/html\[data-translate-it-select-mode=true\]\s+body\s+\.translate-it-element-highlighted/)
    expect(css).not.toMatch(/(^|\n)html body (\[data-translate-highlighted="true"\]|\.translate-it-element-highlighted)/)
  })

  it('does not match colliding website markers while inactive and activates both markers with the root flag', () => {
    const root = document.documentElement
    const previousMode = root.getAttribute('data-translate-it-select-mode')
    const classMarker = document.createElement('div')
    classMarker.className = 'translate-it-element-highlighted'
    const attributeMarker = document.createElement('div')
    attributeMarker.setAttribute('data-translate-highlighted', 'true')
    document.body.append(classMarker, attributeMarker)
    root.removeAttribute('data-translate-it-select-mode')
    const classSelector = 'html[data-translate-it-select-mode=true] body .translate-it-element-highlighted'
    const attributeSelector = 'html[data-translate-it-select-mode=true] body [data-translate-highlighted=true]'

    expect(classMarker.matches(classSelector)).toBe(false)
    expect(attributeMarker.matches(attributeSelector)).toBe(false)
    root.setAttribute('data-translate-it-select-mode', 'true')
    expect(classMarker.matches(classSelector)).toBe(true)
    expect(attributeMarker.matches(attributeSelector)).toBe(true)
    root.removeAttribute('data-translate-it-select-mode')
    expect(classMarker.matches(classSelector)).toBe(false)

    classMarker.remove()
    attributeMarker.remove()
    if (previousMode !== null) root.setAttribute('data-translate-it-select-mode', previousMode)
  })

  it('keeps the select-mode crosshair cursor', () => {
    expect(compile()).toMatch(/cursor:\s*crosshair/)
  })

  it('leaves website highlight variables intact when the cached CSS is injected', () => {
    const root = document.documentElement
    const websiteStyle = document.createElement('style')
    websiteStyle.textContent = ':root { --translate-highlight-color: rgb(1, 2, 3); --translate-highlight-width: 11px; --translate-highlight-offset: 9px; }'
    const extensionStyle = document.createElement('style')
    extensionStyle.textContent = compile()

    try {
      document.head.append(websiteStyle)
      const token = (name) => getComputedStyle(root).getPropertyValue(name).replace(/\s/g, '')
      const before = ['--translate-highlight-color', '--translate-highlight-width', '--translate-highlight-offset'].map(token)

      expect(before).toEqual(['rgb(1,2,3)', '11px', '9px'])
      document.head.append(extensionStyle)
      expect(['--translate-highlight-color', '--translate-highlight-width', '--translate-highlight-offset'].map(token)).toEqual(before)
    } finally {
      websiteStyle.remove()
      extensionStyle.remove()
    }
  })
})
