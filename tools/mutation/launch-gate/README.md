# Launch-gate mutation harness

Adversarial check of the launch / onboarding gate pins (`AGENTS.md` → "Launch
flow"): Welcome → questionnaire → notification choice → sign-in → app, no skip
affordance, no device-history short-circuit on the primary CTA, no empty
profile inside `RootNavigator`. Every mutant in `mutants.mjs` reintroduces one
of those regressions into the real production file; the runner applies it,
runs the mobile Jest suite, restores the original bytes, and records whether
the pins caught it.

Production code is never committed mutated: the runner refuses to start on a
dirty target file, restores from the bytes it read in a `finally`, and re-runs
`git status` on the target after every mutant.

## Run

```bash
# from the repo root; apps/mobile deps installed with `npm ci` (never pnpm)
node tools/mutation/launch-gate/run.mjs --check                 # every find-string still matches? (no tests)
node tools/mutation/launch-gate/run.mjs --suite full            # the report matrix (~15-20 min on 51 mutants)
node tools/mutation/launch-gate/run.mjs --suite targeted --skip-tsc   # fast inner loop (11 gate suites)
node tools/mutation/launch-gate/run.mjs --suite full --only OB02-skip-button-euphemism   # replay one
node tools/mutation/launch-gate/run.mjs --suite full --ignore-tests __tests__/mutation   # pre-pin matrix
node tools/mutation/launch-gate/run.mjs --rebuild artifacts/mutation/launch-gate/<run>   # re-derive matrix from raw json
```

Output goes to `artifacts/mutation/launch-gate/<run-id>/`: `matrix.json`,
`matrix.md`, `run.json`, and per mutant `<ID>.diff` (the exact patch),
`<ID>.jest.json` (raw `--json`), `<ID>.jest.log`, `<ID>.tsc.log`.

Classification: `killed` (Jest exit ≠ 0, failing suites/tests listed),
`survived` (Jest exit 0 with the mutant applied), `failed_to_apply` (find
string absent/ambiguous — nothing ran), `error` (runner failure — never a
pass). `tsc` is recorded separately: babel-jest strips types, so a type error
alone does not stop the mutated app.

`--extra-tests` is only accepted with `--suite targeted` — Jest treats
positional paths as a filter, so with `full` it would silently shrink the run.

## Mutant classes

| class     | what is reintroduced                                                                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skip`    | a way to reach sign-in without finishing the questionnaire (CTA → sign-in, Back → sign-in, "Skip"/"Later" pressables, unlabelled / long-press / keyboard escapes, device-history arguments, double-tap hand-off) |
| `reorder` | gate stages out of order (boot into sign-in/onboarding, sign-in before questionnaire, questionnaire steps shuffled, notification step dropped, readiness ignoring the owner)                                     |
| `empty`   | an empty/default profile inside the app (no-profile account → `RootNavigator`, hydrate error → app, Continue never locked, `null` profile defaulted, validation dropped)                                         |
| `stash`   | pre-auth stash contract broken (not written, not cleared, adopted signed-out, canonical adopts locally, failed save clears, existing profile wins)                                                               |

## Results on `4d812e1a` (see `results/`)

Committed under `results/` are the `matrix.json` / `matrix.md` / `run.json` and
the `<ID>.diff` files of each run (raw Jest JSON/logs are attached to the
session report, ~60 MB per full run).

- `baseline-4d812e1a` — 47 first-order mutants vs the pre-existing suite:
  **42 killed, 5 survived, 0 failed_to_apply, 0 error**.
  Survivors: `LG06-device-history-default-arg`, `APP16-getstarted-consults-profile`,
  `OB02-skip-button-euphemism`, `OB03-account-continue-without-setup`,
  `AS05-stash-validation-dropped`.
- `prepin-replay-9-survivors` — the 5 survivors plus 4 second-order evasion
  mutants (`OB16`–`OB19`, written against the new pins) replayed with the new
  pins ignored (`--ignore-tests __tests__/mutation`): all 9 **survive** the
  pre-existing suite.
- `final-full-with-pins-4d812e1a` — all 51 mutants vs the full suite including
  `apps/mobile/__tests__/mutation/*`: see `results/final-full-with-pins-4d812e1a/matrix.md`.

## New pins (`apps/mobile/__tests__/mutation/`)

| file                                               | kills                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launchGate.inputs.pins.test.ts`                   | `LG06` — calls every stage function with hostile "device history" inputs and asserts the source has an empty parameter list (a defaulted parameter keeps `Function.length === 0`).                                                                                                                                     |
| `gate.primaryCtaIgnoresStoreProfile.pins.test.tsx` | `APP16` — real `App` gate with a stale profile hydrated under the signed-out owner and a profile injected into the store while Welcome is up; the primary CTA must still enter the questionnaire.                                                                                                                      |
| `onboardingScreen.controlLedger.pins.test.tsx`     | `OB02`, `OB03`, `OB16`–`OB19` — exact ledger of every innermost `onPress` target (labelled or `<unlabelled:…>`) on every step in both modes, no long-press/magic-tap/accessibility-escape handler anywhere, keyboard Next never leaves the questionnaire, every non-finish control pressed never reaches a completion. |
| `appStorePendingProfileValidation.pins.test.ts`    | `AS05` — matrix of object-shaped stashes missing/mistyping each required field; none may be adopted, written, or saved, the stash stays untouched, and a complete stash is still adopted.                                                                                                                              |
