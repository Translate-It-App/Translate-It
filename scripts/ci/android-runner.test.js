import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectDevice, resolveDevice, runAndroid } from '../dev/android-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const runnerSource = readFileSync(join(root, 'scripts/dev/android-runner.mjs'), 'utf8');

describe('Firefox Android development runner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves CLI, environment, and auto-detection precedence', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const calls = [];
    const exec = command => {
      calls.push(command);
      return 'List of devices attached\nauto-device\tdevice\n';
    };

    expect(resolveDevice({ args: ['--device=cli-device'], env: { ANDROID_DEVICE: 'env-device' }, exec })).toBe('cli-device');
    expect(resolveDevice({ args: [], env: { ANDROID_DEVICE: 'env-device' }, exec })).toBe('env-device');
    expect(resolveDevice({ args: [], env: {}, exec })).toBe('auto-device');
    expect(calls).toEqual(['adb devices']);
    expect(log).toHaveBeenCalledWith('Auto-detected device: auto-device');
  });

  it('prefers a connected USB device over network devices during auto-detection', () => {
    const device = detectDevice(() => 'List of devices attached\n192.168.1.20:5555\tdevice\nusb-serial\tdevice\noffline\toffline\n');
    expect(device).toBe('usb-serial');
  });

  it('fails actionably without a usable device and never builds, contacts the old fallback, or web-ext', async () => {
    const calls = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const status = await runAndroid({
      args: ['--build'],
      env: {},
      exec: command => {
        calls.push(command);
        return 'List of devices attached\n';
      },
      exists: () => true,
    });
    expect(status).toBe(1);
    expect(calls).toEqual(['adb devices']);
    expect(calls.some(command => command === 'pnpm run dev:firefox')).toBe(false);
    expect(calls.join(' ')).not.toContain('192.168.240.112:5555');
    expect(calls.some(command => command.startsWith('web-ext '))).toBe(false);
    expect(log.mock.calls.flat().join(' ')).toContain('Connect one via USB, set ANDROID_DEVICE, or pass --device=<id>');
    expect(runnerSource).not.toContain('192.168.240.112:5555');
  });

  it('preserves dev:android build and web-ext deployment while watch:android skips the build', async () => {
    expect(packageJson.scripts['dev:android']).toBe('node scripts/dev/android-runner.mjs --build');
    expect(packageJson.scripts['watch:android']).toBe('node scripts/dev/android-runner.mjs');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const calls = [];
    const status = await runAndroid({
      args: ['--build', '--device=cli-device'],
      env: { ANDROID_DEVICE: 'env-device' },
      root: '/tmp/android-runner-test',
      packageInfo: { version: '1.22.0' },
      exists: () => true,
      exec: command => {
        calls.push(command);
        if (command === 'adb -s cli-device shell pm list packages org.mozilla') {
          return 'package:org.mozilla.firefox\npackage:org.mozilla.fenix\n';
        }
        return '';
      },
    });

    expect(status).toBe(0);
    expect(calls).toEqual([
      'pnpm run dev:firefox',
      'adb -s cli-device shell pm list packages org.mozilla',
      'web-ext run -t firefox-android --source-dir "dist/dev/firefox/Translate-It-v1.22.0" --android-device "cli-device" --firefox-apk="org.mozilla.fenix"',
    ]);
    expect(log.mock.calls.flat().join(' ')).toContain('Building Firefox extension for Android...');
    expect(log.mock.calls.flat().join(' ')).toContain('Firefox build completed');
    expect(log.mock.calls.flat().join(' ')).toContain('Using Firefox package: org.mozilla.fenix');
  });

  it('skips the build without --build but still deploys to Firefox Android', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const calls = [];
    const status = await runAndroid({
      args: ['--device=cli-device'],
      env: {},
      root: '/tmp/android-runner-test',
      packageInfo: { version: '1.22.0' },
      exists: () => true,
      exec: command => {
        calls.push(command);
        if (command === 'adb -s cli-device shell pm list packages org.mozilla') {
          return 'package:org.mozilla.firefox\npackage:org.mozilla.fenix\n';
        }
        return '';
      },
    });

    expect(status).toBe(0);
    expect(calls.some(command => command === 'pnpm run dev:firefox')).toBe(false);
    expect(calls).toEqual([
      'adb -s cli-device shell pm list packages org.mozilla',
      'web-ext run -t firefox-android --source-dir "dist/dev/firefox/Translate-It-v1.22.0" --android-device "cli-device" --firefox-apk="org.mozilla.fenix"',
    ]);
    expect(log.mock.calls.flat().join(' ')).toContain('Starting Android deployment on device: cli-device...');
    expect(log.mock.calls.flat().join(' ')).not.toContain('Building Firefox extension for Android...');
  });
});
