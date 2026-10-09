import type { Tier } from './detector'

// USD per million tokens, Anthropic API list prices (Oct 2026), checked against /cost.
// Cache writes cost 1.25x input for the 5-minute TTL and 2x input for the 1-hour TTL.
// `longContext` replaces the rates when one request's total input exceeds its threshold.
export type Rates = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }
export type Price = Rates & { longContext?: Rates & { threshold: number } }
export type CacheTtl = '5m' | '1h'
export const PRICES: Record<Tier, Price> = {
  opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  sonnet: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  haiku: {
    input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2,
    longContext: { threshold: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1 },
  },
}

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
export const PRUDENT_TOKEN_RATIO = 0.65

export type Ledger = {
  actual: number          // what the session really spent (all loops, plus consults)
  baselineHigh: number    // same tokens, all on the baseline model (optimistic savings)
  baselineLow: number     // fewer tokens on the baseline model (prudent savings)
  agentSteps: number
  byTier: Partial<Record<Tier, { steps: number; cost: number }>>
  consults: number
  consultCost: number
  interventions: Record<string, number>
}

export function emptyLedger(): Ledger {
  return { actual: 0, baselineHigh: 0, baselineLow: 0, agentSteps: 0, byTier: {}, consults: 0, consultCost: 0, interventions: {} }
}

// One model request. `isAgent` false for the lead: it counts the same in both columns.
// The usage report has no TTL split: the main loop writes the cache with the 1-hour TTL,
// subagents and teammates with the 5-minute one.
export function addStep(l: Ledger, u: Usage, tier: Tier, baseline: Tier, isAgent: boolean): Ledger {
  const ttl: CacheTtl = isAgent ? '5m' : '1h'
  const c = cost(u, PRICES[tier], ttl)
  const row = l.byTier[tier] ?? { steps: 0, cost: 0 }
  const same = !isAgent || tier === baseline
  return {
    ...l,
    actual: l.actual + c,
    baselineHigh: l.baselineHigh + (same ? c : cost(u, PRICES[baseline], ttl)),
    baselineLow: l.baselineLow + (same ? c : cost(scale(u, PRUDENT_TOKEN_RATIO), PRICES[baseline], ttl)),
    agentSteps: l.agentSteps + (isAgent ? 1 : 0),
    byTier: { ...l.byTier, [tier]: { steps: row.steps + 1, cost: row.cost + c } },
  }
}

// A senior consult has no usage report: estimate from text length (about 4 chars per token).
export function addConsult(l: Ledger, promptChars: number, replyChars: number, tier: Tier): Ledger {
  const c = cost({ input_tokens: promptChars / 4, output_tokens: replyChars / 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, PRICES[tier])
  return { ...l, actual: l.actual + c, consults: l.consults + 1, consultCost: l.consultCost + c }
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
