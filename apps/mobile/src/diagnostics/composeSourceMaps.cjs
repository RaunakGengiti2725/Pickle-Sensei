const DEBUG_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function composeWithDebugId(packagerMap, compilerMap, composeSourceMaps) {
  if (
    !packagerMap ||
    !compilerMap ||
    packagerMap.version !== 3 ||
    compilerMap.version !== 3
  ) {
    throw new Error('Expected Metro and Hermes source maps');
  }
  const debugId = packagerMap.debug_id ?? packagerMap.debugId;
  if (
    typeof debugId !== 'string' ||
    !DEBUG_ID.test(debugId) ||
    [
      packagerMap.debug_id,
      packagerMap.debugId,
      compilerMap.debug_id,
      compilerMap.debugId,
    ].some(value => value !== undefined && value !== debugId)
  ) {
    throw new Error('Missing or inconsistent source-map debug ID');
  }
  if (
    packagerMap.x_facebook_offsets != null ||
    compilerMap.x_facebook_offsets != null ||
    compilerMap.x_facebook_segments != null
  ) {
    throw new Error('Unsupported source-map format');
  }
  return {
    ...composeSourceMaps([packagerMap, compilerMap]),
    debug_id: debugId,
    debugId,
  };
}

async function main() {
  const { default: process } = await import('node:process');
  try {
    const fs = await import('node:fs');
    const { default: sourceMaps } = await import('metro-source-map');
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[2] !== '-o')
      throw new Error('Invalid source-map arguments');
    const packagerMap = JSON.parse(fs.readFileSync(args[0], 'utf8'));
    const compilerMap = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    const composed = composeWithDebugId(
      packagerMap,
      compilerMap,
      sourceMaps.composeSourceMaps,
    );
    fs.writeFileSync(args[3], JSON.stringify(composed), 'utf8');
  } catch {
    process.stderr.write(
      'Unable to prepare matching local Hermes source maps.\n',
    );
    process.exitCode = 1;
  }
}

void main();
