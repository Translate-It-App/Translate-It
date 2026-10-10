import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { resolveExecutable } from './test-helpers.mjs';

const isWindows = process.platform === 'win32';
// Root bypasses file permission checks, so permission-based tests are only
// meaningful for non-root users.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('resolveExecutable', () => {
  let savedPath;
  let tempDirs;

  beforeEach(() => {
    savedPath = process.env.PATH;
    tempDirs = [];
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  function makeTempDir() {
    const dir = mkdtempSync(join(tmpdir(), 'resolve-executable-test-'));
    tempDirs.push(dir);
    return dir;
  }

  function writeExecutable(dir, name) {
    const file = join(dir, name);
    writeFileSync(file, '#!/bin/sh\nexit 0\n');
    chmodSync(file, 0o755);
    return file;
  }

  it('skips a directory shadowing the executable name and resolves the later file', () => {
    const shadowDir = makeTempDir();
    const binDir = makeTempDir();
    mkdirSync(join(shadowDir, 'probe-tool'));
    const expected = writeExecutable(binDir, 'probe-tool');
    process.env.PATH = `${shadowDir}${delimiter}${binDir}`;

    expect(resolveExecutable('probe-tool')).toBe(expected);
  });

  it.runIf(!isWindows)('skips a file without executable permission and resolves the later executable', () => {
    const maskedDir = makeTempDir();
    const binDir = makeTempDir();
    const masked = join(maskedDir, 'probe-tool');
    writeFileSync(masked, '#!/bin/sh\nexit 0\n');
    chmodSync(masked, 0o644);
    const expected = writeExecutable(binDir, 'probe-tool');
    process.env.PATH = `${maskedDir}${delimiter}${binDir}`;

    expect(resolveExecutable('probe-tool')).toBe(expected);
  });

  it.runIf(!isWindows && !isRoot)('skips a user-owned file with mode 001 the current user cannot execute', () => {
    const maskedDir = makeTempDir();
    const binDir = makeTempDir();
    const masked = join(maskedDir, 'probe-tool');
    writeFileSync(masked, '#!/bin/sh\nexit 0\n');
    chmodSync(masked, 0o001);
    const expected = writeExecutable(binDir, 'probe-tool');
    process.env.PATH = `${maskedDir}${delimiter}${binDir}`;

    expect(resolveExecutable('probe-tool')).toBe(expected);
  });

  it('throws when only a directory matches the executable name', () => {
    const shadowDir = makeTempDir();
    mkdirSync(join(shadowDir, 'probe-tool'));
    process.env.PATH = shadowDir;

    expect(() => resolveExecutable('probe-tool')).toThrow('Unable to locate probe-tool on PATH.');
  });

  it.runIf(isWindows)('resolves the .exe candidate when no extensionless file exists', () => {
    const binDir = makeTempDir();
    const expected = join(binDir, 'probe-tool.exe');
    writeFileSync(expected, 'placeholder');
    process.env.PATH = binDir;

    expect(resolveExecutable('probe-tool')).toBe(expected);
  });
});
