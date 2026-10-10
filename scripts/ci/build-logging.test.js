import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BuildReporter } from '../shared/build-reporter.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = []
let tempDir

afterEach(() => {
  vi.restoreAllMocks()
  output.length = 0
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

describe('build terminal logging', () => {
  it('keeps intermediate rows neutral and reports measured sizes with one final browser success', () => {
    vi.spyOn(console, 'log').mockImplementation(value => output.push(String(value ?? '')))
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-logging-'))
    fs.writeFileSync(path.join(tempDir, 'popup.html'), 'abc')
    vi.spyOn(Date, 'now').mockReturnValue(1500)

    for (const browser of ['chrome', 'firefox']) {
      output.length = 0
      const reporter = new BuildReporter(browser)
      reporter.start()
      reporter.logBuildStep('Vite compilation...', 'in-progress')
      reporter.logBuildStep('Vite compilation...', 'completed')
      const stats = reporter.analyzeBuild(tempDir)
      reporter.success(stats)
      const rows = output.filter(line => line.includes('Vite compilation'))
      const text = output.join('\n')

      expect(stats).toEqual({ totalSize: 3, fileCount: 1 })
      expect(text).toContain(`dist/${browser}/Translate-It-v`)
      expect(rows[0]).toContain('⚡ Vite compilation')
      expect(rows[0].startsWith('├─')).toBe(true)
      expect(rows[1]).toContain('· Vite compilation')
      expect(rows[1]).toContain('(0.0s)')
      expect(rows[1].startsWith('└─')).toBe(true)
      expect(rows.every(line => !line.includes('✅'))).toBe(true)
      expect(text).toContain('0.00 KB')
      expect(text).toContain(`${browser.toUpperCase()} BUILD SUCCESSFUL`)
      expect((text.match(/✅/g) || [])).toHaveLength(1)
      expect(text).not.toContain('Manifest generation')
      expect(text).not.toContain('Optimized')
      expect(text).not.toContain('Compressed')
      expect(text).not.toContain('webpack')
      expect(text).not.toContain('submission')
    }
  })

  it('reports configuration without a hardcoded Vue version', () => {
    vi.spyOn(console, 'log').mockImplementation(value => output.push(String(value ?? '')))
    const reporter = new BuildReporter('chrome')
    reporter.start()
    const text = output.join('\n')

    expect(text).toContain('Browser')
    expect(text).toContain('Output Directory')
    expect(text).toContain('Build Mode')
    expect(text).not.toContain('Vue Version')
    expect(text).not.toContain('3.5.18')
  })

  it('reports failed steps and build errors without a success message', () => {
    vi.spyOn(console, 'log').mockImplementation(value => output.push(String(value ?? '')))
    const reporter = new BuildReporter('chrome')

    reporter.logBuildStep('Vite compilation...', 'failed')
    reporter.error('Vite exited with status 1')
    const text = output.join('\n')

    expect(text).toContain('❌ Vite compilation')
    expect(text).toContain('CHROME BUILD FAILED')
    expect(text).toContain('Error: Vite exited with status 1')
    expect(text).not.toContain('BUILD SUCCESSFUL')
  })

  it('prints both parallel child diagnostics before failing without generating publish artifacts', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-logging-bin-'))
    const stubNode = path.join(tempDir, 'node')
    fs.writeFileSync(stubNode, `#!/bin/sh
case "$1" in
  scripts/build/build-chrome.mjs) printf 'CHROME_CHILD_STDOUT\\n'; printf 'CHROME_CHILD_STDERR\\n' >&2; exit 0 ;;
  scripts/build/build-firefox.mjs) printf 'FIREFOX_CHILD_STDOUT\\n'; printf 'FIREFOX_CHILD_STDERR\\n' >&2; exit 7 ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 })
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
    const artifactPaths = [
      `dist/Publish/Translate-It-v${version}-for-Chrome.zip`,
      `dist/Publish/Translate-It-v${version}-for-Firefox.zip`,
      'dist/Publish/release-notes.md',
    ].map(relativePath => path.join(root, relativePath))
    const before = artifactPaths.map(file => fs.existsSync(file))
    const result = spawnSync(process.execPath, ['scripts/build/build-all.mjs', '--parallel'], {
      cwd: root,
      env: { ...process.env, PATH: `${tempDir}${path.delimiter}${process.env.PATH}` },
      encoding: 'utf8',
    })

    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('CHROME_CHILD_STDOUT')
    expect(result.stdout).toContain('FIREFOX_CHILD_STDOUT')
    expect(result.stderr).toContain('CHROME_CHILD_STDERR')
    expect(result.stderr).toContain('FIREFOX_CHILD_STDERR')
    expect(result.stdout).not.toContain('ALL BUILDS COMPLETED')
    expect(result.stdout).not.toContain('Creating publish packages')
    expect(artifactPaths.map(file => fs.existsSync(file))).toEqual(before)
  })

  it('fails the aggregate build when expected browser ZIPs are missing', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-logging-missing-'))
    const workspace = path.join(tempDir, 'workspace')
    const bin = path.join(tempDir, 'bin')
    fs.mkdirSync(path.join(workspace, 'scripts', 'build'), { recursive: true })
    fs.mkdirSync(path.join(workspace, 'scripts', 'shared'), { recursive: true })
    fs.mkdirSync(bin, { recursive: true })

    const version = '0.0.0-logging-test'
    fs.writeFileSync(
      path.join(workspace, 'package.json'),
      JSON.stringify({ name: 'build-logging-test', version })
    )
    fs.copyFileSync(
      path.join(root, 'scripts', 'build', 'build-all.mjs'),
      path.join(workspace, 'scripts', 'build', 'build-all.mjs')
    )
    fs.writeFileSync(
      path.join(workspace, 'scripts', 'shared', 'logger.mjs'),
      `export function logStep(message) { console.log(message) }\nexport function logError(message, details) { console.log(message); if (details) console.log(details) }\n`
    )
    fs.writeFileSync(
      path.join(workspace, 'scripts', 'shared', 'box-utils.mjs'),
      `export function centerText(value) { return String(value) }\nexport function createBox(value) { return String(value) }\nexport function createSuccessBox(value) { return String(value) }\nexport function createErrorBox(value) { return String(value) }\n`
    )
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh
printf 'STUB_CHILD_OUTPUT\\n'
exit 0
`, { mode: 0o755 })

    const runAggregate = () => spawnSync(process.execPath, ['scripts/build/build-all.mjs', '--parallel'], {
      cwd: workspace,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      encoding: 'utf8',
    })
    const releaseNotes = path.join(workspace, 'dist', 'Publish', 'release-notes.md')

    // Case 1: both browser ZIPs missing.
    let result = runAggregate()

    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('STUB_CHILD_OUTPUT')
    expect(result.stdout).toContain('Missing expected browser package')
    expect(result.stdout).not.toContain('ALL BUILDS COMPLETED')
    expect(fs.existsSync(releaseNotes)).toBe(false)

    // Case 2: only the Firefox browser ZIP is missing.
    const chromeZip = path.join(workspace, 'dist', 'chrome', `Translate-It-v${version}.zip`)
    fs.mkdirSync(path.dirname(chromeZip), { recursive: true })
    fs.writeFileSync(chromeZip, 'fake-chrome-zip')
    result = runAggregate()

    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('Missing expected browser package')
    expect(result.stdout).toContain('firefox')
    expect(result.stdout).not.toContain('ALL BUILDS COMPLETED')
    expect(fs.existsSync(releaseNotes)).toBe(false)
  })

  it('uses consistent ZIP progress wording and a single aggregate success heading', () => {
    const chrome = fs.readFileSync(path.join(root, 'scripts/build/build-chrome.mjs'), 'utf8')
    const firefox = fs.readFileSync(path.join(root, 'scripts/build/build-firefox.mjs'), 'utf8')
    const aggregate = fs.readFileSync(path.join(root, 'scripts/build/build-all.mjs'), 'utf8')

    expect(chrome).toContain('ZIP created: ${CHROME_ZIP_PATH} (${sizeStr})')
    expect(firefox).toContain('ZIP created: ${FIREFOX_ZIP_PATH} (${sizeStr})')
    expect(chrome).not.toContain('build completed successfully')
    expect(firefox).not.toContain('build completed successfully')
    expect(aggregate).toContain("centerText('✅ ALL BUILDS COMPLETED')")
    expect(aggregate).toContain('if (chromeCopied)')
    expect(aggregate).toContain('if (firefoxCopied)')
    expect(aggregate).not.toContain('✅ Chrome ZIP')
    expect(aggregate).not.toContain('✅ Firefox ZIP')
    expect(aggregate).not.toContain('Ready for Web Store submission')
  })
})
