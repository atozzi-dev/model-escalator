import type { EngineInterface, Register } from 'claude-code'
import { newTag, tagNote, withAnnouncement } from './channel'
import { DEFAULT_CONFIG, parseConfig, type Config } from './config'
import { dossier, escalated, newAgent, observe, rememberModel, resolveModelId, tierOf, type Action, type AgentState, type ObservedModels, type Tier } from './detector'
import { categorize, recommend, record, type Stats } from './learning'
import { createQueue } from './queue'
import { parseSnapshot, type Snapshot } from './state'
import { addConsult, addIntervention, addStep, emptyLedger, report, statusLine, type Ledger, type Usage } from './savings'

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

// Restores the module state to its defaults. Used by tests so each one starts clean.
export function resetState(): void {
  sessionTag = newTag()
  agents.clear()
  ledger = emptyLedger()
  baseline = 'opus'
  baselinePinned = false
  seenModels = {}
  mode = 'active'
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
      for (const a of saved.agents) agents.set(a.id, a)
      ledger = saved.ledger
      seenModels = saved.seenModels
      sessionTag = saved.sessionTag
      mode = saved.mode
      baseline = saved.baseline
      baselinePinned = saved.baselinePinned
    } else {
      try {
        sessionTag = newTag()
        mode = readMode(await $.env.get('MODEL_ESCALATOR_MODE'))
        const b = await $.env.get('MODEL_ESCALATOR_BASELINE')
        baselinePinned = Boolean(b)
        if (b) baseline = tierOf(b)
      } catch { /* defaults */ }
      await save($)
    }
    const r = await next(e)
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
      await save($)
    }
    return r
  })

  // 2. Every tool call of a watched agent updates its difficulty score.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (mode === 'off' || mode === 'baseline') return r
    const id = e.agentId
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
    const swap = mode === 'active' && a !== undefined && a.tier !== a.startTier
    const r = yield* next(swap ? { ...e, model: resolveModelId(seenModels, a!.tier, config.modelIds) } : e)
    seenModels = rememberModel(seenModels, r.usage?.model)
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
          await storeQueue(async () => {
            const stats = ((await $.store.get(STATS_KEY)) ?? {}) as Stats
            await $.store.set(STATS_KEY, record(stats, a.category, a.startTier, wasEscalated, 0))
          })
        }
        agents.set(id, { ...a, level: 0, score: 0, stepsSinceAction: 0 })
        await save($)
        await $.ui.status(statusLine(ledger))
      } catch { /* best effort */ }
    }
    return next(e)
  })

  // 5. Keep a short history of sessions for later comparison.
  on('session.end', async ($, e, next) => {
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

type ModelReply = string | { isAnswered: true; text: string; usage?: { output_tokens?: number } } | { isAnswered: false; reason?: string; status?: number | null; error?: string; usage?: { output_tokens?: number } }

const tag = (text: string): string => tagNote(sessionTag, text)

async function act($: EngineInterface, s: AgentState, action: Action): Promise<string> {
  await $.ui.log(`${s.id} (${s.category}): ${action}`)
  switch (action) {
    case 'nudge':
      return tag('You are repeating the same failing step. Pause the repetition: re-read the last error in full, ' +
        'state one new hypothesis, then continue with a different approach.')
    case 'consult': {
      const prompt = dossier(s)
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
    case 'swap':
      await $.ui.toast(`${s.category}: switched to ${s.tier}`)
      return tag(`From your next step you run on a stronger model (${s.tier}). Re-assess the problem from scratch.`)
    case 'human':
      await $.ui.toast(`${s.category}: needs a human`)
      await $.ui.status(`stuck: ${s.category} (${s.id})`)
      return tag('Stop now. Summarize what you tried and what blocks you, and end your turn so a human can step in.')
  }
}
