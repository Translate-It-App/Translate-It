import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
let tempDir

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

function createWorkspace() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-output-'))
  const workspace = path.join(tempDir, 'workspace')
  fs.mkdirSync(path.join(workspace, 'scripts', 'validate'), { recursive: true })
  fs.mkdirSync(path.join(workspace, 'scripts', 'shared'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'translate-it', version: '1.0.0' }))
  fs.writeFileSync(path.join(workspace, 'scripts', 'shared', 'logger.mjs'), `
export const logStep = message => console.log(message)
export const logSuccess = message => console.log('✅ ' + message)
export const logError = message => console.log('❌ ' + message)
export const logInfo = message => console.log('ℹ  ' + message)
`)
  fs.writeFileSync(path.join(workspace, 'scripts', 'shared', 'box-utils.mjs'), `
export const createBox = value => value
export const createErrorBox = value => value
export const centerText = value => value
export const emptyBoxLine = () => ''
export const formatPackageSize = value => String(value)
export const formatFileSize = value => String(value)
`)
  for (const file of ['validate-chrome.mjs', 'validate-all.mjs', 'validate-production-bundle.mjs']) {
    fs.copyFileSync(path.join(root, 'scripts', 'validate', file), path.join(workspace, 'scripts', 'validate', file))
  }
  const buildDir = path.join(workspace, 'dist', 'chrome', 'Translate-It-v1.0.0')
  fs.mkdirSync(buildDir, { recursive: true })
  fs.writeFileSync(path.join(buildDir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Translate It',
    version: '1.0.0',
    description: 'Fixture extension',
    background: { service_worker: 'worker.js' },
  }))
  return { workspace, buildDir }
}

function installWebExt(bin, { available = true, versionExit = 0, buildExit = 0 } = {}) {
  fs.mkdirSync(bin, { recursive: true })
  if (!available) return
  fs.writeFileSync(path.join(bin, 'web-ext'), `#!/bin/sh
if [ "$1" = "--version" ]; then exit ${versionExit}; fi
if [ ${buildExit} -ne 0 ]; then printf 'web-ext executed and failed\n' >&2; exit ${buildExit}; fi
printf 'web-ext executed successfully\n'
`, { mode: 0o755 })
}

function run(script, workspace, bin) {
  return spawnSync(process.execPath, [script], {
    cwd: workspace,
    env: { ...process.env, PATH: bin },
    encoding: 'utf8',
  })
}

describe('validation output', () => {
  it('keeps Chrome intermediate rows neutral and reports one final status without store claims', () => {
    const { workspace } = createWorkspace()
    const bin = path.join(tempDir, 'bin')
    installWebExt(bin)

    const result = run('scripts/validate/validate-chrome.mjs', workspace, bin)
    const text = result.stdout + result.stderr
    expect(result.status).toBe(0)
    expect(text).toContain('ℹ  Chrome build directory found')
    expect(text).not.toContain('├─ Chrome build directory found')
    expect(text).toContain('Path: ')
    expect(text).toContain('Manifest Version: V3')
    expect(text).toContain('Total Files: 1')
    expect(text).toContain('Status: ✅ PASSED')
    expect(text.match(/✅/g)).toHaveLength(1)
    expect(text).not.toContain('├─ ✅')
    expect(text).not.toContain('Ready for Web Store')
    expect(text).not.toContain('submission')
  })

  it('fails when web-ext is available but its validation command fails', () => {
    const { workspace } = createWorkspace()
    const bin = path.join(tempDir, 'bin')
    installWebExt(bin, { buildExit: 9 })

    const result = run('scripts/validate/validate-chrome.mjs', workspace, bin)
    const text = result.stdout + result.stderr
    expect(result.status).not.toBe(0)
    expect(text).toContain('web-ext validation failed')
    expect(text).toContain('Status: ❌ FAILED')
    expect(text).not.toContain('Status: ✅ PASSED')
  })

  it('warns and skips web-ext only when the executable is unavailable', () => {
    const { workspace } = createWorkspace()
    const bin = path.join(tempDir, 'bin')
    installWebExt(bin, { available: false })

    const result = run('scripts/validate/validate-chrome.mjs', workspace, bin)
    const text = result.stdout + result.stderr
    expect(result.status).toBe(0)
    expect(text).toContain('web-ext not found')
    expect(text).not.toContain('web-ext validation passed')
    expect(text).toContain('⚠️  web-ext not found')
    expect(text).toContain('Errors:     0')
    expect(text).toContain('Warnings:   1')
    expect(text).toContain('Status: ✅ PASSED')
    expect(text).not.toContain('✅ Chrome validation passed')
  })

  it('counts a present web-ext that fails its version check as an error', () => {
    const { workspace } = createWorkspace()
    const bin = path.join(tempDir, 'bin')
    installWebExt(bin, { versionExit: 9 })

    const result = run('scripts/validate/validate-chrome.mjs', workspace, bin)
    const text = result.stdout + result.stderr
    expect(result.status).not.toBe(0)
    expect(text).toContain('❌ web-ext availability check failed')
    expect(text).not.toContain('web-ext not found')
    expect(text).toContain('Errors:     1')
    expect(text).toContain('Warnings:   0')
    expect(text).toContain('Status: ❌ FAILED')
    expect(text).not.toContain('✅ Chrome validation passed')
  })

  it('reports aggregate success without redundant per-stage success lines', () => {
    const { workspace } = createWorkspace()
    const bin = path.join(tempDir, 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh
exit 0
`, { mode: 0o755 })

    const result = run('scripts/validate/validate-all.mjs', workspace, bin)
    const text = result.stdout + result.stderr
    expect(result.status).toBe(0)
    expect(text).toContain('✅ ALL VALIDATIONS PASSED')
    expect(text).toContain('Total validation time: ')
    expect(text).not.toContain('Chrome validation completed successfully')
    expect(text).not.toContain('Firefox validation completed successfully')
    expect(text).not.toContain('Production bundle validation completed successfully')
  })

  it('propagates aggregate failures with actionable diagnostics and duration', () => {
    const { workspace } = createWorkspace()
    const bin = path.join(tempDir, 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh
case "$1" in
  scripts/validate/validate-chrome.mjs) exit 0 ;;
  scripts/validate/validate-firefox.mjs) exit 6 ;;
  scripts/validate/validate-production-bundle.mjs) exit 0 ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 })

    const result = run('scripts/validate/validate-all.mjs', workspace, bin)
    const text = result.stdout + result.stderr
    expect(result.status).not.toBe(0)
    expect(text).toContain('Firefox validation failed')
    expect(text).toContain('❌ VALIDATION FAILED')
    expect(text).toContain('Please fix the issues above and re-run validation.')
    expect(text).not.toContain('Chrome validation completed successfully')
    expect(text).not.toContain('Production bundle validation completed successfully')
    expect(text).not.toContain('ALL VALIDATIONS PASSED')
    expect(text).not.toContain('Ready for')
  })
})
