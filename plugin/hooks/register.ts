import type { EngineInterface, HookStream, Register, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'
import { newTag, tagNote, withAnnouncement } from './channel'
import { DEFAULT_CONFIG, parseConfig, splitCommand, type Config } from './config'
import { LADDER, afterHelp, agentLabel, canAskForHelp, classifyFailure, clipLabel, consultLimit, countStep, EFFORTS, escalated, isModelRefusal, isPauseAllowedTool, isSilent, leadMessage, markStall, MAX_AGENT_NAME, MAX_LEAD_NOTICES, newAgent, noteProgress, normalizePath, observe, otherSenior, pauseAgent, pickSenior, raiseEffort, refuseTier, rememberModel, resolveModelId, resumeAgent, revertSwap, skipGrace, taskClaim, taskOfResult, tierOf, toolEnd, toolStart, touch, usableTier, type Action, type AgentState, type Effort, type LeadEvent, type ModelFailure, type ObservedModels, type Tier } from './detector'
import { buildDossier, inputFromState } from './dossier'
import { categorize, costPerAccepted, formatStats, isAccepted, mulberry32, recommendWithExploration, record, recordReview, recordRework, type Stats } from './learning'
import { createQueue } from './queue'
import { buildReviewPrompt, diffArgv, editedPath, formatReviews, isCheaper, parseReview, REVIEW_LIMITS, REVIEW_SYSTEM, sampleRun } from './review'
import { parseSnapshot, type Snapshot, type TrackedAgent } from './state'
import { addConsult, addIntervention, addStep, asUsage, cost as stepCost, emptyLedger, report, statusLine, type Ledger, type Usage } from './savings'

export const HELP_TOOL = 'mcp__model-escalator__ask_for_help'
const STATS_KEY = 'stats'
const SESSIONS_KEY = 'sessions'
const SENIOR_SYSTEM =
  'You advise a junior coding agent that is stuck. Read its attempts, name the most likely root cause, ' +
  'and give at most 5 concrete next steps. Do not repeat what already failed. Be brief.'

// active: full behavior · observe: measure and log what it would do, never intervene
// baseline: every agent runs on the baseline tier, no interventions (the A/B control arm) · off: pass through
export type Mode = 'active' | 'observe' | 'baseline' | 'off'

// Every read-modify-write of $.store goes through this queue, so agents that finish together
// cannot both read the old value and overwrite each other's update.
const storeQueue = createQueue()

// Verification commands run strictly one at a time, whatever the number of agents finishing together.
const verifyQueue = createQueue()
// True once the "could not run" toast was shown in this session.
let unavailableToasted = false
const pendingVerifications = new Set<Promise<void>>()

// Resolves once every verification started so far has recorded its outcome. Used by session.end.
async function flushVerifications(): Promise<void> {
  while (pendingVerifications.size > 0) await Promise.allSettled([...pendingVerifications])
}

// Sampled reviews run strictly one at a time in the background, like verifications.
let reviewQueue = createQueue()
const pendingReviews = new Set<Promise<void>>()
// Files each tracked agent edited during its current run, as it named them: the review diff is limited to them.
// Module state only: after a reload the review falls back to the whole working tree diff.
const editedFiles = new Map<string, string[]>()

// What is known, in memory only, of each sampled run (key `agentId:turnId`) between its recording and its review,
// which land in either order: the score when the review came first, whether the run was counted as accepted (and
// when) when the run came first. An entry is dropped once both sides are in; after a module reload the map is
// empty, which loses at most one flip and never counts a run twice. Capped, oldest dropped first.
type ReviewedRun = { accepted?: boolean; at?: number; score?: number }
const reviewRuns = new Map<string, ReviewedRun>()
const MAX_REVIEWED_RUNS = 200
const runKey = (id: string, turnId: unknown): string => `${id}:${typeof turnId === 'string' ? turnId : ''}`

// Rework tracking (option reworkWindowMinutes). Memory only: a module reload loses it, which at worst misses a rework
// (the snapshot would carry up to 50 runs of 50 paths each on every save, too much for a signal that lasts minutes).
// Files, normalised, each tracked agent wrote with a successful edit during its current run.
const writtenFiles = new Map<string, string[]>()
// Finished runs of cheap agents (key `agentId:turnId`) whose files the lead may rework, oldest first.
type ReworkRun = {
  category: string; tier: Tier; label: string; files: Set<string>; endedAt: number
  reworked: boolean
  accepted?: boolean   // how the run was counted, once it is recorded
  at?: number          // when it was recorded
  pending?: boolean    // reworked before it was recorded: applied by recordOutcome
}
const reworkRuns = new Map<string, ReworkRun>()
const MAX_REWORK_RUNS = 50
const MAX_REWORK_FILES = 50

// Messages to the lead sent this session (capped by MAX_LEAD_NOTICES) and the sends still in flight.
let leadNotices = 0
const pendingNotices = new Set<Promise<void>>()

const agents = new Map<string, TrackedAgent>()
// Agents for which a consult limit was already logged (one line per agent).
const limitNoted = new Set<string>()
// Subjects of the shared task list, by task id, as its answers showed them (most recent kept): what an
// in_progress TaskUpdate titles an agent with when the call carries no subject.
const taskSubjects = new Map<string, string>()
const MAX_TASK_SUBJECTS = 200
let ledger: Ledger = emptyLedger()
let baseline: Tier = 'opus'
let mode: Mode = 'active'
// True when MODEL_ESCALATOR_BASELINE fixes the reference model: the lead's model must not override it.
let baselinePinned = false
// Full model ids seen on turn.step requests and results, per tier: what a swap must send.
let seenModels: ObservedModels = {}
// Tiers the account refused this session: as a swap target (the ladder never goes there or above) and as a
// senior consult model. Persisted in the snapshot.
let blockedTiers: Tier[] = []
let refusedSeniors: Tier[] = []

// Per-session tag that authenticates our notes.
let sessionTag = newTag()

// Random source of the exploration draw: a PRNG seeded from the session tag, so a session has its own sequence
// and the same tag gives the same one (a reload restarts it, which is harmless for a draw).
let exploreRandom: (() => number) | undefined
let exploreRandomTag = ''
function explorationRandom(): () => number {
  if (exploreRandom === undefined || exploreRandomTag !== sessionTag) {
    exploreRandom = mulberry32(parseInt(sessionTag, 16) || 1)
    exploreRandomTag = sessionTag
  }
  return exploreRandom
}

// Tunables, built once from the plugin options when the module loads.
let config: Config = DEFAULT_CONFIG

// Stall detection: one periodic check per module load (a reload cancels the old one with its environment).
let stallTimer: { cancel: () => void } | undefined

// Half-life of learned evidence in ms; 0 turns the decay off.
function halfLifeMs(): number { return config.learningHalfLifeDays * 86_400_000 }

// Current time from the host clock, or undefined when it cannot be read (liveness is then simply not tracked).
async function clockNow($: EngineInterface): Promise<number | undefined> {
  try { return (lastNow = await $.clock.now()) } catch { return undefined }
}
// The latest time read from the host clock: the end of a run is stamped with it, without a new await that would
// delay the recording of the run (every step and tool call of the run just read the clock).
let lastNow: number | undefined

// Records an event of a tracked agent (it is running and not silent). Synchronous on `agents`, so it
// cannot interleave with another handler's read-modify-write.
function mark(id: string | undefined, now: number | undefined, f: typeof touch = touch): void {
  const a = id ? agents.get(id) : undefined
  if (id && a && now !== undefined) agents.set(id, f(a, now))
}

const watching = (): boolean => mode === 'active' || mode === 'observe'

// Senior consults of the whole session. Agents never leave the map, so the sum over agents is the total.
function sessionConsults(): number {
  let n = 0
  for (const a of agents.values()) n += a.consults ?? 0
  return n
}

// The limit that closes consults for this agent right now, if any.
const limitFor = (a: AgentState): string | undefined => consultLimit(a, sessionConsults(), ledger.consultCost, config)

// Logs once per agent that a limit stopped a consult. Diagnostics only: never throws.
async function noteLimit($: EngineInterface, a: AgentState, limit: string): Promise<void> {
  if (limitNoted.has(a.id)) return
  limitNoted.add(a.id)
  try { await $.ui.log(`${agentLabel(a)} (${a.category}): consult limit reached: ${limit}`) } catch { /* the note is best effort */ }
}

// The short name of an agent for a toast or a status line: its name when it has one, else its category.
const shortName = (a: { name?: string; category: string }): string => a.name ?? a.category

// Remembers the subjects a task-list answer carries, and titles the tracked agent (`id`, undefined when it is not
// tracked) that created or claimed the task. Returns true when the agent's title changed. Never throws.
function noteTask(id: string | undefined, e: Record<string, unknown>, r: unknown): boolean {
  try {
    const t = taskOfResult((r as { result?: unknown } | undefined)?.result)
    if (t) {
      taskSubjects.delete(t.id)
      taskSubjects.set(t.id, t.subject)
      if (taskSubjects.size > MAX_TASK_SUBJECTS) taskSubjects.delete(taskSubjects.keys().next().value as string)
    }
    const a = id ? agents.get(id) : undefined
    if (!id || !a) return false
    const title = taskClaim(e.tool, e, taskSubjects)
    if (title === undefined || title === a.taskTitle) return false
    agents.set(id, { ...a, taskTitle: title })
    return true
  } catch {
    return false
  }
}

// Restores the module state to its defaults. Used by tests so each one starts clean.
export function resetState(): void {
  sessionTag = newTag()
  exploreRandom = undefined
  agents.clear()
  limitNoted.clear()
  taskSubjects.clear()
  leadNotices = 0
  pendingNotices.clear()
  ledger = emptyLedger()
  baseline = 'opus'
  baselinePinned = false
  seenModels = {}
  blockedTiers = []
  refusedSeniors = []
  mode = 'active'
  stallTimer?.cancel()
  stallTimer = undefined
  reviewQueue = createQueue()
  pendingReviews.clear()
  editedFiles.clear()
  reviewRuns.clear()
  writtenFiles.clear()
  reworkRuns.clear()
  lastNow = undefined
}

function snapshot(): Snapshot {
  return { agents: [...agents.values()], ledger, seenModels, sessionTag, mode, baseline, baselinePinned, blockedTiers, refusedSeniors }
}

// Reference to the session snapshot in $.state (the contract lives in types/index.d.ts).
const SESSION = { plugin: 'model-escalator', key: 'session' } as const

// Write-through with coalescing: only one write runs at a time and the loop always writes the latest
// in-memory state, so concurrent steps and tool calls cannot lose each other's updates. Never throws.
let inflight: Promise<void> | null = null
let dirty = false

function save($: EngineInterface): Promise<void> {
  dirty = true
  if (inflight) return inflight
  inflight = (async () => {
    try {
      while (dirty) {
        dirty = false
        await $.state.set(SESSION, JSON.parse(JSON.stringify(snapshot())) as Snapshot)
      }
    } catch { /* keep working from memory */ } finally {
      dirty = false
      inflight = null
    }
  })()
  return inflight
}

function summarize(e: Record<string, unknown>): string {
  for (const k of ['command', 'file_path', 'pattern', 'url', 'query']) {
    const v = e[k]
    if (typeof v === 'string') return v
  }
  return ''
}

function textOf(r: { text?: string; result?: unknown }): string {
  if (typeof r.text === 'string') return r.text
  if (typeof r.result === 'string') return r.result
  try { return JSON.stringify(r.result ?? '') } catch { return '' }
}

// The engine marks a fork with `fork: true` on agent.spawn (subagentType is `fork` too).
export function isFork(e: { fork?: boolean; subagentType?: string }): boolean {
  return e.fork === true || e.subagentType === 'fork'
}

export function readMode(v: string | undefined): Mode {
  return v === 'observe' || v === 'baseline' || v === 'off' ? v : 'active'
}

export const register: Register = (on, options) => {
  config = parseConfig(options)

  on('session.start', async ($, e, next) => {
    // $.state is session-scoped: a snapshot there means this is a reload of the module, not a new session.
    let saved: Snapshot | undefined
    try { saved = parseSnapshot((await $.state.get(SESSION)).value) } catch { saved = undefined }
    if (saved) {
      agents.clear()
      // A tool call in flight at the reload never reports its end to the new module: start from zero.
      for (const a of saved.agents) agents.set(a.id, { ...a, inFlight: 0 })
      ledger = saved.ledger
      seenModels = saved.seenModels
      sessionTag = saved.sessionTag
      mode = saved.mode
      baseline = saved.baseline
      baselinePinned = saved.baselinePinned
      blockedTiers = saved.blockedTiers
      refusedSeniors = saved.refusedSeniors
    } else {
      try {
        sessionTag = newTag()
        unavailableToasted = false
        leadNotices = 0
        // `claude plugin eval` only forwards EVAL_* variables to its runs: those are the fallback for an unset or empty plain one.
        // ($.env.get needs literal names, so the reads are spelled out.)
        mode = readMode((await $.env.get('MODEL_ESCALATOR_MODE')) || (await $.env.get('EVAL_MODEL_ESCALATOR_MODE')) || undefined)
        const b = (await $.env.get('MODEL_ESCALATOR_BASELINE')) || (await $.env.get('EVAL_MODEL_ESCALATOR_BASELINE'))
        baselinePinned = Boolean(b)
        if (b) baseline = tierOf(b)
      } catch { /* defaults */ }
      await save($)
    }
    stallTimer?.cancel()
    stallTimer = undefined
    if (watching()) {
      try {
        const period = Math.max(1000, Math.min(30_000, (config.stallMinutes * 60_000) / 4))
        stallTimer = $.clock.every(period, () => { void checkStalls($) })
      } catch { /* no stall detection, everything else works */ }
    }
    const r = await next(e)
    if (watching()) {
      try {
        await $.tool.register({
          name: 'ask_for_help',
          description: 'Ask a senior model for advice when you are blocked. Use it only after you made real attempts ' +
            'that failed, not as a first step. Say what blocks you and what you already tried.',
          inputSchema: {
            type: 'object',
            properties: {
              problem: { type: 'string', description: 'What is blocking you.' },
              tried: { type: 'string', description: 'What you already tried.' },
            },
            required: ['problem'],
          },
          isDeferred: false,
        })
      } catch { /* the tool is optional: the ladder works without it */ }
    }
    try {
      await $.command.register({ name: 'escalator', description: 'Model escalator: savings report and stats', argumentHint: '[report|stats|reset|resume <id>|resume all]' })
    } catch { /* name taken: the report stays reachable through the status line */ }
    return r
  })

  on('command.run', { command: 'escalator' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'stats') {
      const stats = ((await $.store.get(STATS_KEY)) ?? {}) as Stats
      const reviews = formatReviews(stats)
      return { text: 'Learned stats per category (runs / escalated):\n' + formatStats(stats, await clockNow($), halfLifeMs()) +
        (reviews ? '\n\nSenior review scores of sampled runs (1-5):\n' + reviews : '') }
    }
    if (arg === 'reset') {
      await storeQueue(async () => { await $.store.delete(STATS_KEY) })
      return { text: 'Learned stats cleared.' }
    }
    if (arg === 'resume' || arg.startsWith('resume ')) return { text: await resumeCommand($, arg.slice(6).trim()) }
    const paused = [...agents.values()].filter((a) => a.paused)
    const pausedText = paused.length === 0 ? '' : '\n\nPaused (resume with /escalator resume <id>|all):\n' +
      paused.map((a) => `- ${agentLabel(a)} (${a.category}, ${a.tier})`).join('\n')
    return { text: `Mode: ${mode}\n` + report(ledger, baseline) + pausedText }
  })

  // 1. Spawn: remember the agent, and let history (or baseline mode) pick the model.
  on('agent.spawn', async ($, e, next) => {
    if (mode === 'off') return next(e)
    // A fork inherits the parent's model and context: it is never rewritten, announced or tracked.
    if (isFork(e)) return next(e)
    let ev = e
    const category = categorize(e.subagentType, e.description)
    try {
      const asked = tierOf(e.model ?? e.parentModel)
      const stats = ((await $.store.get(STATS_KEY)) ?? {}) as Stats
      const choice = mode === 'baseline'
        ? { tier: baseline, reason: 'requested' as const, learned: baseline }
        : recommendWithExploration(stats, category, asked, {
          now: await clockNow($), halfLifeMs: halfLifeMs(), explore: config.explore, byCost: config.learnByCost,
          ...(config.explore > 0 ? { rand: explorationRandom() } : {}),
        })
      // In observe mode the model stays as asked: exploring is only logged, the learned tier is what "would" happen.
      const exploring = choice.reason === 'explore'
      const best = exploring && mode === 'observe' ? choice.learned : choice.tier
      const label = clipLabel(e.name, MAX_AGENT_NAME) ?? category
      if (best !== asked) {
        if (mode !== 'observe') ev = { ...e, model: best }
        await $.ui.log(`${label}: ${asked} -> ${best}${mode === 'observe' ? ' (would)' : ''}`)
      }
      if (choice.basis === 'cost') await $.ui.log(`${label}: chosen by cost per accepted run (${costLine(stats, category, asked, await clockNow($))})`)
      if (exploring) {
        await $.ui.log(mode === 'observe'
          ? `${label}: would explore ${choice.tier} for ${category} (learned ${choice.learned})`
          : `${label}: exploring ${choice.tier} for ${category} (learned ${choice.learned})`)
      }
    } catch { /* never block a spawn on our own failure */ }
    try {
      if (mode === 'active') ev = { ...ev, prompt: withAnnouncement(ev.prompt, sessionTag) }
    } catch { /* keep the original prompt */ }
    const r = await next(ev)
    if (r.agentId) {
      const name = clipLabel(e.name, MAX_AGENT_NAME)
      const fresh = newAgent(r.agentId, category, r.model, e.prompt)
      agents.set(r.agentId, name === undefined ? fresh : { ...fresh, name })
      if (watching()) mark(r.agentId, await clockNow($))
      await save($)
    }
    return r
  })

  // The help tool: a tracked agent asks for the senior consult directly. Answered here, never passed on.
  on('tool.call', { tool: HELP_TOOL as never }, async ($, e) => {
    const ev = e as unknown as Record<string, unknown>
    const stop = pausedDeny(typeof ev.agentId === 'string' ? ev.agentId : undefined, ev.tool)
    if (stop) return stop as never
    const text = await handleHelp($, ev, typeof ev.agentId === 'string' ? ev.agentId : undefined)
    return { result: text } as never
  })

  // 2. Every tool call of a watched agent updates its difficulty score.
  on('tool.call', async ($, e, next) => {
    const stop = pausedDeny(e.agentId, e.tool)
    if (stop) return stop
    if ((e.tool as string) === HELP_TOOL) return next(e)
    const id = e.agentId
    const tracked = watching() && id !== undefined && agents.has(id)
    if (tracked) mark(id, await clockNow($), toolStart)
    let r: Awaited<ReturnType<typeof next>>
    try {
      r = await next(e)
    } catch (err) {
      if (tracked) mark(id, await clockNow($), toolEnd)
      throw err
    }
    if (tracked) mark(id, await clockNow($), toolEnd)
    if (tracked && config.reviewRate > 0 && r.isError !== true && r.deny === undefined) noteEdit(id, e as unknown as Record<string, unknown>)
    if (config.reworkWindowMinutes > 0 && r.isError !== true && r.deny === undefined) {
      if (tracked) noteWritten(id, e as unknown as Record<string, unknown>)
      else if (id === undefined) await noteLeadEdit($, e as unknown as Record<string, unknown>)
    }
    if (noteTask(tracked ? id : undefined, e as unknown as Record<string, unknown>, r)) await save($)
    if (mode === 'off' || mode === 'baseline') return r
    const a = id ? agents.get(id) : undefined
    if (!id || !a || r.deny !== undefined) return r
    try {
      const limit = limitFor(a)
      const { state, action, consultSkipped, progress } = observe(a, {
        tool: e.tool, ok: r.isError !== true, text: textOf(r), summary: summarize(e as unknown as Record<string, unknown>),
      }, config, limit === undefined, blockedTiers)
      if (consultSkipped && limit) await noteLimit($, state, limit)
      if (!action) {
        // Progress while swapped up may send the agent back one tier (option deescalateAfter).
        const back = progress ? noteProgress(state, config, mode === 'observe') : { state }
        agents.set(id, back.state)
        if (back.decided) {
          ledger = addIntervention(ledger, 'deescalate')
          await $.ui.log(`${agentLabel(state)} (${state.category}): ${mode === 'observe' ? 'would de-escalate' : `de-escalate to ${back.state.tier}`}`)
        }
        await save($)
        if (back.decided && mode === 'active') {
          return { ...r, context: [...(r.context ?? []), tag(`Progress noted: from your next step you run on ${back.state.tier} again.`)] } as typeof r
        }
        return r
      }
      ledger = addIntervention(ledger, action)
      if (mode === 'observe') {
        await $.ui.log(`${agentLabel(state)} (${state.category}): would ${labelOf(action)}`)
        // Measure only: never swap, never raise the effort.
        const { effortBoosted: _boost, ...rest } = state
        agents.set(id, a.effortBoosted === undefined ? { ...rest, tier: a.tier } : { ...rest, tier: a.tier, effortBoosted: a.effortBoosted })
        await save($)
        return r
      }
      // The human level pauses the agent: from now on its tool calls are refused until the user resumes it.
      agents.set(id, action === 'human' && config.pauseAtHuman ? pauseAgent(state) : state)
      const note = await act($, state, action)
      if (action === 'swap') notifyLead($, state, { kind: 'swap', tier: state.tier })
      else if (action === 'human') notifyLead($, state, { kind: 'human', paused: config.pauseAtHuman })
      await save($)
      return { ...r, context: [...(r.context ?? []), note] } as typeof r
    } catch {
      return r
    }
  })

  // 3. Swap the model of escalated agents, and meter every request's cost.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId && !baselinePinned) baseline = tierOf(e.model)
    let a = e.agentId ? agents.get(e.agentId) : undefined
    seenModels = rememberModel(seenModels, e.model, !e.agentId)
    if (e.agentId && watching() && agents.has(e.agentId)) mark(e.agentId, await clockNow($))
    // The request's own effort, before any rewrite: the effort level can act only on one it can raise.
    const ownEffort = effortOf(e)
    try {
      const cur = e.agentId && watching() ? agents.get(e.agentId) : undefined
      if (cur && cur.effortSeen !== ownEffort) { a = { ...cur, effortSeen: ownEffort }; agents.set(cur.id, a) }
    } catch { /* the request goes on unchanged */ }
    // A tier another agent found refused is out for this one too: back to the highest usable tier.
    if (mode === 'active' && a && a.tier !== usableTier(a, blockedTiers)) {
      a = revertSwap(a, usableTier(a, blockedTiers), config)
      agents.set(a.id, a)
    }
    const swap = mode === 'active' && a !== undefined && a.tier !== a.startTier
    // A raised effort goes on every request of the agent until its next swap; a request without one is left alone.
    const boost = mode === 'active' && a?.effortBoosted === true ? raiseEffort(ownEffort, config.effortBoost) : undefined
    const sent = boost ? ({ ...e, effort: boost } as TurnStepInput) : e
    const r = swap ? yield* guardedSwap($, sent, next, a!) : yield* next(sent)
    seenModels = rememberModel(seenModels, r.usage?.model, !e.agentId)
    if (e.agentId && watching() && agents.has(e.agentId)) mark(e.agentId, await clockNow($))
    // Idle requests count only where a score is acted on: active, and observe (which measures it).
    try {
      const counted = e.agentId ? agents.get(e.agentId) : undefined
      if (e.agentId && counted && !counted.paused && (mode === 'active' || mode === 'observe')) agents.set(e.agentId, countStep(counted, config))
      // The request's cost goes to the agent's run, on whatever model it ran (an escalation is part of the run's cost).
      const u = asUsage(r.usage)
      const owner = e.agentId ? agents.get(e.agentId) : undefined
      if (e.agentId && owner && u && watching()) {
        agents.set(e.agentId, { ...owner, runCost: (owner.runCost ?? 0) + stepCost(u, config.prices[tierOf(r.usage?.model)], '5m') })
      }
    } catch { /* the stream must go on */ }
    if (mode !== 'off' && r.usage) {
      ledger = addStep(ledger, r.usage as Usage, tierOf(r.usage.model), baseline, Boolean(e.agentId), config)
    }
    await save($)
    return r
  })

  // 4. End of an agent's run: learn from it and refresh the running report.
  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    const a = id ? agents.get(id) : undefined
    if (id && a && mode !== 'off') {
      const written = writtenFiles.get(id) ?? []
      writtenFiles.delete(id)
      try {
        if (mode !== 'baseline') {
          const wasEscalated = escalated(a, config.levels)
          const argv = splitCommand(config.verifyCommand)
          // Read loosely: older published types may not declare these fields.
          const turn = e as { turnId?: unknown; isAborted?: unknown }
          const key = runKey(id, turn.turnId)
          trackRun(a, key, written, lastNow, turn.isAborted === true)
          // Before the outcome is recorded, so the run is known as sampled when it is.
          startReview($, a, turn.turnId, turn.isAborted === true)
          if (argv.length === 0) {
            await recordOutcome($, a, wasEscalated, false, key)
          } else {
            // The agent's run is over and the lead is waiting for its result: verify in the background,
            // one command at a time, and record the outcome (once) when it is known.
            const p: Promise<void> = verifyQueue(() => verifyAndRecord($, a, wasEscalated, argv, key))
              .catch(() => undefined).finally(() => { pendingVerifications.delete(p) })
            pendingVerifications.add(p)
          }
        }
        // The run is over: its cost was taken above, the next run starts from none.
        const { runCost: _spent, ...rest } = agents.get(id) ?? a
        agents.set(id, { ...rest, level: 0, score: 0, stepsSinceAction: 0, deescalated: false, progressSignals: 0, running: false, inFlight: 0, stalled: false })
        await save($)
        await $.ui.status(statusLine(ledger))
      } catch { /* best effort */ }
    }
    return next(e)
  })

  // 5. Keep a short history of sessions for later comparison.
  on('session.end', async ($, e, next) => {
    try {
      // Give running verifications a moment to land their outcome; session.end has a short budget.
      if (pendingVerifications.size > 0 || pendingReviews.size > 0) {
        await Promise.race([Promise.all([flushVerifications(), flushReviews()]), $.clock.sleep(1000)])
      }
      if (pendingNotices.size > 0) await Promise.race([Promise.allSettled([...pendingNotices]), $.clock.sleep(1000)])
    } catch { /* best effort */ }
    try {
      if (mode !== 'off' && ledger.agentSteps > 0) {
        const entry = { at: await $.clock.now(), mode, baseline, ledger }
        await storeQueue(async () => {
          const past = ((await $.store.get(SESSIONS_KEY)) ?? []) as unknown[]
          await $.store.set(SESSIONS_KEY, [...past, entry].slice(-50))
        })
      }
    } catch { /* best effort */ }
    return next(e)
  })
}

// What an API failure says about the model, read from whatever the thrown value carries.
function failureOf(err: unknown): ModelFailure {
  const o = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>
  const inner = (typeof o.error === 'object' && o.error !== null ? o.error : {}) as Record<string, unknown>
  const status = [o.status, o.statusCode, inner.status].find((v): v is number => typeof v === 'number')
  const kind = [o.error, inner.type, o.type, o.code].find((v): v is string => typeof v === 'string')
  return { status, error: kind, message: String(typeof o.message === 'string' ? o.message : err).slice(0, 500) }
}

// A cheap call that names the model: the engine allowlist-checks it and classifies the failure, so a request
// that came back empty can be told apart (refused model or transient). Never throws.
async function probeModel($: EngineInterface, model: string): Promise<ModelFailure | undefined> {
  try {
    const reply = await $.model.complete({ model, prompt: 'ok', maxTokens: 1 }) as ModelReply
    if (typeof reply === 'string' || reply.isAnswered) return undefined
    return { status: reply.status, error: reply.reason === 'api-error' ? reply.error : undefined }
  } catch (err) {
    return failureOf(err)
  }
}

// A swap target the account refuses: remember it for the session (it caps the ladder like maxTier, and it is
// no senior either), send every agent that sits on or above it back to the highest usable tier with its
// ladder at the human level, and tell the user. Returns the tier the asking agent now runs on.
async function refuseSwapTarget($: EngineInterface, id: string, tier: Tier, model: string): Promise<Tier> {
  blockedTiers = refuseTier(blockedTiers, tier)
  refusedSeniors = refuseTier(refusedSeniors, tier)
  for (const [aid, a] of [...agents]) {
    const ok = usableTier(a, blockedTiers)
    if (a.tier !== ok) agents.set(aid, revertSwap(a, ok, config))
  }
  const a = agents.get(id)
  const back = a?.tier ?? tier
  try {
    await $.ui.log(`${a ? agentLabel(a) : id} (${a?.category ?? '-'}): ${model} is not available, stays on ${back}`)
    await $.ui.toast(`${model} is not available: ${a ? shortName(a) : 'agent'} stays on ${back}`)
  } catch { /* the notice is best effort */ }
  if (a) notifyLead($, a, { kind: 'unavailable', model, stays: back })
  await save($)
  return back
}

// Tells the lead (the session's main conversation) about an escalated agent, once per event, in active mode and
// with notifyLead on, at most MAX_LEAD_NOTICES per session. Fire and forget: the hook never waits for the append,
// and one that fails or is refused only leaves a line in the debug log (the toast and log already carry the
// news). The append is awaited at session end for a moment, like the verifications.
function notifyLead($: EngineInterface, a: AgentState, ev: LeadEvent): void {
  try {
    if (mode !== 'active' || !config.notifyLead || leadNotices >= MAX_LEAD_NOTICES) return
    const text = leadMessage(a, ev, leadNotices === 0)
    leadNotices++
    const p: Promise<void> = (async () => {
      try {
        // $.session.send cannot reach the main loop (it only addresses other sessions and agents), so the notice
        // is a user-role row the person does not see as typed, appended to the main conversation.
        const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
        if (r.deny !== undefined) await $.ui.log(`${a.id}: lead not notified: ${r.deny}`, { to: 'debug' })
      } catch (err) {
        try { await $.ui.log(`${a.id}: lead not notified: ${String((err as { message?: unknown } | undefined)?.message ?? err).slice(0, 200)}`, { to: 'debug' }) } catch { /* diagnostics only */ }
      }
    })().finally(() => { pendingNotices.delete(p) })
    pendingNotices.add(p)
  } catch { /* the notice is best effort */ }
}

// The request of a swapped agent, on its target tier. If the engine refuses the model (unknown id, not on the
// organisation's allowlist) before any content came back, the same step is sent again on the tier that worked,
// so the agent never sees the failure; any other failure goes through untouched. Chunks of the engine's own
// are held back until the first real one, so a failed first attempt leaves nothing in the stream.
async function* guardedSwap(
  $: EngineInterface, e: TurnStepInput, next: (e: TurnStepInput) => HookStream<TurnStepChunk, TurnStepResult>, a: AgentState,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const target = resolveModelId(seenModels, a.tier, config.modelIds, config.modelOverrides)
  const held: TurnStepChunk[] = []
  let live = false
  let result: TurnStepResult | undefined
  let thrown: { err: unknown } | undefined
  try {
    const stream = next({ ...e, model: target })
    for (;;) {
      const it = await stream.next()
      if (it.done) { result = it.value; break }
      if (live) { yield it.value; continue }
      if (it.value.kind === 'engine') { held.push(it.value); continue }
      live = true
      yield* held.splice(0)
      yield it.value
    }
  } catch (err) {
    if (live) throw err
    thrown = { err }
  }
  // A failure that names its cause is classified as it is; one that does not (an empty result, an opaque
  // error) is probed with a one-token call that the engine classifies.
  let failure: ModelFailure | undefined
  if (thrown) failure = failureOf(thrown.err)
  else if (!live && (!result || (result.stopReason === null && result.usage === null))) failure = {}
  if (failure && classifyFailure(failure) === 'unknown') failure = await probeModel($, target)
  if (!failure || !isModelRefusal(failure)) {
    if (thrown) throw thrown.err
    yield* held.splice(0)
    return result!
  }
  const back = await refuseSwapTarget($, a.id, a.tier, target)
  const fallback = back === a.startTier && tierOf(e.model) === back ? e.model : resolveModelId(seenModels, back, config.modelIds, config.modelOverrides)
  return yield* next({ ...e, model: fallback })
}

// One tick of the stall check: flags running agents silent past the window (once until they act again).
// The lead is told through the log, the status line and, in active mode, a toast; the agent itself is only
// reached by the next ladder note on its next tool call, because a note travels with a tool result.
async function checkStalls($: EngineInterface): Promise<void> {
  try {
    if (!watching()) return
    const now = await clockNow($)
    if (now === undefined) return
    const found: { a: AgentState; silent: number }[] = []
    for (const [id, a] of [...agents]) {
      if (a.running && a.lastEventAt === undefined) { agents.set(id, { ...a, lastEventAt: now }); continue }
      const silent = isSilent(a, now, config)
      if (silent === undefined) continue
      const stalled = markStall(a, config)
      agents.set(id, stalled)
      ledger = addIntervention(ledger, 'stall')
      found.push({ a: stalled, silent })
    }
    if (found.length === 0) return
    await save($)
    for (const { a, silent } of found) {
      const min = Math.max(1, Math.round(silent / 60_000))
      const busy = (a.inFlight ?? 0) > 0 ? ' (a tool call is still running)' : ''
      try {
        await $.ui.log(`${agentLabel(a)} (${a.category}): no activity for ${min} min${busy}`)
        await $.ui.status(`stalled: ${shortName(a)} (${a.id}) silent for ${min} min`)
        if (mode === 'active') await $.ui.toast(`${shortName(a)}: no activity for ${min} min`)
      } catch { /* the notice is best effort */ }
    }
  } catch { /* a failing check must never disturb the session */ }
}

// The cost per accepted run of each tier from `asked` upward that has one, for the spawn log: "haiku $0.10, sonnet $0.33".
function costLine(stats: Stats, category: string, asked: Tier, now: number | undefined): string {
  const parts: string[] = []
  for (let i = LADDER.indexOf(asked); i >= 0 && i < LADDER.length; i++) {
    const t = LADDER[i]!
    const cell = stats[category]?.[t]
    const e = cell === undefined ? undefined : costPerAccepted(cell, now, halfLifeMs())
    if (e !== undefined) parts.push(`${t} $${e < 0.01 ? e.toFixed(4) : e.toFixed(2)}`)
  }
  return parts.join(', ')
}

// Records one finished run: its cost (the agent's requests and consults of the run, not the review), and whether it
// was accepted. A review that already landed counts in the acceptance here; one that has not is told how the run
// was counted (see reviewRun), so a late low score moves the run to not accepted exactly once.
async function recordOutcome($: EngineInterface, a: TrackedAgent, wasEscalated: boolean, verifyFailed: boolean, key: string): Promise<void> {
  await storeQueue(async () => {
    const stats = ((await $.store.get(STATS_KEY)) ?? {}) as Stats
    const now = await clockNow($)
    const e = reviewRuns.get(key)
    let next = record(stats, a.category, a.startTier, wasEscalated, 0, verifyFailed, now, halfLifeMs(),
      { cost: a.runCost, reviewScore: e?.score, minScore: config.minReviewScore })
    const accepted = isAccepted({ escalated: wasEscalated, verifyFailed, reviewScore: e?.score }, config.minReviewScore)
    // The lead may have reworked the run before its verification landed: it is moved to not accepted now, once.
    const run = reworkRuns.get(key)
    const reworkedEarly = run?.pending === true
    if (run) {
      run.accepted = accepted && !reworkedEarly
      if (now !== undefined) run.at = now
      if (reworkedEarly) {
        run.pending = false
        next = recordRework(next, a.category, a.startTier, { now, halfLifeMs: halfLifeMs(), runAccepted: accepted, runAt: now })
      }
    }
    if (e?.score !== undefined) reviewRuns.delete(key)
    else if (e) reviewRuns.set(key, { accepted: accepted && !reworkedEarly, ...(now !== undefined ? { at: now } : {}) })
    await $.store.set(STATS_KEY, next)
  })
}

// Remembers the file a successful edit tool call of a tracked agent changed (first spelling kept, capped). Never throws.
function noteEdit(id: string, input: Record<string, unknown>): void {
  try {
    const path = editedPath(input.tool, input)
    if (!path) return
    const list = editedFiles.get(id) ?? []
    if (!list.includes(path) && list.length < REVIEW_LIMITS.maxTracked) editedFiles.set(id, [...list, path])
  } catch { /* the review falls back to the whole diff */ }
}

// Remembers the file a successful edit of a tracked agent wrote, normalised, for the rework check at the end of its run.
function noteWritten(id: string, input: Record<string, unknown>): void {
  try {
    const raw = editedPath(input.tool, input)
    if (!raw) return
    const list = writtenFiles.get(id) ?? []
    const file = normalizePath(raw)
    if (!list.includes(file) && list.length < MAX_REWORK_FILES) writtenFiles.set(id, [...list, file])
  } catch { /* rework tracking is optional */ }
}

// End of a tracked agent's run: keeps the files it wrote for the rework check when it started below the reference tier.
// The run's end is the clock at turn.complete; without a clock nothing is tracked. Never throws.
function trackRun(a: AgentState, key: string, files: readonly string[], now: number | undefined, aborted: boolean): void {
  try {
    if (!watching() || aborted || config.reworkWindowMinutes <= 0 || files.length === 0 || now === undefined) return
    if (!isCheaper(a.startTier, baseline)) return
    reworkRuns.delete(key)
    reworkRuns.set(key, { category: a.category, tier: a.startTier, label: agentLabel(a), files: new Set(files), endedAt: now, reworked: false })
    if (reworkRuns.size > MAX_REWORK_RUNS) reworkRuns.delete(reworkRuns.keys().next().value as string)
  } catch { /* rework tracking is optional */ }
}

// A successful edit by the main loop: when it touches a file the most recent run of a cheap agent wrote, inside the
// window, that run is reworked. Each run counts once, however many edits follow. Edits the user makes outside
// Claude Code never reach this hook. Never throws.
async function noteLeadEdit($: EngineInterface, input: Record<string, unknown>): Promise<void> {
  try {
    if (!watching() || reworkRuns.size === 0) return
    const raw = editedPath(input.tool, input)
    if (!raw) return
    const now = await clockNow($)
    if (now === undefined) return
    const windowMs = config.reworkWindowMinutes * 60_000
    const file = normalizePath(raw)
    let hitKey: string | undefined
    for (const [key, run] of [...reworkRuns]) {
      if (now - run.endedAt > windowMs) { reworkRuns.delete(key); continue }
      if (run.files.has(file) && (hitKey === undefined || run.endedAt >= reworkRuns.get(hitKey)!.endedAt)) hitKey = key
    }
    const run = hitKey === undefined ? undefined : reworkRuns.get(hitKey)
    if (!run || run.reworked) return
    run.reworked = true
    if (run.accepted === undefined) run.pending = true
    else {
      const was = run.accepted
      run.accepted = false
      await storeQueue(async () => {
        const stats = ((await $.store.get(STATS_KEY)) ?? {}) as Stats
        await $.store.set(STATS_KEY, recordRework(stats, run.category, run.tier, { now, halfLifeMs: halfLifeMs(), runAccepted: was, runAt: run.at }))
      })
      // A sampled review that lands later must not move the run to not accepted a second time.
      const rv = reviewRuns.get(hitKey!)
      if (rv?.accepted === true) rv.accepted = false
    }
    try { await $.ui.log(`${run.label}: lead reworked ${raw.split(/[\/]/).pop()}`) } catch { /* the note is best effort */ }
  } catch { /* the check must never disturb the lead */ }
}

async function flushReviews(): Promise<void> {
  while (pendingReviews.size > 0) await Promise.allSettled([...pendingReviews])
}

// End of a tracked agent's run: draws whether it is reviewed and, if so, queues the review in the background.
// Only runs that started below the reference tier, in active or observe mode, and that were not aborted. The
// edited files are taken for this run either way, so the next run of the same agent starts with none. Never throws.
function startReview($: EngineInterface, a: AgentState, turnId: unknown, aborted: boolean): void {
  try {
    const files = editedFiles.get(a.id) ?? []
    editedFiles.delete(a.id)
    if (!watching() || aborted || config.reviewRate <= 0 || !isCheaper(a.startTier, baseline)) return
    const key = runKey(a.id, turnId)
    if (!sampleRun(config.reviewRate, sessionTag, key)) return
    reviewRuns.set(key, {})
    if (reviewRuns.size > MAX_REVIEWED_RUNS) reviewRuns.delete(reviewRuns.keys().next().value as string)
    const p: Promise<void> = reviewQueue(() => reviewRun($, a, files, key))
      .catch(() => undefined)
      // Without a score there is nothing to wait for: the entry goes (with a score it stays until the run is recorded).
      .finally(() => { if (reviewRuns.get(key)?.score === undefined) reviewRuns.delete(key); pendingReviews.delete(p) })
    pendingReviews.add(p)
  } catch { /* the review is optional */ }
}

// The agent's diff for the review: limited to the files it edited when they are known and few enough, else the
// whole working tree. Empty when there is nothing to review or git cannot tell (missing, not a repository, no
// commit yet, timeout). Read only. Never throws.
async function reviewDiff($: EngineInterface, files: readonly string[]): Promise<{ diff: string; scoped: boolean }> {
  const scoped = files.length > 0 && files.length <= REVIEW_LIMITS.maxPaths
  try {
    const r = await $.process.run(diffArgv(scoped ? files : []), { timeoutMs: 10_000 })
    if (r.exitCode !== 0 || typeof r.stdout !== 'string') return { diff: '', scoped }
    // Capped twice: here so a huge diff is not carried around, and in the prompt with head and tail kept.
    return { diff: r.stdout.trim().slice(0, REVIEW_LIMITS.maxDiffChars * 4), scoped }
  } catch {
    return { diff: '', scoped }
  }
}

// One sampled review: the agent's diff and task to the review model with the rubric, its score recorded in the
// stats of the run's category and start tier, its cost in the ledger like a consult. A refused or unscored reply
// records nothing. Never throws.
async function reviewRun($: EngineInterface, a: AgentState, files: readonly string[], key: string): Promise<void> {
  try {
    const model = config.reviewModel || config.senior
    if (refusedSeniors.includes(tierOf(model))) return
    if (config.consultBudgetUsd > 0 && ledger.consultCost >= config.consultBudgetUsd) {
      try { await $.ui.log(`${agentLabel(a)} (${a.category}): review skipped: consult budget reached`, { to: 'debug' }) } catch { /* diagnostics only */ }
      return
    }
    const { diff, scoped } = await reviewDiff($, files)
    if (!diff) {
      try { await $.ui.log(`${agentLabel(a)} (${a.category}): review skipped: no diff`, { to: 'debug' }) } catch { /* diagnostics only */ }
      return
    }
    const prompt = buildReviewPrompt({ task: a.taskTitle ? `${a.taskTitle}\n\n${a.task}` : a.task, diff, scoped })
    let text = ''
    let why = 'no reply'
    try {
      // The engine answers { isAnswered, text, usage }; the published 2.1.277 types still say string.
      const reply = await $.model.complete({ model, system: REVIEW_SYSTEM, prompt, maxTokens: 400 }) as ModelReply
      text = typeof reply === 'string' ? reply : reply.isAnswered ? reply.text : ''
      if (typeof reply !== 'string' && !reply.isAnswered) {
        why = reply.reason ?? 'refused'
        // The model itself is unusable for this account: no review or consult asks it again this session.
        if (reply.reason === 'api-error' && isModelRefusal({ status: reply.status, error: reply.error })) refusedSeniors = refuseTier(refusedSeniors, tierOf(model))
      }
      const usage = typeof reply === 'string' ? undefined : asUsage(reply.usage)
      ledger = addConsult(ledger, { usage, promptChars: prompt.length + REVIEW_SYSTEM.length, replyChars: text.length }, tierOf(model), config)
      await save($)
    } catch (err) {
      why = String((err as { message?: unknown } | undefined)?.message ?? err).slice(0, 200)
    }
    const review = parseReview(text)
    if (!review) {
      try { await $.ui.log(`${agentLabel(a)} (${a.category}): review gave no score (${text ? 'no SCORE line' : why})`) } catch { /* best effort */ }
      return
    }
    await storeQueue(async () => {
      const stats = ((await $.store.get(STATS_KEY)) ?? {}) as Stats
      const now = await clockNow($)
      const e = reviewRuns.get(key)
      if (e?.accepted !== undefined) {
        // The run is recorded: a low score moves it to not accepted, and the entry has done its job.
        await $.store.set(STATS_KEY, recordReview(stats, a.category, a.startTier, review.score,
          { now, halfLifeMs: halfLifeMs(), runAccepted: e.accepted, runAt: e.at, minScore: config.minReviewScore }))
        reviewRuns.delete(key)
        // The review already moved the run to not accepted: a later rework only counts.
        const w = reworkRuns.get(key)
        if (w && e.accepted && review.score < config.minReviewScore) w.accepted = false
      } else {
        // The run is not recorded yet: its recording reads the score from the entry.
        await $.store.set(STATS_KEY, recordReview(stats, a.category, a.startTier, review.score, { now, halfLifeMs: halfLifeMs() }))
        reviewRuns.set(key, { score: review.score })
      }
    })
    try {
      const reasons = review.reasons.length > 0 ? `: ${review.reasons.join('; ')}` : ''
      await $.ui.log(`${agentLabel(a)} (${a.category}): review ${review.score}/5${reasons}`.slice(0, 600))
      if (review.score <= 2) await $.ui.toast(`${shortName(a)}: review ${review.score}/5`)
    } catch { /* the note is best effort */ }
  } catch { /* a failing review must never disturb the session */ }
}

// Last lines of a command's output, kept short: it goes to the lead's log, never back to the agent.
function outputTail(r: { stdout?: unknown; stderr?: unknown }): string {
  const text = `${typeof r.stdout === 'string' ? r.stdout : ''}\n${typeof r.stderr === 'string' ? r.stderr : ''}`
  const tail = text.trim().split('\n').slice(-5).join(' | ')
  return tail.length > 400 ? '...' + tail.slice(-400) : tail
}

// Runs the user's verification command (argv from the user's own option, never from agent output)
// in the session's working directory and records the run as accepted or not. Never throws.
async function verifyAndRecord($: EngineInterface, a: TrackedAgent, wasEscalated: boolean, argv: string[], key: string): Promise<void> {
  // Only a command that ran and exited non-zero is a failed verification. One that could not start or
  // outlived the timeout (the call rejects) says nothing about the agent: the run is recorded as if no
  // verification were configured, and the user is told once per session to check the option.
  let failed = false
  let unavailable = ''
  let detail = ''
  try {
    const r = await $.process.run(argv, { timeoutMs: config.verifyTimeoutSeconds * 1000 })
    if (typeof r.exitCode !== 'number') throw new Error('no exit code')
    failed = r.exitCode !== 0
    detail = `exit ${r.exitCode}: ${outputTail(r)}`
  } catch (err) {
    unavailable = String((err as { message?: unknown } | undefined)?.message ?? err).slice(0, 200)
  }
  try {
    if (unavailable) {
      await $.ui.log(`${agentLabel(a)} (${a.category}): verification could not run: ${unavailable}`)
      if (!unavailableToasted) {
        unavailableToasted = true
        await $.ui.toast('Verification could not run: check the verifyCommand option')
      }
    } else {
      await $.ui.log(`${agentLabel(a)} (${a.category}): verification ${failed ? 'failed' : 'passed'} (${detail})`)
      if (failed) await $.ui.toast(`${shortName(a)}: verification failed`)
    }
  } catch { /* the note is best effort */ }
  try { await recordOutcome($, a, wasEscalated, failed, key) } catch { /* best effort */ }
}

type ModelReply = string | { isAnswered: true; text: string; usage?: { output_tokens?: number } } | { isAnswered: false; reason?: string; status?: number | null; error?: string; usage?: { output_tokens?: number } }

const tag = (text: string): string => tagNote(sessionTag, text)

// The effort of a model request as the engine set it: a level of the scale, a number, or null when it has none.
// Read loosely: the published types of older engines do not declare the field.
function effortOf(e: TurnStepInput): Effort | number | null {
  try {
    const v = (e as { effort?: unknown }).effort
    if (typeof v === 'number' && Number.isFinite(v)) return v
    return EFFORTS.includes(v as Effort) ? (v as Effort) : null
  } catch {
    return null
  }
}

const labelOf = (action: Action): string => (action === 'effort' ? 'raise effort' : action)

// The refusal for a tool call of a paused agent (active mode only), or undefined when the call may go on.
// Report and communication tools (see PAUSE_ALLOWED_TOOLS) are never refused.
function pausedDeny(id: string | undefined, tool?: unknown): { deny: string } | undefined {
  try {
    if (mode !== 'active' || !id || !agents.get(id)?.paused || isPauseAllowedTool(tool)) return undefined
    return { deny: tag('You are paused by the supervisor until a human resumes you. Do not continue the task and do not retry this tool. ' +
      'Hand back your summary for the human now (what you tried and what blocks you) with your usual report tool, ' +
      'or reply in text, then stop.') }
  } catch {
    return undefined
  }
}

// `/escalator resume <id>|all`: clears the pause and restarts the ladder of the agent on its current tier.
async function resumeCommand($: EngineInterface, target: string): Promise<string> {
  try {
    if (!target) return 'Usage: /escalator resume <agentId>|all'
    const paused = [...agents.values()].filter((a) => a.paused)
    const chosen = target === 'all' ? paused : paused.filter((a) => a.id === target)
    if (chosen.length === 0) {
      return target !== 'all' && agents.has(target) ? `Agent ${target} is not paused.` : `No paused agent${target === 'all' ? '' : ` with id ${target}`}.`
    }
    const now = await clockNow($)
    for (const a of chosen) agents.set(a.id, resumeAgent(a, now))
    await save($)
    const lines = chosen.map((a) => `${agentLabel(a)} (${a.category}, ${a.tier})`)
    for (const a of chosen) {
      try { await $.ui.log(`${agentLabel(a)} (${a.category}): resumed by the user, ladder restarted on ${a.tier}`) } catch { /* best effort */ }
    }
    try { await $.ui.status(statusLine(ledger)) } catch { /* best effort */ }
    return `Resumed ${chosen.length === 1 ? 'agent' : 'agents'}: ${lines.join(', ')}. The ladder restarts on the current tier.\n` +
      'If an agent already ended its turn, send it a message (for instance ask the lead to message it) to make it continue: the mod cannot wake it.'
  } catch {
    return 'Could not resume the agent.'
  }
}

async function act($: EngineInterface, s: AgentState, action: Action): Promise<string> {
  const raised = action === 'effort' ? raiseEffort(s.effortSeen, config.effortBoost) : undefined
  await $.ui.log(`${agentLabel(s)} (${s.category}): ${labelOf(action)}${raised ? ` to ${raised}` : ''}`)
  switch (action) {
    case 'nudge':
      return tag('You are not making progress. Pause: re-read the last error or result in full, ' +
        'state one new hypothesis, then continue with a different approach.')
    case 'consult':
      return consult($, s)
    case 'effort':
      return tag(`From your next step you think harder (effort ${raised ?? 'raised'}) on the same model. ` +
        'Re-assess the problem from scratch: question your assumptions before you continue.')
    case 'swap':
      await $.ui.toast(`${shortName(s)}: switched to ${s.tier}`)
      return tag(`From your next step you run on a stronger model (${s.tier}). Re-assess the problem from scratch.`)
    case 'human':
      await $.ui.toast(`${shortName(s)}: needs a human` + (config.pauseAtHuman ? ` (paused: /escalator resume ${s.id})` : ''))
      await $.ui.status(`stuck: ${shortName(s)} (${s.id})`)
      return tag('Stop now. Do not continue the task: summarize what you tried and what blocks you, hand back the summary with your usual report tool, then stop so a human can step in.' +
        (config.pauseAtHuman ? ' Your other tool calls are refused until the user resumes you with /escalator resume.' : ''))
  }
}

const RETRY_DOSSIER_LIMITS = { maxChars: 6000, maxAttempts: 5, maxErrorChars: 700, maxDiffChars: 700, maxExtraChars: 800 }

// `git diff --stat` in the session folder, read only, for the dossier. Empty when git is missing, the
// folder is not a repository, the command fails or times out. Never throws.
async function gitDiffStat($: EngineInterface): Promise<string> {
  try {
    const r = await $.process.run(['git', 'diff', '--stat'], { timeoutMs: 5000 })
    if (r.exitCode !== 0) return ''
    return typeof r.stdout === 'string' ? r.stdout.trim().slice(0, 4000) : ''
  } catch {
    return ''
  }
}

// Asks the senior model about the agent and returns the tagged note for it. `extra` is the agent's own
// account of the problem (help tool), shown to the senior as the agent notes. Falls back to a generic
// note without advice.
async function consult($: EngineInterface, s: AgentState, extra = ''): Promise<string> {
  // One consult action, counted before the calls so a refused call and its retry make one.
  const counted = agents.get(s.id)
  if (counted) agents.set(s.id, { ...counted, consults: (counted.consults ?? 0) + 1 })
  const diffStat = await gitDiffStat($)
  // A senior the account refused (not allowed, unknown) is skipped for the rest of the session.
  const first = pickSenior(config.senior, refusedSeniors)
  let advice = first ? await askSenior($, first, buildDossier(inputFromState(s, { diffStat, extra })), s.id) : ''
  const second = first ? otherSenior(first) : undefined
  if (!advice && second && !refusedSeniors.includes(tierOf(second))) {
    // A refusal (often the safety classifier) is intermittent and model dependent: one retry on the other
    // senior model, with a tighter dossier (same diff stat, git is not run again).
    advice = await askSenior($, second, buildDossier(inputFromState(s, { diffStat, extra }), RETRY_DOSSIER_LIMITS), s.id)
  }
  if (!advice) {
    try {
      await $.ui.log(`${agentLabel(s)} (${s.category}): consult refused twice`, { to: 'debug' })
      await $.ui.log(`${agentLabel(s)} (${s.category}): consult refused twice`)
    } catch { /* diagnostics only */ }
    // Nothing was given to the agent: the next ladder step must not wait a full grace window.
    const cur = agents.get(s.id)
    if (cur) agents.set(s.id, skipGrace(cur, config))
    return tag('Still stuck. List three different hypotheses and test the cheapest one first.')
  }
  return tag(`Advice from a senior model:
${advice}`)
}

// One senior call, recorded in the ledger. Returns the advice, or '' when the model gave none. Never throws.
async function askSenior($: EngineInterface, model: string, prompt: string, agentId: string): Promise<string> {
  try {
    // The engine answers { isAnswered, text, usage }; the published 2.1.277 types (used by CI)
    // still say string, hence the wider local type.
    const reply = await $.model.complete({ model, system: SENIOR_SYSTEM, prompt, maxTokens: 2000 }) as ModelReply
    const advice = typeof reply === 'string' ? reply : reply.isAnswered ? reply.text : ''
    if (!advice) {
      try {
        const r = typeof reply === 'string' ? undefined : reply
        const why = r && !r.isAnswered ? `reason=${r.reason ?? 'unknown'} status=${r.status ?? '-'} error=${r.error ?? '-'}` : 'reason=empty-text'
        await $.ui.log(`senior consult (${model}) gave no advice: ${why} output_tokens=${r?.usage?.output_tokens ?? '-'}`, { to: 'debug' })
      } catch { /* diagnostics only */ }
      // The model itself is unusable for this account: never ask it again this session.
      if (typeof reply !== 'string' && !reply.isAnswered && reply.reason === 'api-error' && isModelRefusal({ status: reply.status, error: reply.error })) {
        refusedSeniors = refuseTier(refusedSeniors, tierOf(model))
        try { await $.ui.log(`senior model ${model} is not available: skipped for the rest of the session`) } catch { /* diagnostics only */ }
      }
    }
    const usage = typeof reply === 'string' ? undefined : asUsage(reply.usage)
    const before = ledger.consultCost
    ledger = addConsult(ledger, { usage, promptChars: prompt.length + SENIOR_SYSTEM.length, replyChars: advice.length }, tierOf(model), config)
    // The consult is part of the asking agent's run (unlike a review, which only measures it).
    const owner = agents.get(agentId)
    if (owner) agents.set(agentId, { ...owner, runCost: (owner.runCost ?? 0) + (ledger.consultCost - before) })
    return advice
  } catch {
    return ''
  }
}

const clip = (v: unknown, n: number): string => (typeof v === 'string' ? v.trim().slice(0, n) : '')

// Answers a call of the help tool. Never throws: the agent always gets a text back.
async function handleHelp($: EngineInterface, input: Record<string, unknown>, id: string | undefined): Promise<string> {
  try {
    const a = id ? agents.get(id) : undefined
    if (!id || !a || mode === 'off' || mode === 'baseline') return 'Help is not available for this agent.'
    if (mode === 'observe') {
      await $.ui.log(`${agentLabel(a)} (${a.category}): would consult (asked for help)`)
      ledger = addIntervention(ledger, 'ask')
      await save($)
      return 'Request noted.'
    }
    if (!canAskForHelp(a, config)) return tag('You already consulted a senior model a moment ago: try that advice first.')
    const limit = limitFor(a)
    if (limit) {
      await noteLimit($, a, limit)
      return tag(`No further senior consult is available for you (${limit}). Do not ask for help again: try a different approach, ` +
        'make one small change you can check, or stop and summarize what you tried.')
    }
    // Count the call and move the ladder before the (slow) model call, so a second call cannot slip in.
    agents.set(id, afterHelp(a, config))
    ledger = addIntervention(ledger, 'ask')
    await $.ui.log(`${agentLabel(a)} (${a.category}): asked for help`)
    const problem = clip(input.problem, 2000)
    const tried = clip(input.tried, 2000)
    const extra = `Problem: ${problem || '(not given)'}` + (tried ? `
What it tried: ${tried}` : '')
    const note = await consult($, agents.get(id) ?? a, extra)
    await save($)
    return note
  } catch {
    return 'Help is not available right now.'
  }
}
