import { expect, test } from 'claude-code/testing'
import {
  categorize, costPerAccepted, formatStats, goodEnoughChance, HALF_LIFE_MS, isAccepted, LEARN, mulberry32, recommend,
  recommendWithExploration, record, recordReview, type Cell, type Stats,
} from '../hooks/learning'

const DAY = 24 * 60 * 60 * 1000

test('a cell untouched for one half-life counts half when a run is recorded', async () => {
  const t0 = 1_000_000
  let st: Stats = {}
  for (let i = 0; i < 8; i++) st = record(st, 'c', 'haiku', i < 4, 100, false, t0)
  const next = record(st, 'c', 'haiku', false, 100, false, t0 + HALF_LIFE_MS)
  const c = next['c']!.haiku!
  expect(Math.abs(c.runs - 5)).toBeLessThan(1e-9)
  expect(Math.abs(c.escalated - 2)).toBeLessThan(1e-9)
  expect(Math.abs(c.tokens - 500)).toBeLessThan(1e-9)
  expect(c.updatedAt).toBe(t0 + HALF_LIFE_MS)
})

test('recording with the same timestamp does not decay', async () => {
  const st = record(record({}, 'c', 'haiku', true, 10, false, 5), 'c', 'haiku', true, 10, false, 5)
  expect(st['c']!.haiku!.runs).toBe(2)
})

test('recommend ignores evidence that decayed below the threshold', async () => {
  const t0 = 1_000_000
  let st: Stats = {}
  for (let i = 0; i < 8; i++) st = record(st, 'c', 'haiku', i < 6, 100, false, t0)
  expect(recommend(st, 'c', 'haiku', t0)).toBe('sonnet')
  expect(recommend(st, 'c', 'haiku', t0 + HALF_LIFE_MS / 2)).toBe('sonnet')
  expect(recommend(st, 'c', 'haiku', t0 + HALF_LIFE_MS)).toBe('haiku')
})

test('recommend accepts a custom half-life', async () => {
  const t0 = 1_000_000
  let st: Stats = {}
  for (let i = 0; i < 6; i++) st = record(st, 'c', 'haiku', i < 4, 100, false, t0)
  expect(recommend(st, 'c', 'haiku', t0 + 10 * DAY, 100 * DAY)).toBe('sonnet')
  expect(recommend(st, 'c', 'haiku', t0 + 10 * DAY, DAY)).toBe('haiku')
})

test('without a timestamp nothing decays and nothing is stamped', async () => {
  const st = record(record({}, 'c', 'haiku', true, 10), 'c', 'haiku', false, 10)
  expect(st['c']!.haiku!.runs).toBe(2)
  expect(st['c']!.haiku!.updatedAt).toBeUndefined()
  const old: Stats = { c: { haiku: { runs: 6, escalated: 4, tokens: 0, updatedAt: 1 } } }
  expect(recommend(old, 'c', 'haiku')).toBe('sonnet')
})

test('cells without updatedAt are read as undecayed and gain a timestamp', async () => {
  const old: Stats = { c: { haiku: { runs: 6, escalated: 4, tokens: 0 } } }
  expect(recommend(old, 'c', 'haiku', 9 * HALF_LIFE_MS)).toBe('sonnet')
  const next = record(old, 'c', 'haiku', false, 0, false, 9 * HALF_LIFE_MS)
  expect(next['c']!.haiku!.runs).toBe(7)
  expect(next['c']!.haiku!.updatedAt).toBe(9 * HALF_LIFE_MS)
})

test('decay never mutates the input stats', async () => {
  const t0 = 1_000_000
  const st: Stats = { c: { haiku: { runs: 6, escalated: 4, tokens: 0, updatedAt: t0 } } }
  const snap = JSON.stringify(st)
  recommend(st, 'c', 'haiku', t0 + 5 * HALF_LIFE_MS)
  record(st, 'c', 'haiku', true, 0, false, t0 + 5 * HALF_LIFE_MS)
  expect(JSON.stringify(st)).toBe(snap)
})

test('a clock that went backwards does not inflate counters', async () => {
  const st: Stats = { c: { haiku: { runs: 6, escalated: 4, tokens: 0, updatedAt: 1000 } } }
  const next = record(st, 'c', 'haiku', false, 0, false, 10)
  expect(next['c']!.haiku!.runs).toBe(7)
})

test('categorizes by agent type and task keywords', async () => {
  expect(categorize('general-purpose', 'Fix the login bug')).toBe('general-purpose:bugfix')
  expect(categorize('Explore', 'map the repo')).toBe('Explore:other')
})

test('keeps the requested tier without enough evidence', async () => {
  let st: Stats = {}
  for (let i = 0; i < 4; i++) st = record(st, 'c', 'haiku', true, 100)
  expect(recommend(st, 'c', 'haiku')).toBe('haiku')
})

test('raises the tier when the cheap one escalates too often', async () => {
  let st: Stats = {}
  for (let i = 0; i < 6; i++) st = record(st, 'c', 'haiku', i < 4, 100)
  expect(recommend(st, 'c', 'haiku')).toBe('sonnet')
  for (let i = 0; i < 6; i++) st = record(st, 'c', 'sonnet', i < 1, 100)
  expect(recommend(st, 'c', 'haiku')).toBe('sonnet')
})

test('a failed verification counts like an escalation for the recommendation', async () => {
  let st: Stats = {}
  for (let i = 0; i < 6; i++) st = record(st, 'c', 'haiku', false, 100, i < 4)
  expect(st['c']!.haiku!.failedVerify).toBe(4)
  expect(st['c']!.haiku!.escalated).toBe(0)
  expect(recommend(st, 'c', 'haiku')).toBe('sonnet')
})

test('a run both escalated and failing verification is one rejected run', async () => {
  const st = record({}, 'c', 'haiku', true, 0, true)
  expect(st['c']!.haiku!.notAccepted).toBe(1)
  expect(st['c']!.haiku!.escalated).toBe(1)
  expect(st['c']!.haiku!.failedVerify).toBe(1)
})

test('stats stored before verification existed stay readable', async () => {
  const old: Stats = { c: { haiku: { runs: 6, escalated: 4, tokens: 0 } } }
  expect(recommend(old, 'c', 'haiku')).toBe('sonnet')
  const next = record(old, 'c', 'haiku', false, 0, true)
  expect(next['c']!.haiku!.notAccepted).toBe(5)
  expect(next['c']!.haiku!.runs).toBe(7)
})

test('formatStats shows counters with one decimal when fractional and the age of each cell', async () => {
  const t0 = 10 * DAY
  const st: Stats = {
    'a/b': {
      haiku: { runs: 2.5, escalated: 1, tokens: 0, failedVerify: 0.5, updatedAt: t0 - 3 * DAY },
      sonnet: { runs: 4, escalated: 0, tokens: 0 },
    },
  }
  const out = formatStats(st, t0)
  expect(out).toContain('a/b')
  expect(out).toContain('haiku: 2.5 runs, 1 escalated, 0.5 failed verify (updated 3 d ago)')
  expect(out).toContain('sonnet: 4 runs, 0 escalated')
  expect(out).not.toContain('sonnet: 4 runs, 0 escalated (')
  expect(formatStats({}, t0)).toBe('No stats yet.')
})

test('formatStats ages: minutes, hours, days, and no age without a clock', async () => {
  const mk = (age: number): Stats => ({ c: { haiku: { runs: 1, escalated: 0, tokens: 0, updatedAt: 1_000_000_000 } } })
  expect(formatStats(mk(0), 1_000_000_000 + 30_000)).toContain('(updated just now)')
  expect(formatStats(mk(0), 1_000_000_000 + 5 * 60_000)).toContain('(updated 5 min ago)')
  expect(formatStats(mk(0), 1_000_000_000 + 7 * 3_600_000)).toContain('(updated 7 h ago)')
  expect(formatStats(mk(0))).not.toContain('updated')
})

// --- Exploration ---

// `bad` of `runs` recorded at `at` for one tier.
function cell(st: Stats, tier: 'haiku' | 'sonnet' | 'opus', runs: number, bad: number, at?: number): Stats {
  for (let i = 0; i < runs; i++) st = record(st, 'c', tier, i < bad, 0, false, at)
  return st
}

// Share of `n` seeded draws that explored.
function exploreRate(st: Stats, n: number, opts: { explore?: number; now?: number } = {}, seed = 42): number {
  const rand = mulberry32(seed)
  let hits = 0
  for (let i = 0; i < n; i++) if (recommendWithExploration(st, 'c', 'haiku', { ...opts, rand }).reason === 'explore') hits++
  return hits / n
}

test('mulberry32 is deterministic per seed and stays in [0, 1)', async () => {
  const a = mulberry32(7), b = mulberry32(7), c = mulberry32(8)
  const xs = Array.from({ length: 1000 }, () => a())
  expect(xs.every((x, i) => x === b() && x >= 0 && x < 1)).toBe(true)
  expect(xs[0] === c()).toBe(false)
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length
  expect(Math.abs(mean - 0.5)).toBeLessThan(0.05)
})

test('without a random source exploration matches recommend and explains itself', async () => {
  const none: Stats = {}
  expect(recommendWithExploration(none, 'c', 'haiku')).toEqual({ tier: 'haiku', reason: 'requested', learned: 'haiku' })
  const raised = cell({}, 'haiku', 6, 4)
  expect(recommendWithExploration(raised, 'c', 'haiku')).toEqual({ tier: 'sonnet', reason: 'raised', learned: 'sonnet' })
  expect(recommendWithExploration(raised, 'c', 'haiku').tier).toBe(recommend(raised, 'c', 'haiku'))
  const both = cell(cell({}, 'haiku', 6, 4), 'sonnet', 6, 4)
  expect(recommendWithExploration(both, 'c', 'haiku').tier).toBe(recommend(both, 'c', 'haiku'))
})

test('the chance that a tier is good enough is the Beta posterior of its failure rate below the threshold', async () => {
  // posterior of the failure rate with a uniform prior: Beta(notAccepted + 1, accepted + 1)
  // 6 runs, 4 not accepted: Beta(5, 3) at 0.4 = P(Bin(7, 0.4) >= 5) = 0.096256
  const st = cell({}, 'haiku', 6, 4)
  expect(Math.abs(goodEnoughChance(st['c']!.haiku!) - 0.096256)).toBeLessThan(1e-6)
  // 7 runs, 4 not accepted: Beta(5, 4) at 0.4 = P(Bin(8, 0.4) >= 5) = 0.1736704
  expect(Math.abs(goodEnoughChance(cell({}, 'haiku', 7, 4)['c']!.haiku!) - 0.1736704)).toBeLessThan(1e-6)
  // no evidence: uniform prior, P(p <= 0.4) = 0.4
  expect(Math.abs(goodEnoughChance({ runs: 0, escalated: 0, tokens: 0 }) - 0.4)).toBeLessThan(1e-9)
})

test('with a seed the exploration rate matches the posterior chance', async () => {
  const st = cell({}, 'haiku', 6, 4)
  const rate = exploreRate(st, 20_000)
  expect(Math.abs(rate - 0.096256)).toBeLessThan(0.01)
  const r1 = exploreRate(st, 2000, {}, 3), r2 = exploreRate(st, 2000, {}, 3)
  expect(r1).toBe(r2)
})

test('the explore weight scales the exploration rate and zero turns it off', async () => {
  const st = cell({}, 'haiku', 6, 4)
  expect(Math.abs(exploreRate(st, 20_000, { explore: 0.5 }) - 0.048128)).toBeLessThan(0.008)
  expect(exploreRate(st, 5000, { explore: 0 })).toBe(0)
})

test('an explored run starts on the cheaper tier with reason explore', async () => {
  const st = cell({}, 'haiku', 6, 4)
  expect(recommendWithExploration(st, 'c', 'haiku', { rand: () => 0 })).toEqual({ tier: 'haiku', reason: 'explore', learned: 'sonnet' })
  expect(recommendWithExploration(st, 'c', 'haiku', { rand: () => 0.999 })).toEqual({ tier: 'sonnet', reason: 'raised', learned: 'sonnet' })
})

test('exploration never goes below the requested tier', async () => {
  // sonnet requested and bad, haiku never tried: the rule raises to opus, exploration may only go back to sonnet
  const st = cell({}, 'sonnet', 6, 5)
  for (const u of [0, 0.01, 0.5, 0.999]) {
    const r = recommendWithExploration(st, 'c', 'sonnet', { rand: () => u })
    expect(r.tier === 'haiku').toBe(false)
  }
  expect(recommendWithExploration(st, 'c', 'sonnet', { rand: () => 0 }).tier).toBe('sonnet')
  // nothing raised: no exploration at all, the random source is not even consumed
  let calls = 0
  const r = recommendWithExploration(cell({}, 'haiku', 6, 0), 'c', 'sonnet', { rand: () => { calls++; return 0 } })
  expect(r).toEqual({ tier: 'sonnet', reason: 'requested', learned: 'sonnet' })
  expect(calls).toBe(0)
})

test('with two raised tiers exploration tries the cheapest first, then the next', async () => {
  const st = cell(cell({}, 'haiku', 6, 4), 'sonnet', 6, 4)
  expect(recommend(st, 'c', 'haiku')).toBe('opus')
  const seq = (...us: number[]) => { let i = 0; return () => us[i++] ?? 0.999 }
  expect(recommendWithExploration(st, 'c', 'haiku', { rand: seq(0) }).tier).toBe('haiku')
  expect(recommendWithExploration(st, 'c', 'haiku', { rand: seq(0.999, 0) })).toEqual({ tier: 'sonnet', reason: 'explore', learned: 'opus' })
  expect(recommendWithExploration(st, 'c', 'haiku', { rand: seq(0.999, 0.999) }).reason).toBe('raised')
})

test('strong recent evidence of failure makes exploration vanishingly rare', async () => {
  const st = cell({}, 'haiku', 20, 18)
  expect(goodEnoughChance(st['c']!.haiku!)).toBeLessThan(1e-5)
  expect(exploreRate(st, 20_000)).toBeLessThan(1e-3)
})

test('old evidence is explored more often than fresh evidence', async () => {
  const t0 = 1_000_000
  const st = cell({}, 'haiku', 12, 8, t0)
  const fresh = goodEnoughChance(st['c']!.haiku!, t0)
  const old = goodEnoughChance(st['c']!.haiku!, t0 + HALF_LIFE_MS)
  expect(old > fresh).toBe(true)
  expect(recommendWithExploration(st, 'c', 'haiku', { now: t0 + HALF_LIFE_MS }).reason).toBe('raised')
  expect(exploreRate(st, 20_000, { now: t0 + HALF_LIFE_MS }) > exploreRate(st, 20_000, { now: t0 })).toBe(true)
})

test('a broken random source never explores', async () => {
  const st = cell({}, 'haiku', 6, 4)
  expect(recommendWithExploration(st, 'c', 'haiku', { rand: () => NaN }).reason).toBe('raised')
  expect(recommendWithExploration(st, 'c', 'haiku', { rand: () => 0, explore: NaN }).reason).toBe('raised')
})

// --- Quality: accepted runs and reviews ---

const near = (a: number | undefined, b: number, tol = 1e-9): boolean => a !== undefined && Math.abs(a - b) < tol

test('acceptance: not escalated, verification passed when it ran, review at least 3/5 when sampled', async () => {
  expect(LEARN.minReviewScore).toBe(3)
  expect(isAccepted({ escalated: false })).toBe(true)
  expect(isAccepted({ escalated: true })).toBe(false)
  expect(isAccepted({ escalated: false, verifyFailed: true })).toBe(false)
  expect(isAccepted({ escalated: false, verifyFailed: false, reviewScore: 3 })).toBe(true)
  expect(isAccepted({ escalated: false, reviewScore: 2 })).toBe(false)
  expect(isAccepted({ escalated: false, reviewScore: 4 }, 5)).toBe(false)
  // a score that is not a valid 1-5 verdict is no review at all
  expect(isAccepted({ escalated: false, reviewScore: NaN })).toBe(true)
  expect(isAccepted({ escalated: false, reviewScore: 9 })).toBe(true)
})

test('record counts a run with a review below 3/5 as not accepted, once even when it also escalated', async () => {
  let st = record({}, 'c', 'haiku', false, 0, false, undefined, HALF_LIFE_MS, { reviewScore: 2 })
  expect(st['c']!.haiku!.notAccepted).toBe(1)
  expect(st['c']!.haiku!.escalated).toBe(0)
  st = record(st, 'c', 'haiku', true, 0, true, undefined, HALF_LIFE_MS, { reviewScore: 1 })
  expect(st['c']!.haiku!.notAccepted).toBe(2)
  st = record(st, 'c', 'haiku', false, 0, false, undefined, HALF_LIFE_MS, { reviewScore: 3 })
  expect(st['c']!.haiku!.notAccepted).toBe(2)
  expect(st['c']!.haiku!.runs).toBe(3)
})

test('record keeps the review counters as they are: they fade from reviewedAt, not from updatedAt', async () => {
  const t0 = 1_000_000
  const st: Stats = { c: { haiku: { runs: 1, escalated: 0, tokens: 0, updatedAt: t0, reviews: 2, reviewScore: 7, reviewedAt: t0 } } }
  const next = record(st, 'c', 'haiku', false, 0, false, t0 + HALF_LIFE_MS)['c']!.haiku!
  expect(next.reviews).toBe(2)
  expect(next.reviewScore).toBe(7)
  expect(next.reviewedAt).toBe(t0)
  expect(near(next.runs, 1.5)).toBe(true)
  // the next review decays them by their own clock: 2 * 0.5 + 1 reviews, 7 * 0.5 + 4 points
  const later = recordReview({ c: { haiku: next } }, 'c', 'haiku', 4, { now: t0 + HALF_LIFE_MS })['c']!.haiku!
  expect(near(later.reviews, 2)).toBe(true)
  expect(near(later.reviewScore, 7.5)).toBe(true)
  expect(later.reviewedAt).toBe(t0 + HALF_LIFE_MS)
  // a cell stored before reviews existed gains no review fields from a run
  const old = record({ c: { haiku: { runs: 6, escalated: 4, tokens: 0 } } }, 'c', 'haiku', false, 0)['c']!.haiku!
  expect(old.reviews).toBeUndefined()
  expect(old.cost).toBeUndefined()
})

test('a late review below 3/5 turns one accepted run into a not-accepted one, once', async () => {
  const t0 = 1_000_000
  let st = record({}, 'c', 'haiku', false, 0, false, t0)
  st = record(st, 'c', 'haiku', false, 0, false, t0)
  expect(st['c']!.haiku!.notAccepted).toBe(0)
  // the run was recorded as accepted: the low score flips it
  st = recordReview(st, 'c', 'haiku', 2, { now: t0, runAccepted: true, runAt: t0 })
  expect(st['c']!.haiku!.notAccepted).toBe(1)
  expect(st['c']!.haiku!.runs).toBe(2)
  expect(st['c']!.haiku!.reviews).toBe(1)
  // the same run reviewed again: it is no longer accepted, nothing more to flip
  st = recordReview(st, 'c', 'haiku', 1, { now: t0, runAccepted: false })
  expect(st['c']!.haiku!.notAccepted).toBe(1)
  expect(st['c']!.haiku!.reviews).toBe(2)
  // a good score never flips anything
  st = recordReview(st, 'c', 'haiku', 4, { now: t0, runAccepted: true })
  expect(st['c']!.haiku!.notAccepted).toBe(1)
  // and a flip can never push the not-accepted runs above the runs
  st = recordReview(st, 'c', 'haiku', 1, { now: t0, runAccepted: true })
  st = recordReview(st, 'c', 'haiku', 1, { now: t0, runAccepted: true })
  expect(st['c']!.haiku!.notAccepted).toBe(2)
})

test('a review that lands before its run is recorded counts once, through record', async () => {
  let st = recordReview({}, 'c', 'haiku', 2, { now: 5 })
  expect(st['c']!.haiku!.runs).toBe(0)
  expect(st['c']!.haiku!.reviews).toBe(1)
  expect(st['c']!.haiku!.notAccepted ?? 0).toBe(0)
  st = record(st, 'c', 'haiku', false, 0, false, 5, HALF_LIFE_MS, { reviewScore: 2 })
  expect(st['c']!.haiku!.runs).toBe(1)
  expect(st['c']!.haiku!.notAccepted).toBe(1)
  expect(st['c']!.haiku!.reviews).toBe(1)
  expect(st['c']!.haiku!.reviewScore).toBe(2)
})

test('a late flip weighs the run as much as decay left of it: half after one half-life', async () => {
  const t0 = 1_000_000
  const st = recordReview(record({}, 'c', 'haiku', false, 0, false, t0), 'c', 'haiku', 1, { now: t0 + HALF_LIFE_MS, runAccepted: true, runAt: t0 })
  const c = st['c']!.haiku!
  expect(near(c.runs, 0.5)).toBe(true)
  expect(near(c.notAccepted, 0.5)).toBe(true)
  expect(c.updatedAt).toBe(t0 + HALF_LIFE_MS)
})

test('a low review flips enough runs to raise the tier through the not-accepted rate', async () => {
  // 6 runs, 2 escalated (33%): haiku stays; two accepted runs reviewed 2/5 make it 4 of 6 (67%)
  let st: Stats = {}
  for (let i = 0; i < 6; i++) st = record(st, 'c', 'haiku', i < 2, 0)
  expect(recommend(st, 'c', 'haiku')).toBe('haiku')
  st = recordReview(st, 'c', 'haiku', 2, { runAccepted: true })
  st = recordReview(st, 'c', 'haiku', 2, { runAccepted: true })
  expect(recommend(st, 'c', 'haiku')).toBe('sonnet')
})

test('recordReview ignores an invalid score and never mutates its input', async () => {
  const st = record({}, 'c', 'haiku', false, 0)
  const snap = JSON.stringify(st)
  expect(recordReview(st, 'c', 'haiku', NaN, { runAccepted: true })).toEqual(st)
  expect(recordReview(st, 'c', 'haiku', 0, { runAccepted: true })).toEqual(st)
  recordReview(st, 'c', 'haiku', 1, { runAccepted: true, now: 10 })
  expect(JSON.stringify(st)).toBe(snap)
})

// --- Cost per accepted run ---

// `runs` runs on `tier` at `usd` each, the first `accepted` accepted and the rest escalated.
function priced(st: Stats, tier: 'haiku' | 'sonnet' | 'opus', runs: number, accepted: number, usd: number, at?: number): Stats {
  for (let i = 0; i < runs; i++) st = record(st, 'c', tier, i >= accepted, 0, false, at, HALF_LIFE_MS, { cost: usd })
  return st
}

test('record adds the run cost to decayed cost and priced runs; a run without cost leaves them', async () => {
  const t0 = 1_000_000
  let st = record({}, 'c', 'haiku', false, 0, false, t0, HALF_LIFE_MS, { cost: 0.2 })
  st = record(st, 'c', 'haiku', false, 0, false, t0)
  let c = st['c']!.haiku!
  expect(near(c.cost, 0.2)).toBe(true)
  expect(c.costRuns).toBe(1)
  expect(c.runs).toBe(2)
  st = record(st, 'c', 'haiku', false, 0, false, t0 + HALF_LIFE_MS, HALF_LIFE_MS, { cost: 0.4 })
  c = st['c']!.haiku!
  expect(near(c.cost, 0.5)).toBe(true)
  expect(near(c.costRuns, 1.5)).toBe(true)
  // a cost that is not a finite non-negative number is not recorded
  const bad = record({}, 'c', 'haiku', false, 0, false, t0, HALF_LIFE_MS, { cost: -1 })['c']!.haiku!
  expect(bad.cost).toBeUndefined()
  expect(bad.costRuns).toBeUndefined()
})

test('cost per accepted run: 10 runs at $0.10 with 8 accepted cost 0.10 / (9 / 12) = $0.1333', async () => {
  const c = priced({}, 'haiku', 10, 8, 0.1)['c']!.haiku!
  expect(near(costPerAccepted(c), 0.1 / (9 / 12))).toBe(true)
  // fewer than 5 priced runs: no estimate
  expect(costPerAccepted(priced({}, 'haiku', 4, 4, 0.1)['c']!.haiku!)).toBeUndefined()
  const unpriced: Cell = { runs: 10, escalated: 0, tokens: 0 }
  expect(costPerAccepted(unpriced)).toBeUndefined()
  // decay lowers the priced runs below the threshold
  const t0 = 1_000_000
  expect(costPerAccepted(priced({}, 'haiku', 8, 8, 0.1, t0)['c']!.haiku!, t0 + HALF_LIFE_MS)).toBeUndefined()
})

test('cost picks haiku at $0.10/run with 5 of 10 accepted ($0.20 per accepted) over sonnet at $0.40/run with 10 of 10 ($0.44), though haiku fails 50%', async () => {
  const st = priced(priced({}, 'haiku', 10, 5, 0.1), 'sonnet', 10, 10, 0.4)
  expect(recommend(st, 'c', 'haiku')).toBe('haiku')
  expect(recommend(st, 'c', 'haiku', undefined, HALF_LIFE_MS, false)).toBe('sonnet')
  expect(recommendWithExploration(st, 'c', 'haiku')).toEqual({ tier: 'haiku', reason: 'requested', learned: 'haiku', basis: 'cost' })
})

test('cost picks sonnet when haiku at $0.10/run accepts 1 of 10 ($0.60 per accepted) and sonnet at $0.40/run accepts 10 of 10 ($0.44)', async () => {
  const st = priced(priced({}, 'haiku', 10, 1, 0.1), 'sonnet', 10, 10, 0.4)
  expect(recommend(st, 'c', 'haiku')).toBe('sonnet')
  expect(recommendWithExploration(st, 'c', 'haiku')).toEqual({ tier: 'sonnet', reason: 'raised', learned: 'sonnet', basis: 'cost' })
})

test('cost raises haiku at $0.40/run with 7 of 10 accepted ($0.60 per accepted) to sonnet at $0.30/run with 10 of 10 ($0.33), though the rule keeps haiku', async () => {
  const st = priced(priced({}, 'haiku', 10, 7, 0.4), 'sonnet', 10, 10, 0.3)
  expect(recommend(st, 'c', 'haiku', undefined, HALF_LIFE_MS, false)).toBe('haiku')
  expect(recommend(st, 'c', 'haiku')).toBe('sonnet')
})

test('a cheaper tier must beat the rule by the 10% margin: haiku $0.42 per accepted vs sonnet $0.44 keeps sonnet', async () => {
  expect(LEARN.costMargin).toBe(0.1)
  const st = priced(priced({}, 'haiku', 10, 5, 0.21), 'sonnet', 10, 10, 0.4)
  expect(recommend(st, 'c', 'haiku')).toBe('sonnet')
})

test('scarce cost data falls back to the failure-rate rule', async () => {
  // sonnet has only 3 priced runs: the comparison is not made
  const thin = priced(priced({}, 'haiku', 10, 5, 0.1), 'sonnet', 3, 3, 0.4)
  expect(recommend(thin, 'c', 'haiku')).toBe('sonnet')
  expect(recommendWithExploration(thin, 'c', 'haiku')).toEqual({ tier: 'sonnet', reason: 'raised', learned: 'sonnet' })
  // sonnet never ran: same
  const none = priced({}, 'haiku', 10, 5, 0.1)
  expect(recommend(none, 'c', 'haiku')).toBe('sonnet')
  // haiku and sonnet priced, both bad by the rule, opus unknown: the rule climbs to opus
  const top = priced(priced({}, 'haiku', 10, 2, 0.1), 'sonnet', 10, 5, 0.3)
  expect(recommend(top, 'c', 'haiku')).toBe('opus')
  // sonnet's 6 priced runs fade to 4.2 after half a half-life: the comparison stops, the rule raises haiku (7.1 runs, 50%)
  const t0 = 1_000_000
  const faded = priced(priced({}, 'haiku', 10, 5, 0.1, t0), 'sonnet', 6, 6, 0.4, t0)
  expect(recommend(faded, 'c', 'haiku', t0)).toBe('haiku')
  expect(recommend(faded, 'c', 'haiku', t0 + HALF_LIFE_MS / 2)).toBe('sonnet')
})

test('the cost rule never goes below the requested tier', async () => {
  const st = priced(priced(priced({}, 'haiku', 10, 10, 0.01), 'sonnet', 10, 10, 0.4), 'opus', 10, 10, 1)
  expect(recommend(st, 'c', 'sonnet')).toBe('sonnet')
  expect(recommend(st, 'c', 'opus')).toBe('opus')
})

test('in cost mode exploration tries haiku with the chance its cost per accepted run beats the chosen tier', async () => {
  // haiku $0.10/run, 1 of 10 accepted; sonnet $0.40/run, 10 of 10: sonnet costs 0.4 * 12 / 11 per accepted run.
  // haiku beats that when its acceptance exceeds 0.1 / E, i.e. its failure rate is below x = 1 - 0.1 / E.
  // failure ~ Beta(10, 2): P(fail <= x) = P(Bin(11, x) >= 10) = 11 x^10 (1 - x) + x^11 (about 0.244).
  const st = priced(priced({}, 'haiku', 10, 1, 0.1), 'sonnet', 10, 10, 0.4)
  const x = 1 - 0.1 / (0.4 * 12 / 11)
  const chance = 11 * x ** 10 * (1 - x) + x ** 11
  expect(Math.abs(chance - 0.244) < 0.001).toBe(true)
  expect(recommendWithExploration(st, 'c', 'haiku', { rand: () => chance - 0.001 })).toEqual({ tier: 'haiku', reason: 'explore', learned: 'sonnet', basis: 'cost' })
  expect(recommendWithExploration(st, 'c', 'haiku', { rand: () => chance + 0.001 })).toEqual({ tier: 'sonnet', reason: 'raised', learned: 'sonnet', basis: 'cost' })
  expect(recommendWithExploration(st, 'c', 'haiku', { rand: () => 0, byCost: false }).basis).toBeUndefined()
})
