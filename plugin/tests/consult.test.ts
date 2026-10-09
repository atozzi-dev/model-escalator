import { expect, mock, test } from 'claude-code/testing'
import { resetState } from '../hooks/register'
import { newAgent, otherSenior, skipGrace } from '../hooks/detector'
import { DEFAULT_CONFIG } from '../hooks/config'

type Call = { model: string; prompt: string }
const answered = (text: string) => ({ isAnswered: true, text, usage: { input_tokens: 100, output_tokens: 50 } })
const refused = { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 100, output_tokens: 5 } }

function wire(on: any, replies: (c: Call, n: number) => unknown) {
  resetState()
  mock.env(on, {})
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  const h = { calls: [] as Call[], logs: [] as string[] }
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a' + ++n }))
  on('tool.call', () => ({ isError: true, result: 'Error: boom', text: 'Error: boom' }) as never)
  on('model.complete', (_$: unknown, e: any) => {
    h.calls.push({ model: String(e.model), prompt: String(e.prompt) })
    return { value: replies(h.calls.at(-1)!, h.calls.length) } as never
  })
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('ui.log', (_$: unknown, e: any) => { h.logs.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  for (const k of ['ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return h
}

// Drives a stuck haiku agent; returns each note with the index of the call that produced it.
async function climb($: any, calls = 40): Promise<{ at: number; note: string }[]> {
  const { agentId } = await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model: 'haiku' } as never) as { agentId: string }
  const out: { at: number; note: string }[] = []
  for (let i = 0; i < calls; i++) {
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test', agentId } as never) as { context?: readonly string[] }
    for (const c of r.context ?? []) out.push({ at: i, note: c })
  }
  return out
}

const report = async ($: any): Promise<string> =>
  ((await $.command.run({ command: 'escalator', args: 'report', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)) as { text: string }).text

test('pure helpers: other senior, skipped grace', () => {
  expect(otherSenior('opus')).toBe('sonnet')
  expect(otherSenior('claude-opus-5-5')).toBe('sonnet')
  expect(otherSenior('sonnet')).toBe('opus')
  expect(otherSenior('claude-sonnet-5-5')).toBe('opus')
  expect(otherSenior('haiku')).toBe('opus')
  let s = newAgent('a1', 'test', 'haiku', 'fix the build')
  s = { ...s, log: Array.from({ length: 12 }, (_, i) => `step ${i}`) }
  expect(skipGrace({ ...s, stepsSinceAction: 0 }, DEFAULT_CONFIG).stepsSinceAction).toBe(DEFAULT_CONFIG.grace)
  expect(skipGrace({ ...s, stepsSinceAction: 99 }, DEFAULT_CONFIG).stepsSinceAction).toBe(99)
})

test('answered at the first try: one call, no retry', async ($, on) => {
  const h = wire(on, () => answered('check the lockfile'))
  await $.session.start({ cwd: '/work' } as never)
  const notes = await climb($)
  expect(h.calls.length).toBe(1)
  expect(h.calls[0]!.model).toBe('opus')
  expect(notes.some(n => n.note.includes('check the lockfile'))).toBe(true)
  expect(await report($)).toContain('senior consults: 1')
})

test('refused first, answered on the other model with a shorter prompt: advice returned, two consults counted', async ($, on) => {
  const h = wire(on, (_c, n) => (n === 1 ? refused : answered('retry advice')))
  await $.session.start({ cwd: '/work' } as never)
  const notes = await climb($)
  expect(h.calls.length).toBe(2)
  expect(h.calls[0]!.model).toBe('opus')
  expect(h.calls[1]!.model).toBe('sonnet')
  expect(h.calls[1]!.prompt.length).toBeLessThanOrEqual(h.calls[0]!.prompt.length)
  expect(h.calls[1]!.prompt).toContain('## Task')
  expect(notes.some(n => n.note.includes('retry advice'))).toBe(true)
  expect(await report($)).toContain('senior consults: 2')
})

test('seniorModel sonnet retries on opus', { options: { seniorModel: 'sonnet' } }, async ($, on) => {
  const h = wire(on, (_c, n) => (n === 1 ? refused : answered('ok')))
  await $.session.start({ cwd: '/work' } as never)
  await climb($)
  expect(h.calls.map(c => c.model)).toEqual(['sonnet', 'opus'])
})

test('refused twice: generic note, logged, and the next step comes sooner than after real advice', async ($, on) => {
  const h = wire(on, () => refused)
  await $.session.start({ cwd: '/work' } as never)
  const notes = await climb($)
  expect(h.calls.length).toBe(2)
  expect(h.logs.some(l => l.includes('consult refused twice'))).toBe(true)
  const consult = notes.find(n => n.note.includes('Still stuck'))!
  expect(consult).toBeDefined()
  const next = notes.find(n => n.at > consult.at)!
  expect(next.note).toContain('stronger model')
  // The next qualifying call: the score threshold is the only wait left, not the grace window.
  expect(next.at - consult.at).toBeLessThanOrEqual(DEFAULT_CONFIG.threshold.haiku)
})

test('with real advice the ladder still waits out the grace window', async ($, on) => {
  const h = wire(on, () => answered('advice'))
  await $.session.start({ cwd: '/work' } as never)
  const notes = await climb($)
  const c = notes.find(n => n.note.includes('advice'))!
  const next = notes.find(n => n.at > c.at)!
  expect(h.calls.length).toBe(1)
  expect(next.at - c.at).toBeGreaterThanOrEqual(DEFAULT_CONFIG.grace)
})
