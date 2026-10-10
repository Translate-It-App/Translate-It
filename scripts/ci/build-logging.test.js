import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BuildReporter } from '../shared/build-reporter.mjs'
import { formatDuration } from '../shared/box-utils.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = []
let tempDir

afterEach(() => {
  vi.restoreAllMocks()
  output.length = 0
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

function createAggregateWorkspace(version, children) {
  const workspace = path.join(tempDir, 'workspace')
  const buildDir = path.join(workspace, 'scripts', 'build')
  const sharedDir = path.join(workspace, 'scripts', 'shared')
  fs.mkdirSync(buildDir, { recursive: true })
  fs.mkdirSync(sharedDir, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'build-logging-test', version }))
  fs.copyFileSync(path.join(root, 'scripts', 'build', 'build-all.mjs'), path.join(buildDir, 'build-all.mjs'))
  fs.copyFileSync(path.join(root, 'scripts', 'shared', 'box-utils.mjs'), path.join(sharedDir, 'box-utils.mjs'))
  fs.writeFileSync(path.join(sharedDir, 'logger.mjs'), `export function logStep(message) { console.log(message) }\nexport function logError(message, details) { console.log(message); if (details) console.log(details) }\n`)
  for (const browser of ['chrome', 'firefox']) {
    const script = path.join(buildDir, `build-${browser}.mjs`)
    fs.writeFileSync(script, children[browser])
    if (!fs.existsSync(script)) throw new Error(`Missing aggregate child fixture: ${script}`)
  }
  return workspace
}

function runAggregate(workspace, extraEnv = {}) {
  for (const browser of ['chrome', 'firefox']) {
    if (!fs.existsSync(path.join(workspace, 'scripts', 'build', `build-${browser}.mjs`))) {
      throw new Error(`Missing aggregate child fixture for ${browser}`)
    }
  }
  return spawnSync(process.execPath, ['scripts/build/build-all.mjs', '--parallel'], {
    cwd: workspace,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
  })
}

describe('build terminal logging', () => {
  it.each([
    [0, '00:00'],
    [9000, '00:09'],
    [60000, '01:00'],
    [246800, '04:07'],
    [3600000, '60:00'],
  ])('formats %i milliseconds as %s', (milliseconds, expected) => {
    expect(formatDuration(milliseconds)).toBe(expected)
  })

  it('keeps intermediate rows neutral and reports measured sizes with one final browser success', () => {
    vi.spyOn(console, 'log').mockImplementation(value => output.push(String(value ?? '')))
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-logging-'))
    fs.writeFileSync(path.join(tempDir, 'popup.html'), 'abc')
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0).mockReturnValueOnce(246800).mockReturnValueOnce(246800)
      .mockReturnValueOnce(0).mockReturnValueOnce(246800).mockReturnValueOnce(246800)

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
      expect(rows[1]).toContain('(04:07)')
      expect(rows[1].startsWith('└─')).toBe(true)
      expect(rows.every(line => !line.includes('✅'))).toBe(true)
      expect(text).toContain('0.00 KB')
      expect(text).toContain(`${browser.toUpperCase()} BUILD SUCCESSFUL`)
      expect(text).toContain('⏱ Build completed in 04:07')
      expect((text.match(/✅/g) || [])).toHaveLength(1)
      expect(text).not.toContain('Manifest generation')
      expect(text).not.toContain('Optimized')
      expect(text).not.toContain('Compressed')
      expect(text).not.toContain('webpack')
      expect(text).not.toContain('submission')
    }
  })

  it('copies both browser ZIPs and reports aggregate MM:SS without generating release notes', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-logging-duration-'))
    const version = '0.0.0-logging-test'
    const zipScript = browser => `import fs from 'node:fs'; import path from 'node:path';\nconst version = '${version}';\nconst file = path.join('dist', '${browser}', 'Translate-It-v' + version + '.zip');\nfs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '${browser}-zip');\n`
    const workspace = createAggregateWorkspace(version, {
      chrome: zipScript('chrome'),
      firefox: zipScript('firefox'),
    })
    const preload = path.join(tempDir, 'mock-date.cjs')
    fs.writeFileSync(preload, `let calls = 0; Date.now = () => calls++ === 0 ? 0 : 246800;`)
    const result = runAggregate(workspace, {
      NODE_OPTIONS: `--require="${preload.replaceAll('\\', '/')}"`,
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`Chrome ZIP: dist/Publish/Translate-It-v${version}-for-Chrome.zip`)
    expect(result.stdout).toContain(`Firefox ZIP: dist/Publish/Translate-It-v${version}-for-Firefox.zip`)
    expect(result.stdout).toContain('⏱️ Total build time: 04:07')
    expect(result.stdout).not.toContain('Release notes:')
    expect(fs.readFileSync(path.join(workspace, 'dist', 'Publish', `Translate-It-v${version}-for-Chrome.zip`), 'utf8')).toBe('chrome-zip')
    expect(fs.readFileSync(path.join(workspace, 'dist', 'Publish', `Translate-It-v${version}-for-Firefox.zip`), 'utf8')).toBe('firefox-zip')
    expect(fs.existsSync(path.join(workspace, 'dist', 'Publish', 'release-notes.md'))).toBe(false)
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-logging-failure-'))
    const workspace = createAggregateWorkspace('0.0.0-logging-test', {
      chrome: `console.log('CHROME_CHILD_STDOUT'); console.error('CHROME_CHILD_STDERR');\n`,
      firefox: `console.log('FIREFOX_CHILD_STDOUT'); console.error('FIREFOX_CHILD_STDERR'); process.exitCode = 7;\n`,
    })
    const result = runAggregate(workspace)

    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('CHROME_CHILD_STDOUT')
    expect(result.stdout).toContain('FIREFOX_CHILD_STDOUT')
    expect(result.stderr).toContain('CHROME_CHILD_STDERR')
    expect(result.stderr).toContain('FIREFOX_CHILD_STDERR')
    expect(result.stdout).not.toContain('ALL BUILDS COMPLETED')
    expect(result.stdout).not.toContain('Creating publish packages')
    expect(fs.existsSync(path.join(workspace, 'dist', 'Publish'))).toBe(false)
  })

  it('fails the aggregate build when expected browser ZIPs are missing', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-logging-missing-'))
    const version = '0.0.0-logging-test'
    const workspace = createAggregateWorkspace(version, {
      chrome: `console.log('STUB_CHILD_OUTPUT');\n`,
      firefox: `console.log('STUB_CHILD_OUTPUT');\n`,
    })
    // Case 1: both browser ZIPs missing.
    let result = runAggregate(workspace)

    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('STUB_CHILD_OUTPUT')
    expect(result.stdout).toContain('Missing expected browser package')
    expect(result.stdout).not.toContain('ALL BUILDS COMPLETED')

    // Case 2: only the Firefox browser ZIP is missing.
    const chromeZip = path.join(workspace, 'dist', 'chrome', `Translate-It-v${version}.zip`)
    fs.mkdirSync(path.dirname(chromeZip), { recursive: true })
    fs.writeFileSync(chromeZip, 'fake-chrome-zip')
    result = runAggregate(workspace)

    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('Missing expected browser package')
    expect(result.stdout).toContain('firefox')
    expect(result.stdout).not.toContain('ALL BUILDS COMPLETED')
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
