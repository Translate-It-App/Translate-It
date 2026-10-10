import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'scripts/validate/firefox-known-warnings.json'), 'utf8'))
const tempDirs = []

afterEach(() => tempDirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })))

function warning({ code, message, file }) {
  return { _type: 'warning', code, message, description: 'fixture', column: 1, file, line: 1 }
}

function fixtureWarnings(entries = baseline) {
  return entries.flatMap(entry => Array.from({ length: entry.count }, () => warning({
    code: entry.code,
    message: entry.messagePrefix + (entry.messagePrefix.startsWith('Error in no-unsanitized') ? ' https://example.invalid/versioned-suffix' : ''),
    file: entry.file
  })))
}

function run(warnings, { errors = 0, notices = 0, raw, errorCodes, linterExitCode = 0, linterSignal } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firefox-warning-test-'))
  tempDirs.push(dir)
  const build = path.join(dir, 'build')
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(build)
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(build, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Fixture', version: '1.0', description: 'Fixture', permissions: [],
    browser_specific_settings: { gecko: { id: 'fixture@example.invalid' } }
  }))
  fs.writeFileSync(path.join(build, 'bundle.js'), 'fixture')
  fs.writeFileSync(path.join(bin, 'addons-linter'), '#!/bin/sh\nprintf \'%s\' "$LINTER_OUTPUT"\nif [ -n "$LINTER_SIGNAL" ]; then kill -s "$LINTER_SIGNAL" $$; fi\nexit "$LINTER_EXIT_CODE"\n')
  fs.chmodSync(path.join(bin, 'addons-linter'), 0o755)
  const errorItems = Array.from({ length: errors }, (_, index) => ({ code: errorCodes?.[index] ?? 'UNEXPECTED_ERROR', message: 'Fixture error' }))
  const noticeItems = Array.from({ length: notices }, () => ({ code: 'FIXTURE_NOTICE', message: 'Fixture notice' }))
  const output = raw ?? JSON.stringify({
    summary: { errors: errorItems.length, warnings: warnings.length, notices: noticeItems.length },
    errors: errorItems, warnings, notices: noticeItems
  })
  let stdout = ''
  let status = 0
  try {
    stdout = execFileSync(process.execPath, [path.join(root, 'scripts/validate/validate-firefox.mjs')], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FIREFOX_BUILD_DIR: build, LINTER_OUTPUT: output, LINTER_EXIT_CODE: String(linterExitCode), LINTER_SIGNAL: linterSignal ?? '' }
    })
  } catch (error) {
    stdout = error.stdout || ''
    status = error.status ?? 1
  }
  return { stdout, status }
}

describe('Firefox known warning inventory', () => {
  it('matches exactly the 16-item baseline', () => {
    const result = run(fixtureWarnings())
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Known 16 / New 0 warnings')
    expect(result.stdout).toContain('Warnings: 16')
    expect(result.stdout).toContain('· KNOWN ')
    expect(result.stdout).not.toContain('⚠️ KNOWN')
  })

  it('reports an unknown warning as new and keeps its details visible', () => {
    const item = warning({ code: 'UNEXPECTED_CODE', message: 'Unexpected warning detail', file: 'new.js' })
    const result = run([...fixtureWarnings(), item])
    expect(result.stdout).toContain('Known 16 / New 1 warnings')
    expect(result.stdout).toContain('⚠️ NEW UNEXPECTED_CODE new.js: Unexpected warning detail')
  })

  it('classifies an occurrence beyond a known count as new', () => {
    const known = fixtureWarnings()
    const result = run([...known, { ...known[0] }])
    expect(result.stdout).toContain('Known 16 / New 1 warnings')
  })

  it('reports known warnings that are absent without pretending they were seen', () => {
    const result = run(fixtureWarnings(baseline.slice(1)))
    expect(result.stdout).toContain('Known 14 / New 0 warnings')
    expect(result.stdout).toContain('expected 2, observed 0')
  })

  it('treats a known warning kind in an unlisted file as new', () => {
    const warnings = fixtureWarnings()
    warnings.push({ ...warnings[0], file: 'unlisted.js' })
    const result = run(warnings)
    expect(result.stdout).toContain('Known 16 / New 1 warnings')
    expect(result.stdout).toContain('unlisted.js')
  })

  it('fails safely when the report contains malformed JSON', () => {
    const result = run([], { raw: 'errors 0\nwarnings 2\nnotices 1\n' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Untrusted addons-linter report: output is not valid JSON')
  })

  it('rejects an empty JSON object', () => {
    const result = run([], { raw: '{}' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Untrusted addons-linter report: expected summary totals')
  })

  it('rejects totals inconsistent with diagnostic arrays', () => {
    const result = run([], { raw: JSON.stringify({
      summary: { errors: 0, warnings: 1, notices: 0 }, errors: [], warnings: [], notices: []
    }) })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('summary.warnings (1) does not match warnings.length (0)')
  })

  it('keeps error, warning, and notice totals and fails on errors', () => {
    const result = run(fixtureWarnings(), { errors: 1, notices: 3 })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Errors:   1')
    expect(result.stdout).toContain('Warnings: 16')
    expect(result.stdout).toContain('Notices:  3')
  })

  it('fails when the linter exits with an unexpected status despite reporting zero errors', () => {
    const result = run([], { linterExitCode: 9 })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('addons-linter exited unexpectedly with status 9')
  })

  it('fails when an exit 1 report includes unignored errors', () => {
    const result = run([], { errors: 1, linterExitCode: 1 })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('addons-linter exited unexpectedly with status 1')
  })

  it('preserves the pass for exit 1 caused exclusively by ignored errors', () => {
    const result = run([], { errors: 1, errorCodes: ['DATA_COLLECTION_PERMISSIONS_PROP_RESERVED'], linterExitCode: 1 })
    expect(result.status, result.stdout).toBe(0)
    expect(result.stdout).toContain('Errors:   0 (1 ignored)')
  })

  it('fails on status 9 even when all reported errors are ignored', () => {
    const result = run([], { errors: 1, errorCodes: ['DATA_COLLECTION_PERMISSIONS_PROP_RESERVED'], linterExitCode: 9 })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('addons-linter exited unexpectedly with status 9')
  })

  it('fails when the linter is terminated by a signal', () => {
    const result = run([], { errors: 1, errorCodes: ['DATA_COLLECTION_PERMISSIONS_PROP_RESERVED'], linterSignal: 'TERM' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('addons-linter exited unexpectedly after signal SIGTERM')
  })

  it('succeeds for a zero-exit linter with a valid report', () => {
    const result = run([])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('└─ Mozilla validation completed\n\n')
  })

  it('prints plain compatibility rows and closes each successful section with a blank line', () => {
    const result = run([])
    expect(result.stdout).toContain('├─   Firefox-specific settings configured')
    expect(result.stdout).toContain('├─   Extension ID: fixture@example.invalid')
    expect(result.stdout).toContain('└─ Manifest validation completed\n\n')
    expect(result.stdout).toContain('└─ Package size within limits\n\n')
  })

  it('formats the summary status and terminates the box without a separator or redundant success line', () => {
    const passed = run([])
    const summary = passed.stdout.slice(passed.stdout.indexOf('╔════════'))
    expect(summary).toContain('Status: ✅ PASSED')
    expect(summary).toMatch(/Notices:[\s\S]*?\n╚════════[^\n]*╝\n\n$/)
    expect(summary).not.toMatch(/\n╠════════[^\n]*╣\n╚/)
    expect(passed.stdout).not.toContain('Firefox validation completed')

    const failed = run([], { errors: 1 })
    expect(failed.status).toBe(1)
    expect(failed.stdout).toContain('FIREFOX VALIDATION FAILED')
    expect(failed.stdout).toContain('addons-linter found 1 error(s)')
    expect(failed.stdout).not.toContain('Status: ✅ PASSED')
  })
})
