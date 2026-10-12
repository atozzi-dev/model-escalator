import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'ab-compare.mjs');
const fx = (name) => join(here, 'fixtures', name);

function run(...args) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const lineOf = (out, name) => out.split('\n').find((l) => l.includes(name)) ?? '';

test('OK: active within tolerance and cheaper, exit 0', () => {
  const r = run(fx('baseline.json'), fx('active-ok.json'));
  assert.equal(r.code, 0, r.out + r.err);
  const alpha = lineOf(r.out, 'alpha');
  assert.match(alpha, /100\.0/); // baseline mean score
  assert.match(alpha, /96\.7/); // active mean score
  assert.match(alpha, /-3\.3/); // score delta
  assert.match(alpha, /-60\.0%/); // cost delta
  assert.match(alpha, /OK/);
  assert.match(lineOf(r.out, 'beta'), /OK/);
});

test('standard deviation is reported per arm', () => {
  const r = run(fx('baseline.json'), fx('active-ok.json'));
  // beta baseline scores 100, 80, 90 -> sample sd 10.0
  assert.match(lineOf(r.out, 'beta'), /90\.0 ± 10\.0/);
});

test('totals row: mean score, total cost and savings', () => {
  const r = run(fx('baseline.json'), fx('active-ok.json'));
  const total = lineOf(r.out, 'TOTAL');
  assert.match(total, /95\.0/); // baseline mean of case means
  assert.match(total, /-?3\.3|-1\.7/); // score delta present
  assert.match(total, /-5[0-9]\.[0-9]%/); // savings: 1.4 vs 3.0 -> -53.3%
});

test('WORSE: score drop beyond tolerance, exit 1', () => {
  const r = run(fx('baseline.json'), fx('active-worse.json'));
  assert.equal(r.code, 1);
  assert.match(lineOf(r.out, 'beta'), /WORSE/);
  assert.match(lineOf(r.out, 'alpha'), /OK/);
});

test('tolerance option widens the accepted drop', () => {
  const r = run(fx('baseline.json'), fx('active-worse.json'), '--tolerance', '60');
  assert.equal(r.code, 0, r.out);
});

test('COSTLIER: score fine but not cheaper, exit 1', () => {
  const r = run(fx('baseline.json'), fx('active-costlier.json'));
  assert.equal(r.code, 1);
  assert.match(lineOf(r.out, 'alpha'), /COSTLIER/);
  assert.match(lineOf(r.out, 'alpha'), /\+50\.0%/);
});

test('missing case in one arm is flagged, exit 1', () => {
  const r = run(fx('baseline.json'), fx('active-missing.json'));
  assert.equal(r.code, 1);
  assert.match(lineOf(r.out, 'beta'), /MISSING/);
  assert.match(lineOf(r.out, 'gamma'), /MISSING/);
  assert.match(lineOf(r.out, 'alpha'), /OK/);
});

test('runs without cost report n/a and cannot be OK', () => {
  const r = run(fx('baseline.json'), fx('active-nocost.json'));
  assert.equal(r.code, 1);
  const beta = lineOf(r.out, 'beta');
  assert.match(beta, /n\/a/);
  assert.doesNotMatch(beta, /\bOK\b/);
});

test('failed runs are counted and reported', () => {
  const r = run(fx('baseline.json'), fx('active-failed-run.json'));
  assert.equal(r.code, 1);
  assert.match(lineOf(r.out, 'alpha'), /WORSE/);
  assert.match(r.out, /1 failed/);
});

test('bad input exits 2', () => {
  assert.equal(run(fx('baseline.json'), fx('invalid.json')).code, 2);
  assert.equal(run(fx('baseline.json'), fx('no-cases.json')).code, 2);
  assert.equal(run(fx('baseline.json'), fx('does-not-exist.json')).code, 2);
  assert.equal(run(fx('baseline.json')).code, 2);
  assert.equal(run(fx('baseline.json'), fx('active-ok.json'), '--tolerance', 'abc').code, 2);
  assert.equal(run(fx('baseline.json'), fx('active-ok.json'), '--bogus').code, 2);
  assert.match(run(fx('baseline.json')).err, /usage/i);
});

test('--markdown writes the table as Markdown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-compare-'));
  const file = join(dir, 'out.md');
  const r = run(fx('baseline.json'), fx('active-ok.json'), '--markdown', file);
  assert.equal(r.code, 0, r.err);
  const md = readFileSync(file, 'utf8');
  const lines = md.split('\n').filter((l) => l.startsWith('|'));
  assert.match(lines[0], /^\| Case \|/);
  assert.match(lines[1], /^\|[-: |]+\|$/);
  assert.ok(lines.some((l) => l.includes('alpha') && l.includes('OK')));
  assert.ok(lines.some((l) => l.includes('**TOTAL**') || l.includes('TOTAL')));
});
