#!/usr/bin/env node
/**
 * Bundles the four pre-auth screens for the browser with react-native-web.
 * Production sources are imported in place from apps/mobile; native-only
 * modules are aliased to the shims in ./shims.
 *
 *   node tools/ux-audit/build.mjs            → tools/ux-audit/dist/bundle.js
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const mobile = path.join(repo, "apps", "mobile");
const mobileModules = path.join(mobile, "node_modules");
const dist = path.join(here, "dist");

const ALIASES = {
  "react-native": path.join(here, "shims", "react-native.tsx"),
  "react-native-safe-area-context": path.join(here, "shims", "safe-area-context.tsx"),
  "react-native-reanimated": path.join(here, "shims", "reanimated.tsx"),
  "react-native-video": path.join(here, "shims", "video.tsx"),
  "react-native-svg": path.join(
    mobileModules,
    "react-native-svg",
    "lib",
    "module",
    "ReactNativeSVG.web.js",
  ),
  "@react-native/assets-registry/registry": path.join(here, "shims", "assets-registry.ts"),
};

const STORE_ALIASES = [
  path.join(mobile, "src", "state", "appStore"),
  path.join(mobile, "src", "auth", "authStore"),
  path.join(mobile, "src", "notifications", "notificationStore"),
];

const aliasPlugin = {
  name: "ux-audit-aliases",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^(react-native|@react-native\/)/ }, (args) => {
      const target = ALIASES[args.path];
      return target ? { path: target } : undefined;
    });
    // One React: the app sources under apps/mobile would otherwise resolve
    // `react` from apps/mobile/node_modules while the harness uses its own
    // copy, which breaks hooks ("Invalid hook call").
    pluginBuild.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, (args) => {
      if (args.pluginData?.uxReact) return undefined;
      if (args.resolveDir.startsWith(path.join(here, "node_modules"))) return undefined;
      return pluginBuild.resolve(args.path, {
        kind: args.kind,
        resolveDir: here,
        pluginData: { uxReact: true },
      });
    });
    pluginBuild.onResolve({ filter: /(appStore|authStore|notificationStore)$/ }, (args) => {
      const resolved = path.resolve(args.resolveDir, args.path);
      if (STORE_ALIASES.includes(resolved)) {
        return { path: path.join(here, "shims", "stores.tsx") };
      }
      return undefined;
    });
  },
};

fs.mkdirSync(dist, { recursive: true });

const result = await build({
  entryPoints: [path.join(here, "harness", "entry.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  outfile: path.join(dist, "bundle.js"),
  sourcemap: "inline",
  jsx: "automatic",
  define: {
    __DEV__: "true",
    "process.env.NODE_ENV": '"development"',
    global: "window",
  },
  loader: {
    ".png": "file",
    ".jpg": "file",
    ".mp4": "file",
    ".ttf": "file",
  },
  assetNames: "assets/[name]-[hash]",
  // run.mjs serves the repository root, so asset URLs are repo-relative.
  publicPath: "/tools/ux-audit/dist",
  nodePaths: [path.join(here, "node_modules"), mobileModules],
  resolveExtensions: [".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".jsx", ".js"],
  plugins: [aliasPlugin],
  logLevel: "info",
  metafile: true,
});

fs.writeFileSync(path.join(dist, "meta.json"), JSON.stringify(result.metafile, null, 2));
