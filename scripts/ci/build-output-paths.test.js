import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import buildOutputPaths from '../shared/build-output-paths.cjs'
import { runAndroid } from '../dev/android-runner.mjs'

const root = resolve(import.meta.dirname, '../..')
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const artifactPrefix = 'Translate-It'
const version = packageJson.version

/**
 * Import a browser Vite config with a controlled environment. The config
 * resolves its output directory while the module is evaluated, so the module
 * registry must be reset between environments.
 */
async function loadBrowserConfig(browser, env) {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    VITE_WATCH_MODE: process.env.VITE_WATCH_MODE,
  }

  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }

    const webExtension = vi.fn(options => ({ name: 'mock-web-extension', options }))
    vi.resetModules()
    vi.doMock('vite-plugin-web-extension', () => ({ default: webExtension }))

    const configUrl = new URL(`../../config/vite/vite.config.${browser}.js`, import.meta.url).href
    const { default: config } = await import(/* @vite-ignore */ configUrl)
    const plugin = config.plugins.find(candidate => candidate.name === 'mock-web-extension')

    return { config, plugin: plugin.options }
  } finally {
    vi.doUnmock('vite-plugin-web-extension')
    vi.resetModules()
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('build output paths', () => {
  it('separates development and production output directories', () => {
    const production = buildOutputPaths.getBuildOutputDir({ browser: 'firefox', version, artifactPrefix, production: true })
    const development = buildOutputPaths.getBuildOutputDir({ browser: 'firefox', version, artifactPrefix, production: false })

    expect(production).toBe(`dist/firefox/${artifactPrefix}-v${version}`)
    expect(development).toBe(`dist/dev/firefox/${artifactPrefix}-v${version}`)
    expect(development).not.toBe(production)
  })

  it.each(['chrome', 'firefox'])('writes %s production builds to the release directory', async browser => {
    const { config } = await loadBrowserConfig(browser, { NODE_ENV: 'production', VITE_WATCH_MODE: undefined })

    expect(config.build.outDir).toBe(`dist/${browser}/${artifactPrefix}-v${version}`)
  })

  it.each(['chrome', 'firefox'])('writes %s development builds to the development directory', async browser => {
    const { config } = await loadBrowserConfig(browser, { NODE_ENV: 'development', VITE_WATCH_MODE: undefined })

    expect(config.build.outDir).toBe(`dist/dev/${browser}/${artifactPrefix}-v${version}`)
  })

  it.each(['chrome', 'firefox'])('keeps %s child builds in the same directory as the parent build', async browser => {
    const { config, plugin } = await loadBrowserConfig(browser, { NODE_ENV: 'development', VITE_WATCH_MODE: undefined })

    expect(config.build.outDir).toBe(`dist/dev/${browser}/${artifactPrefix}-v${version}`)
    expect(plugin.htmlViteConfig.build.outDir).toBe(config.build.outDir)
    expect(plugin.scriptViteConfig.build.outDir).toBe(config.build.outDir)
  })

  it.each(['chrome', 'firefox'])('keeps %s watch builds in the development directory', async browser => {
    const { config } = await loadBrowserConfig(browser, { NODE_ENV: 'development', VITE_WATCH_MODE: 'true' })

    expect(config.build.outDir).toBe(`dist/dev/${browser}/${artifactPrefix}-v${version}`)
  })

  it.each([
    ['chrome', { NODE_ENV: 'production', VITE_WATCH_MODE: undefined }],
    ['chrome', { NODE_ENV: 'development', VITE_WATCH_MODE: undefined }],
    ['chrome', { NODE_ENV: 'development', VITE_WATCH_MODE: 'true' }],
    ['firefox', { NODE_ENV: 'production', VITE_WATCH_MODE: undefined }],
    ['firefox', { NODE_ENV: 'development', VITE_WATCH_MODE: undefined }],
    ['firefox', { NODE_ENV: 'development', VITE_WATCH_MODE: 'true' }],
  ])('routes %s output by whether the build is minified', async (browser, env) => {
    const { config } = await loadBrowserConfig(browser, env)
    const isMinified = config.build.minify === 'terser'
    const isProductionDir = config.build.outDir.startsWith('dist/') && !config.build.outDir.startsWith('dist/dev/')

    // A minified bundle must never share a directory with unminified output,
    // otherwise a development build can overwrite the release bundle.
    expect(isProductionDir).toBe(isMinified)
  })

  it('deploys the development Firefox output in the Android runner', async () => {
    const { config } = await loadBrowserConfig('firefox', { NODE_ENV: 'development', VITE_WATCH_MODE: undefined })
    const calls = []

    const status = await runAndroid({
      args: ['--device=cli-device'],
      env: {},
      root: '/tmp/android-runner-test',
      packageInfo: { version },
      exists: () => true,
      exec: command => {
        calls.push(command)
        return ''
      },
    })

    expect(status).toBe(0)
    expect(calls.some(command => command.includes(`--source-dir "${config.build.outDir}"`))).toBe(true)
  })
})
