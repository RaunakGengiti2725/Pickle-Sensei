/**
 * Vitest config for the adversarial attack suite. Deliberately NOT picked up by
 * `pnpm --filter @pickle/evaluation test` (files end in `.attack.ts`, not
 * `.test.ts`): several attacks spawn real bench subprocesses, race the runner
 * against itself and write/remove files under `datasets/`.
 *
 *   pnpm --filter @pickle/evaluation exec vitest run \
 *     --config test/attack/vitest.attack.config.ts
 *
 * Files run strictly one at a time (`fileParallelism: false`) because S4 and
 * S5 both touch the shared `datasets/experiments/wave-e` and
 * `datasets/completion-bench` output directories.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/attack/**/*.attack.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 240_000,
    hookTimeout: 240_000,
    reporters: ["verbose"],
  },
});
