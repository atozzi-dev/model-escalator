import { expect, test } from 'claude-code/testing'
import {
  HALF_LIFE_MS, QUALITY, qualityFailures, recommend, recommendWithExploration, record, recordReview, recordRework, type Stats,
} from '../hooks/learning'

// The quality rule: failed verification, a review below the bar and rework climb fast, apart from escalations.

const near = (a: number | undefined, b: number): boolean => typeof a === 'number' && Math.abs(a - b) < 1e-9

// `runs` runs on `tier`, the first `bad` of them failing verification.
function runs(st: Stats, tier: 'haiku' | 'sonnet' | 'opus', n: number, bad: number, at?: number, cost?: number): Stats {
  for (let i = 0; i < n; i++) st = record(st, 'c', tier, false, 0, i < bad, at, HALF_LIFE_MS, cost === undefined ? {} : { cost })
  return st
}

test('the quality rule: above 10% with at least half a failure left after decay', () => {
  expect(QUALITY.maxRate).toBe(0.1)
  expect(QUALITY.minFailures).toBe(0.5)
})

test('one failed verification in a single run climbs at once, without the five runs the failure-rate rule needs', () => {
  const st = runs({}, 'sonnet', 1, 1)
  expect(recommend(st, 'c', 'sonnet')).toBe('opus')
  expect(recommend(st, 'c', 'haiku')).toBe('haiku')
})

test('1 quality failure in 9 runs (11%) climbs, 1 in 10 (10%) does not', () => {
  expect(recommend(runs({}, 'sonnet', 9, 1), 'c', 'sonnet')).toBe('opus')
  expect(recommend(runs({}, 'sonnet', 10, 1), 'c', 'sonnet')).toBe('sonnet')
})

test('escalations are not quality failures: 3 escalated runs in 10 keep the tier', () => {
  let st: Stats = {}
  for (let i = 0; i < 10; i++) st = record(st, 'c', 'sonnet', i < 3, 0)
  expect(qualityFailures(st['c']!.sonnet!)).toBe(0)
  expect(recommend(st, 'c', 'sonnet')).toBe('sonnet')
})

test('a review below the bar counts as a quality failure, in record and when it lands late; once per run', () => {
  let st = record({}, 'c', 'sonnet', false, 0, false, undefined, HALF_LIFE_MS, { reviewScore: 2 })
  expect(st['c']!.sonnet!.qualityFailed).toBe(1)
  // failed verification and a low review on the same run: one failure
  st = record(st, 'c', 'sonnet', true, 0, true, undefined, HALF_LIFE_MS, { reviewScore: 1 })
  expect(st['c']!.sonnet!.qualityFailed).toBe(2)
  // a late low review on a run counted as accepted
  st = record(st, 'c', 'sonnet', false, 0)
  st = recordReview(st, 'c', 'sonnet', 2, { runAccepted: true })
  expect(st['c']!.sonnet!.qualityFailed).toBe(3)
  // an escalated run is not accepted but its quality was fine: a late low review still counts
  st = record(st, 'c', 'sonnet', true, 0)
  st = recordReview(st, 'c', 'sonnet', 2, { runAccepted: false, runQualityOk: true })
  expect(st['c']!.sonnet!.qualityFailed).toBe(4)
  // already a quality failure, or a good score: nothing more
  st = recordReview(st, 'c', 'sonnet', 1, { runAccepted: false, runQualityOk: false })
  st = recordReview(st, 'c', 'sonnet', 5, { runAccepted: true })
  expect(st['c']!.sonnet!.qualityFailed).toBe(4)
  expect(st['c']!.sonnet!.runs).toBe(4)
  // never more quality failures than runs
  st = recordReview(st, 'c', 'sonnet', 1, { runAccepted: true })
  expect(st['c']!.sonnet!.qualityFailed).toBe(4)
})

test('rework counts as a quality failure once, even on a run that was escalated', () => {
  let st = runs({}, 'sonnet', 9, 0)
  st = record(st, 'c', 'sonnet', true, 0)
  expect(recommend(st, 'c', 'sonnet')).toBe('sonnet')
  st = recordRework(st, 'c', 'sonnet', { runAccepted: false, runQualityOk: true })
  expect(st['c']!.sonnet!.qualityFailed).toBe(1)
  expect(st['c']!.sonnet!.reworked).toBe(1)
  // 1 of 10: not above 10%
  expect(recommend(st, 'c', 'sonnet')).toBe('sonnet')
  st = recordRework(st, 'c', 'sonnet', { runAccepted: true })
  expect(st['c']!.sonnet!.qualityFailed).toBe(2)
  expect(recommend(st, 'c', 'sonnet')).toBe('opus')
  // a run already counted as a quality failure only adds to reworked
  st = recordRework(st, 'c', 'sonnet', { runAccepted: false, runQualityOk: false })
  expect(st['c']!.sonnet!.qualityFailed).toBe(2)
  expect(st['c']!.sonnet!.reworked).toBe(3)
})

test('cells stored before the quality counter read failed verifications and rework as quality failures', () => {
  const old: Stats = { c: { sonnet: { runs: 6, escalated: 0, tokens: 0, failedVerify: 1, notAccepted: 1 } } }
  expect(qualityFailures(old['c']!.sonnet!)).toBe(1)
  expect(recommend(old, 'c', 'sonnet')).toBe('opus')
  const next = record(old, 'c', 'sonnet', false, 0)
  expect(next['c']!.sonnet!.qualityFailed).toBe(1)
  expect(qualityFailures({ runs: 2, escalated: 0, tokens: 0, failedVerify: 2, reworked: 2 })).toBe(2)
})

test('a single failure stops counting after about one half-life: the category comes back to the cheaper tier', () => {
  const t0 = 1_000_000
  const st = runs({}, 'sonnet', 3, 1, t0)
  expect(recommend(st, 'c', 'sonnet', t0 + HALF_LIFE_MS * 0.9)).toBe('opus')
  expect(recommend(st, 'c', 'sonnet', t0 + HALF_LIFE_MS * 1.1)).toBe('sonnet')
})

test('exploration never goes back to a tier the quality rule climbed over', () => {
  const st = runs({}, 'sonnet', 3, 1)
  for (const rand of [() => 0, () => 0.5]) {
    expect(recommendWithExploration(st, 'c', 'sonnet', { rand, explore: 1 })).toEqual({ tier: 'opus', reason: 'raised', learned: 'opus' })
  }
  // nor below it: haiku failed by the old rule, sonnet by the quality rule, opus is the floor of exploration
  let two: Stats = {}
  for (let i = 0; i < 6; i++) two = record(two, 'c', 'haiku', i < 4, 0)
  two = runs(two, 'sonnet', 3, 1)
  expect(recommendWithExploration(two, 'c', 'haiku', { rand: () => 0, explore: 1 }).tier).toBe('opus')
})

test('exploration still tries a tier the failure-rate rule climbed over when quality is fine', () => {
  let st: Stats = {}
  for (let i = 0; i < 5; i++) st = record(st, 'c', 'haiku', i < 3, 0)
  expect(recommendWithExploration(st, 'c', 'haiku', { rand: () => 0, explore: 1 }).reason).toBe('explore')
})

test('the cost rule never picks a tier with a quality problem, however cheap', () => {
  // haiku: $0.01 a run, 2 of 10 failing verification (20%, below the 40% of the old rule); sonnet $0.40, clean
  const st = runs(runs({}, 'haiku', 10, 2, undefined, 0.01), 'sonnet', 10, 0, undefined, 0.4)
  expect(recommend(st, 'c', 'haiku', undefined, HALF_LIFE_MS, true)).toBe('sonnet')
  expect(recommend(st, 'c', 'haiku', undefined, HALF_LIFE_MS, false)).toBe('sonnet')
  expect(recommendWithExploration(st, 'c', 'haiku', { rand: () => 0, explore: 1 }).tier).toBe('sonnet')
  // nor a cheaper-per-accepted tier above the rule's that has one
  const top = runs(runs({}, 'sonnet', 10, 0, undefined, 1), 'opus', 10, 2, undefined, 0.01)
  expect(recommend(top, 'c', 'sonnet')).toBe('sonnet')
})

test('a late flip of the quality counter weighs the run as much as decay left of it', () => {
  const t0 = 1_000_000
  const st = recordRework(record({}, 'c', 'sonnet', false, 0, false, t0), 'c', 'sonnet', { now: t0 + HALF_LIFE_MS, runAccepted: true, runAt: t0 })
  const c = st['c']!.sonnet!
  expect(near(c.runs, 0.5)).toBe(true)
  expect(near(c.qualityFailed, 0.5)).toBe(true)
  expect(c.updatedAt).toBe(t0 + HALF_LIFE_MS)
})
