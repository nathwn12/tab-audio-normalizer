// loudness-alignment.cjs — user-facing loudness numbers must match the engine.
//
// Observed failures this file exists for (2026-10-18):
//   (1) TARGET_LUFS = -16 sat in the engine as a dead store — one reader that
//       never used it — so the constant claimed to control loudness while
//       controlling nothing.
//   (2) popup.html:246 advertised one loudness target while the engine applied
//       a different number, and README.md described a third.
//
// This check re-reads both sides on every run: the numeric loudness claims in
// popup.html / README.md / CHANGELOG.md (current-value statements only) and
// the three applied constants in audio/normalizer-worklet.js (target, ceiling,
// Blast-Guard ceiling). Any disagreement — or a constant with no reader, or an
// empty claim/constant set — exits non-zero. No dependencies beyond fs/path.
//
// Usage: node loudness-alignment.cjs [repoRoot]   (default: this file's dir)
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : __dirname;
const WORKLET = 'audio/normalizer-worklet.js';
const CLAIM_FILES = ['popup.html', 'README.md', 'CHANGELOG.md'];
// Unicode minus / en-dash / em-dash all mean "-N" in prose.
const fixMinus = (s) => s.replace(/[−–—]/g, '-');
const show = (rel) => rel.split(path.sep).join('/');

function readLines(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8').split(/\r?\n/);
}

const failures = [];

// ---- 1. Engine constants: the three numbers the worklet actually applies. ----
const WANT_CONSTS = ['TARGET_LUFS_DEFAULT', 'CEILING_DB', 'BLAST_GUARD_CEILING_DB'];
const wLines = readLines(WORKLET);
const consts = {};
if (wLines === null) {
  failures.push(`missing engine file: ${show(WORKLET)} not found under ${ROOT}`);
} else {
  const norm = wLines.map(fixMinus);
  for (const name of WANT_CONSTS) {
    const declIdx = norm.findIndex((l) => new RegExp(`var\\s+${name}\\s*=\\s*(-?[\\d.]+)`).test(l));
    if (declIdx === -1) {
      failures.push(`missing constant: ${name} has no "var ${name} = <number>" in ${show(WORKLET)}`);
      continue;
    }
    const value = parseFloat(norm[declIdx].match(new RegExp(`var\\s+${name}\\s*=\\s*(-?[\\d.]+)`))[1]);
    // Dead-store guard for observed failure (1): the name must occur again
    // outside its declaration (a reader that applies it). Word-boundary
    // counting so BLAST_GUARD_CEILING_DB does not count as a CEILING_DB use.
    const uses = norm.filter((l) => new RegExp(`\\b${name}\\b`).test(l)).length;
    consts[name] = { line: declIdx + 1, value, uses };
    if (uses < 2) failures.push(`dead store: ${name} is declared but never read in ${show(WORKLET)}`);
  }
}

// ---- 2. User-facing claims (file:line + number). ----
function changelogRanges(lines) {
  // Current-value statements only: [Unreleased] plus the newest ## [x.y.z]
  // section. Older versioned sections are superseded history (e.g. 5.3.0's
  // -18 LUFS) and must never count as claims about current behavior.
  const hdr = [];
  lines.forEach((l, i) => { if (/^##\s+/.test(l)) hdr.push(i); });
  const ver = hdr.filter((i) => /^##\s+\[\d+\.\d+\.\d+\]/.test(lines[i]));
  if (ver.length === 0) return [[0, lines.length]];
  const first = ver[0];
  const second = ver.length > 1 ? ver[1] : lines.length;
  const unrel = hdr.find((i) => /Unreleased/i.test(lines[i]));
  const ranges = [];
  if (unrel !== undefined && unrel < first) ranges.push([unrel, first]);
  ranges.push([first, second]);
  return ranges;
}

const claims = []; // {file, line, kind, value}
for (const rel of CLAIM_FILES) {
  const lines = readLines(rel);
  if (lines === null) { failures.push(`missing claim file: ${show(rel)} not found under ${ROOT}`); continue; }
  let idxs = lines.map((_, i) => i);
  if (rel === 'CHANGELOG.md') {
    const ranges = changelogRanges(lines);
    idxs = idxs.filter((i) => ranges.some(([a, b]) => i >= a && i < b));
  }
  for (const i of idxs) {
    const raw = lines[i];
    const line = fixMinus(raw);
    // Target claims: LUFS numbers stated as the program target. The 'target'
    // context requirement keeps standards citations (AES -18, platform -14,
    // EBU window -20..-16) from counting as claims about this extension.
    if (/target/i.test(raw)) {
      for (const m of line.matchAll(/(-?[\d.]+)\s*LUFS/gi)) {
        claims.push({ file: show(rel), line: i + 1, kind: 'target', value: parseFloat(m[1]) });
      }
    }
    // Ceiling claims: dBTP numbers. A number inside a Blast-Guard
    // parenthetical pairs with the Blast-Guard ceiling, every other dBTP
    // number with the plain ceiling (the plain ceiling is routinely stated
    // on the same line as Blast Guard, e.g. README:48, CHANGELOG:57).
    // A line reporting past measurements ("was +1.6 dBTP ...", cf.
    // CHANGELOG Fixed entry) states no current ceiling and is skipped.
    if (!/was\s*[-+][\d.]+\s*dBTP/i.test(raw)) {
      for (const m of line.matchAll(/(-?[\d.]+)\s*dBTP/gi)) {
        const at = m.index;
        const parens = [...raw.matchAll(/\([^)]*\)/g)];
        const inBlastParen = parens.some((p) => /blast/i.test(p[0]) && at >= p.index && at < p.index + p[0].length);
        claims.push({ file: show(rel), line: i + 1, kind: inBlastParen ? 'bg-ceiling' : 'ceiling', value: parseFloat(m[1]) });
      }
    }
  }
}

// ---- 3. Compare. ----
console.log(`root: ${ROOT}`);
console.log('--- applied constants ---');
for (const name of WANT_CONSTS) {
  if (consts[name]) console.log(`${show(WORKLET)}:${consts[name].line} ${name} = ${consts[name].value} (readers: ${consts[name].uses})`);
}
console.log('--- user-facing claims ---');
for (const c of claims) console.log(`${c.file}:${c.line} ${c.kind} claim = ${c.value}`);

const KIND_TO_CONST = { target: 'TARGET_LUFS_DEFAULT', ceiling: 'CEILING_DB', 'bg-ceiling': 'BLAST_GUARD_CEILING_DB' };
const compared = claims.filter((c) => consts[KIND_TO_CONST[c.kind]]);
for (const c of compared) {
  const name = KIND_TO_CONST[c.kind];
  if (c.value !== consts[name].value) {
    failures.push(`DISAGREEMENT ${c.file}:${c.line} claims ${c.value} vs applied ${consts[name].value} (${show(WORKLET)}:${consts[name].line} ${name})`);
  }
}
if (compared.length === 0 && failures.length === 0) {
  failures.push('VACUOUS: no comparable claim/constant pairs found — a check that cannot fail is not evidence');
}

console.log('--- verdict ---');
if (failures.length > 0) {
  for (const f of failures) console.log(f);
  console.log(`FAIL: ${compared.length} compared, ${failures.filter((f) => f.startsWith('DISAGREEMENT')).length} disagreement(s)`);
  process.exitCode = 1;
} else {
  console.log(`PASS: ${compared.length} claims agree with the applied constants; no dead stores`);
}
