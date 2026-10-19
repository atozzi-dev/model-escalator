import { promptHead } from './classify'
import { LADDER, type Tier } from './detector'

// One cell per category and start tier. Two groups of counters, each with its own clock:
//
// - run counters, as of `updatedAt`: `runs`, `escalated`, `tokens`, `failedVerify`, `notAccepted`, `cost`, `costRuns`.
//   `notAccepted` counts the runs that were not accepted (see `isAccepted`), each once whatever the reasons.
//   `cost` is the USD spent by the runs that reported one and `costRuns` how many those were, so `cost / costRuns`
//   is the mean cost of a run even when older runs were recorded without a cost.
// - review counters, as of `reviewedAt`: `reviews` sampled runs reviewed and `reviewScore` the sum of their scores.
//   `record` copies them untouched; `recordReview` decays them from `reviewedAt` before adding a review.
//
// - `reworked` (run counter, decays with the others): runs whose files the lead edited soon after (see `recordRework`).
//
// Counters may be fractional once decayed. `updatedAt` (ms) is set only when a run is recorded with a clock.
// Every optional field is absent in stats stored before it existed: `notAccepted` then reads as `escalated`, a cell
// without `cost` has no cost evidence, a cell without `reviews` has no review.
export type Cell = {
  runs: number
  escalated: number
  tokens: number
  failedVerify?: number
  notAccepted?: number
  updatedAt?: number
  cost?: number
  costRuns?: number
  reviews?: number
  reviewScore?: number
  reviewedAt?: number
  reworked?: number
}
export type Stats = Record<string, Partial<Record<Tier, Cell>>>

// Keyword categories, tried in this order on the description. Labels and their order are the original ones, with
// 'review' (new) inserted before 'explore' and 'feature' (new) last, so a description that landed in a label before
// still does, except one that also says "review"/"audit" and nothing earlier in the list (it was 'explore' or 'other').
// The patterns grew and now stop at word edges.
const KEYWORDS: [RegExp, string][] = [
  [/\b(?:test\w*|specs?|coverage|e2e|jest|vitest|pytest|tdd|assert\w*)\b/i, 'tests'],
  [/\b(?:fix\w*|bugs?|bugfix\w*|debug\w*|errors?|crash\w*|fail\w*|broken|regress\w*|defects?|exceptions?|stack ?traces?|hotfix\w*|repair\w*|flaky)\b/i, 'bugfix'],
  [/\b(?:refactor\w*|rework\w*|rewrit\w*|renam\w*|clean ?up|simplif\w*|restructur\w*|reorgani[sz]\w*|dedup\w*|tidy\w*|extract\w*)\b/i, 'refactor'],
  [/\b(?:docs?|documentation|document\w*|readme|comments?|changelog|jsdoc|docstrings?|tutorials?)\b/i, 'docs'],
  [/\b(?:migrat\w*|schemas?|databases?|db|sql\w*|postgres\w*|queries|query|datasets?|csv|etl)\b/i, 'data'],
  [/\b(?:ui|ux|css|scss|tailwind|components?|layouts?|styl(?:e|es|ing)|front-?end|buttons?|modals?|responsive|svg|html|themes?)\b/i, 'ui'],
  [/\b(?:review\w*|audit\w*|critique|assess\w*|vet|proofread\w*)\b/i, 'review'],
  [/\b(?:search\w*|find\w*|explor\w*|research\w*|read|reads|investigat\w*|survey\w*|inspect\w*|map|locate|trace|analy[sz]\w*|summari[sz]\w*|understand\w*|look(?:ing)? (?:up|into|for|at))\b/i, 'explore'],
  [/\b(?:implement\w*|add|adds|adding|creat\w*|build|develop\w*|introduc\w*|new|features?|wire|wiring|extend\w*|support)\b/i, 'feature'],
]

// The agent type read as words ("security-reviewer" -> security, reviewer). Strong hints win over the description:
// a reviewer reviews even when its task text talks about tests or errors. Weak hints only apply when the description
// said nothing.
const TYPE_STRONG: [RegExp, string][] = [
  [/^(?:review\w*|audit\w*|critic|inspector)$/, 'review'],
  [/^(?:tests?|tester|testers|testing|qa)$/, 'tests'],
  [/^(?:writer|writers|docs?|documenter|documentation)$/, 'docs'],
]
const TYPE_WEAK: [RegExp, string][] = [[/^(?:explor\w*|research\w*|scout|search\w*|analyst|investigat\w*)$/, 'explore']]

function typeHint(subagentType: string, table: [RegExp, string][]): string | undefined {
  const words = subagentType.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  for (const [re, label] of table) if (words.some((w) => re.test(w))) return label
  return undefined
}

// The label whose pattern appears first in the brief (a brief opens with what the task is: "Implement ... test first").
function firstLabel(text: string): string | undefined {
  let best: { at: number; label: string } | undefined
  for (const [re, label] of KEYWORDS) {
    const at = text.search(re)
    if (at >= 0 && (best === undefined || at < best.at)) best = { at, label }
  }
  return best?.label
}

// `type:label`. The label comes from, in order: the agent type when it names a role (reviewer, tester, writer), the
// description (keyword rows in order), a weak type hint (explorer), the first words of the prompt, else 'other'.
export function categorize(subagentType: string, description: string, prompt?: string): string {
  let label: string | undefined
  try {
    const type = typeof subagentType === 'string' ? subagentType : ''
    const desc = typeof description === 'string' ? description : ''
    label = typeHint(type, TYPE_STRONG)
    if (label === undefined) label = KEYWORDS.find(([re]) => re.test(desc))?.[1]
    if (label === undefined) label = typeHint(type, TYPE_WEAK)
    if (label === undefined && typeof prompt === 'string' && prompt !== '') label = firstLabel(promptHead(prompt))
  } catch {
    label = undefined
  }
  return `${subagentType}:${label ?? 'other'}`
}

// Old runs fade: every counter of a cell halves after this much time without a new run.
export const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000

// Share of a counter left after `ms` (0.5 per half-life). 1 without a clock, for a clock that went backwards (it never
// inflates counters) or with decay turned off.
function fade(ms: number | undefined, halfLifeMs: number): number {
  return ms !== undefined && ms > 0 && halfLifeMs > 0 ? 0.5 ** (ms / halfLifeMs) : 1
}

// Run counters of `c` as seen at `now`. Cells without `updatedAt` (stored before decay existed) or calls without `now`
// are read as they are. Review counters are left as they are: they have their own clock. Never mutates `c`.
function decayed(c: Cell, now: number | undefined, halfLifeMs: number): Cell {
  if (now === undefined || c.updatedAt === undefined) return c
  const f = fade(now - c.updatedAt, halfLifeMs)
  if (f === 1) return c
  return {
    ...c,
    runs: c.runs * f,
    escalated: c.escalated * f,
    tokens: c.tokens * f,
    ...(c.failedVerify !== undefined ? { failedVerify: c.failedVerify * f } : {}),
    ...(c.notAccepted !== undefined ? { notAccepted: c.notAccepted * f } : {}),
    ...(c.cost !== undefined ? { cost: c.cost * f } : {}),
    ...(c.costRuns !== undefined ? { costRuns: c.costRuns * f } : {}),
    ...(c.reworked !== undefined ? { reworked: c.reworked * f } : {}),
  }
}

const EMPTY: Cell = { runs: 0, escalated: 0, tokens: 0 }

// Thresholds of the learning rules.
// - `minRuns`: decayed runs (and, for the cost rule, decayed priced runs) a tier needs before its evidence counts.
// - `maxEscalationRate`: highest share of not-accepted runs a tier may have before the rule climbs over it. The name
//   is historical: the rate is the not-accepted rate (escalated, failed verification or reviewed below the bar).
// - `minReviewScore`: lowest review score (1 to 5) of an accepted run; 3 is "works but needs changes".
// - `costMargin`: the cost rule picks another tier than the failure-rate rule only when that tier's expected cost per
//   accepted run is lower by more than this share, so noise in the estimates does not make the choice flap.
export const LEARN = { minRuns: 5, maxEscalationRate: 0.4, minReviewScore: 3, costMargin: 0.1 }

const validScore = (s: unknown): s is number => typeof s === 'number' && s >= 1 && s <= 5

// What is known of one run when it is judged. `reviewScore` only when the run was sampled and its review scored.
export type Outcome = { escalated: boolean; verifyFailed?: boolean; reviewScore?: number }

// A run is accepted when it was not escalated, passed the verification gate when one ran, and, when it was reviewed,
// scored at least `minScore`. A score outside 1-5 is no review at all.
export function isAccepted(o: Outcome, minScore = LEARN.minReviewScore): boolean {
  if (o.escalated || o.verifyFailed === true) return false
  return !(validScore(o.reviewScore) && o.reviewScore < minScore)
}

export type RecordOptions = {
  // USD the run cost, escalation and consults included. Absent (or not a finite number >= 0) when unknown.
  cost?: number
  // Score of the run's review when it landed before the run was recorded: it then counts in the acceptance here,
  // and `recordReview` must not flip the run again (see the note above `recordReview`).
  reviewScore?: number
  minScore?: number
}

// Adds one run to the cell of `category` and start `tier`: decays the run counters to `now` first, then counts the
// run and, when it is not accepted, one not-accepted run. Review counters and any unknown field are kept as they
// are. Never mutates `stats`.
export function record(
  stats: Stats,
  category: string,
  tier: Tier,
  escalated: boolean,
  tokens: number,
  verifyFailed = false,
  now?: number,
  halfLifeMs = HALF_LIFE_MS,
  opts: RecordOptions = {},
): Stats {
  const row = { ...(stats[category] ?? {}) }
  const c = decayed(row[tier] ?? EMPTY, now, halfLifeMs)
  const accepted = isAccepted({ escalated, verifyFailed, reviewScore: opts.reviewScore }, opts.minScore)
  const cost = opts.cost
  const priced = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
  row[tier] = {
    ...c,
    runs: c.runs + 1,
    escalated: c.escalated + (escalated ? 1 : 0),
    tokens: c.tokens + tokens,
    failedVerify: (c.failedVerify ?? 0) + (verifyFailed ? 1 : 0),
    notAccepted: (c.notAccepted ?? c.escalated) + (accepted ? 0 : 1),
    ...(priced ? { cost: (c.cost ?? 0) + cost, costRuns: (c.costRuns ?? 0) + 1 } : {}),
    ...(now !== undefined ? { updatedAt: now } : {}),
  }
  return { ...stats, [category]: row }
}

// --- Reviews (late acceptance) ---
//
// A sampled run is reviewed in the background, so its score may land before or after the run is recorded. Each run
// must count as not accepted at most once, whatever the order. The caller keeps, per sampled run and only in memory,
// whether the run was recorded yet and, if so, whether it was counted as accepted (`isAccepted` of its outcome
// without the review) and when; both writes go through the same serialized store queue.
//
// - Review first: `recordReview` with `runAccepted` absent adds the score to the review counters only; the score is
//   then passed to `record` as `reviewScore`, which counts the run as not accepted if the score is below the bar.
// - Run first: `record` counts the run on its other signals; `recordReview` with `runAccepted: true` (the run was
//   counted as accepted) moves it to not accepted if the score is below the bar. With `runAccepted: false` (already
//   not accepted: escalated or failed verification) the score only enters the review counters.
//
// The flip adds the run's weight today, `0.5 ^ ((now - runAt) / halfLife)` (1 without `runAt`), to the decayed
// `notAccepted`: the run already faded in `runs` by that much, so the not-accepted rate moves exactly as if the run
// had been recorded as not accepted. `notAccepted` never exceeds `runs`, so even a repeated flip of the same run
// cannot count more failures than runs.

export type ReviewOptions = {
  now?: number
  halfLifeMs?: number
  // true when the reviewed run was already recorded and counted as accepted.
  runAccepted?: boolean
  // When that run was recorded (ms).
  runAt?: number
  minScore?: number
}

// Moves one run, counted as accepted, to not accepted in the (already decayed) cell: adds the run's weight today,
// `0.5 ^ ((now - runAt) / halfLife)` (1 without `runAt`), capped so `notAccepted` never exceeds `runs`.
function notAcceptedOnce(c: Cell, now: number | undefined, runAt: number | undefined, halfLifeMs: number): Cell {
  const w = now !== undefined && runAt !== undefined ? fade(now - runAt, halfLifeMs) : 1
  const before = c.notAccepted ?? c.escalated
  return {
    ...c,
    notAccepted: Math.max(before, Math.min(c.runs, before + w)),
    ...(now !== undefined && (c.updatedAt === undefined || now > c.updatedAt) ? { updatedAt: now } : {}),
  }
}

// Adds one review score (1 to 5) to the cell of `category` and start `tier`, and flips its run to not accepted when
// `runAccepted` and the score is below `minScore`. A review may land before any run of the cell: the cell then
// starts with no runs. An invalid score returns `stats` itself. Never mutates `stats`.
export function recordReview(stats: Stats, category: string, tier: Tier, score: number, opts: ReviewOptions = {}): Stats {
  if (!validScore(score)) return stats
  const { now, halfLifeMs = HALF_LIFE_MS, runAccepted, runAt, minScore = LEARN.minReviewScore } = opts
  const row = { ...(stats[category] ?? {}) }
  const raw = row[tier] ?? EMPTY
  const flip = runAccepted === true && score < minScore
  const c: Cell = flip ? notAcceptedOnce(decayed(raw, now, halfLifeMs), now, runAt, halfLifeMs) : { ...raw }
  const g = now !== undefined && raw.reviewedAt !== undefined ? fade(now - raw.reviewedAt, halfLifeMs) : 1
  row[tier] = {
    ...c,
    reviews: (raw.reviews ?? 0) * g + 1,
    reviewScore: (raw.reviewScore ?? 0) * g + score,
    ...(now !== undefined && (raw.reviewedAt === undefined || now > raw.reviewedAt) ? { reviewedAt: now } : {}),
  }
  return { ...stats, [category]: row }
}

// --- Rework ---
//
// The lead edited, soon after the run ended, a file a cheap agent had written: the run needed fixing. Same "shift
// once" semantics as a late review: the caller knows (in memory) whether the run was counted as accepted and when,
// and calls this once per run. `runAccepted: true` moves the run to not accepted with its decayed weight; any other
// value only counts the rework. The cell's `reworked` grows by one either way. A cell that does not exist returns
// `stats` itself. Never mutates `stats`.
export type ReworkOptions = { now?: number; halfLifeMs?: number; runAccepted?: boolean; runAt?: number }

export function recordRework(stats: Stats, category: string, tier: Tier, opts: ReworkOptions = {}): Stats {
  const raw = stats[category]?.[tier]
  if (raw === undefined) return stats
  const { now, halfLifeMs = HALF_LIFE_MS, runAccepted, runAt } = opts
  const d = decayed(raw, now, halfLifeMs)
  // Decayed to `now`, so the clock moves with the counters even when the run was not accepted before.
  const c = runAccepted === true ? notAcceptedOnce(d, now, runAt, halfLifeMs)
    : { ...d, ...(now !== undefined && d.updatedAt !== undefined && now > d.updatedAt ? { updatedAt: now } : {}) }
  return { ...stats, [category]: { ...stats[category], [tier]: { ...c, reworked: (d.reworked ?? 0) + 1 } } }
}

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

// --- Cost per accepted run ---
//
// For a tier with enough priced runs (decayed `costRuns` >= `minRuns`, decayed `runs` >= `minRuns`):
//   mean cost of a run       m = cost / costRuns
//   acceptance probability   p = (accepted + 1) / (runs + 2), accepted = runs - notAccepted
//   cost per accepted run    E = m / p
// `p` is the posterior mean of Beta(accepted + 1, notAccepted + 1), the same uniform prior exploration samples from,
// so a handful of runs is pulled towards 1/2 instead of reading as 0% or 100%. `m / p` counts the rework: a run that
// is not accepted has to be done again, on average 1/p runs per accepted one. The cost of a run is what the agent
// spent in total, so an escalation inside the run (hot swap, senior consults) is already part of `m`.

// Expected USD per accepted run on the tier of `c`, or undefined without enough priced runs. Never throws.
export function costPerAccepted(c: Cell, now?: number, halfLifeMs = HALF_LIFE_MS): number | undefined {
  const d = decayed(c, now, halfLifeMs)
  const runs = d.runs
  const priced = d.costRuns ?? 0
  const cost = d.cost
  if (!(runs >= LEARN.minRuns && priced >= LEARN.minRuns) || typeof cost !== 'number' || !(cost >= 0)) return undefined
  const accepted = Math.max(0, Math.min(runs, runs - failures(d)))
  const e = cost / priced / ((accepted + 1) / (runs + 2))
  return Number.isFinite(e) ? e : undefined
}

type Passed = { tier: Tier; cell: Cell; beat?: number }
type Learned = { tier: Tier; passed: Passed[]; basis?: 'cost' }

// The tier learning picks, and the tiers it passed over (cheapest first, decayed cells).
//
// The failure-rate rule (`climb`) picks a tier L. The cost rule then looks at the tiers from `requested` upward that
// all have a cost per accepted run, stopping at the first one without: it decides only when that unbroken run of
// priced tiers reaches L, i.e. every tier the rule looked at is priced. Otherwise, or with `byCost` false, L stands
// (the behaviour before costs were recorded). When it decides, it takes the tier with the lowest E (the cheaper one on
// a tie), but replaces L only when E is lower than E(L) by more than `costMargin`. It never goes below `requested`
// and may land above L (a cheap tier that accepts often but runs long) or below it (one that fails more than 40% of
// the time but is still cheaper per accepted run). `beat` on a passed tier is m / E(chosen): the acceptance it would
// need to cost no more per accepted run than the chosen tier, used by exploration.
function learn(stats: Stats, category: string, requested: Tier, now: number | undefined, halfLifeMs: number, byCost: boolean): Learned {
  const rule = climb(stats, category, requested, now, halfLifeMs)
  if (!byCost) return rule
  const priced: { tier: Tier; e: number; m: number; cell: Cell }[] = []
  for (let i = LADDER.indexOf(requested); i >= 0 && i < LADDER.length; i++) {
    const tier = LADDER[i]!
    const raw = stats[category]?.[tier]
    const e = raw === undefined ? undefined : costPerAccepted(raw, now, halfLifeMs)
    if (raw === undefined || e === undefined) break
    const cell = decayed(raw, now, halfLifeMs)
    priced.push({ tier, e, m: (cell.cost ?? 0) / (cell.costRuns ?? 1), cell })
  }
  const atRule = priced.find((p) => p.tier === rule.tier)
  if (atRule === undefined) return rule
  let best = atRule
  for (const p of priced) if (p.e < best.e || (p.e === best.e && LADDER.indexOf(p.tier) < LADDER.indexOf(best.tier))) best = p
  if (best !== atRule && !(best.e < atRule.e * (1 - LEARN.costMargin))) best = atRule
  const passed = priced
    .filter((p) => LADDER.indexOf(p.tier) < LADDER.indexOf(best.tier))
    .map((p) => ({ tier: p.tier, cell: p.cell, beat: best.e > 0 ? p.m / best.e : Infinity }))
  return { tier: best.tier, passed, basis: 'cost' }
}

// The tier to start on for `category` when `requested` was asked. With `byCost` (the default) and enough priced runs
// on every tier involved, the tier with the lowest expected cost per accepted run; otherwise the failure-rate rule,
// which climbs the ladder while a tier's not-accepted rate is above `maxEscalationRate` over at least `minRuns` runs.
// With `now`, old evidence is decayed first: the rate is unchanged (all counters fade together) but a category left
// alone long enough drops below `minRuns` and falls back to the requested tier. Never throws.
export function recommend(stats: Stats, category: string, requested: Tier, now?: number, halfLifeMs = HALF_LIFE_MS, byCost = true): Tier {
  return learn(stats, category, requested, now, halfLifeMs, byCost).tier
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
//
// When the cost rule decided, "good enough" means "no more expensive per accepted run than the chosen tier": a passed
// tier with mean cost m beats E(chosen) when its acceptance exceeds m / E(chosen), i.e. when its failure rate is below
// 1 - m / E(chosen). The chance is the same Beta posterior CDF at that threshold instead of at `maxEscalationRate`
// (0 when even a perfect acceptance could not beat the chosen tier).

export type Reason = 'requested' | 'raised' | 'explore'
// `tier` is the tier to start on; `learned` is what `recommend` would pick; `basis` is 'cost' when the cost per
// accepted run decided, absent when the failure-rate rule did.
export type Choice = { tier: Tier; reason: Reason; learned: Tier; basis?: 'cost' }
export type ExploreOptions = {
  now?: number
  halfLifeMs?: number
  // Uniform source in [0, 1). Without it nothing is explored and the result equals `recommend`.
  rand?: () => number
  // Weight in [0, 1] applied to every exploration chance: 1 is plain Thompson sampling, 0 turns exploration off.
  explore?: number
  // false: only the failure-rate rule, as before costs were recorded. Default true.
  byCost?: boolean
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
  const { tier: learned, passed, basis } = learn(stats, category, requested, now, halfLifeMs, opts.byCost !== false)
  const tag = basis !== undefined ? { basis } : {}
  if (passed.length === 0) return { tier: learned, reason: 'requested', learned, ...tag }
  const w = opts.explore ?? 1
  const weight = w >= 0 ? Math.min(1, w) : 0
  if (rand !== undefined && weight > 0) {
    // cells in `passed` are already decayed
    for (const { tier, cell, beat } of passed) {
      const chance = beat === undefined ? goodEnoughChance(cell) : beatChance(cell, beat)
      if (rand() < weight * chance) return { tier, reason: 'explore', learned, ...tag }
    }
  }
  return { tier: learned, reason: 'raised', learned, ...tag }
}

// Posterior probability that the (already decayed) cell's acceptance is above `need`.
function beatChance(c: Cell, need: number): number {
  if (!(need < 1)) return 0
  const bad = Math.max(0, failures(c))
  const good = Math.max(0, c.runs - bad)
  return betaCdf(1 - need, bad + 1, good + 1)
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

// Counters decay into fractions: shown rounded to one decimal, and without ".0" when that is a whole number, so a
// count of 1.96 reads "2" and not "2.0" next to a "2". Whole counts stay as they are.
const round1 = (n: number): number => Math.round(n * 10) / 10
const num1 = (n: number): string => String(round1(n))
const runsText = (n: number): string => (round1(n) === 1 ? '1 run' : `${num1(n)} runs`)

function ageText(ms: number): string {
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`
  return `${Math.floor(ms / 86_400_000)} d ago`
}

const usd = (x: number): string => '$' + (x < 0.01 ? x.toFixed(4) : x.toFixed(2))

// "mean cost per run" and, with enough data, "cost per accepted run" of a cell; '' when the cell has no priced run.
function costText(c: Cell, now: number | undefined, halfLifeMs: number): string {
  if (!(typeof c.cost === 'number' && typeof c.costRuns === 'number' && c.costRuns > 0)) return ''
  const e = costPerAccepted(c, now, halfLifeMs)
  return `, ${usd(c.cost / c.costRuns)}/run` + (e !== undefined ? `, ${usd(e)} per accepted` : '')
}

// One line per category and tier; counters may be fractional once decayed. With `now`, shows how old each cell is.
// Cells with priced runs also show the mean cost of a run and the cost per accepted run. Lines are grouped by agent
// type (the part of the category before the colon), the most expensive type first, then the most expensive
// category, then the tier order; where costs tie the stored order is kept.
export function formatStats(stats: Stats, now?: number, halfLifeMs = HALF_LIFE_MS): string {
  type Row = { category: string; type: string; order: number; cost: number; seq: number; text: string }
  const rows: Row[] = []
  for (const [category, row] of Object.entries(stats)) {
    for (const [tier, c] of Object.entries(row)) {
      if (!c) continue
      const failed = c.failedVerify ? `, ${num1(c.failedVerify)} failed verify` : ''
      const na = c.notAccepted !== undefined && c.notAccepted !== c.escalated ? `, ${num1(c.notAccepted)} not accepted` : ''
      const rw = c.reworked ? `, reworked ${num1(c.reworked)}` : ''
      const age = now !== undefined && c.updatedAt !== undefined ? ` (updated ${ageText(Math.max(0, now - c.updatedAt))})` : ''
      const colon = category.indexOf(':')
      rows.push({
        category, type: colon > 0 ? category.slice(0, colon) : category, order: LADDER.indexOf(tier as Tier), seq: rows.length,
        cost: typeof c.cost === 'number' && Number.isFinite(c.cost) ? c.cost : 0,
        text: `- ${category} ${tier}: ${runsText(c.runs)}, ${num1(c.escalated)} escalated${failed}${na}${rw}${costText(c, now, halfLifeMs)}${age}`,
      })
    }
  }
  if (rows.length === 0) return 'No stats yet.'
  const typeCost = new Map<string, number>()
  const catCost = new Map<string, number>()
  const typeSeq = new Map<string, number>()
  const catSeq = new Map<string, number>()
  for (const r of rows) {
    typeCost.set(r.type, (typeCost.get(r.type) ?? 0) + r.cost)
    catCost.set(r.category, (catCost.get(r.category) ?? 0) + r.cost)
    if (!typeSeq.has(r.type)) typeSeq.set(r.type, r.seq)
    if (!catSeq.has(r.category)) catSeq.set(r.category, r.seq)
  }
  rows.sort((x, y) =>
    (typeCost.get(y.type)! - typeCost.get(x.type)!) || (typeSeq.get(x.type)! - typeSeq.get(y.type)!) ||
    (catCost.get(y.category)! - catCost.get(x.category)!) || (catSeq.get(x.category)! - catSeq.get(y.category)!) ||
    (x.order - y.order) || (x.seq - y.seq))
  return rows.map((r) => r.text).join('\n')
}

// --- Scope: per-project statistics with a global fallback ---
//
// The same category can be easy in one repository and hard in another. Besides the global table (store key `stats`,
// unchanged, so nothing to migrate) the caller keeps a second store key with one small table per project. Every run
// is recorded in both; reads use the project's cell of a tier when it has enough evidence and the global cell
// otherwise. Projects are identified by `projectKey`, a hash of the working directory: no raw path is ever stored.

export const MAX_PROJECTS = 30

export type Projects = Record<string, { stats: Stats; seenAt: number }>

// FNV-1a, 32 bit, from a given offset basis.
function fnv1a(s: string, basis: number): string {
  let h = basis >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// Stable short id of a project directory, or '' when `path` is empty or not a string. Backslashes become slashes,
// repeated and trailing slashes go, and Windows paths (a drive letter or a backslash) are compared case-insensitively.
// The id is 16 hex digits (two FNV-1a hashes with different offsets); the path itself cannot be recovered from it.
export function projectKey(path: unknown): string {
  if (typeof path !== 'string') return ''
  const windows = /^[a-z]:/i.test(path.trim()) || path.includes('\\')
  let p = path.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (p.length > 1) p = p.replace(/\/+$/, '')
  if (windows) p = p.toLowerCase()
  if (p === '') return ''
  return fnv1a(p, 0x811c9dc5) + fnv1a(p, 0x9747b28c)
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// Reads the stored projects table: entries that are not `{ stats: object, seenAt: number }` are dropped, anything
// that is not an object gives an empty table. Never throws.
export function parseProjects(raw: unknown): Projects {
  const out: Projects = {}
  if (!isObj(raw)) return out
  for (const [k, v] of Object.entries(raw)) {
    if (isObj(v) && isObj(v['stats']) && typeof v['seenAt'] === 'number' && Number.isFinite(v['seenAt'])) {
      out[k] = { stats: v['stats'] as Stats, seenAt: v['seenAt'] }
    }
  }
  return out
}

// Puts `stats` at `key`, marks it seen at `now` and keeps at most `max` projects: the least recently seen go first,
// never the one just written. Never mutates `projects`.
function putProject(projects: Projects, key: string, stats: Stats, now: number | undefined, max: number): Projects {
  const seenAt = now ?? projects[key]?.seenAt ?? 0
  const next: Projects = { ...projects, [key]: { stats, seenAt } }
  const keys = Object.keys(next)
  const cap = Math.max(1, Math.floor(max))
  if (keys.length <= cap) return next
  const evict = keys.filter((k) => k !== key).sort((a, b) => next[a]!.seenAt - next[b]!.seenAt).slice(0, keys.length - cap)
  for (const k of evict) delete next[k]
  return next
}

export type Scoped = { stats: Stats; projects: Projects }

// `record` on the global table and on the table of project `key` (global only when `key` is empty or absent).
export function recordScoped(
  global: Stats,
  projects: Projects,
  key: string | undefined,
  category: string,
  tier: Tier,
  escalated: boolean,
  tokens: number,
  verifyFailed = false,
  now?: number,
  halfLifeMs = HALF_LIFE_MS,
  opts: RecordOptions = {},
  maxProjects = MAX_PROJECTS,
): Scoped {
  const stats = record(global, category, tier, escalated, tokens, verifyFailed, now, halfLifeMs, opts)
  if (!key) return { stats, projects }
  const mine = record(projects[key]?.stats ?? {}, category, tier, escalated, tokens, verifyFailed, now, halfLifeMs, opts)
  return { stats, projects: putProject(projects, key, mine, now, maxProjects) }
}

// `recordReview` on both tables. The project table is left alone when it does not know the project yet.
export function recordReviewScoped(
  global: Stats, projects: Projects, key: string | undefined, category: string, tier: Tier, score: number, opts: ReviewOptions = {},
): Scoped {
  const stats = recordReview(global, category, tier, score, opts)
  const p = key ? projects[key] : undefined
  if (!key || p === undefined) return { stats, projects }
  const mine = recordReview(p.stats, category, tier, score, opts)
  return { stats, projects: mine === p.stats ? projects : { ...projects, [key]: { ...p, stats: mine } } }
}

// `recordRework` on both tables, same rule.
export function recordReworkScoped(
  global: Stats, projects: Projects, key: string | undefined, category: string, tier: Tier, opts: ReworkOptions = {},
): Scoped {
  const stats = recordRework(global, category, tier, opts)
  const p = key ? projects[key] : undefined
  if (!key || p === undefined) return { stats, projects }
  const mine = recordRework(p.stats, category, tier, opts)
  return { stats, projects: mine === p.stats ? projects : { ...projects, [key]: { ...p, stats: mine } } }
}

// The stats to read for `category` in project `key`: per tier, the project's cell when it has at least `minRuns`
// decayed runs, else the global cell. Only `category` is in the result, so `recommend`, `recommendWithExploration`
// and `costPerAccepted` work on it unchanged. Without a known project it is the global row. Never throws.
export function scopedStats(
  global: Stats, projects: Projects, key: string | undefined, category: string, now?: number, halfLifeMs = HALF_LIFE_MS,
): Stats {
  const g = global[category] ?? {}
  const mine = key ? projects[key]?.stats[category] : undefined
  if (mine === undefined) return { [category]: g }
  const row: Partial<Record<Tier, Cell>> = { ...g }
  for (const tier of LADDER) {
    const c = mine[tier]
    if (c !== undefined && decayed(c, now, halfLifeMs).runs >= LEARN.minRuns) row[tier] = c
  }
  return { [category]: row }
}

// `recommend` over `scopedStats`.
export function recommendScoped(
  global: Stats, projects: Projects, key: string | undefined, category: string, requested: Tier,
  now?: number, halfLifeMs = HALF_LIFE_MS, byCost = true,
): Tier {
  return recommend(scopedStats(global, projects, key, category, now, halfLifeMs), category, requested, now, halfLifeMs, byCost)
}

// `recommendWithExploration` over `scopedStats`.
export function recommendScopedWithExploration(
  global: Stats, projects: Projects, key: string | undefined, category: string, requested: Tier, opts: ExploreOptions = {},
): Choice {
  const view = scopedStats(global, projects, key, category, opts.now, opts.halfLifeMs ?? HALF_LIFE_MS)
  return recommendWithExploration(view, category, requested, opts)
}
