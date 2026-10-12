// Prepares the working folder of one eval run. Called by each case's scaffold.sh:
//   node setup.mjs <case dir> [<target dir>]   (target defaults to the current directory)
//
// - copies <case dir>/project/ into the target: the code the agent works on;
// - copies <case dir>/hidden/ into <target>/.eval/hidden/: acceptance tests the agent is not told about;
// - keeps a pristine copy of the project in <target>/.eval/orig/, used to write the final diff;
// - copies check.mjs into <target>/.eval/ and records the sha256 of every protected file
//   (existing tests, hidden tests, the check itself) in <target>/.eval/manifest.json.
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const caseDir = resolve(process.argv[2] ?? '')
const target = resolve(process.argv[3] ?? process.cwd())
const harnessDir = dirname(fileURLToPath(import.meta.url))

if (!process.argv[2] || !existsSync(join(caseDir, 'project'))) {
  console.error(`setup: no project/ folder in ${caseDir}`)
  process.exit(1)
}

/** Relative paths (with forward slashes) of every file below `dir`. */
function walk(dir, prefix = '') {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out.sort()
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

const evalDir = join(target, '.eval')
mkdirSync(evalDir, { recursive: true })
cpSync(join(caseDir, 'project'), target, { recursive: true })
cpSync(join(caseDir, 'project'), join(evalDir, 'orig'), { recursive: true })
if (existsSync(join(caseDir, 'hidden'))) cpSync(join(caseDir, 'hidden'), join(evalDir, 'hidden'), { recursive: true })
cpSync(join(harnessDir, 'check.mjs'), join(evalDir, 'check.mjs'))

const protectedFiles = [
  ...walk(join(target, 'test'), 'test'),
  ...walk(join(evalDir, 'hidden'), '.eval/hidden'),
  '.eval/check.mjs',
]
const manifest = {
  protected: Object.fromEntries(protectedFiles.map((rel) => [rel, sha256(join(target, rel))])),
  original: walk(join(caseDir, 'project')),
}
writeFileSync(join(evalDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
