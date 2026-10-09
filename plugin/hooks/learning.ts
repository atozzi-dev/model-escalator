import { LADDER, type Tier } from './detector'

// `notAccepted` counts runs that were escalated or failed the verification gate (a run that did both counts once).
// `updatedAt` (ms) is set only when a run is recorded with a clock; counters may be fractional once decayed.
// `failedVerify` and `notAccepted` are absent in stats stored before the gate existed: `notAccepted` then reads as `escalated`.
export type Cell = { runs: number; escalated: number; tokens: number; failedVerify?: number; notAccepted?: number; updatedAt?: number }
export type Stats = Record<string, Partial<Record<Tier, Cell>>>

const KEYWORDS: [RegExp, string][] = [
  [/\btest|spec\b/i, 'tests'],
  [/\bfix|bug|debug|error\b/i, 'bugfix'],
  [/\brefactor|rename|cleanup\b/i, 'refactor'],
  [/\bdoc|readme|comment\b/i, 'docs'],
  [/\bmigrat|schema|database|sql\b/i, 'data'],
  [/\bui|css|component|layout\b/i, 'ui'],
  [/\bsearch|find|explore|research|read\b/i, 'explore'],
]

export function categorize(subagentType: string, description: string): string {
  const hit = KEYWORDS.find(([re]) => re.test(description))
  return `${subagentType}:${hit ? hit[1] : 'other'}`
}

// Old runs fade: every counter of a cell halves after this much time without a new run.
export const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000

// Counters of `c` as seen at `now`. Cells without `updatedAt` (stored before decay existed) or calls without `now`
// are read as they are; a clock that went backwards never inflates counters. Never mutates `c`.
function decayed(c: Cell, now: number | undefined, halfLifeMs: number): Cell {
  if (now === undefined || c.updatedAt === undefined || now <= c.updatedAt || !(halfLifeMs > 0)) return c
  const f = 0.5 ** ((now - c.updatedAt) / halfLifeMs)
  return {
    ...c,
    runs: c.runs * f,
    escalated: c.escalated * f,
    tokens: c.tokens * f,
    ...(c.failedVerify !== undefined ? { failedVerify: c.failedVerify * f } : {}),
    ...(c.notAccepted !== undefined ? { notAccepted: c.notAccepted * f } : {}),
  }
}

export function record(
  stats: Stats,
  category: string,
  tier: Tier,
  escalated: boolean,
  tokens: number,
  verifyFailed = false,
  now?: number,
  halfLifeMs = HALF_LIFE_MS,
): Stats {
  const row = { ...(stats[category] ?? {}) }
  const c = decayed(row[tier] ?? { runs: 0, escalated: 0, tokens: 0 }, now, halfLifeMs)
  row[tier] = {
    runs: c.runs + 1,
    escalated: c.escalated + (escalated ? 1 : 0),
    tokens: c.tokens + tokens,
    failedVerify: (c.failedVerify ?? 0) + (verifyFailed ? 1 : 0),
    notAccepted: (c.notAccepted ?? c.escalated) + (escalated || verifyFailed ? 1 : 0),
    ...(now !== undefined ? { updatedAt: now } : c.updatedAt !== undefined ? { updatedAt: c.updatedAt } : {}),
  }
  return { ...stats, [category]: row }
}

export const LEARN = { minRuns: 5, maxEscalationRate: 0.4 }

const failures = (c: Cell): number => c.notAccepted ?? c.escalated

// Walks up from `requested` while the (decayed) evidence says the tier fails this category too often.
// `passed` lists the tiers it climbed over, cheapest first, with their decayed cells.
function climb(stats: Stats, category: string, requested: Tier, now: number | undefined, halfLifeMs: number) {
  const passed: { tier: Tier; cell: Cell }[] = []
  let t = requested
  for (;;) {
    const raw = stats[category]?.[t]
    const c = raw === undefined ? undefined : decayed(raw, now, halfLifeMs)
    const bad = c !== undefined && c.runs >= LEARN.minRuns && failures(c) / c.runs > LEARN.maxEscalationRate
    const i = LADDER.indexOf(t)
    if (!bad || i === LADDER.length - 1) return { tier: t, passed }
    passed.push({ tier: t, cell: c })
    t = LADDER[i + 1]!
  }
}

// Climbs the ladder while the evidence says the tier fails this category too often.
// With `now`, old evidence is decayed first: the rate is unchanged (all counters fade together) but a category left
// alone long enough drops below `minRuns` and falls back to the requested tier.
export function recommend(stats: Stats, category: string, requested: Tier, now?: number, halfLifeMs = HALF_LIFE_MS): Tier {
  return climb(stats, category, requested, now, halfLifeMs).tier
}

// --- Exploration ---
//
// Learning alone only climbs: once a category is pushed off a tier it never runs there again, so it cannot notice that
// the cheaper model became good enough. Exploration is Thompson sampling applied to the climbing rule: instead of the
// point estimate of a tier's failure rate, it uses a draw from its posterior, Beta(notAccepted + 1, accepted + 1) with a
// uniform prior. A tier is then tried again with the posterior probability that its true failure rate is within
// `maxEscalationRate`. With a handful of runs (or old, decayed ones) the posterior is wide and the cheaper tier comes
// back now and then; every further failure narrows it, so strong recent evidence makes exploration vanishingly rare.
// A fixed epsilon would instead spend the same share of runs on a tier that failed 18 times out of 20 as on one that
// failed 4 out of 6. The draw is taken in closed form (one uniform number against the posterior CDF), which gives
// the same choice as sampling the rate itself.
//
// Exploration only undoes what learning raised: it never goes below the requested tier, so a model asked for at spawn
// is never replaced by a cheaper one.

export type Reason = 'requested' | 'raised' | 'explore'
// `tier` is the tier to start on; `learned` is what the plain rule (`recommend`) would pick.
export type Choice = { tier: Tier; reason: Reason; learned: Tier }
export type ExploreOptions = {
  now?: number
  halfLifeMs?: number
  // Uniform source in [0, 1). Without it nothing is explored and the result equals `recommend`.
  rand?: () => number
  // Weight in [0, 1] applied to every exploration chance: 1 is plain Thompson sampling, 0 turns exploration off.
  explore?: number
}

// Lanczos approximation of ln(Gamma(x)) for x > 0.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
]
function lnGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x)
  x -= 1
  let a = LANCZOS[0]!
  const t = x + 7.5
  for (let i = 1; i < 9; i++) a += LANCZOS[i]! / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

// Continued fraction of the incomplete beta function (modified Lentz).
function betaFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300
  const clamp = (v: number): number => (Math.abs(v) < tiny ? tiny : v)
  let c = 1
  let d = 1 / clamp(1 - ((a + b) * x) / (a + 1))
  let h = d
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2))
    d = 1 / clamp(1 + aa * d)
    c = clamp(1 + aa / c)
    h *= d * c
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1))
    d = 1 / clamp(1 + aa * d)
    c = clamp(1 + aa / c)
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-12) break
  }
  return h
}

// Regularized incomplete beta I_x(a, b): the CDF of Beta(a, b) at x.
function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  return x < (a + 1) / (a + b + 2) ? (front * betaFraction(a, b, x)) / a : 1 - (front * betaFraction(b, a, 1 - x)) / b
}

// Posterior probability that the tier of `c` fails this category no more often than `maxEscalationRate`.
// With `now`, the cell is decayed first, which widens the posterior.
export function goodEnoughChance(c: Cell, now?: number, halfLifeMs = HALF_LIFE_MS): number {
  const d = decayed(c, now, halfLifeMs)
  const bad = Math.max(0, failures(d))
  const good = Math.max(0, d.runs - bad)
  return betaCdf(LEARN.maxEscalationRate, bad + 1, good + 1)
}

// `recommend` plus a reason and, with `rand`, a chance to start on a tier the rule climbed over. Tiers are tried
// cheapest first, one uniform draw each; the random source is not consumed when nothing was raised.
export function recommendWithExploration(stats: Stats, category: string, requested: Tier, opts: ExploreOptions = {}): Choice {
  const { now, halfLifeMs = HALF_LIFE_MS, rand } = opts
  const { tier: learned, passed } = climb(stats, category, requested, now, halfLifeMs)
  if (passed.length === 0) return { tier: learned, reason: 'requested', learned }
  const w = opts.explore ?? 1
  const weight = w >= 0 ? Math.min(1, w) : 0
  if (rand !== undefined && weight > 0) {
    // cells in `passed` are already decayed
    for (const { tier, cell } of passed) if (rand() < weight * goodEnoughChance(cell)) return { tier, reason: 'explore', learned }
  }
  return { tier: learned, reason: 'raised', learned }
}

// Small seeded PRNG (mulberry32): uniform numbers in [0, 1), the same sequence for the same seed.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const num1 = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1))

function ageText(ms: number): string {
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`
  return `${Math.floor(ms / 86_400_000)} d ago`
}

// One line per category and tier; counters may be fractional once decayed. With `now`, shows how old each cell is.
export function formatStats(stats: Stats, now?: number): string {
  const lines: string[] = []
  for (const [category, row] of Object.entries(stats)) {
    for (const [tier, c] of Object.entries(row)) {
      if (!c) continue
      const failed = c.failedVerify ? `, ${num1(c.failedVerify)} failed verify` : ''
      const na = c.notAccepted !== undefined && c.notAccepted !== c.escalated ? `, ${num1(c.notAccepted)} not accepted` : ''
      const age = now !== undefined && c.updatedAt !== undefined ? ` (updated ${ageText(Math.max(0, now - c.updatedAt))})` : ''
      lines.push(`- ${category} ${tier}: ${num1(c.runs)} runs, ${num1(c.escalated)} escalated${failed}${na}${age}`)
    }
  }
  return lines.length === 0 ? 'No stats yet.' : lines.join('\n')
}
