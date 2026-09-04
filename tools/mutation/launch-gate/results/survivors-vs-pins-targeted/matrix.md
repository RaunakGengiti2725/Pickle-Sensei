# Launch-gate mutation matrix — survivors-vs-pins-targeted

- HEAD: `4d812e1aa699014cc0521fd92fde66908043aaa8`
- suite: `targeted` · jest: `npx jest --ci --silent --json --outputFile=<out>/<ID>.jest.json __tests__/launchGate.test.ts __tests__/onboardingScreen.test.tsx __tests__/appStorePreAuthOnboarding.test.ts __tests__/onboardingAccount.test.ts __tests__/wf/flow-launch-onboarding-gate.test.tsx __tests__/wf/flow-launch-onboarding-screen.test.tsx __tests__/wf/flow-launch-onboarding-splash-welcome.test.tsx __tests__/wf/App.buttons.test.tsx __tests__/wf/WelcomeScreen.buttons.test.tsx __tests__/wf/OnboardingScreen.buttons.test.tsx __tests__/wf/fix-6-gateLoadingAndErrorBoundary.test.tsx __tests__/mutation`
- node: `v22.12.0` · started: 2026-09-04T06:24:33.673Z · wall: 19013 ms

**killed 5 · survived 0 · failed_to_apply 0 · error 0** (of 5)

| id                                  | class | result     | tsc     | jest failed tests | killed by (suites)                                                    | title                                                                                                  |
| ----------------------------------- | ----- | ---------- | ------- | ----------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| LG06-device-history-default-arg     | skip  | **killed** | skipped | 2/224             | `__tests__/mutation/launchGate.inputs.pins.test.ts`                   | stageAfterGetStarted grows a DEFAULTED device-history parameter (Function.length stays 0)              |
| APP16-getstarted-consults-profile   | skip  | **killed** | skipped | 2/224             | `__tests__/mutation/gate.primaryCtaIgnoresStoreProfile.pins.test.tsx` | Primary CTA short-circuits to sign-in whenever the store holds any profile                             |
| OB02-skip-button-euphemism          | skip  | **killed** | skipped | 3/224             | `__tests__/mutation/onboardingScreen.controlLedger.pins.test.tsx`     | Pre-auth header grows a "Later" pressable (no "skip" wording anywhere) that hands off to sign-in       |
| OB03-account-continue-without-setup | empty | **killed** | skipped | 2/224             | `__tests__/mutation/onboardingScreen.controlLedger.pins.test.tsx`     | In-account header grows a "Later" pressable that saves the default profile (enters the app unanswered) |
| AS05-stash-validation-dropped       | stash | **killed** | skipped | 66/224            | `__tests__/mutation/appStorePendingProfileValidation.pins.test.ts`    | parsePendingProfile accepts any object as a profile (no required-field check)                          |
