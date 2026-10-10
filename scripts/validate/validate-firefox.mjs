#!/usr/bin/env node

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { logStep, logSuccess, logError, logInfo } from '../shared/logger.mjs'
import { createBox, createErrorBox, centerText, emptyBoxLine, formatPackageSize, formatFileSize } from '../shared/box-utils.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../..')
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'))

const FIREFOX_BUILD_DIR = process.env.FIREFOX_BUILD_DIR || path.join(rootDir, `dist/firefox/Translate-It-v${pkg.version}`)
const KNOWN_WARNINGS_PATH = path.join(__dirname, 'firefox-known-warnings.json')

/**
 * Validate Firefox extension build
 */
async function validateFirefoxExtension() {
  try {
    console.log(createBox('🦊 FIREFOX EXTENSION VALIDATOR') + '\n')
    
    const results = {
      errors: 0,
      warnings: 0,
      notices: 0
    }
    
    // Step 1: Check if build exists
    logStep('Checking Firefox build directory...')
    if (!fs.existsSync(FIREFOX_BUILD_DIR)) {
      throw new Error(`Firefox build directory not found: ${FIREFOX_BUILD_DIR}`)
    }
    logInfo('Firefox build directory found')
    console.log(`└─ Path: ${FIREFOX_BUILD_DIR}\n`)
    
    // Step 2: Validate manifest
    logStep('Validating manifest.json...')
    const manifestPath = path.join(FIREFOX_BUILD_DIR, 'manifest.json')
    if (!fs.existsSync(manifestPath)) {
      throw new Error('manifest.json not found in Firefox build')
    }
    
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

    // Substitute extension name
    const substitutedManifest = await substituteMessages(manifest)

    // Firefox-specific manifest checks
    if (!substitutedManifest.manifest_version || (substitutedManifest.manifest_version !== 2 && substitutedManifest.manifest_version !== 3)) {
      throw new Error('Firefox extension must use Manifest V2 or V3')
    }
    console.log(`├─ Manifest Version: V${substitutedManifest.manifest_version}`)

    if (!substitutedManifest.name || !substitutedManifest.version || !substitutedManifest.description) {
      throw new Error('Missing required manifest fields')
    }
    console.log(`├─ Extension Name: ${substitutedManifest.name}`)
    console.log(`├─ Extension Version: ${substitutedManifest.version}`)
    console.log('└─ Manifest validation completed')
    
    // Step 3: Mozilla addons-linter validation
    // Ignored error codes (reserved features not yet implemented):
    // - DATA_COLLECTION_PERMISSIONS_PROP_RESERVED
    // - https://mozilla.github.io/addons-linter/
    // - https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/
    const IGNORED_ERROR_CODES = ['DATA_COLLECTION_PERMISSIONS_PROP_RESERVED']

    logStep('Running Mozilla addons-linter...')
    const knownBaseline = JSON.parse(fs.readFileSync(KNOWN_WARNINGS_PATH, 'utf8'))
    let output
    let exitStatus = 0
    let exitSignal
    let spawnError
    try {
      output = execSync(`addons-linter --output json "${FIREFOX_BUILD_DIR}"`, { encoding: 'utf8' })
    } catch (error) {
      output = error.stdout || ''
      exitStatus = error.status
      exitSignal = error.signal
      spawnError = error.status == null && !error.signal && Boolean(error.code)
      const stderr = String(error.stderr || '')
      if (!output && (error.code === 'ENOENT' || /addons-linter.*not found/i.test(stderr) || error.message.includes('not found'))) {
        console.log('⚠️ addons-linter not found. Install with: pnpm add -D addons-linter')
        throw new Error('addons-linter unavailable; validation was not performed')
      }
      if (!output && (exitStatus !== 0 || exitSignal || error.code)) throw new Error(`addons-linter failed without a report: ${stderr || error.message}`)
    }

    const report = parseLinterReport(output, IGNORED_ERROR_CODES)
    const ignoredErrors = report.ignoredErrors
    const effectiveErrors = report.errors - ignoredErrors
    results.errors += effectiveErrors
    results.warnings += report.warnings
    results.notices += report.notices
    console.log('├─ VALIDATION RESULTS:')
    console.log(`├─   Errors:   ${effectiveErrors}${ignoredErrors ? ` (${ignoredErrors} ignored)` : ''}`)
    console.log(`├─   Warnings: ${report.warnings}`)
    console.log(`├─   Notices:  ${report.notices}`)
    if (report.warningItems) {
      const classification = classifyWarnings(report.warningItems, knownBaseline)
      console.log(`├─   Known ${classification.known} / New ${classification.new.length} warnings`)
      for (const item of classification.new) console.log(`⚠️ NEW ${item.code} ${item.file}: ${item.message}`)
      for (const item of classification.knownItems) console.log(`· KNOWN ${item.code} ${item.file}: ${item.message}`)
      for (const item of classification.missing) console.log(`ℹ️ Known baseline absent: ${item.file} | ${item.messagePrefix} expected ${item.expected}, observed ${item.observed}`)
    }
    const ignoredErrorExit = exitStatus === 1 && !exitSignal && !spawnError && effectiveErrors === 0 && ignoredErrors > 0 && report.errorItems.every(item => IGNORED_ERROR_CODES.includes(item.code))
    if ((exitStatus !== 0 || exitSignal || spawnError) && !ignoredErrorExit) {
      throw new Error(`addons-linter exited unexpectedly${exitStatus != null ? ` with status ${exitStatus}` : ''}${exitSignal ? ` after signal ${exitSignal}` : ''}`)
    }
    if (effectiveErrors > 0) throw new Error(`addons-linter found ${effectiveErrors} error(s)`)
    logInfo('Mozilla validation completed')
    
    // Step 4: Firefox-specific analysis
    logStep('Analyzing Firefox compatibility...')
    const issues = []
    const warnings = []
    const info = []
    
    // Check Firefox-specific settings
    if (manifest.browser_specific_settings?.gecko) {
      info.push('Firefox-specific settings configured')
      if (manifest.browser_specific_settings.gecko.id) {
        info.push(`Extension ID: ${manifest.browser_specific_settings.gecko.id}`)
      }
    }
    
    // Check background implementation
    if (manifest.background) {
      if (manifest.background.scripts && manifest.manifest_version === 3) {
        info.push('Uses background.scripts (Firefox MV3 compatible)')
      } else if (manifest.background.service_worker && manifest.manifest_version === 3) {
        info.push('Uses service_worker (Manifest V3 standard)')
      } else if (manifest.background.scripts && manifest.manifest_version === 2) {
        info.push('Uses background.scripts (Manifest V2 standard)')
      }
    }
    
    // Check permissions
    if (manifest.permissions?.includes('<all_urls>')) {
      info.push('Uses <all_urls> permission (required for translation)')
    }
    
    // Display analysis results
    console.log('├─ COMPATIBILITY ANALYSIS:')
    if (issues.length > 0) {
      issues.forEach(issue => {
        console.log(`├─   ❌ ${issue}`)
        results.warnings++
      })
    }
    if (warnings.length > 0) {
      warnings.forEach(warning => {  
        console.log(`├─   ⚠️  ${warning}`)
        results.warnings++
      })
    }
    if (info.length > 0) {
      info.forEach(infoItem => {
        console.log(`├─   ${infoItem}`)
      })
    }
    if (issues.length === 0 && warnings.length === 0) {
      console.log('├─   No compatibility issues found')
    }
    console.log('└─ Firefox analysis completed\n')
    
    // Step 5: Package size analysis
    logStep('Analyzing package size...')
    const stats = getDirectoryStats(FIREFOX_BUILD_DIR)
    const sizeStr = formatFileSize(stats.totalSize)
    const sizeLimit = 200 // Firefox limit in MB

    console.log('├─ PACKAGE STATISTICS:')
    console.log(`├─   Total Files: ${stats.fileCount}`)
    console.log(`├─   Total Size:  ${sizeStr}`)
    console.log(`├─   Size Limit:  ${sizeLimit} MB (Firefox Add-ons)`)

    if (stats.totalSize > sizeLimit * 1024 * 1024) {
      console.log('└─ ❌ Package size exceeds Firefox limit\n')
      throw new Error(`Extension size (${sizeStr}) exceeds Firefox limit (${sizeLimit}MB)`)
    } else {
      const percentageUsed = ((stats.totalSize / (sizeLimit * 1024 * 1024)) * 100).toFixed(1)
      console.log(`├─   Usage:       ${percentageUsed}% of allowed size`)
      logInfo('Package size within limits')
    }
    
    // Final summary
    console.log('╔════════════════════════════════════════════════════════════════╗')
    console.log(`║${centerText('🦊 FIREFOX VALIDATION SUMMARY')}║`)
    console.log('╠════════════════════════════════════════════════════════════════╣')
    const statusText = results.errors === 0 ? 'PASSED' : 'FAILED'
    const statusLine = `Status:  ${statusText}`
    const errorLine = `Errors:    ${results.errors.toString().padStart(3, ' ')}`
    const warningLine = `Warnings:  ${results.warnings.toString().padStart(3, ' ')}`
    const noticeLine = `Notices:   ${results.notices.toString().padStart(3, ' ')}`

    console.log(emptyBoxLine())
    console.log(`║${centerText(statusLine)}║`)
    console.log(`║${centerText(errorLine)}║`)
    console.log(`║${centerText(warningLine)}║`)
    console.log(`║${centerText(noticeLine)}║`)
    console.log(emptyBoxLine())
    console.log('╠════════════════════════════════════════════════════════════════╣')
    console.log('╚════════════════════════════════════════════════════════════════╝\n')
    
    if (results.errors > 0) {
      process.exit(1)
    }
    logSuccess('Firefox validation completed')
    
  } catch (error) {
    console.log(createErrorBox('🦊 FIREFOX VALIDATION FAILED') + '\n')
    const horizontalLine = '═'.repeat(64)
    console.log(`╠${horizontalLine}╣`)
    console.log(`║${centerText(`❌ Error: ${error.message.slice(0, 51)}`)}║`)
    console.log(`╠${horizontalLine}╣`)
    console.log(`║${centerText('Please fix the above issues and run validation again.')}║`)
    console.log(`╚${horizontalLine}╝\n`)
    
    logError('Firefox validation failed:', error.message)
    process.exit(1)
  }
}

function parseLinterReport(output, ignoredCodes) {
  let parsed
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new Error('Untrusted addons-linter report: output is not valid JSON')
  }

  const validObject = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
  const summary = validObject && parsed.summary
  const arraysValid = validObject && ['errors', 'warnings', 'notices'].every(name => Array.isArray(parsed[name]))
  const totalsValid = summary && typeof summary === 'object' && ['errors', 'warnings', 'notices'].every(name => typeof summary[name] === 'number' && Number.isFinite(summary[name]))
  if (!validObject || !arraysValid || !totalsValid) {
    throw new Error('Untrusted addons-linter report: expected summary totals and errors, warnings, and notices arrays')
  }
  for (const name of ['errors', 'warnings', 'notices']) {
    if (summary[name] !== parsed[name].length) {
      throw new Error(`Untrusted addons-linter report: summary.${name} (${summary[name]}) does not match ${name}.length (${parsed[name].length})`)
    }
  }
  return {
    errors: summary.errors,
    warnings: summary.warnings,
    notices: summary.notices,
    errorItems: parsed.errors,
    warningItems: parsed.warnings,
    ignoredErrors: parsed.errors.filter(item => ignoredCodes.includes(item.code)).length
  }
}

function classifyWarnings(warnings, baseline) {
  const remaining = baseline.map(item => ({ ...item, observed: 0 }))
  const knownItems = []
  const newItems = []
  for (const warning of warnings) {
    const file = normalizeLinterFile(warning.file)
    const message = String(warning.message || '')
    const match = remaining.find(item => item.code === warning.code && item.file === file && message.startsWith(item.messagePrefix) && item.observed < item.count)
    const detail = { ...warning, file, message }
    if (match) {
      match.observed++
      knownItems.push(detail)
    } else newItems.push(detail)
  }
  return {
    known: knownItems.length,
    knownItems,
    new: newItems,
    missing: remaining.filter(item => item.observed < item.count).map(item => ({ ...item, expected: item.count, observed: item.observed }))
  }
}

function normalizeLinterFile(file) {
  let normalized = String(file || '').replaceAll('\\', '/')
  const buildPath = FIREFOX_BUILD_DIR.replaceAll('\\', '/') + '/'
  if (normalized.startsWith(buildPath)) normalized = normalized.slice(buildPath.length)
  return normalized.replace(/^\.\//, '')
}

function getDirectoryStats(dirPath) {
  let fileCount = 0
  let totalSize = 0

  function traverse(currentPath) {
    const items = fs.readdirSync(currentPath)

    for (const item of items) {
      const itemPath = path.join(currentPath, item)
      const stats = fs.statSync(itemPath)

      if (stats.isDirectory()) {
        traverse(itemPath)
      } else {
        fileCount++
        totalSize += stats.size
      }
    }
  }

  traverse(dirPath)
  return { fileCount, totalSize }
}

/**
 * Substitute extension name from package.json
 * @param {Object} obj - Object to process
 * @returns {Object} Object with substituted name
 */
async function substituteMessages(obj) {
  const processed = JSON.parse(JSON.stringify(obj))
  const extensionName = pkg.name === 'translate-it' ? 'Translate It' : pkg.name

  function substituteValue(value) {
    if (typeof value === 'string') {
      return value.replace(/__MSG_nameChrome__|__MSG_nameFirefox__|__MSG_name__/g, extensionName)
    }
    return value
  }

  function processObject(current) {
    if (typeof current === 'string') {
      return substituteValue(current)
    } else if (Array.isArray(current)) {
      return current.map(item => processObject(item))
    } else if (typeof current === 'object' && current !== null) {
      const result = {}
      for (const [key, value] of Object.entries(current)) {
        result[key] = processObject(value)
      }
      return result
    }
    return current
  }

  return processObject(processed)
}

// Run validation
validateFirefoxExtension()
