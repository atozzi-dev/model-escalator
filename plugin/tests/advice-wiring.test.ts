import { expect, mock, test } from 'claude-code/testing'
import { STATS_PANE, resetState } from '../hooks/register'
import { buildStatsView, type StatsInput } from '../hooks/stats-view'
import { emptyLedger } from '../hooks/savings'
import type { Advice } from '../hooks/advice'

let data: Record<string, unknown> = {}
let broken = false

function wire(on: any, env: Record<string, string> = {}): void {
  resetState()
  mock.env(on, env)
  data = {}
  broken = false
  on('store.get', (_$: unknown, e: any) => { if (broken) throw new Error('boom'); return { value: data[e.key] } as never })
  on('store.set', (_$: unknown, e: any) => { data[e.key] = e.value; return { value: undefined } as never })
  on('store.delete', (_$: unknown, e: any) => { delete data[e.key]; return { value: undefined } as never })
  mock.clock(on, { now: 1_000_000 })
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [] } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('session.surfaces', () => ({ value: ['desktop'] }) as never)
  for (const k of ['ui.log', 'ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
}

const run = async ($: any, args: string) =>
  (await $.command.run({ command: 'escalator', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never) as { text: string }).text

// 18 runs of a category on opus that never got stuck, 0.94 USD each: a strong suggestion for sonnet.
const EASY = { 'security-reviewer:other': { opus: { runs: 18, escalated: 0, tokens: 1000, cost: 16.92, costRuns: 18 } } }

const advice = (over: Partial<Advice> = {}): Advice => ({
  category: 'reviewer:other', tier: 'opus', suggested: 'sonnet', scope: 'global', runs: 18, escalationRate: 0, notAcceptedRate: 0,
  priceRatio: 0.5, costNow: 0.94, costCheaper: 0.47, strength: 'strong', ...over,
})

const input = (over: Partial<StatsInput> = {}): StatsInput =>
  ({ mode: 'active', baseline: 'opus', ledger: emptyLedger(), paused: [], plan: '', stats: {}, ...over })

// --- stats-view ---

test('the view has no advice section without advice', () => {
  expect(buildStatsView(input()).sections.map((s) => s.id)).not.toContain('advice')
  expect(buildStatsView(input({ advice: [] })).sections.map((s) => s.id)).not.toContain('advice')
})

test('the advice section follows the learned one and has a row per advice', () => {
  const v = buildStatsView(input({ advice: [advice(), advice({ category: 'docs:other', strength: 'moderate', costNow: undefined, costCheaper: undefined })] }))
  const ids = v.sections.map((s) => s.id)
  expect(ids[ids.length - 1]).toBe('advice')
  expect(ids.indexOf('advice')).toBe(ids.indexOf('learned') + 1)
  const rows = v.sections.find((s) => s.id === 'advice')!.rows.map((r) => r.map((c) => c.text))
  const first = rows.find((r) => r[0] === 'reviewer:other')!
  expect(first).toContain('opus -> sonnet')
  expect(first.join(' ')).toContain('18')
  expect(first.join(' ')).toContain('$0.94')
  expect(first.join(' ')).toContain('$0.47')
  expect(first.join(' ')).toContain('strong')
  expect(rows.find((r) => r[0] === 'docs:other')!.join(' ')).toContain('moderate')
})

test('malformed advice entries are skipped', () => {
  const v = buildStatsView(input({ advice: [null, 3, { category: 1 }] as never }))
  expect(v.sections.map((s) => s.id)).not.toContain('advice')
})

// --- /escalator stats ---

test('/escalator stats lists the suggestions between the learned stats and the session savings', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  data.stats = EASY
  const text = await run($, 'stats')
  expect(text).toContain('Cheaper model suggestions')
  expect(text).toContain('security-reviewer:other: opus -> sonnet')
  expect(text.indexOf('Cheaper model suggestions')).toBeGreaterThan(text.indexOf('Learned stats per category'))
})

test('/escalator stats has no suggestions block without evidence', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  expect(await run($, 'stats')).not.toContain('Cheaper model suggestions')
})

test('/escalator stats shows no suggestions in off mode', async ($, on) => {
  wire(on, { MODEL_ESCALATOR_MODE: 'off' })
  await $.session.start({ cwd: '/work' } as never)
  data.stats = EASY
  expect(await run($, 'stats')).not.toContain('Cheaper model suggestions')
})

// --- hint in the report ---

test('the first report of the session carries the hint of the first strong suggestion, the next ones do not', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  data.stats = EASY
  const first = await run($, '')
  expect(first).toContain('security-reviewer:other never got stuck in 18 runs on opus')
  expect(first).toContain('Ask for sonnet in the Agent call')
  expect(await run($, '')).not.toContain('never got stuck in 18 runs')
  expect(await run($, 'report')).not.toContain('never got stuck in 18 runs')
})

test('a hinted suggestion is not hinted again in a later session within a week', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  data.stats = EASY
  expect(await run($, '')).toContain('never got stuck in 18 runs')
  const hinted = data.adviceHinted
  expect(JSON.stringify(hinted)).toContain('security-reviewer:other|opus')
  resetState()
  await $.session.start({ cwd: '/work' } as never)
  expect(await run($, '')).not.toContain('never got stuck in 18 runs')
})

test('a moderate suggestion is no hint', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  data.stats = { c: { opus: { runs: 10, escalated: 0, tokens: 1 } } }
  const text = await run($, '')
  expect(text).not.toContain('never got stuck')
  expect(await run($, 'stats')).toContain('c: opus -> sonnet')
})

for (const mode of ['baseline', 'off']) test(`no hint in ${mode} mode`, async ($, on) => {
    wire(on, { MODEL_ESCALATOR_MODE: mode })
    await $.session.start({ cwd: '/work' } as never)
    data.stats = EASY
    expect(await run($, '')).not.toContain('never got stuck')
})

test('a broken store degrades to no advice', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  broken = true
  const text = await run($, '')
  expect(text).toContain('Session cost')
  expect(text).not.toContain('never got stuck')
})

// --- panel ---

test('the panel draws the suggestions and the stats pane id is unchanged', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  data.stats = EASY
  const ui = await $.ui.mount({ plugin: 'model-escalator', surface: 'desktop', component: 'Pane', requestId: STATS_PANE,
    props: { title: 'Escalator', isFocused: false, bodyColumns: 100, placement: 'inline', scroll: { first: 0, last: 0, bodyRows: 30 }, view: {} } } as never) as any
  const flat = JSON.stringify(await ui.drawn())
  expect(flat).toContain('Cheaper model suggestions')
  expect(flat).toContain('opus -> sonnet')
})
