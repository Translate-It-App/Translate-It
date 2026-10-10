#!/usr/bin/env node

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { logStep, logSuccess, logError, logInfo } from '../shared/logger.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../..')
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'))

const args = process.argv.slice(2)
const shouldBuild = args.includes('--build')

/**
 * Detect connected Android devices via adb
 */
function detectDevice() {
  try {
    const output = execSync('adb devices', { encoding: 'utf8' })
    const devices = output
      .split('\n')
      .slice(1) // Skip "List of devices attached"
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('*')) // Filter out noise
      .map(line => {
        const parts = line.split(/\s+/)
        return { id: parts[0], status: parts[1] }
      })
      .filter(d => d.status === 'device') // Only online devices

    if (devices.length === 0) return null
    if (devices.length === 1) return devices[0].id
    
    // Priority: 1. USB devices (usually don't have : in ID) 2. Network/Waydroid
    const usbDevice = devices.find(d => !d.id.includes(':'))
    return usbDevice ? usbDevice.id : devices[0].id
  } catch (error) {
    return null
  }
}

// 1. Priority: Command line argument (--device=...)
const deviceArg = args.find(arg => arg.startsWith('--device='))
let deviceIp = deviceArg ? deviceArg.split('=')[1] : null

// 2. Fallback: Environment variable
if (!deviceIp) {
  deviceIp = process.env.ANDROID_DEVICE
}

// 3. Fallback: Auto-detection via adb
if (!deviceIp) {
  const detected = detectDevice()
  if (detected) {
    console.log(`Auto-detected device: ${detected}`)
    deviceIp = detected
  }
}

// Final fallback for Waydroid default if everything else fails
if (!deviceIp) {
  deviceIp = '192.168.240.112:5555' 
  console.log(` No device detected. Falling back to default: ${deviceIp}`)
}

const FIREFOX_BUILD_DIR = `dist/firefox/Translate-It-v${pkg.version}`

/**
 * Detect installed Firefox packages on the device
 */
function detectFirefoxPackage(deviceId) {
  try {
    const output = execSync(`adb -s ${deviceId} shell pm list packages org.mozilla`, { encoding: 'utf8' })
    const packages = output
      .split('\n')
      .map(line => line.replace('package:', '').trim())
      .filter(line => line.length > 0)

    if (packages.length === 0) return null
    
    // Priority: 1. Fenix (Nightly/Preview) 2. Firefox (Stable) 3. Any other
    const fenix = packages.find(p => p === 'org.mozilla.fenix')
    const stable = packages.find(p => p === 'org.mozilla.firefox')
    
    return fenix || stable || packages[0]
  } catch (error) {
    return null
  }
}

/**
 * Run extension on Firefox Android using web-ext
 */
async function runAndroid() {
  try {
    if (shouldBuild) {
      logStep('Building Firefox extension for Android...')
      execSync('pnpm run dev:firefox', { stdio: 'inherit', cwd: rootDir })
      logSuccess('Firefox build completed')
    }

    logStep(`Starting Android deployment on device: ${deviceIp}...`)
    
    const buildPath = path.join(rootDir, FIREFOX_BUILD_DIR)
    if (!fs.existsSync(buildPath)) {
      logError(`Build directory not found: ${FIREFOX_BUILD_DIR}`)
      console.log('💡 Tip: Run with --build flag to create the build first: pnpm run dev:android')
      process.exit(1)
    }

    const firefoxPackage = detectFirefoxPackage(deviceIp)
    let webExtCommand = `web-ext run -t firefox-android --source-dir "${FIREFOX_BUILD_DIR}" --android-device "${deviceIp}"`
    
    if (firefoxPackage) {
      logInfo(`Using Firefox package: ${firefoxPackage}`)
      webExtCommand += ` --firefox-apk="${firefoxPackage}"`
    }
    
    logStep('Executing web-ext run...')
    
    // web-ext run is a persistent process that handles its own logging
    execSync(webExtCommand, { stdio: 'inherit', cwd: rootDir })
    
  } catch (error) {
    // execSync throws if the process exits with non-zero code or is interrupted (e.g., Ctrl+C)
    if (error.status === null) {
      logInfo('Android runner stopped (SIGINT)')
    } else {
      logError('Android deployment failed:', error.message)
      process.exit(1)
    }
  }
}

runAndroid()
