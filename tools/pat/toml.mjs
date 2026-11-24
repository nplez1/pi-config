// Minimal TOML reader for the shapes pat's own files use: comments, [table],
// [[array-of-tables]], bare and quoted keys, basic/literal strings, integers,
// floats, booleans, arrays (single- or multi-line) and inline tables.
//
// Everything outside that subset throws with a file:line instead of being
// silently misread — a mangled inventory is worse than a parse error, because
// the failure would surface as a wrong token weeks later.

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

export function parseToml(text, file = 'toml') {
  const lines = text.split(/\r?\n/);
  const root = {};
  let current = root;
  let i = 0;
  // Which headers were written explicitly, and which paths are arrays of
  // tables. Redefinition is an error rather than a silent last-one-wins, so a
  // duplicated id cannot quietly become a different token.
  // Which table objects were written explicitly, keyed by identity rather than
  // by path: two [[token]] elements may each carry their own [token.check] sub
  // table, but declaring [self] twice lands on the same object and must fail.
  const state = { declared: new WeakSet(), inline: new WeakSet() };

  const fail = (lineNo, message) => {
    throw new Error(`${file}:${lineNo}: ${message}`);
  };

  while (i < lines.length) {
    const lineNo = i + 1;
    const line = stripComment(lines[i]).trim();
    i += 1;
    if (!line) continue;

    if (line.startsWith('[[')) {
      if (!line.endsWith(']]')) fail(lineNo, 'unterminated [[table]] header');
      current = pushArrayTable(root, parseKeyPath(line.slice(2, -2), fail, lineNo), fail, lineNo, state);
      continue;
    }
    if (line.startsWith('[')) {
      if (!line.endsWith(']')) fail(lineNo, 'unterminated [table] header');
      current = ensureTable(root, parseKeyPath(line.slice(1, -1), fail, lineNo), fail, lineNo, state, { declare: true });
      continue;
    }

    const eq = findAssign(line, fail, lineNo);
    const keyPath = parseKeyPath(line.slice(0, eq), fail, lineNo);
    let valueText = line.slice(eq + 1);
    // An array may run over several lines; keep consuming until it closes.
    while (!bracketsBalanced(valueText)) {
      if (i >= lines.length) fail(lineNo, 'unterminated array value');
      valueText += `\n${stripComment(lines[i])}`;
      i += 1;
    }
    assignValue(current, keyPath, parseValue(valueText.trim(), fail, lineNo, state), fail, lineNo);
  }

  return root;
}

// Split `a.b."c.d"` into keys, honouring quotes and escapes.
function parseKeyPath(text, fail, lineNo) {
  const parts = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote === '"') {
      if (c === '\\') {
        current += text[i + 1] ?? '';
        i += 1;
        continue;
      }
      if (c === '"') {
        quote = null;
        continue;
      }
      current += c;
      continue;
    }
    if (quote === "'") {
      if (c === "'") {
        quote = null;
        continue;
      }
      current += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '.') {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current.trim());

  if (parts.some((part) => part === '')) fail(lineNo, `empty key segment in ${JSON.stringify(text.trim())}`);
  const keys = parts;
  if (!keys.length) fail(lineNo, 'empty key');
  for (const key of keys) {
    if (!BARE_KEY.test(key) && /[\s[\]]/.test(key)) fail(lineNo, `unsupported key ${JSON.stringify(key)}`);
  }
  return keys;
}

function findAssign(line, fail, lineNo) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote === '"') {
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '=') return i;
  }
  fail(lineNo, 'expected key = value');
  return -1;
}

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote === '"') {
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '#') return line.slice(0, i);
  }
  return line;
}

function bracketsBalanced(text) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote === '"') {
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '[') depth += 1;
    else if (c === ']') depth -= 1;
  }
  return depth <= 0;
}

function ensureTable(root, path, fail, lineNo, state, { declare = false } = {}) {
  let node = root;
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index];
    const isLast = index === path.length - 1;
    if (Array.isArray(node)) node = node[node.length - 1];
    if (node[segment] === undefined) {
      node[segment] = {};
      node = node[segment];
      continue;
    }
    const next = node[segment];
    if (Array.isArray(next)) {
      // Descending into the last element is right for [token.check]; landing on
      // an array as the header itself is a table/array clash.
      if (isLast) fail(lineNo, `[${path.join('.')}] is already an array of tables`);
      if (!next.length) fail(lineNo, `[${path.join('.')}] has no table to attach to`);
      node = next[next.length - 1];
      continue;
    }
    if (next && typeof next === 'object') {
      if (isLast && state.inline.has(next)) {
        fail(lineNo, `[${path.join('.')}] was already defined as an inline table`);
      }
      node = next;
      continue;
    }
    fail(lineNo, `[${path.join('.')}] conflicts with an existing value`);
  }

  if (declare) {
    if (state.declared.has(node)) fail(lineNo, `[${path.join('.')}] is declared more than once`);
    state.declared.add(node);
  }
  return node;
}

function pushArrayTable(root, path, fail, lineNo, state) {
  const key = path[path.length - 1];
  const parentPath = path.slice(0, -1);
  let parent = parentPath.length ? ensureTable(root, parentPath, fail, lineNo, state) : root;
  if (Array.isArray(parent)) parent = parent[parent.length - 1];
  if (parent[key] === undefined) parent[key] = [];
  else if (!Array.isArray(parent[key])) fail(lineNo, `[[${path.join('.')}]] conflicts with an existing table`);
  const entry = {};
  parent[key].push(entry);
  return entry;
}

function assignValue(current, keyPath, value, fail, lineNo) {
  let node = current;
  for (const key of keyPath.slice(0, -1)) {
    if (node[key] === undefined) {
      node[key] = {};
    } else if (!node[key] || typeof node[key] !== 'object' || Array.isArray(node[key])) {
      fail(lineNo, `key ${keyPath.join('.')} conflicts with an existing value`);
    }
    node = node[key];
  }
  const last = keyPath[keyPath.length - 1];
  if (Object.prototype.hasOwnProperty.call(node, last)) {
    fail(lineNo, `key ${keyPath.join('.')} is defined more than once`);
  }
  node[last] = value;
  return node;
}

function parseValue(text, fail, lineNo, state) {
  if (text === '') fail(lineNo, 'missing value');
  if (text.startsWith('"')) return parseBasicString(text, fail, lineNo);
  if (text.startsWith("'")) return parseLiteralString(text, fail, lineNo);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text.startsWith('[')) return parseArray(text, fail, lineNo, state);
  if (text.startsWith('{')) return parseInlineTable(text, fail, lineNo, state);
  // TOML dates (2026-10-14, 2026-10-14T09:30:00Z) stay verbatim strings: pat
  // only ever compares them as text and never needs timezone arithmetic. The
  // time part is validated, so `2026-10-14 oops` is a parse error rather than a
  // string that silently becomes an unparseable issue date.
  if (/^[+-]?\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?)?$/.test(text)) return text;
  if (/^[+-]?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(text)) return Number(text);
  fail(lineNo, `unsupported value ${JSON.stringify(text)}`);
  return undefined;
}

function parseBasicString(text, fail, lineNo) {
  let out = '';
  let i = 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      const next = text[i + 1];
      const simple = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' };
      if (next === 'u' || next === 'U') {
        const width = next === 'u' ? 4 : 8;
        const hex = text.slice(i + 2, i + 2 + width);
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== width) fail(lineNo, 'bad unicode escape');
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        i += 2 + width;
        continue;
      }
      if (next in simple) {
        out += simple[next];
        i += 2;
        continue;
      }
      fail(lineNo, `unsupported escape \\${next ?? ''}`);
    }
    if (c === '"') {
      if (text.slice(i + 1).trim() !== '') fail(lineNo, 'trailing text after string');
      return out;
    }
    out += c;
    i += 1;
  }
  fail(lineNo, 'unterminated string');
  return out;
}

function parseLiteralString(text, fail, lineNo) {
  const end = text.indexOf("'", 1);
  if (end < 0) fail(lineNo, 'unterminated literal string');
  if (text.slice(end + 1).trim() !== '') fail(lineNo, 'trailing text after string');
  return text.slice(1, end);
}

function splitTopLevel(text, separator) {
  const parts = [];
  let current = '';
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote === '"') {
      current += c;
      if (c === '\\') {
        current += text[i + 1] ?? '';
        i += 1;
        continue;
      }
      if (c === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      current += c;
      if (c === "'") quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === '[' || c === '{') depth += 1;
    else if (c === ']' || c === '}') depth -= 1;
    if (c === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

function parseArray(text, fail, lineNo, state) {
  if (!text.endsWith(']')) fail(lineNo, 'unterminated array');
  const items = splitTopLevel(text.slice(1, -1), ',').map((part) => part.trim());
  // A hole (`[\"a\",,\"b\"]`) is a typo, not an empty string: fail rather than
  // silently shortening the array.
  if (items.some((item) => item === '')) fail(lineNo, 'array contains an empty element');
  return items.map((item) => parseValue(item, fail, lineNo, state));
}

function parseInlineTable(text, fail, lineNo, state) {
  if (!text.endsWith('}')) fail(lineNo, 'unterminated inline table');
  const table = {};
  for (const part of splitTopLevel(text.slice(1, -1), ',')) {
    const chunk = part.trim();
    if (!chunk) continue;
    const eq = findAssign(chunk, fail, lineNo);
    const keyPath = parseKeyPath(chunk.slice(0, eq), fail, lineNo);
    assignValue(table, keyPath, parseValue(chunk.slice(eq + 1).trim(), fail, lineNo, state), fail, lineNo);
  }
  if (state) state.inline.add(table);
  return table;
}

// Render a JS string as a TOML basic string. JSON's escaping is a subset that
// TOML accepts, so this stays simple and always round-trips.
export function tomlString(value) {
  return JSON.stringify(String(value));
}

export function tomlArray(values) {
  return `[${values.map((value) => tomlString(value)).join(', ')}]`;
}
