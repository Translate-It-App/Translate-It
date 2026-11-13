// Shared build output layout.
//
// Production and development artifacts must never share a directory: development
// builds skip minification, so writing them next to the release bundle replaces
// the minified content scripts with unminified ones that packaging and browser
// validation then inspect.

const PRODUCTION_OUTPUT_ROOT = 'dist';
const DEVELOPMENT_OUTPUT_ROOT = 'dist/dev';

/**
 * Whether the current invocation produces a production (minified) bundle.
 * Mirrors the minification gate in config/vite/vite.config.base.js so a build
 * directory only ever receives artifacts of the matching kind.
 */
function isProductionBuild(env = process.env) {
  return env.NODE_ENV === 'production' && env.VITE_WATCH_MODE !== 'true';
}

/**
 * Resolve the output directory for a browser build.
 *
 * @param {object} options
 * @param {string} options.browser - Target browser ('chrome' or 'firefox')
 * @param {string} options.version - Extension version
 * @param {string} options.artifactPrefix - Versioned artifact directory prefix
 * @param {boolean} [options.production] - Production build; defaults to the current environment
 * @returns {string} Output directory relative to the repository root
 */
function getBuildOutputDir({ browser, version, artifactPrefix, production = isProductionBuild() }) {
  const root = production ? PRODUCTION_OUTPUT_ROOT : DEVELOPMENT_OUTPUT_ROOT;
  return `${root}/${browser}/${artifactPrefix}-v${version}`;
}

module.exports = {
  PRODUCTION_OUTPUT_ROOT,
  DEVELOPMENT_OUTPUT_ROOT,
  isProductionBuild,
  getBuildOutputDir,
};
