/**
 * INT-ui-flows-a11y adversary — static user-facing copy scan.
 *
 * Walks every string literal, template literal and JSX text node in the UI
 * layers (screens, components, navigation, design) with the TypeScript
 * compiler and rejects the terms APP_STORE_SUBMISSION.md forbids in
 * user-facing copy. Comments are not strings and are therefore ignored;
 * `Platform.OS === 'android'` style comparisons are lowercase and never
 * match the capitalised platform names.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const UI_DIRS = ['screens', 'components', 'navigation', 'design'].map(dir =>
  path.join(__dirname, '..', '..', 'src', dir),
);

const PROHIBITED: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'Android', re: /\bAndroid\b/ },
  { label: 'Google Play', re: /Google Play/ },
  { label: 'guest mode', re: /guest mode/i },
  { label: 'Live Court', re: /Live Court/ },
  { label: 'DUPR', re: /\bDUPR\b/ },
  { label: 'competitor', re: /SwingVision|PB Vision|Selkirk|JOOLA/ },
  { label: 'accuracy %', re: /\d{2,3}\s?%\s?(accura|precis)/i },
];

type Hit = { file: string; line: number; label: string; text: string };

function listSources(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSources(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name))
      out.push(full);
  }
  return out;
}

function stringNodes(
  source: ts.SourceFile,
): Array<{ text: string; pos: number }> {
  const found: Array<{ text: string; pos: number }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      found.push({ text: node.text, pos: node.getStart(source) });
    } else if (ts.isTemplateExpression(node)) {
      found.push({ text: node.head.text, pos: node.getStart(source) });
      for (const span of node.templateSpans)
        found.push({ text: span.literal.text, pos: span.getStart(source) });
    } else if (ts.isJsxText(node)) {
      found.push({ text: node.text, pos: node.getStart(source) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  const files = UI_DIRS.flatMap(listSources);
  expect(files.length).toBeGreaterThan(20);
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    for (const literal of stringNodes(source)) {
      for (const rule of PROHIBITED) {
        if (!rule.re.test(literal.text)) continue;
        const { line } = source.getLineAndCharacterOfPosition(literal.pos);
        hits.push({
          file: path.relative(path.join(__dirname, '..', '..'), file),
          line: line + 1,
          label: rule.label,
          text: literal.text.trim().slice(0, 160),
        });
      }
    }
  }
  return hits;
}

describe('adv: user-facing copy in UI layers follows APP_STORE_SUBMISSION.md', () => {
  it('contains no Android / Google Play / guest mode / Live Court / DUPR / competitor / accuracy-% strings', () => {
    const hits = scan();
    expect(hits).toEqual([]);
  });
});
