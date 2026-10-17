// Downshift advice: tells the user when a task category runs on a model stronger than it seems to need.
//
// Learning (`learning.ts`) only climbs: it never starts an agent below the model the Agent call asked for, so a
// category that always asks for opus and never gets stuck keeps paying opus prices. The mod cannot change that at
// spawn without overriding an explicit choice; it can only tell the user, who decides. This module reads the learned
// statistics and lists those categories, one suggestion each, one tier down. Pure: no engine calls, never throws.
//
// How to wire it (register.ts and stats-view.ts, not done here):
//
// - Input. The global table (store key `stats`) and the projects table (`parseProjects` of store key `projects`)
//   with the session's `projectId`; options from the config: `minReviewScore`, `prices`, `learnByCost`,
//   `verify` (a `verifyCommand` is set), `reworkWindowMinutes`, plus the lead's `baseline`, `now` (`clockNow($)`) and
//   `halfLifeMs()`. The project cell of a tier is used when it has enough runs, the global one otherwise, exactly as
//   `scopedStats` does for learning.
// - `/escalator stats`. Append `formatAdvice(list, { respectExplicitModel, reviewRate }).text`,
//   when not empty, as its own block after the learned stats and the review scores and before this session's
//   savings per category (`'\n\n' + text`).
// - Stats panel. A small section after "learned" built in stats-view.ts from the same list (one row per suggestion:
//   category, `tier -> suggested`, runs, cost now and estimated; `strength` as dim text). The list must be part of
//   the panel's redraw signature; computing it is cheap (one pass over the tables).
// - Hint. Once per session, the first time the `/escalator` report is shown (optionally also as a `$.ui.log` line
//   at session start; never a toast, it is not urgent). Read the store key `adviceHinted` (a table of
//   `category|tier` -> ms), call `pickHint(list, hinted, now)`; when it returns a suggestion, add `hintLine(a)` to
//   the report and write back `markHinted(hinted, a, now)`. Keep a `$.state` flag (literal key) so a module reload
//   does not show it twice in the same session. `pickHint` skips what was shown in the last `repeatAfterMs`, so the
//   same suggestion comes back at most weekly and only while the evidence still holds. Only `strong` suggestions
//   become hints; `moderate` ones stay in `/escalator stats` and the panel.
// - Modes. Show nothing in `off`; in `baseline` every agent runs on the reference model on purpose, so no hint.
//
// Quality. "Never got stuck" says the tier finishes the work, not that a cheaper tier would do it as well. A
// suggestion is `measured` only when something would show a drop in the quality of the work (`qualityFor`): enough
// senior reviews of this category (on the current or the cheaper tier), a `verifyCommand` for work that writes code,
// or lead rework for work that writes files, on a tier below the lead's model where rework is tracked. Read-only work
// (`review`, `explore`) has none of these: no diff to review, nothing to test or rework. An `unmeasured` suggestion is
// never strong and never the hint; it stays in `/escalator stats` and the panel, worded so it does not vouch for the
// cheaper model.

import { DEFAULT_PRICES, type Price } from './config'
import { LADDER, type Tier } from './detector'
import { HALF_LIFE_MS, LEARN, recommend, scopedStats, type Cell, type Projects, type Stats } from './learning'

// Thresholds. All rates are over decayed counters, the same ones learning reads.
//
// - `minRuns` 8: more than learning's own `minRuns` (5), because a suggestion asks the user to act. With no failure
//   in 8 runs the 95% upper bound of the failure rate is about 3/8 (rule of three), already under learning's 40%
//   bar: the evidence alone shows the category is easy on this tier, not a lucky streak of 3 or 4 runs.
// - `maxEscalationRate` 5%: "never gets stuck", with room for one escalation in 20 runs.
// - `maxNotAcceptedRate` 10%: escalations, failed verifications, low reviews and rework together, one in 10 at most.
//   A category that already needs fixing now and then on the stronger tier is a poor candidate for a weaker one.
// - `strongRuns` 16: twice `minRuns`, with a not-accepted rate within `maxEscalationRate`. Only strong suggestions
//   become the session hint.
// - `cheaperMinRuns` 2 and `cheaperMaxNotAcceptedRate` 25%: the cheaper tier's own cell blocks the suggestion when
//   it already failed this category in more than a quarter of at least 2 runs, or its reviews average below the bar.
//   One failed run alone is noise; 2 of 3, or 1 of 2, is a warning. It is stricter than learning (40% over 5 runs),
//   which also blocks: the suggestion is dropped whenever learning would raise the cheaper tier back.
//   A cheaper tier with at least `LEARN.minRuns` runs within `maxNotAcceptedRate` has proven itself: the suggestion
//   is strong whatever the run count on the current tier.
// - `maxLines` suggestions are listed, `repeatAfterMs` (7 days) between two hints for the same category and tier,
//   `maxHinted` entries kept in the hint table.
// - `minReviews` 3: reviews (decayed) a cell needs before their mean counts as a quality signal. One or two scores
//   are an anecdote; three at or above `minReviewScore` with no failure in the runs are a pattern.
export const ADVICE = {
  minReviews: 3,
  minRuns: 8,
  maxEscalationRate: 0.05,
  maxNotAcceptedRate: 0.1,
  strongRuns: 16,
  cheaperMinRuns: 2,
  cheaperMaxNotAcceptedRate: 0.25,
  maxLines: 5,
  repeatAfterMs: 7 * 24 * 60 * 60 * 1000,
  maxHinted: 50,
} as const

export type Strength = 'strong' | 'moderate'
export type Quality = 'measured' | 'unmeasured'
// The signal that measures a suggestion: reviews of the current tier's runs, of the cheaper tier's runs, the
// verifyCommand, lead rework counted on the current tier, or lead rework that would be counted on the cheaper tier.
export type QualitySignal = 'reviews' | 'cheaper-reviews' | 'verify' | 'rework' | 'rework-cheaper'

// Category labels (`classify.ts` LABELS) by what the work leaves behind. Any other label, `other` included, is work
// of unknown kind: only reviews measure it.
export const WRITE_LABELS: readonly string[] = ['feature', 'bugfix', 'tests', 'refactor', 'docs', 'ui', 'data']
export const CODE_LABELS: readonly string[] = ['feature', 'bugfix', 'tests', 'refactor', 'ui', 'data']
export const READ_ONLY_LABELS: readonly string[] = ['review', 'explore']

// The label of a `type:label` category: the text after the last colon, the whole text without one.
export function categoryLabel(category: string): string {
  const i = typeof category === 'string' ? category.lastIndexOf(':') : -1
  return typeof category === 'string' ? category.slice(i + 1) : ''
}

// One suggestion. Counts and rates are decayed to `now`; costs are USD per run.
export type Advice = {
  category: string
  tier: Tier                 // the tier the category ran on
  suggested: Tier            // one step down
  scope: 'project' | 'global'
  runs: number
  escalationRate: number
  notAcceptedRate: number
  reviewMean?: number        // only when the cell has reviews
  reviews?: number
  cheaperRuns?: number       // runs already recorded on the suggested tier, when any
  priceRatio: number         // price of the suggested tier over the current one (input and output)
  costNow?: number           // mean cost of a run on the current tier, when runs were priced
  costCheaper?: number       // estimate: costNow * priceRatio
  strength: Strength         // never 'strong' when unmeasured
  quality: Quality
  signal?: QualitySignal     // only when measured
  qualityNote: string        // measured: the signal ("reviews average 4.6"); unmeasured: why nothing measures it
}

export type AdviceOptions = {
  now?: number
  halfLifeMs?: number
  minReviewScore?: number
  prices?: Record<Tier, Price>
  learnByCost?: boolean
  projects?: Projects
  projectKey?: string
  verify?: boolean             // a verifyCommand is configured
  reworkWindowMinutes?: number // 0 turns rework tracking off; default on
  baseline?: Tier              // the lead's model: rework and reviews are tracked only on tiers below it; default opus
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const nonNeg = (v: unknown): v is number => isNum(v) && v >= 0

// A cell learning could have written: finite, non-negative `runs` and `escalated`; optional counters dropped when
// malformed. Undefined when the cell itself is unusable.
function cleanCell(raw: unknown): Cell | undefined {
  if (!isObj(raw) || !nonNeg(raw['runs']) || !nonNeg(raw['escalated'])) return undefined
  const c: Cell = { runs: raw['runs'], escalated: raw['escalated'], tokens: nonNeg(raw['tokens']) ? raw['tokens'] : 0 }
  for (const k of ['failedVerify', 'notAccepted', 'cost', 'costRuns', 'reviews', 'reviewScore', 'reworked'] as const) {
    const v = raw[k]
    if (nonNeg(v)) c[k] = v
  }
  if (isNum(raw['updatedAt'])) c.updatedAt = raw['updatedAt']
  if (isNum(raw['reviewedAt'])) c.reviewedAt = raw['reviewedAt']
  return c
}

// Only object rows, known tiers and usable cells.
function cleanStats(raw: unknown): Stats {
  const out: Stats = {}
  if (!isObj(raw)) return out
  for (const [category, row] of Object.entries(raw)) {
    if (!isObj(row)) continue
    const clean: Partial<Record<Tier, Cell>> = {}
    for (const tier of LADDER) {
      const c = cleanCell(row[tier])
      if (c !== undefined) clean[tier] = c
    }
    if (Object.keys(clean).length > 0) out[category] = clean
  }
  return out
}

const fade = (ms: number | undefined, halfLifeMs: number): number =>
  ms !== undefined && ms > 0 && halfLifeMs > 0 ? 0.5 ** (ms / halfLifeMs) : 1

// What the advice reads of a cell at `now`: run counters decayed from `updatedAt`, reviews from `reviewedAt`.
type Seen = {
  runs: number; escalated: number; notAccepted: number; failedVerify: number; reworked: number
  cost?: number; reviews?: number; reviewMean?: number
}

function look(c: Cell, now: number | undefined, halfLifeMs: number): Seen {
  const f = now !== undefined && c.updatedAt !== undefined ? fade(now - c.updatedAt, halfLifeMs) : 1
  const g = now !== undefined && c.reviewedAt !== undefined ? fade(now - c.reviewedAt, halfLifeMs) : 1
  const s: Seen = {
    runs: c.runs * f, escalated: c.escalated * f, notAccepted: (c.notAccepted ?? c.escalated) * f,
    failedVerify: (c.failedVerify ?? 0) * f, reworked: (c.reworked ?? 0) * f,
  }
  // Decay scales cost and costRuns alike, so the mean cost of a run does not change with it.
  if (c.cost !== undefined && c.costRuns !== undefined && c.costRuns > 0) s.cost = c.cost / c.costRuns
  if (c.reviews !== undefined && c.reviewScore !== undefined && c.reviews > 0) {
    s.reviews = c.reviews * g
    s.reviewMean = c.reviewScore / c.reviews
  }
  return s
}

const rate = (x: number, runs: number): number => (runs > 0 ? Math.min(1, x / runs) : 0)

// Price of `to` over `from`, from input and output prices (cache reads are priced closer between tiers, so the real
// saving can be smaller: the figure is an estimate). NaN when the prices are unusable.
export function priceRatio(from: Tier, to: Tier, prices: Record<Tier, Price> = DEFAULT_PRICES): number {
  const p = (t: Tier): number => {
    const x = isObj(prices) ? prices[t] : undefined
    return isObj(x) && nonNeg(x.input) && nonNeg(x.output) ? x.input + x.output : Number.NaN
  }
  const a = p(from)
  const r = p(to) / a
  return a > 0 && Number.isFinite(r) ? r : Number.NaN
}

const STRENGTH_ORDER: Record<Strength, number> = { strong: 0, moderate: 1 }
const QUALITY_ORDER: Record<Quality, number> = { measured: 0, unmeasured: 1 }
const saving = (a: Advice): number => (a.costNow !== undefined && a.costCheaper !== undefined ? (a.costNow - a.costCheaper) * a.runs : 0)

// The suggestions, strong first, then measured before unmeasured, then by estimated saving (cost difference per run
// times runs), then by runs. At most one per category: the qualifying tier with the most runs. Never throws;
// malformed input gives [].
export function downshiftAdvice(stats: unknown, opts: AdviceOptions = {}): Advice[] {
  try {
    const { now, halfLifeMs = HALF_LIFE_MS, minReviewScore = LEARN.minReviewScore, prices = DEFAULT_PRICES, learnByCost = true } = opts
    const verify = opts.verify === true
    const rework = !(isNum(opts.reworkWindowMinutes) && opts.reworkWindowMinutes <= 0)
    const baseline: Tier = isTier(opts.baseline) ? opts.baseline : 'opus'
    const global = cleanStats(stats)
    const projects: Projects = {}
    const key = typeof opts.projectKey === 'string' && opts.projectKey !== '' ? opts.projectKey : undefined
    const mine = key !== undefined && isObj(opts.projects) && isObj(opts.projects[key]) ? opts.projects[key] : undefined
    if (key !== undefined && mine !== undefined) projects[key] = { stats: cleanStats(mine.stats), seenAt: 0 }
    const categories = new Set([...Object.keys(global), ...Object.keys(key !== undefined ? projects[key]?.stats ?? {} : {})])
    const out: Advice[] = []
    for (const category of categories) {
      const view = scopedStats(global, projects, key, category, now, halfLifeMs)
      const row = view[category] ?? {}
      let best: Advice | undefined
      for (const tier of LADDER) {
        const a = adviseTier(view, row, category, tier, { now, halfLifeMs, minReviewScore, prices, learnByCost, verify, rework, baseline })
        if (a === undefined) continue
        a.scope = key !== undefined && row[tier] === projects[key]?.stats[category]?.[tier] ? 'project' : 'global'
        if (best === undefined || a.runs >= best.runs) best = a
      }
      if (best !== undefined) out.push(best)
    }
    return out.sort((a, b) => STRENGTH_ORDER[a.strength] - STRENGTH_ORDER[b.strength] ||
      QUALITY_ORDER[a.quality] - QUALITY_ORDER[b.quality] || saving(b) - saving(a) ||
      b.runs - a.runs || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0))
  } catch {
    return []
  }
}

type Ctx = {
  now?: number; halfLifeMs: number; minReviewScore: number; prices: Record<Tier, Price>; learnByCost: boolean
  verify: boolean; rework: boolean; baseline: Tier
}

const below = (t: Tier, baseline: Tier): boolean => LADDER.indexOf(t) < LADDER.indexOf(baseline)
const enough = (x: Seen | undefined): x is Seen & { reviews: number; reviewMean: number } =>
  x !== undefined && x.reviews !== undefined && x.reviewMean !== undefined && x.reviews >= ADVICE.minReviews - 1e-9

// What would show a drop in quality on this category, strongest first: reviews of either tier (the review gates of
// `adviseTier` already dropped the suggestion when their mean is below the bar), the verifyCommand for code, lead
// rework for written files. Rework (and reviews) are tracked only on runs that start below the lead's model, so for a
// tier at the lead's model the signal is the one the cheaper tier would get once the user switches.
function qualityFor(category: string, tier: Tier, suggested: Tier, s: Seen, c: Seen | undefined, x: Ctx):
  { quality: Quality; signal?: QualitySignal; qualityNote: string } {
  const label = categoryLabel(category)
  const n = (v: number): number => Math.round(v)
  if (READ_ONLY_LABELS.includes(label)) {
    return { quality: 'unmeasured', qualityNote: 'read-only work: no files to review, test or rework' }
  }
  if (enough(s)) return { quality: 'measured', signal: 'reviews', qualityNote: `reviews average ${s.reviewMean.toFixed(1)}` }
  if (enough(c)) return { quality: 'measured', signal: 'cheaper-reviews', qualityNote: `reviews of ${suggested} runs average ${c.reviewMean.toFixed(1)}` }
  const reviewed = Math.max(s.reviews ?? 0, c?.reviews ?? 0)
  const few = reviewed > 0 ? `only ${n(reviewed)} of the ${ADVICE.minReviews} reviews needed` : ''
  if (!WRITE_LABELS.includes(label)) {
    return { quality: 'unmeasured', qualityNote: few || 'no reviews, and the work is not known to change files' }
  }
  if (x.verify && CODE_LABELS.includes(label)) {
    const failed = n(s.failedVerify)
    const runs = n(s.runs)
    return { quality: 'measured', signal: 'verify',
      qualityNote: failed === 0 ? 'your verifyCommand passed' : `your verifyCommand passed in ${runs - failed} of ${runs} runs` }
  }
  if (x.rework && below(tier, x.baseline)) {
    const k = n(s.reworked)
    return { quality: 'measured', signal: 'rework', qualityNote: k === 0 ? 'no rework by the lead' : `the lead reworked ${k} of ${n(s.runs)} runs` }
  }
  if (x.rework && below(suggested, x.baseline)) {
    return { quality: 'measured', signal: 'rework-cheaper', qualityNote: `rework by the lead would show on ${suggested}` }
  }
  const why = !x.rework ? 'rework tracking is off' : 'rework is tracked only below the lead\'s model'
  return { quality: 'unmeasured', qualityNote: `${few || 'no reviews'}, no verifyCommand for this work, and ${why}` }
}

function adviseTier(view: Stats, row: Partial<Record<Tier, Cell>>, category: string, tier: Tier, x: Ctx): Advice | undefined {
  const i = LADDER.indexOf(tier)
  const cell = row[tier]
  if (i <= 0 || cell === undefined) return undefined
  const suggested = LADDER[i - 1]!
  const ratio = priceRatio(tier, suggested, x.prices)
  if (!(ratio < 1)) return undefined
  const s = look(cell, x.now, x.halfLifeMs)
  const escalationRate = rate(s.escalated, s.runs)
  const notAcceptedRate = rate(s.notAccepted, s.runs)
  if (s.runs < ADVICE.minRuns || escalationRate > ADVICE.maxEscalationRate || notAcceptedRate > ADVICE.maxNotAcceptedRate) return undefined
  if (s.reviewMean !== undefined && s.reviewMean < x.minReviewScore) return undefined
  // The cheaper tier's own evidence.
  const low = row[suggested]
  const c = low !== undefined ? look(low, x.now, x.halfLifeMs) : undefined
  if (c !== undefined) {
    if (c.runs >= ADVICE.cheaperMinRuns && rate(c.notAccepted, c.runs) > ADVICE.cheaperMaxNotAcceptedRate) return undefined
    if (c.reviewMean !== undefined && c.reviewMean < x.minReviewScore) return undefined
  }
  if (recommend(view, category, suggested, x.now, x.halfLifeMs, x.learnByCost) !== suggested) return undefined
  const proven = c !== undefined && c.runs >= LEARN.minRuns && rate(c.notAccepted, c.runs) <= ADVICE.maxNotAcceptedRate
  const q = qualityFor(category, tier, suggested, s, c, x)
  const strong = q.quality === 'measured' &&
    (proven || (s.runs >= ADVICE.strongRuns && notAcceptedRate <= ADVICE.maxEscalationRate))
  return {
    category, tier, suggested, scope: 'global', runs: s.runs, escalationRate, notAcceptedRate,
    ...(s.reviewMean !== undefined ? { reviewMean: s.reviewMean, reviews: s.reviews } : {}),
    ...(c !== undefined && c.runs > 0 ? { cheaperRuns: c.runs } : {}),
    priceRatio: ratio,
    ...(s.cost !== undefined ? { costNow: s.cost, costCheaper: s.cost * ratio } : {}),
    strength: strong ? 'strong' : 'moderate',
    ...q,
  }
}

// --- Text ---

const usd = (x: number): string => '$' + (x < 0.01 ? x.toFixed(4) : x.toFixed(2))
const pct = (x: number): string => `${Math.round(x * 100)}%`
const isTier = (t: unknown): t is Tier => typeof t === 'string' && (LADDER as readonly string[]).includes(t)
const valid = (a: unknown): a is Advice => isObj(a) && typeof a['category'] === 'string' && isTier(a['tier']) &&
  isTier(a['suggested']) && nonNeg(a['runs']) && nonNeg(a['escalationRate']) && nonNeg(a['notAcceptedRate']) &&
  (a['strength'] === 'strong' || a['strength'] === 'moderate')
const hasCost = (a: Advice): boolean => nonNeg(a.costNow) && nonNeg(a.costCheaper)
// Only a suggestion that says it is measured counts as one: a missing or unknown `quality` reads as unmeasured.
const measured = (a: Advice): boolean => a.quality === 'measured'
const note = (a: Advice): string => (typeof a.qualityNote === 'string' ? a.qualityNote : '')

function stuckText(a: Advice, n: number): string {
  const k = Math.round(a.escalationRate * a.runs)
  return k === 0 ? `never got stuck in ${n} runs on ${a.tier}` : `got stuck in ${k} of ${n} runs on ${a.tier}`
}

function costText(a: Advice): string {
  return hasCost(a)
    ? `on ${a.suggested} it would cost about ${usd(a.costCheaper!)} instead of ${usd(a.costNow!)} per run`
    : `${a.suggested} costs about ${pct(a.priceRatio)} of ${a.tier} per token`
}

// The one-line hint: "<category> never got stuck in 18 runs on opus (your verifyCommand passed): on sonnet it would
// cost about $0.47 instead of $0.94 per run. Ask for sonnet in the Agent call, or see /escalator stats."
export function hintLine(a: Advice): string {
  const n = Math.round(a.runs)
  const signal = measured(a) && note(a) !== '' ? ` (${note(a)})` : ''
  return `${a.category} ${stuckText(a, n)}${signal}: ${costText(a)}. Ask for ${a.suggested} in the Agent call, or see /escalator stats.`
}

function line(a: Advice): string {
  const k = Math.round(a.escalationRate * a.runs)
  const parts = [
    `${Math.round(a.runs)} runs`,
    k === 0 ? 'never stuck' : `stuck ${pct(a.escalationRate)}`,
    `${pct(a.notAcceptedRate)} not accepted`,
    ...(nonNeg(a.reviewMean) && a.signal !== 'reviews' ? [`reviews ${a.reviewMean.toFixed(1)}/5`] : []),
    ...(nonNeg(a.cheaperRuns) && a.cheaperRuns >= 1 ? [`${Math.round(a.cheaperRuns)} runs on ${a.suggested} already`] : []),
    ...(note(a) !== '' ? [`quality: ${note(a)}`] : []),
    hasCost(a) ? `about ${usd(a.costCheaper!)} instead of ${usd(a.costNow!)} per run` : `${a.suggested} costs about ${pct(a.priceRatio)} per token`,
    ...(a.scope === 'project' ? ['this project'] : []),
  ]
  return `${a.category}: ${a.tier} -> ${a.suggested}, ${parts.join(', ')} (${a.strength})`
}

// An unmeasured suggestion in full sentences that do not vouch for the cheaper model: "security-reviewer:review never
// got stuck in 18 runs on opus. On sonnet it would cost about $0.47 instead of $0.94 per run, but the mod cannot tell
// whether it would find the same issues (read-only work: ...). Try sonnet on a few runs and compare the results
// yourself." Reviews look at the agent's diff, so they cannot measure read-only work.
function unmeasuredLine(a: Advice, reviewRate: number): string {
  const label = categoryLabel(a.category)
  const cost = costText(a)
  const goal = label === 'review' ? 'find the same issues' : label === 'explore' ? 'find the same answers' : 'do the work as well'
  const why = note(a) !== '' ? ` (${note(a)})` : ''
  const how = READ_ONLY_LABELS.includes(label)
    ? `Try ${a.suggested} on a few runs and compare the results yourself.`
    : WRITE_LABELS.includes(label)
      ? 'Set verifyCommand or turn on reviewRate to measure it.'
      : reviewRate > 0
        ? `reviewRate is on: reviews of ${a.suggested} runs that change files will measure it.`
        : `Turn on reviewRate to measure it on ${a.suggested} runs that change files.`
  return `${a.category} ${stuckText(a, Math.round(a.runs))}. ${cost.charAt(0).toUpperCase()}${cost.slice(1)}, ` +
    `but the mod cannot tell whether it would ${goal}${why}. ${how}`
}

export type FormatOptions = { respectExplicitModel?: boolean; reviewRate?: number }

// `lines`: one line per suggestion (at most `ADVICE.maxLines`), for the stats text: a short list line when measured,
// full sentences that state the limit when not. `text`: the block for `/escalator stats`, '' when there is nothing
// to suggest. `hint`: `hintLine` of the first strong, measured suggestion, '' when there is none. Never throws.
export function formatAdvice(list: Advice[], opts: FormatOptions = {}): { text: string; lines: string[]; hint: string } {
  try {
    const ok = Array.isArray(list) ? list.filter(valid) : []
    if (ok.length === 0) return { text: '', lines: [], hint: '' }
    const reviewRate = isNum(opts.reviewRate) ? opts.reviewRate : 0
    const lines = ok.slice(0, ADVICE.maxLines).map((a) => (measured(a) ? line(a) : unmeasuredLine(a, reviewRate)))
    const more = ok.length - lines.length
    const strong = ok.find((a) => a.strength === 'strong' && measured(a))
    const how = opts.respectExplicitModel === true
      ? 'respectExplicitModel is on: a model asked for in the Agent call is kept even if it starts failing (a stuck agent is still escalated).'
      : 'If it starts failing, learning moves the category back up by itself.'
    const text = [
      'Cheaper model suggestions (costs are estimates from list prices):',
      ...lines.map((l) => `- ${l}`),
      ...(more > 0 ? [`- and ${more} more`] : []),
      'These are based on runs that did not get stuck, not on a comparison with the cheaper model, and the savings are ' +
        'estimates. "quality" names what would show the cheaper model doing worse work; without it a suggestion is never strong.',
      'The mod never starts an agent below the model it asked for: ask for the cheaper model in the Agent call or in the agent\'s definition. ' + how,
    ].join('\n')
    return { text, lines, hint: strong !== undefined ? hintLine(strong) : '' }
  } catch {
    return { text: '', lines: [], hint: '' }
  }
}

// --- Once-per-session hint without repeats ---

const hintKey = (a: Advice): string => `${a.category}|${a.tier}`

// The first strong, measured suggestion whose `category|tier` was not hinted in the last `ADVICE.repeatAfterMs`.
// `hinted` is the stored table (malformed entries read as never hinted).
export function pickHint(list: Advice[], hinted: Record<string, number>, now: number): Advice | undefined {
  try {
    const table = isObj(hinted) ? hinted : {}
    return (Array.isArray(list) ? list : []).filter(valid).find((a) => {
      if (a.strength !== 'strong' || !measured(a)) return false
      const at = table[hintKey(a)]
      return !isNum(at) || now - at >= ADVICE.repeatAfterMs
    })
  } catch {
    return undefined
  }
}

// `hinted` with `a` marked at `now`, keeping the `ADVICE.maxHinted` most recent entries. Never mutates `hinted`.
export function markHinted(hinted: Record<string, number>, a: Advice, now: number): Record<string, number> {
  const key = hintKey(a)
  const table: Record<string, number> = {}
  if (isObj(hinted)) for (const [k, v] of Object.entries(hinted)) if (isNum(v) && k !== key) table[k] = v
  // The entry just written always stays; the oldest of the others go first.
  const keep = Object.keys(table).sort((x, y) => table[y]! - table[x]!).slice(0, ADVICE.maxHinted - 1)
  const out: Record<string, number> = { [key]: now }
  for (const k of keep) out[k] = table[k]!
  return out
}
