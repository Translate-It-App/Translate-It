import { writeFileSync, statSync, accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

// Shared helpers for the CI shell-script tests so they behave the same on
// Windows and on the POSIX CI runners.

// Git for Windows ships two `bash` binaries: a small launcher in `bin/` that
// injects `/ucrt64/bin` and `/usr/bin` ahead of the caller's PATH, and the real
// MSYS bash in `usr/bin`. The injected directories shadow test mock executables
// that intentionally reuse real tool names (notably `git`), so a mocked
// `git rev-parse HEAD` would silently run the real Git. Native Windows `jq`
// also writes CRLF line endings, unlike the POSIX `jq` used by CI.
//
// Sourcing a BASH_ENV prelude reorders PATH inside the shell so the mock
// directory wins, and puts `jq` into binary output mode so its line endings
// match CI. This workaround is Windows-only; POSIX environments are returned
// unchanged.
export function createBashEnvPreload(mockDir, env) {
  if (process.platform !== 'win32') return env;
  const posixMockDir = mockDir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  const prelude = join(mockDir, 'mock-bash-env.sh');
  // The mock directory is passed through an environment variable rather than
  // interpolated into the shell source, so paths containing quotes, spaces, or
  // other shell metacharacters cannot break or inject into the prelude.
  writeFileSync(prelude, [
    'PATH="${MOCK_BASH_PRELOAD_DIR}:$PATH"',
    'export PATH',
    'shopt -s expand_aliases',
    "alias jq='jq --binary'",
    '',
  ].join('\n'));
  // bash expands BASH_ENV before reading it, so a literal path containing
  // shell metacharacters could be subject to command substitution or word
  // splitting. Referencing the prelude through a variable makes bash expand it
  // once (to the literal path) without re-parsing its contents.
  return { ...env, BASH_ENV: '$MOCK_BASH_PRELUDE', MOCK_BASH_PRELUDE: prelude, MOCK_BASH_PRELOAD_DIR: posixMockDir };
}

// Locate an executable on PATH without relying on POSIX-only tools such as
// `which`, which is not available to native Windows Node processes.
// Directories and other non-file candidates are skipped, as are files the
// current user cannot execute on POSIX; the search continues until a valid
// candidate is found.
function isExecutableFile(fullPath) {
  let stat;
  try {
    stat = statSync(fullPath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  if (process.platform === 'win32') return true;
  try {
    accessSync(fullPath, constants.X_OK);
  } catch {
    return false;
  }
  return true;
}

export function resolveExecutable(name) {
  const candidates = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const fullPath = join(dir, candidate);
      if (isExecutableFile(fullPath)) return fullPath;
    }
  }
  throw new Error(`Unable to locate ${name} on PATH.`);
}

// Resolve Git to an absolute path both Node subprocesses and the Git Bash
// wrapper scripts can execute. On Windows the separators are normalized to
// forward slashes so the path can be `exec`'d from within a bash script.
export function resolveGit() {
  const gitPath = resolveExecutable('git');
  return process.platform === 'win32' ? gitPath.replace(/\\/g, '/') : gitPath;
}
