import { expect, mock, test } from 'claude-code/testing'
import { resetState } from '../hooks/register'

type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

type Harness = { stepModels: string[]; spawnModels: (string | undefined)[]; consults: number; logs: string[] }

// Wires the fake core under the plugin: spawn, failing tool, senior model, metered steps.
function wire(on: any, env: Record<string, string>): Harness {
  resetState()
  mock.env(on, env)
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  const h: Harness = { stepModels: [], spawnModels: [], consults: 0, logs: [] }
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => { h.spawnModels.push(e.model); return { model: e.model ?? 'haiku', agentId: 'a' + ++n } })
  on('tool.call', () => ({ isError: true, result: 'Error: boom', text: 'Error: boom' }) as never)
  on('model.complete', () => { h.consults++; return { value: { isAnswered: true, text: 'advice' } } as never })
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    h.stepModels.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20000, cache_creation_input_tokens: 1000 } } as never
  })
  on('ui.log', (_$: unknown, e: any) => { h.logs.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  for (const k of ['ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return h
}

async function spawn($: any, model = 'haiku', description = 'fix db test'): Promise<string> {
  const r = await $.agent.spawn({ prompt: 'p', description, subagentType: 'general-purpose', model } as never) as { agentId: string }
  return r.agentId
}

async function stuck($: any, agentId: string, calls = 12): Promise<string[]> {
  const notes: string[] = []
  for (let i = 0; i < calls; i++) {
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test', agentId } as never) as { context?: readonly string[] }
    for (const c of r.context ?? []) notes.push(c)
  }
  return notes
}

const escalator = async ($: any, args = 'report') =>
  (await $.command.run({ command: 'escalator', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never) as { text: string }).text

test('observe: no notes, no swap, but interventions are counted and visible', async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'observe' })
  await $.session.start({ cwd: '/work' } as never)

  const id = await spawn($)
  expect(h.spawnModels[0]).toBe('haiku')
  const notes = await stuck($, id)
  expect(notes.length).toBe(0)
  expect(h.consults).toBe(0)

  await drain($.turn.step({ turnId: 't', index: 0, model: 'haiku', messageCount: 3, agentId: id } as never) as never)
  expect(h.stepModels.at(-1)).toBe('haiku')

  const out = await escalator($)
  expect(out).toContain('Mode: observe')
  expect(out).toMatch(/Interventions: .*nudge 1/)
  expect(out).toContain('consult 1')
  expect(out).toContain('swap 1')
  expect(h.logs.some(l => l.includes('would nudge'))).toBe(true)
})

test('observe: learning never rewrites the spawn model', async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'observe' })
  await $.session.start({ cwd: '/work' } as never)
  // The same kind of task escalates repeatedly while in observe mode...
  for (let run = 0; run < 5; run++) {
    const id = await spawn($, 'haiku', 'fix login bug')
    await stuck($, id)
    await $.turn.complete({ turnId: 'r' + run, agentId: id, answer: 'x' } as never)
  }
  // ...and the next spawn still keeps the requested model.
  await spawn($, 'haiku', 'fix signup bug')
  expect(h.spawnModels.at(-1)).toBe('haiku')
})

test('baseline: spawns forced to the baseline model, no interventions, no stats', async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'baseline', MODEL_ESCALATOR_BASELINE: 'sonnet' })
  await $.session.start({ cwd: '/work' } as never)

  const id = await spawn($, 'haiku')
  expect(h.spawnModels[0]).toBe('sonnet')
  const notes = await stuck($, id)
  expect(notes.length).toBe(0)
  expect(h.consults).toBe(0)

  await drain($.turn.step({ turnId: 't', index: 0, model: 'sonnet', messageCount: 3, agentId: id } as never) as never)
  expect(h.stepModels.at(-1)).toBe('sonnet')

  await $.turn.complete({ turnId: 'r', agentId: id, answer: 'x' } as never)
  expect(await escalator($, 'stats')).not.toContain('"general')
  expect(await escalator($, 'stats')).not.toContain('startTier')
  const out = await escalator($)
  expect(out).toContain('Interventions: none')
})

test('baseline: MODEL_ESCALATOR_BASELINE wins over the lead model', async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'baseline', MODEL_ESCALATOR_BASELINE: 'opus' })
  await $.session.start({ cwd: '/work' } as never)

  // Lead requests run on sonnet; they must not redefine the reference model.
  await drain($.turn.step({ turnId: 'm', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 } as never) as never)
  await spawn($, 'haiku')
  expect(h.spawnModels[0]).toBe('opus')
  expect(await escalator($)).toContain('Same work all on opus')
})

test('baseline without env: falls back to the lead model', async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'baseline' })
  await $.session.start({ cwd: '/work' } as never)
  await drain($.turn.step({ turnId: 'm', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 } as never) as never)
  await spawn($, 'haiku')
  expect(h.spawnModels[0]).toBe('sonnet')
  expect(await escalator($)).toContain('Same work all on sonnet')
})

test('off: everything passes through untouched', async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'off', MODEL_ESCALATOR_BASELINE: 'opus' })
  await $.session.start({ cwd: '/work' } as never)

  const id = await spawn($, 'haiku')
  expect(h.spawnModels[0]).toBe('haiku')
  const notes = await stuck($, id)
  expect(notes.length).toBe(0)
  expect(h.consults).toBe(0)

  await drain($.turn.step({ turnId: 't', index: 0, model: 'haiku', messageCount: 3, agentId: id } as never) as never)
  expect(h.stepModels.at(-1)).toBe('haiku')
  await $.turn.complete({ turnId: 'r', agentId: id, answer: 'x' } as never)

  const out = await escalator($)
  expect(out).toContain('Mode: off')
  expect(out).toContain('Session cost: $0.00')
  expect(out).toContain('Interventions: none')
  expect(await escalator($, 'stats')).not.toContain('startTier')
})
