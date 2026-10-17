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

// 18 runs of a category on opus that never got stuck, 0.94 USD each.
const OPUS = { runs: 18, escalated: 0, tokens: 1000, cost: 16.92, costRuns: 18 }
// With 5 accepted sonnet runs whose rework the mod watched: a strong, measured suggestion for sonnet.
const EASY = { 'coder:feature': { opus: OPUS, sonnet: { runs: 5, escalated: 0, tokens: 100 } } }

const advice = (over: Partial<Advice> = {}): Advice => ({
  category: 'reviewer:other', tier: 'opus', suggested: 'sonnet', scope: 'global', runs: 18, escalationRate: 0, notAcceptedRate: 0,
  priceRatio: 0.5, costNow: 0.94, costCheaper: 0.47, strength: 'strong', quality: 'measured', signal: 'verify',
  qualityNote: 'your verifyCommand passed', ...over,
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
  expect(text).toContain('coder:feature: opus -> sonnet')
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
  expect(first).toContain('coder:feature never got stuck in 18 runs on opus')
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
  expect(JSON.stringify(hinted)).toContain('coder:feature|opus')
  resetState()
  await $.session.start({ cwd: '/work' } as never)
  expect(await run($, '')).not.toContain('never got stuck in 18 runs')
})

test('a moderate suggestion is no hint', { options: { verifyCommand: 'npm test' } }, async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  data.stats = { 'c:feature': { opus: { runs: 10, escalated: 0, tokens: 1 } } }
  const text = await run($, '')
  expect(text).not.toContain('never got stuck')
  expect(await run($, 'stats')).toContain('c:feature: opus -> sonnet')
})

// --- quality ---

// The same evidence for read-only work: no reviews, tests or rework can tell whether sonnet would do as well.
const READ_ONLY = { 'security-reviewer:review': { opus: OPUS } }

test('read-only work is listed in /escalator stats with its limit and never hinted', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  data.stats = READ_ONLY
  expect(await run($, '')).not.toContain('never got stuck')
  const stats = await run($, 'stats')
  expect(stats).toContain('security-reviewer:review never got stuck in 18 runs on opus. On sonnet it would cost about $0.47')
  expect(stats).toContain('cannot tell whether it would find the same issues')
  expect(stats).toContain('not on a comparison with the cheaper model')
})

test('the stats name the signal that measures a suggestion', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  data.stats = EASY
  expect(await run($, 'stats')).toContain('quality: no rework by the lead in 5 sonnet runs')
  expect(await run($, '')).toContain('(no rework by the lead in 5 sonnet runs)')
})

test('code work never run on the cheaper model has only a safety net and no hint', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  data.stats = { 'coder:feature': { opus: OPUS } }
  expect(await run($, '')).not.toContain('never got stuck')
  const stats = await run($, 'stats')
  expect(stats).toContain('Quality is not measured yet (no sonnet runs to compare)')
  expect(stats).toContain('edits by the lead within 30 minutes would show it')
})

test('the verifyCommand option measures code work', { options: { verifyCommand: 'npm test', reworkWindowMinutes: 0 } }, async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  data.stats = EASY
  expect(await run($, 'stats')).toContain('quality: your verifyCommand passed')
  expect(await run($, '')).toContain('(your verifyCommand passed)')
})

test('code work with rework off and no verifyCommand is unmeasured and no hint', { options: { reworkWindowMinutes: 0 } }, async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  data.stats = EASY
  expect(await run($, '')).not.toContain('never got stuck')
  expect(await run($, 'stats')).toContain('Set verifyCommand or turn on reviewRate')
})

test('reviewRate on changes the advice for other work', { options: { reviewRate: 0.5 } }, async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  data.stats = { 'gp:other': { opus: OPUS } }
  expect(await run($, 'stats')).toContain('reviewRate is on')
})

test('the view marks unmeasured advice and says what it means', () => {
  const v = buildStatsView(input({ advice: [advice({ category: 'reviewer:review', strength: 'moderate', quality: 'unmeasured', signal: undefined, qualityNote: 'read-only work' })] }))
  const rows = v.sections.find((s) => s.id === 'advice')!.rows.map((r) => r.map((c) => c.text).join(' '))
  expect(rows.find((r) => r.startsWith('reviewer:review'))!).toContain('unmeasured')
  expect(rows.join('\n')).toContain('quality not measured')
  expect(rows.join('\n')).toContain('not a comparison with the cheaper model')
  expect(rows.join('\n')).not.toContain('safety net')
})

test('the view marks safety-net advice and says what it means', () => {
  const v = buildStatsView(input({ advice: [advice({ category: 'w:feature', strength: 'moderate', quality: 'safety-net', signal: undefined, qualityNote: 'x' })] }))
  const rows = v.sections.find((s) => s.id === 'advice')!.rows.map((r) => r.map((c) => c.text).join(' '))
  expect(rows.find((r) => r.startsWith('w:feature'))!).toContain('safety net')
  expect(rows.join('\n')).toContain('safety net: quality not measured yet')
  expect(rows.join('\n')).not.toContain('unmeasured:')
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
