import { expect, mock, test } from 'claude-code/testing'
import { resetState } from '../hooks/register'
import { emptyLedger } from '../hooks/savings'
import { projectKey } from '../hooks/learning'

const DAY = Date.parse('2026-10-09T09:30:00Z')

function wire(on: any, data: Record<string, unknown> = {}): Record<string, unknown> {
  resetState()
  mock.env(on, {})
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

const stats = { 'general-purpose:bugfix': { haiku: { runs: 10, escalated: 4 } } }
const projectStats = { 'general-purpose:docs': { sonnet: { runs: 3, escalated: 1 } } }
const sessions = [{ at: DAY, mode: 'active', baseline: 'opus', ledger: { ...emptyLedger(), actual: 1, baselineHigh: 3, baselineLow: 2, agentSteps: 4 } }]

const full = (): Record<string, unknown> => ({
  stats, sessions, projects: { [projectKey('/work')]: { stats: projectStats, seenAt: DAY } },
})

const csvBody = (text: string): string => {
  const m = /^```csv\n([\s\S]*)\n```$/.exec(text)
  expect(m).not.toBe(null)
  return m?.[1] ?? ''
}

test('export defaults to the session table', async ($, on) => {
  wire(on, full())
  await $.session.start({ cwd: '/work' } as never)
  const body = csvBody(await run($, 'export'))
  expect(body).toContain('(total)')
  expect(body).not.toContain('# ')
})

test('export session is the same as the default', async ($, on) => {
  wire(on, full())
  await $.session.start({ cwd: '/work' } as never)
  expect(await run($, 'export session')).toBe(await run($, 'export'))
})

test('export learned lists global and project rows', async ($, on) => {
  wire(on, full())
  await $.session.start({ cwd: '/work' } as never)
  const body = csvBody(await run($, 'export learned'))
  expect(body).toContain('global,general-purpose:bugfix,haiku')
  expect(body).toContain('project,general-purpose:docs,sonnet')
})

test('export history lists the stored sessions', async ($, on) => {
  wire(on, full())
  await $.session.start({ cwd: '/work' } as never)
  const body = csvBody(await run($, 'export history'))
  expect(body).toContain('2026-10-09T09:30:00.000Z,active,opus')
})

test('export all has the three tables', async ($, on) => {
  wire(on, full())
  await $.session.start({ cwd: '/work' } as never)
  const body = csvBody(await run($, 'export all'))
  expect(body).toContain('# session')
  expect(body).toContain('# learned')
  expect(body).toContain('# history')
})

test('export with an unknown kind shows the usage', async ($, on) => {
  wire(on, full())
  const text = await run($, 'export bogus')
  expect(text).toContain('/escalator export [session|learned|history|all]')
  expect(text).not.toContain('```')
})

test('export with empty stores gives header-only tables', async ($, on) => {
  wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  expect(csvBody(await run($, 'export learned')).split('\n').length).toBe(1)
  expect(csvBody(await run($, 'export history')).split('\n').length).toBe(1)
})

test('export survives malformed stored data', async ($, on) => {
  wire(on, { stats: 'x', projects: 5, sessions: { a: 1 } })
  await $.session.start({ cwd: '/work' } as never)
  expect(csvBody(await run($, 'export all'))).toContain('# history')
})
