import type { EngineInterface, HookStream, Register, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'
import { newTag, tagNote, withAnnouncement } from './channel'
import { DEFAULT_CONFIG, describeConfig, parseConfig, splitCommand, type Config } from './config'
import { LADDER, afterHelp, agentHead, agentLabel, allowedMax, nextTier, canAskForHelp, classifyFailure, clipLabel, consultLimit, countStep, EFFORTS, escalated, isModelRefusal, isPauseAllowedTool, isSilent, leadMessage, markStall, MAX_AGENT_NAME, MAX_LEAD_NOTICES, newAgent, noteProgress, normalizePath, observe, otherSenior, pauseAgent, pickSenior, raiseEffort, refuseTier, rememberModel, resolveModelId, resumeAgent, revertSwap, skipGrace, taskClaim, taskOfResult, tierOf, toolEnd, toolStart, touch, usableTier, type Action, type AgentState, type Effort, type LeadEvent, type ModelFailure, type ObservedModels, type Tier } from './detector'
import { buildDossier, inputFromState } from './dossier'
import { cacheGet, cachePut, cacheKey, classifierInput, combineCategory, LABELS, parseCache } from './classify'
import { categorize, costPerAccepted, formatStats, isAccepted, mulberry32, parseProjects, projectKey, recommendScopedWithExploration, recordReviewScoped, recordReworkScoped, recordScoped, scopedStats, type Projects, type Stats } from './learning'
import { emptyGraph, LEAD_ID, reduce, SENIOR_ID, type GraphInput, type GraphState } from './graph'
import { layoutGraph, type LayoutMemory } from './layout'
import { renderSvg } from './render-svg'
import { renderTree } from './render-text'
import { createQueue } from './queue'
import { buildDetail, consultGate, findAgent, selectorChips, swapGate } from './node-detail'
import { buildStatsView, columnWidths, fitView, type ViewCell } from './stats-view'
import { buildReviewPrompt, diffArgv, editedPath, formatReviews, isCheaper, parseReview, REVIEW_LIMITS, REVIEW_SYSTEM, sampleRun } from './review'
import { parseSnapshot, type Snapshot, type TrackedAgent } from './state'
import { addAgent, addConsult, addEscalation, addIntervention, addStep, asUsage, cost as stepCost, emptyLedger, planBlock, report, reportByCategory, savings, statusLine, type Ledger, type Usage } from './savings'

export const HELP_TOOL = 'mcp__model-escalator__ask_for_help'
const STATS_KEY = 'stats'
const PROJECTS_KEY = 'projects'
const SESSIONS_KEY = 'sessions'
const CATEGORIES_KEY = 'categories'
const CATEGORY_CACHE_MAX = 200
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

// The agent network of the map (`/escalator map`). Fed by pure reducers from the hooks, kept in the session snapshot.
export const MAP_PANE = 'escalator-map'
const REDRAW_MS = 250      // one redraw check per tick: at most four redraws a second
const SETTLE_MS = 4500     // quiet this long after the last change: one last redraw, so the animations stop
let graph: GraphState = emptyGraph('opus')
let layoutMem: LayoutMemory | undefined
let drawnSeq = 0           // the last graph event a draw showed: later ones animate
let mapDirty = false       // the graph changed since the last redraw request
let mapSettled = true      // the quiet redraw after the last change was requested
let mapChangedAt = 0
let mapTimer: { cancel: () => void } | undefined
// The terminal tree. The spinner frame advances on the redraw tick while the pane is open on the terminal and
// some agent works (a Client module with a frame clock would need its own file; this reuses the existing tick).
// Recent-event suffixes stay visible for TEXT_RECENT_MS after they are first drawn: events above `textSeq` are
// "recent", and `textPendingSeq` becomes the new `textSeq` once the window that started at `textPendingAt` ends.
const TEXT_RECENT_MS = 3000
const TEXT_WIDTH = 80
let terminalOpen = false

// The map's node detail. The agent a person selected (buttons next to the drawing), the result of the last action on
// it, and the notes an action queued for an agent: a note travels with the agent's next tool result, like a ladder note.
let selectedId: string | undefined
let actionNote: string | undefined
const pendingNotes = new Map<string, string[]>()
const MAX_PENDING_NOTES = 3
// Agents with a "consult now" in flight: a second press waits for the first.
const consulting = new Set<string>()

// The statistics panel (`/escalator panel`). Its own tick, only while the pane is open: once a second it compares a
// signature of what the panel shows (ledger, mode, paused agents, learned stats) and asks for a redraw if it changed.
export const STATS_PANE = 'escalator-stats'
const STATS_REDRAW_MS = 1000
let statsTimer: { cancel: () => void } | undefined
let statsDirty = false     // the pane was just opened: draw once on the first tick
let statsSig = ''          // what the last tick saw
let textFrame = 0
let textSeq = 0
let textPendingSeq = 0
let textPendingAt: number | undefined

type GraphFeed = GraphInput extends infer I ? (I extends GraphInput ? Omit<I, 'at'> : never) : never

// True when two graphs would draw the same picture (the reducers hand back new objects for unchanged values).
function sameGraph(a: GraphState, b: GraphState): boolean {
  if (a === b) return true
  if (a.seq !== b.seq || a.collapsed !== b.collapsed || a.dropped !== b.dropped) return false
  if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false
  return a.nodes.every((n, i) => {
    const m = b.nodes[i]
    return m !== undefined && (Object.keys(n) as (keyof typeof n)[]).every((k) => n[k] === m[k])
  })
}

// Applies one input record to the graph. Pure reducer, no waiting: the draw happens later, on the redraw tick.
// The time is the latest read of the host clock; the read it starts is not awaited. Never throws.
function feed($: EngineInterface, input: GraphFeed): void {
  try {
    if (mode === 'off') return
    const at = lastNow ?? 0
    void clockNow($)
    const next = reduce(graph, { ...input, at } as GraphInput)
    if (sameGraph(graph, next)) return
    graph = next
    mapDirty = true
    mapSettled = false
    mapChangedAt = at
  } catch { /* the map is optional */ }
}

// Draws the map again once the graph changed, one tick at a time: hooks only mark the graph changed.
async function mapTick($: EngineInterface): Promise<void> {
  try {
    const now = (await clockNow($)) ?? mapChangedAt
    let redraw = false
    if (mapDirty) { mapDirty = false; redraw = true }
    else if (!mapSettled && now - mapChangedAt >= SETTLE_MS) { mapSettled = true; redraw = true }
    if (terminalOpen) {
      if (graph.nodes.some((n) => n.kind !== 'lead' && n.status === 'active')) { textFrame = (textFrame + 1) % 1_000_000; redraw = true }
      if (textPendingAt !== undefined && now - textPendingAt >= TEXT_RECENT_MS) {
        textSeq = textPendingSeq
        textPendingAt = undefined
        redraw = true
      }
    }
    if (redraw) $.ui.invalidate('ui.render')
  } catch { /* a missed redraw is drawn on the next change */ }
}

function startMapTimer($: EngineInterface): void {
  if (mapTimer) return
  try { mapTimer = $.clock.every(REDRAW_MS, () => { void mapTick($) }) } catch { /* the pane still draws on open */ }
}

function stopMapTimer(): void {
  mapTimer?.cancel()
  mapTimer = undefined
}

// What the statistics panel shows, as one string: a change of it means a redraw.
async function statsSignature($: EngineInterface): Promise<string> {
  let learned: unknown
  try { learned = await $.store.get(STATS_KEY) } catch { learned = undefined }
  return JSON.stringify([mode, baseline, ledger, [...agents.values()].filter((a) => a.paused).map((a) => a.id), learned])
}

async function statsTick($: EngineInterface): Promise<void> {
  try {
    const sig = await statsSignature($)
    if (statsDirty || sig !== statsSig) { statsDirty = false; statsSig = sig; $.ui.invalidate('ui.render') }
  } catch { /* a missed redraw is drawn on the next change */ }
}

function startStatsTimer($: EngineInterface): void {
  if (statsTimer) return
  try { statsTimer = $.clock.every(STATS_REDRAW_MS, () => { void statsTick($) }) } catch { /* the pane still draws on open */ }
}

function stopStatsTimer(): void {
  statsTimer?.cancel()
  statsTimer = undefined
}

// Hash of the session's working directory, the key of its per-project statistics ('' when unknown). Never the path.
let projectId = ''

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
  projectId = ''
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
  stopMapTimer()
  stopStatsTimer()
  statsDirty = false
  statsSig = ''
  graph = emptyGraph('opus')
  layoutMem = undefined
  drawnSeq = 0
  mapDirty = false
  mapSettled = true
  mapChangedAt = 0
  terminalOpen = false
  selectedId = undefined
  actionNote = undefined
  pendingNotes.clear()
  consulting.clear()
  textFrame = 0
  textSeq = 0
  textPendingSeq = 0
  textPendingAt = undefined
  reviewQueue = createQueue()
  pendingReviews.clear()
  editedFiles.clear()
  reviewRuns.clear()
  writtenFiles.clear()
  reworkRuns.clear()
  lastNow = undefined
}

function snapshot(): Snapshot {
  return {
    agents: [...agents.values()], ledger, seenModels, sessionTag, mode, baseline, baselinePinned, blockedTiers, refusedSeniors,
    graph, ...(layoutMem ? { layout: layoutMem } : {}), drawnSeq,
  }
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

// The task category of a spawn: the keyword one, or with `modelCategories` the label a small model gave (cached in the
// store by a key that ignores case and punctuation). Any failure falls back to the keywords; never throws.
async function taskCategory($: EngineInterface, e: { subagentType?: string; description?: string; prompt?: string }): Promise<string> {
  const type = e.subagentType ?? ''
  const description = e.description ?? ''
  const fallback = categorize(type, description)
  if (!config.modelCategories || mode === 'off' || mode === 'baseline') return fallback
  try {
    const key = cacheKey(type, description, e.prompt ?? '')
    if (key === '') return fallback
    const hit = cacheGet(parseCache(await $.store.get(CATEGORIES_KEY)), key)
    let label = hit.label
    if (label !== undefined) {
      await storeQueue(async () => {
        const fresh = cacheGet(parseCache(await $.store.get(CATEGORIES_KEY)), key)
        if (fresh.label !== undefined) await $.store.set(CATEGORIES_KEY, fresh.cache)
      })
    } else {
      try { label = await $.model.classify(classifierInput(type, description, e.prompt ?? ''), LABELS, { model: 'haiku' }) } catch { label = undefined }
      if (typeof label === 'string') {
        const l = label.trim().toLowerCase()
        if (!LABELS.includes(l)) label = undefined
        else {
          label = l
          await storeQueue(async () => {
            await $.store.set(CATEGORIES_KEY, cachePut(parseCache(await $.store.get(CATEGORIES_KEY)), key, l, CATEGORY_CACHE_MAX))
          })
        }
      } else label = undefined
    }
    // 'other' from the classifier does not override a specific keyword category.
    if (label === 'other' && !fallback.endsWith(':other')) return fallback
    return combineCategory(type, label, fallback)
  } catch {
    return fallback
  }
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
      graph = saved.graph ?? emptyGraph(baseline)
      layoutMem = saved.layout
      drawnSeq = saved.drawnSeq ?? 0
      // A map pane left open across the reload keeps being redrawn.
      try {
        const open = await $.ui.panes()
        if (open.some((p) => p.id === MAP_PANE)) { mapDirty = true; startMapTimer($) }
        if (open.some((p) => p.id === STATS_PANE)) { statsDirty = true; startStatsTimer($) }
      } catch { /* no pane list: the map redraws when it is opened again */ }
    } else {
      graph = emptyGraph(baseline)
      layoutMem = undefined
      drawnSeq = 0
      stopMapTimer()
      stopStatsTimer()
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
    try { projectId = projectKey((r as { cwd?: unknown } | undefined)?.cwd) } catch { projectId = '' }
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
      await $.command.register({ name: 'escalator', description: 'Model escalator: savings report, stats panel and the live agent network', argumentHint: '[report|stats|config|history [n]|map|panel [close]|consult <id>|swap <id>|reset [history]|resume <id>|all|help]' })
    } catch { /* name taken: the report stays reachable through the status line */ }
    return r
  })

  on('command.run', { command: 'escalator' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'help') return { text: COMMAND_HELP }
    if (arg === 'config') return { text: await configCommand($) }
    if (arg === 'history' || arg.startsWith('history ')) return { text: await historyCommand($, arg.slice(7).trim()) }
    if (arg === 'stats') {
      const stats = ((await $.store.get(STATS_KEY)) ?? {}) as Stats
      const reviews = formatReviews(stats)
      // This session's savings per category go here, not in the report: the report's request counts stay one table.
      const byCategory = ledger.byCategory && Object.keys(ledger.byCategory).length > 0 ? '\n\n' + reportByCategory(ledger, baseline) : ''
      return { text: 'Learned stats per category (runs / escalated):\n' + formatStats(stats, await clockNow($), halfLifeMs()) +
        (reviews ? '\n\nSenior review scores of sampled runs (1-5):\n' + reviews : '') + byCategory }
    }
    if (arg === 'reset') {
      // The category cache is kept: it maps task text to a label, which is a fact about the text, not something learned
      // from outcomes, and clearing it would only cost new classification calls.
      await storeQueue(async () => { await $.store.delete(STATS_KEY); await $.store.delete(PROJECTS_KEY) })
      return { text: 'Learned stats cleared (per-category and per-project statistics). The session history and the task category cache are kept.' }
    }
    if (arg === 'reset history') {
      await storeQueue(async () => { await $.store.delete(SESSIONS_KEY) })
      return { text: 'Session history cleared. Learned stats are kept.' }
    }
    if (arg === 'resume' || arg.startsWith('resume ')) return { text: await resumeCommand($, arg.slice(6).trim()) }
    if (arg === 'consult' || arg.startsWith('consult ')) return { text: await consultNow($, arg.slice(7)) }
    if (arg === 'swap' || arg.startsWith('swap ')) return { text: await swapNow($, arg.slice(4)) }
    if (arg === 'map') return { text: await openMap($) }
    if (arg === 'panel') return { text: await openStatsPanel($) }
    if (arg === 'panel close') return { text: await closeStatsPanel($) }
    if (arg !== '' && arg !== 'report') return { text: `Unknown subcommand "${arg.split(/\s+/)[0]}".\n\n${COMMAND_HELP}` }
    const paused = [...agents.values()].filter((a) => a.paused)
    // On a subscription the engine reports the plan windows; on API billing there are none and the block is left out.
    const plan = await readPlan($)
    const planText = plan ? '\n\n' + plan : ''
    const pausedText = paused.length === 0 ? '' : '\n\nPaused (resume with /escalator resume <id>|all):\n' +
      paused.map((a) => `- ${agentLabel(a)} (${a.category}, ${a.tier})`).join('\n')
    return { text: `Mode: ${mode}\n` + report(ledger, baseline) + planText + pausedText +
      '\n\nMore: /escalator stats, /escalator map (live agent network), /escalator history, /escalator config, /escalator help' }
  })

  // The map pane. Desktop, VS Code and mobile draw an interactive Svg; the terminal a short text for now.
  on('ui.render', { component: 'Pane', requestId: MAP_PANE }, async ($, e, next) => {
    try {
      const now = (await clockNow($)) ?? lastNow ?? 0
      const g = graph
      const layout = layoutGraph(g, layoutMem)
      layoutMem = { slots: layout.slots, retired: layout.retired }
      const workers = g.nodes.filter((n) => n.kind === 'worker').length
      const alt = `Agent network: ${workers} worker${workers === 1 ? '' : 's'}${g.nodes.some((n) => n.id === SENIOR_ID) ? ', a senior' : ''}`
      let out
      if (e.surface === 'terminal') {
        const { Box, Text, Button } = $.ui.resolve(e)
        terminalOpen = true
        if (textPendingAt !== undefined && now - textPendingAt >= TEXT_RECENT_MS) { textSeq = textPendingSeq; textPendingAt = undefined }
        if (g.seq > textSeq && textPendingAt === undefined) { textPendingSeq = g.seq; textPendingAt = now }
        const cols = Number((e.props as { bodyColumns?: unknown } | undefined)?.bodyColumns)
        const width = Number.isFinite(cols) && cols >= 1 ? Math.floor(cols) : TEXT_WIDTH
        const lines = renderTree(g, layout, { frame: textFrame, width, lastSeq: textSeq })
        const rows = lines.map((line) => Box({
          flexDirection: 'row',
          children: line.map((s) => Text({
            ...(s.color ? { color: s.color } : {}), ...(s.bold ? { bold: true } : {}), ...(s.dim ? { dimColor: true } : {}),
            children: s.text,
          })),
        }))
        const panel = nodePanel($, { Box, Text, Button } as UiKit, true)
        out = Box({ flexDirection: 'column', children: panel ? [...rows, panel] : rows })
      } else {
        const { Svg, Box, Text, Button } = $.ui.resolve(e)
        const svg = Svg({ source: renderSvg(g, layout, { lastSeq: drawnSeq, now }), alt, isInteractive: true })
        drawnSeq = g.seq
        const panel = nodePanel($, { Box, Text, Button } as UiKit, false)
        out = panel ? Box({ flexDirection: 'column', gap: 1, children: [svg, panel] }) : svg
      }
      void save($)
      return out
    } catch {
      return next(e)
    }
  })

  // The statistics panel: the same content on every surface, as Box and Text (terminal, desktop, VS Code and mobile
  // all have both). The view is built and fitted in stats-view.ts; this only maps it to elements.
  on('ui.render', { component: 'Pane', requestId: STATS_PANE }, async ($, e, next) => {
    try {
      const { Box, Text } = $.ui.resolve(e)
      const stats = ((await $.store.get(STATS_KEY)) ?? {}) as Stats
      const view = buildStatsView({
        mode, baseline, ledger, stats, plan: await readPlan($), now: await clockNow($), halfLifeMs: halfLifeMs(),
        paused: [...agents.values()].filter((a) => a.paused).map((a) => `${agentLabel(a)} (${a.category}, ${a.tier})`),
      })
      const text = (c: ViewCell) => Text({ ...(c.bold ? { bold: true } : {}), ...(c.dim ? { dimColor: true } : {}), wrap: 'truncate-end', children: c.text })
      const terminal = e.surface === 'terminal'
      const cols = Number((e.props as { bodyColumns?: unknown } | undefined)?.bodyColumns)
      const width = Number.isFinite(cols) && cols >= 1 ? Math.floor(cols) : TEXT_WIDTH
      // The terminal pads the text itself; the other surfaces give each column a width in characters.
      const shown = terminal ? fitView(view, width) : view
      const out = Box({
        flexDirection: 'column', gap: 1,
        children: shown.sections.map((s) => {
          const widths = terminal ? [] : columnWidths(s.rows)
          return Box({
            flexDirection: 'column',
            children: [
              Text({ bold: true, children: s.title }),
              ...s.rows.map((r) => Box({
                flexDirection: 'row', gap: 2,
                children: r.map((c, k) => (terminal || r.length === 1 ? text(c) : Box({ width: widths[k] ?? 0, children: text(c) }))),
              })),
            ],
          })
        }),
      })
      statsSig = await statsSignature($)
      return out
    } catch {
      return next(e)
    }
  })

  // Closing a pane stops its redraw ticks.
  on('ui.close', async ($, e, next) => {
    const r = await next(e)
    try { if (e.id === MAP_PANE) { stopMapTimer(); terminalOpen = false } } catch { /* best effort */ }
    try { if (e.id === STATS_PANE) stopStatsTimer() } catch { /* best effort */ }
    return r
  })

  // 1. Spawn: remember the agent, and let history (or baseline mode) pick the model.
  // (The map is fed from here, from the tool, step, complete and ladder paths below, and from the helpers.)
  on('agent.spawn', async ($, e, next) => {
    if (mode === 'off') return next(e)
    // A fork inherits the parent's model and context: it is never rewritten, announced or tracked.
    if (isFork(e)) return next(e)
    let ev = e
    const category = await taskCategory($, e)
    try {
      const asked = tierOf(e.model ?? e.parentModel)
      // `model` is what the Agent call asked for; when it is absent the agent definition or the parent decides, and
      // the types give no way to tell those two apart: only a present `model` counts as an explicit choice.
      const explicit = config.respectExplicitModel && mode !== 'baseline' && typeof e.model === 'string' && e.model !== ''
      const stats = ((await $.store.get(STATS_KEY)) ?? {}) as Stats
      const projects = parseProjects(await $.store.get(PROJECTS_KEY))
      const choice = mode === 'baseline'
        ? { tier: baseline, reason: 'requested' as const, learned: baseline }
        : recommendScopedWithExploration(stats, projects, projectId, category, asked, {
          now: await clockNow($), halfLifeMs: halfLifeMs(), explore: config.explore, byCost: config.learnByCost,
          ...(config.explore > 0 && !explicit ? { rand: explorationRandom() } : {}),
        })
      // In observe mode the model stays as asked: exploring is only logged, the learned tier is what "would" happen.
      const exploring = !explicit && choice.reason === 'explore'
      const best = explicit ? asked : exploring && mode === 'observe' ? choice.learned : choice.tier
      const label = clipLabel(e.name, MAX_AGENT_NAME) ?? category
      if (best !== asked) {
        if (mode !== 'observe') ev = { ...e, model: best }
        await $.ui.log(`${label}: ${asked} -> ${best}${mode === 'observe' ? ' (would)' : ''}`)
      }
      if (explicit && choice.learned !== asked) await $.ui.log(`${label}: kept the requested ${asked} (explicit), learning suggested ${choice.learned}`)
      if (!explicit && choice.basis === 'cost') await $.ui.log(`${label}: chosen by cost per accepted run (${costLine(scopedStats(stats, projects, projectId, category, await clockNow($), halfLifeMs()), category, asked, await clockNow($))})`)
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
      ledger = addAgent(ledger, category)
      if (watching()) mark(r.agentId, await clockNow($))
      feed($, { type: 'spawn', agentId: r.agentId, label: name ?? category, model: String(r.model ?? '') })
      await save($)
    }
    return r
  })

  // The help tool: a tracked agent asks for the senior consult directly. Answered here, never passed on.
  on('tool.call', { tool: HELP_TOOL as never }, async ($, e) => {
    const ev = e as unknown as Record<string, unknown>
    const stop = pausedDeny(typeof ev.agentId === 'string' ? ev.agentId : undefined, ev.tool)
    if (stop) return stop as never
    const helper = typeof ev.agentId === 'string' ? ev.agentId : undefined
    feed($, { type: 'tool-start', ...(helper ? { agentId: helper } : {}), tool: 'ask_for_help' })
    const text = await handleHelp($, ev, helper)
    feed($, { type: 'tool-end', ...(helper ? { agentId: helper } : {}), tool: 'ask_for_help' })
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
    const who = id ? { agentId: id } : {}
    feed($, { type: 'tool-start', ...who, tool: String(e.tool), summary: summarize(e as unknown as Record<string, unknown>) })
    let r: Awaited<ReturnType<typeof next>>
    try {
      r = await next(e)
    } catch (err) {
      feed($, { type: 'tool-end', ...who, tool: String(e.tool) })
      if (tracked) mark(id, await clockNow($), toolEnd)
      throw err
    }
    feed($, { type: 'tool-end', ...who, tool: String(e.tool) })
    if (tracked) mark(id, await clockNow($), toolEnd)
    // What a "consult now" or "swap now" queued for this agent goes out with its next tool result.
    if (tracked && r.deny === undefined) {
      const queued = takeNotes(id)
      if (queued.length > 0) r = { ...r, context: [...(r.context ?? []), ...queued] } as typeof r
    }
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
        if (back.decided && mode === 'active') feed($, { type: 'ladder', agentId: id, action: 'swap', toModel: back.state.tier, level: back.state.level, score: back.state.score })
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
      // A consult reaches the map through consult() itself, with the senior's side of it.
      if (action !== 'consult') {
        feed($, { type: 'ladder', agentId: id, action, ...(action === 'swap' ? { toModel: state.tier } : {}), level: state.level, score: state.score })
        if (action === 'human' && config.pauseAtHuman) feed($, { type: 'pause', agentId: id })
      }
      const note = await act($, state, action)
      // The first swap of an agent counts once as an escalation of its category (the flag outlives its runs, like the agent count).
      if (action === 'swap') {
        const cur: TrackedAgent = agents.get(id) ?? state
        if (cur.escCounted !== true) {
          ledger = addEscalation(ledger, cur.category)
          agents.set(id, { ...cur, escCounted: true })
        }
      }
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
      feed($, { type: 'ladder', agentId: a.id, action: 'swap', toModel: a.tier, level: a.level, score: a.score })
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
      ledger = addStep(ledger, r.usage as Usage, tierOf(r.usage.model), baseline, Boolean(e.agentId), config, e.agentId ? agents.get(e.agentId)?.category : undefined)
      // The request's own cost, on the model it ran on, for the map (the lead's cache writes live for an hour).
      const u = asUsage(r.usage)
      feed($, {
        type: 'step', ...(e.agentId ? { agentId: e.agentId } : {}), model: String(r.usage.model ?? e.model),
        cost: u ? stepCost(u, config.prices[tierOf(r.usage.model)], e.agentId ? '5m' : '1h') : 0,
      })
    }
    await save($)
    return r
  })

  // 4. End of an agent's run: learn from it and refresh the running report.
  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    const a = id ? agents.get(id) : undefined
    feed($, { type: 'complete', ...(id ? { agentId: id } : {}) })
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
    if (a.tier !== ok) {
      const back = revertSwap(a, ok, config)
      agents.set(aid, back)
      feed($, { type: 'ladder', agentId: aid, action: 'swap', toModel: back.tier, level: back.level, score: back.score })
    }
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
    feed($, { type: 'notice', agentId: a.id })
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
      feed($, { type: 'stall', agentId: id })
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

// The global table and the per-project tables from the store. Call inside storeQueue for a read-modify-write.
async function readStats($: EngineInterface): Promise<{ stats: Stats; projects: Projects }> {
  return { stats: ((await $.store.get(STATS_KEY)) ?? {}) as Stats, projects: parseProjects(await $.store.get(PROJECTS_KEY)) }
}

// Writes both tables in one go (the caller holds the store queue). The project table is only written when it exists
// or when this write added to it, so a session with no known project leaves the key alone.
async function writeStats($: EngineInterface, s: { stats: Stats; projects: Projects }): Promise<void> {
  await $.store.set(STATS_KEY, s.stats)
  if (Object.keys(s.projects).length > 0) await $.store.set(PROJECTS_KEY, s.projects)
}

// Records one finished run: its cost (the agent's requests and consults of the run, not the review), and whether it
// was accepted. A review that already landed counts in the acceptance here; one that has not is told how the run
// was counted (see reviewRun), so a late low score moves the run to not accepted exactly once.
async function recordOutcome($: EngineInterface, a: TrackedAgent, wasEscalated: boolean, verifyFailed: boolean, key: string): Promise<void> {
  await storeQueue(async () => {
    const { stats, projects } = await readStats($)
    const now = await clockNow($)
    const e = reviewRuns.get(key)
    let next = recordScoped(stats, projects, projectId, a.category, a.startTier, wasEscalated, 0, verifyFailed, now, halfLifeMs(),
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
        next = recordReworkScoped(next.stats, next.projects, projectId, a.category, a.startTier, { now, halfLifeMs: halfLifeMs(), runAccepted: accepted, runAt: now })
      }
    }
    if (e?.score !== undefined) reviewRuns.delete(key)
    else if (e) reviewRuns.set(key, { accepted: accepted && !reworkedEarly, ...(now !== undefined ? { at: now } : {}) })
    await writeStats($, next)
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
        const { stats, projects } = await readStats($)
        await writeStats($, recordReworkScoped(stats, projects, projectId, run.category, run.tier, { now, halfLifeMs: halfLifeMs(), runAccepted: was, runAt: run.at }))
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
      ledger = addConsult(ledger, { usage, promptChars: prompt.length + REVIEW_SYSTEM.length, replyChars: text.length }, tierOf(model), config, a.category)
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
      const { stats, projects } = await readStats($)
      const now = await clockNow($)
      const e = reviewRuns.get(key)
      if (e?.accepted !== undefined) {
        // The run is recorded: a low score moves it to not accepted, and the entry has done its job.
        await writeStats($, recordReviewScoped(stats, projects, projectId, a.category, a.startTier, review.score,
          { now, halfLifeMs: halfLifeMs(), runAccepted: e.accepted, runAt: e.at, minScore: config.minReviewScore }))
        reviewRuns.delete(key)
        // The review already moved the run to not accepted: a later rework only counts.
        const w = reworkRuns.get(key)
        if (w && e.accepted && review.score < config.minReviewScore) w.accepted = false
      } else {
        // The run is not recorded yet: its recording reads the score from the entry.
        await writeStats($, recordReviewScoped(stats, projects, projectId, a.category, a.startTier, review.score, { now, halfLifeMs: halfLifeMs() }))
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

const COMMAND_HELP = [
  'Subcommands:',
  '/escalator report: session cost, estimated savings and interventions (the default)',
  '/escalator stats: what the mod has learned per task category, and this session\'s savings per category',
  '/escalator config: the effective configuration and the environment mode',
  '/escalator history [n]: the last n recorded sessions (default 10, at most 50)',
  '/escalator map: open the live network of agents',
  '/escalator panel [close]: open (or close) a panel with the session, plan usage, savings per category and learned statistics',
  '/escalator consult <id>: ask the senior model about an agent now; the advice reaches it on its next tool call',
  '/escalator swap <id>: move an agent one tier up, from its next request (the map\'s detail buttons do the same)',
  '/escalator resume <id>|all: resume agents paused at the human level',
  '/escalator reset: forget the learned stats (history and category cache are kept)',
  '/escalator reset history: clear the recorded session history',
  '/escalator help: this list',
].join('\n')

// `/escalator config`: the options in force and where the mode comes from. ($.env.get needs literal names.)
async function configCommand($: any): Promise<string> {
  let modeSrc = 'default'
  let baseSrc = 'session start'
  try {
    modeSrc = (await $.env.get('MODEL_ESCALATOR_MODE')) ? 'MODEL_ESCALATOR_MODE' : (await $.env.get('EVAL_MODEL_ESCALATOR_MODE')) ? 'EVAL_MODEL_ESCALATOR_MODE' : 'default'
    baseSrc = (await $.env.get('MODEL_ESCALATOR_BASELINE')) ? 'MODEL_ESCALATOR_BASELINE' : (await $.env.get('EVAL_MODEL_ESCALATOR_BASELINE')) ? 'EVAL_MODEL_ESCALATOR_BASELINE' : "the lead's model"
  } catch { /* sources unknown: the values below are still right */ }
  return [
    `Mode: ${mode} (from ${modeSrc})`,
    `Baseline: ${baseline} (from ${baseSrc})`,
    'Options:',
    ...describeConfig(config).map((l) => '  ' + l),
    'Change them from /config, or in settings under pluginConfigs with the key model-escalator (or model-escalator@inline).',
    'The mode comes from the MODEL_ESCALATOR_MODE and MODEL_ESCALATOR_BASELINE environment variables.',
  ].join('\n')
}

const HISTORY_DEFAULT = 10
const HISTORY_MAX = 50

// `/escalator history [n]`: the stored session summaries, newest first. Malformed entries are skipped.
async function historyCommand($: any, arg: string): Promise<string> {
  const asked = Number(arg)
  const n = arg !== '' && Number.isInteger(asked) && asked >= 1 ? Math.min(asked, HISTORY_MAX) : HISTORY_DEFAULT
  let past: unknown[] = []
  try { const v = await $.store.get(SESSIONS_KEY); past = Array.isArray(v) ? v : [] } catch { /* no history */ }
  const rows: string[] = []
  for (const s of past) {
    const o = (typeof s === 'object' && s !== null ? s : {}) as { at?: unknown; mode?: unknown; baseline?: unknown; ledger?: unknown }
    const l = o.ledger as Ledger | undefined
    if (typeof o.at !== 'number' || !Number.isFinite(o.at) || typeof l !== 'object' || l === null || typeof l.actual !== 'number') continue
    const sv = savings(l)
    const money = (x: number) => (x < 0 ? '-' : '') + '$' + Math.abs(x).toFixed(2)
    const iv = Object.values(l.interventions ?? {}).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0)
    rows.push(`- ${new Date(o.at).toISOString().slice(0, 16).replace('T', ' ')} ${String(o.mode)}, baseline ${String(o.baseline)}: ` +
      `spent ${money(l.actual)}, saved ~${money(sv.low)} to ${money(sv.high)} (${sv.lowPct}-${sv.highPct}%), interventions ${iv}`)
  }
  if (rows.length === 0) return 'No sessions recorded yet. A session is recorded when it ends, if agents ran in it.'
  const shownRows = rows.slice(-n).reverse()
  return `Last ${shownRows.length} of ${rows.length} recorded sessions (newest first, times in UTC):\n` + shownRows.join('\n') +
    '\n\nClear with /escalator reset history.'
}

// `/escalator map`: opens the pane (a second call only retitles it) and starts the redraw ticks.
async function openMap($: EngineInterface): Promise<string> {
  try {
    await clockNow($)
    const opened = await $.ui.open({ id: MAP_PANE, title: 'Agent network' })
    mapDirty = true
    startMapTimer($)
    return opened.isPlaced
      ? 'Agent network opened. It shows every agent with its model, what it is doing and its cost; the animated map needs desktop or VS Code.'
      : `Agent network pane is waiting: ${opened.reason}`
  } catch {
    return 'Could not open the agent network pane.'
  }
}

// ---- Node detail: select an agent on the map, see it, consult or swap it now ----

// The element constructors the panel draws with (Box, Text and Button exist on every surface).
type UiKit = { Box: (p: Record<string, unknown>) => any; Text: (p: Record<string, unknown>) => any; Button: (p: Record<string, unknown>) => any }

// True when the map has folded the agent away or it has finished its work.
function agentDone(id: string): boolean {
  const n = graph.nodes.find((x) => x.id === id)
  return n === undefined || n.status === 'done'
}

function gatesFor(a: AgentState) {
  const done = agentDone(a.id)
  return {
    consult: consultGate(a, { mode, done, limit: limitFor(a) }),
    swap: swapGate(a, { mode, done, allowed: allowedMax(config.maxTier, blockedTiers), maxTier: config.maxTier }),
  }
}

// The notes queued for the agent, taken out (oldest first). Never throws.
function takeNotes(id: string | undefined): string[] {
  try {
    if (!id) return []
    const notes = pendingNotes.get(id) ?? []
    pendingNotes.delete(id)
    return notes
  } catch {
    return []
  }
}

function queueNote(id: string, note: string): void {
  pendingNotes.set(id, [...(pendingNotes.get(id) ?? []), note].slice(-MAX_PENDING_NOTES))
}

// Runs a button's action in the background: the press returns at once, the result is shown in the detail, and a
// consult (slow) also says when it is done. Never throws.
function runAction($: EngineInterface, work: Promise<string>, toast: boolean): void {
  void work.then(async (msg) => {
    if (toast) { try { await $.ui.toast(msg.slice(0, 200)) } catch { /* the detail shows it too */ } }
  }).catch(() => undefined)
}

// The selector buttons under the drawing and, for the selected agent, its detail with the actions. The same
// elements on every surface. Undefined when no worker is tracked (the pane is then the drawing alone).
function nodePanel($: EngineInterface, ui: UiKit, terminal: boolean): any {
  try {
    const list = [...agents.values()]
    if (list.length === 0) return undefined
    if (selectedId !== undefined && !agents.has(selectedId)) { selectedId = undefined; actionNote = undefined }
    const { Box, Text, Button } = ui
    const text = (children: string, extra: Record<string, unknown> = {}) => Text({ ...(terminal ? { wrap: 'truncate-end' } : {}), ...extra, children })
    const rows: any[] = [Box({
      key: 'node-select', flexDirection: 'row', gap: 1, flexWrap: 'wrap',
      children: [text('Inspect:', { dimColor: true }), ...selectorChips(list, selectedId).map((c) => Button({
        key: `select-${c.id}`, label: c.label, ...(c.selected ? { variant: 'primary' } : {}),
        onPress: () => { selectedId = c.id; actionNote = undefined; mapDirty = true },
      }))],
    })]
    const a = selectedId === undefined ? undefined : agents.get(selectedId)
    if (a) {
      const gates = gatesFor(a)
      const d = buildDetail({ agent: a, node: graph.nodes.find((n) => n.id === a.id), events: graph.events, ...gates })
      rows.push(text(d.title, { bold: true }))
      for (const r of d.rows) rows.push(text(`${r.label}: ${r.value}`))
      rows.push(text(d.attempts.length > 0 ? 'Last failed attempts:' : 'No failed attempt yet.', { dimColor: true }))
      for (const l of d.attempts) rows.push(text(`- ${l}`, { dimColor: true }))
      const id = a.id
      const buttons: any[] = []
      if (gates.consult.ok) {
        buttons.push(Button({ key: 'consult-now', label: 'Consult now', onPress: () => { runAction($, consultNow($, id), true) } }))
      }
      if (gates.swap.ok) {
        buttons.push(Button({ key: 'swap-now', label: 'Swap now', onPress: () => { runAction($, swapNow($, id), false) } }))
      }
      buttons.push(Button({ key: 'close-detail', label: 'Close detail', onPress: () => { selectedId = undefined; actionNote = undefined; mapDirty = true } }))
      rows.push(Box({ key: 'node-actions', flexDirection: 'row', gap: 1, flexWrap: 'wrap', children: buttons }))
      const why = [...new Set([gates.consult, gates.swap].flatMap((g) => (g.ok ? [] : [g.reason])))]
      for (const r of why) rows.push(text(r, { dimColor: true }))
      if (actionNote) rows.push(text(actionNote))
    }
    return Box({ key: 'node-panel', flexDirection: 'column', children: rows })
  } catch {
    return undefined
  }
}

// Say a result and redraw the map on its next tick.
function actionDone(msg: string): string {
  actionNote = msg
  mapDirty = true
  return msg
}

// "Consult now": the same senior consult the ladder runs (same dossier, caps and retry on the other senior); the
// advice is queued and reaches the agent with its next tool result. `query` is an agent id or name. Never throws.
async function consultNow($: EngineInterface, query: string): Promise<string> {
  try {
    const found = findAgent(agents.values(), query)
    if ('error' in found) return found.error
    const a = found.agent
    const gate = gatesFor(a).consult
    if (!gate.ok) return actionDone(gate.reason)
    if (consulting.has(a.id)) return actionDone(`A consult for ${agentHead(a)} is already running.`)
    consulting.add(a.id)
    try {
      ledger = addIntervention(ledger, 'consult')
      try { await $.ui.log(`${agentLabel(a)} (${a.category}): consult now (asked by the user)`) } catch { /* the note is best effort */ }
      const note = await consult($, a)
      queueNote(a.id, note)
      // A fresh grace window, as after any intervention.
      const cur = agents.get(a.id)
      if (cur) agents.set(a.id, { ...cur, stepsSinceAction: 0 })
      await save($)
      return actionDone(note.includes('Advice from a senior model')
        ? `Consulted the senior model about ${agentHead(a)}: the advice reaches it on its next tool call.`
        : `The senior model gave no advice for ${agentHead(a)}: a generic hint reaches it on its next tool call.`)
    } finally {
      consulting.delete(a.id)
    }
  } catch {
    return actionDone('Could not run the consult.')
  }
}

// "Swap now": the agent runs one tier up from its next request, through the swap path of the ladder (full model id,
// unavailable-model handling). It counts as an escalated run for learning, like a swap the ladder made: its ladder
// moves just past the swap level, and its category counts one escalation. `query` is an agent id or name.
async function swapNow($: EngineInterface, query: string): Promise<string> {
  try {
    const found = findAgent(agents.values(), query)
    if ('error' in found) return found.error
    const a = found.agent
    const gate = gatesFor(a).swap
    if (!gate.ok) return actionDone(gate.reason)
    const swapAt = config.levels.indexOf('swap')
    const state: TrackedAgent = {
      ...a, tier: nextTier(a.tier), score: 0, stepsSinceAction: 0, progressSignals: 0, effortBoosted: false,
      ...(swapAt >= 0 ? { level: Math.max(a.level, swapAt + 1) } : {}),
    }
    agents.set(a.id, state)
    ledger = addIntervention(ledger, 'swap')
    feed($, { type: 'ladder', agentId: a.id, action: 'swap', toModel: state.tier, level: state.level, score: state.score })
    queueNote(a.id, await act($, state, 'swap'))
    const cur: TrackedAgent = agents.get(a.id) ?? state
    if (cur.escCounted !== true) {
      ledger = addEscalation(ledger, cur.category)
      agents.set(a.id, { ...cur, escCounted: true })
    }
    notifyLead($, state, { kind: 'swap', tier: state.tier })
    await save($)
    return actionDone(`${agentHead(a)} moves to ${state.tier} from its next request.`)
  } catch {
    return actionDone('Could not swap the agent.')
  }
}

// `/escalator panel`: opens the statistics pane (a second call only retitles it) and starts its refresh tick.
async function openStatsPanel($: EngineInterface): Promise<string> {
  try {
    await clockNow($)
    const opened = await $.ui.open({ id: STATS_PANE, title: 'Escalator' })
    statsDirty = true
    startStatsTimer($)
    return opened.isPlaced
      ? 'Escalator panel opened: the session cost and savings, plan usage, savings per task category and what the mod learned.'
      : `Escalator panel is waiting: ${opened.reason}`
  } catch {
    return 'Could not open the Escalator panel.'
  }
}

// `/escalator panel close`: closes the pane and stops its refresh tick. (A close by the person raises `ui.close`,
// which stops the tick too; a close the mod asks for does not pass through the mod's own hooks.)
async function closeStatsPanel($: EngineInterface): Promise<string> {
  stopStatsTimer()
  try {
    await $.ui.close({ id: STATS_PANE })
    return 'Escalator panel closed.'
  } catch {
    return 'Could not close the Escalator panel.'
  }
}

// The report's "Plan usage" block: '' on API billing or when the engine cannot tell. Never throws.
async function readPlan($: EngineInterface): Promise<string> {
  try { return planBlock((await $.session.usage()).rateLimits, ledger) } catch { return '' }
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
    for (const a of chosen) {
      agents.set(a.id, resumeAgent(a, now))
      feed($, { type: 'resume', agentId: a.id })
    }
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
  const senior = pickSenior(config.senior, refusedSeniors) ?? config.senior
  const before = ledger.consultCost
  feed($, { type: 'consult', agentId: s.id, phase: 'start', model: senior })
  try {
    return await consultRun($, s, extra)
  } finally {
    feed($, { type: 'consult', agentId: s.id, phase: 'end', model: senior, cost: Math.max(0, ledger.consultCost - before) })
  }
}

async function consultRun($: EngineInterface, s: AgentState, extra: string): Promise<string> {
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
    ledger = addConsult(ledger, { usage, promptChars: prompt.length + SENIOR_SYSTEM.length, replyChars: advice.length }, tierOf(model), config, agents.get(agentId)?.category)
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
