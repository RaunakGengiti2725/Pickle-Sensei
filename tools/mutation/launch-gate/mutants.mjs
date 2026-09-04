/**
 * Mutant catalogue for the launch / onboarding gate.
 *
 * Every mutant is a deterministic, exact-match text substitution against one
 * production file under apps/mobile. `find` MUST occur exactly once in the
 * clean file (the runner refuses to apply an ambiguous or stale mutant and
 * records it as `failed_to_apply`). The runner writes the mutated bytes, runs
 * the mobile Jest suite, then restores the original bytes it read — no git
 * command ever touches the working tree.
 *
 * Classes (from the assignment):
 *   skip     — reintroduce a skip affordance / a path that bypasses the
 *              questionnaire on the way to sign-in
 *   reorder  — change the Welcome → onboarding → sign-in → app order
 *   empty    — let an account/device with no (or a default) profile into the
 *              main app
 *   stash    — break the pre-auth stash contract that carries the answers
 *              across sign-in (single-use, owner-gated, validated)
 *
 * `expected` is the pre-run prediction from reading the existing suites; the
 * matrix records what actually happened. Predictions are labelled INFERRED in
 * the report; only the run result is VERIFIED.
 */

const LAUNCH_GATE = "apps/mobile/src/flow/launchGate.ts";
const APP = "apps/mobile/App.tsx";
const ONBOARDING = "apps/mobile/src/screens/OnboardingScreen.tsx";
const WELCOME = "apps/mobile/src/screens/WelcomeScreen.tsx";
const APP_STORE = "apps/mobile/src/state/appStore.ts";

/** @type {Array<{id:string,cls:'skip'|'reorder'|'empty'|'stash',file:string,title:string,expected:'killed'|'survived'|'unknown',edits:Array<{find:string,replace:string}>}>} */
export const MUTANTS = [
  // ───────────────────────── launchGate.ts (pure routing) ─────────────────
  {
    id: "LG01-getstarted-to-signin",
    cls: "skip",
    file: LAUNCH_GATE,
    title: "Primary CTA routes straight to sign-in (questionnaire skipped)",
    expected: "killed",
    edits: [
      {
        find: `export function stageAfterGetStarted(): PreAuthStage {
  return 'onboarding';
}`,
        replace: `export function stageAfterGetStarted(): PreAuthStage {
  return 'signin';
}`,
      },
    ],
  },
  {
    id: "LG02-after-onboarding-to-welcome",
    cls: "reorder",
    file: LAUNCH_GATE,
    title: "Finishing the questionnaire returns to Welcome instead of sign-in",
    expected: "killed",
    edits: [
      {
        find: `export function stageAfterOnboarding(): PreAuthStage {
  return 'signin';
}`,
        replace: `export function stageAfterOnboarding(): PreAuthStage {
  return 'welcome';
}`,
      },
    ],
  },
  {
    id: "LG03-after-onboarding-loops",
    cls: "reorder",
    file: LAUNCH_GATE,
    title: "Finishing the questionnaire re-enters onboarding (never reaches sign-in)",
    expected: "killed",
    edits: [
      {
        find: `export function stageAfterOnboarding(): PreAuthStage {
  return 'signin';
}`,
        replace: `export function stageAfterOnboarding(): PreAuthStage {
  return 'onboarding';
}`,
      },
    ],
  },
  {
    id: "LG04-leaving-to-signin",
    cls: "skip",
    file: LAUNCH_GATE,
    title: 'Step-one Back hands off to sign-in (the removed "Skip to sign-in" escape)',
    expected: "killed",
    edits: [
      {
        find: `export function stageWhenLeavingOnboarding(): PreAuthStage {
  return 'welcome';
}`,
        replace: `export function stageWhenLeavingOnboarding(): PreAuthStage {
  return 'signin';
}`,
      },
    ],
  },
  {
    id: "LG05-device-history-optional-arg",
    cls: "skip",
    file: LAUNCH_GATE,
    title: "stageAfterGetStarted grows an optional device-history parameter (alreadyOnboarded?)",
    expected: "killed",
    edits: [
      {
        find: `export function stageAfterGetStarted(): PreAuthStage {
  return 'onboarding';
}`,
        replace: `export function stageAfterGetStarted(
  alreadyOnboarded?: boolean,
): PreAuthStage {
  return alreadyOnboarded ? 'signin' : 'onboarding';
}`,
      },
    ],
  },
  {
    id: "LG06-device-history-default-arg",
    cls: "skip",
    file: LAUNCH_GATE,
    title:
      "stageAfterGetStarted grows a DEFAULTED device-history parameter (Function.length stays 0)",
    expected: "unknown",
    edits: [
      {
        find: `export function stageAfterGetStarted(): PreAuthStage {
  return 'onboarding';
}`,
        replace: `export function stageAfterGetStarted(
  alreadyOnboarded = false,
): PreAuthStage {
  return alreadyOnboarded ? 'signin' : 'onboarding';
}`,
      },
    ],
  },

  // ───────────────────────── App.tsx (Gate) ───────────────────────────────
  {
    id: "APP01-getstarted-bypasses-gate",
    cls: "skip",
    file: APP,
    title: "Welcome primary CTA sets sign-in directly, bypassing stageAfterGetStarted",
    expected: "killed",
    edits: [
      {
        find: `onGetStarted={() => setPreAuthStage(stageAfterGetStarted())}`,
        replace: `onGetStarted={() => setPreAuthStage('signin')}`,
      },
    ],
  },
  {
    id: "APP02-back-bypasses-gate",
    cls: "skip",
    file: APP,
    title: "Pre-auth step-one Back sets sign-in directly, bypassing stageWhenLeavingOnboarding",
    expected: "killed",
    edits: [
      {
        find: `onBack={() => setPreAuthStage(stageWhenLeavingOnboarding())}`,
        replace: `onBack={() => setPreAuthStage('signin')}`,
      },
    ],
  },
  {
    id: "APP03-finished-to-welcome",
    cls: "reorder",
    file: APP,
    title: "Pre-auth onFinished returns to Welcome, bypassing stageAfterOnboarding",
    expected: "killed",
    edits: [
      {
        find: `onFinished={() => setPreAuthStage(stageAfterOnboarding())}`,
        replace: `onFinished={() => setPreAuthStage('welcome')}`,
      },
    ],
  },
  {
    id: "APP04-initial-stage-signin",
    cls: "reorder",
    file: APP,
    title: "Gate boots into sign-in (Welcome and questionnaire skipped)",
    expected: "killed",
    edits: [
      {
        find: `useState<PreAuthStage>('welcome')`,
        replace: `useState<PreAuthStage>('signin')`,
      },
    ],
  },
  {
    id: "APP05-initial-stage-onboarding",
    cls: "reorder",
    file: APP,
    title: "Gate boots into the questionnaire (Welcome skipped)",
    expected: "killed",
    edits: [
      {
        find: `useState<PreAuthStage>('welcome')`,
        replace: `useState<PreAuthStage>('onboarding')`,
      },
    ],
  },
  {
    id: "APP06-signin-before-onboarding-swap",
    cls: "reorder",
    file: APP,
    title: 'Stages swapped: "onboarding" renders SignInScreen, "signin" renders the questionnaire',
    expected: "killed",
    edits: [
      {
        find: `    preAuthStage === 'signin' ? (
      <SignInScreen onBack={() => setPreAuthStage('welcome')} />
    ) : preAuthStage === 'onboarding' ? (
      <OnboardingScreen`,
        replace: `    preAuthStage === 'onboarding' ? (
      <SignInScreen onBack={() => setPreAuthStage('welcome')} />
    ) : preAuthStage === 'signin' ? (
      <OnboardingScreen`,
      },
    ],
  },
  {
    id: "APP07-preauth-mode-dropped",
    cls: "skip",
    file: APP,
    title: "Pre-auth questionnaire mounts in account mode (Leave setup / sign-out escape appears)",
    expected: "killed",
    edits: [
      {
        find: `      <OnboardingScreen
        mode="preauth"
        onFinished`,
        replace: `      <OnboardingScreen
        onFinished`,
      },
    ],
  },
  {
    id: "APP08-account-link-enters-questionnaire",
    cls: "reorder",
    file: APP,
    title: '"I already have an account" enters the questionnaire instead of sign-in',
    expected: "killed",
    edits: [
      {
        find: `onSignIn={() => setPreAuthStage('signin')}`,
        replace: `onSignIn={() => setPreAuthStage(stageAfterGetStarted())}`,
      },
    ],
  },
  {
    id: "APP09-no-account-link",
    cls: "reorder",
    file: APP,
    title: "Welcome loses the returning-player link (no route to sign-in but the questionnaire)",
    expected: "killed",
    edits: [
      {
        find: `        onSignIn={() => setPreAuthStage('signin')}
`,
        replace: ``,
      },
    ],
  },
  {
    id: "APP10-empty-profile-into-app",
    cls: "empty",
    file: APP,
    title: "Signed-in with no profile renders RootNavigator (in-account questionnaire removed)",
    expected: "killed",
    edits: [
      {
        find: `  ) : !profile ? (
    <OnboardingScreen />
  ) : (
    <RootNavigator />
  );`,
        replace: `  ) : (
    <RootNavigator />
  );`,
      },
    ],
  },
  {
    id: "APP11-guest-empty-profile-into-app",
    cls: "empty",
    file: APP,
    title: "Only canonical accounts are gated on a profile; a guest owner with none enters the app",
    expected: "killed",
    edits: [
      {
        find: `  ) : !profile ? (
    <OnboardingScreen />`,
        replace: `  ) : !profile && session.provider !== 'guest' ? (
    <OnboardingScreen />`,
      },
    ],
  },
  {
    id: "APP12-canonical-empty-profile-into-app",
    cls: "empty",
    file: APP,
    title: "Only guests are gated on a profile; a canonical account with none enters the app",
    expected: "killed",
    edits: [
      {
        find: `  ) : !profile ? (
    <OnboardingScreen />`,
        replace: `  ) : !profile && session.provider === 'guest' ? (
    <OnboardingScreen />`,
      },
    ],
  },
  {
    id: "APP13-hydrate-error-into-app",
    cls: "empty",
    file: APP,
    title:
      "A failed profile load renders RootNavigator with profile=null instead of the retry state",
    expected: "killed",
    edits: [
      {
        find: `  ) : !profile && hydrateError ? (
    <ErrorState
      dark
      title="Your coaching profile couldn’t load"
      detail={hydrateError}
      onRetry={() => void hydrateApp()}
    />
  ) : !profile ? (`,
        replace: `  ) : !profile && hydrateError ? (
    <RootNavigator />
  ) : !profile ? (`,
      },
    ],
  },
  {
    id: "APP14-account-questionnaire-preauth-mode",
    cls: "empty",
    file: APP,
    title:
      "In-account questionnaire mounts in pre-auth mode (answers stashed, profile never saved, onFinished no-op)",
    expected: "killed",
    edits: [
      {
        find: `  ) : !profile ? (
    <OnboardingScreen />`,
        replace: `  ) : !profile ? (
    <OnboardingScreen mode="preauth" onFinished={() => {}} onBack={() => {}} />`,
      },
    ],
  },
  {
    id: "APP15-ready-ignores-owner",
    cls: "reorder",
    file: APP,
    title: "Gate readiness ignores the app-store owner (stale owner profile can route the gate)",
    expected: "killed",
    edits: [
      {
        find: `    appHydrated &&
    appOwnerKey === desiredOwner;`,
        replace: `    appHydrated;`,
      },
    ],
  },
  {
    id: "APP16-getstarted-consults-profile",
    cls: "skip",
    file: APP,
    title: "Primary CTA short-circuits to sign-in whenever the store holds any profile",
    expected: "unknown",
    edits: [
      {
        find: `onGetStarted={() => setPreAuthStage(stageAfterGetStarted())}`,
        replace: `onGetStarted={() =>
          setPreAuthStage(profile ? 'signin' : stageAfterGetStarted())
        }`,
      },
    ],
  },

  // ───────────────────────── OnboardingScreen.tsx ─────────────────────────
  {
    id: "OB01-skip-button-literal",
    cls: "skip",
    file: ONBOARDING,
    title: 'Pre-auth header grows a "Skip" pressable that hands off to sign-in',
    expected: "killed",
    edits: [
      {
        find: `        <Text style={[type.micro, styles.stepCount]}>
          {stepIndex + 1}/{STEPS.length}
        </Text>
      </View>`,
        replace: `        <Text style={[type.micro, styles.stepCount]}>
          {stepIndex + 1}/{STEPS.length}
        </Text>
        {preAuth ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Skip"
            accessibilityHint="Skip setup and sign in"
            hitSlop={12}
            onPress={() => props.onFinished?.()}
            style={styles.headerButton}
          >
            <Text style={[type.micro, styles.stepCount]}>Skip</Text>
          </PressableScale>
        ) : null}
      </View>`,
      },
    ],
  },
  {
    id: "OB02-skip-button-euphemism",
    cls: "skip",
    file: ONBOARDING,
    title:
      'Pre-auth header grows a "Later" pressable (no "skip" wording anywhere) that hands off to sign-in',
    expected: "unknown",
    edits: [
      {
        find: `        <Text style={[type.micro, styles.stepCount]}>
          {stepIndex + 1}/{STEPS.length}
        </Text>
      </View>`,
        replace: `        <Text style={[type.micro, styles.stepCount]}>
          {stepIndex + 1}/{STEPS.length}
        </Text>
        {preAuth ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Later"
            accessibilityHint="Finish setup another time"
            hitSlop={12}
            onPress={() => props.onFinished?.()}
            style={styles.headerButton}
          >
            <Text style={[type.micro, styles.stepCount]}>Later</Text>
          </PressableScale>
        ) : null}
      </View>`,
      },
    ],
  },
  {
    id: "OB03-account-continue-without-setup",
    cls: "empty",
    file: ONBOARDING,
    title:
      'In-account header grows a "Later" pressable that saves the default profile (enters the app unanswered)',
    expected: "unknown",
    edits: [
      {
        find: `        <Text style={[type.micro, styles.stepCount]}>
          {stepIndex + 1}/{STEPS.length}
        </Text>
      </View>`,
        replace: `        <Text style={[type.micro, styles.stepCount]}>
          {stepIndex + 1}/{STEPS.length}
        </Text>
        {preAuth ? null : (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Later"
            accessibilityHint="Finish setup another time"
            hitSlop={12}
            onPress={() => void completeOnboarding(answeredProfile)}
            style={styles.headerButton}
          >
            <Text style={[type.micro, styles.stepCount]}>Later</Text>
          </PressableScale>
        )}
      </View>`,
      },
    ],
  },
  {
    id: "OB04-leave-dialog-continue-without-setup",
    cls: "empty",
    file: ONBOARDING,
    title:
      'In-account Leave dialog\'s "Sign out" becomes "Continue without setup" (saves the default profile)',
    expected: "killed",
    edits: [
      {
        find: `            label: 'Sign out',
            variant: 'danger',
            onPress: () => {
              setConfirmingLeave(false);
              void signOut();
            },`,
        replace: `            label: 'Continue without setup',
            variant: 'danger',
            onPress: () => {
              setConfirmingLeave(false);
              void completeOnboarding(answeredProfile);
            },`,
      },
    ],
  },
  {
    id: "OB05-back-finishes",
    cls: "skip",
    file: ONBOARDING,
    title: "Pre-auth step-one Back calls onFinished (Back becomes a skip to sign-in)",
    expected: "killed",
    edits: [
      {
        find: `    if (preAuth) {
      props.onBack?.();
      return;
    }
    setConfirmingLeave(true);`,
        replace: `    if (preAuth) {
      props.onFinished?.();
      return;
    }
    setConfirmingLeave(true);`,
      },
    ],
  },
  {
    id: "OB06-later-back-leaves-flow",
    cls: "skip",
    file: ONBOARDING,
    title: "Back past step one leaves the questionnaire (calls onBack) instead of stepping back",
    expected: "killed",
    edits: [
      {
        find: `              accessibilityHint="Return to the previous question"
              hitSlop={12}
              onPress={goBack}`,
        replace: `              accessibilityHint="Return to the previous question"
              hitSlop={12}
              onPress={preAuth ? () => props.onBack?.() : goBack}`,
      },
    ],
  },
  {
    id: "OB07-continue-never-locked",
    cls: "empty",
    file: ONBOARDING,
    title: "Continue is never locked (unanswered steps fall through to the default profile)",
    expected: "killed",
    edits: [
      {
        find: `  const stepComplete =
    step === 'reveal' || step === 'notifications'
      ? true
      : step === 'name'
        ? firstName.length >= 1
        : answers[step] !== undefined;`,
        replace: `  const stepComplete = true;`,
      },
    ],
  },
  {
    id: "OB08-choice-steps-optional",
    cls: "empty",
    file: ONBOARDING,
    title: "Only the name is required; choice steps continue unanswered (default answers saved)",
    expected: "killed",
    edits: [
      {
        find: `        ? firstName.length >= 1
        : answers[step] !== undefined;`,
        replace: `        ? firstName.length >= 1
        : true;`,
      },
    ],
  },
  {
    id: "OB09-name-optional",
    cls: "empty",
    file: ONBOARDING,
    title: "Name step continues on an empty name (Continue + keyboard Next)",
    expected: "killed",
    edits: [
      {
        find: `        ? firstName.length >= 1
        : answers[step] !== undefined;`,
        replace: `        ? true
        : answers[step] !== undefined;`,
      },
      {
        find: `                    if (firstName.length >= 1) goForward();`,
        replace: `                    goForward();`,
      },
    ],
  },
  {
    id: "OB10-finish-despite-failed-stash",
    cls: "stash",
    file: ONBOARDING,
    title: "Pre-auth finish hands off to sign-in even when the stash write failed",
    expected: "killed",
    edits: [
      {
        find: `        const ok = await completePreAuthOnboarding(answeredProfile);
        if (ok) props.onFinished?.();
        return;`,
        replace: `        await completePreAuthOnboarding(answeredProfile);
        props.onFinished?.();
        return;`,
      },
    ],
  },
  {
    id: "OB11-preauth-saves-instead-of-stash",
    cls: "stash",
    file: ONBOARDING,
    title: "Pre-auth finish calls completeOnboarding (owner write) instead of the stash",
    expected: "killed",
    edits: [
      {
        find: `        const ok = await completePreAuthOnboarding(answeredProfile);
        if (ok) props.onFinished?.();
        return;`,
        replace: `        await completeOnboarding(answeredProfile);
        props.onFinished?.();
        return;`,
      },
    ],
  },
  {
    id: "OB12-reveal-finishes-directly",
    cls: "reorder",
    file: ONBOARDING,
    title: "Reveal's Continue finishes setup immediately (notification step removed from the flow)",
    expected: "killed",
    edits: [
      {
        find: `            <Button label="Continue" variant="dark" onPress={goForward} />`,
        replace: `            <Button
              label="Continue"
              variant="dark"
              onPress={() => void finishOnboarding('not_now')}
            />`,
      },
    ],
  },
  {
    id: "OB13-steps-reordered",
    cls: "reorder",
    file: ONBOARDING,
    title: "Question order changed (goal asked before level)",
    expected: "killed",
    edits: [
      {
        find: `const STEPS = [
  'name',
  'gender',
  'level',
  'handedness',
  'goal',
  'problem',`,
        replace: `const STEPS = [
  'name',
  'gender',
  'goal',
  'handedness',
  'level',
  'problem',`,
      },
    ],
  },
  {
    id: "OB14-preauth-leave-setup-too",
    cls: "skip",
    file: ONBOARDING,
    title: 'Pre-auth step one renders the account-mode "Leave setup" close control instead of Back',
    expected: "killed",
    edits: [
      {
        find: `          ) : preAuth ? (
            <PressableScale
              accessibilityLabel="Back"
              accessibilityHint="Return to the welcome screen"`,
        replace: `          ) : !preAuth ? (
            <PressableScale
              accessibilityLabel="Back"
              accessibilityHint="Return to the welcome screen"`,
      },
    ],
  },
  {
    id: "OB15-double-tap-hands-off",
    cls: "skip",
    file: ONBOARDING,
    title: "A second tap while finishing hands off to sign-in although the stash is still pending",
    expected: "killed",
    edits: [
      {
        find: `  const finishOnboarding = async (choice: NotificationOnboardingChoice) => {
    if (notificationBusy || onboardingBusy) return;`,
        replace: `  const finishOnboarding = async (choice: NotificationOnboardingChoice) => {
    if (notificationBusy || onboardingBusy) {
      if (preAuth) props.onFinished?.();
      return;
    }`,
      },
    ],
  },
  // Second-order mutants: written AFTER the first matrix, aimed at evading
  // the new tap-target ledger pin (labelled onPress controls only).
  {
    id: "OB16-name-submit-hands-off",
    cls: "skip",
    file: ONBOARDING,
    title:
      "Keyboard Next on an EMPTY name hands off to sign-in pre-auth (skip with no pressable at all; Next with a name still advances)",
    expected: "unknown",
    edits: [
      {
        find: `                  onSubmitEditing={() => {
                    if (firstName.length >= 1) goForward();
                  }}`,
        replace: `                  onSubmitEditing={() => {
                    if (firstName.length >= 1) goForward();
                    else if (preAuth) props.onFinished?.();
                  }}`,
      },
    ],
  },
  {
    id: "OB17-unlabelled-skip-pressable",
    cls: "skip",
    file: ONBOARDING,
    title:
      "Pre-auth header grows an UNLABELLED raw Pressable (no accessibilityLabel, no text) that hands off to sign-in",
    expected: "unknown",
    edits: [
      {
        find: `import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,`,
        replace: `import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,`,
      },
      {
        find: `        <Text style={[type.micro, styles.stepCount]}>
          {stepIndex + 1}/{STEPS.length}
        </Text>
      </View>`,
        replace: `        <Text style={[type.micro, styles.stepCount]}>
          {stepIndex + 1}/{STEPS.length}
        </Text>
        {preAuth ? (
          <Pressable
            hitSlop={24}
            onPress={() => props.onFinished?.()}
            style={styles.headerButton}
          />
        ) : null}
      </View>`,
      },
    ],
  },
  {
    id: "OB18-back-longpress-hands-off",
    cls: "skip",
    file: ONBOARDING,
    title:
      "Pre-auth step-one Back keeps its PressableScale but its icon gains a LONG-press-only raw Pressable that hands off to sign-in",
    expected: "unknown",
    edits: [
      {
        find: `import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,`,
        replace: `import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,`,
      },
      {
        find: `          ) : preAuth ? (
            <PressableScale
              accessibilityLabel="Back"
              accessibilityHint="Return to the welcome screen"
              hitSlop={12}
              onPress={leaveOnboarding}
              style={styles.headerButton}
            >
              <Icon name="back" size={20} color={color.onDark} />
            </PressableScale>`,
        replace: `          ) : preAuth ? (
            <PressableScale
              accessibilityLabel="Back"
              accessibilityHint="Return to the welcome screen"
              hitSlop={12}
              onPress={leaveOnboarding}
              style={styles.headerButton}
            >
              <Pressable onLongPress={() => props.onFinished?.()}>
                <Icon name="back" size={20} color={color.onDark} />
              </Pressable>
            </PressableScale>`,
      },
    ],
  },
  {
    id: "OB19-progress-tap-hands-off",
    cls: "skip",
    file: ONBOARDING,
    title:
      "The step counter text becomes tappable (Text onPress, no label) and hands off to sign-in pre-auth",
    expected: "unknown",
    edits: [
      {
        find: `        <Text style={[type.micro, styles.stepCount]}>
          {stepIndex + 1}/{STEPS.length}
        </Text>
      </View>`,
        replace: `        <Text
          style={[type.micro, styles.stepCount]}
          onPress={preAuth ? () => props.onFinished?.() : undefined}
        >
          {stepIndex + 1}/{STEPS.length}
        </Text>
      </View>`,
      },
    ],
  },

  // Third-order mutants (adversarial test of the XCM-13 pins, 83596ca2): each
  // one adds a control or gesture that reaches sign-in / the app before the
  // questionnaire is finished WITHOUT an `onPress`, a label, or any of the five
  // gesture props the control-ledger pin enumerates (onLongPress, onDoubleTap,
  // onMagicTap, onAccessibilityEscape, onAccessibilityAction). `expected` is
  // the pin's own claim ("any control/gesture that reaches sign-in"); on
  // 83596ca2 every one of them SURVIVES the full suite.
  {
    id: "OB20-pressin-unlabelled-hands-off",
    cls: "skip",
    file: ONBOARDING,
    title: "Unlabelled raw Pressable with onPressIn only (no onPress) hands off pre-auth",
    expected: "killed",
    edits: [
      {
        find: `import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,`,
        replace: `import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,`,
      },
      {
        find: `        <Text style={[type.micro, styles.stepCount]}>
          {stepIndex + 1}/{STEPS.length}
        </Text>
      </View>`,
        replace: `        <Text style={[type.micro, styles.stepCount]}>
          {stepIndex + 1}/{STEPS.length}
        </Text>
        {preAuth ? (
          <Pressable
            hitSlop={24}
            onPressIn={() => props.onFinished?.()}
            style={styles.headerButton}
          />
        ) : null}
      </View>`,
      },
    ],
  },
  {
    id: "OB21-touchend-view-hands-off",
    cls: "skip",
    file: ONBOARDING,
    title: "Plain View with onTouchEnd hands off pre-auth",
    expected: "killed",
    edits: [
      {
        find: `        <Text style={[type.micro, styles.stepCount]}>
          {stepIndex + 1}/{STEPS.length}
        </Text>
      </View>`,
        replace: `        <Text style={[type.micro, styles.stepCount]}>
          {stepIndex + 1}/{STEPS.length}
        </Text>
        {preAuth ? (
          <View
            onTouchEnd={() => props.onFinished?.()}
            style={styles.headerButton}
          />
        ) : null}
      </View>`,
      },
    ],
  },
  {
    id: "OB22-accessibilitytap-hands-off",
    cls: "skip",
    file: ONBOARDING,
    title: "Raw Pressable with onAccessibilityTap only hands off pre-auth",
    expected: "killed",
    edits: [
      {
        find: `import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,`,
        replace: `import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,`,
      },
      {
        find: `        <Text style={[type.micro, styles.stepCount]}>
          {stepIndex + 1}/{STEPS.length}
        </Text>
      </View>`,
        replace: `        <Text style={[type.micro, styles.stepCount]}>
          {stepIndex + 1}/{STEPS.length}
        </Text>
        {preAuth ? (
          <Pressable
            accessible
            onAccessibilityTap={() => props.onFinished?.()}
            style={styles.headerButton}
          />
        ) : null}
      </View>`,
      },
    ],
  },
  {
    id: "OB23-back-pressout-hands-off",
    cls: "skip",
    file: ONBOARDING,
    title: "Back icon gains nested raw Pressable with onPressOut hands off (OB18 with onPressOut)",
    expected: "killed",
    edits: [
      {
        find: `import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,`,
        replace: `import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,`,
      },
      {
        find: `              onPress={leaveOnboarding}
              style={styles.headerButton}
            >
              <Icon name="back" size={20} color={color.onDark} />
            </PressableScale>`,
        replace: `              onPress={leaveOnboarding}
              style={styles.headerButton}
            >
              <Pressable onPressOut={() => props.onFinished?.()}>
                <Icon name="back" size={20} color={color.onDark} />
              </Pressable>
            </PressableScale>`,
      },
    ],
  },
  {
    id: "OB24-name-magic-word-hands-off",
    cls: "skip",
    file: ONBOARDING,
    title: "Typing a magic word into the name field hands off pre-auth",
    expected: "killed",
    edits: [
      {
        find: `                  onChangeText={text => select('name', text)}`,
        replace: `                  onChangeText={text => {
                    select('name', text);
                    if (preAuth && text.trim().toLowerCase() === 'skip') {
                      props.onFinished?.();
                    }
                  }}`,
      },
    ],
  },
  {
    id: "OB25-name-endediting-hands-off",
    cls: "skip",
    file: ONBOARDING,
    title:
      "Name field onEndEditing (fires with keyboard Next on device) hands off on empty name pre-auth",
    expected: "killed",
    edits: [
      {
        find: `                  onSubmitEditing={() => {
                    if (firstName.length >= 1) goForward();
                  }}`,
        replace: `                  onSubmitEditing={() => {
                    if (firstName.length >= 1) goForward();
                  }}
                  onEndEditing={() => {
                    if (firstName.length === 0 && preAuth) props.onFinished?.();
                  }}`,
      },
    ],
  },
  {
    id: "OB26-scroll-swipe-hands-off",
    cls: "skip",
    file: ONBOARDING,
    title: "ScrollView onScrollEndDrag (swipe) hands off pre-auth",
    expected: "killed",
    edits: [
      {
        find: `function LockedScroll(props: {
  children: React.ReactNode;
  bottomInset: number;
}) {`,
        replace: `function LockedScroll(props: {
  children: React.ReactNode;
  bottomInset: number;
  onSwipe?: () => void;
}) {`,
      },
      {
        find: `      onLayout={e => setViewport(e.nativeEvent.layout.height)}`,
        replace: `      onScrollEndDrag={props.onSwipe}
      onLayout={e => setViewport(e.nativeEvent.layout.height)}`,
      },
      {
        find: `          <LockedScroll key={step} bottomInset={space.lg}>`,
        replace: `          <LockedScroll
            key={step}
            bottomInset={space.lg}
            onSwipe={preAuth ? () => props.onFinished?.() : undefined}
          >`,
      },
    ],
  },
  {
    id: "OB27-continue-double-tap-hands-off",
    cls: "skip",
    file: ONBOARDING,
    title: "Pressing Continue on the name step twice within the same render hands off pre-auth",
    expected: "killed",
    edits: [
      {
        find: `  const goForward = () => setStepIndex(i => Math.min(i + 1, STEPS.length - 1));`,
        replace: `  const tapsRef = useRef(0);
  const goForward = () => {
    tapsRef.current += 1;
    if (preAuth && tapsRef.current >= 2 && stepIndex === 0) {
      props.onFinished?.();
      return;
    }
    setStepIndex(i => Math.min(i + 1, STEPS.length - 1));
  };`,
      },
      {
        find: `import React, { useState } from 'react';`,
        replace: `import React, { useRef, useState } from 'react';`,
      },
    ],
  },
  {
    id: "OB28-account-pressin-saves-default",
    cls: "empty",
    file: ONBOARDING,
    title:
      "In-account header grows an unlabelled Pressable whose onPressIn saves the default profile (OB03 without onPress)",
    expected: "killed",
    edits: [
      {
        find: `import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,`,
        replace: `import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,`,
      },
      {
        find: `        <Text style={[type.micro, styles.stepCount]}>
          {stepIndex + 1}/{STEPS.length}
        </Text>
      </View>`,
        replace: `        <Text style={[type.micro, styles.stepCount]}>
          {stepIndex + 1}/{STEPS.length}
        </Text>
        {preAuth ? null : (
          <Pressable
            hitSlop={24}
            onPressIn={() => void completeOnboarding(answeredProfile)}
            style={styles.headerButton}
          />
        )}
      </View>`,
      },
    ],
  },
  {
    id: "OB29-name-focus-hands-off",
    cls: "skip",
    file: ONBOARDING,
    title: "Name TextInput onFocus hands off pre-auth",
    expected: "killed",
    edits: [
      {
        find: `                  onChangeText={text => select('name', text)}`,
        replace: `                  onChangeText={text => select('name', text)}
                  onFocus={preAuth ? () => props.onFinished?.() : undefined}`,
      },
    ],
  },
  {
    id: "OB30-idle-timer-hands-off",
    cls: "skip",
    file: ONBOARDING,
    title: "Pre-auth step one auto-hands off to sign-in after 15s idle (no control at all)",
    expected: "killed",
    edits: [
      {
        find: `import React, { useState } from 'react';`,
        replace: `import React, { useEffect, useState } from 'react';`,
      },
      {
        find: `  const goForward = () => setStepIndex(i => Math.min(i + 1, STEPS.length - 1));`,
        replace: `  useEffect(() => {
    if (!preAuth || stepIndex !== 0) return;
    const t = setTimeout(() => props.onFinished?.(), 15000);
    return () => clearTimeout(t);
  }, [preAuth, stepIndex, props]);
  const goForward = () => setStepIndex(i => Math.min(i + 1, STEPS.length - 1));`,
      },
    ],
  },
  {
    id: "OB31-name-keypress-hands-off",
    cls: "skip",
    file: ONBOARDING,
    title: "Name TextInput onKeyPress hands off pre-auth on an empty name",
    expected: "killed",
    edits: [
      {
        find: `                  onChangeText={text => select('name', text)}`,
        replace: `                  onChangeText={text => select('name', text)}
                  onKeyPress={() => {
                    if (preAuth && firstName.length === 0) props.onFinished?.();
                  }}`,
      },
    ],
  },

  // ───────────────────────── WelcomeScreen.tsx ────────────────────────────
  {
    id: "WS01-primary-cta-signin",
    cls: "skip",
    file: WELCOME,
    title: "Welcome primary CTA fires onSignIn when available (skips the questionnaire)",
    expected: "killed",
    edits: [
      {
        find: `          label="Start your first read"
          variant="volt"
          onPress={props.onGetStarted}`,
        replace: `          label="Start your first read"
          variant="volt"
          onPress={props.onSignIn ?? props.onGetStarted}`,
      },
    ],
  },
  {
    id: "WS02-third-cta",
    cls: "skip",
    file: WELCOME,
    title: 'Welcome grows a third "Look around first" pressable routed to sign-in',
    expected: "killed",
    edits: [
      {
        find: `        <Text style={styles.privacy}>
          Two successful validated ratings free · Unscored attempts don’t count
        </Text>`,
        replace: `        {props.onSignIn ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Look around first"
            accessibilityHint="Sign in without setup"
            onPress={props.onSignIn}
            style={styles.signInLink}
          >
            <Text style={[type.bodyBold, { color: color.onDarkMuted }]}>
              Look around first
            </Text>
          </PressableScale>
        ) : null}
        <Text style={styles.privacy}>
          Two successful validated ratings free · Unscored attempts don’t count
        </Text>`,
      },
    ],
  },

  // ───────────────────────── appStore.ts (stash + profile) ─────────────────
  {
    id: "AS01-null-profile-defaulted",
    cls: "empty",
    file: APP_STORE,
    title: "hydrate() substitutes a default profile when the owner has none (gate sees a profile)",
    expected: "killed",
    edits: [
      {
        find: `        profile: raw ? (JSON.parse(raw) as Profile) : null,
        hydrated: true,`,
        replace: `        profile: raw
          ? (JSON.parse(raw) as Profile)
          : {
              skillLevel: '3.0',
              handedness: 'right',
              goal: 'all-around',
              biggestProblem: 'not sure',
              focusCheckpoint: 'contact_position',
            },
        hydrated: true,`,
      },
    ],
  },
  {
    id: "AS02-stash-adopted-signed-out",
    cls: "stash",
    file: APP_STORE,
    title: "Pre-auth stash is adopted by the signed-out owner (profile appears before any sign-in)",
    expected: "killed",
    edits: [
      {
        find: `        pending &&
        owner !== SIGNED_OUT_DATA_OWNER &&
        getActiveDataOwner() === owner`,
        replace: `        pending &&
        getActiveDataOwner() === owner`,
      },
    ],
  },
  {
    id: "AS03-stash-not-cleared",
    cls: "stash",
    file: APP_STORE,
    title: "Adopted stash is never cleared (re-adopted on every hydrate, overwriting later edits)",
    expected: "killed",
    edits: [
      {
        find: `          await setKv(db, PENDING_ONBOARDING_PROFILE_KV_KEY, '');
          pending = null;`,
        replace: `          pending = null;`,
      },
    ],
  },
  {
    id: "AS04-stash-write-skipped",
    cls: "stash",
    file: APP_STORE,
    title: "completePreAuthOnboarding reports success without writing the stash",
    expected: "killed",
    edits: [
      {
        find: `      await setKv(
        getDb(),
        PENDING_ONBOARDING_PROFILE_KV_KEY,
        JSON.stringify({ version: 1, profile }),
      );
      set({ onboardingBusy: false, onboardingError: null });
      return true;`,
        replace: `      set({ onboardingBusy: false, onboardingError: null });
      return true;`,
      },
    ],
  },
  {
    id: "AS05-stash-validation-dropped",
    cls: "stash",
    file: APP_STORE,
    title: "parsePendingProfile accepts any object as a profile (no required-field check)",
    expected: "killed",
    edits: [
      {
        find: `    for (const key of requiredStrings) {
      if (typeof candidate[key] !== 'string') return null;
    }
    return profile as Profile;`,
        replace: `    void candidate;
    void requiredStrings;
    return profile as Profile;`,
      },
    ],
  },
  {
    id: "AS06-existing-profile-wins",
    cls: "stash",
    file: APP_STORE,
    title: "An existing owner profile is kept over a fresh stash (newest intent loses)",
    expected: "killed",
    edits: [
      {
        find: `        pending &&
        owner !== SIGNED_OUT_DATA_OWNER &&
        getActiveDataOwner() === owner`,
        replace: `        pending &&
        !raw &&
        owner !== SIGNED_OUT_DATA_OWNER &&
        getActiveDataOwner() === owner`,
      },
    ],
  },
  {
    id: "AS07-canonical-adopts-locally",
    cls: "stash",
    file: APP_STORE,
    title: "Canonical accounts adopt the stash locally without the server save",
    expected: "killed",
    edits: [
      {
        find: `          const adopted =
            apiSession &&
            canonicalDataOwner(apiSession.canonicalAppUserId) === owner
              ? await saveCanonicalOnboardingProfile(apiSession, pending)
              : pending;`,
        replace: `          const adopted = pending;`,
      },
    ],
  },
  {
    id: "AS08-failed-save-clears-stash",
    cls: "stash",
    file: APP_STORE,
    title: "A failed canonical save still clears the stash (answers lost)",
    expected: "killed",
    edits: [
      {
        find: `        } catch {
          // Stash and existing profile both survive for the next attempt.
        }`,
        replace: `        } catch {
          await setKv(db, PENDING_ONBOARDING_PROFILE_KV_KEY, '');
          pending = null;
        }`,
      },
    ],
  },
];
