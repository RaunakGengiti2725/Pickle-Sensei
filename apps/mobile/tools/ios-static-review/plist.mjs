/**
 * Minimal XML property-list reader (no dependencies).
 *
 * Handles the subset Apple's Info.plist / entitlements / PrivacyInfo files
 * use: dict, array, string, integer, real, true, false, date, data. Values
 * keep their source line so audit rows can cite `file:line`.
 */

const ENTITIES = {
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&apos;': "'",
};

function decodeEntities(text) {
  return text.replace(/&(lt|gt|amp|quot|apos);/g, m => ENTITIES[m]);
}

class Tokenizer {
  constructor(source) {
    this.source = source;
    this.pos = 0;
    this.tokens = [];
    const re =
      /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/?[A-Za-z]+(?:\s[^>]*?)?\/?>|[^<]+/g;
    let m;
    while ((m = re.exec(source)) !== null) {
      const raw = m[0];
      const line = source.slice(0, m.index).split('\n').length;
      if (raw.startsWith('<?') || raw.startsWith('<!')) continue;
      if (raw.startsWith('<')) {
        const closing = raw.startsWith('</');
        const selfClosing = raw.endsWith('/>');
        const name = raw
          .replace(/^<\/?/, '')
          .replace(/\/?>$/, '')
          .split(/\s/)[0];
        this.tokens.push({ kind: 'tag', name, closing, selfClosing, line });
      } else if (raw.trim().length > 0) {
        this.tokens.push({ kind: 'text', text: raw, line });
      }
    }
  }

  peek() {
    return this.tokens[this.pos];
  }

  next() {
    return this.tokens[this.pos++];
  }
}

function readText(tz) {
  const t = tz.peek();
  if (t && t.kind === 'text') {
    tz.next();
    return decodeEntities(t.text);
  }
  return '';
}

function expectClose(tz, name) {
  const t = tz.next();
  if (!t || t.kind !== 'tag' || !t.closing || t.name !== name) {
    throw new Error(`plist: expected </${name}> at line ${t ? t.line : 'EOF'}`);
  }
}

function parseValue(tz) {
  const open = tz.next();
  if (!open || open.kind !== 'tag' || open.closing) {
    throw new Error(
      `plist: expected value tag at line ${open ? open.line : 'EOF'}`,
    );
  }
  const line = open.line;
  switch (open.name) {
    case 'true':
      return { type: 'boolean', value: true, line };
    case 'false':
      return { type: 'boolean', value: false, line };
    case 'string': {
      if (open.selfClosing) return { type: 'string', value: '', line };
      const text = readText(tz);
      expectClose(tz, 'string');
      return { type: 'string', value: text, line };
    }
    case 'integer': {
      const text = readText(tz);
      expectClose(tz, 'integer');
      return { type: 'integer', value: Number.parseInt(text.trim(), 10), line };
    }
    case 'real': {
      const text = readText(tz);
      expectClose(tz, 'real');
      return { type: 'real', value: Number.parseFloat(text.trim()), line };
    }
    case 'date':
    case 'data': {
      if (open.selfClosing) return { type: open.name, value: '', line };
      const text = readText(tz);
      expectClose(tz, open.name);
      return { type: open.name, value: text.trim(), line };
    }
    case 'array': {
      const items = [];
      if (open.selfClosing) return { type: 'array', value: items, line };
      while (true) {
        const t = tz.peek();
        if (!t) throw new Error('plist: unterminated <array>');
        if (t.kind === 'tag' && t.closing && t.name === 'array') {
          tz.next();
          break;
        }
        items.push(parseValue(tz));
      }
      return { type: 'array', value: items, line };
    }
    case 'dict': {
      const entries = new Map();
      if (open.selfClosing) return { type: 'dict', value: entries, line };
      while (true) {
        const t = tz.next();
        if (!t) throw new Error('plist: unterminated <dict>');
        if (t.kind === 'tag' && t.closing && t.name === 'dict') break;
        if (t.kind !== 'tag' || t.name !== 'key' || t.closing) {
          throw new Error(`plist: expected <key> at line ${t.line}`);
        }
        const keyLine = t.line;
        const key = t.selfClosing ? '' : readText(tz);
        if (!t.selfClosing) expectClose(tz, 'key');
        if (entries.has(key)) {
          throw new Error(
            `plist: duplicate key "${key}" at line ${keyLine} (first at line ${entries.get(key).keyLine})`,
          );
        }
        const value = parseValue(tz);
        entries.set(key, { keyLine, ...value });
      }
      return { type: 'dict', value: entries, line };
    }
    default:
      throw new Error(`plist: unsupported tag <${open.name}> at line ${line}`);
  }
}

/** Parses XML plist text into a typed tree that keeps line numbers. */
export function parsePlist(source) {
  const tz = new Tokenizer(source);
  const open = tz.next();
  if (!open || open.kind !== 'tag' || open.name !== 'plist') {
    throw new Error('plist: missing <plist> root');
  }
  const root = parseValue(tz);
  expectClose(tz, 'plist');
  return root;
}

/** Converts a typed tree into plain JS (Map → object, drops line numbers). */
export function toPlain(node) {
  switch (node.type) {
    case 'dict': {
      const out = {};
      for (const [k, v] of node.value) out[k] = toPlain(v);
      return out;
    }
    case 'array':
      return node.value.map(toPlain);
    default:
      return node.value;
  }
}

/** Looks up a top-level key; returns the typed node or undefined. */
export function dictGet(dictNode, key) {
  if (dictNode.type !== 'dict') return undefined;
  return dictNode.value.get(key);
}
