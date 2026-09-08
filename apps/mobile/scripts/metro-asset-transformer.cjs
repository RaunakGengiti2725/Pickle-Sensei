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
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Delegate the CommonJS worker interface unchanged.
const upstreamWorker = () => require('metro-transform-worker');

// The config process only needs the decoder guard above; the Babel/minifier
// toolchain behind metro-transform-worker loads on first worker use instead.
module.exports = {
  get transform() {
    return upstreamWorker().transform;
  },
  get getCacheKey() {
    return upstreamWorker().getCacheKey;
  },
};
