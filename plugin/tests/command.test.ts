import { expect, mock, test } from 'claude-code/testing'
import { resetState } from '../hooks/register'
import { emptyLedger } from '../hooks/savings'

const DAY = Date.parse('2026-10-09T09:30:00Z')

function wire(on: any, data: Record<string, unknown> = {}, env: Record<string, string> = {}): Record<string, unknown> {
  resetState()
  mock.env(on, env)
  on('store.get', (_$: unknown, e: any) => ({ value: data[e.key] }))
  on('store.set', (_$: unknown, e: any) => { data[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: unknown, e: any) => { delete data[e.key]; return { value: undefined } })
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  for (const k of ['ui.log', 'ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return data
}

const run = async ($: any, args: string): Promise<string> =>
  ((await $.command.run({ command: 'escalator', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)) as { text: string }).text

const SUBCOMMANDS = ['report', 'stats', 'reset', 'reset history', 'config', 'resume', 'history', 'map', 'help']

function session(i: number) {
  const ledger = { ...emptyLedger(), actual: 1 + i, baselineHigh: 3 + i, baselineLow: 2 + i, agentSteps: 4, interventions: { nudge: 2, swap: 1 } }
  return { at: DAY + i * 60_000, mode: i % 2 ? 'observe' : 'active', baseline: 'opus', ledger }
}

test('help lists every subcommand', async ($, on) => {
  wire(on)
  const text = await run($, 'help')
  for (const s of SUBCOMMANDS) expect(text).toContain('/escalator ' + s)
})

test('an unknown subcommand shows the help', async ($, on) => {
  wire(on)
  const text = await run($, 'frobnicate')
  expect(text).toContain('Unknown subcommand')
  expect(text).toContain('/escalator history')
})

test('report stays the default', async ($, on) => {
  wire(on)
  expect(await run($, '')).toContain('Session cost')
  expect(await run($, 'report')).toContain('Session cost')
})

test('config shows the defaults and where to change them', async ($, on) => {
  wire(on)
  const text = await run($, 'config')
  expect(text).toContain('Mode: active')
  expect(text).toContain('graceSteps: 4')
  expect(text).toContain('seniorModel: opus')
  expect(text).toContain('/config')
  expect(text).toContain('pluginConfigs')
  expect(text).not.toContain('(changed')
})

test('config marks an option that differs from the default', { options: { graceSteps: 7, pauseAtHuman: false } }, async ($, on) => {
  wire(on)
  const text = await run($, 'config')
  expect(text).toContain('graceSteps: 7 (changed, default 4)')
  expect(text).toContain('pauseAtHuman: false (changed, default true)')
  expect(text).toContain('stallMinutes: 10')
  expect(text).not.toContain('stallMinutes: 10 (changed')
})

test('config shows the environment mode and the EVAL_ fallback source', async ($, on) => {
  wire(on, {}, { EVAL_MODEL_ESCALATOR_MODE: 'observe', MODEL_ESCALATOR_BASELINE: 'sonnet' })
  await $.session.start({ cwd: '/work' } as never)
  const text = await run($, 'config')
  expect(text).toContain('Mode: observe (from EVAL_MODEL_ESCALATOR_MODE)')
  expect(text).toContain('Baseline: sonnet (from MODEL_ESCALATOR_BASELINE)')
})

test('history with no sessions says so', async ($, on) => {
  wire(on)
  expect(await run($, 'history')).toContain('No sessions recorded yet')
})

test('history lists the last sessions, newest first, default 10', async ($, on) => {
  wire(on, { sessions: [0, 1, 2].map(session) })
  const text = await run($, 'history')
  const lines = text.split('\n').filter((l) => l.startsWith('- '))
  expect(lines.length).toBe(3)
  expect(lines[0]).toContain('2026-10-09 09:32')
  expect(lines[0]).toContain('active')
  expect(lines[0]).toContain('baseline opus')
  expect(lines[0]).toContain('spent $3.00')
  expect(lines[0]).toContain('saved ~$')
  expect(lines[0]).toContain('interventions 3')
  expect(lines[2]).toContain('2026-10-09 09:30')
})

test('history is capped: default 10, explicit n, at most 50', async ($, on) => {
  wire(on, { sessions: Array.from({ length: 60 }, (_, i) => session(i)) })
  const count = async (args: string) => (await run($, args)).split('\n').filter((l) => l.startsWith('- ')).length
  expect(await count('history')).toBe(10)
  expect(await count('history 3')).toBe(3)
  expect(await count('history 500')).toBe(50)
  expect(await count('history nonsense')).toBe(10)
})

test('history ignores malformed entries', async ($, on) => {
  wire(on, { sessions: [session(0), null, 'x', { at: 'no' }, session(1)] })
  expect((await run($, 'history')).split('\n').filter((l) => l.startsWith('- ')).length).toBe(2)
})

test('reset clears the learned stats but keeps the history and the category cache', async ($, on) => {
  const data = wire(on, { stats: { x: 1 }, projects: { p: {} }, sessions: [session(0)], categories: { a: 'b' } })
  const text = await run($, 'reset')
  expect(text).toContain('Learned stats cleared')
  expect(data['stats']).toBe(undefined)
  expect(data['projects']).toBe(undefined)
  expect(data['sessions']).toBeDefined()
  expect(data['categories']).toBeDefined()
})

test('reset history clears only the history', async ($, on) => {
  const data = wire(on, { stats: { x: 1 }, projects: { p: {} }, sessions: [session(0)], categories: { a: 'b' } })
  const text = await run($, 'reset history')
  expect(text).toContain('Session history cleared')
  expect(data['sessions']).toBe(undefined)
  expect(data['stats']).toBeDefined()
  expect(data['projects']).toBeDefined()
  expect(data['categories']).toBeDefined()
})
