import { expect, mock, test } from 'claude-code/testing'
import { parseConfig } from '../hooks/config'
import { categorize } from '../hooks/learning'
import { resetState } from '../hooks/register'

const CAT = categorize('general-purpose', 'fix db test')

// Scarce evidence: haiku failed 3 of 5 runs, so learning raises haiku to sonnet, but the posterior is wide: the
// chance that haiku is good enough is about one in four. The session's draws come from a PRNG seeded by its random
// tag, which a test cannot fix, so tests repeat the spawn: with N spawns the odds of seeing no exploration at all
// (or only exploration) are below 1e-6.
const STATS = { [CAT]: { haiku: { runs: 5, escalated: 3, tokens: 0, notAccepted: 3 } } }
const N = 80

let nextId = 0

async function wire(on: any, $: any, env: Record<string, string> = {}) {
  resetState()
  mock.clock(on, { now: 1_000_000_000_000 })
  mock.env(on, env)
  const data: Record<string, unknown> = { stats: STATS }
  on('store.get', (_$: unknown, e: any) => ({ value: data[e.key] }))
  on('store.set', (_$: unknown, e: any) => { data[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: unknown, e: any) => { delete data[e.key]; return { value: undefined } })
  const spawned: string[] = []
  const logs: string[] = []
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('agent.spawn', (_$: unknown, e: any) => { spawned.push(e.model); return { model: e.model ?? 'haiku', agentId: 'x' + ++nextId } })
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('ui.log', (_$: unknown, e: any) => { logs.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  for (const k of ['ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/work' } as never)
  return { spawned, logs, data }
}

async function spawnMany($: any, n: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const r = await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model: 'haiku' } as never) as { agentId: string }
    ids.push(r.agentId)
  }
  return ids
}

test('off by default: the option is 0 and invalid values fall back to it', () => {
  expect(parseConfig({}).explore).toBe(0)
  expect(parseConfig({ explore: 2 }).explore).toBe(0)
  expect(parseConfig({ explore: -1 }).explore).toBe(0)
  expect(parseConfig({ explore: 'x' }).explore).toBe(0)
  expect(parseConfig({ explore: 0.25 }).explore).toBe(0.25)
})

test('without the option learning alone decides: every spawn goes to sonnet', { options: { respectExplicitModel: false } }, async ($, on) => {
  const w = await wire(on, $)
  await spawnMany($, N)
  expect(w.spawned.every((m) => m === 'sonnet')).toBe(true)
  expect(w.logs.some((l) => l.includes('explor'))).toBe(false)
})

test('explore 1: some spawns go back to haiku with a log line, the others stay on sonnet', { options: { respectExplicitModel: false, explore: 1 } }, async ($, on) => {
  const w = await wire(on, $)
  await spawnMany($, N)
  const haiku = w.spawned.filter((m) => m === 'haiku').length
  expect(haiku).toBeGreaterThan(0)
  expect(haiku).toBeLessThan(N)
  expect(w.spawned.every((m) => m === 'haiku' || m === 'sonnet')).toBe(true)
  const lines = w.logs.filter((l) => l.includes('exploring haiku for ' + CAT + ' (learned sonnet)'))
  expect(lines.length).toBe(haiku)
})

test('observe: only logs that it would explore, the spawn keeps the requested model', { options: { respectExplicitModel: false, explore: 1 } }, async ($, on) => {
  const w = await wire(on, $, { MODEL_ESCALATOR_MODE: 'observe' })
  await spawnMany($, N)
  expect(w.spawned.every((m) => m === 'haiku')).toBe(true)
  expect(w.logs.some((l) => l.includes('would explore haiku for ' + CAT + ' (learned sonnet)'))).toBe(true)
  expect(w.logs.some((l) => l.includes('exploring'))).toBe(false)
})

test('baseline never explores', { options: { explore: 1 } }, async ($, on) => {
  const w = await wire(on, $, { MODEL_ESCALATOR_MODE: 'baseline', MODEL_ESCALATOR_BASELINE: 'opus' })
  await spawnMany($, N)
  expect(w.spawned.every((m) => m === 'opus')).toBe(true)
  expect(w.logs.some((l) => l.includes('explor'))).toBe(false)
})

test('off never explores', { options: { explore: 1 } }, async ($, on) => {
  const w = await wire(on, $, { MODEL_ESCALATOR_MODE: 'off' })
  await spawnMany($, N)
  expect(w.spawned.every((m) => m === 'haiku')).toBe(true)
  expect(w.logs.length).toBe(0)
})

test('each run is recorded under the tier it ran on', { options: { respectExplicitModel: false, explore: 1 } }, async ($, on) => {
  const w = await wire(on, $)
  const ids = await spawnMany($, N)
  for (const [i, id] of ids.entries()) await $.turn.complete({ turnId: 'r' + i, agentId: id, answer: 'x' } as never)
  const cells = (w.data.stats as any)[CAT]
  const haiku = w.spawned.filter((m) => m === 'haiku').length
  expect(haiku).toBeGreaterThan(0)
  expect(cells.haiku.runs).toBe(5 + haiku)
  expect(cells.sonnet.runs).toBe(N - haiku)
})
