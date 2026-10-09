// Pure logic: no $ calls, so it is unit-testable in isolation.

import { DEFAULT_CONFIG, type Config } from './config'

export type Tier = 'haiku' | 'sonnet' | 'opus'
export const LADDER: readonly Tier[] = ['haiku', 'sonnet', 'opus']

export type Action = 'nudge' | 'consult' | 'swap' | 'human'

export type AgentState = {
  id: string
  category: string
  task: string
  startTier: Tier
  tier: Tier
  score: number
  level: number
  stepsSinceAction: number
  errorCounts: Record<string, number>
  lastFailing?: number
  log: string[]
  tokens: number
}

export function tierOf(model: string | undefined): Tier {
  const m = (model ?? '').toLowerCase()
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('opus') || m.includes('mythos') || m.includes('fable')) return 'opus'
  return 'sonnet'
}

export type ObservedModels = Partial<Record<Tier, string>>

// Remembers a resolved full id (never a bare alias such as "sonnet") under its own tier.
export function rememberModel(seen: ObservedModels, model: string | undefined): ObservedModels {
  const m = (model ?? '').trim()
  const lower = m.toLowerCase()
  if (!lower.startsWith('claude-')) return seen
  // Only the ladder's own families: fable/mythos/unknown ids must never become a swap target.
  const tier = LADDER.find((t) => lower.includes(t))
  return tier ? { ...seen, [tier]: m } : seen
}

// Full model id to send for a tier: the one observed in this session, else the default.
export function resolveModelId(seen: ObservedModels, tier: Tier, ids: Record<Tier, string> = DEFAULT_CONFIG.modelIds): string {
  return seen[tier] ?? ids[tier]
}

export function nextTier(t: Tier): Tier {
  const i = LADDER.indexOf(t)
  return LADDER[Math.min(i + 1, LADDER.length - 1)]!
}

export function newAgent(id: string, category: string, model: string | undefined, task: string): AgentState {
  const t = tierOf(model)
  return { id, category, task: task.slice(0, 2000), startTier: t, tier: t, score: 0, level: 0,
    stepsSinceAction: 0, errorCounts: {}, log: [], tokens: 0 }
}

// Strips what changes between identical failures: numbers, paths, hex ids, spacing.
export function normalizeError(text: string): string {
  return text
    .replace(/(\/[\w.@-]+)+/g, '<path>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

export function failingTests(text: string): number | undefined {
  const m = text.match(/(\d+)\s+(?:failed|failing|failures?)\b/i)
  if (m) return Number(m[1])
  if (/\b(\d+)\s+passed\b/i.test(text) && !/fail/i.test(text)) return 0
  return undefined
}

export type Observation = { tool: string; ok: boolean; text: string; summary: string }

export function observe(prev: AgentState, ob: Observation, cfg: Config = DEFAULT_CONFIG): { state: AgentState; action?: Action } {
  const s: AgentState = { ...prev, errorCounts: { ...prev.errorCounts }, log: [...prev.log] }
  s.stepsSinceAction++
  let progress = false

  if (!ob.ok) {
    const sig = normalizeError(ob.text)
    const n = (s.errorCounts[sig] ?? 0) + 1
    s.errorCounts[sig] = n
    s.score += n >= 2 ? 1 : 0.25
  }

  const failing = failingTests(ob.text)
  if (failing !== undefined) {
    if (failing === 0 || (s.lastFailing !== undefined && failing < s.lastFailing)) progress = true
    else if (s.lastFailing !== undefined && failing >= s.lastFailing) s.score += 1
    s.lastFailing = failing
  }

  s.log.push(`${ob.tool}: ${ob.summary.slice(0, 120)} -> ${ob.ok ? 'ok' : 'ERR ' + normalizeError(ob.text).slice(0, 100)}`)
  if (s.log.length > cfg.logSize) s.log.splice(0, s.log.length - cfg.logSize)

  if (progress) {
    s.score = 0
    s.errorCounts = {}
    return { state: s }
  }

  const due = s.level === 0 || s.stepsSinceAction >= cfg.grace
  if (s.score >= cfg.threshold[s.tier] && due && s.level < cfg.levels.length) {
    const action = cfg.levels[s.level]!
    s.level++
    s.score = 0
    s.stepsSinceAction = 0
    if (action === 'swap') s.tier = nextTier(s.tier)
    return { state: s, action }
  }
  return { state: s }
}

// True once an agent got past the swap level (or past the last one when swap is disabled).
export function escalated(s: AgentState, levels: readonly Action[]): boolean {
  const i = levels.indexOf('swap')
  return i >= 0 ? s.level > i : s.level >= levels.length
}

export function dossier(s: AgentState): string {
  return [
    `Task: ${s.task}`,
    `Model tier: ${s.tier}. Interventions so far: ${s.level}.`,
    'Recent attempts (oldest first):',
    ...s.log.map(l => '- ' + l),
  ].join('\n')
}
