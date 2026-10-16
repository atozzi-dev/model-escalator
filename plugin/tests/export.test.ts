import { expect, test } from 'claude-code/testing'
import { csvField, csvRow, exportCsv, historyCsv, learnedCsv, sessionCsv } from '../hooks/export'
import { emptyLedger, type Ledger } from '../hooks/savings'
import type { Stats } from '../hooks/learning'

const ledger = (): Ledger => ({
  ...emptyLedger(),
  actual: 1.5, baselineHigh: 4, baselineLow: 3, agentSteps: 12, consults: 2, consultCost: 0.25, interventions: { swap: 1, consult: 2 },
  byCategory: {
    'general-purpose:docs': { steps: 4, actual: 0.5, baselineHigh: 1, baselineLow: 0.5, agents: 1, escalated: 0 },
    'general-purpose:bugfix': { steps: 8, actual: 1, baselineHigh: 3, baselineLow: 2, agents: 2, escalated: 1 },
  },
})

const stats = (): Stats => ({
  'general-purpose:bugfix': {
    haiku: { runs: 10, escalated: 4, notAccepted: 5, tokens: 1000, cost: 1, costRuns: 10, reviews: 2, reviewScore: 7, reworked: 1 },
    sonnet: { runs: 2, escalated: 0, tokens: 200 },
  },
})

const lines = (s: string): string[] => s.split('\n')

test('csvField quotes commas, quotes and newlines only when needed', () => {
  expect(csvField('plain')).toBe('plain')
  expect(csvField('a,b')).toBe('"a,b"')
  expect(csvField('say "hi"')).toBe('"say ""hi"""')
  expect(csvField('l1\nl2')).toBe('"l1\nl2"')
  expect(csvField('l1\r\nl2')).toBe('"l1\r\nl2"')
  expect(csvField('')).toBe('')
  expect(csvField(undefined)).toBe('')
  expect(csvField(3)).toBe('3')
})

test('csvField neutralizes spreadsheet formulas in text but not numbers', () => {
  expect(csvField('=SUM(A1)')).toBe("'=SUM(A1)")
  expect(csvField('@x')).toBe("'@x")
  expect(csvField('+1')).toBe("'+1")
  expect(csvField(-2.5)).toBe('-2.5')
})

test('csvRow joins fields with commas', () => {
  expect(csvRow(['a', 'b,c', 1])).toBe('a,"b,c",1')
})

test('sessionCsv: header, categories by cost, total row', () => {
  const out = lines(sessionCsv(ledger()))
  expect(out[0]).toBe('category,agents,escalations,requests,cost_usd,baseline_cost_low_usd,baseline_cost_high_usd,savings_low_usd,savings_high_usd,savings_low_pct,savings_high_pct')
  expect(out[1]).toBe('general-purpose:bugfix,2,1,8,1.0000,2.0000,3.0000,1.0000,2.0000,50.0,66.7')
  expect(out[2]).toBe('general-purpose:docs,1,0,4,0.5000,0.5000,1.0000,0.0000,0.5000,0.0,50.0')
  expect(out[3]).toBe('(total),3,1,12,1.5000,3.0000,4.0000,1.5000,2.5000,50.0,62.5')
  expect(out.length).toBe(4)
})

test('sessionCsv: empty or malformed ledger gives header and a zero total', () => {
  const out = lines(sessionCsv(emptyLedger()))
  expect(out.length).toBe(2)
  expect(out[1]).toBe('(total),0,0,0,0.0000,0.0000,0.0000,0.0000,0.0000,0.0,0.0')
  expect(lines(sessionCsv(undefined)).length).toBe(2)
  expect(lines(sessionCsv({ ...emptyLedger(), byCategory: { x: null as never, y: { steps: 'a' } as never } })).length).toBe(3)
})

test('sessionCsv: ties on cost are ordered by name; negative savings keep the sign', () => {
  const l: Ledger = { ...emptyLedger(), actual: 2, baselineHigh: 1, baselineLow: 1, byCategory: {
    b: { steps: 1, actual: 1, baselineHigh: 0.5, baselineLow: 0.5, agents: 1, escalated: 1 },
    a: { steps: 1, actual: 1, baselineHigh: 0.5, baselineLow: 0.5, agents: 1, escalated: 1 },
  } }
  const out = lines(sessionCsv(l))
  expect(out[1]!.startsWith('a,')).toBe(true)
  expect(out[2]!.startsWith('b,')).toBe(true)
  expect(out[1]!).toContain(',-0.5000,-0.5000,-100.0,-100.0')
})

test('learnedCsv: one row per category, tier and scope', () => {
  const out = lines(learnedCsv({ stats: stats() }))
  expect(out[0]).toBe('scope,category,model,runs,escalated,escalation_rate,not_accepted_rate,failed_verify,reworked,cost_per_run_usd,cost_per_accepted_usd,reviews,review_mean')
  const haiku = out[1]!.split(',')
  expect(haiku.slice(0, 10)).toEqual(['global', 'general-purpose:bugfix', 'haiku', '10', '4', '0.400', '0.500', '0', '1', '0.1000'])
  expect(haiku.slice(11)).toEqual(['2', '3.500'])
  expect(out[2]).toBe('global,general-purpose:bugfix,sonnet,2,0,0.000,0.000,0,0,,,0,')
  expect(out.length).toBe(3)
})

test('learnedCsv: project scope follows global, tiers in ladder order', () => {
  const proj: Stats = { 'general-purpose:bugfix': { opus: { runs: 1, escalated: 0, tokens: 1 }, haiku: { runs: 6, escalated: 1, tokens: 1 } } }
  const out = lines(learnedCsv({ stats: stats(), projectStats: proj }))
  expect(out.slice(1).map(l => l.split(',').slice(0, 3).join(','))).toEqual([
    'global,general-purpose:bugfix,haiku', 'global,general-purpose:bugfix,sonnet',
    'project,general-purpose:bugfix,haiku', 'project,general-purpose:bugfix,opus',
  ])
})

test('learnedCsv: empty and malformed stats give only the header', () => {
  expect(lines(learnedCsv({ stats: {} })).length).toBe(1)
  expect(lines(learnedCsv({ stats: undefined as never })).length).toBe(1)
  expect(lines(learnedCsv({ stats: { x: null as never, y: { haiku: null as never } } })).length).toBe(1)
})

test('learnedCsv: fractional decayed counters are rounded to 3 decimals', () => {
  const s: Stats = { c: { haiku: { runs: 2.123456, escalated: 1, tokens: 1 } } }
  expect(lines(learnedCsv({ stats: s }))[1]!.split(',')[3]).toBe('2.123')
})

test('historyCsv: one row per valid session, oldest first, ISO dates', () => {
  const past = [
    { at: Date.UTC(2026, 9, 2, 10, 30), mode: 'active', baseline: 'opus', ledger: ledger() },
    'junk', { at: 'x', ledger: ledger() },
    { at: Date.UTC(2026, 9, 1, 8, 0), mode: 'observe', baseline: 'opus', ledger: { ...emptyLedger(), actual: 0.2, baselineHigh: 0.4, baselineLow: 0.3, agentSteps: 3 } },
  ]
  const out = lines(historyCsv(past))
  expect(out[0]).toBe('date,mode,baseline,agent_requests,agents,escalations,interventions,consults,consult_cost_usd,cost_usd,savings_low_usd,savings_high_usd,savings_low_pct,savings_high_pct')
  expect(out[1]).toBe('2026-10-01T08:00:00.000Z,observe,opus,3,,,0,0,0.0000,0.2000,0.1000,0.2000,33.3,50.0')
  expect(out[2]).toBe('2026-10-02T10:30:00.000Z,active,opus,12,3,1,3,2,0.2500,1.5000,1.5000,2.5000,50.0,62.5')
  expect(out.length).toBe(3)
})

test('historyCsv: no sessions gives only the header; limit keeps the newest', () => {
  expect(lines(historyCsv([])).length).toBe(1)
  expect(lines(historyCsv(undefined)).length).toBe(1)
  const past = [1, 2, 3].map(d => ({ at: Date.UTC(2026, 0, d), mode: 'active', baseline: 'opus', ledger: ledger() }))
  const out = lines(historyCsv(past, 2))
  expect(out.length).toBe(3)
  expect(out[1]!.startsWith('2026-01-02')).toBe(true)
})

test('exportCsv: single kinds return the bare table', () => {
  const inp = { ledger: ledger(), stats: stats(), sessions: [] }
  expect(exportCsv('session', inp)).toBe(sessionCsv(ledger()))
  expect(exportCsv('learned', inp)).toBe(learnedCsv({ stats: stats() }))
  expect(exportCsv('history', inp)).toBe(historyCsv([]))
})

test('exportCsv all: sections with a comment line, separated by a blank line', () => {
  const out = exportCsv('all', { ledger: ledger(), stats: stats(), sessions: [] })
  const parts = out.split('\n\n')
  expect(parts.length).toBe(3)
  expect(parts[0]!.startsWith('# session\n')).toBe(true)
  expect(parts[1]!.startsWith('# learned\n')).toBe(true)
  expect(parts[2]!.startsWith('# history\n')).toBe(true)
})

test('exportCsv never emits fields outside the documented columns', () => {
  const out = exportCsv('all', { ledger: ledger(), stats: stats(), sessions: [{ at: 1, mode: 'active', baseline: 'opus', ledger: ledger(), prompt: 'SECRET' }] })
  expect(out.includes('SECRET')).toBe(false)
})
