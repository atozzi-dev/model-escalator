import { expect, mock, test } from 'claude-code/testing'
import { HELP_TOOL, resetState } from '../hooks/register'
import { newAgent, observe } from '../hooks/detector'
import { parseSnapshot } from '../hooks/state'

type Call = { model: string; prompt: string }
type Opts = { errorText?: string; diff?: unknown; replies?: (n: number) => unknown }
const answered = (text: string) => ({ isAnswered: true, text, usage: { input_tokens: 100, output_tokens: 50 } })
const refused = { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 100, output_tokens: 5 } }
const diffOk = { exitCode: 0, stdout: ' src/parser.ts | 4 ++--\n 1 file changed', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

function wire(on: any, o: Opts = {}) {
  resetState()
  mock.env(on, {})
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  const h = { calls: [] as Call[], runs: [] as { argv: readonly string[]; timeoutMs?: number }[] }
  let n = 0
  const err = o.errorText ?? 'Error: boom'
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a' + ++n }))
  on('tool.call', (_$: unknown, e: any) => (e.tool === 'Edit' ? { result: 'edited', text: 'edited' } : { isError: true, result: err, text: err }) as never)
  on('process.run', async (_$: unknown, e: any) => {
    h.runs.push({ argv: e.argv, timeoutMs: e.init?.timeoutMs })
    if (o.diff === 'throw') throw new Error('no git')
    return { value: o.diff ?? diffOk } as never
  })
  on('model.complete', (_$: unknown, e: any) => {
    h.calls.push({ model: String(e.model), prompt: String(e.prompt) })
    return { value: o.replies ? o.replies(h.calls.length) : answered('advice') } as never
  })
  on('turn.complete', () => ({ text: 'done' }) as never)
  for (const k of ['ui.log', 'ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return h
}

async function spawn($: any): Promise<string> {
  return ((await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model: 'haiku' } as never)) as { agentId: string }).agentId
}
async function climb($: any, agentId: string, calls = 40): Promise<void> {
  for (let i = 0; i < calls; i++) await $.tool.call({ tool: 'Bash', command: 'npm test', agentId } as never)
}

test('the senior prompt carries the full error, the touched files and the diff stat', async ($, on) => {
  const long = 'Error: build failed\n' + 'x'.repeat(5000) + '\nTAIL-MARKER'
  const h = wire(on, { errorText: long })
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await climb($, id)
  expect(h.calls.length).toBe(1)
  const p = h.calls[0]!.prompt
  expect(p).toContain('## Recent attempts')
  expect(p).toContain('Error: build failed')
  expect(p).toContain('TAIL-MARKER')
  expect(p).toMatch(/cut/)
  expect(p).toContain('## Diff stat')
  expect(p).toContain('src/parser.ts | 4 ++--')
  expect(h.runs.length).toBe(1)
  expect(Array.from(h.runs[0]!.argv)).toEqual(['git', 'diff', '--stat'])
  expect(h.runs[0]!.timeoutMs).toBe(5000)
})

test('touched files appear with their edit counts', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Edit', file_path: '/work/src/a.ts', agentId: id } as never)
  await climb($, id)
  const p = h.calls[0]?.prompt ?? ''
  expect(p).toContain('## Files touched')
  expect(p).toMatch(/a\.ts \(\d+ edits?\)/)
})

async function noDiff($: any, on: any, diff: unknown): Promise<void> {
  const h = wire(on, { diff })
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await climb($, id)
  expect(h.calls.length).toBe(1)
  expect(h.runs.length).toBe(1)
  expect(h.calls[0]!.prompt).not.toContain('## Diff stat')
  expect(h.calls[0]!.prompt).not.toContain('fatal')
}
test('no diff section when git cannot run', async ($, on) => { await noDiff($, on, 'throw') })
test('no diff section when git exits non-zero', async ($, on) => { await noDiff($, on, { ...diffOk, exitCode: 128, stdout: 'fatal: not a repo' }) })
test('no diff section when git prints nothing', async ($, on) => { await noDiff($, on, { ...diffOk, stdout: '   ' }) })

test('a secret in an error is redacted in the prompt', async ($, on) => {
  const h = wire(on, { errorText: 'Error: auth failed\nAPI_TOKEN=abcd1234efgh5678 rejected' })
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await climb($, id)
  expect(h.calls[0]!.prompt).toContain('auth failed')
  expect(h.calls[0]!.prompt).not.toContain('abcd1234efgh5678')
})

test('the help tool problem and tried text go under the agent notes', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await $.tool.call({ tool: HELP_TOOL, problem: 'the parser loops forever', tried: 'removed the cache', agentId: id } as never)
  expect(h.calls.length).toBe(1)
  const p = h.calls[0]!.prompt
  expect(p).toContain('## Agent notes')
  const notes = p.slice(p.indexOf('## Agent notes'))
  expect(notes).toContain('the parser loops forever')
  expect(notes).toContain('removed the cache')
})

test('the retry uses a tighter dossier and does not run git again', async ($, on) => {
  const h = wire(on, { errorText: 'Error: ' + 'y'.repeat(1400), replies: (n) => (n === 1 ? refused : answered('ok')) })
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await climb($, id)
  expect(h.calls.length).toBe(2)
  expect(h.calls[1]!.model).toBe('sonnet')
  expect(h.calls[1]!.prompt.length).toBeLessThan(h.calls[0]!.prompt.length)
  expect(h.calls[1]!.prompt).toContain('## Task')
  expect(h.runs.length).toBe(1)
})

test('observe keeps a bounded ring of full error texts for failed calls only', () => {
  let s = newAgent('a', 'test', 'haiku', 'task')
  for (let i = 0; i < 10; i++) s = observe(s, { tool: 'Bash', summary: 'run', ok: false, text: `fail ${i} ` + 'z'.repeat(5000) }).state
  s = observe(s, { tool: 'Bash', summary: 'run', ok: true, text: 'fine' }).state
  const ring = s.recentErrors!
  expect(ring.length).toBe(6)
  expect(ring[5]).toContain('fail 9')
  expect(ring[0]).toContain('fail 4')
  expect(ring.every((e) => e.length <= 2000)).toBe(true)
})

test('a hidden failure (ok result with a failing run and a non-zero exit) is an ERR line with its full text in the ring', () => {
  const text = 'FAIL src/a.test.ts\nTests: 1 failed, 1 passed, 2 total\nexit=1'
  const s = observe(newAgent('a', 'test', 'haiku', 'task'), { tool: 'Bash', summary: 'npm test', ok: true, text }).state
  expect(s.log[0]).toContain('-> ERR')
  expect(s.recentErrors).toEqual([text])
  const ok = observe(s, { tool: 'Bash', summary: 'ls', ok: true, text: 'fine' }).state
  expect(ok.log[1]).toContain('-> ok')
  expect(ok.recentErrors!.length).toBe(1)
})

test('parseSnapshot validates recentErrors and old snapshots hydrate', () => {
  const snap = (a: Record<string, unknown>) => ({ agents: [{ id: 'a', ...a }], ledger: {}, seenModels: {}, sessionTag: 't', mode: 'active', baseline: 'opus', baselinePinned: false })
  const get = (a: Record<string, unknown>) => (parseSnapshot(snap(a))!.agents[0] as any).recentErrors
  expect(get({})).toBeUndefined()
  expect(get({ recentErrors: 'oops' })).toBeUndefined()
  expect(get({ recentErrors: ['a', 5] })).toBeUndefined()
  expect(get({ recentErrors: ['a', 'b'] })).toEqual(['a', 'b'])
  expect(get({ recentErrors: Array.from({ length: 20 }, (_, i) => 'e' + i) }).length).toBe(6)
  expect(get({ recentErrors: ['x'.repeat(9000)] })[0].length).toBe(2000)
})
