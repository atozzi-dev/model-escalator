import { expect, test } from 'claude-code/testing'
import {
  ADVICE, downshiftAdvice, formatAdvice, hintLine, markHinted, pickHint, priceRatio, type Advice,
} from '../hooks/advice'
import { DEFAULT_PRICES } from '../hooks/config'
import type { Tier } from '../hooks/detector'
import { HALF_LIFE_MS, record, recordReview, type Projects, type Stats } from '../hooks/learning'

const T0 = 1_000_000_000
const DAY = 24 * 60 * 60 * 1000
const close = (a: number | undefined, b: number, eps = 1e-6): boolean => a !== undefined && Math.abs(a - b) < eps

// `n` runs of `category` on `tier` at T0, the first `bad` of them escalated, each costing `cost` USD.
function runs(stats: Stats, category: string, tier: Tier, n: number, bad = 0, cost?: number, at = T0): Stats {
  let st = stats
  for (let i = 0; i < n; i++) st = record(st, category, tier, i < bad, 0, false, at, HALF_LIFE_MS, cost !== undefined ? { cost } : {})
  return st
}

// --- thresholds ---

test('a category that never got stuck in enough runs on opus gets a sonnet suggestion', async () => {
  const st = runs({}, 'coder:feature', 'opus', 18, 0, 0.94)
  const list = downshiftAdvice(st, { now: T0, verify: true })
  expect(list.length).toBe(1)
  const a = list[0]!
  expect(a.category).toBe('coder:feature')
  expect(a.tier).toBe('opus')
  expect(a.suggested).toBe('sonnet')
  expect(a.scope).toBe('global')
  expect(close(a.runs, 18)).toBe(true)
  expect(a.escalationRate).toBe(0)
  expect(a.notAcceptedRate).toBe(0)
  expect(close(a.costNow, 0.94)).toBe(true)
  expect(close(a.costCheaper, 0.47)).toBe(true)
  expect(close(a.priceRatio, 0.5)).toBe(true)
  // no sonnet run yet: guarded by the verifyCommand, not measured, so not strong
  expect(a.quality).toBe('guarded')
  expect(a.strength).toBe('moderate')
})

test('fewer than the minimum runs gives no advice', async () => {
  const st = runs({}, 'c', 'opus', ADVICE.minRuns - 1)
  expect(downshiftAdvice(st, { now: T0 }).length).toBe(0)
  expect(downshiftAdvice(runs({}, 'c', 'opus', ADVICE.minRuns), { now: T0 }).length).toBe(1)
})

test('many runs on the current tier alone never make a suggestion strong', async () => {
  expect(downshiftAdvice(runs({}, 'c:feature', 'opus', 12), { now: T0, verify: true })[0]!.strength).toBe('moderate')
  expect(downshiftAdvice(runs({}, 'c:feature', 'opus', 60), { now: T0, verify: true })[0]!.strength).toBe('moderate')
})

test('an escalation rate above the bar gives no advice', async () => {
  // 1 of 10 escalated: 10% > 5%
  expect(downshiftAdvice(runs({}, 'c', 'opus', 10, 1), { now: T0 }).length).toBe(0)
  // 1 of 20 escalated: 5%, at the bar, still advised
  const ok = downshiftAdvice(runs({}, 'c', 'opus', 20, 1), { now: T0 })
  expect(ok.length).toBe(1)
  expect(close(ok[0]!.escalationRate, 0.05)).toBe(true)
})

test('a not-accepted rate above the bar gives no advice', async () => {
  let st: Stats = {}
  // 2 of 12 failed verification: 16.7% not accepted, no escalation
  for (let i = 0; i < 12; i++) st = record(st, 'c', 'opus', false, 0, i < 2, T0)
  expect(downshiftAdvice(st, { now: T0 }).length).toBe(0)
  let ok: Stats = {}
  for (let i = 0; i < 12; i++) ok = record(ok, 'c', 'opus', false, 0, i < 1, T0)
  const list = downshiftAdvice(ok, { now: T0 })
  expect(list.length).toBe(1)
  expect(close(list[0]!.notAcceptedRate, 1 / 12)).toBe(true)
})

test('haiku is never advised down', async () => {
  expect(downshiftAdvice(runs({}, 'c', 'haiku', 40), { now: T0 }).length).toBe(0)
})

test('sonnet is advised down to haiku, one step only from opus', async () => {
  const s = downshiftAdvice(runs({}, 'c', 'sonnet', 10, 0, 0.2), { now: T0 })[0]!
  expect(s.suggested).toBe('haiku')
  expect(close(s.costCheaper, 0.2 * (0.6 / 12))).toBe(true)
  const o = downshiftAdvice(runs({}, 'c', 'opus', 30), { now: T0 })[0]!
  expect(o.suggested).toBe('sonnet')
})

// --- decay ---

test('old runs decay below the minimum and the advice goes away', async () => {
  const st = runs({}, 'c', 'opus', 10, 0, 0.5)
  expect(downshiftAdvice(st, { now: T0 }).length).toBe(1)
  expect(downshiftAdvice(st, { now: T0 + HALF_LIFE_MS }).length).toBe(0)
  // a longer half-life keeps them
  expect(downshiftAdvice(st, { now: T0 + HALF_LIFE_MS, halfLifeMs: 10 * HALF_LIFE_MS }).length).toBe(1)
})

test('the reported run count is the decayed one', async () => {
  const st = runs({}, 'c', 'opus', 40)
  const a = downshiftAdvice(st, { now: T0 + HALF_LIFE_MS })[0]!
  expect(close(a.runs, 20)).toBe(true)
})

// --- the cheaper tier already failing ---

test('a cheaper tier that fails this category blocks the advice', async () => {
  let st = runs({}, 'c', 'opus', 20)
  st = runs(st, 'c', 'sonnet', 3, 1)  // 33% not accepted on sonnet
  expect(downshiftAdvice(st, { now: T0 }).length).toBe(0)
})

test('a single failed run on the cheaper tier is not enough evidence to block', async () => {
  let st = runs({}, 'c', 'opus', 20)
  st = runs(st, 'c', 'sonnet', 1, 1)
  expect(downshiftAdvice(st, { now: T0 }).length).toBe(1)
})

test('a cheaper tier learning would climb over blocks the advice', async () => {
  let st = runs({}, 'c', 'opus', 20)
  st = runs(st, 'c', 'sonnet', 10, 5)
  expect(downshiftAdvice(st, { now: T0 }).length).toBe(0)
})

test('a cheaper tier with poor reviews blocks the advice', async () => {
  let st = runs({}, 'c', 'opus', 20)
  st = recordReview(st, 'c', 'sonnet', 2, { now: T0 })
  st = recordReview(st, 'c', 'sonnet', 2, { now: T0 })
  expect(downshiftAdvice(st, { now: T0 }).length).toBe(0)
})

test('a cheaper tier that proved itself makes the advice strong and is reported', async () => {
  let st = runs({}, 'c:feature', 'opus', 9)
  st = runs(st, 'c:feature', 'sonnet', 6)
  const a = downshiftAdvice(st, { now: T0 }).find((x) => x.tier === 'opus')!
  expect(a.strength).toBe('strong')
  expect(close(a.cheaperRuns, 6)).toBe(true)
})

test('one suggestion per category, for the tier with the most runs', async () => {
  let st = runs({}, 'c', 'opus', 20)
  st = runs(st, 'c', 'sonnet', 9)
  const list = downshiftAdvice(st, { now: T0 })
  expect(list.length).toBe(1)
  expect(list[0]!.tier).toBe('opus')
})

// --- reviews ---

test('a review mean below the bar on the current tier blocks the advice', async () => {
  let st = runs({}, 'c', 'opus', 20)
  st = recordReview(st, 'c', 'opus', 2, { now: T0 })
  st = recordReview(st, 'c', 'opus', 2, { now: T0 })
  expect(downshiftAdvice(st, { now: T0 }).length).toBe(0)
  // a stricter bar from the options
  let good = runs({}, 'c', 'opus', 20)
  good = recordReview(good, 'c', 'opus', 4, { now: T0 })
  expect(downshiftAdvice(good, { now: T0 }).length).toBe(1)
  expect(downshiftAdvice(good, { now: T0, minReviewScore: 5 }).length).toBe(0)
})

test('the review mean and count are reported', async () => {
  let st = runs({}, 'c', 'opus', 20)
  st = recordReview(st, 'c', 'opus', 4, { now: T0 })
  st = recordReview(st, 'c', 'opus', 5, { now: T0 })
  const a = downshiftAdvice(st, { now: T0 })[0]!
  expect(close(a.reviewMean, 4.5)).toBe(true)
  expect(close(a.reviews, 2)).toBe(true)
  expect(downshiftAdvice(runs({}, 'c', 'opus', 20), { now: T0 })[0]!.reviewMean).toBe(undefined)
})

// --- project vs global ---

test('a project cell with enough runs replaces the global one', async () => {
  const global = runs({}, 'c', 'opus', 20)
  const projects: Projects = { p1: { stats: runs({}, 'c', 'opus', 6, 3), seenAt: T0 } }
  expect(downshiftAdvice(global, { now: T0, projects, projectKey: 'p1' }).length).toBe(0)
  // another project, or none, reads the global table
  expect(downshiftAdvice(global, { now: T0, projects, projectKey: 'p2' }).length).toBe(1)
  expect(downshiftAdvice(global, { now: T0, projects }).length).toBe(1)
})

test('a project with too few runs falls back to the global cell', async () => {
  const global = runs({}, 'c', 'opus', 20)
  const projects: Projects = { p1: { stats: runs({}, 'c', 'opus', 3, 3), seenAt: T0 } }
  const a = downshiftAdvice(global, { now: T0, projects, projectKey: 'p1' })
  expect(a.length).toBe(1)
  expect(a[0]!.scope).toBe('global')
})

test('a good project cell gives project-scoped advice even when the global one is poor', async () => {
  const global = runs({}, 'c', 'opus', 20, 10)
  const projects: Projects = { p1: { stats: runs({}, 'c', 'opus', 10), seenAt: T0 } }
  const a = downshiftAdvice(global, { now: T0, projects, projectKey: 'p1' })
  expect(a.length).toBe(1)
  expect(a[0]!.scope).toBe('project')
})

test('a category known only to the project is considered', async () => {
  const projects: Projects = { p1: { stats: runs({}, 'only-here:other', 'opus', 10), seenAt: T0 } }
  const a = downshiftAdvice({}, { now: T0, projects, projectKey: 'p1' })
  expect(a.length).toBe(1)
  expect(a[0]!.category).toBe('only-here:other')
})

// --- prices ---

test('price ratio follows input and output prices', async () => {
  expect(close(priceRatio('opus', 'sonnet'), 0.5)).toBe(true)
  expect(close(priceRatio('sonnet', 'haiku'), 0.05)).toBe(true)
})

test('custom prices change the estimate and a tier that is not cheaper is never advised', async () => {
  const st = runs({}, 'c', 'opus', 20, 0, 1)
  const prices = { ...DEFAULT_PRICES, sonnet: { ...DEFAULT_PRICES.sonnet, input: 1, output: 5 } }
  expect(close(downshiftAdvice(st, { now: T0, prices })[0]!.costCheaper, 0.25)).toBe(true)
  const same = { ...DEFAULT_PRICES, sonnet: DEFAULT_PRICES.opus }
  expect(downshiftAdvice(st, { now: T0, prices: same }).length).toBe(0)
})

test('a cell without priced runs is advised without a cost estimate', async () => {
  const a = downshiftAdvice(runs({}, 'c', 'opus', 20), { now: T0 })[0]!
  expect(a.costNow).toBe(undefined)
  expect(a.costCheaper).toBe(undefined)
})

// --- order ---

test('strong suggestions come first, then the largest estimated saving', async () => {
  let st = runs({}, 'small:feature', 'opus', 20, 0, 0.1)
  st = runs(st, 'big:feature', 'opus', 20, 0, 1)
  st = runs(st, 'weak:feature', 'opus', 10, 0, 5)
  // small and big already ran cleanly on sonnet: measured, strong; weak did not
  st = runs(st, 'small:feature', 'sonnet', 5)
  st = runs(st, 'big:feature', 'sonnet', 5)
  const list = downshiftAdvice(st, { now: T0, verify: true })
  expect(list.map((a) => a.category).join(',')).toBe('big:feature,small:feature,weak:feature')
})

// --- malformed input ---

test('empty and malformed stats give no advice and never throw', async () => {
  const junk: unknown[] = [
    undefined, null, 'x', 42, [], {}, { c: 'str' }, { c: null }, { c: { opus: 'x' } },
    { c: { opus: { runs: 'a', escalated: 0, tokens: 0 } } },
    { c: { opus: { runs: Number.NaN, escalated: 0, tokens: 0 } } },
    { c: { opus: { runs: -20, escalated: 0, tokens: 0 } } },
    { c: { opus: { runs: 20, escalated: -1, tokens: 0 } } },
    { c: { opus: { runs: 20, tokens: 0 } } },
    { c: { gpt: { runs: 20, escalated: 0, tokens: 0 } } },
    { c: { opus: { runs: Infinity, escalated: 0, tokens: 0 } } },
  ]
  for (const j of junk) expect(downshiftAdvice(j, { now: T0 }).length).toBe(0)
  expect(downshiftAdvice({}, { now: T0, projects: 'junk' as unknown as Projects, projectKey: 'p1' }).length).toBe(0)
  expect(downshiftAdvice({}, { now: T0, projects: { p1: { stats: 'x', seenAt: 1 } } as unknown as Projects, projectKey: 'p1' }).length).toBe(0)
})

test('a malformed cost or review field is ignored, not fatal', async () => {
  const st = { c: { opus: { runs: 20, escalated: 0, tokens: 0, cost: 'x', costRuns: 20, reviews: 'y', reviewScore: 3 } } }
  const a = downshiftAdvice(st, { now: T0 })
  expect(a.length).toBe(1)
  expect(a[0]!.costNow).toBe(undefined)
  expect(a[0]!.reviewMean).toBe(undefined)
})

test('a malformed cheaper cell does not block and does not throw', async () => {
  const st = runs({}, 'c', 'opus', 20) as unknown as Record<string, Record<string, unknown>>
  st['c']!['sonnet'] = { runs: 'oops' }
  expect(downshiftAdvice(st, { now: T0 }).length).toBe(1)
})

// --- formatting ---

const sample = (over: Partial<Advice> = {}): Advice => ({
  category: 'security-reviewer:other', tier: 'opus', suggested: 'sonnet', scope: 'global', runs: 18,
  escalationRate: 0, notAcceptedRate: 0, priceRatio: 0.5, costNow: 0.94, costCheaper: 0.47, strength: 'strong',
  quality: 'measured', signal: 'reviews', qualityNote: 'reviews of sonnet runs average 4.6', ...over,
})

test('the hint reads as one short sentence with the estimate', async () => {
  expect(hintLine(sample())).toBe(
    'security-reviewer:other never got stuck in 18 runs on opus (reviews of sonnet runs average 4.6): on sonnet it would ' +
    'cost about $0.47 instead of $0.94 per run. Ask for sonnet in the Agent call, or see /escalator stats.')
})

test('the hint without a cost uses the price ratio', async () => {
  const h = hintLine(sample({ costNow: undefined, costCheaper: undefined }))
  expect(h).toContain('sonnet costs about 50% of opus per token')
  expect(h).not.toContain('$')
})

test('the hint says how often it got stuck when it did', async () => {
  const h = hintLine(sample({ runs: 20, escalationRate: 0.05 }))
  expect(h).toContain('got stuck in 1 of 20 runs on opus')
})

test('formatAdvice lists suggestions, says the figures are estimates and gives a hint', async () => {
  const out = formatAdvice([sample(), sample({ category: 'infra-reviewer:other', runs: 12, strength: 'moderate', reviewMean: 4.25, reviews: 2,
    signal: 'rework', qualityNote: 'no rework by the lead in 6 sonnet runs' })])
  expect(out.lines.length).toBe(2)
  expect(out.lines[0]).toContain('security-reviewer:other: opus -> sonnet')
  expect(out.lines[0]).toContain('about $0.47 instead of $0.94 per run')
  expect(out.lines[1]).toContain('opus runs: reviews average 4.3')
  expect(out.lines[1]).toContain('moderate')
  expect(out.text).toContain('estimate')
  expect(out.text).toContain(out.lines[0]!)
  expect(out.text).not.toContain('respectExplicitModel')
  expect(out.hint).toBe(hintLine(sample()))
})

test('formatAdvice mentions respectExplicitModel only when it is on', async () => {
  expect(formatAdvice([sample()], { respectExplicitModel: true }).text).toContain('respectExplicitModel')
  expect(formatAdvice([sample()], { respectExplicitModel: false }).text).not.toContain('respectExplicitModel')
})

test('formatAdvice gives no hint for moderate suggestions only', async () => {
  const out = formatAdvice([sample({ strength: 'moderate' })])
  expect(out.lines.length).toBe(1)
  expect(out.hint).toBe('')
})

test('formatAdvice of an empty list is empty', async () => {
  expect(formatAdvice([])).toEqual({ text: '', lines: [], hint: '' })
})

test('formatAdvice caps the lines and says how many more', async () => {
  const many = Array.from({ length: ADVICE.maxLines + 3 }, (_, i) => sample({ category: `c${i}:other` }))
  const out = formatAdvice(many)
  expect(out.lines.length).toBe(ADVICE.maxLines)
  expect(out.text).toContain('and 3 more')
})

test('formatAdvice never throws on malformed entries', async () => {
  const out = formatAdvice([null, 'x', { category: 3 }] as unknown as Advice[])
  expect(out).toEqual({ text: '', lines: [], hint: '' })
})

// --- once-per-session hint without repeats ---

test('pickHint returns the first strong suggestion not shown recently', async () => {
  const a = sample()
  const b = sample({ category: 'other:other' })
  expect(pickHint([sample({ strength: 'moderate' })], {}, T0)).toBe(undefined)
  expect(pickHint([a, b], {}, T0)).toBe(a)
  const seen = markHinted({}, a, T0)
  expect(pickHint([a, b], seen, T0 + DAY)).toBe(b)
  expect(pickHint([a], seen, T0 + DAY)).toBe(undefined)
  expect(pickHint([a], seen, T0 + ADVICE.repeatAfterMs)).toBe(a)
})

test('pickHint and markHinted tolerate a malformed seen table', async () => {
  const a = sample()
  expect(pickHint([a], 'junk' as unknown as Record<string, number>, T0)).toBe(a)
  expect(pickHint([a], { [`${a.category}|opus`]: 'x' } as unknown as Record<string, number>, T0)).toBe(a)
  const seen = markHinted(null as unknown as Record<string, number>, a, T0)
  expect(seen[`${a.category}|opus`]).toBe(T0)
})

test('markHinted keeps the table small', async () => {
  let seen: Record<string, number> = {}
  for (let i = 0; i < ADVICE.maxHinted + 10; i++) seen = markHinted(seen, sample({ category: `c${i}` }), T0 + i)
  expect(Object.keys(seen).length).toBe(ADVICE.maxHinted)
  expect(seen[`c${ADVICE.maxHinted + 9}|opus`]).toBe(T0 + ADVICE.maxHinted + 9)
  expect(seen['c0|opus']).toBe(undefined)
})
