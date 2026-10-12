import { expect, mock, test } from 'claude-code/testing'
import { parseConfig } from '../hooks/config'
import { categorize } from '../hooks/learning'
import { resetState } from '../hooks/register'

const CAT = categorize('general-purpose', 'fix db test')
const NOW = 1_000_000_000_000

// haiku failed 3 of 5 runs: learning raises haiku to sonnet.
const STATS = { [CAT]: { haiku: { runs: 5, escalated: 3, tokens: 0, notAccepted: 3 } } }

type H = { spawned: (string | undefined)[]; logs: string[]; stepModels: string[] }

function wire(on: any, env: Record<string, string> = {}): H {
  resetState()
  mock.clock(on, { now: NOW })
  mock.env(on, env)
  const data: Record<string, unknown> = { stats: STATS }
  const h: H = { spawned: [], logs: [], stepModels: [] }
  on('store.get', (_$: unknown, e: any) => ({ value: data[e.key] }))
  on('store.set', (_$: unknown, e: any) => { data[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: unknown, e: any) => { delete data[e.key]; return { value: undefined } })
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => { h.spawned.push(e.model); return { model: e.model ?? 'opus', agentId: 'a' + ++n } })
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('tool.call', () => ({ isError: true, result: 'Error: boom', text: 'Error: boom' }) as never)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'advice' } }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    h.stepModels.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20000, cache_creation_input_tokens: 1000 } } as never
  })
  on('ui.log', (_$: unknown, e: any) => { h.logs.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  for (const k of ['ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return h
}

const spawn = ($: any, model?: string) =>
  $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', parentModel: 'haiku', ...(model ? { model } : {}) } as never)

test('config: respectExplicitModel defaults to false, invalid values fall back', () => {
  expect(parseConfig({}).respectExplicitModel).toBe(false)
  expect(parseConfig({ respectExplicitModel: true }).respectExplicitModel).toBe(true)
  expect(parseConfig({ respectExplicitModel: 'x' }).respectExplicitModel).toBe(false)
})

test('an explicit haiku spawn stays haiku and the log says what learning suggested', { options: { respectExplicitModel: true } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'haiku')
  expect(h.spawned).toEqual(['haiku'])
  expect(h.logs.some((l) => l.includes('kept the requested haiku (explicit), learning suggested sonnet'))).toBe(true)
  expect(h.logs.some((l) => l.includes('haiku -> sonnet'))).toBe(false)
})

test('an implicit spawn (no model given) is still raised by learning', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await spawn($)
  expect(h.spawned).toEqual(['sonnet'])
  expect(h.logs.some((l) => l.includes('kept the requested'))).toBe(false)
})

test('by default an explicit haiku is raised by learning like any other', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'haiku')
  expect(h.spawned).toEqual(['sonnet'])
  expect(h.logs.some((l) => l.includes('kept the requested'))).toBe(false)
})

test('respectExplicitModel false restores learning over an explicit choice', { options: { respectExplicitModel: false } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'haiku')
  expect(h.spawned).toEqual(['sonnet'])
  expect(h.logs.some((l) => l.includes('kept the requested'))).toBe(false)
})

test('an explicit choice is not explored away: no draw, no log, the model asked for is kept', { options: { respectExplicitModel: true, explore: 1 } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  for (let i = 0; i < 40; i++) await spawn($, 'haiku')
  expect(h.spawned.every((m) => m === 'haiku')).toBe(true)
  expect(h.logs.some((l) => l.includes('exploring'))).toBe(false)
})

test('an explicit sonnet is never lowered by exploration either', { options: { respectExplicitModel: true, explore: 1 } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  for (let i = 0; i < 40; i++) await spawn($, 'sonnet')
  expect(h.spawned.every((m) => m === 'sonnet')).toBe(true)
})

test('baseline mode still overrides an explicit model', { options: { respectExplicitModel: true } }, async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'baseline', MODEL_ESCALATOR_BASELINE: 'opus' })
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'haiku')
  expect(h.spawned).toEqual(['opus'])
})

test('the ladder still swaps an explicit haiku agent when it is stuck', { options: { respectExplicitModel: true } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const r = await spawn($, 'haiku') as { agentId: string }
  expect(h.spawned).toEqual(['haiku'])
  for (let i = 0; i < 12; i++) await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: r.agentId } as never)
  const st = $.turn.step({ turnId: 't', index: 0, model: 'haiku', messageCount: 3, agentId: r.agentId } as never) as { result: Promise<unknown> } & AsyncIterable<unknown>
  for await (const _ of st) { /* chunks */ }
  await st.result
  expect(h.stepModels.at(-1)).toContain('sonnet')
})
