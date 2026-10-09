import type { Tier } from './detector'

// USD per million tokens. Opus 5.5 and Sonnet 5.5 are Anthropic list prices (Oct 2026).
// Haiku uses Haiku 4.5 list prices as a placeholder: check the pricing page and override in config.
export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }
export const PRICES: Record<Tier, Price> = {
  opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  sonnet: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
}

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export function cost(u: Usage, p: Price): number {
  return (u.input_tokens * p.input + u.output_tokens * p.output +
    u.cache_read_input_tokens * p.cacheRead + u.cache_creation_input_tokens * p.cacheWrite) / 1e6
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
export function addStep(l: Ledger, u: Usage, tier: Tier, baseline: Tier, isAgent: boolean): Ledger {
  const c = cost(u, PRICES[tier])
  const row = l.byTier[tier] ?? { steps: 0, cost: 0 }
  const same = !isAgent || tier === baseline
  return {
    ...l,
    actual: l.actual + c,
    baselineHigh: l.baselineHigh + (same ? c : cost(u, PRICES[baseline])),
    baselineLow: l.baselineLow + (same ? c : cost(scale(u, PRUDENT_TOKEN_RATIO), PRICES[baseline])),
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
