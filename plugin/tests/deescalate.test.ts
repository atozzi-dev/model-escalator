import { expect, mock, test } from 'claude-code/testing'
import { DEFAULT_CONFIG, parseConfig } from '../hooks/config'
import { escalated, newAgent, noteProgress, pauseAgent } from '../hooks/detector'
import { resetState } from '../hooks/register'
import { parseSnapshot } from '../hooks/state'

type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

type Harness = { stepModels: string[]; logs: string[]; text: { value: string; ok: boolean } }

// Fake core under the plugin: spawn, a tool whose output the test chooses, metered steps.
function wire(on: any, env: Record<string, string> = {}): Harness {
  resetState()
  mock.env(on, env)
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  const h: Harness = { stepModels: [], logs: [], text: { value: 'Error: boom', ok: false } }
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a' + ++n }))
  on('tool.call', () => ({ isError: !h.text.ok, result: h.text.value, text: h.text.value }) as never)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'advice' } }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    h.stepModels.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
  on('ui.log', (_$: unknown, e: any) => { h.logs.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  for (const k of ['ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return h
}

const spawn = async ($: any, model = 'haiku'): Promise<string> =>
  ((await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model } as never)) as { agentId: string }).agentId

type Notes = readonly string[]
async function call($: any, agentId: string): Promise<Notes> {
  const r = await $.tool.call({ tool: 'Bash', command: 'npm test', agentId } as never) as { context?: Notes }
  return r.context ?? []
}

const FAIL = { value: 'Error: boom', ok: false }
const GOOD = { value: 'Tests: 0 failed, 3 passed', ok: true }

// Fails until `n` swap notes arrived (the levels option below keeps swap first).
async function escalate($: any, h: Harness, id: string, n: number): Promise<void> {
  h.text = FAIL
  let seen = 0
  for (let i = 0; i < 60 && seen < n; i++) seen += (await call($, id)).filter((c) => c.includes('stronger model')).length
  expect(seen).toBe(n)
}

async function progress($: any, h: Harness, id: string, times: number): Promise<string[]> {
  h.text = GOOD
  const out: string[] = []
  for (let i = 0; i < times; i++) out.push(...await call($, id))
  return out
}

const step = async ($: any, id: string): Promise<void> => {
  await drain($.turn.step({ turnId: 't', index: 0, model: 'haiku', messageCount: 3, agentId: id } as never) as never)
}

const report = async ($: any): Promise<string> =>
  ((await $.command.run({ command: 'escalator', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)) as { text: string }).text

const OPT = { options: { levels: 'swap,human', deescalateAfter: 2 } }

test('off by default: no de-escalation after many progress signals', { options: { levels: 'swap,human' } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await escalate($, h, id, 1)
  const notes = await progress($, h, id, 8)
  expect(notes.filter((c) => c.includes('Progress noted'))).toEqual([])
  await step($, id)
  expect(h.stepModels.at(-1)).toBe('claude-sonnet-5-5')
})

test('Haiku to Sonnet goes back to Haiku after two progress signals', OPT, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await escalate($, h, id, 1)
  await step($, id)
  expect(h.stepModels.at(-1)).toBe('claude-sonnet-5-5')
  expect(await progress($, h, id, 1)).toEqual([])
  const notes = await progress($, h, id, 1)
  expect(notes.some((c) => c.includes('Progress noted') && c.includes('haiku'))).toBe(true)
  expect(h.logs.some((l) => l.includes('de-escalate'))).toBe(true)
  await step($, id)
  expect(h.stepModels.at(-1)).toBe('haiku')
  expect(await report($)).toContain('deescalate 1')
})

test('Haiku to Sonnet to Opus goes back one tier, to Sonnet', OPT, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await escalate($, h, id, 2)
  await step($, id)
  expect(h.stepModels.at(-1)).toBe('claude-opus-5-5')
  const notes = await progress($, h, id, 2)
  expect(notes.some((c) => c.includes('sonnet'))).toBe(true)
  await step($, id)
  expect(h.stepModels.at(-1)).toBe('claude-sonnet-5-5')
})

test('a later block swaps it up again, and it is not de-escalated a second time', OPT, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await escalate($, h, id, 1)
  await progress($, h, id, 2)
  await step($, id)
  expect(h.stepModels.at(-1)).toBe('haiku')
  await escalate($, h, id, 1)
  await step($, id)
  expect(h.stepModels.at(-1)).toBe('claude-sonnet-5-5')
  const notes = await progress($, h, id, 6)
  expect(notes.filter((c) => c.includes('Progress noted'))).toEqual([])
  await step($, id)
  expect(h.stepModels.at(-1)).toBe('claude-sonnet-5-5')
})

test('the allowance restarts when the run is over', OPT, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await escalate($, h, id, 1)
  await progress($, h, id, 2)
  await $.turn.complete({ turnId: 't', agentId: id, answer: 'done' } as never)
  await escalate($, h, id, 1)
  const notes = await progress($, h, id, 2)
  expect(notes.some((c) => c.includes('Progress noted'))).toBe(true)
})

test('observe logs what it would do and never changes the model', OPT, async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'observe' })
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  h.text = FAIL
  for (let i = 0; i < 12; i++) await call($, id)
  expect(h.logs.some((l) => l.includes('would swap'))).toBe(true)
  const notes = await progress($, h, id, 2)
  expect(notes).toEqual([])
  expect(h.logs.some((l) => l.includes('would de-escalate'))).toBe(true)
  await step($, id)
  expect(h.stepModels.at(-1)).toBe('haiku')
  expect(await report($)).toContain('deescalate 1')
})

test('noteProgress: never for a paused agent, never below the start tier, never when off', () => {
  const cfg = parseConfig({ deescalateAfter: 1 })
  const up = { ...newAgent('a', 'c', 'haiku', 't'), tier: 'sonnet' as const, level: 3 }
  expect(noteProgress(up, cfg).tier).toBe('haiku')
  expect(noteProgress(pauseAgent(up), cfg).tier).toBeUndefined()
  expect(noteProgress(newAgent('b', 'c', 'haiku', 't'), cfg).tier).toBeUndefined()
  expect(noteProgress(up, DEFAULT_CONFIG).tier).toBeUndefined()
  const done = noteProgress(up, cfg)
  expect(done.state.deescalated).toBe(true)
  expect(done.state.level).toBe(2)
  expect(noteProgress({ ...up, deescalated: true }, cfg).tier).toBeUndefined()
})

test('deescalateAfter is parsed from options and off by default', () => {
  expect(DEFAULT_CONFIG.deescalateAfter).toBe(0)
  expect(parseConfig({ deescalateAfter: 3 }).deescalateAfter).toBe(3)
  expect(parseConfig({ deescalateAfter: '2' }).deescalateAfter).toBe(2)
  expect(parseConfig({ deescalateAfter: -1 }).deescalateAfter).toBe(0)
  expect(parseConfig({ deescalateAfter: 'x' }).deescalateAfter).toBe(0)
})

test('a snapshot without the new fields hydrates, a malformed value is dropped', () => {
  const base = { agents: [{ id: 'a', tier: 'sonnet', startTier: 'haiku' }], ledger: {}, seenModels: {}, sessionTag: 't', mode: 'active', baseline: 'opus', baselinePinned: false }
  const old = parseSnapshot(base)!
  expect(old.agents[0]!.deescalated).toBeUndefined()
  const bad = parseSnapshot({ ...base, agents: [{ id: 'a', progressSignals: -2, deescalated: 'yes' }] })!
  expect(bad.agents[0]!.progressSignals).toBeUndefined()
  expect(bad.agents[0]!.deescalated).toBeUndefined()
  const ok = parseSnapshot({ ...base, agents: [{ id: 'a', progressSignals: 1, deescalated: true }] })!
  expect(ok.agents[0]!.progressSignals).toBe(1)
  expect(ok.agents[0]!.deescalated).toBe(true)
})

test('a run that swapped up and came back is recorded as escalated', OPT, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await escalate($, h, id, 1)
  await progress($, h, id, 2)
  await $.turn.complete({ turnId: 't', agentId: id, answer: 'done' } as never)
  const text = ((await $.command.run({ command: 'escalator', args: 'stats', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)) as { text: string }).text
  expect(text).toContain('haiku: 1 runs, 1 escalated')
})

test('escalated() is true for a de-escalated agent', () => {
  const s = { ...newAgent('a', 'c', 'haiku', 't'), level: 0, deescalated: true }
  expect(escalated(s, DEFAULT_CONFIG.levels)).toBe(true)
})
