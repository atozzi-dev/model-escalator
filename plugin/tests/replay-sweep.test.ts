import { expect, test } from 'claude-code/testing'
import { DEFAULT_CONFIG, parseConfig } from '../hooks/config'
import type { Tier } from '../hooks/detector'
import { addAgent, push, recordedOptions, sizeOf, startRecording, TOTAL_MAX_BYTES, type RecEvent, type Recording } from '../hooks/recorder'
import {
  compareRows, FP_WEIGHT, MAX_SWEEP_CANDIDATES, prepareRecording, replayPrepared, replaySession, sweep, sweepGrid, sweepReport, sweepSteps,
  type SweepGrid, type SweepRow,
} from '../hooks/replay'

const gridOf = (spec: string, current = DEFAULT_CONFIG): SweepGrid => {
  const g = sweepGrid(spec, current)
  if ('error' in g) throw new Error(g.error)
  return g
}
const errorOf = (spec: string, current = DEFAULT_CONFIG): string => {
  const g = sweepGrid(spec, current)
  return 'error' in g ? g.error : ''
}

type HandAgent = { label: string; tier?: Tier; tools: Record<string, unknown>[]; esc?: boolean; verifyFailed?: boolean }

// A hand-built observe session: each agent's tool events in turn, one model step before each, then its end.
function session(id: string, agents: HandAgent[], at = 0): Recording {
  const live = startRecording(id, at, 'observe', 'opus', recordedOptions(DEFAULT_CONFIG))
  let t = 0
  push(live, { k: 'boot', at: t })
  for (const [n, h] of agents.entries()) {
    const tier = h.tier ?? 'haiku'
    const a = addAgent(live, { id: `${id}-${n}`, label: h.label, cat: 'c', tier })
    push(live, { k: 'spawn', a, at: ++t, asked: tier, tier })
    for (const tool of h.tools) {
      push(live, { k: 'step', a, at: ++t, d: 0, m: tier })
      push(live, { k: 'tool', a, at: ++t, d: 0, t: 'Bash', ...tool } as RecEvent)
    }
    push(live, { k: 'end', a, at: ++t, ...(h.esc ? { esc: true } : {}) })
    if (h.verifyFailed) push(live, { k: 'verify', a, at: ++t, ok: false })
  }
  return live.rec
}

const fail = (s: string) => ({ n: 1, s })
// Finished well: the same error three times, far apart (2.25 points: flagged only with a threshold of 2 or less).
const fine: HandAgent = { label: 'fine', tools: [fail('a'), {}, {}, fail('a'), {}, {}, fail('a'), {}, {}] }
// Stuck: the same error again and again, and the run ended escalated.
const stuck: HandAgent = { label: 'stuck', tools: Array.from({ length: 12 }, () => fail('b')), esc: true }
// Stuck too (its verification failed), but with only three failures: caught only with a threshold of 2 or less.
const quiet: HandAgent = { label: 'quiet', tools: [fail('q'), {}, fail('q'), {}, fail('q'), {}], verifyFailed: true }

test('a grid spec expands ranges, lists and single values into every combination, checked like the options', async () => {
  const g = gridOf('thresholdHaiku=2..5 graceSteps=3,4,6 effortStep=true')
  expect(g.keys).toEqual(['thresholdHaiku', 'graceSteps', 'effortStep'])
  expect(g.candidates.length).toBe(12)
  expect(g.candidates[0]!.values).toEqual([['thresholdHaiku', '2'], ['graceSteps', '3'], ['effortStep', 'true']])
  expect(g.candidates[0]!.config.threshold.haiku).toBe(2)
  expect(g.candidates[0]!.config.grace).toBe(3)
  expect(g.candidates[0]!.config.levels).toContain('effort')
  expect(g.candidates[11]!.values).toEqual([['thresholdHaiku', '5'], ['graceSteps', '6'], ['effortStep', 'true']])
  // Options left out keep the value in force.
  const layered = gridOf('graceSteps=5', parseConfig({ thresholdSonnet: 7 }))
  expect(layered.candidates[0]!.config.threshold.sonnet).toBe(7)
  // Decimal steps, alternatives of a comma-valued option separated by |, repeated values counted once.
  expect(gridOf('idleWeight=0.05..0.2:0.05').candidates.map((c) => c.values[0]![1])).toEqual(['0.05', '0.1', '0.15', '0.2'])
  expect(gridOf('levels=nudge,consult,swap,human|nudge,swap,human').candidates.map((c) => c.values[0]![1]))
    .toEqual(['nudge,consult,swap,human', 'nudge,swap,human'])
  expect(gridOf('graceSteps=4,4,3..4').candidates.length).toBe(2)
})

test('a grid spec that is wrong or too large is refused with a clear error', async () => {
  expect(errorOf('')).toContain('option=values')
  expect(errorOf('graceSteps')).toContain('option=values')
  expect(errorOf('verifyCommand=npm')).toContain('verifyCommand is not used by the replay')
  expect(errorOf('graceSteps=-2..1')).toContain('Invalid value for graceSteps')
  expect(errorOf('levels=nudge,teleport')).toContain('Invalid value for levels')
  expect(errorOf('thresholdHaiku=5..2')).toContain('5..2')
  expect(errorOf('idleWeight=0..1:0')).toContain('0..1:0')
  expect(errorOf('graceSteps=3 graceSteps=4')).toContain('graceSteps is given twice')
  const big = errorOf('thresholdHaiku=1..10 thresholdSonnet=1..10 graceSteps=1..3')
  expect(big).toContain('300 combinations')
  expect(big).toContain(`at most ${MAX_SWEEP_CANDIDATES}`)
  // A huge range is refused before it is expanded.
  expect(errorOf('graceSteps=1..100000000')).toContain(`at most ${MAX_SWEEP_CANDIDATES}`)
  expect(gridOf('thresholdHaiku=1..10 thresholdSonnet=1..10 graceSteps=1,2').candidates.length).toBe(MAX_SWEEP_CANDIDATES)
})

test('a sweep ranks by weighted false positives, then stuck agents caught, then closeness to the options in force', async () => {
  const recs = [session('s1', [fine, stuck, quiet])]
  const r = sweep(recs, DEFAULT_CONFIG, gridOf('thresholdHaiku=1..4'))
  expect(r.agents).toBe(3)
  expect(r.stuck).toBe(2)
  expect(r.finishedWell).toBe(1)
  const th = (row: SweepRow) => row.values[0]![1]
  expect(r.rows.map(th)).toEqual(['3', '4', '2', '1'])
  const [best, next, low, lowest] = r.rows
  expect(best!.isCurrent).toBe(true)
  expect(best!.falsePositives).toBe(0)
  expect(best!.caught).toBe(1)
  expect(next!.distance).toBeGreaterThan(0)
  expect(low!.falsePositives).toBe(1)
  expect(low!.caught).toBe(2)
  // Each false positive counts with the highest level it reached.
  for (const row of r.rows) {
    const levels = Object.entries(row.fpByLevel)
    expect(levels.reduce((n, [, k]) => n + k, 0)).toBe(row.falsePositives)
    expect(row.fpWeight).toBe(levels.reduce((n, [lvl, k]) => n + k * FP_WEIGHT[lvl as keyof typeof FP_WEIGHT], 0))
  }
  expect(lowest!.fpWeight).toBeGreaterThanOrEqual(low!.fpWeight)
  // Not beaten on both counts by another row.
  expect(best!.pareto).toBe(true)
  expect(low!.pareto).toBe(true)
  // The options in force are in the grid: that row is the current row.
  expect(r.current).toBe(best)
  expect(r.currentRank).toBe(1)
  // Interventions per level, and the agents acted on earlier than recorded: none was recorded in the hand-built
  // sessions, so only the ones whose run ended badly count.
  expect(lowest!.interventions.nudge).toBeGreaterThan(0)
  expect(lowest!.interventions.consult).toBeGreaterThan(0)
  expect(lowest!.earlier).toBe(2)
  expect(best!.earlier).toBe(1)
  expect(best!.later).toBe(0)
})

test('the weights put a nudge below a consult below a swap below a human, and ties fall back in order', async () => {
  expect(FP_WEIGHT.nudge).toBeLessThan(FP_WEIGHT.consult)
  expect(FP_WEIGHT.consult).toBeLessThan(FP_WEIGHT.effort)
  expect(FP_WEIGHT.effort).toBeLessThan(FP_WEIGHT.swap)
  expect(FP_WEIGHT.swap).toBeLessThan(FP_WEIGHT.human)
  const row = (fpWeight: number, caught: number, distance: number, ladder = 0, order = 0) => ({ fpWeight, caught, distance, ladder, order }) as SweepRow
  // Two nudges are better than one swap.
  expect(compareRows(row(2 * FP_WEIGHT.nudge, 0, 0), row(FP_WEIGHT.swap, 0, 0))).toBeLessThan(0)
  expect(compareRows(row(1, 5, 9), row(1, 4, 0))).toBeLessThan(0)
  expect(compareRows(row(1, 5, 0.5), row(1, 5, 1))).toBeLessThan(0)
  expect(compareRows(row(1, 5, 1, 3), row(1, 5, 1, 4))).toBeLessThan(0)
  expect(compareRows(row(1, 5, 1, 3, 2), row(1, 5, 1, 3, 1))).toBeGreaterThan(0)
})

test('the options in force are replayed as their own row when the grid leaves them out', async () => {
  const recs = [session('s1', [fine, stuck, quiet])]
  const r = sweep(recs, DEFAULT_CONFIG, gridOf('thresholdHaiku=1,2'))
  expect(r.rows.length).toBe(2)
  expect(r.rows.some((x) => x.isCurrent)).toBe(false)
  expect(r.current.isCurrent).toBe(true)
  expect(r.current.falsePositives).toBe(0)
  expect(r.currentRank).toBe(1)
  // The steps say how far the sweep is: one per candidate, then the options in force.
  const it = sweepSteps(recs, DEFAULT_CONFIG, gridOf('thresholdHaiku=1,2'))
  const seen: number[] = []
  let step = it.next()
  while (!step.done) { seen.push(step.value); step = it.next() }
  expect(seen).toEqual([1, 2, 3])
  expect(step.value.rows.length).toBe(2)
})

test('the sweep report shows the top 10, the row of the options in force, the scoring and the limits', async () => {
  const recs = [session('s1', [fine, stuck, quiet]), session('s2', [fine, stuck], 3_600_000)]
  const text = sweepReport(sweep(recs, DEFAULT_CONFIG, gridOf('thresholdHaiku=1..4 graceSteps=2,3,5')))
  expect(text).toContain('12 candidates')
  expect(text).toContain('2 recorded sessions')
  expect(text).toContain('thresholdHaiku 1..4 (4), graceSteps 2,3,5 (3)')
  expect(text).toContain(`nudge ${FP_WEIGHT.nudge}, consult ${FP_WEIGHT.consult}`)
  expect(text).toContain('does not simulate the models')
  expect(text).toContain('Self-check')
  const ranked = text.split('\n').filter((l) => /^\s*\d+\*?\s/.test(l))
  // Top 10 and the current row (graceSteps 4 is not in the grid).
  expect(ranked.length).toBe(11)
  expect(ranked[10]).toContain('options in force')
  expect(sweepReport(sweep([], DEFAULT_CONFIG, gridOf('graceSteps=3')))).toContain('No recorded sessions')
})

test('replaying a prepared recording gives the same result as replaying the recording', async () => {
  const rec = session('s1', [fine, stuck, quiet])
  const prepared = prepareRecording(rec)
  for (const cfg of [DEFAULT_CONFIG, parseConfig({ thresholdHaiku: 1, graceSteps: 2 })]) {
    expect(replayPrepared(prepared, cfg)).toEqual(replaySession(rec, cfg))
  }
})

// An active session where the agents share the session's consult limits: consults (some refused), reviews with a
// cost, a refused tier, help requests and manual actions.
function coupled(seed: number): Recording {
  const rec = synthetic(seed, 6, 60)
  const extra: RecEvent[] = []
  for (const [i, e] of rec.events.entries()) {
    if (e.k !== 'tool' || !('a' in e)) continue
    if (i % 41 === 0) extra.push({ k: 'consult', a: e.a, at: e.at + 1, ok: i % 3 !== 0, c: 0.02 })
    if (i % 97 === 0) extra.push({ k: 'review', a: e.a, at: e.at + 1, score: 2, c: 0.03 })
    if (i % 53 === 0) extra.push({ k: 'help', a: e.a, at: e.at + 1 })
    if (i % 131 === 0) extra.push({ k: 'manual', a: e.a, at: e.at + 1, act: i % 2 === 0 ? 'consult' : 'swap' })
    if (i === 200) extra.push({ k: 'refused', at: e.at + 1, tier: 'opus' })
  }
  const events = [...rec.events, ...extra].sort((x, y) => x.at - y.at)
  return { ...rec, events }
}

test('the sweep reuses each agent\'s replay across candidates and gives the rows of whole-session replays', async () => {
  const recs = [coupled(3), coupled(4), { ...synthetic(5, 5, 40), mode: 'observe' as const }]
  const grid = gridOf('thresholdHaiku=1..3 thresholdSonnet=2,5 maxConsultsPerSession=0,2,20 consultBudgetUsd=0,0.1')
  const fast = sweep(recs, DEFAULT_CONFIG, grid)
  const plain = sweep(recs, DEFAULT_CONFIG, grid, true)
  expect(fast.rows.length).toBe(36)
  expect(fast).toEqual(plain)
  // The grid changes something: the rows are not all the same.
  expect(new Set(fast.rows.map((r) => r.ladder)).size).toBeGreaterThan(1)
})

// A synthetic active session:`n` agents of every tier, `tools` tool results each (a quarter failing on one of four
// errors, some edits, some test counts) and a model request every third, interleaved.
function synthetic(seed: number, n: number, tools: number): Recording {
  let x = seed * 7919 + 13
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648)
  const live = startRecording(`syn${seed}`, seed * 3_600_000, 'active', 'opus', recordedOptions(DEFAULT_CONFIG))
  push(live, { k: 'boot', at: 0 })
  const tiers: Tier[] = ['haiku', 'sonnet', 'opus']
  const as = Array.from({ length: n }, (_, i) => addAgent(live, { id: `a${i}`, label: `w${i}`, cat: `c${i % 3}`, tier: tiers[i % 3]! }))
  let t = 1
  for (const a of as) push(live, { k: 'spawn', a, at: t++, asked: live.rec.agents[a]!.tier, tier: live.rec.agents[a]!.tier })
  for (let i = 0; i < tools; i++) {
    for (const a of as) {
      t += 200
      if (i % 3 === 0) push(live, { k: 'step', a, at: t, d: 100, m: live.rec.agents[a]!.tier })
      const r = rnd()
      const tool: RecEvent = { k: 'tool', a, at: t + 50, d: 40, t: 'Bash', g: Math.floor(i / 2) }
      if (r < 0.25) { tool.n = 1; tool.s = String(Math.floor(rnd() * 4)) }
      else if (r < 0.4) tool.e = String(Math.floor(rnd() * 3))
      else if (r < 0.45) tool.f = [Math.floor(rnd() * 5)]
      push(live, tool)
    }
  }
  for (const a of as) push(live, { k: 'end', a, at: (t += 10), ...(a % 4 === 0 ? { esc: true } : {}) })
  return live.rec
}

// The largest sweep there can be, measured whole: about 5 s on a loaded machine, so it gets its own timeout.
test('a sweep of 20 sessions over 200 candidates runs in seconds', { timeoutMs: 30000 }, async () => {
  // The store keeps at most TOTAL_MAX_BYTES of recordings in all: 20 sessions that fill it are the largest sweep.
  const recs = Array.from({ length: 20 }, (_, i) => synthetic(i + 1, 8, 100))
  const bytes = recs.reduce((n, r) => n + sizeOf(r), 0)
  expect(bytes).toBeGreaterThan(TOTAL_MAX_BYTES * 0.8)
  expect(bytes).toBeLessThanOrEqual(TOTAL_MAX_BYTES)
  const grid = gridOf('thresholdHaiku=1..5 thresholdSonnet=3..7 graceSteps=2..9')
  expect(grid.candidates.length).toBe(200)
  const events = recs.reduce((n, r) => n + r.events.length, 0)
  const t0 = Date.now()
  let longest = 0
  const it = sweepSteps(recs, DEFAULT_CONFIG, grid)
  let last = Date.now()
  let step = it.next()
  while (!step.done) {
    longest = Math.max(longest, Date.now() - last)
    last = Date.now()
    step = it.next()
  }
  const ms = Date.now() - t0
  expect(events).toBeGreaterThan(20000)
  expect(step.value.rows.length).toBe(200)
  expect(step.value.agents).toBe(160)
  // Generous bounds for a loaded machine: one step (one candidate over every session) never holds the engine long.
  expect(ms).toBeLessThan(20000)
  expect(longest).toBeLessThan(1000)
})
