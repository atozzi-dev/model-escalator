// Pure: every tunable of the mod, parsed from the plugin's options. Invalid values fall back to the defaults.

import type { Action, Effort, Tier } from './detector'

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
  effortStep: boolean               // adds the effort level between consult and swap
  effortBoost: Effort               // lowest effort the effort level raises a request to (it always goes at least one step up)
  learningHalfLifeDays: number      // days after which learned evidence counts half; 0 = never fades
  notifyLead: boolean               // message the lead (main conversation) when an agent is swapped up or needs a human
  reviewRate: number                // share (0 to 1) of the runs of cheap models reviewed by a senior model; 0 = off
  reviewModel: string               // model that reviews a sampled run; empty = the senior model
  explore: number                   // weight (0 to 1) of exploring a tier below the learned one at spawn; 0 = off
  respectExplicitModel: boolean     // a model asked for in the Agent call is never changed at spawn by learning or exploration
  learnByCost: boolean              // pick the start tier by cost per accepted run once there is enough cost data
  modelCategories: boolean          // classify tasks with a small model (one short call per uncached spawn) instead of keywords only
  minReviewScore: number            // lowest review score (1 to 5) of an accepted run
  reworkWindowMinutes: number       // minutes after a cheap agent's run during which a lead edit of its files counts as rework; 0 = off
  recordSessions: number            // sessions whose observation stream is recorded for /escalator replay (newest kept); 0 = off
}

// Most sessions the recorder keeps, whatever the option asks for (the store also caps the bytes).
export const MAX_RECORD_SESSIONS = 50

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
// Every level in escalation order. `effort` is switched by the effortStep option alone, never by `levels`.
const LEVEL_ORDER: readonly Action[] = ['nudge', 'consult', 'effort', 'swap', 'human']
const EFFORT_NAMES: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

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
  effortStep: false,
  effortBoost: 'high',
  notifyLead: true,
  learningHalfLifeDays: 30,
  modelOverrides: {},
  verifyCommand: '',
  verifyTimeoutSeconds: 120,
  // Off by default: every sampled run costs one senior call.
  reviewRate: 0,
  reviewModel: '',
  // Off by default: exploring deliberately runs some tasks on a model learning had ruled out.
  explore: 0,
  respectExplicitModel: false,
  learnByCost: true,
  modelCategories: false,
  minReviewScore: 3,
  reworkWindowMinutes: 30,
  // Off by default: the recording lives in the plugin's store, next to the learned statistics.
  recordSessions: 0,
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

// `effort` is accepted as a name so a list naming it stays valid, but it is ignored here: effortStep adds it.
function parseLevels(v: unknown, fallback: readonly Action[]): readonly Action[] {
  if (typeof v !== 'string' || v.trim() === '') return fallback
  const names = v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (names.length === 0 || names.some((n) => !LEVEL_ORDER.includes(n as Action))) return fallback
  const levels = ALL_LEVELS.filter((l) => names.includes(l))
  return levels.length > 0 ? levels : fallback
}

// The enabled levels in escalation order, with the effort level between consult and swap when it is on.
function withEffort(levels: readonly Action[], on: boolean): readonly Action[] {
  return on ? LEVEL_ORDER.filter((l) => l === 'effort' || levels.includes(l)) : levels
}

function parseEffort(v: unknown, fallback: Effort): Effort {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return EFFORT_NAMES.includes(t as Effort) ? (t as Effort) : fallback
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

// The options as the user names them (the `userConfig` keys), with the value in force, read back from a parsed config.
function optionValues(c: Config): [string, unknown][] {
  return [
    ['thresholdHaiku', c.threshold.haiku], ['thresholdSonnet', c.threshold.sonnet], ['thresholdOpus', c.threshold.opus],
    ['graceSteps', c.grace], ['seniorModel', c.senior],
    ['levels', c.levels.filter((l) => l !== 'effort').join(',')], ['maxTier', c.maxTier],
    ['effortStep', c.levels.includes('effort')], ['effortBoost', c.effortBoost],
    ['prudentTokenRatio', c.prudentTokenRatio], ['oscillationEdits', c.oscillationEdits],
    ['idleSteps', c.idleSteps], ['idleWeight', c.idleWeight], ['stallMinutes', c.stallMinutes],
    ['verifyCommand', c.verifyCommand], ['verifyTimeoutSeconds', c.verifyTimeoutSeconds],
    ['maxConsultsPerAgent', c.maxConsultsPerAgent], ['maxConsultsPerSession', c.maxConsultsPerSession],
    ['consultBudgetUsd', c.consultBudgetUsd], ['pauseAtHuman', c.pauseAtHuman], ['notifyLead', c.notifyLead],
    ['deescalateAfter', c.deescalateAfter], ['learningHalfLifeDays', c.learningHalfLifeDays],
    ['reviewRate', c.reviewRate], ['reviewModel', c.reviewModel], ['explore', c.explore],
    ['respectExplicitModel', c.respectExplicitModel], ['learnByCost', c.learnByCost], ['modelCategories', c.modelCategories],
    ['minReviewScore', c.minReviewScore], ['reworkWindowMinutes', c.reworkWindowMinutes],
    ['recordSessions', c.recordSessions],
    ['prices', c.prices], ['modelIds', c.modelOverrides],
  ]
}

// The value in force of one option, by its user-facing name (as /escalator config shows it); undefined for an unknown name.
export function optionValue(c: Config, name: string): unknown {
  return optionValues(c).find(([n]) => n === name)?.[1]
}

function shown(v: unknown): string {
  if (typeof v === 'string') return v === '' ? '(empty)' : v
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

// One line per option: `name: value`, plus `(changed, default X)` when it differs from the default.
export function describeConfig(c: Config): string[] {
  const defaults = new Map(optionValues(DEFAULT_CONFIG))
  return optionValues(c).map(([name, v]) => {
    const d = defaults.get(name)
    if (JSON.stringify(v) === JSON.stringify(d)) return `${name}: ${shown(v)}`
    // Long values (prices, model ids, commands) are cut, and their default is not repeated.
    const now = shown(v)
    return now.length > 60 ? `${name}: ${now.slice(0, 57)}... (changed)` : `${name}: ${now} (changed${shown(d).length > 60 ? '' : `, default ${shown(d)}`})`
  })
}

// `fallback` gives the value of every option that is absent or invalid (the defaults unless a caller layers options,
// as the replay does over the options in force).
export function parseConfig(raw: Raw | undefined, fallback: Config = DEFAULT_CONFIG): Config {
  const d = fallback
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
    const halfLife = num(o.learningHalfLifeDays)
    const effortStep = bool(o.effortStep, d.effortStep)
    const rate = num(o.reviewRate)
    const explore = num(o.explore)
    const minScore = num(o.minReviewScore)
    const rework = num(o.reworkWindowMinutes)
    const record = num(o.recordSessions)
    const reviewer = typeof o.reviewModel === 'string' ? o.reviewModel.trim() : ''
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
      verifyCommand: typeof o.verifyCommand === 'string' && vc.length <= 1000 ? vc : d.verifyCommand,
      verifyTimeoutSeconds: vt !== undefined && vt > 0 ? Math.min(vt, 600) : d.verifyTimeoutSeconds,
      grace: grace !== undefined && grace >= 0 ? Math.floor(grace) : d.grace,
      senior: senior !== '' && senior.length <= 100 ? senior : d.senior,
      levels: withEffort(parseLevels(o.levels, d.levels.filter((l) => l !== 'effort')), effortStep),
      maxTier: parseMaxTier(o.maxTier, d.maxTier),
      prices: parsePrices(o.prices, d.prices),
      modelOverrides: o.modelIds === undefined ? d.modelOverrides : parseModelIds(o.modelIds),
      prudentTokenRatio: ratio !== undefined && ratio > 0 && ratio <= 1 ? ratio : d.prudentTokenRatio,
      maxConsultsPerAgent: perAgent !== undefined && perAgent >= 0 ? Math.floor(perAgent) : d.maxConsultsPerAgent,
      maxConsultsPerSession: perSession !== undefined && perSession >= 0 ? Math.floor(perSession) : d.maxConsultsPerSession,
      consultBudgetUsd: budget !== undefined && budget >= 0 ? budget : d.consultBudgetUsd,
      pauseAtHuman: bool(o.pauseAtHuman, d.pauseAtHuman),
      deescalateAfter: deesc !== undefined && deesc >= 1 ? Math.floor(deesc) : d.deescalateAfter,
      effortStep,
      effortBoost: parseEffort(o.effortBoost, d.effortBoost),
      notifyLead: bool(o.notifyLead, d.notifyLead),
      learningHalfLifeDays: halfLife !== undefined && halfLife >= 0 ? halfLife : d.learningHalfLifeDays,
      reviewRate: rate !== undefined && rate >= 0 && rate <= 1 ? rate : d.reviewRate,
      explore: explore !== undefined && explore >= 0 && explore <= 1 ? explore : d.explore,
      respectExplicitModel: bool(o.respectExplicitModel, d.respectExplicitModel),
      learnByCost: bool(o.learnByCost, d.learnByCost),
      modelCategories: bool(o.modelCategories, d.modelCategories),
      minReviewScore: minScore !== undefined && minScore >= 1 && minScore <= 5 ? minScore : d.minReviewScore,
      reworkWindowMinutes: rework !== undefined && rework >= 0 ? rework : d.reworkWindowMinutes,
      recordSessions: record !== undefined && record >= 0 ? Math.min(Math.floor(record), MAX_RECORD_SESSIONS) : d.recordSessions,
      reviewModel: typeof o.reviewModel === 'string' && reviewer.length <= 100 ? reviewer : d.reviewModel,
    }
  } catch {
    return d
  }
}
