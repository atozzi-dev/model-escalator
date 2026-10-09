import { expect, test } from 'claude-code/testing'
import { addConsult, addStep, cost, emptyLedger, PRICES, report, savings } from '../hooks/savings'

const U = { input_tokens: 2_000, output_tokens: 1_000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 3_000 }

test('cost follows list prices', async () => {
  // opus: 2k*4 + 1k*20 + 40k*0.2 + 3k*5 = 8000+20000+8000+15000 = 51000 / 1e6
  expect(Math.abs(cost(U, PRICES.opus) - 0.051) < 1e-9).toBe(true)
})

test('lead requests never count as savings', async () => {
  const l = addStep(emptyLedger(), U, 'opus', 'opus', false)
  expect(Math.abs(savings(l).high) < 1e-12).toBe(true)
  expect(l.agentSteps).toBe(0)
})

test('a sonnet agent step saves against an opus baseline, prudently less', async () => {
  const l = addStep(emptyLedger(), U, 'sonnet', 'opus', true)
  const s = savings(l)
  expect(s.high).toBeGreaterThan(0)
  expect(s.low).toBeLessThan(s.high)
  expect(s.highPct).toBeGreaterThan(30)
})

test('consults add to the real cost and can turn savings negative', async () => {
  let l = addStep(emptyLedger(), U, 'haiku', 'opus', true)
  for (let i = 0; i < 20; i++) l = addConsult(l, 8_000, 2_000, 'opus')
  expect(l.consults).toBe(20)
  expect(savings(l).low).toBeLessThan(0)
  expect(report(l, 'opus')).toContain('senior consults: 20')
})
