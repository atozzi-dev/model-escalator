#!/usr/bin/env node
// Keeps the manifest version and CHANGELOG.md in step, and extracts release notes.
//
//   node scripts/changelog-version.mjs check            manifest version must equal the newest dated section
//   node scripts/changelog-version.mjs notes X.Y.Z      print the release notes for that version
//   node scripts/changelog-version.mjs manifest         print the manifest version
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADING = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?[ \t]*$/;

export function parseSections(changelog) {
  const lines = changelog.split(/\r?\n/);
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i]);
    if (!m) continue;
    const end = lines.findIndex((l, j) => j > i && l.startsWith('## '));
    const body = lines.slice(i + 1, end === -1 ? lines.length : end).join('\n').trim();
    sections.push({ name: m[1], date: m[2] ?? null, body });
  }
  return sections;
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const cmp = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

export function newestRelease(sections) {
  const dated = sections.filter((s) => SEMVER.test(s.name) && s.date);
  return dated.sort((a, b) => cmp(b.name, a.name))[0] ?? null;
}

// Returns a list of problems; empty means consistent.
export function checkVersions(manifestVersion, changelog) {
  const problems = [];
  const sections = parseSections(changelog);
  if (!sections.some((s) => s.name === 'Unreleased')) problems.push('CHANGELOG.md has no "## [Unreleased]" section');
  const newest = newestRelease(sections);
  if (!newest) problems.push('CHANGELOG.md has no dated "## [X.Y.Z] - YYYY-MM-DD" section');
  else if (newest.name !== manifestVersion) {
    problems.push(`manifest version ${manifestVersion} differs from the newest dated CHANGELOG section ${newest.name}`);
  }
  return problems;
}

export function releaseNotes(changelog, version) {
  const s = parseSections(changelog).find((x) => x.name === version && x.date);
  if (!s) return null;
  return `${s.body}\n\nFull list of changes: see CHANGELOG.md.\n`;
}

function main(argv) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = JSON.parse(readFileSync(join(root, 'plugin/.claude-plugin/plugin.json'), 'utf8')).version;
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const [cmd, arg] = argv;
  if (cmd === 'check') {
    const problems = checkVersions(manifest, changelog);
    if (problems.length) {
      for (const p of problems) console.error(`error: ${p}`);
      return 1;
    }
    console.log(`ok: manifest and CHANGELOG.md agree on ${manifest}`);
    return 0;
  }
  if (cmd === 'manifest') {
    console.log(manifest);
    return 0;
  }
  if (cmd === 'notes' && arg) {
    const notes = releaseNotes(changelog, arg);
    if (notes === null) {
      console.error(`error: no dated CHANGELOG section for ${arg}`);
      return 1;
    }
    process.stdout.write(notes);
    return 0;
  }
  console.error('usage: changelog-version.mjs check | manifest | notes X.Y.Z');
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
