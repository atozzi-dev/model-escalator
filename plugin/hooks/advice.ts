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
//   with the session's `projectId`; options from the config: `minReviewScore`, `prices`, `learnByCost`, plus
//   `now` (`clockNow($)`) and `halfLifeMs()`. The project cell of a tier is used when it has enough runs, the global
//   one otherwise, exactly as `scopedStats` does for learning.
// - `/escalator stats`. Append `formatAdvice(list, { respectExplicitModel: config.respectExplicitModel }).text`,
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
export const ADVICE = {
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
  strength: Strength
}

export type AdviceOptions = {
  now?: number
  halfLifeMs?: number
  minReviewScore?: number
  prices?: Record<Tier, Price>
  learnByCost?: boolean
  projects?: Projects
  projectKey?: string
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
type Seen = { runs: number; escalated: number; notAccepted: number; cost?: number; reviews?: number; reviewMean?: number }

function look(c: Cell, now: number | undefined, halfLifeMs: number): Seen {
  const f = now !== undefined && c.updatedAt !== undefined ? fade(now - c.updatedAt, halfLifeMs) : 1
  const g = now !== undefined && c.reviewedAt !== undefined ? fade(now - c.reviewedAt, halfLifeMs) : 1
  const s: Seen = { runs: c.runs * f, escalated: c.escalated * f, notAccepted: (c.notAccepted ?? c.escalated) * f }
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
const saving = (a: Advice): number => (a.costNow !== undefined && a.costCheaper !== undefined ? (a.costNow - a.costCheaper) * a.runs : 0)

// The suggestions, strong first, then by estimated saving (cost difference per run times runs), then by runs.
// At most one per category: the qualifying tier with the most runs. Never throws; malformed input gives [].
export function downshiftAdvice(stats: unknown, opts: AdviceOptions = {}): Advice[] {
  try {
    const { now, halfLifeMs = HALF_LIFE_MS, minReviewScore = LEARN.minReviewScore, prices = DEFAULT_PRICES, learnByCost = true } = opts
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
        const a = adviseTier(view, row, category, tier, { now, halfLifeMs, minReviewScore, prices, learnByCost })
        if (a === undefined) continue
        a.scope = key !== undefined && row[tier] === projects[key]?.stats[category]?.[tier] ? 'project' : 'global'
        if (best === undefined || a.runs >= best.runs) best = a
      }
      if (best !== undefined) out.push(best)
    }
    return out.sort((a, b) => STRENGTH_ORDER[a.strength] - STRENGTH_ORDER[b.strength] || saving(b) - saving(a) ||
      b.runs - a.runs || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0))
  } catch {
    return []
  }
}

type Ctx = { now?: number; halfLifeMs: number; minReviewScore: number; prices: Record<Tier, Price>; learnByCost: boolean }

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
  const strong = proven || (s.runs >= ADVICE.strongRuns && notAcceptedRate <= ADVICE.maxEscalationRate)
  return {
    category, tier, suggested, scope: 'global', runs: s.runs, escalationRate, notAcceptedRate,
    ...(s.reviewMean !== undefined ? { reviewMean: s.reviewMean, reviews: s.reviews } : {}),
    ...(c !== undefined && c.runs > 0 ? { cheaperRuns: c.runs } : {}),
    priceRatio: ratio,
    ...(s.cost !== undefined ? { costNow: s.cost, costCheaper: s.cost * ratio } : {}),
    strength: strong ? 'strong' : 'moderate',
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

function stuckText(a: Advice, n: number): string {
  const k = Math.round(a.escalationRate * a.runs)
  return k === 0 ? `never got stuck in ${n} runs on ${a.tier}` : `got stuck in ${k} of ${n} runs on ${a.tier}`
}

// The one-line hint: "<category> never got stuck in 18 runs on opus: on sonnet it would cost about $0.47 instead of
// $0.94 per run. Ask for sonnet in the Agent call, or see /escalator stats."
export function hintLine(a: Advice): string {
  const n = Math.round(a.runs)
  const cost = hasCost(a)
    ? `on ${a.suggested} it would cost about ${usd(a.costCheaper!)} instead of ${usd(a.costNow!)} per run`
    : `${a.suggested} costs about ${pct(a.priceRatio)} of ${a.tier} per token`
  return `${a.category} ${stuckText(a, n)}: ${cost}. Ask for ${a.suggested} in the Agent call, or see /escalator stats.`
}

function line(a: Advice): string {
  const k = Math.round(a.escalationRate * a.runs)
  const parts = [
    `${Math.round(a.runs)} runs`,
    k === 0 ? 'never stuck' : `stuck ${pct(a.escalationRate)}`,
    `${pct(a.notAcceptedRate)} not accepted`,
    ...(nonNeg(a.reviewMean) ? [`reviews ${a.reviewMean.toFixed(1)}/5`] : []),
    ...(nonNeg(a.cheaperRuns) && a.cheaperRuns >= 1 ? [`${Math.round(a.cheaperRuns)} runs on ${a.suggested} already`] : []),
    hasCost(a) ? `about ${usd(a.costCheaper!)} instead of ${usd(a.costNow!)} per run` : `${a.suggested} costs about ${pct(a.priceRatio)} per token`,
    ...(a.scope === 'project' ? ['this project'] : []),
  ]
  return `${a.category}: ${a.tier} -> ${a.suggested}, ${parts.join(', ')} (${a.strength})`
}

export type FormatOptions = { respectExplicitModel?: boolean }

// `lines`: one short line per suggestion (at most `ADVICE.maxLines`), for the stats text and the panel. `text`: the
// block for `/escalator stats`, '' when there is nothing to suggest. `hint`: `hintLine` of the first strong
// suggestion, '' when there is none. Never throws.
export function formatAdvice(list: Advice[], opts: FormatOptions = {}): { text: string; lines: string[]; hint: string } {
  try {
    const ok = Array.isArray(list) ? list.filter(valid) : []
    if (ok.length === 0) return { text: '', lines: [], hint: '' }
    const lines = ok.slice(0, ADVICE.maxLines).map(line)
    const more = ok.length - lines.length
    const strong = ok.find((a) => a.strength === 'strong')
    const how = opts.respectExplicitModel === true
      ? 'respectExplicitModel is on: a model asked for in the Agent call is kept even if it starts failing (a stuck agent is still escalated).'
      : 'If it starts failing, learning moves the category back up by itself.'
    const text = [
      'Cheaper model suggestions (costs are estimates from list prices):',
      ...lines.map((l) => `- ${l}`),
      ...(more > 0 ? [`- and ${more} more`] : []),
      'The mod never starts an agent below the model it asked for: ask for the cheaper model in the Agent call or in the agent\'s definition. ' + how,
    ].join('\n')
    return { text, lines, hint: strong !== undefined ? hintLine(strong) : '' }
  } catch {
    return { text: '', lines: [], hint: '' }
  }
}

// --- Once-per-session hint without repeats ---

const hintKey = (a: Advice): string => `${a.category}|${a.tier}`

// The first strong suggestion whose `category|tier` was not hinted in the last `ADVICE.repeatAfterMs`. `hinted` is
// the stored table (malformed entries read as never hinted).
export function pickHint(list: Advice[], hinted: Record<string, number>, now: number): Advice | undefined {
  try {
    const table = isObj(hinted) ? hinted : {}
    return (Array.isArray(list) ? list : []).filter(valid).find((a) => {
      if (a.strength !== 'strong') return false
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
