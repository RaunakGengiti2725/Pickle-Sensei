/**
 * Browser entry for the UX audit harness. Exposes `window.__ux` so the
 * Playwright driver (run.mjs) can render a scenario, wait for layout, and
 * pull the measured tree.
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { __setFontScale, View } from "../shims/react-native";
import { __setSafeArea } from "../shims/safe-area-context";
import { __setVideoMode, type VideoMode } from "../shims/video";
import { __setStoreState, calls, type HarnessStoreState } from "../shims/stores";
import { measure, type UxSnapshot } from "./measure";
import { WelcomeScreen } from "../../../apps/mobile/src/screens/WelcomeScreen";
import { SplashScreen } from "../../../apps/mobile/src/screens/SplashScreen";
import { SignInScreen } from "../../../apps/mobile/src/screens/SignInScreen";
import { OnboardingScreen } from "../../../apps/mobile/src/screens/OnboardingScreen";

export interface Scenario {
  screen: "welcome" | "splash" | "signin" | "onboarding";
  fontScale: number;
  insets: { top: number; right: number; bottom: number; left: number };
  splash?: { ready: boolean; video: VideoMode };
  onboarding?: { mode: "account" | "preauth" };
  store?: HarnessStoreState;
}

interface UxApi {
  render: (scenario: Scenario) => Promise<void>;
  measure: () => UxSnapshot;
  calls: () => unknown[];
  events: () => string[];
  unmount: () => void;
}

declare global {
  interface Window {
    __ux: UxApi;
  }
}

const events: string[] = [];
let root: Root | null = null;
const container = document.getElementById("root") as HTMLElement;

function ScreenFor(props: { scenario: Scenario }) {
  const s = props.scenario;
  switch (s.screen) {
    case "welcome":
      return (
        <WelcomeScreen
          onGetStarted={() => events.push("welcome.onGetStarted")}
          onSignIn={() => events.push("welcome.onSignIn")}
        />
      );
    case "splash":
      return (
        <SplashScreen
          ready={s.splash?.ready ?? true}
          onFinished={() => events.push("splash.onFinished")}
        />
      );
    case "signin":
      return <SignInScreen onBack={() => events.push("signin.onBack")} />;
    case "onboarding":
      return (
        <OnboardingScreen
          mode={s.onboarding?.mode ?? "preauth"}
          onFinished={() => events.push("onboarding.onFinished")}
          onBack={() => events.push("onboarding.onBack")}
        />
      );
  }
}

function nextFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const tick = (left: number) => {
      if (left <= 0) return resolve();
      requestAnimationFrame(() => tick(left - 1));
    };
    tick(count);
  });
}

window.__ux = {
  async render(scenario) {
    events.length = 0;
    calls.length = 0;
    __setFontScale(scenario.fontScale);
    __setSafeArea(scenario.insets, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    __setVideoMode(scenario.splash?.video ?? "progress");
    __setStoreState(
      scenario.store ?? {
        app: { onboardingBusy: false, onboardingError: null },
        auth: { busy: false, error: null },
      },
    );
    if (root) {
      root.unmount();
      root = null;
    }
    await document.fonts.ready;
    root = createRoot(container);
    root.render(
      <View style={{ width: "100%", height: "100%" }}>
        <ScreenFor scenario={scenario} />
      </View>,
    );
    // Two frames for layout + the LockedScroll onLayout/onContentSizeChange
    // round trip, then a settle for the Video shim's deferred onProgress.
    await nextFrames(3);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await nextFrames(2);
  },
  measure,
  calls: () => [...calls],
  events: () => [...events],
  unmount() {
    root?.unmount();
    root = null;
  },
};
