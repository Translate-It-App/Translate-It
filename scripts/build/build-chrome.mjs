#!/usr/bin/env node

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { BuildReporter } from '../shared/build-reporter.mjs'
import { logStep, logError } from '../shared/logger.mjs'
import { formatPackageSize } from '../shared/box-utils.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../..')
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'))

const CHROME_BUILD_DIR = `dist/chrome/Translate-It-v${pkg.version}`
const CHROME_ZIP_PATH = `dist/chrome/Translate-It-v${pkg.version}.zip`

/**
 * Build Chrome extension with Vue
 */
async function buildChromeExtension() {
  const reporter = new BuildReporter('chrome')
  
  try {
    reporter.start()
    
    // Step 1: Clean previous build
    logStep('Cleaning previous Chrome build...')
    if (fs.existsSync(path.join(rootDir, CHROME_BUILD_DIR))) {
      fs.rmSync(path.join(rootDir, CHROME_BUILD_DIR), { recursive: true, force: true })
    }
    fs.mkdirSync(path.join(rootDir, CHROME_BUILD_DIR), { recursive: true })
    
    // Step 2: Run Vite build
    reporter.logBuildStep('Vite compilation...', 'in-progress')
    process.chdir(rootDir)
    
    process.env.NODE_ENV = 'production'
    process.env.BROWSER = 'chrome'

    const buildCommand = `npx vite build --config config/vite/vite.config.chrome.js`
    execSync(buildCommand, { stdio: 'pipe' })
    
    reporter.logBuildStep('Vite compilation...', 'completed')
    
    // Step 3: Create ZIP package
    logStep('Creating Chrome extension package...')
    const archiver = await import('archiver')
    const archive = archiver.default('zip', { zlib: { level: 9 } })
    const output = fs.createWriteStream(path.join(rootDir, CHROME_ZIP_PATH))
    
    await new Promise((resolve, reject) => {
      output.on('close', resolve)
      archive.on('error', reject)
      
      archive.pipe(output)
      archive.directory(path.join(rootDir, CHROME_BUILD_DIR), false)
      archive.finalize()
    })
    
    const zipStats = fs.statSync(path.join(rootDir, CHROME_ZIP_PATH))
    const sizeStr = formatPackageSize(zipStats.size)
    logStep(`ZIP created: ${CHROME_ZIP_PATH} (${sizeStr})`)

    // Step 4: Analyze build output
    const buildStats = reporter.analyzeBuild(path.join(rootDir, CHROME_BUILD_DIR))

    // Step 5: Success
    reporter.success(buildStats)
    
  } catch (error) {
    reporter.error(error.message)
    logError('Chrome build failed:', error.message)
    process.exit(1)
  }
}

// Run build
buildChromeExtension()
