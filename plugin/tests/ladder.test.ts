import { expect, mock, test } from 'claude-code/testing'
import { resetState } from '../hooks/register'
import { afterHelp, escalated, newAgent, observe } from '../hooks/detector'
import { DEFAULT_CONFIG, parseConfig, type Config } from '../hooks/config'
import { parseSnapshot } from '../hooks/state'

type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

function wire(on: any): { stepModels: string[] } {
  resetState()
  mock.env(on, {})
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  const h = { stepModels: [] as string[] }
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a' + ++n }))
  on('tool.call', () => ({ isError: true, result: 'Error: boom', text: 'Error: boom' }) as never)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'advice' } }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    h.stepModels.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20000, cache_creation_input_tokens: 1000 } } as never
  })
  for (const k of ['ui.log', 'ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return h
}

const kindOf = (note: string): string =>
  note.includes('stronger model') ? 'swap' : note.includes('Stop now') ? 'human' : note.includes('not making progress') ? 'nudge' : 'consult'

// Runs a stuck agent and returns the ladder it climbed: each note's kind, plus the model of a request after every swap.
async function climb($: any, h: { stepModels: string[] }, model: string, calls = 80): Promise<{ kinds: string[]; swapModels: string[]; notes: string[] }> {
  const { agentId } = await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model } as never) as { agentId: string }
  const kinds: string[] = []
  const swapModels: string[] = []
  const notes: string[] = []
  for (let i = 0; i < calls; i++) {
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test', agentId } as never) as { context?: readonly string[] }
    for (const c of r.context ?? []) {
      notes.push(c)
      kinds.push(kindOf(c))
      if (kindOf(c) === 'swap') {
        await drain($.turn.step({ turnId: 't' + i, index: 0, model, messageCount: 3, agentId } as never) as never)
        swapModels.push(h.stepModels.at(-1)!)
      }
    }
  }
  return { kinds, swapModels, notes }
}

test('a Haiku agent climbs through sonnet to opus before a human is asked', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const r = await climb($, h, 'haiku')
  expect(r.kinds).toEqual(['nudge', 'consult', 'swap', 'swap', 'human'])
  expect(r.swapModels).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5'])
  expect(r.notes[2]).toContain('(sonnet)')
  expect(r.notes[3]).toContain('(opus)')
})

test('a Sonnet agent swaps once to opus, then a human is asked', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const r = await climb($, h, 'sonnet')
  expect(r.kinds).toEqual(['nudge', 'consult', 'swap', 'human'])
  expect(r.swapModels).toEqual(['claude-opus-5-5'])
})

test('an Opus agent never gets a swap note', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const r = await climb($, h, 'opus')
  expect(r.kinds).toEqual(['nudge', 'consult', 'human'])
  expect(r.swapModels).toEqual([])
})

test('maxTier sonnet stops a Haiku agent at sonnet and skips the swap for a Sonnet agent', { options: { maxTier: 'sonnet' } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const a = await climb($, h, 'haiku')
  expect(a.kinds).toEqual(['nudge', 'consult', 'swap', 'human'])
  expect(a.swapModels).toEqual(['claude-sonnet-5-5'])
  expect((await climb($, h, 'sonnet')).kinds).toEqual(['nudge', 'consult', 'human'])
})

test('without the swap level nobody is swapped', { options: { levels: 'nudge,consult,human' } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const r = await climb($, h, 'haiku')
  expect(r.kinds).toEqual(['nudge', 'consult', 'human'])
  expect(r.swapModels).toEqual([])
})

// Pure ladder, driven directly.
function drive(model: string, cfg: Config = DEFAULT_CONFIG, start = newAgent('x', 'c', model, 't'), calls = 80) {
  let s = start
  const out: string[] = []
  const tiers: string[] = []
  for (let i = 0; i < calls; i++) {
    const r = observe(s, { tool: 'Bash', ok: false, text: 'Error: boom', summary: 'npm test' }, cfg)
    s = r.state
    if (r.action) { out.push(r.action); tiers.push(s.tier) }
  }
  return { out, tiers, s }
}

test('pure ladder: swaps keep the level and move one tier up each time', () => {
  const r = drive('claude-haiku-5-5')
  expect(r.out).toEqual(['nudge', 'consult', 'swap', 'swap', 'human'])
  expect(r.tiers).toEqual(['haiku', 'haiku', 'sonnet', 'opus', 'opus'])
  expect(escalated(r.s, DEFAULT_CONFIG.levels)).toBe(true)
})

test('pure ladder: swap as the last level keeps swapping up to maxTier, then stops', () => {
  const r = drive('claude-haiku-5-5', { ...DEFAULT_CONFIG, levels: ['nudge', 'swap'] })
  expect(r.out).toEqual(['nudge', 'swap', 'swap'])
})

test('pure ladder: a skipped swap goes straight to the next level at the same trigger', () => {
  expect(drive('claude-opus-5-5', { ...DEFAULT_CONFIG, levels: ['swap', 'human'] }).out).toEqual(['human'])
  expect(drive('claude-opus-5-5', { ...DEFAULT_CONFIG, levels: ['nudge', 'swap'] }).out).toEqual(['nudge'])
})

test('help then stuck: the next escalation is a swap when below maxTier', () => {
  const helped = afterHelp(newAgent('x', 'c', 'claude-haiku-5-5', 't'))
  expect(drive('claude-haiku-5-5', DEFAULT_CONFIG, helped).out).toEqual(['swap', 'swap', 'human'])
  const top = afterHelp(newAgent('x', 'c', 'claude-opus-5-5', 't'))
  expect(drive('claude-opus-5-5', DEFAULT_CONFIG, top).out).toEqual(['human'])
})

test('parseConfig reads maxTier and falls back on invalid values', () => {
  expect(DEFAULT_CONFIG.maxTier).toBe('opus')
  expect(parseConfig({ maxTier: ' Sonnet ' }).maxTier).toBe('sonnet')
  expect(parseConfig({ maxTier: 'haiku' }).maxTier).toBe('haiku')
  for (const bad of ['fable', 'mythos', '', 'gpt', 5, undefined]) expect(parseConfig({ maxTier: bad }).maxTier).toBe('opus')
})

test('parseSnapshot drops a malformed helped flag and keeps a valid one', () => {
  const snap = (a: Record<string, unknown>) => ({ agents: [{ id: 'a', ...a }], ledger: {}, seenModels: {}, sessionTag: 't', mode: 'active', baseline: 'opus', baselinePinned: false })
  expect((parseSnapshot(snap({ helped: 'yes' }))!.agents[0] as any).helped).toBeUndefined()
  expect((parseSnapshot(snap({ helped: true }))!.agents[0] as any).helped).toBe(true)
})
