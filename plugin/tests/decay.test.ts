import { expect, mock, test } from 'claude-code/testing'
import { categorize } from '../hooks/learning'
import { resetState } from '../hooks/register'

const CAT = categorize('general-purpose', 'fix db test')

const DAY = 24 * 60 * 60 * 1000
const T0 = 1_000_000_000_000


// Fake core with a mocked clock; a category with bad evidence recorded at `updatedAt`.
async function wire(on: any, $: any, updatedAt: number) {
  resetState()
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, {})
  const data: Record<string, unknown> = { stats: { [CAT]: { haiku: { runs: 8, escalated: 6, tokens: 0, notAccepted: 6, updatedAt } } } }
  on('store.get', (_$: unknown, e: any) => ({ value: data[e.key] }))
  on('store.set', (_$: unknown, e: any) => { data[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: unknown, e: any) => { delete data[e.key]; return { value: undefined } })
  const spawned: string[] = []
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('agent.spawn', (_$: unknown, e: any) => { spawned.push(e.model); return { model: e.model ?? 'haiku', agentId: 'a1' } })
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
  for (const k of ['ui.log', 'ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/work' } as never)
  return { clock, spawned, data }
}

const spawn = ($: any) => $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model: 'haiku' } as never)

test('recent bad evidence still forces a stronger model at spawn', { options: { respectExplicitModel: false } }, async ($, on) => {
  const w = await wire(on, $, T0 - 1 * DAY)
  await spawn($)
  expect(w.spawned[0]).not.toBe('haiku')
})

test('evidence recorded long ago no longer forces a stronger model', async ($, on) => {
  const w = await wire(on, $, T0 - 120 * DAY)
  await spawn($)
  expect(w.spawned[0]).toBe('haiku')
})

test('learningHalfLifeDays: 0 keeps old evidence', { options: { respectExplicitModel: false, learningHalfLifeDays: 0 } }, async ($, on) => {
  const w = await wire(on, $, T0 - 120 * DAY)
  await spawn($)
  expect(w.spawned[0]).not.toBe('haiku')
})

test('a short half-life makes recent-ish evidence fade', { options: { learningHalfLifeDays: 1 } }, async ($, on) => {
  const w = await wire(on, $, T0 - 10 * DAY)
  await spawn($)
  expect(w.spawned[0]).toBe('haiku')
})

test('a completed run decays the stored cell and stamps it with the clock', async ($, on) => {
  const w = await wire(on, $, T0 - 30 * DAY)
  const { agentId } = await spawn($) as { agentId: string }
  await $.turn.complete({ turnId: 't', agentId, answer: 'done' } as never)
  const stats = w.data['stats'] as Record<string, Record<string, { runs: number; updatedAt?: number }>>
  const cell = stats[CAT]!['haiku']!
  expect(cell.updatedAt).toBe(T0)
  expect(Math.abs(cell.runs - 5)).toBeLessThan(1e-6) // 8 runs halved once, plus this one
})

test('/escalator stats lists the cells readably with their age', async ($, on) => {
  await wire(on, $, T0 - 3 * DAY)
  const text = ((await $.command.run({ command: 'escalator', args: 'stats', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)) as { text: string }).text
  expect(text).toContain('haiku: 8 runs, 6 escalated')
  expect(text).toContain('(updated 3 d ago)')
})
