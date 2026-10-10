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
  const workspace = path.join(tempDir, 'workspace with spaces')
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
    permissions: ['<all_urls>'],
  }))
  return { workspace, buildDir }
}

function installWebExt(workspace, { versionExit = 0, buildExit = 0 } = {}) {
  const packageDir = path.join(workspace, 'node_modules', 'web-ext')
  fs.mkdirSync(path.join(packageDir, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ bin: { 'web-ext': 'bin/web-ext.js' } }))
  fs.writeFileSync(path.join(packageDir, 'bin', 'web-ext.js'), `
import fs from 'node:fs'
import path from 'node:path'
if (process.argv[2] === '--version') {
  if (${versionExit}) { console.error('distinctive version failure'); process.exit(${versionExit}) }
  console.log('10.1.0')
} else {
  if (${buildExit}) { console.error('distinctive build stderr'); console.log('distinctive build stdout'); process.exit(${buildExit}) }
  const artifactArg = process.argv.find(arg => arg.startsWith('--artifacts-dir='))
  const zip = path.join(artifactArg.slice('--artifacts-dir='.length), 'fixture.zip')
  fs.writeFileSync(zip, 'fixture package')
  console.log('Your web extension is ready: ' + zip)
}
`)
}

function run(script, workspace, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: workspace,
    env: { ...process.env },
    encoding: 'utf8',
  })
}

function runAggregate(workspace, args = [], { failFirefox = false } = {}) {
  const preload = path.join(tempDir, 'aggregate-preload.cjs')
  const callsFile = path.join(tempDir, 'aggregate-calls.txt')
  fs.writeFileSync(preload, [
    "const childProcess = require('node:child_process')",
    "const { syncBuiltinESMExports } = require('node:module')",
    'const originalExecSync = childProcess.execSync',
    'childProcess.execSync = function (command, options) {',
    "  const commands = ['node scripts/validate/validate-chrome.mjs', 'node scripts/validate/validate-firefox.mjs', 'node scripts/validate/validate-firefox.mjs --verbose', 'node scripts/validate/validate-production-bundle.mjs']",
    '  if (!commands.includes(command)) return originalExecSync.call(this, command, options)',
    "  require('node:fs').appendFileSync(process.env.AGGREGATE_CALLS, command + '\\n')",
    "  if (process.env.AGGREGATE_FAIL_FIREFOX === '1' && command.startsWith('node scripts/validate/validate-firefox.mjs')) {",
    "    const error = new Error('mock Firefox validation failure')",
    '    error.status = 6',
    "    error.stdout = ''",
    "    error.stderr = ''",
    '    throw error',
    '  }',
    "  return options?.encoding ? '' : Buffer.alloc(0)",
    '}',
    'syncBuiltinESMExports()'
  ].join('\n'))
  return spawnSync(process.execPath, ['--require', preload, 'scripts/validate/validate-all.mjs', ...args], {
    cwd: workspace,
    env: {
      ...process.env,
      AGGREGATE_CALLS: callsFile,
      AGGREGATE_FAIL_FIREFOX: failFirefox ? '1' : '0'
    },
    encoding: 'utf8'
  })
}

describe('validation output', () => {
  it('keeps Chrome intermediate rows neutral and reports one final status without store claims', () => {
    const { workspace } = createWorkspace()
    installWebExt(workspace)

    const result = run('scripts/validate/validate-chrome.mjs', workspace)
    const text = result.stdout + result.stderr
    expect(result.status).toBe(0)
    expect(text).toContain('ℹ  Chrome build directory found')
    expect(text).not.toContain('├─ Chrome build directory found')
    expect(text).toContain('Path: ')
    expect(text).toContain('Manifest Version: V3')
    expect(text).toContain('├─   Service worker correctly configured for Manifest V3')
    expect(text).toContain('├─   Uses <all_urls> permission (required for translation)')
    expect(text).not.toContain('├─   ℹ️')
    expect(text).toContain('└─ Manifest validation completed\n')
    expect(text).toContain('└─ Cross-browser validation completed\n')
    expect(text).toContain('└─ Chrome analysis completed\n')
    expect(text).toContain('└─ Package size within limits\n')
    expect(text).toContain('├─ PACKAGE STATISTICS:')
    expect(text).toContain('Size Limit:  128 MB (Chrome Web Store)')
    expect(text).toContain('Status: ✅ PASSED')
    expect(text).toContain('Errors:     0')
    expect(text).toContain('Warnings:   0')
    expect(text).toContain('Notices:    0')
    expect(text).toContain('Total Files: 1')
    expect(text.match(/✅/g)).toHaveLength(1)
    expect(text).not.toContain('├─ ✅')
    expect(text).not.toContain('Ready for Web Store')
    expect(text).not.toContain('submission')
  })

  it('fails when web-ext is available but its validation command fails', () => {
    const { workspace } = createWorkspace()
    installWebExt(workspace, { buildExit: 9 })

    const result = run('scripts/validate/validate-chrome.mjs', workspace)
    const text = result.stdout + result.stderr
    expect(result.status).not.toBe(0)
    expect(text).toContain('web-ext validation failed')
    expect(text).toContain('Status: ❌ FAILED')
    expect(text).not.toContain('Status: ✅ PASSED')
    expect(text).toContain('distinctive build stderr')
    expect(text).toContain('distinctive build stdout')
  })

  it('warns and skips web-ext only when the optional package is missing', () => {
    const { workspace } = createWorkspace()

    const result = run('scripts/validate/validate-chrome.mjs', workspace)
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
    installWebExt(workspace, { versionExit: 9 })

    const result = run('scripts/validate/validate-chrome.mjs', workspace)
    const text = result.stdout + result.stderr
    expect(result.status).not.toBe(0)
    expect(text).toContain('❌ web-ext availability check failed')
    expect(text).not.toContain('web-ext not found')
    expect(text).toContain('Errors:     1')
    expect(text).toContain('Warnings:   0')
    expect(text).toContain('Status: ❌ FAILED')
    expect(text).not.toContain('✅ Chrome validation passed')
    expect(text).toContain('distinctive version failure')
  })

  it('reports aggregate success without redundant per-stage success lines', () => {
    const { workspace } = createWorkspace()

    const result = runAggregate(workspace)
    const text = result.stdout + result.stderr
    expect(result.status).toBe(0)
    expect(text).toContain('✅ ALL VALIDATIONS PASSED')
    expect(text).toContain('Total validation time: ')
    expect(text).not.toContain('Chrome validation completed successfully')
    expect(text).not.toContain('Firefox validation completed successfully')
    expect(text).not.toContain('Production bundle validation completed successfully')
  })

  it('forwards --verbose to the Firefox validator only', () => {
    const { workspace } = createWorkspace()

    const result = runAggregate(workspace, ['--verbose'])
    expect(result.status).toBe(0)
    const invocations = fs.readFileSync(path.join(tempDir, 'aggregate-calls.txt'), 'utf8')
    expect(invocations).toContain('scripts/validate/validate-firefox.mjs --verbose')
    expect(invocations).not.toContain('scripts/validate/validate-chrome.mjs --verbose')
    expect(invocations).not.toContain('scripts/validate/validate-production-bundle.mjs --verbose')
  })

  it('propagates aggregate failures with actionable diagnostics and duration', () => {
    const { workspace } = createWorkspace()

    const result = runAggregate(workspace, [], { failFirefox: true })
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
