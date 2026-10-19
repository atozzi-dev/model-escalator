import { expect, mock, test } from 'claude-code/testing'
import { resetState } from '../hooks/register'
import { sessionCsv } from '../hooks/export'
import { addStep, cost, emptyLedger, PRICES, report, type Ledger } from '../hooks/savings'
import { buildStatsView } from '../hooks/stats-view'

const U = { input_tokens: 2_000, output_tokens: 1_000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 3_000 }
const lines = (csv: string): string[] => csv.split('\n')

// --- savings.ts ---

test('addStep splits the cost between the lead and the agents', () => {
  let l = addStep(emptyLedger(), U, 'opus', 'opus', false)
  l = addStep(l, U, 'haiku', 'opus', true)
  expect(Math.abs((l.leadCost ?? -1) - cost(U, PRICES.opus, '1h')) < 1e-9).toBe(true)
  expect(Math.abs((l.agentCost ?? -1) - cost(U, PRICES.haiku, '5m')) < 1e-9).toBe(true)
})

test('the report shows the lead and the agents apart, with the delegation hint', () => {
  let l = addStep(emptyLedger(), U, 'opus', 'opus', false)
  l = addStep(l, U, 'haiku', 'opus', true)
  const text = report(l, 'opus')
  expect(text).toContain('Lead (main conversation): $')
  expect(text).toMatch(/% of the session/)
  expect(text).toContain("The mod does not change the lead's model")
  expect(text).toContain('Getting work delegated')
  expect(text).toContain('Subagents and teammates: $')
  expect(text).toContain('Session cost:')
})

test('the report has no lead line for ledgers without the split', () => {
  const text = report({ ...emptyLedger(), actual: 1 }, 'opus')
  expect(text).not.toContain('Lead (main conversation)')
  expect(text).not.toContain('Subagents and teammates')
})

test('a session with only lead requests shows no delegation', () => {
  const text = report(addStep(emptyLedger(), U, 'opus', 'opus', false), 'opus')
  expect(text).toContain('100% of the session')
  expect(text).toContain('Subagents and teammates: $0.00')
})

// --- export.ts ---

const base = (): Ledger => ({
  ...emptyLedger(), actual: 1.5, baselineHigh: 4, baselineLow: 3, agentSteps: 12,
  byCategory: { 'general-purpose:docs': { steps: 4, actual: 0.5, baselineHigh: 1, baselineLow: 0.5, agents: 1, escalated: 0 } },
})

test('sessionCsv has a (lead) row before the total when the lead had a cost', () => {
  const out = lines(sessionCsv({ ...base(), leadCost: 0.5, agentCost: 1 }))
  expect(out[out.length - 2]).toBe('(lead),,,,0.5000,0.5000,0.5000,0.0000,0.0000,0.0,0.0')
  expect(out[out.length - 1]!.startsWith('(total)')).toBe(true)
  expect(lines(sessionCsv(base())).some((l) => l.startsWith('(lead)'))).toBe(false)
})

// --- stats-view.ts ---

test('session rows show the lead and the agents apart when the ledger has the split', () => {
  const input = (ledger: Ledger) => ({ mode: 'active', baseline: 'opus', ledger, paused: [], plan: '', stats: {} })
  const rows = (ledger: Ledger) => buildStatsView(input(ledger)).sections.find((s) => s.id === 'session')!.rows.map((r) => r.map((c) => c.text))
  expect(rows({ ...base(), leadCost: 0.5, agentCost: 1 })).toContainEqual(['Lead', '$0.50, 33% of the session'])
  expect(rows({ ...base(), leadCost: 0.5, agentCost: 1 })).toContainEqual(['Subagents', '$1.00'])
  expect(rows(base()).some((r) => r[0] === 'Lead')).toBe(false)
})

// --- the command ---

test('/escalator shows the lead apart from the agents', async ($, on) => {
  resetState()
  mock.env(on, {})
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [] } }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, ...U } } as never
  })
  await $.session.start({ cwd: '/work' } as never)
  const st = $.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 3 } as never) as any
  for await (const _ of st) { /* chunks */ }
  await st.result
  const text = (await $.command.run({ command: 'escalator', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never) as { text: string }).text
  expect(text).toContain('Lead (main conversation): $')
  expect(text).toContain('Subagents and teammates: $0.00')
})
