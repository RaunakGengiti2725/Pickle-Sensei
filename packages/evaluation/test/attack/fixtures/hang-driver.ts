/**
 * Attack fixture: drives the REAL `runSubprocess()` (spawnSync, no timeout)
 * against `never-exits.ts`. The attack test spawns this driver in its own
 * process group, watches it stay alive, and then kills the whole group.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runSubprocess } from "../../../src/regression/run.js";

const here = dirname(fileURLToPath(import.meta.url));
console.log(`hang-driver pid=${process.pid} calling runSubprocess(never-exits.ts)`);
const result = runSubprocess({ script: "never-exits.ts", args: [], cwd: here });
console.log(`hang-driver: runSubprocess returned exit=${result.exitCode}`);
