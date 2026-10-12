// Acceptance check of an eval run. The agent runs it as its last step:
//   node .eval/check.mjs
//
// It writes two files that the graders read:
// - .eval/result.txt: first line PASS only when the project's tests and the hidden acceptance
//   tests pass and no protected file (existing tests, hidden tests, this script) was changed;
// - .eval/diff.txt: the changes against the original project, for the quality judge.
// It exits 0 on PASS and 1 otherwise.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const evalDir = dirname(fileURLToPath(import.meta.url))
const root = dirname(evalDir)
const SKIP = new Set(['.eval', '.git', 'node_modules'])

function walk(dir, prefix = '') {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!prefix && SKIP.has(entry.name)) continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out.sort()
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

function runTests(files) {
  if (files.length === 0) return { ok: false, output: 'no test files found' }
  const r = spawnSync(process.execPath, ['--test', ...files], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
  })
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`
  return { ok: r.status === 0, output }
}

const tail = (text, lines) => text.trimEnd().split('\n').slice(-lines).join('\n')

// Line diff (longest common subsequence), printed with three lines of context.
function diffLines(before, after) {
  const a = before.split('\n')
  const b = after.split('\n')
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const ops = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) ops.push([' ', a[i++], j++])
    else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push(['-', a[i++]])
    else ops.push(['+', b[j++]])
  }
  const keep = ops.map((op, k) => op[0] !== ' ' || ops.slice(Math.max(0, k - 3), k + 4).some((o) => o[0] !== ' '))
  const out = []
  let gap = false
  ops.forEach((op, k) => {
    if (keep[k]) {
      if (gap) out.push('@@')
      gap = false
      out.push(`${op[0]}${op[1]}`)
    } else gap = true
  })
  return out.join('\n')
}

const manifest = JSON.parse(readFileSync(join(evalDir, 'manifest.json'), 'utf8'))

const changedProtected = Object.entries(manifest.protected)
  .filter(([rel, hash]) => !existsSync(join(root, rel)) || sha256(join(root, rel)) !== hash)
  .map(([rel]) => rel)

const visibleFiles = walk(join(root, 'test'), 'test').filter((f) => /\.test\.m?js$/.test(f))
const hiddenFiles = walk(join(evalDir, 'hidden'), '.eval/hidden').filter((f) => /\.test\.m?js$/.test(f))
const visible = runTests(visibleFiles)
const hidden = runTests(hiddenFiles)

const pass = visible.ok && hidden.ok && changedProtected.length === 0
const report = [
  pass ? 'PASS' : 'FAIL',
  `project tests: ${visible.ok ? 'pass' : 'fail'} (${visibleFiles.length} files)`,
  `acceptance tests: ${hidden.ok ? 'pass' : 'fail'} (${hiddenFiles.length} files)`,
  `protected files changed: ${changedProtected.length === 0 ? 'none' : changedProtected.join(', ')}`,
]
if (!visible.ok) report.push('', '--- project tests (tail) ---', tail(visible.output, 40))
if (!hidden.ok) report.push('', '--- acceptance tests (tail) ---', tail(hidden.output, 40))
writeFileSync(join(evalDir, 'result.txt'), report.join('\n') + '\n')

const original = new Set(manifest.original)
const current = walk(root)
const diff = []
for (const rel of [...new Set([...original, ...current])].sort()) {
  const before = original.has(rel) ? readFileSync(join(evalDir, 'orig', rel), 'utf8') : null
  const after = existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null
  if (before === after) continue
  if (before === null) diff.push(`=== added ${rel}`, after)
  else if (after === null) diff.push(`=== deleted ${rel}`)
  else diff.push(`=== changed ${rel}`, diffLines(before, after))
}
writeFileSync(join(evalDir, 'diff.txt'), diff.length ? diff.join('\n') + '\n' : '(no changes)\n')

console.log(report.slice(0, 4).join('\n'))
if (!pass) console.log('details: .eval/result.txt')
process.exit(pass ? 0 : 1)
