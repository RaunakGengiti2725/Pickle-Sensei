/**
 * `react-native` alias for the browser harness.
 *
 * Re-exports react-native-web and layers on the two things the audit needs
 * that RNW does not model:
 *   1. Dynamic Type — every <Text>/<TextInput> fontSize + lineHeight is
 *      multiplied by the scenario font scale (iOS multiplies both;
 *      `allowFontScaling={false}` / `maxFontSizeMultiplier` are honoured).
 *   2. Evidence attributes — each element records its RN accessibility props,
 *      hitSlop and text-scaling props in `data-ux` so the DOM walker can
 *      report them alongside the measured rectangle.
 *
 * Platform.OS is forced to 'ios' so iOS-only branches (Apple sign-in, safe
 * area fallbacks, KeyboardAvoidingView 'padding') render.
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  type ComponentProps,
  type ComponentType,
} from "react";
import * as RNW from "react-native-web";

export * from "react-native-web";

export const Platform = {
  ...RNW.Platform,
  OS: "ios" as const,
  Version: "18.0",
  isPad: false,
  isTV: false,
  select<T>(spec: { ios?: T; native?: T; default?: T; web?: T }): T | undefined {
    if ("ios" in spec) return spec.ios;
    if ("native" in spec) return spec.native;
    return spec.default;
  },
};

let fontScale = 1;
export function __setFontScale(next: number): void {
  fontScale = next;
}
export function __getFontScale(): number {
  return fontScale;
}

export const PixelRatio = {
  ...RNW.PixelRatio,
  getFontScale: () => fontScale,
};

type UxMeta = Record<string, unknown>;

function pick(props: Record<string, unknown>, keys: string[]): UxMeta {
  const out: UxMeta = {};
  for (const key of keys) {
    if (props[key] !== undefined) out[key] = props[key];
  }
  return out;
}

const A11Y_KEYS = [
  "accessible",
  "accessibilityRole",
  "role",
  "accessibilityLabel",
  "aria-label",
  "accessibilityHint",
  "accessibilityState",
  "accessibilityValue",
  "accessibilityLiveRegion",
  "accessibilityElementsHidden",
  "importantForAccessibility",
  "accessibilityViewIsModal",
  "testID",
  "hitSlop",
  "disabled",
  "numberOfLines",
  "allowFontScaling",
  "maxFontSizeMultiplier",
  "adjustsFontSizeToFit",
  "minimumFontScale",
  "placeholder",
  "maxLength",
  "scrollEnabled",
];

function useUxDataset(kind: string, props: Record<string, unknown>) {
  const nodeRef = useRef<HTMLElement | null>(null);
  const meta = JSON.stringify({ kind, ...pick(props, A11Y_KEYS) });
  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    node.dataset.ux = meta;
    node.dataset.uxKind = kind;
  });
  return nodeRef;
}

function mergeRefs<T>(...refs: Array<React.Ref<T> | undefined>): (instance: T | null) => void {
  return (instance) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(instance);
      else if (ref && typeof ref === "object") {
        (ref as React.MutableRefObject<T | null>).current = instance;
      }
    }
  };
}

function scaleTextStyle(
  style: unknown,
  allowFontScaling: boolean | undefined,
  maxFontSizeMultiplier: number | undefined,
): unknown {
  if (allowFontScaling === false) return style;
  const effective =
    maxFontSizeMultiplier && maxFontSizeMultiplier >= 1
      ? Math.min(fontScale, maxFontSizeMultiplier)
      : fontScale;
  if (effective === 1) return style;
  const flat = RNW.StyleSheet.flatten(style as never) as Record<string, unknown> | undefined;
  if (!flat) return style;
  const next: Record<string, unknown> = { ...flat };
  if (typeof flat.fontSize === "number") {
    next.fontSize = flat.fontSize * effective;
  } else {
    // RN default font size is 14 on iOS when unspecified.
    next.fontSize = 14 * effective;
  }
  if (typeof flat.lineHeight === "number") {
    next.lineHeight = flat.lineHeight * effective;
  }
  return next;
}

type TextProps = ComponentProps<typeof RNW.Text> & {
  allowFontScaling?: boolean;
  maxFontSizeMultiplier?: number;
  numberOfLines?: number;
};

export const Text = forwardRef<HTMLElement, TextProps>(function Text(props, ref) {
  const nodeRef = useUxDataset("Text", props as Record<string, unknown>);
  const style = scaleTextStyle(props.style, props.allowFontScaling, props.maxFontSizeMultiplier);
  const Base = RNW.Text as unknown as ComponentType<Record<string, unknown>>;
  return <Base {...props} style={style} ref={mergeRefs(ref, nodeRef)} />;
});

type TextInputProps = ComponentProps<typeof RNW.TextInput> & {
  allowFontScaling?: boolean;
  maxFontSizeMultiplier?: number;
};

export const TextInput = forwardRef<HTMLElement, TextInputProps>(function TextInput(props, ref) {
  const nodeRef = useUxDataset("TextInput", props as Record<string, unknown>);
  const style = scaleTextStyle(props.style, props.allowFontScaling, props.maxFontSizeMultiplier);
  const Base = RNW.TextInput as unknown as ComponentType<Record<string, unknown>>;
  return <Base {...props} style={style} ref={mergeRefs(ref, nodeRef)} />;
});

function withUxDataset<P extends Record<string, unknown>>(kind: string, Base: ComponentType<P>) {
  return forwardRef<HTMLElement, P>(function Wrapped(props, ref) {
    const nodeRef = useUxDataset(kind, props);
    const merged = useCallback(mergeRefs(ref, nodeRef), [ref, nodeRef]);
    const Component = Base as unknown as ComponentType<Record<string, unknown>>;
    return <Component {...props} ref={merged} />;
  });
}

export const View = withUxDataset(
  "View",
  RNW.View as unknown as ComponentType<Record<string, unknown>>,
);
export const Pressable = withUxDataset(
  "Pressable",
  RNW.Pressable as unknown as ComponentType<Record<string, unknown>>,
);
export const ScrollView = withUxDataset(
  "ScrollView",
  RNW.ScrollView as unknown as ComponentType<Record<string, unknown>>,
);

type ImageProps = ComponentProps<typeof RNW.Image> & {
  source?: unknown;
  onLoad?: (event: unknown) => void;
  onError?: (event: unknown) => void;
};

/** Image records load/error outcome so the walker can report missing assets. */
export const Image = Object.assign(
  forwardRef<HTMLElement, ImageProps>(function Image(props, ref) {
    const nodeRef = useUxDataset("Image", props as Record<string, unknown>);
    const Base = RNW.Image as unknown as ComponentType<Record<string, unknown>>;
    const source = props.source as string | number | { uri?: string } | undefined;
    const uri =
      typeof source === "string"
        ? source
        : typeof source === "object" && source
          ? source.uri
          : String(source);
    return (
      <Base
        {...props}
        ref={mergeRefs(ref, nodeRef, (node) => {
          if (node) {
            node.dataset.uxImg = uri ?? "";
            if (!node.dataset.uxImgState) node.dataset.uxImgState = "pending";
          }
        })}
        onLoad={(event: unknown) => {
          if (nodeRef.current) nodeRef.current.dataset.uxImgState = "loaded";
          props.onLoad?.(event);
        }}
        onError={(event: unknown) => {
          if (nodeRef.current) nodeRef.current.dataset.uxImgState = "error";
          props.onError?.(event);
        }}
      />
    );
  }),
  {
    getSize: RNW.Image.getSize,
    prefetch: RNW.Image.prefetch,
    resolveAssetSource: (source: unknown) => source,
  },
);

/** RNW's StatusBar lacks the imperative stack API SplashScreen uses. */
export const StatusBar = Object.assign(
  function StatusBar(): null {
    return null;
  },
  {
    currentHeight: 0,
    setBarStyle: () => undefined,
    setHidden: () => undefined,
    setBackgroundColor: () => undefined,
    setTranslucent: () => undefined,
    setNetworkActivityIndicatorVisible: () => undefined,
    pushStackEntry: (entry: unknown) => entry,
    popStackEntry: () => undefined,
    replaceStackEntry: (_entry: unknown, next: unknown) => next,
  },
);
