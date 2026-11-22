// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements every section of SPEC.md: the command line, the
// output and exit codes, safe paths, format detection, matching lines at three tiers, unified diffs, SEARCH/REPLACE
// blocks, V4A patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
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
  readonly moves: { old: string; now: string }[] = [];
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

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: '\r\n' | '\n';
  finalBreak: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

const leadingWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

/** A line of old text, normalised for one matching tier (SPEC.md section 5). */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in lines at one tier; occurrences may overlap. */
function occurrences(O: string[], lines: string[], tier: number): number[] {
  const pos: number[] = [];
  if (O.length === 0 || O.length > lines.length) return pos;
  const on = O.map((l) => normLine(l, tier));
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (normLine(lines[i + k]!, tier) !== on[k]) { ok = false; break; }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/** The first tier at which O occurs at least once, with every occurrence there (null: none). */
function findMatch(O: string[], lines: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrences(O, lines, t);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** Like findMatch, but only occurrences starting at or after `from`. */
function findMatchFrom(O: string[], lines: string[], from: number, strict: boolean): { tier: number; positions: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrences(O, lines, t).filter((p) => p >= from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** The first line at or after `from` equal to one line at the first tier where one is (null: none). */
function findSingleLine(want: string, lines: string[], from: number, strict: boolean): number | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const w = normLine(want, t);
    for (let i = Math.max(0, from); i < lines.length; i++) {
      if (normLine(lines[i]!, t) === w) return i;
    }
  }
  return null;
}

/** One line of new text: `ctx` is the index into O of the context line it mirrors, null for an added line. */
interface NLine {
  text: string;
  ctx: number | null;
}

/**
 * Replace O at pos by N: context lines are written as the file's own matched lines; at tier 2 the other lines
 * are re-indented, replacing O's first line's leading whitespace by the file's first matched line's (section 5).
 */
function applyReplace(state: FileState, O: string[], N: NLine[], pos: number, tier: number): FileState {
  const lines = state.lines.slice();
  let f = '';
  let p = '';
  if (tier === 2 && O.length > 0) {
    f = leadingWs(lines[pos]!);
    p = leadingWs(O[0]!);
  }
  const mapped = N.map((n) => {
    if (n.ctx !== null) return lines[pos + n.ctx]!;
    if (tier === 2) {
      const t = n.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    }
    return n.text;
  });
  lines.splice(pos, O.length, ...mapped);
  return { lines, br: state.br, finalBreak: state.finalBreak };
}

/** One body line of a unified hunk or a V4A chunk: ' ' and '' are context lines, '-' old, '+' new, '\' a marker. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\' | '';
  text: string;
}

/** Split a hunk or chunk body into its old lines O and its new lines N (sections 6 and 8). */
function bodyON(body: BodyLine[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.kind === ' ' || b.kind === '') {
      N.push({ text: b.text, ctx: O.length });
      O.push(b.text);
    } else if (b.kind === '-') {
      O.push(b.text);
    } else if (b.kind === '+') {
      N.push({ text: b.text, ctx: null });
    }
  }
  return { O, N };
}

/** A body line that is a blank line: a context line whose text is empty or only whitespace. */
function isBlankBodyLine(b: BodyLine): boolean {
  return (b.kind === ' ' || b.kind === '') && b.text.trim() === '';
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

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** A `--- ` or `+++ ` path: the text after the four characters, up to the first tab, spaces removed. */
function headerPath(s: string): string {
  const t = s.slice(4);
  const tab = t.indexOf('\t');
  return (tab >= 0 ? t.slice(0, tab) : t).trim();
}

/** A section path: `/dev/null` means no file; a leading `a/` or `b/` is removed. */
function sectionPath(raw: string | null): string | null {
  if (raw === null || raw === '/dev/null') return null;
  return raw.startsWith('a/') || raw.startsWith('b/') ? raw.slice(2) : raw;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  const fresh = (): USection => ({
    oldPath: null, newPath: null, hasPair: false, renameFrom: null, renameTo: null,
    diffOld: null, diffNew: null, newFile: false, deletedFile: false, hunks: [],
  });
  let cur: USection | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hasPair || cur.hunks.length > 0) {
        cur = fresh();
        sections.push(cur);
      }
      cur.oldPath = headerPath(l);
      cur.newPath = headerPath(lines[i + 1]!);
      cur.hasPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      const body: BodyLine[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          body.push({ kind: '', text: '' });
          i += 1;
          continue;
        }
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push({ kind: b[0] as ' ' | '-' | '+' | '\\', text: b.slice(1) });
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === '') body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length).trim();
      else if (l === 'new file mode' || l.startsWith('new file mode ')) cur.newFile = true;
      else if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** Whether a `\` line follows the hunk's last context or `+` line right away. */
function hunkNoFinalBreak(body: BodyLine[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    const kind = body[k]!.kind;
    if (kind === ' ' || kind === '' || kind === '+') last = k;
  }
  return last >= 0 && body[last + 1] !== undefined && body[last + 1]!.kind === '\\';
}

/** Apply one hunk to a file's state; also the O/N length difference for the next hunk's offset. */
function applyHunk(state: FileState, hunk: Hunk, d: number, strict: boolean, path: string): { state: FileState; delta: number } {
  const { O, N } = bodyON(hunk.body);
  const noFB = hunkNoFinalBreak(hunk.body);
  if (O.length === 0) {
    const lines = state.lines.slice();
    const pos = Math.min(Math.max(hunk.a + d, 0), lines.length);
    lines.splice(pos, 0, ...N.map((n) => n.text));
    const finalBreak = pos === state.lines.length ? !noFB : state.finalBreak;
    return { state: { lines, br: state.br, finalBreak }, delta: N.length };
  }
  const m = findMatch(O, state.lines, strict);
  if (m === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let pos = m.positions[0]!;
  let best = Math.abs(pos - target);
  for (const p of m.positions) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      best = dist;
      pos = p;
    }
  }
  const next = applyReplace(state, O, N, pos, m.tier);
  const finalBreak = pos + O.length === state.lines.length ? !noFB : state.finalBreak;
  return { state: { lines: next.lines, br: next.br, finalBreak }, delta: N.length - O.length };
}

function unifiedSectionEdit(s: USection, strict: boolean): Edit {
  let oldP: string | null;
  let newP: string | null;
  if (s.hasPair) {
    oldP = sectionPath(s.oldPath);
    newP = sectionPath(s.newPath);
  } else {
    oldP = sectionPath(s.renameFrom ?? s.diffOld);
    newP = sectionPath(s.renameTo ?? s.diffNew);
  }
  const creation = oldP === null || s.newFile;
  const deletion = !creation && (newP === null || s.deletedFile);
  const move = !creation && !deletion && oldP !== newP;
  return (tree) => {
    const checkPaths: string[] = [];
    if (oldP !== null) checkPaths.push(oldP);
    if (newP !== null && newP !== oldP) checkPaths.push(newP);
    for (const p of checkPaths) if (!safe(p)) throw new Fail('unsafe', p);
    if (creation) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of s.hunks) {
        for (const n of bodyON(h.body).N) if (n.ctx === null) plus.push(n.text);
      }
      let noFB = false;
      for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const body = s.hunks[hi]!.body;
        let last = -1;
        for (let k = 0; k < body.length; k++) if (body[k]!.kind === '+') last = k;
        if (last >= 0) {
          noFB = body[last + 1] !== undefined && body[last + 1]!.kind === '\\';
          break;
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : `${plus.join('\n')}${noFB ? '' : '\n'}`);
      return;
    }
    if (deletion) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const src = oldP!;
    const dst = move ? newP! : oldP!;
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    if (move && tree.get(dst) !== null) throw new Fail('exists', dst);
    let state = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      const r = applyHunk(state, h, d, strict, src);
      state = r.state;
      d += r.delta;
    }
    const out = joinFile(state);
    if (move) {
      tree.now.set(dst, out);
      tree.now.set(src, null);
      tree.moves.push({ old: src, now: dst });
    } else {
      tree.now.set(src, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    edits.push(srEdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const state = splitFile(before);
    const m = findMatch(oldLines, state.lines, strict);
    if (m === null) throw new Fail('no-match', path);
    if (m.positions.length > 1) throw new Fail('ambiguous', path);
    const N: NLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    tree.now.set(path, joinFile(applyReplace(state, oldLines, N, m.positions[0]!, m.tier)));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File:')) {
      const path = l.slice('*** Add File:'.length).trim();
      i += 1;
      const raw: string[] = [];
      while (i < last) {
        const b = lines[i]!;
        if (blank(b)) {
          raw.push('');
          i += 1;
          continue;
        }
        if (b.startsWith('+')) {
          raw.push(b);
          i += 1;
          continue;
        }
        break;
      }
      while (raw.length > 0 && raw[raw.length - 1]!.trim() === '') raw.pop();
      const content = raw.map((r) => (r.startsWith('+') ? r.slice(1) : ''));
      edits.push(v4aAddEdit(path, content));
      continue;
    }
    if (l.startsWith('*** Delete File:')) {
      const path = l.slice('*** Delete File:'.length).trim();
      i += 1;
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (l.startsWith('*** Update File:')) {
      const updateLine = i;
      const path = l.slice('*** Update File:'.length).trim();
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        moveTo = lines[i]!.slice('*** Move to:'.length).trim();
        i += 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let started = false;
      while (i < last) {
        const b = lines[i]!;
        if (b.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchor = b.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          started = true;
          i += 1;
          continue;
        }
        if (b === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          i += 1;
          continue;
        }
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || blank(b)) {
          if (cur === null) {
            if (started) {
              if (blank(b)) {
                i += 1;
                continue;
              }
              throw new Exit2(`error: parse ${i + 1}`);
            }
            cur = { anchor: null, body: [], eof: false };
            started = true;
          }
          if (b === '' || blank(b)) cur.body.push({ kind: '', text: '' });
          else cur.body.push({ kind: b[0] as ' ' | '-' | '+', text: b.slice(1) });
          i += 1;
          continue;
        }
        break;
      }
      if (cur !== null) chunks.push(cur);
      const lastChunk = chunks[chunks.length - 1];
      if (lastChunk !== undefined) {
        while (lastChunk.body.length > 0 && isBlankBodyLine(lastChunk.body[lastChunk.body.length - 1]!)) lastChunk.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aAddEdit(path: string, content: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, content.length === 0 ? '' : `${content.join('\n')}\n`);
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let state = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findSingleLine(ch.anchor, state.lines, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { O, N } = bodyON(ch.body);
      if (O.length === 0) {
        const pos = ch.eof ? state.lines.length : cursor;
        const lines = state.lines.slice();
        lines.splice(pos, 0, ...N.map((n) => n.text));
        state = { lines, br: state.br, finalBreak: state.finalBreak };
        cursor = pos + N.length;
      } else {
        let tier: number;
        let pos: number;
        if (ch.eof) {
          const endPos = state.lines.length - O.length;
          if (endPos < cursor) throw new Fail('no-match', path);
          const max = strict ? 0 : 2;
          let found: number | null = null;
          for (let t = 0; t <= max; t++) {
            if (occurrences(O, state.lines, t).includes(endPos)) {
              found = t;
              break;
            }
          }
          if (found === null) throw new Fail('no-match', path);
          tier = found;
          pos = endPos;
        } else {
          const m = findMatchFrom(O, state.lines, cursor, strict);
          if (m === null) throw new Fail('no-match', path);
          tier = m.tier;
          pos = m.positions[0]!;
        }
        state = applyReplace(state, O, N, pos, tier);
        cursor = pos + N.length;
      }
    }
    const out = joinFile(state);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push({ old: path, now: moveTo });
    } else {
      tree.now.set(path, out);
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
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
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
  const changed: { path: string; was: string | null; now: string | null }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ path: p, was, now });
  }
  const rows: { sort: string; line: string }[] = [];
  const usedAsOld = new Set<string>();
  const usedAsNew = new Set<string>();
  for (const mv of tree.moves) {
    const oldC = changed.find((c) => c.path === mv.old);
    const newC = changed.find((c) => c.path === mv.now);
    if (oldC !== undefined && newC !== undefined && oldC.was !== null && oldC.now === null && newC.was === null && newC.now !== null) {
      rows.push({ sort: mv.now, line: `R ${mv.old} -> ${mv.now}` });
      usedAsOld.add(mv.old);
      usedAsNew.add(mv.now);
    }
  }
  for (const c of changed) {
    if (usedAsOld.has(c.path) || usedAsNew.has(c.path)) continue;
    rows.push({ sort: c.path, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${c.path}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
  if (!check) {
    for (const c of changed) {
      if (c.now === null) rmSync(c.path, { force: true });
      else {
        mkdirSync(dirname(c.path), { recursive: true });
        writeFileSync(c.path, c.now);
      }
    }
  }
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
