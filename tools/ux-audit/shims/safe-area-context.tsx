/**
 * `react-native-safe-area-context` alias. Insets come from the scenario's
 * device profile (set by the harness before render) so notch/home-indicator
 * padding matches the simulated iPhone.
 */
import React from "react";
import { StyleSheet, View } from "./react-native";

export type Edge = "top" | "right" | "bottom" | "left";
export interface EdgeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

let insets: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
let frame = { x: 0, y: 0, width: 0, height: 0 };

export function __setSafeArea(
  next: EdgeInsets,
  nextFrame: { width: number; height: number },
): void {
  insets = next;
  frame = { x: 0, y: 0, ...nextFrame };
}

export const initialWindowMetrics = {
  get insets() {
    return insets;
  },
  get frame() {
    return frame;
  },
};

export function useSafeAreaInsets(): EdgeInsets {
  return insets;
}

export function useSafeAreaFrame() {
  return frame;
}

export function SafeAreaProvider(props: { children?: React.ReactNode }) {
  return <>{props.children}</>;
}

export function SafeAreaView(props: {
  children?: React.ReactNode;
  edges?: readonly Edge[] | Partial<Record<Edge, unknown>>;
  style?: unknown;
  testID?: string;
}) {
  const edges: Edge[] = Array.isArray(props.edges)
    ? [...(props.edges as Edge[])]
    : props.edges && typeof props.edges === "object"
      ? (Object.keys(props.edges) as Edge[])
      : ["top", "right", "bottom", "left"];
  // The real component ADDS the inset to whatever padding the style declares.
  const flat = (StyleSheet.flatten(props.style as never) ?? {}) as Record<string, unknown>;
  const base = (side: string, axis: string): number => {
    const value = flat[side] ?? flat[axis] ?? flat.padding ?? 0;
    return typeof value === "number" ? value : 0;
  };
  const padding = {
    paddingTop: base("paddingTop", "paddingVertical") + (edges.includes("top") ? insets.top : 0),
    paddingBottom:
      base("paddingBottom", "paddingVertical") + (edges.includes("bottom") ? insets.bottom : 0),
    paddingLeft:
      base("paddingLeft", "paddingHorizontal") + (edges.includes("left") ? insets.left : 0),
    paddingRight:
      base("paddingRight", "paddingHorizontal") + (edges.includes("right") ? insets.right : 0),
  };
  return (
    <View
      testID={props.testID}
      style={[props.style as never, padding]}
      accessibilityLabel={undefined}
    >
      {props.children}
    </View>
  );
}
