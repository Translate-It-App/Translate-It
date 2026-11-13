const profileKeys = ['mode', 'nodeEnv', 'browser', 'defines', 'build'];
const defineKeys = ['browser', 'isProduction', 'isDevelopment', 'nodeEnv'];
const buildKeys = ['minify', 'dropConsole', 'dropDebugger', 'sourcemap', 'cssMinify', 'esbuildDrop', 'target'];

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactKeys = (value, keys) => plainObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function validateBuildParity(builds, modes) {
  const issues = [];
  if (!Array.isArray(modes) || !modes.length || modes.some(mode => typeof mode !== 'string' || !mode)
      || new Set(modes).size !== modes.length) return { ok: false, issues: ['Expected build modes must be a non-empty unique string list.'] };
  if (!Array.isArray(builds)) return { ok: false, issues: ['Build evidence must be an array.'] };

  const byMode = new Map();
  for (const [index, build] of builds.entries()) {
    if (!plainObject(build) || typeof build.mode !== 'string' || !modes.includes(build.mode)) {
      issues.push(`Build evidence entry ${index} has an unknown or missing mode.`);
      continue;
    }
    if (byMode.has(build.mode)) issues.push(`Duplicate build evidence for mode ${build.mode}.`);
    else byMode.set(build.mode, build);
  }

  let referenceSignature;
  for (const mode of modes) {
    const build = byMode.get(mode);
    if (!build) {
      issues.push(`Missing build evidence for mode ${mode}.`);
      continue;
    }
    if (build.status !== 'passed') issues.push(`Build ${mode} did not report a successful status.`);
    const environment = build.environment;
    if (!exactKeys(environment, ['worker', 'content'])) {
      issues.push(`Build ${mode} is missing successful worker/content environment evidence.`);
      continue;
    }
    const workerValid = validateProfile(environment.worker, `${mode} worker`, issues);
    const contentValid = validateProfile(environment.content, `${mode} content`, issues);
    if (workerValid && contentValid && JSON.stringify(environment.worker) !== JSON.stringify(environment.content)) {
      issues.push(`Build ${mode} worker/content environments do not match.`);
    }
    if (workerValid && contentValid) {
      const signature = JSON.stringify({ worker: environment.worker, content: environment.content });
      if (referenceSignature === undefined) referenceSignature = signature;
      else if (signature !== referenceSignature) issues.push(`Build ${mode} environment differs from the other modes.`);
    }
  }
  return { ok: issues.length === 0, issues };
}

function validateProfile(profile, label, issues) {
  const initialIssueCount = issues.length;
  if (!exactKeys(profile, profileKeys)) {
    issues.push(`${label} environment profile is missing or malformed.`);
    return false;
  }
  if (profile.mode !== 'production' || profile.nodeEnv !== 'production') issues.push(`${label} was not resolved with production mode and NODE_ENV.`);
  if (!['chrome', 'firefox'].includes(profile.browser)) issues.push(`${label} browser define is missing or unsupported.`);
  if (!exactKeys(profile.defines, defineKeys) || profile.defines.browser !== profile.browser
      || profile.defines.isProduction !== true || profile.defines.isDevelopment !== false
      || profile.defines.nodeEnv !== 'production') issues.push(`${label} production defines are missing or inconsistent.`);
  if (!exactKeys(profile.build, buildKeys) || profile.build.minify !== 'terser'
      || profile.build.dropConsole !== true || profile.build.dropDebugger !== true
      || profile.build.sourcemap !== false || profile.build.cssMinify !== true
      || !Array.isArray(profile.build.esbuildDrop)
      || [...profile.build.esbuildDrop].sort().join(',') !== 'console,debugger'
      || profile.build.target !== 'esnext') issues.push(`${label} resolved build optimization settings are missing or inconsistent.`);
  return issues.length === initialIssueCount;
}
