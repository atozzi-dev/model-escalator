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
function nextAction(s: AgentState, cfg: Config): Action | undefined {
  const swapAt = cfg.levels.indexOf('swap')
  const canSwap = swapAt >= 0 && tierRank(s.tier) < tierRank(cfg.maxTier)
  if (canSwap && s.level > swapAt) return 'swap'            // level stays just past the swap
  while (s.level < cfg.levels.length) {
    const action = cfg.levels[s.level]!
    s.level++
    if (action !== 'swap' || canSwap) return action
  }
  return undefined
}

export type Observation = { tool: string; ok: boolean; text: string; summary: string }

export function observe(prev: AgentState, ob: Observation, cfg: Config = DEFAULT_CONFIG): { state: AgentState; action?: Action } {
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

  s.log.push(`${ob.tool}: ${ob.summary.slice(0, 120)} -> ${ob.ok ? 'ok' : 'ERR ' + normalizeError(ob.text).slice(0, 100)}`)
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
    const action = nextAction(s, cfg)
    if (action) {
      s.score = 0
      s.stepsSinceAction = 0
      if (action === 'swap') s.tier = nextTier(s.tier)
      return { state: s, action }
    }
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

// Flags the agent and raises its score to its threshold, so its next tool call earns the next ladder note.
export function markStall(s: AgentState, cfg: Config = DEFAULT_CONFIG): AgentState {
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

export function dossier(s: AgentState): string {
  return [
    `Task: ${s.task}`,
    `Model tier: ${s.tier}. Interventions so far: ${s.level}.`,
    'Recent attempts (oldest first):',
    ...s.log.map(l => '- ' + l),
  ].join('\n')
}
