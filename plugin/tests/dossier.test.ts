import { expect, test } from 'claude-code/testing'
import { newAgent, observe } from '../hooks/detector'
import { buildDossier, inputFromState, redactSecrets, truncateMiddle, type DossierInput } from '../hooks/dossier'

const base = (over: Partial<DossierInput> = {}): DossierInput => ({
  goal: 'Fix the failing parser tests', tier: 'haiku', interventions: 2,
  attempts: [{ tool: 'Bash', summary: 'npm test', ok: false, error: 'TypeError: x is undefined' }],
  files: [{ path: 'src/parser.ts', edits: 4 }],
  ...over,
})

test('has a section for each part, with short headings', async () => {
  const out = buildDossier(base({ diffStat: ' src/parser.ts | 4 ++--', extra: 'Problem: cannot fix it' }))
  for (const h of ['Task', 'State', 'Recent attempts', 'Files touched', 'Diff stat', 'Agent notes']) expect(out).toContain(h)
  expect(out).toContain('Fix the failing parser tests')
  expect(out).toContain('haiku')
  expect(out).toContain('src/parser.ts (4 edits)')
  expect(out).toContain('TypeError: x is undefined')
  expect(out).toContain('Problem: cannot fix it')
})

test('optional sections are omitted when empty', async () => {
  const out = buildDossier(base({ files: [], attempts: [] }))
  expect(out).not.toContain('Diff stat')
  expect(out).not.toContain('Agent notes')
  expect(out).not.toContain('Files touched')
})

test('a long error keeps its head and tail and marks the cut', async () => {
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`)
  const out = buildDossier(base({ attempts: [{ tool: 'Bash', summary: 'build', ok: false, error: lines.join('\n') }] }), { maxErrorChars: 400 })
  expect(out).toContain('line 0')
  expect(out).toContain('line 299')
  expect(out).not.toContain('line 150')
  expect(out).toMatch(/\[\.\.\. \d+ (lines|chars) cut \.\.\.\]/)
})

test('truncateMiddle handles one giant line and short text', async () => {
  expect(truncateMiddle('short', 100)).toBe('short')
  const t = truncateMiddle('a'.repeat(1000) + 'Z'.repeat(1000), 200)
  expect(t.length).toBeLessThan(260)
  expect(t.startsWith('a')).toBe(true)
  expect(t.endsWith('Z')).toBe(true)
  expect(t).toContain('cut')
})

test('the total cap is respected', async () => {
  const attempts = Array.from({ length: 30 }, (_, i) => ({ tool: 'Bash', summary: `cmd ${i}`, ok: false, error: `distinct failure ${i}\n` + 'x'.repeat(5000) }))
  const big = base({ attempts, goal: 'g'.repeat(50000), extra: 'e'.repeat(50000), diffStat: 'd'.repeat(50000) })
  expect(buildDossier(big, { maxChars: 3000 }).length).toBeLessThan(3001)
  expect(buildDossier(big).length).toBeLessThan(12001)
})

test('only the last N attempts are shown', async () => {
  const attempts = Array.from({ length: 20 }, (_, i) => ({ tool: 'Bash', summary: `cmd-${i}-end`, ok: true }))
  const out = buildDossier(base({ attempts }), { maxAttempts: 5 })
  expect(out).toContain('cmd-19-end')
  expect(out).toContain('cmd-15-end')
  expect(out).not.toContain('cmd-14-end')
})

test('identical consecutive errors collapse', async () => {
  const e = { tool: 'Bash', summary: 'npm test', ok: false, error: 'Error at line 12' }
  const out = buildDossier(base({ attempts: [e, { ...e, error: 'Error at line 99' }, e] }))
  expect(out).toContain('same error ×3')
  expect(out.split('Error at line').length - 1).toBe(1)
})

test('different errors are not collapsed', async () => {
  const out = buildDossier(base({ attempts: [
    { tool: 'Bash', summary: 'a', ok: false, error: 'first problem' },
    { tool: 'Bash', summary: 'b', ok: false, error: 'second problem' },
  ] }))
  expect(out).not.toContain('same error')
  expect(out).toContain('first problem')
  expect(out).toContain('second problem')
})

test('redacts each secret pattern', async () => {
  expect(redactSecrets('DB_PASSWORD=hunter22 failed')).toBe('DB_PASSWORD=[redacted] failed')
  expect(redactSecrets('password: "my secret pw"')).toContain('[redacted]')
  expect(redactSecrets('password: "my secret pw"')).not.toContain('secret pw')
  expect(redactSecrets('{"api_key": "abcd1234efgh"}')).not.toContain('abcd1234efgh')
  expect(redactSecrets('GITHUB_TOKEN=ghp_abcdefghijklmnop1234')).not.toContain('ghp_')
  expect(redactSecrets('Authorization: Bearer abc.def.ghi')).toBe('Authorization: [redacted]')
  expect(redactSecrets('authorization=Basic dXNlcjpwYXNz')).not.toContain('dXNlcjpwYXNz')
  const pem = 'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----\nafter'
  expect(redactSecrets(pem)).toBe('before\n[redacted]\nafter')
  expect(redactSecrets('key ' + 'a1b2c3d4'.repeat(8))).toBe('key [redacted]')
  expect(redactSecrets('blob Zm9vQmFyQmF6MTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1O end')).toBe('blob [redacted] end')
  expect(redactSecrets('use sk-ant1234567890abcdefghij now')).toBe('use [redacted] now')
})

test('normal text is untouched', async () => {
  const normal = [
    'TypeError: Cannot read properties of undefined (reading "map")',
    'at /src/components/VeryLongComponentNameForTheApp/index.ts:12:4',
    'commit 4ef4405c84a50e8b7d3b8b2f1a2d3c4e5f60718a',
    'TokenError: unexpected end',
    'Expected token } but found EOF',
    'password is required',
    'npm ERR! code ELIFECYCLE',
  ].join('\n')
  expect(redactSecrets(normal)).toBe(normal)
})

test('secrets are redacted in the whole dossier', async () => {
  const out = buildDossier(base({
    attempts: [{ tool: 'Bash', summary: 'curl -H "Authorization: Bearer abc123xyz"', ok: false, error: 'API_TOKEN=supersecretvalue rejected' }],
    extra: 'tried password=letmein99',
  }))
  expect(out).not.toContain('supersecretvalue')
  expect(out).not.toContain('abc123xyz')
  expect(out).not.toContain('letmein99')
})

test('files are listed with counts, most edited first', async () => {
  const out = buildDossier(base({ files: [{ path: 'a.ts', edits: 1 }, { path: 'b.ts', edits: 7 }] }))
  expect(out).toContain('b.ts (7 edits)')
  expect(out).toContain('a.ts (1 edit)')
  expect(out.indexOf('b.ts')).toBeLessThan(out.indexOf('a.ts'))
})

test('never throws on odd input', async () => {
  expect(typeof buildDossier(undefined as unknown as DossierInput)).toBe('string')
  expect(typeof buildDossier({} as DossierInput)).toBe('string')
  expect(typeof buildDossier(base({ attempts: [{ tool: 'x', summary: undefined as unknown as string, ok: false, error: 5 as unknown as string }] }))).toBe('string')
})

test('inputFromState maps a typical agent state', async () => {
  let s = newAgent('a1', 'code', 'haiku', 'Make the build green')
  for (let i = 0; i < 3; i++) s = observe(s, { tool: 'Bash', ok: false, text: 'boom', summary: 'npm run build' }).state
  s = observe(s, { tool: 'Edit', ok: true, text: '', summary: 'src/a.ts' }).state
  const input = inputFromState(s, { diffStat: ' 1 file changed', extra: 'stuck' })
  expect(input.goal).toBe('Make the build green')
  expect(input.tier).toBe('haiku')
  expect(input.interventions).toBe(s.level)
  expect(input.diffStat).toBe(' 1 file changed')
  expect(input.extra).toBe('stuck')
  expect(input.attempts.length).toBe(4)
  expect(input.attempts[0]).toMatchObject({ tool: 'Bash', summary: 'npm run build', ok: false })
  expect(input.attempts[3]).toMatchObject({ tool: 'Edit', summary: 'src/a.ts', ok: true })
  expect(input.files).toEqual([{ path: 'src/a.ts', edits: 1 }])
  expect(buildDossier(input)).toContain('Make the build green')
})

// A shell call that exited 0 but whose output reports a failure: the senior sees that output, not a bare "ok".
const SOFT = 'FAIL: answer.txt does not match the expected digest'

test('a soft failure reaches the dossier with its output, redacted and capped like an error', async () => {
  let s = newAgent('a1', 'code', 'haiku', 'Guess the word')
  const secret = `${SOFT}\ntoken=abcd1234efgh5678\n${'noise line\n'.repeat(400)}last line`
  s = observe(s, { tool: 'Bash', ok: true, text: secret, summary: 'bash check.sh | tail -1' }).state
  s = observe(s, { tool: 'Bash', ok: true, text: 'a.txt', summary: 'ls' }).state
  const input = inputFromState(s)
  expect(input.attempts[0]).toMatchObject({ tool: 'Bash', summary: 'bash check.sh | tail -1', ok: true, soft: true })
  expect(input.attempts[0]!.error).toContain(SOFT)
  expect(input.attempts[1]).toEqual({ tool: 'Bash', summary: 'ls', ok: true })
  const out = buildDossier(input)
  expect(out).toContain('- Bash: bash check.sh | tail -1 -> ok, but the output reports a failure')
  expect(out).toContain(`    ${SOFT}`)
  expect(out).not.toContain('abcd1234efgh5678')
  expect(out).toContain('lines cut')
  expect(out).toContain('- Bash: ls -> ok')
})

test('soft failures and errors share the ring of full texts, matched from the end', async () => {
  const s = { ...newAgent('a', 'x', 'sonnet', 't'),
    log: ['Bash: npm test -> ERR short', 'Bash: bash check.sh | tail -1 -> ok (the output reports a failure)', 'Bash: ls -> ok', 'Bash: make -> ERR other'],
    recentErrors: ['full error one', 'FAIL: soft output', 'full error two'] }
  const input = inputFromState(s)
  expect(input.attempts.map((a) => a.error)).toEqual(['full error one', 'FAIL: soft output', undefined, 'full error two'])
  expect(input.attempts.map((a) => a.ok)).toEqual([false, true, true, false])
  // Without its full text a soft failure still says what happened.
  const bare = inputFromState({ ...s, recentErrors: [] })
  expect(bare.attempts[1]).toEqual({ tool: 'Bash', summary: 'bash check.sh | tail -1', ok: true, soft: true })
  expect(buildDossier(bare)).toContain('-> ok, but the output reports a failure')
})

test('the same soft failure repeated is shown once with its count', async () => {
  const out = buildDossier(base({ attempts: [
    { tool: 'Bash', summary: 'echo a > x && bash check.sh | tail -1', ok: true, soft: true, error: SOFT },
    { tool: 'Bash', summary: 'echo b > x && bash check.sh | tail -1', ok: true, soft: true, error: SOFT },
    { tool: 'Bash', summary: 'echo c > x && bash check.sh | tail -1', ok: true, soft: true, error: SOFT },
  ] }))
  expect(out).toContain('(same output ×3)')
  expect(out.split(SOFT).length - 1).toBe(1)
})

test('inputFromState prefers full error texts when the state carries them', async () => {
  const s = { ...newAgent('a', 'x', 'sonnet', 't'), log: ['Bash: npm test -> ERR short', 'Bash: ls -> ok'], recentErrors: ['the full error text\nline two'] }
  const input = inputFromState(s)
  expect(input.attempts[0]!.error).toBe('the full error text\nline two')
  expect(input.attempts[1]!.ok).toBe(true)
})
