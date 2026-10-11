import { DEFAULT_CONFIG, DEFAULT_PRICES, type Config, type Price, type Rates } from './config'
import type { Tier } from './detector'

export type { Price, Rates }
type Pricing = Pick<Config, 'prices' | 'prudentTokenRatio'>

export type CacheTtl = '5m' | '1h'
export const PRICES: Record<Tier, Price> = DEFAULT_PRICES

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export function cost(u: Usage, p: Price, ttl: CacheTtl = '5m'): number {
  const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  const r: Rates = p.longContext && total > p.longContext.threshold ? p.longContext : p
  const write = ttl === '1h' ? r.cacheWrite1h : r.cacheWrite5m
  return (u.input_tokens * r.input + u.output_tokens * r.output +
    u.cache_read_input_tokens * r.cacheRead + u.cache_creation_input_tokens * write) / 1e6
}

function scale(u: Usage, k: number): Usage {
  return { input_tokens: u.input_tokens * k, output_tokens: u.output_tokens * k,
    cache_read_input_tokens: u.cache_read_input_tokens * k, cache_creation_input_tokens: u.cache_creation_input_tokens * k }
}

// A stronger model usually needs fewer tokens for the same task. The prudent baseline
// assumes it would use this fraction of the cheap model's tokens.
export const PRUDENT_TOKEN_RATIO = DEFAULT_CONFIG.prudentTokenRatio

// Per task category. `steps`, `actual` and the two baselines come from agent requests (and
// `actual` also from consults); `agents` and `escalated` are counted by the caller.
export type CategoryRow = {
  steps: number
  actual: number
  baselineHigh: number
  baselineLow: number
  agents: number
  escalated: number
}

export const MAX_CATEGORIES = 50
const OTHER = 'other'
const MAX_CATEGORY_NAME = 40

export type Ledger = {
  actual: number          // what the session really spent (all loops, plus consults)
  baselineHigh: number    // same tokens, all on the baseline model (optimistic savings)
  baselineLow: number     // fewer tokens on the baseline model (prudent savings)
  agentSteps: number
  byTier: Partial<Record<Tier, { steps: number; cost: number }>>
  consults: number
  consultCost: number
  interventions: Record<string, number>
  byCategory?: Record<string, CategoryRow>   // absent in ledgers saved by older versions
}

export function emptyLedger(): Ledger {
  return { actual: 0, baselineHigh: 0, baselineLow: 0, agentSteps: 0, byTier: {}, consults: 0, consultCost: 0, interventions: {}, byCategory: {} }
}

const emptyRow = (): CategoryRow => ({ steps: 0, actual: 0, baselineHigh: 0, baselineLow: 0, agents: 0, escalated: 0 })

// Returns the ledger's map with `category` updated by `patch`. Blank or non-string names are ignored;
// once MAX_CATEGORIES distinct names exist, new ones are folded into "other".
function touch(l: Ledger, category: unknown, patch: (r: CategoryRow) => CategoryRow): Record<string, CategoryRow> | undefined {
  const map = l.byCategory && typeof l.byCategory === 'object' ? l.byCategory : {}
  if (typeof category !== 'string' || !category.trim()) return l.byCategory
  const name = category.trim().slice(0, MAX_CATEGORY_NAME)
  const own = (k: string) => Object.prototype.hasOwnProperty.call(map, k)
  const key = own(name) || Object.keys(map).filter(k => k !== OTHER).length < MAX_CATEGORIES ? name : OTHER
  return { ...map, [key]: patch(own(key) ? map[key]! : emptyRow()) }
}

// Counts one more agent run in the category.
export function addAgent(l: Ledger, category: string): Ledger {
  return { ...l, byCategory: touch(l, category, r => ({ ...r, agents: r.agents + 1 })) }
}

// Counts one agent run of the category that was escalated.
export function addEscalation(l: Ledger, category: string): Ledger {
  return { ...l, byCategory: touch(l, category, r => ({ ...r, escalated: r.escalated + 1 })) }
}

// One model request. `isAgent` false for the lead: it counts the same in both columns.
// The usage report has no TTL split: the main loop writes the cache with the 1-hour TTL,
// subagents and teammates with the 5-minute one.
// `category` (agent steps only) feeds the per-category breakdown; the lead has none.
export function addStep(l: Ledger, u: Usage, tier: Tier, baseline: Tier, isAgent: boolean, cfg: Pricing = DEFAULT_CONFIG, category?: string): Ledger {
  const ttl: CacheTtl = isAgent ? '5m' : '1h'
  const c = cost(u, cfg.prices[tier], ttl)
  const row = l.byTier[tier] ?? { steps: 0, cost: 0 }
  const same = !isAgent || tier === baseline
  const high = same ? c : cost(u, cfg.prices[baseline], ttl)
  const low = same ? c : cost(scale(u, cfg.prudentTokenRatio), cfg.prices[baseline], ttl)
  const byCategory = isAgent
    ? touch(l, category, r => ({ ...r, steps: r.steps + 1, actual: r.actual + c, baselineHigh: r.baselineHigh + high, baselineLow: r.baselineLow + low }))
    : l.byCategory
  return {
    ...l,
    actual: l.actual + c,
    baselineHigh: l.baselineHigh + high,
    baselineLow: l.baselineLow + low,
    agentSteps: l.agentSteps + (isAgent ? 1 : 0),
    byTier: { ...l.byTier, [tier]: { steps: row.steps + 1, cost: row.cost + c } },
    ...(byCategory ? { byCategory } : {}),
  }
}

const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const

// Accepts a usage report only when all four token counts are finite, non-negative numbers.
export function asUsage(x: unknown): Usage | undefined {
  if (!x || typeof x !== 'object') return undefined
  const o = x as Record<string, unknown>
  for (const k of USAGE_KEYS) {
    const v = o[k]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined
  }
  return {
    input_tokens: o.input_tokens as number,
    output_tokens: o.output_tokens as number,
    cache_read_input_tokens: o.cache_read_input_tokens as number,
    cache_creation_input_tokens: o.cache_creation_input_tokens as number,
  }
}

export type ConsultCost = {
  usage?: Usage            // the reply's own usage report, when the engine gives one
  promptChars: number      // used only without usage: about 4 chars per token
  replyChars: number
}

// A senior consult is a one-shot call, so it is priced like a request with the 5-minute cache write.
// Without a usage report (older engines), estimate from text length.
// With `category`, the cost is also charged to that category's real spend (the baselines stay as they are).
export function addConsult(l: Ledger, c: ConsultCost, tier: Tier, cfg: Pricing = DEFAULT_CONFIG, category?: string): Ledger {
  const u: Usage = c.usage ?? { input_tokens: c.promptChars / 4, output_tokens: c.replyChars / 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  const k = cost(u, cfg.prices[tier], '5m')
  const byCategory = touch(l, category, r => ({ ...r, actual: r.actual + k }))
  return { ...l, actual: l.actual + k, consults: l.consults + 1, consultCost: l.consultCost + k, ...(byCategory ? { byCategory } : {}) }
}

export function addIntervention(l: Ledger, action: string): Ledger {
  return { ...l, interventions: { ...l.interventions, [action]: (l.interventions[action] ?? 0) + 1 } }
}

export function savings(l: Ledger) {
  const high = l.baselineHigh - l.actual
  const low = l.baselineLow - l.actual
  const pct = (x: number, base: number) => (base > 0 ? Math.round((x / base) * 100) : 0)
  return { low, high, lowPct: pct(low, l.baselineLow), highPct: pct(high, l.baselineHigh) }
}

const usd = (x: number) => (x < 0 ? '-' : '') + '$' + Math.abs(x).toFixed(2)

export function statusLine(l: Ledger): string {
  const s = savings(l)
  const n = Object.values(l.interventions).reduce((a, b) => a + b, 0)
  return `spent ${usd(l.actual)} · saved ~${usd(s.low)}–${usd(s.high)} (${s.lowPct}–${s.highPct}%) · interventions ${n}`
}

// Compact table of where the ladder pays off, sorted by real cost. Never throws.
export function reportByCategory(l: Ledger, baseline: Tier): string {
  try {
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
    const map = l && typeof l.byCategory === 'object' && l.byCategory ? l.byCategory : {}
    const rows = Object.entries(map)
      .filter(([, r]) => r && typeof r === 'object')
      .map(([name, r]) => ({ name, steps: num(r.steps), actual: num(r.actual), high: num(r.baselineHigh), low: num(r.baselineLow), agents: num(r.agents), esc: num(r.escalated) }))
      .sort((a, b) => b.actual - a.actual || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    if (!rows.length) return 'No category data yet.'
    const pct = (x: number, base: number) => (base > 0 ? Math.round((x / base) * 100) : 0)
    const lines = rows.map(r => {
      const hi = r.high - r.actual
      const lo = r.low - r.actual
      return `  ${r.name}: ${r.steps} requests, ${usd(r.actual)}, all on ${baseline} ${usd(r.low)}..${usd(r.high)}, ` +
        `savings ${pct(lo, r.low)}% to ${pct(hi, r.high)}%, escalations ${r.esc}/${r.agents} agents`
    })
    return [
      'Savings by task category (real cost first):', ...lines,
      'Note: negative savings mean the ladder cost more than running that kind of task on the strong model.',
    ].join('\n')
  } catch {
    return 'No category data yet.'
  }
}

export function report(l: Ledger, baseline: Tier): string {
  const s = savings(l)
  const tiers = (Object.entries(l.byTier) as [Tier, { steps: number; cost: number }][])
    .map(([t, r]) => `  ${t}: ${r.steps} requests, ${usd(r.cost)}`)
  const iv = Object.entries(l.interventions).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'
  return [
    `Session cost: ${usd(l.actual)} (senior consults: ${l.consults}, ${usd(l.consultCost)})`,
    `Same work all on ${baseline}: ${usd(l.baselineLow)} (prudent) to ${usd(l.baselineHigh)} (same tokens)`,
    `Estimated savings: ${usd(s.low)} to ${usd(s.high)} (${s.lowPct}% to ${s.highPct}%)`,
    'By model:', ...tiers,
    `Interventions: ${iv}`,
    'Estimate at API list prices. On a subscription plan read the percentage as share of usage limits saved.',
  ].join('\n')
}
