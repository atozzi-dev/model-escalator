import { expect, mock, test } from 'claude-code/testing'
import { DEFAULT_CONFIG, parseConfig, type Config } from '../hooks/config'
import { afterHelp, escalated, newAgent, noteProgress, observe, raiseEffort, type AgentState } from '../hooks/detector'
import { HELP_TOOL, resetState } from '../hooks/register'
import { parseSnapshot } from '../hooks/state'

type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

type Step = { model: string; effort: unknown; hasEffort: boolean }
type Harness = { steps: Step[]; logs: string[] }

// Fake core under the plugin: every tool call fails, every model request is metered and recorded as sent.
function wire(on: any, env: Record<string, string> = {}): Harness {
  resetState()
  mock.env(on, env)
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', (_$: unknown, e: any) => ({ value: { tool: `mcp__model-escalator__${e.name}` } }) as never)
  const h: Harness = { steps: [], logs: [] }
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a' + ++n }))
  on('tool.call', () => ({ isError: true, result: 'Error: boom', text: 'Error: boom' }) as never)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'advice' } }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    h.steps.push({ model: e.model, effort: e.effort, hasEffort: 'effort' in e && e.effort !== undefined })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
  on('ui.log', (_$: unknown, e: any) => { h.logs.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  for (const k of ['ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return h
}

const kindOf = (note: string): string =>
  note.includes('think harder') ? 'effort' : note.includes('stronger model') ? 'swap' : note.includes('Stop now') ? 'human'
    : note.includes('not making progress') ? 'nudge' : 'consult'

const spawn = async ($: any, model: string): Promise<string> =>
  ((await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model } as never)) as { agentId: string }).agentId

// One model request of the agent, as the engine would send it: its own model and, when given, its own effort.
async function step($: any, id: string, model: string, effort: string | undefined): Promise<void> {
  await drain($.turn.step({ turnId: 't', index: 0, model, messageCount: 3, agentId: id, ...(effort === undefined ? {} : { effort }) } as never) as never)
}

type Climb = { kinds: string[]; notes: string[]; after: Record<string, Step[]> }

// A stuck agent: a model request before every tool call, so the mod always knows the request's effort.
// `after[kind]` holds the request sent right after each note of that kind.
async function climb($: any, h: Harness, id: string, model: string, effort: string | undefined, calls = 80): Promise<Climb> {
  const out: Climb = { kinds: [], notes: [], after: {} }
  let pending: string[] = []
  // The human level ends the ladder: ten more calls show that nothing follows it, then the climb stops.
  let afterHuman = 0
  for (let i = 0; i < calls && afterHuman < 10; i++) {
    if (out.kinds.includes('human')) afterHuman++
    await step($, id, model, effort)
    for (const k of pending) (out.after[k] ??= []).push(h.steps.at(-1)!)
    pending = []
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: id } as never) as { context?: readonly string[] }
    for (const c of r.context ?? []) {
      out.notes.push(c)
      out.kinds.push(kindOf(c))
      pending.push(kindOf(c))
    }
  }
  return out
}

const report = async ($: any, args = ''): Promise<string> =>
  ((await $.command.run({ command: 'escalator', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)) as { text: string }).text

const ON = { options: { effortStep: true } }

test('off by default: the ladder is unchanged and no request effort is rewritten', async ($, on) => {
  expect(DEFAULT_CONFIG.effortStep).toBe(false)
  expect(DEFAULT_CONFIG.effortBoost).toBe('high')
  expect(DEFAULT_CONFIG.levels).toEqual(['nudge', 'consult', 'swap', 'human'])
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'haiku')
  const r = await climb($, h, id, 'haiku', 'medium')
  expect(r.kinds).toEqual(['nudge', 'consult', 'swap', 'swap', 'human'])
  expect(h.steps.every((s) => s.effort === 'medium')).toBe(true)
})

test('on: a Haiku agent climbs nudge, consult, effort, swap; the next request carries the raised effort', ON, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'haiku')
  const r = await climb($, h, id, 'haiku', 'medium')
  expect(r.kinds).toEqual(['nudge', 'consult', 'effort', 'swap', 'swap', 'human'])
  const raised = r.notes[2]!
  expect(raised).toMatch(/^\[supervisor:[0-9a-f]{6}\] /)
  expect(raised).toContain('high')
  expect(raised).toContain('Re-assess')
  // Same model, higher effort, until the swap.
  expect(r.after.effort![0]).toEqual({ model: 'haiku', effort: 'high', hasEffort: true })
  expect(h.logs.some((l) => l.includes('raise effort'))).toBe(true)
  expect(await report($)).toContain('effort 1')
})

test('the raised effort is one step above the request, at least effortBoost, never lower', () => {
  expect(raiseEffort('medium', 'high')).toBe('high')
  expect(raiseEffort('low', 'high')).toBe('high')
  expect(raiseEffort('high', 'high')).toBe('xhigh')
  expect(raiseEffort('xhigh', 'high')).toBe('max')
  expect(raiseEffort('low', 'low')).toBe('medium')
  expect(raiseEffort('medium', 'max')).toBe('max')
  expect(raiseEffort('max', 'high')).toBeUndefined()
  expect(raiseEffort(undefined, 'high')).toBeUndefined()
  expect(raiseEffort(null, 'high')).toBeUndefined()
  expect(raiseEffort(12000, 'high')).toBeUndefined()
  expect(raiseEffort('turbo', 'high')).toBeUndefined()
})

test('a request already on high is raised to xhigh', ON, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'sonnet')
  const r = await climb($, h, id, 'sonnet', 'high')
  expect(r.kinds).toEqual(['nudge', 'consult', 'effort', 'swap', 'human'])
  expect(r.after.effort![0]!.effort).toBe('xhigh')
})

test('a model without effort: the level is skipped and no effort is ever sent', ON, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'haiku')
  const r = await climb($, h, id, 'haiku', undefined)
  expect(r.kinds).toEqual(['nudge', 'consult', 'swap', 'swap', 'human'])
  expect(h.steps.some((s) => s.hasEffort)).toBe(false)
})

test('a request already at max: the level is skipped', ON, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'haiku')
  const r = await climb($, h, id, 'haiku', 'max')
  expect(r.kinds).toEqual(['nudge', 'consult', 'swap', 'swap', 'human'])
  expect(h.steps.every((s) => s.effort === 'max')).toBe(true)
})

test('after a swap the boost is dropped: the new model gets the request\'s own effort', ON, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'haiku')
  const r = await climb($, h, id, 'haiku', 'medium')
  expect(r.after.swap![0]).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium', hasEffort: true })
  expect(r.after.swap![1]).toEqual({ model: 'claude-opus-5-5', effort: 'medium', hasEffort: true })
  expect(h.steps.at(-1)!.effort).toBe('medium')
})

test('an Opus agent gets effort as its only extra lever before a human', ON, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'opus')
  const r = await climb($, h, id, 'opus', 'medium')
  expect(r.kinds).toEqual(['nudge', 'consult', 'effort', 'human'])
  expect(r.after.effort![0]).toEqual({ model: 'opus', effort: 'high', hasEffort: true })
})

test('help then stuck: the effort step comes next', ON, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'haiku')
  await step($, id, 'haiku', 'medium')
  const help = await $.tool.call({ tool: HELP_TOOL, problem: 'the migration hangs', agentId: id } as never) as { result?: unknown }
  expect(String(help.result)).toContain('advice')
  const r = await climb($, h, id, 'haiku', 'medium')
  expect(r.kinds).toEqual(['effort', 'swap', 'swap', 'human'])
})

test('a consult closed by a limit goes on to the effort step', { options: { effortStep: true, maxConsultsPerAgent: 0 } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'haiku')
  const r = await climb($, h, id, 'haiku', 'medium')
  expect(r.kinds).toEqual(['nudge', 'effort', 'swap', 'swap', 'human'])
})

test('the boost lasts for the run and later runs; the next climb is not raised again but swaps', ON, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'haiku')
  const first = await climb($, h, id, 'haiku', 'medium', 12)
  expect(first.kinds).toEqual(['nudge', 'consult', 'effort'])
  await $.turn.complete({ turnId: 't', agentId: id, answer: 'done' } as never)
  await step($, id, 'haiku', 'medium')
  expect(h.steps.at(-1)!.effort).toBe('high')
  const second = await climb($, h, id, 'haiku', 'medium')
  expect(second.kinds).toEqual(['nudge', 'consult', 'swap', 'swap', 'human'])
})

test('a run that only raised the effort is not recorded as escalated', ON, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'haiku')
  const r = await climb($, h, id, 'haiku', 'medium', 12)
  expect(r.kinds).toEqual(['nudge', 'consult', 'effort'])
  await $.turn.complete({ turnId: 't', agentId: id, answer: 'done' } as never)
  const text = await report($, 'stats')
  expect(text).toContain('haiku: 1 run, 0 escalated')
})

test('observe: logs that it would raise the effort, counts it, never changes a request', { options: { effortStep: true } }, async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'observe' })
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'haiku')
  const r = await climb($, h, id, 'haiku', 'medium', 30)
  expect(r.notes).toEqual([])
  expect(h.logs.some((l) => l.includes('would raise effort'))).toBe(true)
  expect(h.steps.every((s) => s.effort === 'medium' && s.model === 'haiku')).toBe(true)
  expect(await report($)).toContain('effort 1')
})

test('baseline never rewrites the effort', ON, async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'baseline' })
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'haiku')
  await climb($, h, id, 'opus', 'medium', 20)
  expect(h.steps.every((s) => s.effort === 'medium')).toBe(true)
})

// Pure ladder, driven directly; the agent's last request carried `effort`.
function drive(cfg: Config, start: AgentState, calls = 80) {
  let s = start
  const out: string[] = []
  for (let i = 0; i < calls; i++) {
    const r = observe(s, { tool: 'Bash', ok: false, text: 'Error: boom', summary: 'npm test' }, cfg)
    s = r.state
    if (r.action) out.push(r.action)
  }
  return { out, s }
}

const seen = (model: string, effort: AgentState['effortSeen'] = 'medium'): AgentState => ({ ...newAgent('x', 'c', model, 't'), effortSeen: effort })

test('pure ladder: effort sits between consult and swap, and alone is no escalation', () => {
  const cfg = parseConfig({ effortStep: true })
  const r = drive(cfg, seen('claude-haiku-5-5'))
  expect(r.out).toEqual(['nudge', 'consult', 'effort', 'swap', 'swap', 'human'])
  const upToEffort = drive(cfg, seen('claude-haiku-5-5'), 12)
  expect(upToEffort.out).toEqual(['nudge', 'consult', 'effort'])
  expect(upToEffort.s.effortBoosted).toBe(true)
  expect(escalated(upToEffort.s, cfg.levels)).toBe(false)
  expect(escalated(r.s, cfg.levels)).toBe(true)
  // Without swap the end of the ladder counts, but a trailing effort level is not that end.
  const noSwap = parseConfig({ effortStep: true, levels: 'nudge,consult,human' })
  expect(noSwap.levels).toEqual(['nudge', 'consult', 'effort', 'human'])
  expect(escalated({ ...upToEffort.s, level: 3 }, noSwap.levels)).toBe(false)
  expect(escalated({ ...upToEffort.s, level: 4 }, noSwap.levels)).toBe(true)
  expect(escalated({ ...upToEffort.s, level: 2 }, ['nudge', 'consult', 'effort'])).toBe(true)
  expect(escalated({ ...upToEffort.s, level: 1 }, ['nudge', 'consult', 'effort'])).toBe(false)
  // An unknown effort (no request seen yet) cannot be raised either.
  expect(drive(cfg, newAgent('x', 'c', 'claude-haiku-5-5', 't')).out).toEqual(['nudge', 'consult', 'swap', 'swap', 'human'])
})

test('pure ladder: a swap drops the boost; help moves to effort; de-escalation never retries it', () => {
  const cfg = parseConfig({ effortStep: true, deescalateAfter: 1 })
  const swapped = drive(cfg, seen('claude-haiku-5-5'), 16)
  expect(swapped.out).toEqual(['nudge', 'consult', 'effort', 'swap'])
  expect(swapped.s.effortBoosted).toBeFalsy()
  expect(drive(cfg, afterHelp(seen('claude-haiku-5-5'), cfg)).out).toEqual(['effort', 'swap', 'swap', 'human'])
  const back = noteProgress(swapped.s, cfg)
  expect(back.tier).toBe('haiku')
  expect(drive(cfg, back.state).out[0]).toBe('swap')
})

test('options: effortStep inserts the level, effortBoost is validated, levels cannot add it alone', () => {
  expect(parseConfig({ effortStep: true }).levels).toEqual(['nudge', 'consult', 'effort', 'swap', 'human'])
  expect(parseConfig({ effortStep: 'true', levels: 'swap,nudge' }).levels).toEqual(['nudge', 'effort', 'swap'])
  expect(parseConfig({ effortStep: 'false' }).levels).toEqual(['nudge', 'consult', 'swap', 'human'])
  expect(parseConfig({ levels: 'nudge,effort,swap' }).levels).toEqual(['nudge', 'swap'])
  expect(parseConfig({ effortStep: 'yes' }).effortStep).toBe(false)
  expect(parseConfig({ effortBoost: ' XHigh ' }).effortBoost).toBe('xhigh')
  expect(parseConfig({ effortBoost: 'low' }).effortBoost).toBe('low')
  for (const bad of ['turbo', '', 3, undefined]) expect(parseConfig({ effortBoost: bad }).effortBoost).toBe('high')
})

test('an old snapshot hydrates; malformed effort fields are dropped, valid ones kept', () => {
  const base = { ledger: {}, seenModels: {}, sessionTag: 't', mode: 'active', baseline: 'opus', baselinePinned: false }
  const old = parseSnapshot({ ...base, agents: [{ id: 'a', tier: 'haiku', startTier: 'haiku' }] })!
  expect(old.agents[0]!.effortBoosted).toBeUndefined()
  expect(old.agents[0]!.effortSeen).toBeUndefined()
  const bad = parseSnapshot({ ...base, agents: [{ id: 'a', effortBoosted: 'yes', effortSeen: 'turbo' }, { id: 'b', effortSeen: Number.NaN }] })!
  expect(bad.agents[0]!.effortBoosted).toBeUndefined()
  expect(bad.agents[0]!.effortSeen).toBeUndefined()
  expect(bad.agents[1]!.effortSeen).toBeUndefined()
  const ok = parseSnapshot({ ...base, agents: [{ id: 'a', effortBoosted: true, effortSeen: 'medium' }, { id: 'b', effortSeen: null }, { id: 'c', effortSeen: 8000 }] })!
  expect(ok.agents[0]!.effortBoosted).toBe(true)
  expect(ok.agents[0]!.effortSeen).toBe('medium')
  expect(ok.agents[1]!.effortSeen).toBeNull()
  expect(ok.agents[2]!.effortSeen).toBe(8000)
})
