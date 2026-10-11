import { expect, mock, test } from 'claude-code/testing'
import { categorize, projectKey, type Cell, type Stats } from '../hooks/learning'
import { resetState } from '../hooks/register'

const CAT = categorize('general-purpose', 'fix db test')
const NOW = 1_000_000_000_000

type H = { data: Record<string, unknown>; spawned: string[]; setCwd: (cwd: string) => void }

function wire(on: any, preload: Record<string, unknown> = {}): H {
  resetState()
  mock.clock(on, { now: NOW })
  mock.env(on, {})
  const h: H = { data: { ...preload }, spawned: [], setCwd: () => undefined }
  let cwd = '/secret/place/a'
  h.setCwd = (c) => { cwd = c }
  on('store.get', (_$: unknown, e: any) => ({ value: h.data[e.key] }))
  on('store.set', (_$: unknown, e: any) => { h.data[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: unknown, e: any) => { delete h.data[e.key]; return { value: undefined } })
  on('session.start', () => ({ cwd }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => { h.spawned.push(e.model); return { model: e.model ?? 'haiku', agentId: 'a' + ++n } })
  on('turn.complete', () => ({ text: 'done' }) as never)
  for (const k of ['ui.log', 'ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return h
}

const spawn = async ($: any): Promise<string> =>
  ((await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model: 'haiku' } as never)) as { agentId: string }).agentId
const finish = ($: any, id: string) => $.turn.complete({ turnId: 't-' + id, agentId: id, answer: 'x' } as never)
const run = async ($: any): Promise<void> => { await finish($, await spawn($)) }
const command = async ($: any, args: string): Promise<string> =>
  ((await $.command.run({ command: 'escalator', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)) as { text: string }).text

const globalCell = (h: H): Cell | undefined => ((h.data.stats as Stats | undefined)?.[CAT] as Record<string, Cell> | undefined)?.haiku
const projects = (h: H): Record<string, { stats: Stats; seenAt: number }> => (h.data.projects ?? {}) as Record<string, { stats: Stats; seenAt: number }>
const projectCell = (h: H, cwd: string): Cell | undefined => (projects(h)[projectKey(cwd)]?.stats[CAT] as Record<string, Cell> | undefined)?.haiku

test('two sessions in different projects keep separate project evidence while the global table grows', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/secret/place/a' } as never)
  await run($)
  h.setCwd('/secret/place/b')
  await $.session.start({ cwd: '/secret/place/b' } as never)
  await run($)
  await run($)
  expect(globalCell(h)!.runs).toBe(3)
  expect(projectCell(h, '/secret/place/a')!.runs).toBe(1)
  expect(projectCell(h, '/secret/place/b')!.runs).toBe(2)
  expect(Object.keys(projects(h)).length).toBe(2)
})

test('no raw path is stored', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/secret/place/a' } as never)
  await run($)
  expect(Object.keys(projects(h)).length).toBe(1)
  expect(JSON.stringify(h.data)).not.toContain('secret')
  expect(JSON.stringify(h.data)).not.toContain('place')
})

test('a project with enough evidence decides its own spawn tier; a new project falls back to the global table', async ($, on) => {
  const bad: Stats = { [CAT]: { haiku: { runs: 5, escalated: 3, tokens: 0, notAccepted: 3 } } }
  const h = wire(on, { projects: { [projectKey('/secret/place/a')]: { stats: bad, seenAt: NOW } } })
  await $.session.start({ cwd: '/secret/place/a' } as never)
  await spawn($)
  expect(h.spawned).toEqual(['sonnet'])
  h.setCwd('/secret/place/b')
  await $.session.start({ cwd: '/secret/place/b' } as never)
  await spawn($)
  expect(h.spawned).toEqual(['sonnet', 'haiku'])
})

test('without a known project only the global table is written', async ($, on) => {
  const h = wire(on)
  h.setCwd('')
  await $.session.start({ cwd: '' } as never)
  await run($)
  expect(globalCell(h)!.runs).toBe(1)
  expect(Object.keys(projects(h)).length).toBe(0)
})

test('/escalator reset clears the global and the project tables', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/secret/place/a' } as never)
  await run($)
  expect(h.data.stats).toBeDefined()
  expect(h.data.projects).toBeDefined()
  await command($, 'reset')
  expect(h.data.stats).toBeUndefined()
  expect(h.data.projects).toBeUndefined()
})
