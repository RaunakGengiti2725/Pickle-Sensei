# Launch-gate mutation matrix — prepin-replay-9-survivors

- HEAD: `4d812e1aa699014cc0521fd92fde66908043aaa8`
- suite: `full` · jest: `npx jest --ci --silent --json --outputFile=<out>/<ID>.jest.json --testPathIgnorePatterns __tests__/mutation`
- node: `v22.12.0` · started: 2026-09-04T06:38:32.779Z · wall: 106870 ms

**killed 0 · survived 9 · failed_to_apply 0 · error 0** (of 9)

| id                                  | class | result       | tsc     | jest failed tests | killed by (suites) | title                                                                                                                         |
| ----------------------------------- | ----- | ------------ | ------- | ----------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| LG06-device-history-default-arg     | skip  | **survived** | skipped | 0/2901            |                    | stageAfterGetStarted grows a DEFAULTED device-history parameter (Function.length stays 0)                                     |
| APP16-getstarted-consults-profile   | skip  | **survived** | skipped | 0/2901            |                    | Primary CTA short-circuits to sign-in whenever the store holds any profile                                                    |
| OB02-skip-button-euphemism          | skip  | **survived** | skipped | 0/2901            |                    | Pre-auth header grows a "Later" pressable (no "skip" wording anywhere) that hands off to sign-in                              |
| OB03-account-continue-without-setup | empty | **survived** | skipped | 0/2901            |                    | In-account header grows a "Later" pressable that saves the default profile (enters the app unanswered)                        |
| OB16-name-submit-hands-off          | skip  | **survived** | skipped | 0/2901            |                    | Keyboard Next on an EMPTY name hands off to sign-in pre-auth (skip with no pressable at all; Next with a name still advances) |
| OB17-unlabelled-skip-pressable      | skip  | **survived** | skipped | 0/2901            |                    | Pre-auth header grows an UNLABELLED raw Pressable (no accessibilityLabel, no text) that hands off to sign-in                  |
| OB18-back-longpress-hands-off       | skip  | **survived** | skipped | 0/2901            |                    | Pre-auth step-one Back keeps its PressableScale but its icon gains a LONG-press-only raw Pressable that hands off to sign-in  |
| OB19-progress-tap-hands-off         | skip  | **survived** | skipped | 0/2901            |                    | The step counter text becomes tappable (Text onPress, no label) and hands off to sign-in pre-auth                             |
| AS05-stash-validation-dropped       | stash | **survived** | skipped | 0/2901            |                    | parsePendingProfile accepts any object as a profile (no required-field check)                                                 |
