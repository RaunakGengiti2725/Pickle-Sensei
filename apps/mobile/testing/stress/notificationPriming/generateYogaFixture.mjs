/**
 * Regenerates `yogaLayout.fixture.json`: the actions-row geometry of
 * NotificationPrimingCard computed by REAL Yoga (yoga-layout@3 WASM — the
 * flexbox engine React Native embeds), used to pin the pure-TypeScript model
 * in `layout.ts` (react-test-renderer produces no geometry, and yoga-layout
 * is deliberately not an app dependency).
 *
 * Run from apps/mobile in a throwaway directory that has yoga-layout@3:
 *   mkdir -p /tmp/yoga && cd /tmp/yoga && npm i yoga-layout@3
 *   node /path/to/apps/mobile/testing/stress/notificationPriming/generateYogaFixture.mjs \
 *     /path/to/apps/mobile/testing/stress/notificationPriming/fontMetrics.fixture.json \
 *     /path/to/apps/mobile/testing/stress/notificationPriming/yogaLayout.fixture.json
 *
 * Node geometry mirrors the real styles: HomeScreen content
 * paddingHorizontal 24; card padding 16 / gap 16 / hairline border; 40pt icon
 * slot; copy column flex 1 minWidth 0; actions row gap 8; slot minWidth 96
 * flexGrow 0 alignSelf flex-start; pill paddingHorizontal 16 borderWidth 1
 * minHeight 44; caption 13/18.
 */
import {
  loadYoga,
  Direction,
  Edge,
  FlexDirection,
  Gutter,
  Justify,
  Align,
  MeasureMode,
} from 'yoga-layout/load';
import fs from 'node:fs';

const [, , metricsPath, outPath] = process.argv;
const Yoga = await loadYoga();
// iPhone @3x: Yoga rounds computed geometry to the device pixel grid.
const CONFIG = Yoga.Config.create();
CONFIG.setPointScaleFactor(3);
const createNode = () => Yoga.Node.createWithConfig(CONFIG);
const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8')).fonts;
const MED = metrics.Manrope_500Medium;
const SEMI = metrics.Manrope_600SemiBold;

const SCREEN_PAD = 24;
const CARD_PAD = 16;
const CARD_GAP = 16;
const HAIRLINE = 1 / 3;
const ICON = 40;
const ACTIONS_GAP = 8;
const SLOT_MIN_WIDTH = 96;
const PILL_PAD_H = 16;
const PILL_BORDER = 1;
const PILL_MIN_HEIGHT = 44;

function textWidth(str, font, fontPx) {
  const kerned = font.stringEm[str];
  const em =
    kerned ??
    [...str].reduce((acc, ch) => acc + (font.advanceEm[ch] ?? 0.6), 0);
  return em * fontPx;
}

function wrap(str, font, fontPx, maxWidth) {
  const lines = [];
  let cur = '';
  for (const w of str.split(' ')) {
    const cand = cur ? `${cur} ${w}` : w;
    if (cur && textWidth(cand, font, fontPx) > maxWidth) {
      lines.push(cur);
      cur = w;
    } else cur = cand;
  }
  if (cur) lines.push(cur);
  return lines;
}

function textNode(str, font, fontSize, lineHeight, fontScale) {
  const node = createNode();
  const fontPx = fontSize * fontScale;
  const lh = lineHeight * fontScale;
  node.setMeasureFunc((width, widthMode) => {
    const natural = textWidth(str, font, fontPx);
    if (widthMode === MeasureMode.Undefined || natural <= width) {
      return { width: natural, height: lh };
    }
    const lines = wrap(str, font, fontPx, width);
    const w = Math.max(...lines.map(l => textWidth(l, font, fontPx)));
    return { width: Math.min(w, width), height: lh * lines.length };
  });
  return node;
}

function pill(label, fontScale) {
  const slot = createNode();
  slot.setFlexGrow(0);
  slot.setAlignSelf(Align.FlexStart);
  slot.setMinWidth(SLOT_MIN_WIDTH);
  const press = createNode();
  press.setMinHeight(PILL_MIN_HEIGHT);
  press.setPadding(Edge.Horizontal, PILL_PAD_H);
  press.setBorder(Edge.All, PILL_BORDER);
  press.setAlignItems(Align.Center);
  press.setJustifyContent(Justify.Center);
  press.insertChild(textNode(label, MED, 13, 18, fontScale), 0);
  slot.insertChild(press, 0);
  return { slot, press };
}

function layoutCard({ screenWidth, fontScale, primaryLabel, failed }) {
  const root = createNode();
  root.setWidth(screenWidth);
  root.setPadding(Edge.Horizontal, SCREEN_PAD);

  const card = createNode();
  card.setFlexDirection(FlexDirection.Row);
  card.setGap(Gutter.All, CARD_GAP);
  card.setPadding(Edge.All, CARD_PAD);
  card.setBorder(Edge.All, HAIRLINE);
  root.insertChild(card, 0);

  const icon = createNode();
  icon.setWidth(ICON);
  icon.setHeight(ICON);
  card.insertChild(icon, 0);

  const copy = createNode();
  copy.setFlexGrow(1);
  copy.setFlexShrink(1);
  copy.setFlexBasis(0);
  copy.setMinWidth(0);
  card.insertChild(copy, 1);

  const title = textNode('A nudge on practice days?', SEMI, 16, 22, fontScale);
  const body = textNode(
    'One daily reminder, plus a heads-up before a streak slips. Scheduled on this phone only.',
    MED,
    13,
    18,
    fontScale,
  );
  body.setMargin(Edge.Top, 3);
  copy.insertChild(title, 0);
  copy.insertChild(body, 1);
  let index = 2;
  if (failed) {
    const failure = textNode(
      'Reminders couldn’t be turned on. Try again, or allow notifications for Pickle Sensei in your phone’s Settings.',
      MED,
      13,
      18,
      fontScale,
    );
    failure.setMargin(Edge.Top, 8);
    copy.insertChild(failure, index++);
  }
  const actions = createNode();
  actions.setFlexDirection(FlexDirection.Row);
  actions.setGap(Gutter.All, ACTIONS_GAP);
  actions.setMargin(Edge.Top, 10);
  copy.insertChild(actions, index);
  const primary = pill(primaryLabel, fontScale);
  const secondary = pill('Not now', fontScale);
  actions.insertChild(primary.slot, 0);
  actions.insertChild(secondary.slot, 1);

  root.calculateLayout(screenWidth, undefined, Direction.LTR);

  const abs = (node, ancestors) => {
    let x = node.getComputedLeft();
    let y = node.getComputedTop();
    for (const a of ancestors) {
      x += a.getComputedLeft();
      y += a.getComputedTop();
    }
    return { x, y, w: node.getComputedWidth(), h: node.getComputedHeight() };
  };
  const cardBox = abs(card, [root]);
  const copyBox = abs(copy, [card, root]);
  const p = abs(primary.slot, [actions, copy, card, root]);
  const s = abs(secondary.slot, [actions, copy, card, root]);
  const pPress = abs(primary.press, [primary.slot, actions, copy, card, root]);
  const sPress = abs(secondary.press, [
    secondary.slot,
    actions,
    copy,
    card,
    root,
  ]);
  const rowRight = s.x + s.w;
  const out = {
    screenWidth,
    fontScale,
    primaryLabel,
    failed,
    copyColumnWidth: copyBox.w,
    rowContentWidth: p.w + ACTIONS_GAP + s.w,
    pills: [
      { label: primaryLabel, width: p.w, height: pPress.h, left: p.x },
      { label: 'Not now', width: s.w, height: sPress.h, left: s.x },
    ],
    overflowPastCopyColumn: Math.max(0, rowRight - (copyBox.x + copyBox.w)),
    overflowPastCardBorder: Math.max(0, rowRight - (cardBox.x + cardBox.w)),
    overflowPastScreen: Math.max(0, rowRight - screenWidth),
  };
  root.freeRecursive();
  return out;
}

/** iOS Dynamic Type multipliers (RCTAccessibilityManager.mm) × iPhone widths. */
const FONT_SCALES = {
  large: 1.0,
  xxxLarge: 1.353,
  accessibilityLarge: 2.143,
  accessibilityExtraExtraExtraLarge: 3.571,
};
const WIDTHS = [320, 375, 430];
const rows = [];
for (const [fontScaleName, fontScale] of Object.entries(FONT_SCALES)) {
  for (const screenWidth of WIDTHS) {
    for (const primaryLabel of ['Turn on', 'Asking…', 'Try again']) {
      rows.push({
        fontScaleName,
        ...layoutCard({
          screenWidth,
          fontScale,
          primaryLabel,
          failed: primaryLabel === 'Try again',
        }),
      });
    }
  }
}
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      note: 'Actions-row geometry from real Yoga (yoga-layout@3 WASM, pointScaleFactor 3 = iPhone @3x) with the advance widths in fontMetrics.fixture.json. Regenerate with generateYogaFixture.mjs.',
      engine: 'yoga-layout@3',
      pointScaleFactor: 3,
      rows,
    },
    null,
    2,
  ) + '\n',
);
