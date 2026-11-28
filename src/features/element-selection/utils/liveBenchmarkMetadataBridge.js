const REQUEST = 'translate-it:select-element-benchmark:metadata-request';

export function installLiveBenchmarkMetadataBridge(targetDocument = document, loadProbe = () => import('./liveBenchmarkProbe.js')) {
  if (!import.meta.env.DEV || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(targetDocument.location.hostname)) return;
  targetDocument.dispatchEvent(new targetDocument.defaultView.CustomEvent('translate-it:select-element-benchmark:extension-ready'));
  targetDocument.addEventListener(REQUEST, (event) => {
    loadProbe().then(({ captureBenchmarkMetadata }) => captureBenchmarkMetadata(event)).catch(() => {});
  });
}
