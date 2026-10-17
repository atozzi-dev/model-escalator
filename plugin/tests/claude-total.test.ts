import { expect, mock, test } from 'claude-code/testing'
import { STATS_PANE, resetState } from '../hooks/register'
import { claudeCostUsd, claudeCostLine, emptyLedger } from '../hooks/savings'
import { buildStatsView } from '../hooks/stats-view'

// --- savings.ts ---

test('claudeCostUsd reads the object form and the plain number', () => {
  expect(claudeCostUsd({ usd: 5.25 })).toBe(5.25)
  expect(claudeCostUsd(5.25)).toBe(5.25)
  expect(claudeCostUsd(0)).toBe(0)
})

test('claudeCostUsd rejects anything else', () => {
  for (const bad of [undefined, null, 'x', -1, Number.NaN, {}, { usd: 'a' }, { usd: -2 }, []]) expect(claudeCostUsd(bad)).toBeUndefined()
})

test('the line gives both totals and the reason they differ', () => {
  const line = claudeCostLine({ usd: 12.5 }, { ...emptyLedger(), actual: 10.25 })
  expect(line).toBe('Claude Code reports $12.50 for this session; the mod metered $10.25 ' +
    '(requests Claude Code makes on its own, such as prompt suggestions, do not pass through the mod)')
  expect(claudeCostLine(undefined, emptyLedger())).toBe('')
})

// --- stats-view.ts ---

const input = (claudeCost?: number) => ({ mode: 'active', baseline: 'opus', ledger: { ...emptyLedger(), actual: 1 }, paused: [], plan: '', stats: {}, ...(claudeCost !== undefined ? { claudeCost } : {}) })
const session = (claudeCost?: number) => buildStatsView(input(claudeCost)).sections.find((s) => s.id === 'session')!.rows.map((r) => r.map((c) => c.text))

test('the panel shows the total Claude Code reports next to the metered one', () => {
  expect(session(1.5)).toContainEqual(['Claude Code', '$1.50 reported, the mod metered $1.00'])
  expect(session().some((r) => r[0] === 'Claude Code')).toBe(false)
})

// --- the command and the panel ---

let cost: unknown
function wire(on: any): void {
  resetState()
  mock.env(on, {})
  mock.store(on)
  mock.clock(on, { now: 1_000_000 })
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [], ...(cost !== undefined ? { cost } : {}) } }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
}
const run = async ($: any) =>
  (await $.command.run({ command: 'escalator', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never) as { text: string }).text

test('/escalator shows the total Claude Code reports', async ($, on) => {
  cost = { usd: 3.5 }
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const text = await run($)
  expect(text).toContain('Claude Code reports $3.50 for this session; the mod metered $0.00')
})

test('/escalator accepts a plain number as the cost', async ($, on) => {
  cost = 2
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  expect(await run($)).toContain('Claude Code reports $2.00')
})

test('/escalator shows nothing when the cost is absent', async ($, on) => {
  cost = undefined
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  expect(await run($)).not.toContain('Claude Code reports')
})

test('the panel shows the reported total', async ($, on) => {
  cost = { usd: 3.5 }
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const ui = await $.ui.mount({ plugin: 'model-escalator', surface: 'desktop', component: 'Pane', requestId: STATS_PANE,
    props: { title: 'Escalator', isFocused: false, bodyColumns: 100, placement: 'inline', scroll: { first: 0, last: 0, bodyRows: 30 }, view: {} } } as never) as any
  const flat = JSON.stringify(await ui.drawn())
  expect(flat).toContain('$3.50 reported')
})
