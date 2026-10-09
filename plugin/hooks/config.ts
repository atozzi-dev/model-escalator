// Pure: every tunable of the mod, parsed from the plugin's options. Invalid values fall back to the defaults.

import type { Action, Tier } from './detector'

export type Rates = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }
export type Price = Rates & { longContext?: Rates & { threshold: number } }

export type Config = {
  threshold: Record<Tier, number>   // difficulty score that triggers the next intervention, per starting tier
  grace: number                     // steps to wait between two interventions
  logSize: number                   // attempts kept in the dossier
  senior: string                    // model asked for advice at the consult level
  maxTier: Tier                     // highest tier a swap may reach (never above opus)
  levels: readonly Action[]         // enabled ladder levels, in escalation order
  prices: Record<Tier, Price>       // USD per million tokens
  prudentTokenRatio: number         // fraction of tokens the baseline model would need
  modelIds: Record<Tier, string>    // full ids sent on a swap when none was observed
  modelOverrides: Partial<Record<Tier, string>>  // explicit ids from the modelIds option; beat observed ids and defaults
  verifyCommand: string           // optional check run at the end of each tracked agent's run; empty = off
  verifyTimeoutSeconds: number      // how long the check may run before it counts as failed (at most 600)
  oscillationEdits: number          // edits of one file tolerated since the last progress; each further edit adds to the score
  idleSteps: number                 // model requests tolerated without progress
  idleWeight: number                // score added by each model request past idleSteps
  stallMinutes: number              // minutes without any event after which a running agent is flagged as stalled
  maxConsultsPerAgent: number       // senior consults one agent may get; a refused call and its retry count once; 0 = none
  maxConsultsPerSession: number     // senior consults across all agents of the session; 0 = none
  consultBudgetUsd: number          // USD the senior calls may cost in the session; 0 = no limit
  deescalateAfter: number           // progress signals after which a swapped agent goes back one tier; 0 = off
  pauseAtHuman: boolean             // refuse the tool calls of an agent that reached the human level until it is resumed
}

// USD per million tokens, Anthropic API list prices (Oct 2026), checked against /cost.
// Cache writes cost 1.25x input for the 5-minute TTL and 2x input for the 1-hour TTL.
// `longContext` replaces the rates when one request's total input exceeds its threshold.
export const DEFAULT_PRICES: Record<Tier, Price> = {
  opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  sonnet: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  haiku: {
    input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2,
    longContext: { threshold: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1 },
  },
}

export const ALL_LEVELS: readonly Action[] = ['nudge', 'consult', 'swap', 'human']

export const DEFAULT_CONFIG: Config = {
  threshold: { haiku: 3, sonnet: 4, opus: 6 },
  grace: 4,
  logSize: 12,
  senior: 'opus',
  levels: ALL_LEVELS,
  maxTier: 'opus',
  prices: DEFAULT_PRICES,
  prudentTokenRatio: 0.65,
  oscillationEdits: 3,
  // Provisional: the only progress signal today is failing tests dropping, so long tasks without tests
  // need headroom. Recalibrate on the observe-week data before relying on these values.
  idleSteps: 40,
  idleWeight: 0.25,
  stallMinutes: 10,
  maxConsultsPerAgent: 3,
  maxConsultsPerSession: 20,
  consultBudgetUsd: 0,
  pauseAtHuman: true,
  deescalateAfter: 0,
  modelOverrides: {},
  verifyCommand: '',
  verifyTimeoutSeconds: 120,
  modelIds: { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' },
}

type Raw = Readonly<Record<string, unknown>>

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

function positive(v: unknown, fallback: number): number {
  const n = num(v)
  return n !== undefined && n > 0 ? n : fallback
}

// A boolean option: a real boolean, or the strings "true" / "false"; anything else keeps the default.
function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  const t = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return t === 'true' ? true : t === 'false' ? false : fallback
}

function parseLevels(v: unknown, fallback: readonly Action[]): readonly Action[] {
  if (typeof v !== 'string' || v.trim() === '') return fallback
  const names = v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (names.length === 0 || names.some((n) => !ALL_LEVELS.includes(n as Action))) return fallback
  return ALL_LEVELS.filter((l) => names.includes(l))
}

function parseMaxTier(v: unknown, fallback: Tier): Tier {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return t === 'haiku' || t === 'sonnet' || t === 'opus' ? t : fallback
}

const RATE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const

function mergeRates<T extends Rates>(base: T, over: unknown): T {
  if (typeof over !== 'object' || over === null) return base
  const out = { ...base }
  for (const k of RATE_KEYS) {
    const n = num((over as Raw)[k])
    if (n !== undefined && n >= 0) out[k] = n
  }
  return out
}

function mergePrice(base: Price, over: unknown): Price {
  if (typeof over !== 'object' || over === null) return base
  const merged: Price = { ...mergeRates(base, over) }
  if (base.longContext) {
    const lc = (over as Raw).longContext
    const t = num((lc as Raw | undefined)?.threshold)
    merged.longContext = typeof lc === 'object' && lc !== null
      ? { ...mergeRates(base.longContext, lc), threshold: t !== undefined && t > 0 ? t : base.longContext.threshold }
      : base.longContext
  }
  return merged
}

// `prices` is a JSON object keyed by tier, each entry overriding only the rates it names:
// {"sonnet":{"input":3,"output":15}}. Anything malformed is ignored.
function parsePrices(v: unknown, base: Record<Tier, Price>): Record<Tier, Price> {
  if (typeof v !== 'string' || v.trim() === '') return base
  let obj: unknown
  try { obj = JSON.parse(v) } catch { return base }
  if (typeof obj !== 'object' || obj === null) return base
  const o = obj as Raw
  return { haiku: mergePrice(base.haiku, o.haiku), sonnet: mergePrice(base.sonnet, o.sonnet), opus: mergePrice(base.opus, o.opus) }
}

// `modelIds` is a JSON object keyed by tier: {"sonnet":"us.anthropic.claude-sonnet-..."}. Entries that are not
// non-empty strings, and unknown keys, are ignored; malformed JSON gives no overrides.
function parseModelIds(v: unknown): Partial<Record<Tier, string>> {
  if (typeof v !== 'string' || v.trim() === '') return {}
  let obj: unknown
  try { obj = JSON.parse(v) } catch { return {} }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return {}
  const out: Partial<Record<Tier, string>> = {}
  for (const t of ['haiku', 'sonnet', 'opus'] as const) {
    const id = (obj as Raw)[t]
    if (typeof id === 'string' && id.trim() !== '' && id.length <= 200) out[t] = id.trim()
  }
  return out
}

// Splits a command line into an argument vector: spaces separate, single or double quotes group.
// There is no shell, so no pipes, redirects or variable expansion. An unbalanced quote yields [] (nothing runs).
export function splitCommand(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inWord = false
  let quote = ''
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = ''
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      inWord = true
    } else if (/\s/.test(ch)) {
      if (inWord) { out.push(cur); cur = ''; inWord = false }
    } else {
      cur += ch
      inWord = true
    }
  }
  if (quote) return []
  if (inWord) out.push(cur)
  return out
}

export function parseConfig(raw: Raw | undefined): Config {
  const d = DEFAULT_CONFIG
  const o: Raw = raw ?? {}
  try {
    const ratio = num(o.prudentTokenRatio)
    const grace = num(o.graceSteps)
    const osc = num(o.oscillationEdits)
    const idle = num(o.idleSteps)
    const idleW = num(o.idleWeight)
    const vt = num(o.verifyTimeoutSeconds)
    const vc = typeof o.verifyCommand === 'string' ? o.verifyCommand.trim() : ''
    const senior = typeof o.seniorModel === 'string' ? o.seniorModel.trim() : ''
    const perAgent = num(o.maxConsultsPerAgent)
    const perSession = num(o.maxConsultsPerSession)
    const budget = num(o.consultBudgetUsd)
    const deesc = num(o.deescalateAfter)
    return {
      ...d,
      threshold: {
        haiku: positive(o.thresholdHaiku, d.threshold.haiku),
        sonnet: positive(o.thresholdSonnet, d.threshold.sonnet),
        opus: positive(o.thresholdOpus, d.threshold.opus),
      },
      oscillationEdits: osc !== undefined && osc >= 1 ? Math.floor(osc) : d.oscillationEdits,
      idleSteps: idle !== undefined && idle >= 1 ? Math.floor(idle) : d.idleSteps,
      idleWeight: idleW !== undefined && idleW >= 0 ? idleW : d.idleWeight,
      stallMinutes: positive(o.stallMinutes, d.stallMinutes),
      verifyCommand: vc.length <= 1000 ? vc : d.verifyCommand,
      verifyTimeoutSeconds: vt !== undefined && vt > 0 ? Math.min(vt, 600) : d.verifyTimeoutSeconds,
      grace: grace !== undefined && grace >= 0 ? Math.floor(grace) : d.grace,
      senior: senior !== '' && senior.length <= 100 ? senior : d.senior,
      levels: parseLevels(o.levels, d.levels),
      maxTier: parseMaxTier(o.maxTier, d.maxTier),
      prices: parsePrices(o.prices, d.prices),
      modelOverrides: parseModelIds(o.modelIds),
      prudentTokenRatio: ratio !== undefined && ratio > 0 && ratio <= 1 ? ratio : d.prudentTokenRatio,
      maxConsultsPerAgent: perAgent !== undefined && perAgent >= 0 ? Math.floor(perAgent) : d.maxConsultsPerAgent,
      maxConsultsPerSession: perSession !== undefined && perSession >= 0 ? Math.floor(perSession) : d.maxConsultsPerSession,
      consultBudgetUsd: budget !== undefined && budget >= 0 ? budget : d.consultBudgetUsd,
      pauseAtHuman: bool(o.pauseAtHuman, d.pauseAtHuman),
      deescalateAfter: deesc !== undefined && deesc >= 1 ? Math.floor(deesc) : d.deescalateAfter,
    }
  } catch {
    return d
  }
}
