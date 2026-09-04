/** `@react-native/assets-registry/registry` alias: the bundler inlines asset
 * URLs directly, so nothing is ever registered by numeric id. */
export function getAssetByID(): undefined {
  return undefined;
}

export function registerAsset(): number {
  return 0;
}
