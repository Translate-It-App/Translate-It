#!/usr/bin/env node

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { logStep, logSuccess, logError, logInfo } from '../shared/logger.mjs'
import projectNaming from '../shared/project-names.cjs'
import buildOutputPaths from '../shared/build-output-paths.cjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../..')
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'))
const { artifactPrefix } = projectNaming.getProjectNames(pkg.name)

/**
 * Detect connected Android devices via adb
 */
export function detectDevice(exec = execSync) {
  try {
    const output = exec('adb devices', { encoding: 'utf8' })
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

export function resolveDevice({ args = process.argv.slice(2), env = process.env, exec = execSync } = {}) {
  const deviceArg = args.find(arg => arg.startsWith('--device='))
  let deviceId = deviceArg ? deviceArg.split('=')[1] : null
  if (!deviceId) deviceId = env.ANDROID_DEVICE
  if (!deviceId) {
    deviceId = detectDevice(exec)
    if (deviceId) console.log(`Auto-detected device: ${deviceId}`)
  }
  return deviceId || null
}

/**
 * Detect installed Firefox packages on the device
 */
export function detectFirefoxPackage(deviceId, exec = execSync) {
  try {
    const output = exec(`adb -s ${deviceId} shell pm list packages org.mozilla`, { encoding: 'utf8' })
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
export async function runAndroid({ args = process.argv.slice(2), env = process.env, exec = execSync, root = rootDir, packageInfo = pkg, exists = fs.existsSync } = {}) {
  try {
    const deviceId = resolveDevice({ args, env, exec })
    if (!deviceId) {
      logError('No Android device found. Connect one via USB, set ANDROID_DEVICE, or pass --device=<id>.')
      return 1
    }

    if (args.includes('--build')) {
      logStep('Building Firefox extension for Android...')
      exec('pnpm run dev:firefox', { stdio: 'inherit', cwd: root })
      logSuccess('Firefox build completed')
    }

    logStep(`Starting Android deployment on device: ${deviceId}...`)
    
    // The runner deploys a development build, which lives outside the release output.
    const firefoxBuildDir = buildOutputPaths.getBuildOutputDir({
      browser: 'firefox',
      version: packageInfo.version,
      artifactPrefix,
      production: false,
    })
    const buildPath = path.join(root, firefoxBuildDir)
    if (!exists(buildPath)) {
      logError(`Build directory not found: ${firefoxBuildDir}`)
      console.log('💡 Tip: Run with --build flag to create the build first: pnpm run dev:android')
      return 1
    }

    const firefoxPackage = detectFirefoxPackage(deviceId, exec)
    let webExtCommand = `web-ext run -t firefox-android --source-dir "${firefoxBuildDir}" --android-device "${deviceId}"`
    
    if (firefoxPackage) {
      logInfo(`Using Firefox package: ${firefoxPackage}`)
      webExtCommand += ` --firefox-apk="${firefoxPackage}"`
    }
    
    logStep('Executing web-ext run...')
    
    // web-ext run is a persistent process that handles its own logging
    exec(webExtCommand, { stdio: 'inherit', cwd: root })
    return 0
  } catch (error) {
    // execSync throws if the process exits with non-zero code or is interrupted (e.g., Ctrl+C)
    if (error.status === null) {
      logInfo('Android runner stopped (SIGINT)')
      return 0
    } else {
      logError('Android deployment failed:', error.message)
      return 1
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAndroid().then(code => { process.exitCode = code })
}
