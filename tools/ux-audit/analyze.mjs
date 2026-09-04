/**
 * Pure analysis over a measured snapshot (harness/measure.ts output). Each
 * rule returns violation records that carry the offending node(s) so the
 * rendered-tree evidence travels with the finding.
 *
 * Severity here is a triage hint only; the final report re-grades findings.
 */

export const MIN_TARGET = 44;

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
  "progressbar",
]);

export function isControl(node) {
  if (node.tag === "input" || node.tag === "textarea" || node.tag === "button") return true;
  if (node.role && CONTROL_ROLES.has(node.role) && node.role !== "progressbar") return true;
  return node.tabIndex === 0 && node.kind === "Pressable";
}

function hasHiddenAncestor(node, byId) {
  let cursor = node.parent === null ? null : byId.get(node.parent);
  while (cursor) {
    if (cursor.ariaHidden || cursor.hidesSubtree) return true;
    cursor = cursor.parent === null ? null : byId.get(cursor.parent);
  }
  return false;
}

function isAncestor(a, b, byId) {
  let cursor = b.parent === null ? null : byId.get(b.parent);
  while (cursor) {
    if (cursor.id === a.id) return true;
    cursor = cursor.parent === null ? null : byId.get(cursor.parent);
  }
  return false;
}

function hasScrollableAncestor(node, byId) {
  let cursor = node.parent === null ? null : byId.get(node.parent);
  while (cursor) {
    if (cursor.scrollable) return true;
    cursor = cursor.parent === null ? null : byId.get(cursor.parent);
  }
  return false;
}

function describe(node) {
  return {
    id: node.id,
    kind: node.kind,
    tag: node.tag,
    role: node.role,
    label: node.label,
    testID: node.testID,
    text: node.text ? node.text.slice(0, 80) : null,
    rect: node.rect,
    clipRect: node.clipRect,
    fontSize: node.fontSize,
    lineHeight: node.lineHeight,
    props: node.props,
  };
}

function hitSlopOf(node) {
  const slop = node.props?.hitSlop;
  if (typeof slop === "number") return { x: slop, y: slop };
  if (slop && typeof slop === "object") {
    return {
      x: ((slop.left ?? 0) + (slop.right ?? 0)) / 2,
      y: ((slop.top ?? 0) + (slop.bottom ?? 0)) / 2,
    };
  }
  return { x: 0, y: 0 };
}

export function analyze(snapshot) {
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const { w: vw, h: vh } = snapshot.viewport;
  const violations = [];
  const push = (rule, severity, node, detail, extra = {}) =>
    violations.push({ rule, severity, node: describe(node), detail, ...extra });

  if (!snapshot.fontsReady) {
    violations.push({
      rule: "harness-fonts-not-ready",
      severity: "harness",
      node: null,
      detail: "document.fonts.status !== loaded — measurements untrusted",
    });
  }

  const live = snapshot.nodes.filter(
    (n) => n.visible && !n.ariaHidden && !hasHiddenAncestor(n, byId),
  );
  const texts = live.filter((n) => n.kind === "Text" || n.kind === "TextInput");
  // `accessible={false}` pressables (dialog backdrops) are invisible to
  // VoiceOver even though RNW still renders them focusable.
  const controls = live.filter((n) => isControl(n) && n.props?.accessible !== false);
  // A TextInput is both a text and a control; visit each node once.
  const textsAndControls = [...new Set([...texts, ...controls])];

  // 1. Text truncated/clipped inside its own box (numberOfLines, fixed height).
  for (const t of texts) {
    if (!t.textOverflow) continue;
    if (t.kind === "TextInput") {
      // A single-line input scrolls its own value; that is not truncation.
      if (t.textOverflow.horizontal > 1) {
        push(
          "input-scrolls",
          "info",
          t,
          `value ${t.textOverflow.horizontal}px wider than the field (scrolls horizontally)`,
        );
      }
      continue;
    }
    const clipsX = t.overflow.split("/")[0] !== "visible";
    const clipsY = t.overflow.split("/")[1] !== "visible";
    if (clipsX && t.textOverflow.horizontal > 1) {
      push(
        "text-truncated",
        "P2",
        t,
        `horizontal overflow ${t.textOverflow.horizontal}px inside its own clipped box`,
      );
    }
    if (clipsY && t.textOverflow.vertical > 1) {
      push(
        "text-truncated",
        "P2",
        t,
        `vertical overflow ${t.textOverflow.vertical}px inside its own clipped box`,
      );
    }
    // Horizontal overflow of a non-clipping text box: a single unbreakable
    // token wider than the column bleeds outside the layout.
    if (!clipsX && t.textOverflow.horizontal > 1) {
      push(
        "text-overflows-column",
        "P2",
        t,
        `unbreakable token ${t.textOverflow.horizontal}px wider than its column`,
      );
    }
  }

  // 2. Text or control cut by a non-scrolling overflow:hidden ancestor.
  for (const n of textsAndControls) {
    if (n.clippedBy && (n.clippedBy.dx > 1 || n.clippedBy.dy > 1)) {
      const anc = byId.get(n.clippedBy.id);
      // The root container clips to the window; that case is reported by the
      // viewport rule below, not as an ancestor clip.
      if (!anc || anc.parent === null) continue;
      push(
        "clipped-by-ancestor",
        "P2",
        n,
        `cut by ancestor #${n.clippedBy.id} (${anc?.kind ?? anc?.tag}) dx=${n.clippedBy.dx} dy=${n.clippedBy.dy}`,
        {
          ancestor: anc ? describe(anc) : null,
        },
      );
    }
  }

  // 3. Content outside the viewport with no way to scroll to it.
  for (const n of textsAndControls) {
    const r = n.rect;
    const outBottom = Math.max(0, r.y + r.h - vh);
    const outRight = Math.max(0, r.x + r.w - vw);
    const outTop = Math.max(0, -r.y);
    const outLeft = Math.max(0, -r.x);
    const out = Math.max(outBottom, outRight, outTop, outLeft);
    if (out <= 1) continue;
    if (hasScrollableAncestor(n, byId)) {
      push(
        "below-fold",
        "info",
        n,
        `extends ${out.toFixed(1)}px past the viewport inside a scrollable ancestor (reachable by scrolling)`,
      );
    } else {
      const fully = r.y >= vh || r.x >= vw || r.y + r.h <= 0 || r.x + r.w <= 0;
      push(
        "offscreen-unreachable",
        fully ? "P1" : "P2",
        n,
        `${fully ? "entirely" : `${out.toFixed(1)}px`} outside the ${vw}x${vh} viewport with no scrollable ancestor`,
        {
          edges: { bottom: outBottom, right: outRight, top: outTop, left: outLeft },
        },
      );
    }
  }

  // 4. Touch targets < 44pt (effective = rect + hitSlop).
  for (const c of controls) {
    const slop = hitSlopOf(c);
    const w = c.rect.w + 2 * slop.x;
    const h = c.rect.h + 2 * slop.y;
    if (w < MIN_TARGET - 0.5 || h < MIN_TARGET - 0.5) {
      push(
        "touch-target",
        "P2",
        c,
        `effective ${w.toFixed(1)}x${h.toFixed(1)}pt (< ${MIN_TARGET}pt; rect ${c.rect.w}x${c.rect.h}, hitSlop ${JSON.stringify(c.props?.hitSlop ?? null)})`,
      );
    }
  }

  // 5. Controls without an accessible name.
  for (const c of controls) {
    const childText = live
      .filter((n) => n.kind === "Text" && isAncestor(c, n, byId))
      .map((n) => n.text)
      .join(" ")
      .trim();
    const name = c.label || childText || (c.tag === "input" ? c.props?.placeholder : "");
    if (!name) {
      push("unlabeled-control", "P1", c, "no accessibilityLabel and no text content");
    }
    if (c.tag !== "input" && !c.role && c.kind === "Pressable") {
      push("control-without-role", "P2", c, "pressable without an accessibilityRole");
    }
  }

  // 6. Overlapping painted text/controls that are not nested. Painted rects
  //    (clipRect) are used so scroll content hidden under a pinned footer
  //    does not count — only pixels actually drawn on top of each other do.
  //    A sheet inside an `accessibilityViewIsModal` view is drawn over the
  //    (backdropped) screen behind it by design, so a modal descendant is
  //    only compared with other modal descendants.
  const modal = live.find((n) => n.props?.accessibilityViewIsModal === true);
  const inModal = (n) => Boolean(modal) && isAncestor(modal, n, byId);
  const boxes = textsAndControls.filter((n) => n.clipRect.w > 0 && n.clipRect.h > 0);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (isAncestor(a, b, byId) || isAncestor(b, a, byId)) continue;
      if (inModal(a) !== inModal(b)) continue;
      const ra = a.clipRect;
      const rb = b.clipRect;
      const ix = Math.min(ra.x + ra.w, rb.x + rb.w) - Math.max(ra.x, rb.x);
      const iy = Math.min(ra.y + ra.h, rb.y + rb.h) - Math.max(ra.y, rb.y);
      if (ix > 2 && iy > 2) {
        // A text inside a control overlapping another text inside the same
        // control (e.g. mark + label in a provider button) is a real overlap
        // too, so no further exclusions.
        push(
          "overlap",
          "P2",
          a,
          `overlaps #${b.id} (${b.kind} "${(b.label ?? b.text ?? "").slice(0, 40)}") by ${ix.toFixed(1)}x${iy.toFixed(1)}px`,
          {
            other: describe(b),
          },
        );
      }
    }
  }

  // 7. Images / video that failed to load, or accessible images with no name.
  for (const n of snapshot.nodes) {
    if (n.img && n.img.state === "error") {
      push("image-missing", "P1", n, `image failed to load: ${n.img.src}`);
    }
    if (n.video && n.video.state === "error") {
      push("video-missing", "P1", n, `video failed to load: ${n.video.src}`);
    }
    if (n.img && n.props?.accessible === true && !n.label && !n.ariaHidden) {
      push("unlabeled-image", "P2", n, "accessible image with no accessibilityLabel");
    }
  }

  // 8. Focus/reading order vs visual order: a later-focused control sitting
  //    clearly above an earlier one (row tolerance 8px) is flagged.
  //    While an `accessibilityViewIsModal` view is up, only its descendants
  //    are reachable, so the order is restricted to them.
  const order = snapshot.focusOrder
    .map((id) => byId.get(id))
    .filter(Boolean)
    .filter((n) => n.props?.accessible !== false)
    .filter((n) => !modal || isAncestor(modal, n, byId));
  for (let i = 1; i < order.length; i += 1) {
    const prev = order[i - 1];
    const cur = order[i];
    if (cur.rect.y + 8 < prev.rect.y) {
      push(
        "focus-order-vs-visual",
        "P3",
        cur,
        `focused after #${prev.id} ("${prev.label ?? prev.text ?? ""}") but rendered ${(prev.rect.y - cur.rect.y).toFixed(1)}px above it`,
        {
          previous: describe(prev),
        },
      );
    }
  }

  // 9. Text opting out of Dynamic Type.
  for (const t of texts) {
    if (t.props?.allowFontScaling === false) {
      push("font-scaling-disabled", "info", t, "allowFontScaling={false}");
    }
  }

  return {
    counts: {
      nodes: snapshot.nodes.length,
      live: live.length,
      texts: texts.length,
      controls: controls.length,
      violations: violations.length,
    },
    focusOrder: order.map((n) => ({
      id: n.id,
      role: n.role,
      label: n.label ?? n.text,
      y: n.rect.y,
      x: n.rect.x,
    })),
    controls: controls.map(describe),
    violations,
  };
}
