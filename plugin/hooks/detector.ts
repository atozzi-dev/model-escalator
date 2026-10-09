// Pure logic: no $ calls, so it is unit-testable in isolation.

import { DEFAULT_CONFIG, type Config } from './config'
import { exitCodes, parseTestRuns } from './testparse'

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
  stepsSinceProgress: number            // model requests since the last progress; past the idle allowance each adds to the score
  errorCounts: Record<string, number>
  editCounts: Record<string, number>   // edits per normalised file path since the last progress
  lastFailing?: number
  log: string[]
  tokens: number
  // Liveness, for stall detection. All optional: snapshots saved before they existed lack them.
  lastEventAt?: number                  // $.clock.now() of the agent's last event (spawn, tool call start or end, model request)
  inFlight?: number                     // tool calls started and not yet finished
  running?: boolean                     // true from the first event of a run until turn.complete
  stalled?: boolean                     // already flagged as silent; cleared by any event
  helped?: boolean                      // asked for help through the tool at least once
  recentErrors?: string[]               // full text (cut) of the last failed calls, oldest first, for the senior dossier
  consults?: number                     // senior consult actions for this agent (a refused call and its retry count once)
}

export function tierOf(model: string | undefined): Tier {
  const m = (model ?? '').toLowerCase()
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('opus') || m.includes('mythos') || m.includes('fable')) return 'opus'
  return 'sonnet'
}

export type ObservedModels = Partial<Record<Tier, string>> & { leadShape?: string }

// Provider shape of an id: whatever precedes "claude-" ("us.anthropic." on Bedrock, "" for first-party and Vertex ids).
const shapeOf = (lower: string): string => lower.slice(0, lower.indexOf('claude-'))

// Remembers a resolved full id (never a bare alias such as "sonnet") under its own tier. Any provider prefix or
// suffix is fine (Bedrock region prefixes, "anthropic.", "@date", "-v1:0", "[1m]"): the family word must follow "claude-".
// `isLead` marks the id as the lead's own: its shape is then preferred, so a Bedrock lead keeps Bedrock-shaped targets
// even when an id of another shape shows up later for the same tier.
export function rememberModel(seen: ObservedModels, model: string | undefined, isLead = false): ObservedModels {
  const m = (model ?? '').trim()
  const lower = m.toLowerCase()
  const at = lower.indexOf('claude-')
  if (at < 0) return seen
  // Only the ladder's own families: fable/mythos/unknown ids must never become a swap target.
  if (lower.includes('fable') || lower.includes('mythos')) return seen
  const tier = LADDER.find((t) => lower.indexOf(t, at + 7) >= 0)
  if (!tier) return seen
  const next: ObservedModels = { ...seen }
  if (isLead) next.leadShape = shapeOf(lower)
  const kept = seen[tier]
  const keepsLead = kept !== undefined && next.leadShape !== undefined
    && shapeOf(kept.toLowerCase()) === next.leadShape && shapeOf(lower) !== next.leadShape
  if (!keepsLead) next[tier] = m
  return next
}

// Full model id to send for a tier: the user's explicit id, else the one observed in this session, else the default.
export function resolveModelId(seen: ObservedModels, tier: Tier, ids: Record<Tier, string> = DEFAULT_CONFIG.modelIds,
  overrides: Partial<Record<Tier, string>> = {}): string {
  return overrides[tier] ?? seen[tier] ?? ids[tier]
}

export const tierRank = (t: Tier): number => LADDER.indexOf(t)

export function nextTier(t: Tier): Tier {
  const i = LADDER.indexOf(t)
  return LADDER[Math.min(i + 1, LADDER.length - 1)]!
}

export function newAgent(id: string, category: string, model: string | undefined, task: string): AgentState {
  const t = tierOf(model)
  return { id, category, task: task.slice(0, 2000), startTier: t, tier: t, score: 0, level: 0,
    stepsSinceAction: 0, stepsSinceProgress: 0, errorCounts: {}, editCounts: {}, log: [], tokens: 0 }
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

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

// One key per file: forward slashes, case-folded for Windows-style paths (case-insensitive file systems).
export function normalizePath(p: string): string {
  const t = p.trim()
  const f = t.replace(/\\/g, '/')
  return f !== t || /^[a-z]:\//i.test(f) ? f.toLowerCase() : f
}

// The action due at the current level, moving s.level past it. While the agent runs below `maxTier`,
// the ladder keeps swapping one tier up instead of moving past the swap level. A swap that cannot happen
// (swap disabled, or the agent already at `maxTier`) is skipped, and the next enabled level acts in its place.
// A consult that is closed (a limit was reached) is skipped the same way: `skipped` reports it.
function nextAction(s: AgentState, cfg: Config, consultOpen: boolean, blocked: readonly Tier[]): { action?: Action; skipped: boolean } {
  const swapAt = cfg.levels.indexOf('swap')
  const canSwap = swapAt >= 0 && tierRank(s.tier) < tierRank(allowedMax(cfg.maxTier, blocked))
  if (canSwap && s.level > swapAt) return { action: 'swap', skipped: false }   // level stays just past the swap
  let skipped = false
  while (s.level < cfg.levels.length) {
    const action = cfg.levels[s.level]!
    s.level++
    if (action === 'consult' && !consultOpen) { skipped = true; continue }
    if (action !== 'swap' || canSwap) return { action, skipped }
  }
  return { skipped }
}

// Why no further senior consult may be made, or undefined when one may. `sessionConsults` is the total over
// all agents; `consultCost` the USD of every senior call so far (a refused call and its retry both count).
// A count limit of 0 allows no consult; a budget of 0 means no dollar limit.
export function consultLimit(s: AgentState, sessionConsults: number, consultCost: number, cfg: Config = DEFAULT_CONFIG): string | undefined {
  if ((s.consults ?? 0) >= cfg.maxConsultsPerAgent) return `per agent (${cfg.maxConsultsPerAgent} consults)`
  if (sessionConsults >= cfg.maxConsultsPerSession) return `per session (${cfg.maxConsultsPerSession} consults)`
  if (cfg.consultBudgetUsd > 0 && consultCost >= cfg.consultBudgetUsd) return `budget (USD ${cfg.consultBudgetUsd})`
  return undefined
}

export const MAX_RECENT_ERRORS = 6
export const MAX_ERROR_TEXT = 2000

// Keeps the head and the tail of a long error text (the cause is often at the end), within MAX_ERROR_TEXT.
function cutError(text: string): string {
  if (text.length <= MAX_ERROR_TEXT) return text
  const mark = '\n[... cut ...]\n'
  const room = MAX_ERROR_TEXT - mark.length
  const head = Math.floor(room * 0.45)
  return text.slice(0, head) + mark + text.slice(text.length - (room - head))
}

export type Observation = { tool: string; ok: boolean; text: string; summary: string }

// `consultOpen` false means a limit forbids consults now: a consult due at this trigger is skipped to the next
// enabled level, and `consultSkipped` tells the caller that a limit stopped it.
// `blocked` lists the tiers the account refused this session: a swap never reaches them, nor any tier above.
export function observe(prev: AgentState, ob: Observation, cfg: Config = DEFAULT_CONFIG, consultOpen = true, blocked: readonly Tier[] = []): { state: AgentState; action?: Action; consultSkipped?: boolean } {
  const s: AgentState = { ...prev, errorCounts: { ...prev.errorCounts }, editCounts: { ...prev.editCounts }, log: [...prev.log] }
  s.stepsSinceAction++
  let progress = false

  // Failing counts per test run in the output; plain text without a recognised summary falls back
  // to the first "N failed" it mentions.
  const runs = parseTestRuns(ob.text)
  const counts = runs.length > 0 ? runs.map(r => r.failed) : [failingTests(ob.text)].filter((n): n is number => n !== undefined)

  // Failed attempts in this output. An isError result is one attempt. A loop (or `; echo "exit=$?"`)
  // can hide failures behind ok=true, so every failing run and every non-zero exit marker counts as
  // well. The largest of the three wins, they are never summed, so one failed attempt weighs once
  // here (plus once below when its failing count does not drop).
  const failedRuns = runs.filter(r => r.failed > 0).length
  const badExits = exitCodes(ob.text).filter(c => c !== 0).length
  const attempts = Math.max(ob.ok ? 0 : 1, failedRuns, badExits)
  if (attempts > 0) {
    const sig = normalizeError(ob.text)
    for (let i = 0; i < attempts; i++) {
      const n = (s.errorCounts[sig] ?? 0) + 1
      s.errorCounts[sig] = n
      s.score += n >= 2 ? 1 : 0.25
    }
  }

  // Oscillation: the same file edited again and again without progress, whatever the errors say.
  if (EDIT_TOOLS.includes(ob.tool) && ob.summary) {
    const key = normalizePath(ob.summary)
    const edits = s.editCounts[key] ?? 0
    if (edits >= cfg.oscillationEdits) s.score += 1
    s.editCounts[key] = edits + 1
  }

  // Runs are applied in order. Progress wipes the score; later runs of the same output that do not
  // improve on the new baseline count again, so only the end state decides whether the call was progress.
  for (const failing of counts) {
    if (failing === 0 || (s.lastFailing !== undefined && failing < s.lastFailing)) {
      progress = true
      s.score = 0
      s.errorCounts = {}
      s.editCounts = {}
    } else if (s.lastFailing !== undefined) {
      s.score += 1
      progress = false
    }
    s.lastFailing = failing
  }

  s.log.push(`${ob.tool}: ${ob.summary.slice(0, 120)} -> ${attempts === 0 ? 'ok' : 'ERR ' + normalizeError(ob.text).slice(0, 100)}`)
  // One ring entry per failed log line (same rule as the "ERR" mark above), so the dossier can match them from the end.
  if (attempts > 0) s.recentErrors = [...(prev.recentErrors ?? []), cutError(String(ob.text ?? ''))].slice(-MAX_RECENT_ERRORS)
  if (s.log.length > cfg.logSize) s.log.splice(0, s.log.length - cfg.logSize)

  if (progress) {
    s.score = 0
    s.stepsSinceProgress = 0
    s.errorCounts = {}
    s.editCounts = {}
    return { state: s }
  }

  const due = s.level === 0 || s.stepsSinceAction >= cfg.grace
  if (s.score >= cfg.threshold[s.tier] && due) {
    const pick = nextAction(s, cfg, consultOpen, blocked)
    if (pick.action) {
      s.score = 0
      s.stepsSinceAction = 0
      if (pick.action === 'swap') s.tier = nextTier(s.tier)
      return { state: s, action: pick.action, consultSkipped: pick.skipped }
    }
    return { state: s, consultSkipped: pick.skipped }
  }
  return { state: s }
}

// One model request of a tracked agent. Requests beyond the idle allowance without progress add to the score,
// so an agent that keeps working without ever producing a result climbs the ladder too.
export function countStep(prev: AgentState, cfg: Config = DEFAULT_CONFIG): AgentState {
  const s: AgentState = { ...prev, stepsSinceProgress: prev.stepsSinceProgress + 1 }
  if (s.stepsSinceProgress > cfg.idleSteps) s.score += cfg.idleWeight
  return s
}

// Any event of the agent: it is running, not silent, and no longer flagged.
export function touch(s: AgentState, now: number): AgentState {
  return { ...s, lastEventAt: now, running: true, stalled: false }
}

export function toolStart(s: AgentState, now: number): AgentState {
  return { ...touch(s, now), inFlight: (s.inFlight ?? 0) + 1 }
}

export function toolEnd(s: AgentState, now: number): AgentState {
  return { ...touch(s, now), inFlight: Math.max(0, (s.inFlight ?? 0) - 1) }
}

// A tool call in flight (a build, a test suite) is legitimate silence: the window is three times longer,
// so only a call that hangs for very long is flagged.
export const BUSY_FACTOR = 3

// How long (ms) a running, not yet flagged agent has been silent, when that exceeds its window; else undefined.
// An agent without a timestamp (old snapshot) or whose run is over is never silent.
export function isSilent(s: AgentState, now: number, cfg: Config = DEFAULT_CONFIG): number | undefined {
  if (!s.running || s.stalled || s.lastEventAt === undefined) return undefined
  const window = cfg.stallMinutes * 60_000 * ((s.inFlight ?? 0) > 0 ? BUSY_FACTOR : 1)
  const silent = now - s.lastEventAt
  return silent > window ? silent : undefined
}

// Flags the agent. A silent agent with no tool call running also gets its score raised to its threshold, so its
// next tool call earns the next ladder note. With a tool call in flight the command may simply be slow: only
// flag it (the lead is notified); if the command fails, the usual error signals take over.
export function markStall(s: AgentState, cfg: Config = DEFAULT_CONFIG): AgentState {
  if ((s.inFlight ?? 0) > 0) return { ...s, stalled: true }
  return { ...s, stalled: true, score: Math.max(s.score, cfg.threshold[s.tier]) }
}

// An agent may ask for help once per grace window: after a help call (or any intervention) it waits
// for `grace` more tool calls.
export function canAskForHelp(s: AgentState, cfg: Config = DEFAULT_CONFIG): boolean {
  return !s.helped || s.stepsSinceAction >= cfg.grace
}

// A help call jumps straight to the senior consult: the ladder continues after it (never moves back),
// the score restarts and a fresh grace window begins.
export function afterHelp(s: AgentState, cfg: Config = DEFAULT_CONFIG): AgentState {
  const i = cfg.levels.indexOf('consult')
  return { ...s, helped: true, level: i >= 0 ? Math.max(s.level, i + 1) : s.level, score: 0, stepsSinceAction: 0 }
}

// True once an agent got past the swap level (it swapped at least once, or had none to make) (or past the last one when swap is disabled).
export function escalated(s: AgentState, levels: readonly Action[]): boolean {
  const i = levels.indexOf('swap')
  return i >= 0 ? s.level > i : s.level >= levels.length
}

// The senior model to retry a refused consult on: the other one of opus and sonnet (never haiku).
export function otherSenior(senior: string): 'opus' | 'sonnet' {
  return tierOf(senior) === 'opus' ? 'sonnet' : 'opus'
}

// After a refused consult nothing was given to the agent: the next ladder step is due without a grace window.
export function skipGrace(s: AgentState, cfg: Config = DEFAULT_CONFIG): AgentState {
  return { ...s, stepsSinceAction: Math.max(s.stepsSinceAction, cfg.grace) }
}

// Blocked models: a tier the account refuses (not on the organisation's allowlist, or not offered to it) is
// remembered for the session. It caps the ladder like `maxTier` does: the tier itself and all above are out.
export function refuseTier(blocked: readonly Tier[], tier: Tier): Tier[] {
  return blocked.includes(tier) ? [...blocked] : [...blocked, tier]
}

// The highest tier a swap may reach: `max`, or the one just below the lowest refused tier if that is lower.
export function allowedMax(max: Tier, blocked: readonly Tier[]): Tier {
  if (blocked.length === 0) return max
  const lowest = Math.min(...blocked.map(tierRank))
  return LADDER[Math.max(0, Math.min(tierRank(max), lowest - 1))]!
}

// The tier an agent should run on given the refused ones: its own tier, capped, never below where it started.
export function usableTier(s: AgentState, blocked: readonly Tier[]): Tier {
  const capped = LADDER[Math.min(tierRank(s.tier), tierRank(allowedMax('opus', blocked)))]!
  return tierRank(capped) < tierRank(s.startTier) ? s.startTier : capped
}

// After a swap target was refused: the agent goes back to the tier that worked and its ladder moves to the
// human level, due without a grace window. Without a human level it keeps its place.
export function revertSwap(s: AgentState, to: Tier, cfg: Config = DEFAULT_CONFIG): AgentState {
  const human = cfg.levels.indexOf('human')
  return { ...s, tier: to, level: human >= 0 ? human : s.level, stepsSinceAction: Math.max(s.stepsSinceAction, cfg.grace) }
}

export type ModelFailure = { status?: number | null; error?: string; message?: string }

// What an API failure says about the model: `model` when it is unusable for this account (unknown id, not
// allowed, no permission) so retrying cannot help; `transient` for overload, rate limit, server errors and
// dropped connections, which say nothing about the model; `unknown` when the failure carries no such sign.
export function classifyFailure(f: ModelFailure): 'model' | 'transient' | 'unknown' {
  const err = (f.error ?? '').toLowerCase()
  const msg = (f.message ?? '').toLowerCase()
  const status = typeof f.status === 'number' ? f.status : undefined
  if (err === 'model_not_found') return 'model'
  if (['rate_limit', 'overloaded', 'server_error', 'authentication_failed', 'billing_error'].includes(err)) return 'transient'
  if (status !== undefined && (status === 429 || status >= 500)) return 'transient'
  if (status === 404 || status === 403) return 'model'
  if (/overload|rate.?limit|too many requests|\b(429|5\d\d)\b|timed? ?out|econn|socket|network/.test(msg)) return 'transient'
  if (/not_found|not found|not allowed|allowlist|not available|invalid model|unknown model|permission|not have access|may not exist/.test(msg)) return 'model'
  return status === 400 && /model/.test(msg) ? 'model' : 'unknown'
}

export const isModelRefusal = (f: ModelFailure): boolean => classifyFailure(f) === 'model'

// The senior model for a consult: the configured one, else the other one, skipping refused tiers.
export function pickSenior(senior: string, refused: readonly Tier[]): string | undefined {
  if (!refused.includes(tierOf(senior))) return senior
  const other = otherSenior(senior)
  return refused.includes(other) ? undefined : other
}
