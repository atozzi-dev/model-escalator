import { expect, mock, test } from 'claude-code/testing'
import { HELP_TOOL, resetState } from '../hooks/register'
import { consultLimit, newAgent, observe } from '../hooks/detector'
import { DEFAULT_CONFIG, parseConfig } from '../hooks/config'
import { parseSnapshot } from '../hooks/state'

type Call = { model: string; prompt: string }
// 100k input tokens: 0.40 USD on Opus (4 per million), 0.20 USD on Sonnet (2 per million).
const usage = { input_tokens: 100_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const answered = (text: string) => ({ isAnswered: true, text, usage })
const refused = { isAnswered: false, reason: 'empty-reply', usage }

function wire(on: any, replies: (c: Call, n: number) => unknown) {
  resetState()
  mock.env(on, {})
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  const h = { calls: [] as Call[], logs: [] as string[] }
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a' + ++n }))
  // `ls` succeeds (it only lets steps pass); anything else fails, so the ladder climbs.
  on('tool.call', (_$: unknown, e: any) => (e.command === 'ls'
    ? { isError: false, result: 'ok', text: 'ok' }
    : { isError: true, result: 'Error: boom', text: 'Error: boom' }) as never)
  on('model.complete', (_$: unknown, e: any) => {
    h.calls.push({ model: String(e.model), prompt: String(e.prompt) })
    return { value: replies(h.calls.at(-1)!, h.calls.length) } as never
  })
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('ui.log', (_$: unknown, e: any) => { h.logs.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  for (const k of ['ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return h
}

async function spawn($: any): Promise<string> {
  const r = await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model: 'haiku' } as never) as { agentId: string }
  return r.agentId
}

const ask = async ($: any, agentId: string): Promise<string> => {
  const r = await $.tool.call({ tool: HELP_TOOL, problem: 'the migration hangs', tried: 'restarted the db', agentId } as never) as { result?: unknown }
  return String(r.result ?? '')
}

// Four successful steps: the grace window after a consult, so the agent may ask again.
async function breathe($: any, agentId: string): Promise<void> {
  for (let i = 0; i < 4; i++) await $.tool.call({ tool: 'Bash', command: 'ls', agentId } as never)
}

const REFUSED_TEXT = 'No further senior consult'

test('per agent: the fourth ask is refused with no model call, and the refusal is logged once', async ($, on) => {
  const h = wire(on, () => answered('ok advice'))
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  const out: string[] = []
  for (let i = 0; i < 5; i++) {
    out.push(await ask($, id))
    await breathe($, id)
  }
  expect(out.slice(0, 3).every(t => t.includes('ok advice'))).toBe(true)
  expect(out[3]).toContain(REFUSED_TEXT)
  expect(out[3]).toContain('different approach')
  expect(out[4]).toContain(REFUSED_TEXT)
  expect(h.calls.length).toBe(3)
  expect(h.logs.filter(l => l.includes('consult limit reached')).length).toBe(1)
  expect(h.logs.some(l => l.includes('consult limit reached: per agent (3 consults)'))).toBe(true)
})

test('per session: the limit counts consults of all agents together', { options: { maxConsultsPerSession: 2 } }, async ($, on) => {
  const h = wire(on, () => answered('ok advice'))
  await $.session.start({ cwd: '/work' } as never)
  const a = await spawn($)
  const b = await spawn($)
  expect(await ask($, a)).toContain('ok advice')
  await breathe($, a)
  expect(await ask($, b)).toContain('ok advice')
  await breathe($, b)
  expect(await ask($, a)).toContain(REFUSED_TEXT)
  expect(await ask($, b)).toContain(REFUSED_TEXT)
  expect(h.calls.length).toBe(2)
  expect(h.logs.some(l => l.includes('consult limit reached: per session (2 consults)'))).toBe(true)
})

test('dollar budget: once the senior calls cost the budget, no further consult', { options: { consultBudgetUsd: 0.5 } }, async ($, on) => {
  const h = wire(on, () => answered('ok advice'))
  await $.session.start({ cwd: '/work' } as never)
  const a = await spawn($)
  const b = await spawn($)
  expect(await ask($, a)).toContain('ok advice')   // 0.40 spent
  expect(await ask($, b)).toContain('ok advice')   // 0.40 < 0.50: allowed, 0.80 spent
  await breathe($, a)
  expect(await ask($, a)).toContain(REFUSED_TEXT)
  expect(h.calls.length).toBe(2)
  expect(h.logs.some(l => l.includes('consult limit reached: budget (USD 0.5)'))).toBe(true)
})

test('a refused consult and its retry count as one consult, but both calls count for the budget', { options: { consultBudgetUsd: 0.5 } }, async ($, on) => {
  // First call refused (0.40 USD on Opus), retry answered on Sonnet (0.20 USD): 0.60 USD, one consult.
  const h = wire(on, (_c, n) => (n === 1 ? refused : answered('retry advice')))
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  expect(await ask($, id)).toContain('retry advice')
  expect(h.calls.length).toBe(2)
  await breathe($, id)
  expect(await ask($, id)).toContain(REFUSED_TEXT)
  expect(h.calls.length).toBe(2)
  // Over the budget (0.60 >= 0.50) with one consult of the agent's three: the budget is what stopped it.
  expect(h.logs.some(l => l.includes('consult limit reached: budget'))).toBe(true)
  expect(h.logs.some(l => l.includes('consult limit reached: per agent'))).toBe(false)
  const report = ((await $.command.run({ command: 'escalator', args: 'report', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)) as { text: string }).text
  expect(report).toContain('senior consults: 2')
})

test('retry counts as one consult for the count limit', { options: { maxConsultsPerAgent: 1 } }, async ($, on) => {
  const h = wire(on, (_c, n) => (n === 1 ? refused : answered('retry advice')))
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  expect(await ask($, id)).toContain('retry advice')
  await breathe($, id)
  expect(await ask($, id)).toContain(REFUSED_TEXT)
  expect(h.calls.length).toBe(2)
})

test('zero consults allowed: the ladder skips the consult and swaps at the same trigger', { options: { maxConsultsPerSession: 0 } }, async ($, on) => {
  const h = wire(on, () => answered('should not be asked'))
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  const notes: string[] = []
  for (let i = 0; i < 40; i++) {
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: id } as never) as { context?: readonly string[] }
    notes.push(...(r.context ?? []))
  }
  expect(h.calls.length).toBe(0)
  expect(notes.some(n => n.includes('Advice from a senior'))).toBe(false)
  expect(notes.some(n => n.includes('stronger model'))).toBe(true)
  expect(h.logs.filter(l => l.includes('consult limit reached')).length).toBe(1)
  expect(await ask($, id)).toContain(REFUSED_TEXT)
})

test('pure: a closed consult skips to the next enabled level, the swap', () => {
  const s = { ...newAgent('a1', 'test', 'haiku', 'fix the build'), score: 10, level: 1, stepsSinceAction: 10, consults: 3 }
  const ob = { tool: 'Bash', ok: false, text: 'Error: boom', summary: 'npm test' }
  expect(observe(s, ob, DEFAULT_CONFIG, true).action).toBe('consult')
  const closed = observe(s, ob, DEFAULT_CONFIG, false)
  expect(closed.action).toBe('swap')
  expect(closed.consultSkipped).toBe(true)
  expect(closed.state.tier).toBe('sonnet')
  expect(observe(s, ob, DEFAULT_CONFIG, true).consultSkipped).toBe(false)
})

test('pure: consultLimit names the first limit reached, and none below them', () => {
  const s = newAgent('a1', 'test', 'haiku', 'fix the build')
  const cfg = { ...DEFAULT_CONFIG, maxConsultsPerAgent: 3, maxConsultsPerSession: 20, consultBudgetUsd: 0.5 }
  expect(consultLimit(s, 0, 0, cfg)).toBe(undefined)
  expect(consultLimit({ ...s, consults: 2 }, 2, 0.49, cfg)).toBe(undefined)
  expect(consultLimit({ ...s, consults: 3 }, 3, 0, cfg)).toBe('per agent (3 consults)')
  expect(consultLimit(s, 20, 0, cfg)).toBe('per session (20 consults)')
  expect(consultLimit(s, 1, 0.5, cfg)).toBe('budget (USD 0.5)')
  expect(consultLimit(s, 1, 99, { ...cfg, consultBudgetUsd: 0 })).toBe(undefined)
})

test('parseConfig: the three consult limits default to 3, 20 and no budget', () => {
  expect(DEFAULT_CONFIG.maxConsultsPerAgent).toBe(3)
  expect(DEFAULT_CONFIG.maxConsultsPerSession).toBe(20)
  expect(DEFAULT_CONFIG.consultBudgetUsd).toBe(0)
  const c = parseConfig({ maxConsultsPerAgent: '1', maxConsultsPerSession: 5, consultBudgetUsd: 2.5 })
  expect(c.maxConsultsPerAgent).toBe(1)
  expect(c.maxConsultsPerSession).toBe(5)
  expect(c.consultBudgetUsd).toBe(2.5)
  expect(parseConfig({ maxConsultsPerAgent: 0 }).maxConsultsPerAgent).toBe(0)
  expect(parseConfig({ maxConsultsPerAgent: 2.7 }).maxConsultsPerAgent).toBe(2)
  const bad = parseConfig({ maxConsultsPerAgent: -1, maxConsultsPerSession: 'many', consultBudgetUsd: -3 })
  expect(bad.maxConsultsPerAgent).toBe(3)
  expect(bad.maxConsultsPerSession).toBe(20)
  expect(bad.consultBudgetUsd).toBe(0)
})

test('a snapshot saved before the consult counts hydrates; a valid count is kept, a malformed one dropped', () => {
  const agent = { id: 'a1', category: 'test', task: 'fix', startTier: 'haiku', tier: 'haiku', score: 0, level: 0,
    stepsSinceAction: 0, errorCounts: {}, editCounts: {}, log: [], tokens: 0 }
  const base = { ledger: {}, seenModels: {}, sessionTag: 'abc123', mode: 'active', baseline: 'opus', baselinePinned: false }
  const old = parseSnapshot({ ...base, agents: [agent] })
  expect(old?.agents.length).toBe(1)
  expect(old?.agents[0]!.consults).toBe(undefined)
  expect(parseSnapshot({ ...base, agents: [{ ...agent, consults: 2 }] })?.agents[0]!.consults).toBe(2)
  expect(parseSnapshot({ ...base, agents: [{ ...agent, consults: -1 }] })?.agents[0]!.consults).toBe(undefined)
  expect(parseSnapshot({ ...base, agents: [{ ...agent, consults: 1.5 }] })?.agents[0]!.consults).toBe(undefined)
  expect(parseSnapshot({ ...base, agents: [{ ...agent, consults: 'x' }] })?.agents[0]!.consults).toBe(undefined)
})
