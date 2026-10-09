import type { EngineInterface, Register } from 'claude-code'
import { newTag, tagNote, withAnnouncement } from './channel'
import { DEFAULT_CONFIG, parseConfig, splitCommand, type Config } from './config'
import { afterHelp, canAskForHelp, countStep, dossier, escalated, isSilent, markStall, newAgent, observe, rememberModel, resolveModelId, tierOf, toolEnd, toolStart, touch, type Action, type AgentState, type ObservedModels, type Tier } from './detector'
import { categorize, recommend, record, type Stats } from './learning'
import { createQueue } from './queue'
import { parseSnapshot, type Snapshot } from './state'
import { addConsult, addIntervention, addStep, emptyLedger, report, statusLine, type Ledger, type Usage } from './savings'

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
let ledger: Ledger = emptyLedger()
let baseline: Tier = 'opus'
let mode: Mode = 'active'
// True when MODEL_ESCALATOR_BASELINE fixes the reference model: the lead's model must not override it.
let baselinePinned = false
// Full model ids seen on turn.step requests and results, per tier: what a swap must send.
let seenModels: ObservedModels = {}

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

// Restores the module state to its defaults. Used by tests so each one starts clean.
export function resetState(): void {
  sessionTag = newTag()
  agents.clear()
  ledger = emptyLedger()
  baseline = 'opus'
  baselinePinned = false
  seenModels = {}
  mode = 'active'
  stallTimer?.cancel()
  stallTimer = undefined
}

function snapshot(): Snapshot {
  return { agents: [...agents.values()], ledger, seenModels, sessionTag, mode, baseline, baselinePinned }
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
      await $.command.register({ name: 'escalator', description: 'Model escalator: savings report and stats', argumentHint: '[report|stats|reset]' })
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
    return { text: `Mode: ${mode}\n` + report(ledger, baseline) }
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
    const text = await handleHelp($, ev, typeof ev.agentId === 'string' ? ev.agentId : undefined)
    return { result: text } as never
  })

  // 2. Every tool call of a watched agent updates its difficulty score.
  on('tool.call', async ($, e, next) => {
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
      const { state, action } = observe(a, {
        tool: e.tool, ok: r.isError !== true, text: textOf(r), summary: summarize(e as unknown as Record<string, unknown>),
      }, config)
      if (!action) { agents.set(id, state); await save($); return r }
      ledger = addIntervention(ledger, action)
      if (mode === 'observe') {
        await $.ui.log(`${id} (${state.category}): would ${action}`)
        agents.set(id, { ...state, tier: a.tier })   // measure only: never swap
        await save($)
        return r
      }
      agents.set(id, state)
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
    const a = e.agentId ? agents.get(e.agentId) : undefined
    seenModels = rememberModel(seenModels, e.model)
    if (e.agentId && watching() && agents.has(e.agentId)) mark(e.agentId, await clockNow($))
    const swap = mode === 'active' && a !== undefined && a.tier !== a.startTier
    const r = yield* next(swap ? { ...e, model: resolveModelId(seenModels, a!.tier, config.modelIds) } : e)
    seenModels = rememberModel(seenModels, r.usage?.model)
    if (e.agentId && watching() && agents.has(e.agentId)) mark(e.agentId, await clockNow($))
    // Idle requests count only where a score is acted on: active, and observe (which measures it).
    try {
      const counted = e.agentId ? agents.get(e.agentId) : undefined
      if (e.agentId && counted && (mode === 'active' || mode === 'observe')) agents.set(e.agentId, countStep(counted, config))
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
        agents.set(id, { ...(agents.get(id) ?? a), level: 0, score: 0, stepsSinceAction: 0, running: false, inFlight: 0, stalled: false })
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

async function act($: EngineInterface, s: AgentState, action: Action): Promise<string> {
  await $.ui.log(`${s.id} (${s.category}): ${action}`)
  switch (action) {
    case 'nudge':
      return tag('You are not making progress. Pause: re-read the last error or result in full, ' +
        'state one new hypothesis, then continue with a different approach.')
    case 'consult':
      return consult($, s)
    case 'swap':
      await $.ui.toast(`${s.category}: switched to ${s.tier}`)
      return tag(`From your next step you run on a stronger model (${s.tier}). Re-assess the problem from scratch.`)
    case 'human':
      await $.ui.toast(`${s.category}: needs a human`)
      await $.ui.status(`stuck: ${s.category} (${s.id})`)
      return tag('Stop now. Summarize what you tried and what blocks you, and end your turn so a human can step in.')
  }
}

// Asks the senior model about the agent and returns the tagged note for it. `extra` is the agent's own
// account of the problem (help tool), added to the dossier. Falls back to a generic note without advice.
async function consult($: EngineInterface, s: AgentState, extra = ''): Promise<string> {
  const prompt = dossier(s) + extra
  // The engine answers { isAnswered, text, usage }; the published 2.1.277 types (used by CI)
  // still say string, hence the wider local type.
  const reply = await $.model.complete({ model: config.senior, system: SENIOR_SYSTEM, prompt, maxTokens: 2000 }) as ModelReply
  const advice = typeof reply === 'string' ? reply : reply.isAnswered ? reply.text : ''
  if (!advice) {
    try {
      const r = typeof reply === 'string' ? undefined : reply
      const why = r && !r.isAnswered ? `reason=${r.reason ?? 'unknown'} status=${r.status ?? '-'} error=${r.error ?? '-'}` : 'reason=empty-text'
      await $.ui.log(`senior consult gave no advice: ${why} output_tokens=${r?.usage?.output_tokens ?? '-'}`, { to: 'debug' })
    } catch { /* diagnostics only */ }
  }
  ledger = addConsult(ledger, prompt.length + SENIOR_SYSTEM.length, advice.length, tierOf(config.senior), config)
  if (!advice) return tag('Still stuck. List three different hypotheses and test the cheapest one first.')
  return tag(`Advice from a senior model:
${advice}`)
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
    // Count the call and move the ladder before the (slow) model call, so a second call cannot slip in.
    agents.set(id, afterHelp(a, config))
    ledger = addIntervention(ledger, 'ask')
    await $.ui.log(`${id} (${a.category}): asked for help`)
    const problem = clip(input.problem, 2000)
    const tried = clip(input.tried, 2000)
    const extra = `
The agent asks for help.
Problem: ${problem || '(not given)'}` + (tried ? `
What it tried: ${tried}` : '')
    const note = await consult($, agents.get(id) ?? a, extra)
    await save($)
    return note
  } catch {
    return 'Help is not available right now.'
  }
}
