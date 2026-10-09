import type { EngineInterface, HookStream, Register, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'
import { newTag, tagNote, withAnnouncement } from './channel'
import { DEFAULT_CONFIG, parseConfig, splitCommand, type Config } from './config'
import { afterHelp, canAskForHelp, classifyFailure, consultLimit, countStep, EFFORTS, escalated, isModelRefusal, isSilent, markStall, newAgent, noteProgress, observe, otherSenior, pauseAgent, pickSenior, raiseEffort, refuseTier, rememberModel, resolveModelId, resumeAgent, revertSwap, skipGrace, tierOf, toolEnd, toolStart, touch, usableTier, type Action, type AgentState, type Effort, type ModelFailure, type ObservedModels, type Tier } from './detector'
import { buildDossier, inputFromState } from './dossier'
import { categorize, recommend, record, type Stats } from './learning'
import { createQueue } from './queue'
import { parseSnapshot, type Snapshot } from './state'
import { addConsult, addIntervention, addStep, asUsage, emptyLedger, report, statusLine, type Ledger, type Usage } from './savings'

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

const agents = new Map<string, AgentState>()
// Agents for which a consult limit was already logged (one line per agent).
const limitNoted = new Set<string>()
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

// Tunables, built once from the plugin options when the module loads.
let config: Config = DEFAULT_CONFIG

// Stall detection: one periodic check per module load (a reload cancels the old one with its environment).
let stallTimer: { cancel: () => void } | undefined

// Current time from the host clock, or undefined when it cannot be read (liveness is then simply not tracked).
async function clockNow($: EngineInterface): Promise<number | undefined> {
  try { return await $.clock.now() } catch { return undefined }
}

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
async function noteLimit($: EngineInterface, id: string, category: string, limit: string): Promise<void> {
  if (limitNoted.has(id)) return
  limitNoted.add(id)
  try { await $.ui.log(`${id} (${category}): consult limit reached: ${limit}`) } catch { /* the note is best effort */ }
}

// Restores the module state to its defaults. Used by tests so each one starts clean.
export function resetState(): void {
  sessionTag = newTag()
  agents.clear()
  limitNoted.clear()
  ledger = emptyLedger()
  baseline = 'opus'
  baselinePinned = false
  seenModels = {}
  blockedTiers = []
  refusedSeniors = []
  mode = 'active'
  stallTimer?.cancel()
  stallTimer = undefined
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
        mode = readMode(await $.env.get('MODEL_ESCALATOR_MODE'))
        const b = await $.env.get('MODEL_ESCALATOR_BASELINE')
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
      return { text: 'Learned stats per category (runs / escalated):\n' + JSON.stringify(stats, null, 2) }
    }
    if (arg === 'reset') {
      await storeQueue(async () => { await $.store.delete(STATS_KEY) })
      return { text: 'Learned stats cleared.' }
    }
    if (arg === 'resume' || arg.startsWith('resume ')) return { text: await resumeCommand($, arg.slice(6).trim()) }
    const paused = [...agents.values()].filter((a) => a.paused)
    const pausedText = paused.length === 0 ? '' : '\n\nPaused (resume with /escalator resume <id>|all):\n' +
      paused.map((a) => `- ${a.id} (${a.category}, ${a.tier})`).join('\n')
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
      const best = mode === 'baseline' ? baseline : recommend(stats, category, asked)
      if (best !== asked) {
        if (mode !== 'observe') ev = { ...e, model: best }
        await $.ui.log(`${category}: ${asked} -> ${best}${mode === 'observe' ? ' (would)' : ''}`)
      }
    } catch { /* never block a spawn on our own failure */ }
    try {
      if (mode === 'active') ev = { ...ev, prompt: withAnnouncement(ev.prompt, sessionTag) }
    } catch { /* keep the original prompt */ }
    const r = await next(ev)
    if (r.agentId) {
      agents.set(r.agentId, newAgent(r.agentId, category, r.model, e.prompt))
      if (watching()) mark(r.agentId, await clockNow($))
      await save($)
    }
    return r
  })

  // The help tool: a tracked agent asks for the senior consult directly. Answered here, never passed on.
  on('tool.call', { tool: HELP_TOOL as never }, async ($, e) => {
    const ev = e as unknown as Record<string, unknown>
    const stop = pausedDeny(typeof ev.agentId === 'string' ? ev.agentId : undefined)
    if (stop) return stop as never
    const text = await handleHelp($, ev, typeof ev.agentId === 'string' ? ev.agentId : undefined)
    return { result: text } as never
  })

  // 2. Every tool call of a watched agent updates its difficulty score.
  on('tool.call', async ($, e, next) => {
    const stop = pausedDeny(e.agentId)
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
    if (mode === 'off' || mode === 'baseline') return r
    const a = id ? agents.get(id) : undefined
    if (!id || !a || r.deny !== undefined) return r
    try {
      const limit = limitFor(a)
      const { state, action, consultSkipped, progress } = observe(a, {
        tool: e.tool, ok: r.isError !== true, text: textOf(r), summary: summarize(e as unknown as Record<string, unknown>),
      }, config, limit === undefined, blockedTiers)
      if (consultSkipped && limit) await noteLimit($, id, state.category, limit)
      if (!action) {
        // Progress while swapped up may send the agent back one tier (option deescalateAfter).
        const back = progress ? noteProgress(state, config, mode === 'observe') : { state }
        agents.set(id, back.state)
        if (back.decided) {
          ledger = addIntervention(ledger, 'deescalate')
          await $.ui.log(`${id} (${state.category}): ${mode === 'observe' ? 'would de-escalate' : `de-escalate to ${back.state.tier}`}`)
        }
        await save($)
        if (back.decided && mode === 'active') {
          return { ...r, context: [...(r.context ?? []), tag(`Progress noted: from your next step you run on ${back.state.tier} again.`)] } as typeof r
        }
        return r
      }
      ledger = addIntervention(ledger, action)
      if (mode === 'observe') {
        await $.ui.log(`${id} (${state.category}): would ${labelOf(action)}`)
        // Measure only: never swap, never raise the effort.
        const { effortBoosted: _boost, ...rest } = state
        agents.set(id, a.effortBoosted === undefined ? { ...rest, tier: a.tier } : { ...rest, tier: a.tier, effortBoosted: a.effortBoosted })
        await save($)
        return r
      }
      // The human level pauses the agent: from now on its tool calls are refused until the user resumes it.
      agents.set(id, action === 'human' && config.pauseAtHuman ? pauseAgent(state) : state)
      const note = await act($, state, action)
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
      try {
        if (mode !== 'baseline') {
          const wasEscalated = escalated(a, config.levels)
          const argv = splitCommand(config.verifyCommand)
          if (argv.length === 0) {
            await recordOutcome($, a, wasEscalated, false)
          } else {
            // The agent's run is over and the lead is waiting for its result: verify in the background,
            // one command at a time, and record the outcome (once) when it is known.
            const p: Promise<void> = verifyQueue(() => verifyAndRecord($, a, wasEscalated, argv))
              .catch(() => undefined).finally(() => { pendingVerifications.delete(p) })
            pendingVerifications.add(p)
          }
        }
        agents.set(id, { ...(agents.get(id) ?? a), level: 0, score: 0, stepsSinceAction: 0, deescalated: false, progressSignals: 0, running: false, inFlight: 0, stalled: false })
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
      if (pendingVerifications.size > 0) {
        await Promise.race([flushVerifications(), $.clock.sleep(1000)])
      }
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
    await $.ui.log(`${id} (${a?.category ?? '-'}): ${model} is not available, stays on ${back}`)
    await $.ui.toast(`${model} is not available: ${a?.category ?? 'agent'} stays on ${back}`)
  } catch { /* the notice is best effort */ }
  await save($)
  return back
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
        await $.ui.log(`${a.id} (${a.category}): no activity for ${min} min${busy}`)
        await $.ui.status(`stalled: ${a.category} (${a.id}) silent for ${min} min`)
        if (mode === 'active') await $.ui.toast(`${a.category}: no activity for ${min} min`)
      } catch { /* the notice is best effort */ }
    }
  } catch { /* a failing check must never disturb the session */ }
}

async function recordOutcome($: EngineInterface, a: AgentState, wasEscalated: boolean, verifyFailed: boolean): Promise<void> {
  await storeQueue(async () => {
    const stats = ((await $.store.get(STATS_KEY)) ?? {}) as Stats
    await $.store.set(STATS_KEY, record(stats, a.category, a.startTier, wasEscalated, 0, verifyFailed))
  })
}

// Last lines of a command's output, kept short: it goes to the lead's log, never back to the agent.
function outputTail(r: { stdout?: unknown; stderr?: unknown }): string {
  const text = `${typeof r.stdout === 'string' ? r.stdout : ''}\n${typeof r.stderr === 'string' ? r.stderr : ''}`
  const tail = text.trim().split('\n').slice(-5).join(' | ')
  return tail.length > 400 ? '...' + tail.slice(-400) : tail
}

// Runs the user's verification command (argv from the user's own option, never from agent output)
// in the session's working directory and records the run as accepted or not. Never throws.
async function verifyAndRecord($: EngineInterface, a: AgentState, wasEscalated: boolean, argv: string[]): Promise<void> {
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
      await $.ui.log(`${a.id} (${a.category}): verification could not run: ${unavailable}`)
      if (!unavailableToasted) {
        unavailableToasted = true
        await $.ui.toast('Verification could not run: check the verifyCommand option')
      }
    } else {
      await $.ui.log(`${a.id} (${a.category}): verification ${failed ? 'failed' : 'passed'} (${detail})`)
      if (failed) await $.ui.toast(`${a.category}: verification failed`)
    }
  } catch { /* the note is best effort */ }
  try { await recordOutcome($, a, wasEscalated, failed) } catch { /* best effort */ }
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
function pausedDeny(id: string | undefined): { deny: string } | undefined {
  try {
    if (mode !== 'active' || !id || !agents.get(id)?.paused) return undefined
    return { deny: tag('You are paused by the supervisor: a human has to step in. Stop now, do not retry this tool or call any other, ' +
      'and reply with a short summary of what you tried and what blocks you. Tool calls stay refused until the user resumes you.') }
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
    const lines = chosen.map((a) => `${a.id} (${a.category}, ${a.tier})`)
    for (const a of chosen) {
      try { await $.ui.log(`${a.id} (${a.category}): resumed by the user, ladder restarted on ${a.tier}`) } catch { /* best effort */ }
    }
    try { await $.ui.status(statusLine(ledger)) } catch { /* best effort */ }
    return `Resumed ${chosen.length === 1 ? 'agent' : 'agents'}: ${lines.join(', ')}. The ladder restarts on the current tier.`
  } catch {
    return 'Could not resume the agent.'
  }
}

async function act($: EngineInterface, s: AgentState, action: Action): Promise<string> {
  const raised = action === 'effort' ? raiseEffort(s.effortSeen, config.effortBoost) : undefined
  await $.ui.log(`${s.id} (${s.category}): ${labelOf(action)}${raised ? ` to ${raised}` : ''}`)
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
      await $.ui.toast(`${s.category}: switched to ${s.tier}`)
      return tag(`From your next step you run on a stronger model (${s.tier}). Re-assess the problem from scratch.`)
    case 'human':
      await $.ui.toast(`${s.category}: needs a human` + (config.pauseAtHuman ? ` (paused: /escalator resume ${s.id})` : ''))
      await $.ui.status(`stuck: ${s.category} (${s.id})`)
      return tag('Stop now. Summarize what you tried and what blocks you, and end your turn so a human can step in.' +
        (config.pauseAtHuman ? ' Your further tool calls are refused until the user resumes you with /escalator resume.' : ''))
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
  let advice = first ? await askSenior($, first, buildDossier(inputFromState(s, { diffStat, extra }))) : ''
  const second = first ? otherSenior(first) : undefined
  if (!advice && second && !refusedSeniors.includes(tierOf(second))) {
    // A refusal (often the safety classifier) is intermittent and model dependent: one retry on the other
    // senior model, with a tighter dossier (same diff stat, git is not run again).
    advice = await askSenior($, second, buildDossier(inputFromState(s, { diffStat, extra }), RETRY_DOSSIER_LIMITS))
  }
  if (!advice) {
    try {
      await $.ui.log(`${s.id} (${s.category}): consult refused twice`, { to: 'debug' })
      await $.ui.log(`${s.id} (${s.category}): consult refused twice`)
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
async function askSenior($: EngineInterface, model: string, prompt: string): Promise<string> {
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
    ledger = addConsult(ledger, { usage, promptChars: prompt.length + SENIOR_SYSTEM.length, replyChars: advice.length }, tierOf(model), config)
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
      await $.ui.log(`${id} (${a.category}): would consult (asked for help)`)
      ledger = addIntervention(ledger, 'ask')
      await save($)
      return 'Request noted.'
    }
    if (!canAskForHelp(a, config)) return tag('You already consulted a senior model a moment ago: try that advice first.')
    const limit = limitFor(a)
    if (limit) {
      await noteLimit($, id, a.category, limit)
      return tag(`No further senior consult is available for you (${limit}). Do not ask for help again: try a different approach, ` +
        'make one small change you can check, or stop and summarize what you tried.')
    }
    // Count the call and move the ladder before the (slow) model call, so a second call cannot slip in.
    agents.set(id, afterHelp(a, config))
    ledger = addIntervention(ledger, 'ask')
    await $.ui.log(`${id} (${a.category}): asked for help`)
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
