/* global require, module */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Metro loads transformerPath as CommonJS.
const { createRequire } = require('node:module');

// Use Metro's resolved instance, not an unrelated/hoisted image-size copy.
// GHSA-w3rx-r6r6-pgpr / GHSA-5p2g-fcmc-qvqq have no patched release.
// Metro filters by extension, but image-size selects its decoder by signature:
// disabling these handlers also rejects ICNS/JXL/HEIF bytes renamed to .png.
// The heif handler includes AVIF/HEIC brands; raw jxl-stream is not affected.
const metroRequire = createRequire(require.resolve('metro/package.json'));
metroRequire('image-size').disableTypes(['icns', 'jxl', 'heif']);

// Metro's config process and each fresh transform worker must both run this.
// Preserve the upstream worker interface and Sentry's separate Babel pipeline.
let upstreamWorker;
function worker() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Delegate the CommonJS worker interface unchanged.
  upstreamWorker ??= require('metro-transform-worker');
  return upstreamWorker;
}

// The config process only needs the image-size guard above; the transform
// toolchain (Babel, source maps, minifier) loads on first use inside a worker.
module.exports = {
  get transform() {
    return worker().transform;
  },
  get getCacheKey() {
    return worker().getCacheKey;
  },
};
