/**
 * xc-screen-ux-a11y-i18n-3 / static plane.
 *
 * 1. Extracts every prose string (JSX text, string literals, template
 *    literals) from the four audited screens and the copy modules they
 *    render, via the TypeScript AST, and scans each against the
 *    APP_STORE_SUBMISSION.md lexicon (forbidden products/competitors,
 *    unsupported claims), the AGENTS.md raw-machine-token rule, and the
 *    dossier's privacy contract ("there is no cloud video feature").
 * 2. Computes the WCAG 2.x contrast ratio for every design-token
 *    foreground/background pairing the audited screens can render.
 *
 * Raw outputs: artifacts/xc-screen-ux-a11y-i18n-3/static-copy-scan.json and
 * token-contrast-matrix.json. Known failures are pinned with `test.failing`
 * so the harness stays green while the finding stays visible.
 */
import * as ts from 'typescript';

declare const require: (id: string) => unknown;
declare const __dirname: string;
const fs = require('fs') as {
  readFileSync: (file: string, enc: 'utf8') => string;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};
import { color, type } from '../src/design/tokens';
import {
  FORBIDDEN_TERMS,
  MACHINE_TOKEN_PATTERNS,
  UNSUPPORTED_CLAIMS,
  contrastRatio,
  isLargeText,
  parseColor,
  scanText,
  writeArtifact,
  type LexiconHit,
  type LexiconRule,
} from '../xc-audit/auditKit';

const SRC = path.resolve(__dirname, '..', 'src');

/** Audited screens + the modules whose copy they render. */
const AUDITED_FILES = [
  'screens/AnalyzeScreen.tsx',
  'screens/ResultScreen.tsx',
  'screens/ResultDetailsScreen.tsx',
  'screens/FormReviewScreen.tsx',
  'components/StrokeResult.tsx',
  'components/strokeResultModel.ts',
  'components/AnalysisFeedbackPrompt.tsx',
  'review/FormReviewPlayer.tsx',
  'analysis/runCaptureAnalysis.ts',
  'design/components.tsx',
];

/** Dossier §"Capture is video only … there is no cloud video feature". */
const PRIVACY_CONTRACT: readonly LexiconRule[] = [
  {
    id: 'cloud_video_feature',
    pattern: /cloud\s+video\s+(?:sync|upload|backup)|enable\s+cloud/i,
    policy:
      'APP_STORE_SUBMISSION.md: clips never leave the device; there is no cloud video feature',
  },
];

interface ProseString {
  file: string;
  line: number;
  kind: 'jsx_text' | 'string' | 'template';
  text: string;
}

/** Prose = has whitespace between words or ends in sentence punctuation. */
function looksLikeProse(text: string): boolean {
  const t = text.trim();
  if (t.length < 4) return false;
  if (/^[a-z0-9_.:/-]+$/i.test(t)) return false; // identifiers, keys, paths
  return /\s/.test(t) || /[.!?…]$/.test(t);
}

function isNonProseContext(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent))
    return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isJsxAttribute(parent)) {
    const name = parent.name.getText();
    return (
      name === 'testID' ||
      name === 'accessibilityRole' ||
      name === 'accessibilityLiveRegion' ||
      name === 'variant' ||
      name === 'name' ||
      name === 'icon' ||
      name === 'tone' ||
      name === 'pose' ||
      name === 'edges' ||
      name === 'barStyle' ||
      name === 'key'
    );
  }
  return false;
}

function extractProse(file: string): ProseString[] {
  const abs = path.join(SRC, file);
  const source = ts.createSourceFile(
    abs,
    fs.readFileSync(abs, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: ProseString[] = [];
  const push = (
    node: ts.Node,
    kind: ProseString['kind'],
    text: string,
  ): void => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!looksLikeProse(normalized)) return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    out.push({ file, line: line + 1, kind, text: normalized });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      push(node, 'jsx_text', node.text);
    } else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node)
    ) {
      if (!isNonProseContext(node)) push(node, 'string', node.text);
    } else if (ts.isTemplateExpression(node)) {
      const parts = [
        node.head.text,
        ...node.templateSpans.map(s => `⟨expr⟩${s.literal.text}`),
      ];
      push(node, 'template', parts.join(''));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

interface ScanRow extends ProseString {
  hits: LexiconHit[];
}

const prose: ProseString[] = AUDITED_FILES.flatMap(extractProse);
const scanned: ScanRow[] = prose.map(p => ({
  ...p,
  hits: [
    ...scanText(p.text, FORBIDDEN_TERMS),
    ...scanText(p.text, UNSUPPORTED_CLAIMS),
    ...scanText(p.text, PRIVACY_CONTRACT),
  ],
}));

/**
 * Machine tokens in SOURCE are legitimate when they are the keys of a mapping
 * table (`paddle_track_unavailable: 'Paddle …'`). Source-level scan therefore
 * only flags tokens inside sentences (prose that also contains ≥ 3 words).
 */
const tokenLeaks: ScanRow[] = prose
  .filter(p => p.text.split(' ').length >= 3)
  .map(p => ({ ...p, hits: scanText(p.text, MACHINE_TOKEN_PATTERNS) }))
  .filter(r => r.hits.length > 0);

describe('xc-3 static · source copy scan (4 screens + rendered copy modules)', () => {
  afterAll(() => {
    writeArtifact('static-copy-scan.json', {
      files: AUDITED_FILES,
      proseStrings: prose.length,
      perFile: Object.fromEntries(
        AUDITED_FILES.map(f => [f, prose.filter(p => p.file === f).length]),
      ),
      lexiconHits: scanned.filter(r => r.hits.length > 0),
      machineTokenSentences: tokenLeaks,
      dupr: prose.filter(p => /\bDUPR\b/.test(p.text)),
      accuracyMentions: prose.filter(p => /\baccura/i.test(p.text)),
    });
  });

  it('extracts a substantive corpus from every audited file', () => {
    for (const file of AUDITED_FILES) {
      expect(prose.filter(p => p.file === file).length).toBeGreaterThan(0);
    }
    expect(prose.length).toBeGreaterThan(300);
  });

  it('no Android / Google Play / guest mode / Live Court / competitor copy', () => {
    const hits = scanned.filter(r =>
      r.hits.some(
        h =>
          h.rule !== 'dupr' &&
          h.rule !== 'cloud_video_feature' &&
          FORBIDDEN_TERMS.some(f => f.id === h.rule),
      ),
    );
    expect(hits).toEqual([]);
  });

  it('no accuracy-percentage / superlative / AI-coach-equivalence claims', () => {
    const hits = scanned.filter(r =>
      r.hits.some(h => UNSUPPORTED_CLAIMS.some(u => u.id === h.rule)),
    );
    expect(hits.map(h => `${h.file}:${h.line} ${h.text}`)).toEqual([]);
  });

  it('no sentence embeds a raw snake_case / dotted machine token', () => {
    // Sentences that name a token are only allowed when the token is quoted
    // as data the sentence explains (e.g. the sidecar failure code, which is
    // rendered on purpose as `(${code})` and audited at render time).
    const leaks = tokenLeaks.filter(
      r => !/⟨expr⟩/.test(r.text) || r.hits.some(h => h.rule === 'js_leak'),
    );
    expect(leaks.map(l => `${l.file}:${l.line} ${l.text}`)).toEqual([]);
  });

  // FINDING (pinned): the Analyze camera landing tells the player clip
  // storage stays local "unless you explicitly enable cloud video sync". No
  // such setting exists (Settings → Privacy says "Cloud video upload: Not
  // configured") and the dossier states "there is no cloud video feature".
  test.failing(
    'Analyze landing copy does not describe a cloud video sync feature',
    () => {
      const hits = scanned.filter(r =>
        r.hits.some(h => h.rule === 'cloud_video_feature'),
      );
      expect(hits.map(h => `${h.file}:${h.line} ${h.text}`)).toEqual([]);
    },
  );

  it('DUPR appears in source only as code identifiers, never as prose (pinned)', () => {
    // `progress/duprEstimate` is imported by ResultScreen; the dossier forbids
    // the acronym in user-facing copy. Prose strings containing it would be a
    // finding — record them either way.
    const duprProse = prose.filter(p => /\bDUPR\b/.test(p.text));
    expect(duprProse.map(p => `${p.file}:${p.line} ${p.text}`)).toEqual([]);
  });
});

// ───────────────────────── token contrast matrix ─────────────────────────

interface Pairing {
  fg: keyof typeof color;
  bg: keyof typeof color;
  role: keyof typeof type;
  where: string;
}

/** Foreground/background/type-role triplets the audited screens render. */
const PAIRINGS: readonly Pairing[] = [
  // Dark shells (Result, ResultDetails, FormReview, Analyze camera)
  { fg: 'onDark', bg: 'surfaceDark', role: 'h1', where: 'Result headline' },
  { fg: 'onDark', bg: 'surfaceDark', role: 'body', where: 'Result body' },
  {
    fg: 'onDarkMuted',
    bg: 'surfaceDark',
    role: 'body',
    where: 'Result muted body',
  },
  {
    fg: 'onDarkSubtle',
    bg: 'surfaceDark',
    role: 'body',
    where: 'ErrorState dark detail',
  },
  {
    fg: 'onDarkSubtle',
    bg: 'surfaceDark',
    role: 'caption',
    where: 'Result captions',
  },
  {
    fg: 'onDarkFaint',
    bg: 'surfaceDark',
    role: 'caption',
    where: 'Result faint captions',
  },
  {
    fg: 'onDarkFaint',
    bg: 'surfaceDark',
    role: 'micro',
    where: 'Result eyebrows',
  },
  {
    fg: 'onDarkDisabled',
    bg: 'surfaceDark',
    role: 'body',
    where: 'disabled dark labels',
  },
  {
    fg: 'onDarkDisabled',
    bg: 'surfaceDark',
    role: 'caption',
    where: 'disabled dark captions',
  },
  {
    fg: 'volt',
    bg: 'surfaceDark',
    role: 'micro',
    where: 'volt eyebrow on dark',
  },
  {
    fg: 'mint',
    bg: 'surfaceDark',
    role: 'caption',
    where: 'mint status on dark',
  },
  {
    fg: 'flame',
    bg: 'surfaceDark',
    role: 'caption',
    where: 'flame status on dark',
  },
  {
    fg: 'onDark',
    bg: 'inkElevated',
    role: 'body',
    where: 'elevated dark card body',
  },
  {
    fg: 'onDarkMuted',
    bg: 'inkElevated',
    role: 'caption',
    where: 'elevated dark card caption',
  },
  {
    fg: 'onDarkSubtle',
    bg: 'inkElevated',
    role: 'caption',
    where: 'elevated dark card subtle',
  },
  {
    fg: 'onDarkFaint',
    bg: 'inkElevated',
    role: 'caption',
    where: 'elevated dark card faint',
  },
  { fg: 'onDark', bg: 'graphite', role: 'body', where: 'graphite card body' },
  {
    fg: 'onDarkMuted',
    bg: 'graphite',
    role: 'caption',
    where: 'graphite card caption',
  },
  {
    fg: 'onDarkFaint',
    bg: 'graphite',
    role: 'caption',
    where: 'graphite faint caption',
  },
  {
    fg: 'onDark',
    bg: 'cameraSurface',
    role: 'body',
    where: 'camera overlay body',
  },
  {
    fg: 'onDarkMuted',
    bg: 'cameraSurface',
    role: 'caption',
    where: 'camera overlay caption',
  },
  { fg: 'onVolt', bg: 'volt', role: 'bodyBold', where: 'volt button label' },
  { fg: 'onDark', bg: 'court', role: 'bodyBold', where: 'court button label' },
  {
    fg: 'onDark',
    bg: 'courtDeep',
    role: 'bodyBold',
    where: 'paywall button label',
  },
  // Light shells (Analyze saved/error cards, ErrorState light)
  { fg: 'ink', bg: 'surface', role: 'body', where: 'light body' },
  { fg: 'inkSoft', bg: 'surface', role: 'body', where: 'light muted body' },
  { fg: 'inkSoft', bg: 'surface', role: 'caption', where: 'light caption' },
  {
    fg: 'inkSoft',
    bg: 'surfaceElevated',
    role: 'caption',
    where: 'card caption',
  },
  {
    fg: 'inkSoft',
    bg: 'surfaceAlt',
    role: 'caption',
    where: 'alt surface caption',
  },
  { fg: 'good', bg: 'goodSoft', role: 'caption', where: 'good pill' },
  { fg: 'warn', bg: 'warnSoft', role: 'caption', where: 'warn pill' },
  { fg: 'bad', bg: 'badSoft', role: 'caption', where: 'bad pill' },
  { fg: 'good', bg: 'surface', role: 'caption', where: 'good text on light' },
  { fg: 'warn', bg: 'surface', role: 'caption', where: 'warn text on light' },
  { fg: 'bad', bg: 'surface', role: 'caption', where: 'bad text on light' },
  { fg: 'court', bg: 'surface', role: 'caption', where: 'court link on light' },
  { fg: 'court', bg: 'courtSoft', role: 'caption', where: 'court pill' },
  { fg: 'onDark', bg: 'good', role: 'bodyBold', where: 'good button' },
  { fg: 'onDark', bg: 'bad', role: 'bodyBold', where: 'danger button' },
];

interface ContrastRow extends Pairing {
  fgHex: string;
  bgHex: string;
  fontSize: number;
  fontWeight: string;
  fontFamily: string;
  large: boolean;
  ratio: number;
  aaThreshold: number;
  aa: boolean;
  aaa: boolean;
}

function roleFont(role: keyof typeof type): {
  size: number;
  weight: string;
  family: string;
} {
  const style = type[role] as {
    fontSize?: number;
    fontWeight?: string | number;
    fontFamily?: string;
  };
  return {
    size: style.fontSize ?? 16,
    weight: String(style.fontWeight ?? 'normal'),
    family: style.fontFamily ?? '',
  };
}

const contrastRows: ContrastRow[] = PAIRINGS.map(p => {
  const fg = parseColor(color[p.fg]);
  const bg = parseColor(color[p.bg]);
  if (!fg || !bg) throw new Error(`unparseable token ${p.fg}/${p.bg}`);
  const font = roleFont(p.role);
  const large = isLargeText(font.size, font.weight, font.family);
  const ratio = Number(contrastRatio(fg, bg).toFixed(2));
  const aaThreshold = large ? 3 : 4.5;
  return {
    ...p,
    fgHex: color[p.fg],
    bgHex: color[p.bg],
    fontSize: font.size,
    fontWeight: font.weight,
    fontFamily: font.family,
    large,
    ratio,
    aaThreshold,
    aa: ratio >= aaThreshold,
    aaa: ratio >= (large ? 4.5 : 7),
  };
});

describe('xc-3 static · design-token WCAG contrast matrix', () => {
  afterAll(() => {
    writeArtifact('token-contrast-matrix.json', {
      note:
        'WCAG 2.x contrast of design tokens as paired on the audited screens. ' +
        'Opacity/blur/gradient effects are not modelled; computed from tokens.ts.',
      rows: contrastRows,
      failingAA: contrastRows.filter(r => !r.aa),
    });
  });

  it('kit self-check: black/white = 21, white/white = 1', () => {
    const black = parseColor('#000000');
    const white = parseColor('#FFFFFF');
    if (!black || !white) throw new Error('parse');
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
  });

  it('primary text tokens on their shells meet AA', () => {
    const primary = contrastRows.filter(
      r => r.fg === 'onDark' || r.fg === 'ink' || r.fg === 'onVolt',
    );
    expect(
      primary.filter(r => !r.aa).map(r => `${r.where} ${r.ratio}`),
    ).toEqual([]);
  });

  // FINDING (pinned, token-level): these pairings sit below 4.5:1 for
  // small text. Which of them actually reach a rendered screen state is
  // established by the render-plane suites (per-Text contrast rows).
  it('pairings below AA are exactly the known set (drift = new finding or fix)', () => {
    const failing = contrastRows
      .filter(r => !r.aa)
      .map(r => `${r.fg} on ${r.bg} ${r.ratio}`);
    expect(failing).toEqual([
      'onDarkDisabled on surfaceDark 3.83',
      'onDarkDisabled on surfaceDark 3.83',
      'onDarkFaint on graphite 4.34',
      'inkSoft on surfaceAlt 4.42',
      'good on goodSoft 4.46',
      'warn on warnSoft 3.86',
      'warn on surface 4.31',
      'court on courtSoft 4.45',
    ]);
  });
});
