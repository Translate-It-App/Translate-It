#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

const productionMarkers = [
  'Vitest mocker',
  'queueMock',
  'vi.mock(',
  '@vitest',
  'DefaultStrategy.staleGuard.test.js',
  'DiscordStrategy.staleGuard.test.js',
  'TwitterStrategy.staleGuard.test.js',
];

const tdZMarker = 'Promise.resolve().then(() => styleInjector)';

function getJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...getJavaScriptFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(entryPath);
    }
  }
  return files;
}

const failures = [];
for (const browser of ['chrome', 'firefox']) {
  const buildDir = path.join(rootDir, 'dist', browser, `Translate-It-v${packageJson.version}`);
  if (!fs.existsSync(buildDir)) {
    failures.push(`${browser}: missing production build directory ${path.relative(rootDir, buildDir)}`);
    continue;
  }

  const javaScriptFiles = getJavaScriptFiles(buildDir);
  if (javaScriptFiles.length === 0) {
    failures.push(`${browser}: production build directory contains no executable .js files (${path.relative(rootDir, buildDir)})`);
    continue;
  }

  for (const filePath of javaScriptFiles) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const marker of productionMarkers) {
      if (source.includes(marker)) failures.push(`${path.relative(rootDir, filePath)}: ${marker}`);
    }
    if (source.includes(tdZMarker)) {
      failures.push(`${path.relative(rootDir, filePath)}: ${tdZMarker}`);
    }
  }
}

if (failures.length > 0) {
  console.error('❌ Production bundle invariant failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('✅ Production bundle invariant passed for Chrome and Firefox.');
}
