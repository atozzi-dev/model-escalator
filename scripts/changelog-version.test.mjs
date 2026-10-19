import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSections, newestRelease, checkVersions, releaseNotes } from './changelog-version.mjs';

const log = `# Changelog

## [Unreleased]

### Added

- Next thing.

## [1.10.0] - 2026-11-01

### Fixed

- Ten.

## [1.2.0] - 2026-10-16

### Added

- Two.
`;

const script = join(dirname(fileURLToPath(import.meta.url)), 'changelog-version.mjs');

test('parseSections reads names, dates and bodies', () => {
  const s = parseSections(log);
  assert.deepEqual(s.map((x) => x.name), ['Unreleased', '1.10.0', '1.2.0']);
  assert.equal(s[0].date, null);
  assert.equal(s[1].date, '2026-11-01');
  assert.equal(s[2].body, '### Added\n\n- Two.');
});

test('newestRelease compares versions numerically and ignores Unreleased', () => {
  assert.equal(newestRelease(parseSections(log)).name, '1.10.0');
  assert.equal(newestRelease(parseSections('## [Unreleased]\n')), null);
});

test('checkVersions accepts a consistent pair', () => {
  assert.deepEqual(checkVersions('1.10.0', log), []);
});

test('checkVersions flags a mismatch', () => {
  const p = checkVersions('1.2.0', log);
  assert.equal(p.length, 1);
  assert.match(p[0], /1\.2\.0 differs .* 1\.10\.0/);
});

test('checkVersions flags a missing Unreleased section', () => {
  const p = checkVersions('1.10.0', log.replace('[Unreleased]', '[Next]'));
  assert.equal(p.length, 1);
  assert.match(p[0], /Unreleased/);
});

test('checkVersions ignores an undated section when picking the newest', () => {
  const undated = log.replace(' - 2026-11-01', '');
  assert.deepEqual(checkVersions('1.2.0', undated), []);
});

test('checkVersions flags a changelog without a dated release', () => {
  assert.equal(checkVersions('1.0.0', '## [Unreleased]\n').length, 1);
});

test('releaseNotes returns the section plus the closing line, or null', () => {
  assert.equal(releaseNotes(log, '1.2.0'), '### Added\n\n- Two.\n\nFull list of changes: see CHANGELOG.md.\n');
  assert.equal(releaseNotes(log, '9.9.9'), null);
  assert.equal(releaseNotes(log, 'Unreleased'), null);
});

test('CLI check passes on this repository and notes fails for an unknown version', () => {
  const ok = spawnSync(process.execPath, [script, 'check'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const bad = spawnSync(process.execPath, [script, 'notes', '0.0.1'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
});
