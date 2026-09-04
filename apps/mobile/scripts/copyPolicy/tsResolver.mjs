/**
 * Node module-resolution hook for running the copy-policy library straight
 * from its TypeScript sources: `scan.ts` / `extract.ts` / `policy.ts` use
 * extensionless relative imports (so tsc + Jest resolve them), and Node's
 * ESM loader only accepts explicit extensions — this hook tries `.ts` when
 * an extensionless relative specifier fails to resolve.
 */
export async function resolve(specifier, context, nextResolve) {
  if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      // fall through to the default resolver so its error surfaces
    }
  }
  return nextResolve(specifier, context);
}
