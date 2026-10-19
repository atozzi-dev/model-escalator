import { expect, test } from 'claude-code/testing'
import { ADVICE, downshiftAdvice, formatAdvice, hintLine, pickHint, type Advice } from '../hooks/advice'
import type { Tier } from '../hooks/detector'
import { HALF_LIFE_MS, LEARN, record, recordReview, recordRework, type Stats } from '../hooks/learning'

const T0 = 1_000_000_000

function runs(stats: Stats, category: string, tier: Tier, n: number, cost?: number, failedVerify = 0): Stats {
  let st = stats
  for (let i = 0; i < n; i++) {
    st = record(st, category, tier, false, 0, i < failedVerify, T0, HALF_LIFE_MS, cost !== undefined ? { cost } : {})
  }
  return st
}

function reviews(stats: Stats, category: string, tier: Tier, scores: number[]): Stats {
  let st = stats
  for (const s of scores) st = recordReview(st, category, tier, s, { now: T0 })
  return st
}

const one = (st: Stats, opts: Parameters<typeof downshiftAdvice>[1] = {}): Advice => {
  const list = downshiftAdvice(st, { now: T0, ...opts })
  expect(list.length).toBe(1)
  return list[0]!
}

// No protection at all: rework off, no verifyCommand, no reviews.
const BARE = { reworkWindowMinutes: 0 }

// --- measured: only evidence from runs of the cheaper tier ---

test('evidence on the current tier alone is never measured', async () => {
  let st = runs({}, 'w:feature', 'sonnet', 30)
  st = reviews(st, 'w:feature', 'sonnet', [5, 5, 5, 5])
  // reviews, a passing verifyCommand and no rework on sonnet say nothing about haiku
  const a = one(st, { verify: true, baseline: 'opus' })
  expect(a.quality).not.toBe('measured')
  expect(a.strength).toBe('moderate')
  expect(pickHint([a], {}, T0)).toBe(undefined)
})

test('enough clean runs on the cheaper tier with rework tracked are measured and strong', async () => {
  let st = runs({}, 'w:feature', 'opus', 20)
  st = runs(st, 'w:feature', 'sonnet', LEARN.minRuns)
  const a = one(st)
  expect(a.quality).toBe('measured')
  expect(a.signal).toBe('rework')
  expect(a.qualityNote).toBe(`no rework by the lead in ${LEARN.minRuns} sonnet runs`)
  expect(a.strength).toBe('strong')
})

test('rework seen on the cheaper tier is counted in the note', async () => {
  let st = runs({}, 'w:feature', 'opus', 20)
  st = runs(st, 'w:feature', 'sonnet', 10)
  st = recordRework(st, 'w:feature', 'sonnet', { now: T0, runAccepted: true })
  expect(one(st).qualityNote).toBe('the lead reworked 1 of 10 sonnet runs')
})

test('a verifyCommand measures code work on the cheaper tier runs', async () => {
  let st = runs({}, 'w:bugfix', 'opus', 20)
  st = runs(st, 'w:bugfix', 'sonnet', 6)
  const a = one(st, { verify: true, ...BARE })
  expect(a.quality).toBe('measured')
  expect(a.signal).toBe('verify')
  expect(a.qualityNote).toBe('verifyCommand passed on 6 sonnet runs')
  let f = runs({}, 'w:bugfix', 'opus', 20)
  f = runs(f, 'w:bugfix', 'sonnet', 10, undefined, 1)
  expect(one(f, { verify: true, ...BARE }).qualityNote).toBe('verifyCommand passed on 9 of 10 sonnet runs')
})

test('reviews of the cheaper tier measure it, ahead of verify and rework', async () => {
  let st = runs({}, 'gp:other', 'opus', 20)
  st = runs(st, 'gp:other', 'sonnet', 6)
  st = reviews(st, 'gp:other', 'sonnet', [4, 5, 4])
  const a = one(st, { verify: true })
  expect(a.quality).toBe('measured')
  expect(a.signal).toBe('reviews')
  expect(a.qualityNote).toBe('reviews of sonnet runs average 4.3')
  // fewer than the minimum reviews do not count
  let few = runs({}, 'gp:other', 'opus', 20)
  few = runs(few, 'gp:other', 'sonnet', 6)
  few = reviews(few, 'gp:other', 'sonnet', [5, 5])
  expect(one(few, BARE).quality).toBe('unmeasured')
  expect(ADVICE.minReviews).toBe(3)
})

test('too few or too poor runs on the cheaper tier are not evidence', async () => {
  let st = runs({}, 'w:feature', 'opus', 20)
  st = runs(st, 'w:feature', 'sonnet', LEARN.minRuns - 1)
  expect(one(st).quality).toBe('guarded')
  // 2 of 10 not accepted: 20%, above the 10% bar but below the 25% block
  let poor = runs({}, 'w:feature', 'opus', 20)
  poor = runs(poor, 'w:feature', 'sonnet', 10, undefined, 2)
  expect(one(poor, { verify: true }).quality).toBe('guarded')
})

test('cheaper runs without any active signal are not measured', async () => {
  let st = runs({}, 'w:feature', 'opus', 20)
  st = runs(st, 'w:feature', 'sonnet', 6)
  expect(one(st, BARE).quality).toBe('unmeasured')
})

test('read-only work is never measured, even with cheaper runs, reviews and a verifyCommand', async () => {
  for (const category of ['security-reviewer:review', 'scout:explore']) {
    let st = runs({}, category, 'opus', 30, 0.94)
    st = runs(st, category, 'sonnet', 8)
    st = reviews(st, category, 'sonnet', [5, 5, 5, 5])
    const a = one(st, { verify: true, reviewRate: 0.5 })
    expect(a.quality).toBe('unmeasured')
    expect(a.strength).toBe('moderate')
    expect(a.qualityNote).toContain('read-only')
  }
})

// --- guarded: no evidence yet, a check that would catch a drop after the switch ---

test('code work with a verifyCommand is guarded by tests first', async () => {
  const a = one(runs({}, 'w:feature', 'opus', 20), { verify: true, reviewRate: 0.5 })
  expect(a.quality).toBe('guarded')
  expect(a.guard).toBe('tests')
  expect(a.strength).toBe('moderate')
  expect(a.qualityNote).toBe('if sonnet does worse, your verifyCommand would catch the failures and learning would move this category back up')
})

test('then by sampled reviews, then by rework', async () => {
  const r = one(runs({}, 'w:feature', 'opus', 20), { reviewRate: 0.2 })
  expect(r.guard).toBe('reviews')
  expect(r.qualityNote).toBe('if sonnet does worse, sampled senior reviews (reviewRate) would show it and learning would move this category back up')
  const w = one(runs({}, 'w:feature', 'opus', 20), { reworkWindowMinutes: 10 })
  expect(w.guard).toBe('rework')
  expect(w.qualityNote).toBe('if sonnet does worse, edits by the lead within 10 minutes would show it and learning would move this category back up')
})

test('every label that writes files is guarded by rework by default', async () => {
  for (const label of ['feature', 'bugfix', 'tests', 'refactor', 'docs', 'ui', 'data']) {
    const a = one(runs({}, `w:${label}`, 'opus', 20))
    expect(a.quality).toBe('guarded')
    expect(a.guard).toBe('rework')
    expect(a.qualityNote).toContain('within 30 minutes')
  }
})

test('docs are not guarded by a verifyCommand', async () => {
  expect(one(runs({}, 'w:docs', 'opus', 20), { verify: true, ...BARE }).quality).toBe('unmeasured')
})

test('other work is guarded only by sampled reviews', async () => {
  const st = runs({}, 'gp:other', 'opus', 20)
  expect(one(st, { verify: true }).quality).toBe('unmeasured')
  expect(one(st, { reviewRate: 0.2 }).guard).toBe('reviews')
  expect(one(runs({}, 'c', 'opus', 20)).quality).toBe('unmeasured')
})

test('reviews and rework guard nothing when the cheaper tier is not below the lead', async () => {
  const st = runs({}, 'w:feature', 'opus', 20)
  const a = one(st, { baseline: 'sonnet', reviewRate: 0.5 })
  expect(a.quality).toBe('unmeasured')
  expect(a.qualityNote).toContain('below the lead')
  expect(one(st, { baseline: 'sonnet', verify: true }).guard).toBe('tests')
})

test('unmeasured write work says why', async () => {
  expect(one(runs({}, 'w:feature', 'opus', 20), BARE).qualityNote).toContain('rework tracking is off')
})

test('measured, then guarded, then unmeasured suggestions', async () => {
  let st = runs({}, 'r:review', 'opus', 10, 5)
  st = runs(st, 'w:feature', 'opus', 10, 1)
  st = runs(st, 'v:bugfix', 'opus', 10, 0.1)
  st = runs(st, 'v:bugfix', 'sonnet', 6)
  expect(downshiftAdvice(st, { now: T0 }).map((a) => a.category).join(',')).toBe('v:bugfix,w:feature,r:review')
})

// --- text ---

const sample = (over: Partial<Advice> = {}): Advice => ({
  category: 'coder:feature', tier: 'opus', suggested: 'sonnet', scope: 'global', runs: 18,
  escalationRate: 0, notAcceptedRate: 0, priceRatio: 0.5, costNow: 0.94, costCheaper: 0.47, strength: 'strong',
  cheaperRuns: 6, quality: 'measured', signal: 'verify', qualityNote: 'verifyCommand passed on 6 sonnet runs', ...over,
})

const unmeasured = (over: Partial<Advice> = {}): Advice => sample({
  category: 'security-reviewer:review', strength: 'moderate', quality: 'unmeasured', signal: undefined, cheaperRuns: undefined,
  qualityNote: 'read-only work: no files to review, test or rework', ...over,
})

const guarded = (over: Partial<Advice> = {}): Advice => sample({
  strength: 'moderate', quality: 'guarded', signal: undefined, guard: 'rework', cheaperRuns: undefined,
  qualityNote: 'if sonnet does worse, edits by the lead within 30 minutes would show it and learning would move this category back up',
  ...over,
})

test('the hint of a measured suggestion names the evidence', async () => {
  expect(hintLine(sample())).toBe(
    'coder:feature never got stuck in 18 runs on opus (verifyCommand passed on 6 sonnet runs): on sonnet it would cost ' +
    'about $0.47 instead of $0.94 per run. Ask for sonnet in the Agent call, or see /escalator stats.')
})

test('a measured line names the evidence and shows current-tier reviews only as context', async () => {
  const l = formatAdvice([sample({ reviewMean: 4.6, reviews: 4 })]).lines[0]!
  expect(l).toContain('quality: verifyCommand passed on 6 sonnet runs')
  expect(l).toContain('opus runs: reviews average 4.6')
  expect(l).toContain('(strong)')
})

test('a guarded line says quality is not measured yet and which check would catch a drop', async () => {
  const out = formatAdvice([guarded()])
  expect(out.lines[0]).toBe(
    'coder:feature never got stuck in 18 runs on opus. On sonnet it would cost about $0.47 instead of $0.94 per run. ' +
    'Quality is not measured yet (no sonnet runs to compare): if sonnet does worse, edits by the lead within 30 minutes ' +
    'would show it and learning would move this category back up.')
  expect(out.hint).toBe('')
  expect(formatAdvice([guarded({ cheaperRuns: 3 })]).lines[0]).toContain('(only 3 sonnet runs so far)')
  expect(formatAdvice([guarded({ cheaperRuns: 8 })]).lines[0]).toContain('(too few accepted sonnet runs)')
})

test('an unmeasured line says plainly what the mod cannot tell', async () => {
  const out = formatAdvice([unmeasured()])
  expect(out.lines[0]).toBe(
    'security-reviewer:review never got stuck in 18 runs on opus. On sonnet it would cost about $0.47 instead of $0.94 ' +
    'per run, but the mod cannot tell whether it would find the same issues (read-only work: no files to review, test or ' +
    'rework). Try sonnet on a few runs and compare the results yourself.')
  expect(out.hint).toBe('')
})

test('an unmeasured line without costs uses the price ratio', async () => {
  const l = formatAdvice([unmeasured({ category: 'scout:explore', costNow: undefined, costCheaper: undefined })]).lines[0]!
  expect(l).toContain('Sonnet costs about 50% of opus per token, but the mod cannot tell whether it would find the same answers')
})

test('an unmeasured line for other or write work says what would measure it', async () => {
  const off = formatAdvice([unmeasured({ category: 'gp:other', qualityNote: 'x' })]).lines[0]!
  expect(off).toContain('whether it would do the work as well')
  expect(off).toContain('Turn on reviewRate')
  const w = formatAdvice([unmeasured({ category: 'w:feature', qualityNote: 'x' })]).lines[0]!
  expect(w).toContain('Set verifyCommand or turn on reviewRate')
})

test('the stats block keeps the general caveat', async () => {
  for (const list of [[sample()], [unmeasured()], [guarded()]]) {
    const text = formatAdvice(list).text
    expect(text).toContain('estimate')
    expect(text).toContain('runs that did not get stuck, not on a comparison with the cheaper model')
  }
})

test('only a measured suggestion is ever the hint, whatever its strength says', async () => {
  for (const forged of [unmeasured({ strength: 'strong' }), guarded({ strength: 'strong' })]) {
    expect(pickHint([forged], {}, T0)).toBe(undefined)
    expect(formatAdvice([forged]).hint).toBe('')
  }
  const old = { ...sample() } as Partial<Advice>
  delete old.quality
  expect(pickHint([old as Advice], {}, T0)).toBe(undefined)
  expect(pickHint([guarded({ strength: 'strong' }), sample()], {}, T0)!.signal).toBe('verify')
})
