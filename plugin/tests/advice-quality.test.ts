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

// --- the rule ---

test('read-only work is never measured, even with many runs, reviews or a verifyCommand', async () => {
  for (const category of ['security-reviewer:review', 'scout:explore']) {
    let st = runs({}, category, 'opus', 30, 0.94)
    st = reviews(st, category, 'opus', [5, 5, 5, 5])
    const a = one(st, { verify: true })
    expect(a.quality).toBe('unmeasured')
    expect(a.signal).toBe(undefined)
    expect(a.strength).toBe('moderate')
    expect(a.qualityNote).toContain('read-only')
  }
})

test('other work without reviews is unmeasured; with enough reviews it is measured', async () => {
  const st = runs({}, 'general-purpose:other', 'opus', 20)
  const a = one(st, { verify: true })
  expect(a.quality).toBe('unmeasured')
  expect(a.strength).toBe('moderate')
  const few = one(reviews(st, 'general-purpose:other', 'opus', [5, 5]))
  expect(few.quality).toBe('unmeasured')
  expect(few.qualityNote).toContain(`only 2 of the ${ADVICE.minReviews} reviews`)
  const enough = one(reviews(st, 'general-purpose:other', 'opus', [5, 4, 5]))
  expect(enough.quality).toBe('measured')
  expect(enough.signal).toBe('reviews')
  expect(enough.qualityNote).toBe('reviews average 4.7')
  expect(enough.strength).toBe('strong')
})

test('reviews of the cheaper tier on this category measure it too', async () => {
  let st = runs({}, 'general-purpose:other', 'opus', 20)
  st = reviews(st, 'general-purpose:other', 'sonnet', [4, 5, 4])
  const a = one(st)
  expect(a.quality).toBe('measured')
  expect(a.signal).toBe('cheaper-reviews')
  expect(a.qualityNote).toBe('reviews of sonnet runs average 4.3')
})

test('a category label that is not a known one reads as other', async () => {
  expect(one(runs({}, 'c', 'opus', 20)).quality).toBe('unmeasured')
  expect(one(runs({}, 'plugin:agent:weird', 'opus', 20)).quality).toBe('unmeasured')
})

test('code work with a verifyCommand is measured by it', async () => {
  const a = one(runs({}, 'coder:feature', 'opus', 20), { verify: true, reworkWindowMinutes: 0 })
  expect(a.quality).toBe('measured')
  expect(a.signal).toBe('verify')
  expect(a.qualityNote).toBe('your verifyCommand passed')
  // one failure in 20 runs is still within the not-accepted bar
  const b = one(runs({}, 'coder:bugfix', 'opus', 20, undefined, 1), { verify: true, reworkWindowMinutes: 0 })
  expect(b.qualityNote).toBe('your verifyCommand passed in 19 of 20 runs')
})

test('docs work is not measured by a verifyCommand, only by rework or reviews', async () => {
  const a = one(runs({}, 'writer:docs', 'opus', 20), { verify: true, reworkWindowMinutes: 0 })
  expect(a.quality).toBe('unmeasured')
  expect(one(runs({}, 'writer:docs', 'opus', 20), { verify: true }).quality).toBe('safety-net')
})

test('work that writes files with no run on the cheaper tier has only a safety net', async () => {
  for (const label of ['feature', 'bugfix', 'tests', 'refactor', 'docs', 'ui', 'data']) {
    // opus at an opus baseline is not tracked for rework, sonnet runs would be: a net, not a measure
    const a = one(runs({}, `w:${label}`, 'opus', 20), { baseline: 'opus', reworkWindowMinutes: 30 })
    expect(a.quality).toBe('safety-net')
    expect(a.signal).toBe(undefined)
    expect(a.strength).toBe('moderate')
    expect(a.qualityNote).toBe(
      'if sonnet does worse, edits by the lead within 30 minutes would show it and learning would move this category back up')
  }
  expect(one(runs({}, 'w:feature', 'opus', 20), { reworkWindowMinutes: 10 }).qualityNote).toContain('within 10 minutes')
})

test('too few runs on the cheaper tier are still only a safety net', async () => {
  let st = runs({}, 'w:feature', 'opus', 20)
  st = runs(st, 'w:feature', 'sonnet', LEARN.minRuns - 1)
  expect(one(st).quality).toBe('safety-net')
})

test('enough accepted runs on the cheaper tier make its rework a measured signal', async () => {
  let st = runs({}, 'w:feature', 'opus', 20)
  st = runs(st, 'w:feature', 'sonnet', LEARN.minRuns)
  const a = one(st)
  expect(a.quality).toBe('measured')
  expect(a.signal).toBe('rework-cheaper')
  expect(a.qualityNote).toBe(`no rework by the lead in ${LEARN.minRuns} sonnet runs`)
  expect(a.strength).toBe('strong')
  // with rework off those runs prove nothing about quality
  expect(one(st, { reworkWindowMinutes: 0 }).quality).toBe('unmeasured')
})

test('rework seen on the cheaper tier is counted in the note', async () => {
  let st = runs({}, 'w:feature', 'opus', 20)
  st = runs(st, 'w:feature', 'sonnet', 10)
  st = recordRework(st, 'w:feature', 'sonnet', { now: T0, runAccepted: true })
  const a = one(st)
  expect(a.signal).toBe('rework-cheaper')
  expect(a.qualityNote).toBe('the lead reworked 1 of 10 sonnet runs')
})

test('rework counted on the current tier is named as such', async () => {
  let st = runs({}, 'w:feature', 'sonnet', 20)
  expect(one(st, { baseline: 'opus' }).qualityNote).toBe('no rework by the lead')
  st = recordRework(st, 'w:feature', 'sonnet', { now: T0, runAccepted: true })
  // 1 rework in 20 is 5% not accepted: still advised
  const a = one(st, { baseline: 'opus' })
  expect(a.signal).toBe('rework')
  expect(a.qualityNote).toBe('the lead reworked 1 of 20 runs')
})

test('rework is no signal when it is off or when neither tier is below the lead', async () => {
  const st = runs({}, 'w:feature', 'opus', 20)
  const off = one(st, { reworkWindowMinutes: 0 })
  expect(off.quality).toBe('unmeasured')
  expect(off.qualityNote).toContain('rework tracking is off')
  const high = one(st, { baseline: 'sonnet' })
  expect(high.quality).toBe('unmeasured')
  expect(high.qualityNote).toContain('below the lead')
})

test('reviews come before verify and rework as the named signal', async () => {
  let st = runs({}, 'w:feature', 'sonnet', 20)
  st = reviews(st, 'w:feature', 'sonnet', [5, 5, 4])
  const a = one(st, { verify: true, baseline: 'opus' })
  expect(a.signal).toBe('reviews')
  const b = one(runs({}, 'w:feature', 'sonnet', 20), { verify: true, baseline: 'opus' })
  expect(b.signal).toBe('verify')
})

test('measured, then safety-net, then unmeasured suggestions of the same strength', async () => {
  let st = runs({}, 'r:review', 'opus', 10, 5)
  st = runs(st, 'w:feature', 'opus', 10, 1)
  st = runs(st, 'v:bugfix', 'opus', 10, 0.1)
  // v:bugfix is measured by reviews, w:feature only has the rework net
  st = reviews(st, 'v:bugfix', 'opus', [5, 5, 5])
  expect(downshiftAdvice(st, { now: T0 }).map((a) => a.category).join(',')).toBe('v:bugfix,w:feature,r:review')
})

// --- text ---

const sample = (over: Partial<Advice> = {}): Advice => ({
  category: 'coder:feature', tier: 'opus', suggested: 'sonnet', scope: 'global', runs: 18,
  escalationRate: 0, notAcceptedRate: 0, priceRatio: 0.5, costNow: 0.94, costCheaper: 0.47, strength: 'strong',
  quality: 'measured', signal: 'verify', qualityNote: 'your verifyCommand passed', ...over,
})

const unmeasured = (over: Partial<Advice> = {}): Advice => sample({
  category: 'security-reviewer:review', strength: 'moderate', quality: 'unmeasured', signal: undefined,
  qualityNote: 'read-only work: no files to review, test or rework', ...over,
})

test('the hint of a measured suggestion names the signal', async () => {
  expect(hintLine(sample())).toBe(
    'coder:feature never got stuck in 18 runs on opus (your verifyCommand passed): on sonnet it would cost about $0.47 ' +
    'instead of $0.94 per run. Ask for sonnet in the Agent call, or see /escalator stats.')
})

test('a measured line names the signal', async () => {
  const out = formatAdvice([sample()])
  expect(out.lines[0]).toContain('quality: your verifyCommand passed')
  expect(out.lines[0]).toContain('(strong)')
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

test('an unmeasured line for other work says what would measure it', async () => {
  const note = 'no reviews, and the work is not known to change files'
  const off = formatAdvice([unmeasured({ category: 'gp:other', qualityNote: note })]).lines[0]!
  expect(off).toContain('whether it would do the work as well')
  expect(off).toContain('Turn on reviewRate')
  const on = formatAdvice([unmeasured({ category: 'gp:other', qualityNote: note })], { reviewRate: 0.2 }).lines[0]!
  expect(on).toContain('reviewRate is on')
  const w = formatAdvice([unmeasured({ category: 'w:feature', qualityNote: 'x' })]).lines[0]!
  expect(w).toContain('Set verifyCommand or turn on reviewRate')
})

const net = (over: Partial<Advice> = {}): Advice => sample({
  strength: 'moderate', quality: 'safety-net', signal: undefined,
  qualityNote: 'if sonnet does worse, edits by the lead within 30 minutes would show it and learning would move this category back up',
  ...over,
})

test('a safety-net line says quality is not measured yet and what would catch a drop', async () => {
  const out = formatAdvice([net()])
  expect(out.lines[0]).toBe(
    'coder:feature never got stuck in 18 runs on opus. On sonnet it would cost about $0.47 instead of $0.94 per run. ' +
    'Quality is not measured yet (no sonnet runs to compare): if sonnet does worse, edits by the lead within 30 minutes ' +
    'would show it and learning would move this category back up.')
  expect(out.hint).toBe('')
})

test('a safety-net suggestion is never the hint, even when marked strong', async () => {
  expect(pickHint([net({ strength: 'strong' })], {}, T0)).toBe(undefined)
  expect(formatAdvice([net({ strength: 'strong' })]).hint).toBe('')
})

test('the stats block keeps the general caveat', async () => {
  for (const list of [[sample()], [unmeasured()]]) {
    const text = formatAdvice(list).text
    expect(text).toContain('estimate')
    expect(text).toContain('runs that did not get stuck, not on a comparison with the cheaper model')
  }
})

test('an unmeasured or unlabelled suggestion is never the hint, even when marked strong', async () => {
  const forged = unmeasured({ strength: 'strong' })
  expect(pickHint([forged], {}, T0)).toBe(undefined)
  expect(formatAdvice([forged]).hint).toBe('')
  const old = { ...sample() } as Partial<Advice>
  delete old.quality
  expect(pickHint([old as Advice], {}, T0)).toBe(undefined)
  expect(pickHint([forged, sample()], {}, T0)!.category).toBe('coder:feature')
})
