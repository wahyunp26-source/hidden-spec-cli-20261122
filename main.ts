// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Pairs (old, new) of move edits that ran in this process, for the R lines of section 2. */
const movePairs: Array<{ old: string; nw: string }> = [];

/** A file as lines: its line break, whether it ends with one, and its lines. */
interface Doc {
  lines: string[];
  br: string;
  hasBreak: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', hasBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const hasBreak = text.endsWith(br);
  if (hasBreak) parts.pop();
  return { lines: parts, br, hasBreak };
}

function docText(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.hasBreak ? d.br : '');
}

function stripTrail(s: string): string {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i -= 1;
  return s.slice(0, i);
}

function stripBoth(s: string): string {
  let a = 0;
  while (a < s.length && (s[a] === ' ' || s[a] === '\t')) a += 1;
  let b = s.length;
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b -= 1;
  return s.slice(a, b);
}

function leadWs(s: string): string {
  let a = 0;
  while (a < s.length && (s[a] === ' ' || s[a] === '\t')) a += 1;
  return s.slice(0, a);
}

/** Line equality at one tier (SPEC.md section 5). */
function lineEq(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Positions where O occurs in lines at one tier, starting at or after `from`. */
function occAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(tier, lines[i + j]!, o[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier with an occurrence of O at or after `from` (tier 0 only when strict), else null. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const top = strict ? 1 : 3;
  for (let t = 0; t < top; t += 1) {
    const occ = occAt(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk, with its raw patch line. */
interface BodyLine {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  raw: string;
}

/** Split a body into O (context + old lines) and N (context lines carry their O index). */
function splitON(body: BodyLine[]): { o: string[]; n: Array<{ text: string; ctx: number | null }> } {
  const o: string[] = [];
  const n: Array<{ text: string; ctx: number | null }> = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.kind === 'del') {
      o.push(b.text);
    } else if (b.kind === 'add') {
      n.push({ text: b.text, ctx: null });
    }
  }
  return { o, n };
}

/**
 * Replacement lines for a matched occurrence: context lines are the file's own matched lines;
 * at tier 2 every other line is re-indented from O's first line's leading whitespace to the
 * file's first matched line's leading whitespace (SPEC.md section 5).
 */
function buildNew(fileLines: string[], at: number, o: string[], n: Array<{ text: string; ctx: number | null }>, tier: number): string[] {
  const out: string[] = [];
  const f = fileLines[at] !== undefined ? leadWs(fileLines[at]!) : '';
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  for (const item of n) {
    if (item.ctx !== null) {
      out.push(fileLines[at + item.ctx]!);
      continue;
    }
    let t = item.text;
    if (tier === 2 && t !== '' && stripBoth(t) !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** Index of the last context or `+` body line, or -1 when there is none. */
function lastCtxOrAddIdx(body: BodyLine[]): number {
  let idx = -1;
  body.forEach((b, i) => {
    if (b.kind === 'ctx' || b.kind === 'add') idx = i;
  });
  return idx;
}

/** Index of the last `+` body line, or -1 when there is none. */
function lastAddIdx(body: BodyLine[]): number {
  let idx = -1;
  body.forEach((b, i) => {
    if (b.kind === 'add') idx = i;
  });
  return idx;
}

/** Whether a `\` line follows the body line at `idx`. */
function hasBsAfter(body: BodyLine[], idx: number): boolean {
  if (idx < 0) return false;
  return body[idx + 1] !== undefined && body[idx + 1]!.kind === 'bs';
}

// ---- Section 6: unified diffs ----

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UniSection {
  diffOld?: string;
  diffNew?: string;
  pairOld?: string;
  pairNew?: string;
  renOld?: string;
  renNew?: string;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Path from a `--- <path>` / `+++ <path>` line: text after 4 chars, up to the first tab, trimmed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab < 0 ? rest : rest.slice(0, tab)).trim();
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/([^ \t]+) b\/([^ \t]+)[ \t]*$/;

function toUniBody(raw: string): BodyLine {
  if (raw === '') return { kind: 'ctx', text: '', raw };
  const c = raw[0];
  if (c === ' ') return { kind: 'ctx', text: raw.slice(1), raw };
  if (c === '-') return { kind: 'del', text: raw.slice(1), raw };
  if (c === '+') return { kind: 'add', text: raw.slice(1), raw };
  return { kind: 'bs', text: raw, raw };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let state: 'outside' | 'header' | 'body' = 'outside';
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffOld: m[1], diffNew: m[2], create: false, del: false, hunks: [] };
      sections.push(cur);
      state = 'header';
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (state === 'header' && cur !== null) {
        cur.pairOld = stripAB(headerPath(line));
        cur.pairNew = stripAB(headerPath(lines[i + 1]!));
      } else {
        cur = { pairOld: stripAB(headerPath(line)), pairNew: stripAB(headerPath(lines[i + 1]!)), create: false, del: false, hunks: [] };
        sections.push(cur);
        state = 'header';
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      i += 1;
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          hunk.body.push(toUniBody(bl));
          i += 1;
          continue;
        }
        break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.raw === '') hunk.body.pop();
      cur.hunks.push(hunk);
      state = 'body';
      continue;
    }
    if (state === 'header' && cur !== null) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        cur.renOld = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renNew = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.del = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function resolveUni(s: UniSection): { oldP: string | null | undefined; newP: string | null | undefined } {
  const conv = (r: string | undefined): string | null | undefined => {
    if (r === undefined) return undefined;
    if (r === '/dev/null') return null;
    return r;
  };
  const oldRaw = s.pairOld !== undefined ? s.pairOld : s.renOld !== undefined ? s.renOld : s.diffOld;
  const newRaw = s.pairNew !== undefined ? s.pairNew : s.renNew !== undefined ? s.renNew : s.diffNew;
  let oldP = conv(oldRaw);
  let newP = conv(newRaw);
  if (oldP === undefined && newP !== undefined) oldP = newP;
  if (newP === undefined && oldP !== undefined) newP = oldP;
  return { oldP, newP };
}

/** Apply one hunk; returns the new doc plus the hunk's length delta for `d` (section 6). */
function applyUnifiedHunk(doc: Doc, h: Hunk, strict: boolean, d: number, path: string): { doc: Doc; delta: number } {
  const { o, n } = splitON(h.body);
  const delta = n.length - o.length;
  const lines = doc.lines;
  if (o.length === 0) {
    const at = Math.min(Math.max(h.a + d, 0), lines.length);
    const out = [...lines.slice(0, at), ...n.map((x) => x.text), ...lines.slice(at)];
    let hasBreak = doc.hasBreak;
    if (at === lines.length) hasBreak = !hasBsAfter(h.body, lastCtxOrAddIdx(h.body));
    return { doc: { lines: out, br: doc.br, hasBreak }, delta };
  }
  const found = findTier(lines, o, strict, 0);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const pos of found.occ) {
    const dist = Math.abs(pos - target);
    if (dist < bestDist) {
      best = pos;
      bestDist = dist;
    }
  }
  const rep = buildNew(lines, best, o, n, found.tier);
  const out = [...lines.slice(0, best), ...rep, ...lines.slice(best + o.length)];
  let hasBreak = doc.hasBreak;
  if (best + o.length === lines.length) hasBreak = !hasBsAfter(h.body, lastCtxOrAddIdx(h.body));
  return { doc: { lines: out, br: doc.br, hasBreak }, delta };
}

function unifiedEdit(s: UniSection, strict: boolean): Edit {
  const { oldP, newP } = resolveUni(s);
  const isCreate = s.create || oldP === null;
  const isDelete = !isCreate && (s.del || newP === null);
  const isMove = !isCreate && !isDelete && oldP !== null && oldP !== undefined && newP !== null && newP !== undefined && oldP !== newP;
  return (tree) => {
    if (oldP === undefined || newP === undefined || (oldP === null && newP === null)) return;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const added: string[] = [];
      for (const h of s.hunks) {
        for (const b of h.body) if (b.kind === 'add') added.push(b.text);
      }
      let hasBreak = true;
      let lastHunk: Hunk | null = null;
      for (const h of s.hunks) {
        if (h.body.some((b) => b.kind === 'add')) lastHunk = h;
      }
      if (lastHunk !== null) hasBreak = !hasBsAfter(lastHunk.body, lastAddIdx(lastHunk.body));
      tree.now.set(np, added.length === 0 ? '' : added.join('\n') + (hasBreak ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP!;
    const np = newP!;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    let doc = parseDoc(before);
    let d = 0;
    for (const h of s.hunks) {
      const applied = applyUnifiedHunk(doc, h, strict, d, op);
      doc = applied.doc;
      d += applied.delta;
    }
    const text = docText(doc);
    if (isMove) {
      tree.now.set(op, null);
      tree.now.set(np, text);
      movePairs.push({ old: op, nw: np });
    } else {
      tree.now.set(op, text);
    }
  };
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const doc = parseDoc(before);
    const found = findTier(doc.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const nItems = newLines.map((t) => ({ text: t, ctx: null as number | null }));
    const rep = buildNew(doc.lines, at, oldLines, nItems, found.tier);
    const out = [...doc.lines.slice(0, at), ...rep, ...doc.lines.slice(at + oldLines.length)];
    tree.now.set(path, docText({ lines: out, br: doc.br, hasBreak: doc.hasBreak }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | undefined = undefined;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | undefined = undefined;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (l.trim() === '') continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === undefined) path = prevPath;
    if (path === undefined) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let sep = -1;
    for (let j = searchIdx + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = sep + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(searchIdx + 1, sep), lines.slice(sep + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---- Section 8: V4A patches ----

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
  startedAt: 'at' | 'body';
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo?: string;
  addLines?: string[];
  chunks?: V4aChunk[];
}

function toV4aBody(raw: string): BodyLine {
  if (raw === '') return { kind: 'ctx', text: '', raw };
  const c = raw[0];
  if (c === ' ') return { kind: 'ctx', text: raw.slice(1), raw };
  if (c === '-') return { kind: 'del', text: raw.slice(1), raw };
  return { kind: 'add', text: raw.slice(1), raw };
}

function isV4aBodyLine(l: string): boolean {
  return l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+');
}

/** Collect one V4A chunk body starting at `i`; returns the index after the chunk. */
function collectV4aBody(lines: string[], i: number, last: number, isSectionStart: (l: string) => boolean, ch: V4aChunk): number {
  let stoppedBy: 'at' | 'eof' | 'section' = 'section';
  while (i < last) {
    const l = lines[i]!;
    if (l.startsWith('@@')) {
      stoppedBy = 'at';
      break;
    }
    if (l.trim() === '*** End of File') {
      stoppedBy = 'eof';
      break;
    }
    if (isSectionStart(l)) {
      stoppedBy = 'section';
      break;
    }
    if (isV4aBodyLine(l)) {
      ch.body.push(toV4aBody(l));
      i += 1;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (stoppedBy === 'eof') {
    ch.eof = true;
    i += 1;
  }
  if (stoppedBy === 'section') {
    while (ch.body.length > 0 && ch.body[ch.body.length - 1]!.raw.trim() === '') ch.body.pop();
  }
  return i;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (lines[k]!.trim() !== '') {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      const rawLines: string[] = [];
      const rawIdx: number[] = [];
      i += 1;
      while (i < last && !isSectionStart(lines[i]!)) {
        rawLines.push(lines[i]!);
        rawIdx.push(i);
        i += 1;
      }
      while (rawLines.length > 0 && rawLines[rawLines.length - 1]!.trim() === '') {
        rawLines.pop();
        rawIdx.pop();
      }
      const addLines: string[] = [];
      for (let k = 0; k < rawLines.length; k += 1) {
        const rl = rawLines[k]!;
        if (rl.startsWith('+')) addLines.push(rl.slice(1));
        else if (rl === '') addLines.push('');
        else throw new Exit2(`error: parse ${rawIdx[k]! + 1}`);
      }
      edits.push(v4aEdit({ kind: 'add', path: p, addLines }, strict));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      edits.push(v4aEdit({ kind: 'delete', path: p }, strict));
      i += 1;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      const updateLineIdx = i;
      i += 1;
      let moveTo: string | undefined = undefined;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: V4aChunk[] = [];
      let firstChunk = true;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          const ch: V4aChunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [], startedAt: 'at' };
          i = collectV4aBody(lines, i + 1, last, isSectionStart, ch);
          chunks.push(ch);
          firstChunk = false;
          continue;
        }
        if (l.trim() === '') {
          if (firstChunk) {
            const ch: V4aChunk = { anchor: null, eof: false, body: [], startedAt: 'body' };
            i = collectV4aBody(lines, i, last, isSectionStart, ch);
            if (!(ch.body.length === 0 && !ch.eof)) chunks.push(ch);
            firstChunk = false;
            continue;
          }
          i += 1;
          continue;
        }
        if (firstChunk && isV4aBodyLine(l)) {
          const ch: V4aChunk = { anchor: null, eof: false, body: [], startedAt: 'body' };
          i = collectV4aBody(lines, i, last, isSectionStart, ch);
          if (!(ch.body.length === 0 && !ch.eof)) chunks.push(ch);
          firstChunk = false;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${updateLineIdx + 1}`);
      edits.push(v4aEdit({ kind: 'update', path: p, moveTo, chunks }, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function applyV4aChunk(doc: Doc, ch: V4aChunk, strict: boolean, cursor: number, path: string): { doc: Doc; cursor: number } {
  let cur = cursor;
  if (ch.anchor !== null) {
    const found = findTier(doc.lines, [ch.anchor], strict, cur);
    if (found === null) throw new Fail('no-match', path);
    cur = found.occ[0]! + 1;
  }
  const { o, n } = splitON(ch.body);
  if (o.length === 0) {
    const at = ch.eof ? doc.lines.length : cur;
    const out = [...doc.lines.slice(0, at), ...n.map((x) => x.text), ...doc.lines.slice(at)];
    return { doc: { lines: out, br: doc.br, hasBreak: doc.hasBreak }, cursor: at + n.length };
  }
  const found = findTier(doc.lines, o, strict, cur);
  if (found === null) throw new Fail('no-match', path);
  let occ = found.occ;
  if (ch.eof) occ = occ.filter((pos) => pos + o.length === doc.lines.length);
  if (occ.length === 0) throw new Fail('no-match', path);
  const at = occ[0]!;
  const rep = buildNew(doc.lines, at, o, n, found.tier);
  const out = [...doc.lines.slice(0, at), ...rep, ...doc.lines.slice(at + o.length)];
  return { doc: { lines: out, br: doc.br, hasBreak: doc.hasBreak }, cursor: at + rep.length };
}

function v4aEdit(s: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      const ls = s.addLines!;
      tree.now.set(s.path, ls.length === 0 ? '' : ls.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== undefined && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== undefined && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    let doc = parseDoc(before);
    let cursor = 0;
    for (const ch of s.chunks!) {
      const r = applyV4aChunk(doc, ch, strict, cursor, s.path);
      doc = r.doc;
      cursor = r.cursor;
    }
    const text = docText(doc);
    if (s.moveTo !== undefined) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, text);
      movePairs.push({ old: s.path, nw: s.moveTo });
    } else {
      tree.now.set(s.path, text);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  movePairs.length = 0;
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const used = new Set<string>();
  for (const mv of movePairs) {
    if (used.has(mv.old) || used.has(mv.nw)) continue;
    const wasOld = tree.original(mv.old);
    const wasNew = tree.original(mv.nw);
    const nowOld = tree.get(mv.old);
    const nowNew = tree.get(mv.nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: mv.nw, line: `R ${mv.old} -> ${mv.nw}` });
      used.add(mv.old);
      used.add(mv.nw);
    }
  }
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (used.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: outLines };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
