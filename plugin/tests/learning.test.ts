import { expect, test } from 'claude-code/testing'
import {
  categorize, formatStats, goodEnoughChance, HALF_LIFE_MS, mulberry32, recommend, recommendWithExploration, record, type Stats,
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
