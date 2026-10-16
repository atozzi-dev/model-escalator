import { expect, test } from 'claude-code/testing'
import { buildStatsView, fitView, type StatsInput, type StatsView } from '../hooks/stats-view'
import { emptyLedger, type Ledger } from '../hooks/savings'
import type { Stats } from '../hooks/learning'

const ledger = (): Ledger => ({
  ...emptyLedger(),
  actual: 1.5, baselineHigh: 4, baselineLow: 3, agentSteps: 12,
  consults: 2, consultCost: 0.25, interventions: { swap: 1, consult: 2 },
  byCategory: {
    'general-purpose:bugfix': { steps: 8, actual: 1, baselineHigh: 3, baselineLow: 2, agents: 2, escalated: 1 },
    'general-purpose:docs': { steps: 4, actual: 0.5, baselineHigh: 1, baselineLow: 0.5, agents: 1, escalated: 0 },
  },
})

const stats = (): Stats => ({
  'general-purpose:bugfix': {
    haiku: { runs: 10, escalated: 4, notAccepted: 5, tokens: 1000, cost: 1, costRuns: 10, reviews: 2, reviewScore: 7, reworked: 1 },
    sonnet: { runs: 2, escalated: 0, tokens: 200 },
  },
  'general-purpose:docs': { haiku: { runs: 3, escalated: 0, tokens: 100 } },
})

const input = (over: Partial<StatsInput> = {}): StatsInput => ({
  mode: 'active', baseline: 'opus', ledger: ledger(), paused: ['scout (bugfix, haiku)'], plan: '', stats: stats(), ...over,
})

const section = (v: StatsView, id: string) => v.sections.find((s) => s.id === id)
const texts = (v: StatsView, id: string): string[][] => (section(v, id)?.rows ?? []).map((r) => r.map((c) => c.text))

test('the view has the session, categories and learned sections, and no plan section without a plan', () => {
  const v = buildStatsView(input())
  expect(v.sections.map((s) => s.id)).toEqual(['session', 'categories', 'learned'])
})

test('session rows carry mode, cost, baseline range, savings, interventions, consults and paused agents', () => {
  const rows = texts(buildStatsView(input()), 'session')
  expect(rows).toContainEqual(['Mode', 'active (baseline opus)'])
  expect(rows).toContainEqual(['Cost', '$1.50 (consults 2, $0.25)'])
  expect(rows).toContainEqual(['All on opus', '$3.00 to $4.00'])
  expect(rows).toContainEqual(['Savings', '$1.50 to $2.50 (50% to 63%)'])
  expect(rows).toContainEqual(['Interventions', 'swap 1, consult 2'])
  expect(rows).toContainEqual(['Paused', 'scout (bugfix, haiku)'])
})

test('no interventions and no paused agents read as none', () => {
  const rows = texts(buildStatsView(input({ ledger: emptyLedger(), paused: [] })), 'session')
  expect(rows).toContainEqual(['Interventions', 'none'])
  expect(rows).toContainEqual(['Paused', 'none'])
})

test('the plan section appears with the plan lines when there is a plan block', () => {
  const plan = 'Plan usage (as Claude Code reports it):\n  five_hour: 23.5% used, resets 2026-10-12T15:00:00Z\n  seven_day: 7% used\nEstimate: the ladder saved about 50% to 63% of this session\'s usage (API-price estimate, not a reading of the plan limits).'
  const v = buildStatsView(input({ plan }))
  expect(v.sections.map((s) => s.id)).toEqual(['session', 'plan', 'categories', 'learned'])
  const rows = texts(v, 'plan')
  expect(rows[0]).toEqual(['five_hour: 23.5% used, resets 2026-10-12T15:00:00Z'])
  expect(rows[1]).toEqual(['seven_day: 7% used'])
  expect(rows[2]![0]).toContain('Estimate:')
  expect(rows.length).toBe(3)
})

test('categories are sorted by real cost with savings and escalations, and limited to the top rows', () => {
  const rows = texts(buildStatsView(input()), 'categories')
  expect(rows[0]).toEqual(['Category', 'Cost', 'Saved', 'Escalated'])
  expect(rows[1]).toEqual(['general-purpose:bugfix', '$1.00', '50% to 67%', '1/2'])
  expect(rows[2]).toEqual(['general-purpose:docs', '$0.50', '0% to 50%', '0/1'])
  const many = ledger()
  for (let i = 0; i < 9; i++) many.byCategory![`c${i}`] = { steps: 1, actual: 0.01 * (i + 1), baselineHigh: 1, baselineLow: 1, agents: 1, escalated: 0 }
  const sec = section(buildStatsView(input({ ledger: many })), 'categories')!
  expect(sec.rows.length).toBe(1 + 5 + 1)
  expect(sec.rows[6]![0]!.text).toBe('+6 more')
  expect(texts(buildStatsView(input({ ledger: emptyLedger() })), 'categories')).toEqual([['No category data yet.']])
})

test('learned rows sum the tiers: runs, not accepted share, cost per accepted, review average, rework', () => {
  const rows = texts(buildStatsView(input({ now: 0 })), 'learned')
  expect(rows[0]).toEqual(['Category', 'Runs', 'Not acc.', '$/accepted', 'Review', 'Rework'])
  // 12 runs, 5 not accepted: 42%. Haiku: $0.10 a run, 6/12 accepted: $0.20 per accepted run.
  expect(rows[1]).toEqual(['general-purpose:bugfix', '12', '42%', '$0.20 haiku', '3.5 (2)', '1'])
  expect(rows[2]).toEqual(['general-purpose:docs', '3', '0%', '-', '-', '0'])
  expect(texts(buildStatsView(input({ stats: {} })), 'learned')).toEqual([['No learned stats yet.']])
})

test('a malformed ledger or stats never throws', () => {
  const v = buildStatsView({ mode: 'active', baseline: 'opus', ledger: {} as never, paused: [], plan: '', stats: { x: { haiku: { runs: 'a' } as never } } as never })
  expect(v.sections.length).toBeGreaterThanOrEqual(3)
})

test('fitView keeps every row within the width and truncates with an ellipsis', () => {
  const v = buildStatsView(input())
  for (const width of [30, 40, 60, 80, 120]) {
    const fit = fitView(v, width)
    for (const s of fit.sections) {
      for (const r of s.rows) {
        const total = r.reduce((n, c) => n + c.text.length, 0) + (r.length - 1) * 2
        expect([width, s.id, total <= width]).toEqual([width, s.id, true])
      }
    }
  }
  // Columns line up within a section.
  const fit = fitView(v, 120)
  const first = fit.sections.find((s) => s.id === 'categories')!.rows.map((r) => r[0]!.text.length)
  expect(new Set(first).size).toBe(1)
  // A narrow width shortens text rather than overflowing.
  expect(fitView(v, 30).sections.flatMap((s) => s.rows.flat()).some((c) => c.text.endsWith('…'))).toBe(true)
})

test('numbers are right-aligned in the tables, names and labels left-aligned', () => {
  const v = buildStatsView(input({ now: 0 }))
  for (const id of ['categories', 'learned']) {
    for (const r of section(v, id)!.rows.filter((r) => r.length > 1)) {
      expect(r[0]!.align).toBeUndefined()
      for (const c of r.slice(1)) expect(c.align).toBe('right')
    }
  }
  for (const r of section(v, 'session')!.rows) for (const c of r) expect(c.align).toBeUndefined()
})

test('table headers are set apart from the rows', () => {
  const v = buildStatsView(input({ now: 0 }))
  for (const id of ['categories', 'learned']) {
    const [header, first] = section(v, id)!.rows
    for (const c of header!) expect([c.bold, c.dim]).toEqual([true, true])
    for (const c of first!) expect(c.bold).toBeUndefined()
  }
})

test('fitView pads right-aligned cells on the left, so the digits line up', () => {
  const fit = fitView(buildStatsView(input({ now: 0 })), 100)
  const esc = section(fit, 'categories')!.rows.map((r) => r[3]!.text)
  expect(new Set(esc.map((t) => t.length)).size).toBe(1)
  expect(esc[0]).toBe('Escalated')
  expect(esc[1]).toBe('      1/2')
  expect(esc[2]).toBe('      0/1')
})

test('fitView wraps a long single-cell row onto more rows instead of cutting it', () => {
  const plan = 'Plan usage (as Claude Code reports it):\n  seven_day: 7% used\nEstimate: the ladder saved about 50% to 63% of this session\'s usage (API-price estimate, not a reading of the plan limits).'
  const fit = fitView(buildStatsView(input({ plan })), 40)
  const rows = section(fit, 'plan')!.rows
  expect(rows.length).toBeGreaterThan(3)
  for (const r of rows) {
    expect(r.length).toBe(1)
    expect(r[0]!.text.length).toBeLessThanOrEqual(40)
    expect(r[0]!.text.endsWith('…')).toBe(false)
  }
  const words = rows.map((r) => r[0]!.text.trim()).join(' ')
  expect(words).toContain('not a reading of the plan limits).')
})

test('fitView cuts a category name in the middle, keeping the part that tells categories apart', () => {
  const fit = fitView(buildStatsView(input({ now: 0 })), 50)
  const names = section(fit, 'learned')!.rows.slice(1).map((r) => r[0]!.text.trim())
  expect(names.some((n) => n.includes('…'))).toBe(true)
  expect(names.some((n) => n.endsWith(':bugfix'))).toBe(true)
  expect(names.some((n) => n.endsWith(':docs'))).toBe(true)
})
