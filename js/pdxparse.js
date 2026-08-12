/* pdxparse.js — client-side port of the Python build pipeline's parsing
   core (tools/pdx/*, tools/inline_scripts.py, tools/loc.py). Used ONLY for
   user-supplied files (dev feature); the shipped dataset is built in CI by
   the Python pipeline, which remains the reference implementation. The
   grammar here mirrors it 1:1 — see tests/pdxparse-test.mjs, which runs
   this port against the same real-file fixtures as the Python suite. */

// ---------------------------------------------------------------- decoding

/* windows-1252's high range, spelled out.

   This used to be `new TextDecoder("windows-1252")`. That decoder is a
   legacy single-byte encoding, and legacy encodings are only present when
   Node is built with full ICU — a small-icu or system-icu runner throws
   RangeError and the whole parse fails on one smart quote. Rather than
   depend on how a given CI image happened to be built, map the 32 code
   points by hand. Everything outside 0x80-0x9F is identical to latin-1,
   which is just the code point itself. */
const CP1252_HIGH = [
  0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
  0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F,
  0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
  0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
];

function decodeCp1252(bytes) {
  let out = "";
  for (const b of bytes)
    out += String.fromCharCode(
      b >= 0x80 && b <= 0x9F ? CP1252_HIGH[b - 0x80] : b);
  return out;
}

export function decodeBytes(buf) {
  const bytes = new Uint8Array(buf);
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  const body = bytes.subarray(start);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body)
      .replace(/\r\n?/g, "\n");
  } catch {
    return decodeCp1252(body).replace(/\r\n?/g, "\n");
  }
}

// ------------------------------------------------------------------- lexer

const OP_CHARS = new Set(["=", "<", ">", "!"]);
const BARE_END = new Set([" ", "\t", "\n", "{", "}", "#", '"',
                          "=", "<", ">", "!"]);

export class PdxError extends Error {
  constructor(message, line, col) {
    super(`${message} at line ${line}, col ${col}`);
    this.line = line; this.col = col;
  }
}

function* tokenize(text) {
  let i = 0, line = 1, col = 1;
  const n = text.length;
  const bump = (k = 1) => {
    for (let j = 0; j < k; j++) {
      if (text[i] === "\n") { line++; col = 1; } else col++;
      i++;
    }
  };
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n") { bump(); continue; }
    if (c === "#") { while (i < n && text[i] !== "\n") bump(); continue; }
    if (c === "{" || c === "}") {
      yield { kind: c, line, col }; bump(); continue;
    }
    if (OP_CHARS.has(c)) {
      const sl = line, sc = col;
      let op = c;
      if (text[i + 1] === "=") op += "=";
      if (["=", "==", "!=", "<", ">", "<=", ">="].includes(op)) {
        yield { kind: "op", value: op, line: sl, col: sc };
        bump(op.length); continue;
      }
      throw new PdxError(`unexpected character ${c}`, line, col);
    }
    if (c === '"') {
      const sl = line, sc = col;
      bump();
      let buf = "";
      for (;;) {
        // Multi-line strings are legitimate (inline_script `code` params).
        if (i >= n) throw new PdxError("unterminated string", sl, sc);
        if (text[i] === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) {
          buf += text[i + 1]; bump(2); continue;
        }
        if (text[i] === '"') { bump(); break; }
        buf += text[i]; bump();
      }
      yield { kind: "str", value: buf, line: sl, col: sc };
      continue;
    }
    if (c === "@" && (text[i + 1] === "[" || text.substr(i + 1, 2) === "\\[")) {
      const sl = line, sc = col;
      bump(text[i + 1] === "[" ? 2 : 3);
      let buf = "";
      for (;;) {
        if (i >= n) throw new PdxError("unterminated @[ maths ]", sl, sc);
        if (text[i] === "\\" && text[i + 1] === "]") { bump(2); break; }
        if (text[i] === "]") { bump(); break; }
        buf += text[i]; bump();
      }
      yield { kind: "math", value: buf.trim(), line: sl, col: sc };
      continue;
    }
    const sl = line, sc = col;
    let buf = "";
    while (i < n && !BARE_END.has(text[i])) { buf += text[i]; bump(); }
    if (!buf) throw new PdxError(`unexpected character ${c}`, line, col);
    yield { kind: "val", value: buf, line: sl, col: sc };
  }
  yield { kind: "eof", line, col };
}

// -------------------------------------------------------------------- AST

export class VarRef {
  constructor(name) { this.name = name; }
  toString() { return `@${this.name}`; }
}
export class MathExpr {
  constructor(expr) { this.expr = expr; }
  toString() { return `@[${this.expr}]`; }
}

export class Block {
  constructor(line = 0) { this.items = []; this.line = line; }
  *pairs() { for (const it of this.items) if (it && it.key !== undefined) yield it; }
  bareValues() { return this.items.filter(it => !it || it.key === undefined); }
  getAll(key) {
    const out = [];
    for (const p of this.pairs()) if (p.key === key) out.push(p.value);
    return out;
  }
  get(key, dflt = null) {
    for (const p of this.pairs()) if (p.key === key) return p.value;
    return dflt;
  }
  getLast(key, dflt = null) {
    let out = dflt;
    for (const p of this.pairs()) if (p.key === key) out = p.value;
    return out;
  }
  has(key) { for (const p of this.pairs()) if (p.key === key) return true; return false; }
}

function scalarFrom(tok) {
  if (tok.kind === "str") return tok.value;
  if (tok.kind === "math") return new MathExpr(tok.value);
  const v = tok.value;
  if (v.startsWith("@") && v.length > 1) return new VarRef(v.slice(1));
  return v;
}

export function parse(text) {
  const toks = [...tokenize(text)];
  let pos = 0;
  const peek = (k = 0) => toks[Math.min(pos + k, toks.length - 1)];
  const take = () => { const t = toks[pos]; if (t.kind !== "eof") pos++; return t; };

  function body(top = false) {
    const blk = new Block(peek().line);
    for (;;) {
      const tok = peek();
      if (tok.kind === "eof") {
        if (top) return blk;
        throw new PdxError("unexpected end of file inside block",
                           tok.line, tok.col);
      }
      if (tok.kind === "}") {
        if (top) throw new PdxError("unmatched '}'", tok.line, tok.col);
        return blk;
      }
      if (tok.kind === "val" || tok.kind === "str" || tok.kind === "math") {
        if (tok.kind !== "math" && peek(1).kind === "op") {
          blk.items.push(pair());
        } else {
          take();
          blk.items.push(scalarFrom(tok));
        }
        continue;
      }
      if (tok.kind === "{") {
        take();
        const inner = body();
        take(); // }
        blk.items.push({ key: "", op: "=", value: inner, line: tok.line });
        continue;
      }
      throw new PdxError(`unexpected ${tok.kind}`, tok.line, tok.col);
    }
  }

  function pair() {
    const key = take(), op = take(), val = peek();
    if (val.kind === "{") {
      take();
      const inner = body();
      take(); // }
      return { key: key.value, op: op.value, value: inner, line: key.line };
    }
    if (val.kind === "val" || val.kind === "str" || val.kind === "math") {
      take();
      return { key: key.value, op: op.value, value: scalarFrom(val),
               line: key.line };
    }
    throw new PdxError(`expected value after '${key.value} ${op.value}'`,
                       val.line, val.col);
  }

  const blk = body(true);
  if (peek().kind !== "eof")
    throw new PdxError(`unexpected ${peek().kind}`, peek().line, peek().col);
  return blk;
}

export const parseBytes = buf => parse(decodeBytes(buf));

// -------------------------------------------------------------- variables

export function parseNumber(t) {
  if (typeof t !== "string" || !t.trim()) return null;
  const num = Number(t);
  return Number.isFinite(num) ? num : null;
}

export class VarTable {
  constructor(fallback = null) { this.defs = new Map(); this.fallback = fallback; }
  define(name, value, sourceFile = "?", line = 0) {
    this.defs.set(name.replace(/^@/, ""), { value, sourceFile, line });
  }
  lookup(name) {
    name = name.replace(/^@/, "");
    return this.defs.get(name) ?? this.fallback?.lookup(name) ?? null;
  }
  loadDefinitions(block, sourceFile = "?") {
    for (const p of block.pairs()) {
      if (!p.key.startsWith("@")) continue;
      const [v, err] = resolve(p.value, this);
      if (err === null && typeof v === "number")
        this.define(p.key, v, sourceFile, p.line);
    }
  }
}

export function evalMath(expr, table) {
  let i = 0;
  const ws = () => { while (expr[i] === " " || expr[i] === "\t") i++; };
  const peekc = () => (ws(), expr[i] ?? "");
  const err = m => { throw new Error(`${m} in ${JSON.stringify(expr)}`); };
  function atom() {
    ws();
    if (/[0-9.]/.test(expr[i] ?? "")) {
      const s = i;
      while (/[0-9.eE]/.test(expr[i] ?? "")) i++;
      const n = parseNumber(expr.slice(s, i));
      if (n === null) err("bad number");
      return n;
    }
    if (expr[i] === "@" || /[A-Za-z_]/.test(expr[i] ?? "")) {
      if (expr[i] === "@") i++;
      const s = i;
      while (/[A-Za-z0-9_]/.test(expr[i] ?? "")) i++;
      const hit = table.lookup(expr.slice(s, i));
      if (!hit) err(`undefined variable @${expr.slice(s, i)}`);
      return hit.value;
    }
    err("unexpected character");
  }
  function factor() {
    const c = peekc();
    if (c === "-") { i++; return -factor(); }
    if (c === "+") { i++; return factor(); }
    if (c === "(") {
      i++;
      const v = exprFn();
      if (peekc() !== ")") err("missing ')'");
      i++;
      return v;
    }
    return atom();
  }
  function term() {
    let v = factor();
    for (;;) {
      const c = peekc();
      if (c === "*") { i++; v *= factor(); }
      else if (c === "/") {
        i++;
        const d = factor();
        if (d === 0) err("division by zero");
        v /= d;
      } else return v;
    }
  }
  function exprFn() {
    let v = term();
    for (;;) {
      const c = peekc();
      if (c === "+") { i++; v += term(); }
      else if (c === "-") { i++; v -= term(); }
      else return v;
    }
  }
  const v = exprFn();
  ws();
  if (i !== expr.length) err("trailing input");
  return Number.isInteger(v) ? v : v;
}

export function resolve(value, table) {
  if (value instanceof VarRef) {
    const hit = table.lookup(value.name);
    return hit ? [hit.value, null] : [value, `undefined variable @${value.name}`];
  }
  if (value instanceof MathExpr) {
    try { return [evalMath(value.expr, table), null]; }
    catch (e) { return [value, e.message]; }
  }
  if (typeof value === "string") {
    const n = parseNumber(value);
    return n !== null ? [n, null] : [value, null];
  }
  return [value, null];
}

// --------------------------------------------------------- inline scripts

export class InlineScriptLibrary {
  constructor() { this.scripts = new Map(); this.unexpanded = []; }

  add(id, text) { this.scripts.set(id, text); }

  substitute(text, params) {
    text = applyOptionals(text, params);
    return text.replace(/\$([A-Za-z0-9_]+)\$/g,
      (m, key) => params.has(key) ? params.get(key).join(" ") : m);
  }

  expandBlock(block, depth = 0, context = "?") {
    const out = new Block(block.line);
    for (const item of block.items) {
      if (!item || item.key === undefined) { out.items.push(item); continue; }
      if (item.key !== "inline_script") {
        const v = item.value instanceof Block
          ? this.expandBlock(item.value, depth, context) : item.value;
        out.items.push({ ...item, value: v });
        continue;
      }
      const [sid, params] = scriptCall(item);
      if (!sid || !this.scripts.has(sid) || depth >= 8) {
        if (sid && !this.scripts.has(sid))
          this.unexpanded.push({ script: sid, context, line: item.line });
        out.items.push(item);
        continue;
      }
      let sub;
      try { sub = parse(this.substitute(this.scripts.get(sid), params)); }
      catch (e) {
        this.unexpanded.push({ script: sid, context, error: e.message });
        out.items.push(item);
        continue;
      }
      out.items.push(...this.expandBlock(sub, depth + 1, context).items);
    }
    return out;
  }
}

function scriptCall(pair) {
  const v = pair.value;
  if (v instanceof Block) {
    let sid = null;
    const params = new Map();
    for (const p of v.pairs()) {
      const s = paramText(p.value);
      if (p.key === "script") sid = s;
      else {
        if (!params.has(p.key)) params.set(p.key, []);
        params.get(p.key).push(s);
      }
    }
    return [sid, params];
  }
  return [paramText(v), new Map()];
}

function paramText(v) {
  if (v instanceof Block) {
    return v.items.map(it => {
      if (!it || it.key === undefined) return String(it);
      const inner = it.value instanceof Block
        ? `{ ${paramText(it.value)} }` : paramText(it.value);
      return `${it.key} ${it.op} ${inner}`;
    }).join(" ");
  }
  return String(v);
}

function applyOptionals(text, params) {
  let out = "", i = 0;
  const n = text.length;
  while (i < n) {
    if (text.startsWith("[[", i)) {
      const m = /^\[\[(!?)([A-Za-z0-9_]+)\]/.exec(text.slice(i));
      if (m) {
        const neg = m[1] === "!", key = m[2];
        let j = i + m[0].length, depth = 1;
        const start = j;
        while (j < n && depth) {
          if (text.startsWith("[[", j)) { depth++; j += 2; }
          else if (text[j] === "]") { depth--; j++; }
          else j++;
        }
        const inner = text.slice(start, j - 1);
        const include = neg ? !params.has(key) : params.has(key);
        if (include) out += applyOptionals(inner, params);
        i = j;
        continue;
      }
    }
    out += text[i]; i++;
  }
  return out;
}

// ------------------------------------------------------------ localisation

const LOC_ENTRY = /^\s*([A-Za-z0-9_.\-']+):(\d*)\s*"(.*)$/;
const SUBST = /\$([A-Za-z0-9_.\-']+)(?:\|[^$]*)?\$/g;

export class LocTable {
  constructor() { this.entries = new Map(); }
  loadText(text, sourceFile = "?", language = "english") {
    let inTarget = false, sawHeader = false;
    let lineno = 0;
    for (const raw of text.split("\n")) {
      lineno++;
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const hm = /^l_(\w+)\s*:\s*$/.exec(line);
      if (hm) { sawHeader = true; inTarget = hm[1] === language; continue; }
      if (!inTarget) {
        if (sawHeader) continue;
        inTarget = true;
      }
      const m = LOC_ENTRY.exec(raw);
      if (!m) continue;
      const end = m[3].lastIndexOf('"');
      const body = (end !== -1 ? m[3].slice(0, end) : m[3])
        .replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\t/g, "\t");
      this.entries.set(m[1], body);
    }
  }
  get(key) { return this.entries.get(key) ?? null; }
  resolveSubst(value, depth = 6) {
    if (depth <= 0 || !value.includes("$")) return value;
    return value.replace(SUBST, (m, key) => {
      const hit = this.entries.get(key) ?? this.entries.get("giga_vanilla_" + key);
      return hit === undefined || hit === null
        ? m : this.resolveSubst(hit, depth - 1);
    });
  }
}

export function stripMarkup(value) {
  return value.replace(/§./g, "").replace(/§!/g, "")
    .replace(/£[A-Za-z0-9_]+£?/g, "")
    .replace(/\s{2,}/g, " ").trim();
}
