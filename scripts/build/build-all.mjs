#!/usr/bin/env node

import { execSync, spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { logStep, logError } from '../shared/logger.mjs'
import { centerText, createBox, createSuccessBox, createErrorBox, formatDuration } from '../shared/box-utils.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../..')

// Check if parallel mode is enabled
const isParallel = process.argv.includes('--parallel') || process.argv.includes('--p')

/**
 * Build Chrome extension asynchronously
 */
async function buildChromeAsync() {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''

    const args = ['scripts/build/build-chrome.mjs']

    let settled = false
    const child = spawn('node', args, {
      cwd: rootDir,
      stdio: 'pipe'
    })

    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      resolve({ browser: 'Chrome', success: code === 0, stdout, stderr, error: code === 0 ? null : `Chrome build failed with exit code ${code}` })
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      resolve({ browser: 'Chrome', success: false, stdout, stderr, error: `Chrome build process error: ${error.message}` })
    })
  })
}

/**
 * Build Firefox extension asynchronously
 */
async function buildFirefoxAsync() {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''

    const args = ['scripts/build/build-firefox.mjs']

    let settled = false
    const child = spawn('node', args, {
      cwd: rootDir,
      stdio: 'pipe'
    })

    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      resolve({ browser: 'Firefox', success: code === 0, stdout, stderr, error: code === 0 ? null : `Firefox build failed with exit code ${code}` })
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      resolve({ browser: 'Firefox', success: false, stdout, stderr, error: `Firefox build process error: ${error.message}` })
    })
  })
}

/**
 * Build all browser extensions and create publish packages
 */
async function buildAll() {
  try {
    console.log(createBox('🗳️ BUILDING ALL EXTENSIONS') + '\n')

    const startTime = Date.now()

    // Build extensions (parallel or sequential based on flag)
    if (isParallel) {
      logStep(`Building Chrome and Firefox extensions in parallel...`)

      // Run builds in parallel and capture outputs
      const [chromeResult, firefoxResult] = await Promise.all([
        buildChromeAsync(),
        buildFirefoxAsync()
      ])

      // Display both captured outputs, including diagnostics from failed builds.
      for (const result of [chromeResult, firefoxResult]) {
        process.stdout.write(result.stdout)
        if (result.stderr) process.stderr.write(result.stderr)
      }
      const failedBuild = [chromeResult, firefoxResult].find(result => !result.success)
      if (failedBuild) throw new Error(failedBuild.error)
    } else {
      // Step 1: Build Chrome
      logStep(`Building Chrome extension...`)
      execSync(`node scripts/build/build-chrome.mjs`, {
        cwd: rootDir,
        stdio: 'inherit'
      })

      // Step 2: Build Firefox
      logStep(`Building Firefox extension...`)
      execSync(`node scripts/build/build-firefox.mjs`, {
        cwd: rootDir,
        stdio: 'inherit'
      })
    }
    
    // Step 3: Create publish packages
    // Copy packages to Publish directory
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'))
    const version = pkg.version

    const chromeZip = path.join(rootDir, `dist/chrome/Translate-It-v${version}.zip`)
    const firefoxZip = path.join(rootDir, `dist/firefox/Translate-It-v${version}.zip`)

    const missingZips = [chromeZip, firefoxZip].filter(zipPath => !fs.existsSync(zipPath))
    if (missingZips.length > 0) {
      throw new Error(`Missing expected browser package(s): ${missingZips.join(', ')}`)
    }

    logStep('Creating publish packages...')
    const publishDir = path.join(rootDir, 'dist/Publish')
    if (!fs.existsSync(publishDir)) {
      fs.mkdirSync(publishDir, { recursive: true })
    }

    const chromeCopied = fs.existsSync(chromeZip)
    if (chromeCopied) {
      fs.copyFileSync(chromeZip, path.join(publishDir, `Translate-It-v${version}-for-Chrome.zip`))
    }
    
    const firefoxCopied = fs.existsSync(firefoxZip)
    if (firefoxCopied) {
      fs.copyFileSync(firefoxZip, path.join(publishDir, `Translate-It-v${version}-for-Firefox.zip`))
    }
    
    // Step 4: Generate release notes
    const releaseNotes = `# Translate It v${version} Release

## Chrome Extension
- **File**: Translate-It-v${version}-for-Chrome.zip
- **Manifest**: Version 3
- **Compatible**: Chrome 88+

## Firefox Extension
- **File**: Translate-It-v${version}-for-Firefox.zip
- **Manifest**: Version 3
- **Compatible**: Firefox 112+

## Installation
1. Download the appropriate file for your browser
2. Extract and load as unpacked extension for testing
3. Or submit to respective web stores

Generated on: ${new Date().toISOString()}
Build time: ${formatDuration(Date.now() - startTime)}
`
    
    fs.writeFileSync(path.join(publishDir, 'release-notes.md'), releaseNotes)
    
    // Step 5: Success summary
    const duration = formatDuration(Date.now() - startTime)
    
    const horizontalLine = '═'.repeat(64)
    console.log('\n╔' + horizontalLine + '╗')
    console.log(`║${centerText('✅ ALL BUILDS COMPLETED')}║`)
    console.log(`╠${horizontalLine}╣`)
    if (chromeCopied) console.log(`║${centerText(`Chrome ZIP: dist/Publish/Translate-It-v${version}-for-Chrome.zip`)}║`)
    if (firefoxCopied) console.log(`║${centerText(`Firefox ZIP: dist/Publish/Translate-It-v${version}-for-Firefox.zip`)}║`)
    if (!chromeCopied && !firefoxCopied) console.log(`║${centerText('No browser ZIPs were copied to dist/Publish/')}║`)
    console.log(`╠${horizontalLine}╣`)
    console.log(`║${centerText(`⏱️ Total build time: ${duration}`)}║`)
    console.log(`╚${horizontalLine}╝\n`)
    
    logStep('Release notes: dist/Publish/release-notes.md')
    
  } catch (error) {
    console.log('\n' + createErrorBox('❌ BUILD FAILED'))
    const horizontalLine = '═'.repeat(64)
    console.log(`╠${horizontalLine}╣`)
    console.log(`║${centerText(`Error: ${error.message.slice(0, 51)}`)}║`)
    console.log(`╚${horizontalLine}╝\n`)
    
    logError('Build failed:', error.message)
    process.exit(1)
  }
}

// Run build
buildAll()
