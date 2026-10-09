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

const near = (a: number, b: number) => Math.abs(a - b) / b < 0.02
const use = (i: number, o: number, r: number, w: number) =>
  ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: r, cache_creation_input_tokens: w })

test('matches /cost for haiku agent steps', async () => {
  // /cost totals many requests; split into 10 requests, each far below the 100K long-context threshold.
  let l = emptyLedger()
  for (let i = 0; i < 10; i++) l = addStep(l, use(330, 320, 45_070, 5_340), 'haiku', 'haiku', true)
  expect(near(l.actual, 0.0131)).toBe(true)
})

test('matches /cost for the opus main loop (1h writes)', async () => {
  const l = addStep(emptyLedger(), use(1_000, 1_200, 210_800, 15_200), 'opus', 'opus', false)
  expect(near(l.actual, 0.191)).toBe(true)
})

test('matches /cost for a sonnet agent (5m writes)', async () => {
  const l = addStep(emptyLedger(), use(28, 2_500, 504_900, 40_300), 'sonnet', 'sonnet', true)
  expect(near(l.actual, 0.2266)).toBe(true)
})

test('haiku long context uses the higher rates above 100K total input', async () => {
  const short = cost(use(1_000, 1_000, 98_000, 0), PRICES.haiku)
  const long = cost(use(1_000, 1_000, 99_001, 0), PRICES.haiku)
  expect(near(short, (1_000 * 0.1 + 1_000 * 0.5 + 98_000 * 0.01) / 1e6)).toBe(true)
  expect(near(long, (1_000 * 0.5 + 1_000 * 2.5 + 99_001 * 0.05) / 1e6)).toBe(true)
})

test('main loop writes cost the 1h price, agent steps the 5m price', async () => {
  const w = use(0, 0, 0, 1_000_000)
  expect(near(addStep(emptyLedger(), w, 'opus', 'opus', false).actual, 8)).toBe(true)
  expect(near(addStep(emptyLedger(), w, 'opus', 'opus', true).actual, 5)).toBe(true)
  expect(near(addStep(emptyLedger(), w, 'haiku', 'opus', true).baselineHigh, 5)).toBe(true)
})

test('consults add to the real cost and can turn savings negative', async () => {
  let l = addStep(emptyLedger(), U, 'haiku', 'opus', true)
  for (let i = 0; i < 20; i++) l = addConsult(l, 8_000, 2_000, 'opus')
  expect(l.consults).toBe(20)
  expect(savings(l).low).toBeLessThan(0)
  expect(report(l, 'opus')).toContain('senior consults: 20')
})
