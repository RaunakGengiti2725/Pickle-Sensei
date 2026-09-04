/**
 * String extraction + user-visibility classification for the release copy
 * policy scan. Walks the TypeScript AST (not a regex over source text) so every
 * literal is attributed to the syntactic slot it sits in and comments are
 * separated from code.
 *
 * Visibility levels (worst → best for the policy):
 *   visible  — the string is rendered to the user on a known path
 *              (JSX text, a copy prop such as `title`/`accessibilityLabel`,
 *              an Alert/Toast argument, a `*_COPY`/`*_NOTE` constant, a copy
 *              key in an object literal, every string in legal.ts).
 *   likely   — prose-shaped literal in an unclassified slot (contains a space
 *              and reads like a sentence/label); treated as visible for the
 *              policy gate but reported separately so the reader can confirm.
 *   code     — identifier-shaped or in a non-UI slot (import path, testID,
 *              switch label, comparison operand, object key, style value…).
 *   comment  — inside a `//` or `/* *\/` comment.
 */
import ts from 'typescript';

export type Visibility = 'visible' | 'likely' | 'code' | 'comment';

export interface ExtractedString {
  /** Repo-relative file path. */
  file: string;
  /** 1-based line/column of the literal (or comment) start. */
  line: number;
  column: number;
  /** Absolute offset of the literal start in the file text (raw, with quotes). */
  start: number;
  /** Raw source slice (quotes/backticks included) — positions are exact. */
  raw: string;
  /** Cooked text (escapes resolved) for readability. */
  text: string;
  /** The syntactic slot the literal sits in. */
  slot: string;
  /** Extra detail about the slot: prop/key/callee/variable name. */
  slotName: string | null;
  visibility: Visibility;
}

export interface ExtractOptions {
  /** Treat every string literal in the file as user-visible (served text). */
  allVisible?: boolean;
}

// Props / object keys / identifiers that carry copy.
const COPY_NAME_RE =
  /(^|[_a-z])(label|title|subtitle|text|message|msg|copy|hint|description|desc|caption|note|notes|detail|details|body|headline|heading|placeholder|cta|summary|reason|reasons|explanation|prompt|question|answer|tip|tips|step|steps|line|lines|sentence|phrase|word|words|blurb|footnote|kicker|eyebrow|badge|status|error|warning|announcement|toast|button|action|name|greeting|intro|outro|bullet|bullets|paragraph|paragraphs|content|disclaimer|legal|terms|policy|help|instructions?|guidance|advice|feedback|verdict|coachline|callout|banner|why|because|benefit|benefits|promise|value|quote)(s|Label|Text|Copy|Title|Line|Lines|Note)?$/i;

// Props / keys that never carry copy even when they look like it.
const NON_COPY_NAME_RE =
  /^(testID|testId|accessibilityRole|accessibilityState|accessibilityValue|key|id|ids|iconName|icon|source|uri|url|href|scheme|style|styles|color|colors|backgroundColor|fontFamily|fontWeight|fontStyle|resizeMode|keyboardType|returnKeyType|autoCapitalize|autoComplete|textContentType|kind|type|mode|variant|tone|size|status|state|behavior|pointerEvents|component|screen|route|routeName|path|method|table|column|columns|field|fields|event|eventName|metric|storageKey|service|provider|ownerId|deviceId|locale|format|encoding|ext|extension|mime|mimeType|contentType|headers?|authorization|token|role|env|flavor|target|bundleId|package|appId|clientId|region|host|hostname|endpoint|baseUrl|apiKey|sku|productId|entitlement|offering|preset|orientation|codec|quality)$/;

const ALERT_CALLEE_RE =
  /(^|\.)(alert|prompt|showToast|toast|announceForAccessibility|showMessage|showBanner|showError|showNotice|speak|say|setError|setMessage|setNotice|setBanner|setToast|setStatusText|confirm)$/i;

// Non-UI callees: literals passed here are never shown.
const NON_UI_CALLEE_RE =
  /(^|\.)(require|import|log|debug|info|warn|error|trace|getItem|setItem|removeItem|multiGet|multiSet|exec|execute|executeSync|run|query|all|get|prepare|track|logEvent|recordEvent|emit|on|off|addListener|removeListener|addEventListener|removeEventListener|navigate|replace|reset|goBack|dispatch|has|includes|startsWith|endsWith|indexOf|split|join|test|match|replaceAll|localeCompare|createElement|getElementById|querySelector|Symbol|createContext|forwardRef|memo|useState|useRef|useMemo|useCallback|createStore|persist|createSelector|jest|describe|it|expect|fetch|Headers|URL|URLSearchParams|encodeURIComponent|decodeURIComponent|atob|btoa|Buffer|from|of|isNaN|parseInt|parseFloat|Number|String|Boolean|Date|RegExp|JSON|stringify|parse|Object|keys|values|entries|assign|freeze|defineProperty|hasOwnProperty|Array|Map|Set|WeakMap|Promise|setTimeout|setInterval|clearTimeout|clearInterval|requestAnimationFrame|Linking|openURL|canOpenURL|openSettings|Platform|select|Keychain|setGenericPassword|getGenericPassword|resetGenericPassword|hasGenericPassword|openDatabase|transaction|executeSql|readFile|writeFile|exists|unlink|mkdir|stat|copyFile|moveFile|readDir|downloadFile|uploadFiles|getDownloadURL|configure|setLogLevel|setAttributes|identify|logIn|logOut|getOfferings|purchasePackage|restorePurchases|getCustomerInfo|check|request|requestMultiple|checkMultiple|openPhotoPicker|launchImageLibrary|launchCamera|startRecording|stopRecording|takePhoto|startsWith|padStart|padEnd|repeat|slice|substring|substr|charAt|charCodeAt|codePointAt|normalize|trim|trimStart|trimEnd|toLowerCase|toUpperCase|toFixed|toString|valueOf|sort|filter|map|forEach|reduce|some|every|find|findIndex|flat|flatMap|concat|at|hash|createHash|digest|update|encode|decode|scan|tokenize|classify|resolve|reject|then|catch|finally)$/;

// `navigation.push('Screen')` and friends — the ONLY `.push` calls that are
// not building a list of strings.
const NAV_PUSH_RE =
  /^(navigation|nav|history|router|stack|navigator)\.(push|replace|navigate)$/i;

// Identifiers whose value is copy.
const COPY_IDENT_RE =
  /(copy|note|label|text|title|message|msg|hint|caption|subtitle|headline|heading|description|body|cta|steps|lines|sentences?|phrases?|words?|disclaimer|blurb|prompt|question|answer|tip|tips|greeting|instructions?|explanation|reason|summary|verdict|advice|guidance|feedback|toast|banner|placeholder|announcement|paragraphs?|bullets?|content|strings?|wording|copyright|legal|terms|privacy|support)(s)?$/i;

// Function names that build copy.
const COPY_FUNC_RE =
  /^(format|describe|explain|phrase|word|say|speak|narrate|label|title|caption|render|humani[sz]e|pluralize|copyFor|textFor|messageFor|noteFor|hintFor|summari[sz]e|build\w*(Copy|Text|Message|Label|Title|Note|Line|Summary)|get\w*(Copy|Text|Message|Label|Title|Note|Line|Summary|Hint|Caption)|to\w*(Copy|Text|Message|Label|Title|Note|Line|Summary|Sentence|Phrase|Words?))/i;

function isProseLike(text: string): boolean {
  const t = text.trim();
  if (t.length < 3) {
    return false;
  }
  if (!/\s/.test(t)) {
    return false;
  }
  if (/^[a-z0-9_./:-]+$/i.test(t)) {
    return false;
  }
  if (
    /^(SELECT\s[\s\S]*\sFROM\s|INSERT\s+(OR\s+\w+\s+)?INTO\s|UPDATE\s+\w+\s+SET\s|DELETE\s+FROM\s|CREATE\s+(TABLE|UNIQUE|INDEX|VIEW|TRIGGER)\b|ALTER\s+TABLE\b|DROP\s+(TABLE|INDEX|VIEW|TRIGGER)\b|PRAGMA\s+\w+|WITH\s+\w+\s+AS\s*\(|BEGIN(\s+TRANSACTION)?;?$|COMMIT;?$|ROLLBACK;?$|^\s*(AND|OR|WHERE)\s+\w+\s*(=|<>|!=|<|>|IS\s|IN\s*\(|LIKE\s)|^\s*ORDER\s+BY\s+\w+|^\s*LIMIT\s+\d|^\s*VALUES\s*\()/i.test(
      t,
    )
  ) {
    return false;
  }
  if (/^https?:\/\//i.test(t)) {
    return false;
  }
  // SVG path data / numeric vectors ("M24 3 L40 12 Z", "0 0 24 24").
  if (/^[MLHVCSQTAZmlhvcsqtaz0-9\s.,-]+$/.test(t)) {
    return false;
  }
  // Embedded HTML / CSS / JS (WebView documents, player bootstrap scripts).
  if (
    /^\s*<(!DOCTYPE|html|head|body|style|script|div|meta)\b/i.test(t) ||
    /^\s*[\w#.-]+\s*\{[^}]*:[^}]*\}/.test(t)
  ) {
    return false;
  }
  // A capitalised word sequence, or something ending in sentence punctuation,
  // or at least three words.
  return (
    /[.!?…:]$/.test(t) || /^[A-Z“"']/.test(t) || t.split(/\s+/).length >= 3
  );
}

/** Stricter than isProseLike: a full sentence (≥4 words or terminal punctuation). */
function isSentenceLike(text: string): boolean {
  const t = text.trim();
  return isProseLike(t) && (/[.!?…]$/.test(t) || t.split(/\s+/).length >= 4);
}

function nameOf(
  node: ts.PropertyName | ts.JsxAttributeName | ts.BindingName | undefined,
): string | null {
  if (!node) {
    return null;
  }
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
    return node.text;
  }
  if (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.text;
  }
  if (ts.isJsxNamespacedName(node)) {
    return node.name.text;
  }
  return null;
}

function calleeText(call: ts.CallExpression | ts.NewExpression): string {
  return call.expression.getText().replace(/\s+/g, '');
}

function enclosingFunctionName(node: ts.Node): string | null {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)) {
      return cur.name ? cur.name.getText() : null;
    }
    if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) {
      const p = cur.parent;
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
        return p.name.text;
      }
      if (ts.isPropertyAssignment(p)) {
        return nameOf(p.name);
      }
      return cur.name ? cur.name.getText() : null;
    }
    cur = cur.parent;
  }
  return null;
}

/** Walk up through expression wrappers that do not change what the value is. */
function unwrapValueParent(node: ts.Node): ts.Node {
  let cur = node;
  for (;;) {
    const p = cur.parent;
    if (!p) {
      return cur;
    }
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isTypeAssertionExpression(p) ||
      ts.isTemplateSpan(p) ||
      ts.isTemplateExpression(p) ||
      (ts.isConditionalExpression(p) &&
        (p.whenTrue === cur || p.whenFalse === cur)) ||
      (ts.isBinaryExpression(p) &&
        (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          p.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          p.operatorToken.kind === ts.SyntaxKind.PlusToken)) ||
      ts.isArrayLiteralExpression(p) ||
      ts.isSpreadElement(p) ||
      ts.isSpreadAssignment(p)
    ) {
      cur = p;
      continue;
    }
    return cur;
  }
}

interface Classification {
  slot: string;
  slotName: string | null;
  visibility: Visibility;
}

function classifyLiteral(
  node: ts.Node,
  cooked: string,
  file: string,
): Classification {
  const directParent = node.parent;

  // Non-value positions ------------------------------------------------
  if (
    ts.isImportDeclaration(directParent) ||
    ts.isExportDeclaration(directParent) ||
    ts.isExternalModuleReference(directParent)
  ) {
    return { slot: 'module_specifier', slotName: null, visibility: 'code' };
  }
  if (ts.isLiteralTypeNode(directParent) || ts.isImportTypeNode(directParent)) {
    return { slot: 'type_literal', slotName: null, visibility: 'code' };
  }
  if (ts.isPropertyAssignment(directParent) && directParent.name === node) {
    return { slot: 'object_key', slotName: cooked, visibility: 'code' };
  }
  if (
    (ts.isPropertyDeclaration(directParent) ||
      ts.isMethodDeclaration(directParent) ||
      ts.isPropertySignature(directParent) ||
      ts.isEnumMember(directParent)) &&
    directParent.name === node
  ) {
    return { slot: 'member_name', slotName: cooked, visibility: 'code' };
  }
  if (ts.isEnumMember(directParent)) {
    return {
      slot: 'enum_value',
      slotName: nameOf(directParent.name),
      visibility: 'code',
    };
  }
  if (
    ts.isElementAccessExpression(directParent) &&
    directParent.argumentExpression === node
  ) {
    return { slot: 'element_access', slotName: null, visibility: 'code' };
  }
  if (ts.isCaseClause(directParent)) {
    return { slot: 'switch_case', slotName: null, visibility: 'code' };
  }
  if (ts.isComputedPropertyName(directParent)) {
    return { slot: 'computed_key', slotName: null, visibility: 'code' };
  }
  if (ts.isTaggedTemplateExpression(directParent)) {
    return {
      slot: 'tagged_template',
      slotName: directParent.tag.getText(),
      visibility: 'code',
    };
  }

  // JSX -----------------------------------------------------------------
  if (
    ts.isJsxAttribute(directParent) ||
    (ts.isJsxExpression(directParent) &&
      directParent.parent &&
      ts.isJsxAttribute(directParent.parent))
  ) {
    const attr = ts.isJsxAttribute(directParent)
      ? directParent
      : (directParent.parent as ts.JsxAttribute);
    const prop = nameOf(attr.name) ?? '';
    if (NON_COPY_NAME_RE.test(prop)) {
      return {
        slot: 'jsx_prop_noncopy',
        slotName: prop,
        visibility: isSentenceLike(cooked) ? 'likely' : 'code',
      };
    }
    if (COPY_NAME_RE.test(prop)) {
      return { slot: 'jsx_prop_copy', slotName: prop, visibility: 'visible' };
    }
    return {
      slot: 'jsx_prop_other',
      slotName: prop,
      visibility: isProseLike(cooked) ? 'likely' : 'code',
    };
  }

  // Comparison operand ---------------------------------------------------
  if (ts.isBinaryExpression(directParent)) {
    const k = directParent.operatorToken.kind;
    if (
      k === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      k === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      k === ts.SyntaxKind.EqualsEqualsToken ||
      k === ts.SyntaxKind.ExclamationEqualsToken ||
      k === ts.SyntaxKind.InKeyword
    ) {
      return { slot: 'comparison_operand', slotName: null, visibility: 'code' };
    }
  }

  // Value position: find what consumes the value ---------------------------
  const valueNode = unwrapValueParent(node);
  const consumer = valueNode.parent;

  if (consumer && ts.isJsxExpression(consumer)) {
    const holder = consumer.parent;
    if (holder && ts.isJsxAttribute(holder)) {
      const prop = nameOf(holder.name) ?? '';
      if (NON_COPY_NAME_RE.test(prop)) {
        return {
          slot: 'jsx_prop_noncopy',
          slotName: prop,
          visibility: isSentenceLike(cooked) ? 'likely' : 'code',
        };
      }
      if (COPY_NAME_RE.test(prop)) {
        return { slot: 'jsx_prop_copy', slotName: prop, visibility: 'visible' };
      }
      return {
        slot: 'jsx_prop_other',
        slotName: prop,
        visibility: isProseLike(cooked) ? 'likely' : 'code',
      };
    }
    if (holder && (ts.isJsxElement(holder) || ts.isJsxFragment(holder))) {
      const tag = ts.isJsxElement(holder)
        ? holder.openingElement.tagName.getText()
        : 'Fragment';
      return {
        slot: 'jsx_child_expression',
        slotName: tag,
        visibility: 'visible',
      };
    }
  }

  if (
    consumer &&
    (ts.isCallExpression(consumer) || ts.isNewExpression(consumer))
  ) {
    const callee = calleeText(consumer);
    if (ALERT_CALLEE_RE.test(callee)) {
      return {
        slot: 'alert_argument',
        slotName: callee,
        visibility: 'visible',
      };
    }
    if (/\.(push|unshift)$/.test(callee)) {
      if (NAV_PUSH_RE.test(callee)) {
        return {
          slot: 'call_argument_nonui',
          slotName: callee,
          visibility: 'code',
        };
      }
      const list = callee.replace(/\.(push|unshift)$/, '');
      if (COPY_IDENT_RE.test(list)) {
        return {
          slot: 'list_push_copy',
          slotName: list,
          visibility: 'visible',
        };
      }
      return {
        slot: 'list_push',
        slotName: list,
        visibility: isProseLike(cooked) ? 'likely' : 'code',
      };
    }
    if (NON_UI_CALLEE_RE.test(callee) || /^console\./.test(callee)) {
      return {
        slot: 'call_argument_nonui',
        slotName: callee,
        visibility: 'code',
      };
    }
    if (
      /^(new\s*)?(Error|TypeError|RangeError|ApiError|\w*Error)$/.test(callee)
    ) {
      return {
        slot: 'error_message',
        slotName: callee,
        visibility: isProseLike(cooked) ? 'likely' : 'code',
      };
    }
    return {
      slot: 'call_argument',
      slotName: callee,
      visibility: isProseLike(cooked) ? 'likely' : 'code',
    };
  }

  if (consumer && ts.isPropertyAssignment(consumer)) {
    const key = nameOf(consumer.name) ?? '';
    if (NON_COPY_NAME_RE.test(key)) {
      return {
        slot: 'object_value_noncopy',
        slotName: key,
        visibility: isSentenceLike(cooked) ? 'likely' : 'code',
      };
    }
    if (COPY_NAME_RE.test(key)) {
      return {
        slot: 'object_value_copy',
        slotName: key,
        visibility: 'visible',
      };
    }
    return {
      slot: 'object_value_other',
      slotName: key,
      visibility: isProseLike(cooked) ? 'likely' : 'code',
    };
  }

  if (consumer && ts.isVariableDeclaration(consumer)) {
    const name = ts.isIdentifier(consumer.name)
      ? consumer.name.text
      : consumer.name.getText();
    if (
      COPY_IDENT_RE.test(name) ||
      /_(COPY|NOTE|LABEL|TEXT|TITLE|MESSAGE|HINT|CAPTION|STEPS|LINES|DISCLAIMER|BLURB)$/.test(
        name,
      )
    ) {
      return { slot: 'copy_constant', slotName: name, visibility: 'visible' };
    }
    if (
      NON_COPY_NAME_RE.test(name) ||
      /(Key|KEY|Id|ID|Url|URL|Path|PATH|Scheme|Table|TABLE|Column|Sql|SQL|Regex|Pattern|Prefix|Suffix|Service|SERVICE|Event|EVENT|Route|ROUTE|Name|NAME|Version|VERSION)$/.test(
        name,
      )
    ) {
      return { slot: 'variable_noncopy', slotName: name, visibility: 'code' };
    }
    return {
      slot: 'variable_other',
      slotName: name,
      visibility: isProseLike(cooked) ? 'likely' : 'code',
    };
  }

  if (
    consumer &&
    (ts.isReturnStatement(consumer) || ts.isArrowFunction(consumer))
  ) {
    const fn = enclosingFunctionName(consumer) ?? '';
    if (COPY_FUNC_RE.test(fn) || COPY_IDENT_RE.test(fn)) {
      return {
        slot: 'copy_function_return',
        slotName: fn,
        visibility:
          isProseLike(cooked) || /\S/.test(cooked) ? 'visible' : 'code',
      };
    }
    return {
      slot: 'function_return',
      slotName: fn,
      visibility: isProseLike(cooked) ? 'likely' : 'code',
    };
  }

  if (consumer && ts.isPropertyDeclaration(consumer)) {
    const name = nameOf(consumer.name) ?? '';
    if (COPY_IDENT_RE.test(name)) {
      return {
        slot: 'class_field_copy',
        slotName: name,
        visibility: 'visible',
      };
    }
    return {
      slot: 'class_field',
      slotName: name,
      visibility: isProseLike(cooked) ? 'likely' : 'code',
    };
  }

  if (
    consumer &&
    ts.isBinaryExpression(consumer) &&
    consumer.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    const target = consumer.left.getText();
    if (COPY_IDENT_RE.test(target)) {
      return {
        slot: 'assignment_copy',
        slotName: target,
        visibility: 'visible',
      };
    }
    return {
      slot: 'assignment',
      slotName: target,
      visibility: isProseLike(cooked) ? 'likely' : 'code',
    };
  }

  if (consumer && ts.isShorthandPropertyAssignment(consumer)) {
    return { slot: 'shorthand', slotName: null, visibility: 'code' };
  }

  if (consumer && ts.isExpressionStatement(consumer)) {
    return { slot: 'directive', slotName: null, visibility: 'code' };
  }

  void file;
  return {
    slot: 'unclassified',
    slotName: consumer ? ts.SyntaxKind[consumer.kind] : null,
    visibility: isProseLike(cooked) ? 'likely' : 'code',
  };
}

function literalPieces(
  node: ts.Node,
): Array<{ start: number; end: number; text: string }> | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [{ start: node.getStart(), end: node.getEnd(), text: node.text }];
  }
  if (
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  ) {
    return [{ start: node.getStart(), end: node.getEnd(), text: node.text }];
  }
  return null;
}

export function extractStrings(
  file: string,
  sourceText: string,
  options: ExtractOptions = {},
): ExtractedString[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const out: ExtractedString[] = [];
  const commentPositions = new Set<number>();

  const pushComments = (ranges: ts.CommentRange[] | undefined) => {
    if (!ranges) {
      return;
    }
    for (const r of ranges) {
      if (commentPositions.has(r.pos)) {
        continue;
      }
      commentPositions.add(r.pos);
      const raw = sourceText.slice(r.pos, r.end);
      const lc = sf.getLineAndCharacterOfPosition(r.pos);
      out.push({
        file,
        line: lc.line + 1,
        column: lc.character + 1,
        start: r.pos,
        raw,
        text: raw,
        slot: 'comment',
        slotName: null,
        visibility: 'comment',
      });
    }
  };

  const visit = (node: ts.Node) => {
    pushComments(ts.getLeadingCommentRanges(sourceText, node.getFullStart()));
    pushComments(ts.getTrailingCommentRanges(sourceText, node.getEnd()));
    // Comments that precede a punctuation token (e.g. inside an empty block or
    // before a closing brace) are leading trivia of that token, not of any
    // node — walk the token-level children too.
    for (const child of node.getChildren(sf)) {
      pushComments(
        ts.getLeadingCommentRanges(sourceText, child.getFullStart()),
      );
    }

    if (ts.isJsxText(node)) {
      const text = node.text;
      if (text.trim().length > 0) {
        const holder = node.parent;
        const tag = ts.isJsxElement(holder)
          ? holder.openingElement.tagName.getText()
          : 'Fragment';
        const lc = sf.getLineAndCharacterOfPosition(node.getStart());
        out.push({
          file,
          line: lc.line + 1,
          column: lc.character + 1,
          start: node.getStart(),
          raw: node.getText(),
          text,
          slot: 'jsx_text',
          slotName: tag,
          visibility: 'visible',
        });
      }
    } else {
      const pieces = literalPieces(node);
      if (pieces) {
        for (const piece of pieces) {
          // For template head/middle/tail the syntactic owner is the
          // TemplateExpression; classify from there.
          const owner =
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node)
              ? ts.isTemplateSpan(node.parent)
                ? node.parent.parent
                : node.parent
              : node;
          const cls = classifyLiteral(owner, piece.text, file);
          const visibility: Visibility =
            options.allVisible && cls.visibility !== 'comment'
              ? 'visible'
              : cls.visibility;
          const lc = sf.getLineAndCharacterOfPosition(piece.start);
          out.push({
            file,
            line: lc.line + 1,
            column: lc.character + 1,
            start: piece.start,
            raw: sourceText.slice(piece.start, piece.end),
            text: piece.text,
            slot: cls.slot,
            slotName: cls.slotName,
            visibility,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // EOF comments (after the last node) are trailing on the EndOfFileToken.
  pushComments(
    ts.getLeadingCommentRanges(sourceText, sf.endOfFileToken.getFullStart()),
  );

  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * Ranges of identifier tokens (variable, property, JSX attribute and type
 * names). Used by the coverage self-check: a policy term that appears in raw
 * source but in none of the extracted strings/comments must sit inside an
 * identifier (e.g. `duprEstimate`, `android:` object key) — anything else is
 * an extraction gap.
 */
export function identifierRanges(
  file: string,
  sourceText: string,
): Array<{ start: number; end: number; text: string }> {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const out: Array<{ start: number; end: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      out.push({ start: node.getStart(), end: node.getEnd(), text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Line number of an offset inside a raw literal (for multi-line templates). */
export function lineOfOffset(
  sourceText: string,
  absoluteOffset: number,
): number {
  let line = 1;
  for (let i = 0; i < absoluteOffset && i < sourceText.length; i++) {
    if (sourceText.charCodeAt(i) === 10) {
      line++;
    }
  }
  return line;
}
