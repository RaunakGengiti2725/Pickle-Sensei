/**
 * Runs inside the page. Walks the rendered DOM and returns one record per
 * element that matters for the audit (text, controls, images, scroll
 * containers, a11y-labelled groups) with its rectangle, computed text
 * metrics, clipping state and the RN props recorded by the shims.
 */
export interface UxNode {
  id: number;
  parent: number | null;
  depth: number;
  tag: string;
  kind: string | null;
  role: string | null;
  label: string | null;
  ariaHidden: boolean;
  ariaLive: string | null;
  ariaDisabled: boolean;
  ariaSelected: boolean | null;
  tabIndex: number | null;
  testID: string | null;
  text: string | null;
  rect: { x: number; y: number; w: number; h: number };
  /** rect intersected with every clipping ancestor (what is actually painted). */
  clipRect: { x: number; y: number; w: number; h: number };
  fontSize: number | null;
  lineHeight: number | null;
  fontFamily: string | null;
  overflow: string;
  scrollable: boolean;
  scroll: { w: number; h: number; cw: number; ch: number } | null;
  textOverflow: { horizontal: number; vertical: number } | null;
  clipAncestor: number | null;
  clippedBy: { id: number; dx: number; dy: number } | null;
  visible: boolean;
  /** display:none / visibility:hidden / opacity≈0 — hides descendants too
   * (a zero-size container with visible overflow does not). */
  hidesSubtree: boolean;
  props: Record<string, unknown> | null;
  img: { src: string; state: string } | null;
  video: { src: string; state: string } | null;
}

export interface UxSnapshot {
  viewport: { w: number; h: number };
  fontsReady: boolean;
  fontFamilies: string[];
  nodes: UxNode[];
  focusOrder: number[];
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function parseProps(el: HTMLElement): Record<string, unknown> | null {
  const raw = el.dataset.ux;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function ownText(el: HTMLElement): string {
  // Text content of this element excluding nested RNW Text children (nested
  // <span> inside a Text is inline content of the same string, keep those).
  let out = "";
  el.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) out += node.textContent ?? "";
    else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as HTMLElement;
      if (child.dataset.uxKind === "Text") return;
      out += ownText(child);
    }
  });
  return out;
}

const CONTROL_ROLES = new Set([
  "button",
  "radio",
  "checkbox",
  "switch",
  "link",
  "textbox",
  "slider",
  "tab",
  "menuitem",
]);

export function isControl(node: UxNode): boolean {
  if (node.tag === "input" || node.tag === "textarea" || node.tag === "button") return true;
  if (node.role && CONTROL_ROLES.has(node.role)) return true;
  return node.tabIndex === 0 && node.kind === "Pressable";
}

export function measure(): UxSnapshot {
  const nodes: UxNode[] = [];
  const ids = new Map<Element, number>();
  const focusOrder: number[] = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const visit = (el: HTMLElement, parent: number | null, depth: number) => {
    const id = nodes.length;
    ids.set(el, id);
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const props = parseProps(el);
    const kind = el.dataset.uxKind ?? null;
    const overflow = `${cs.overflowX}/${cs.overflowY}`;
    const scrollable =
      (cs.overflowY === "auto" || cs.overflowY === "scroll") &&
      el.scrollHeight > el.clientHeight + 1;
    const hidesSubtree =
      cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) <= 0.01;
    const visible = !hidesSubtree && rect.width > 0 && rect.height > 0;

    const isText = kind === "Text" || kind === "TextInput";
    const text = isText
      ? kind === "TextInput"
        ? (el as HTMLInputElement).value || (el as HTMLInputElement).placeholder || ""
        : ownText(el)
      : null;

    let textOverflow: UxNode["textOverflow"] = null;
    if (isText) {
      textOverflow = {
        horizontal: round(el.scrollWidth - el.clientWidth),
        vertical: round(el.scrollHeight - el.clientHeight),
      };
    }

    // Nearest ancestor that clips (overflow hidden/clip, or a scroll view),
    // plus the painted rectangle after every clipping ancestor is applied.
    let clipAncestor: number | null = null;
    let clippedBy: UxNode["clippedBy"] = null;
    let clipLeft = rect.left;
    let clipTop = rect.top;
    let clipRight = rect.right;
    let clipBottom = rect.bottom;
    let cursor: HTMLElement | null = el.parentElement;
    while (cursor && cursor !== document.body) {
      const acs = getComputedStyle(cursor);
      const clips = acs.overflowX !== "visible" || acs.overflowY !== "visible";
      if (clips) {
        const ar = cursor.getBoundingClientRect();
        clipLeft = Math.max(clipLeft, ar.left);
        clipTop = Math.max(clipTop, ar.top);
        clipRight = Math.min(clipRight, ar.right);
        clipBottom = Math.min(clipBottom, ar.bottom);
        if (clipAncestor === null) {
          clipAncestor = ids.get(cursor) ?? null;
          const ancestorScrolls = acs.overflowY === "auto" || acs.overflowY === "scroll";
          if (!ancestorScrolls && visible) {
            const dx =
              Math.max(0, round(rect.right - ar.right)) + Math.max(0, round(ar.left - rect.left));
            const dy =
              Math.max(0, round(rect.bottom - ar.bottom)) + Math.max(0, round(ar.top - rect.top));
            if (dx > 0.5 || dy > 0.5) {
              clippedBy = { id: clipAncestor ?? -1, dx, dy };
            }
          }
        }
      }
      cursor = cursor.parentElement;
    }
    // The window itself clips everything.
    clipLeft = Math.max(clipLeft, 0);
    clipTop = Math.max(clipTop, 0);
    clipRight = Math.min(clipRight, vw);
    clipBottom = Math.min(clipBottom, vh);

    const tabIndexAttr = el.getAttribute("tabindex");
    const node: UxNode = {
      id,
      parent,
      depth,
      tag: el.tagName.toLowerCase(),
      kind,
      role: el.getAttribute("role"),
      label: el.getAttribute("aria-label"),
      ariaHidden: el.getAttribute("aria-hidden") === "true",
      ariaLive: el.getAttribute("aria-live"),
      ariaDisabled: el.getAttribute("aria-disabled") === "true",
      ariaSelected: el.hasAttribute("aria-selected")
        ? el.getAttribute("aria-selected") === "true"
        : null,
      tabIndex: tabIndexAttr === null ? null : Number(tabIndexAttr),
      testID: el.getAttribute("data-testid"),
      text,
      rect: {
        x: round(rect.left),
        y: round(rect.top),
        w: round(rect.width),
        h: round(rect.height),
      },
      clipRect: {
        x: round(clipLeft),
        y: round(clipTop),
        w: round(Math.max(0, clipRight - clipLeft)),
        h: round(Math.max(0, clipBottom - clipTop)),
      },
      fontSize: isText ? round(parseFloat(cs.fontSize)) : null,
      lineHeight: isText
        ? cs.lineHeight === "normal"
          ? null
          : round(parseFloat(cs.lineHeight))
        : null,
      fontFamily: isText ? cs.fontFamily : null,
      overflow,
      scrollable,
      scroll:
        scrollable || cs.overflowY !== "visible"
          ? {
              w: el.scrollWidth,
              h: el.scrollHeight,
              cw: el.clientWidth,
              ch: el.clientHeight,
            }
          : null,
      textOverflow,
      clipAncestor,
      clippedBy,
      visible,
      hidesSubtree,
      props,
      img:
        el.dataset.uxImg !== undefined
          ? { src: el.dataset.uxImg, state: el.dataset.uxImgState ?? "unknown" }
          : null,
      video:
        el.dataset.uxVideo !== undefined
          ? {
              src: el.dataset.uxVideo,
              state: el.dataset.uxVideoState ?? "pending",
            }
          : null,
    };
    nodes.push(node);
    if (
      visible &&
      !node.ariaHidden &&
      (node.tabIndex === 0 || node.tag === "input" || node.tag === "textarea")
    ) {
      focusOrder.push(id);
    }
    for (const child of Array.from(el.children)) {
      visit(child as HTMLElement, id, depth + 1);
    }
  };

  // #root plus any react-native-web Modal portals appended to <body>; the
  // font pre-load div in index.html is skipped by id.
  for (const child of Array.from(document.body.children)) {
    if (child.id === "ux-font-preload" || child.tagName === "SCRIPT") continue;
    visit(child as HTMLElement, null, 0);
  }

  const families = new Set<string>();
  document.fonts.forEach((face) => {
    if (face.status === "loaded") families.add(face.family);
  });

  return {
    viewport: { w: vw, h: vh },
    fontsReady: document.fonts.status === "loaded",
    fontFamilies: [...families],
    nodes,
    focusOrder,
  };
}
