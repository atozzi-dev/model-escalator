#!/usr/bin/env node
// Compare two A/B result files written by `claude plugin eval --json <file>`
// (baseline arm vs active arm) and print a per-case verdict table.
//
// Usage:
//   node scripts/ab-compare.mjs <baseline.json> <active.json> [--tolerance <points>] [--markdown <file>]
//
// Exit code: 0 when every case is OK, 1 when at least one case is not, 2 on bad input.
//
// Input shape (only the fields read here):
//   { cases: [ { name, arms: { with: [ { score (0..1), costUsd, error? } ] } } ] }
// With the default ablation the same runs sit in `arms.with` and the no-plugin
// runs in `arms.without`; the A/B arms are produced with `--ablation none`,
// so only `arms.with` is read.

import { readFileSync, writeFileSync } from 'node:fs';

const USAGE =
  'usage: node scripts/ab-compare.mjs <baseline.json> <active.json> [--tolerance <points>] [--markdown <file>]';

class InputError extends Error {}

function parseArgs(argv) {
  const files = [];
  let tolerance = 5;
  let markdown;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tolerance') {
      const v = argv[++i];
      tolerance = Number(v);
      if (v === undefined || v.trim() === '' || !Number.isFinite(tolerance) || tolerance < 0) {
        throw new InputError(`--tolerance needs a non-negative number, got ${JSON.stringify(v)}`);
      }
    } else if (a === '--markdown') {
      markdown = argv[++i];
      if (!markdown) throw new InputError('--markdown needs a file path');
    } else if (a.startsWith('--')) {
      throw new InputError(`unknown option ${a}`);
    } else {
      files.push(a);
    }
  }
  if (files.length !== 2) throw new InputError('expected exactly two result files');
  return { baselineFile: files[0], activeFile: files[1], tolerance, markdown };
}

function load(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new InputError(`cannot read ${file}: ${e.message}`);
  }
  if (!data || !Array.isArray(data.cases)) {
    throw new InputError(`${file}: no "cases" array, is it a --json result?`);
  }
  const cases = new Map();
  for (const c of data.cases) {
    if (!c || typeof c.name !== 'string') throw new InputError(`${file}: a case has no name`);
    const runs = c.arms?.with;
    if (!Array.isArray(runs)) throw new InputError(`${file}: case ${c.name} has no arms.with runs`);
    cases.set(c.name, runs);
  }
  return cases;
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

// Score is on a 0..1 scale in the files; the table uses 0..100.
function summarize(runs) {
  const scores = runs.map((r) => (typeof r?.score === 'number' ? r.score * 100 : 0));
  const costs = runs.map((r) => r?.costUsd).filter((c) => typeof c === 'number' && Number.isFinite(c));
  const failed = runs.filter((r) => r?.error).length;
  return {
    n: runs.length,
    failed,
    score: scores.length ? mean(scores) : null,
    sd: stdev(scores),
    cost: costs.length ? mean(costs) : null,
  };
}

const pct = (a, b) => (b > 0 ? ((a - b) / b) * 100 : null);

function compare(baseline, active, tolerance) {
  const names = [...new Set([...baseline.keys(), ...active.keys()])];
  const rows = [];
  const notes = [];
  for (const name of names) {
    const b = baseline.has(name) ? summarize(baseline.get(name)) : null;
    const a = active.has(name) ? summarize(active.get(name)) : null;
    const row = { name, b, a, scoreDelta: null, costDelta: null, verdict: 'MISSING' };
    if (!b) notes.push(`${name}: missing in the baseline file`);
    if (!a) notes.push(`${name}: missing in the active file`);
    for (const [label, s] of [['baseline', b], ['active', a]]) {
      if (s?.failed) notes.push(`${name}: ${s.failed} failed run(s) in ${label} (counted with their score)`);
      if (s && s.n === 0) notes.push(`${name}: no runs in ${label}`);
    }
    if (b && a && b.score !== null && a.score !== null) {
      row.scoreDelta = a.score - b.score;
      row.costDelta = b.cost !== null && a.cost !== null ? pct(a.cost, b.cost) : null;
      if (row.scoreDelta < -tolerance) row.verdict = 'WORSE';
      else if (row.costDelta === null) row.verdict = 'NO COST';
      else if (row.costDelta >= 0) row.verdict = 'COSTLIER';
      else row.verdict = 'OK';
    }
    rows.push(row);
  }

  const both = rows.filter((r) => r.b && r.a && r.scoreDelta !== null);
  const total = { b: null, a: null, scoreDelta: null, savings: null };
  if (both.length) {
    total.b = { score: mean(both.map((r) => r.b.score)), cost: null };
    total.a = { score: mean(both.map((r) => r.a.score)), cost: null };
    total.scoreDelta = total.a.score - total.b.score;
    const costed = both.filter((r) => r.b.cost !== null && r.a.cost !== null);
    if (costed.length === both.length) {
      total.b.cost = costed.reduce((s, r) => s + r.b.cost, 0);
      total.a.cost = costed.reduce((s, r) => s + r.a.cost, 0);
      total.savings = total.b.cost > 0 ? ((total.b.cost - total.a.cost) / total.b.cost) * 100 : null;
    } else {
      notes.push('totals: cost is n/a because some cases have no cost data');
    }
  }
  return { rows, total, notes, allOk: rows.length > 0 && rows.every((r) => r.verdict === 'OK') };
}

const f1 = (x) => (x === null ? 'n/a' : x.toFixed(1));
const signed = (x, suffix = '') => (x === null ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}${suffix}`);
const usd = (x) => (x === null ? 'n/a' : `$${x.toFixed(4)}`);
const scoreCell = (s) => (s ? `${f1(s.score)} ± ${f1(s.sd)}` : '-');
const costCell = (s) => (s ? usd(s.cost) : '-');

const HEADER = ['Case', 'Baseline score', 'Active score', 'Δ score (pts)', 'Baseline $/run', 'Active $/run', 'Δ cost', 'Verdict'];

function tableRows({ rows, total }) {
  const body = rows.map((r) => [
    r.name, scoreCell(r.b), scoreCell(r.a), signed(r.scoreDelta),
    costCell(r.b), costCell(r.a), signed(r.costDelta, '%'), r.verdict,
  ]);
  const t = [
    'TOTAL',
    total.b ? f1(total.b.score) : '-',
    total.a ? f1(total.a.score) : '-',
    signed(total.scoreDelta),
    total.b ? usd(total.b.cost) : '-',
    total.a ? usd(total.a.cost) : '-',
    total.savings === null ? 'n/a' : signed(-total.savings, '%'),
    total.savings === null ? '' : `saves ${f1(total.savings)}%`,
  ];
  return { body, total: t };
}

function renderText(result, tolerance) {
  const { body, total } = tableRows(result);
  const all = [HEADER, ...body, total];
  const widths = HEADER.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const fmt = (r) => r.map((c, i) => (i === 0 || i === r.length - 1 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ').trimEnd();
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const lines = [fmt(HEADER), sep, ...body.map(fmt), sep, fmt(total), ''];
  lines.push(`Tolerance: ${tolerance} points. OK = score within tolerance and cheaper.`);
  for (const n of result.notes) lines.push(`Note: ${n}`);
  return lines.join('\n') + '\n';
}

function renderMarkdown(result, tolerance) {
  const { body, total } = tableRows(result);
  const row = (r) => `| ${r.join(' | ')} |`;
  const lines = [
    row(HEADER),
    `|${HEADER.map((_, i) => (i === 0 || i === HEADER.length - 1 ? '---' : '---:')).join('|')}|`,
    ...body.map(row),
    row(total.map((c, i) => (i === 0 ? `**${c}**` : c))),
    '',
    `Tolerance: ${tolerance} points. OK = score within tolerance and cheaper.`,
  ];
  if (result.notes.length) lines.push('', ...result.notes.map((n) => `- ${n}`));
  return lines.join('\n') + '\n';
}

function main(argv) {
  let args;
  let result;
  try {
    args = parseArgs(argv);
    result = compare(load(args.baselineFile), load(args.activeFile), args.tolerance);
    if (result.rows.length === 0) throw new InputError('no cases to compare');
  } catch (e) {
    if (!(e instanceof InputError)) throw e;
    process.stderr.write(`ab-compare: ${e.message}\n${USAGE}\n`);
    return 2;
  }
  process.stdout.write(renderText(result, args.tolerance));
  if (args.markdown) {
    try {
      writeFileSync(args.markdown, renderMarkdown(result, args.tolerance));
    } catch (e) {
      process.stderr.write(`ab-compare: cannot write ${args.markdown}: ${e.message}\n`);
      return 2;
    }
  }
  return result.allOk ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
