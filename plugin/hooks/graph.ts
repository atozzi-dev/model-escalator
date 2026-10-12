// Pure model of the agent network: the lead, its workers (subagents and in-process teammates) and the senior
// that answers consults. No $ calls: it is fed by simple input records that mirror what the hooks already see,
// and it returns a new immutable state each time. A later layout and an SVG renderer read this state; the
// renderer is responsible for escaping every text field (nothing is escaped here, only length-capped).
//
// Wiring map (hook event -> input record):
//   agent.spawn                      -> { type: 'spawn', agentId, label, model }
//   tool.call (before the call)      -> { type: 'tool-start', agentId?, tool, summary? }   summary: path or command
//   tool.call (result)               -> { type: 'tool-end', agentId?, tool }
//   turn.step (result with usage)    -> { type: 'step', agentId?, model, cost }            cost: USD of that request
//   ladder action taken              -> { type: 'ladder', agentId, action, toModel?, level?, score? }
//   consult started / finished       -> { type: 'consult', agentId, phase: 'start' | 'end', model?, cost? }
//   SendMessage / session.send       -> { type: 'message', from?, to?, text? }
//   note appended to the lead        -> { type: 'notice', agentId }
//   stall timer fired                -> { type: 'stall', agentId }
//   human level / resume             -> { type: 'pause' | 'resume', agentId }
//   turn.complete                    -> { type: 'complete', agentId? }
// `agentId` absent means the main loop (the lead). Every record carries `at`, a millisecond timestamp.

import { tierOf, type Tier } from './detector'

export const LEAD_ID = 'lead'
export const SENIOR_ID = 'senior'

export const GRAPH_LIMITS = { workers: 50, events: 100, edges: 200, label: 40, text: 60 } as const

export type NodeKind = 'lead' | 'worker' | 'senior'
export type NodeStatus = 'active' | 'waiting' | 'done' | 'stuck' | 'paused'
export type EdgeKind = 'spawn' | 'message' | 'consult' | 'notice'
export type GraphEventKind = 'spawn' | 'message' | 'consult' | 'swap' | 'nudge' | 'effort' | 'human' | 'notice'
  | 'stall' | 'pause' | 'resume' | 'done'

export type GraphNode = {
  readonly id: string
  readonly kind: NodeKind
  readonly label: string
  readonly model: string
  readonly tier: Tier
  readonly status: NodeStatus
  readonly action: string          // plain words derived from the last event: "reads app.ts", "thinks"...
  readonly level: number           // difficulty level reached on the ladder
  readonly score: number           // difficulty score
  readonly cost: number            // USD so far
  readonly interventions: number   // nudges, consults, effort raises, swaps and human stops received
  readonly consults: number        // consults completed for this node
  readonly since: number           // timestamp of the last status change
}

export type GraphEdge = {
  readonly id: string              // kind|from|to
  readonly kind: EdgeKind
  readonly from: string
  readonly to: string
  readonly count: number
  readonly at: number              // last use, for the renderer's flowing animation
}

export type GraphEvent = {
  readonly seq: number             // strictly increasing, survives queue trimming: the renderer remembers the last one it drew
  readonly kind: GraphEventKind
  readonly at: number
  readonly nodes: readonly string[]
  readonly fromTier?: Tier
  readonly toTier?: Tier
}

export type GraphState = {
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
  readonly events: readonly GraphEvent[]
  readonly seq: number
  readonly collapsed: number       // finished workers folded away to stay under the cap
  readonly dropped: number         // spawns refused because the cap was full of live workers
}

export type LadderAction = 'nudge' | 'consult' | 'effort' | 'swap' | 'human'

export type GraphInput =
  | { type: 'spawn'; at: number; agentId: string; label: string; model: string }
  | { type: 'tool-start'; at: number; agentId?: string; tool: string; summary?: string }
  | { type: 'tool-end'; at: number; agentId?: string; tool?: string }
  | { type: 'step'; at: number; agentId?: string; model: string; cost: number }
  | { type: 'ladder'; at: number; agentId: string; action: LadderAction; toModel?: string; level?: number; score?: number }
  | { type: 'consult'; at: number; agentId: string; phase: 'start' | 'end'; model?: string; cost?: number }
  | { type: 'message'; at: number; from?: string; to?: string; text?: string }
  | { type: 'notice'; at: number; agentId: string }
  | { type: 'stall'; at: number; agentId: string }
  | { type: 'pause'; at: number; agentId: string }
  | { type: 'resume'; at: number; agentId: string }
  | { type: 'complete'; at: number; agentId?: string }

const cap = (s: unknown, n: number): string => (typeof s === 'string' ? s : '').slice(0, n)
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const money = (v: unknown): number => Math.max(0, num(v))
const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? ''

// What a tool call means in plain words. `summary` is a path for file tools, a command for Bash.
export function actionText(tool: string, summary?: string): string {
  const s = (summary ?? '').trim()
  const file = baseName(s)
  const withFile = (verb: string, fallback: string) => (file ? `${verb} ${file}` : fallback)
  let text: string
  switch (tool) {
    case 'Read': text = withFile('reads', 'reads a file'); break
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': text = withFile('edits', 'edits a file'); break
    case 'Write': text = withFile('writes', 'writes a file'); break
    case 'Bash': case 'PowerShell': {
      const first = s.split(/\s+/)[0] ?? ''
      if (/(^|[\s/\\])(test|tests|vitest|jest|pytest|mocha)\b/.test(s) || /\bcargo test\b|\bgo test\b/.test(s)) text = 'runs the tests'
      else text = first ? `runs ${baseName(first) || first}` : 'runs a command'
      break
    }
    case 'Grep': text = 'searches the code'; break
    case 'Glob': text = 'lists files'; break
    case 'WebFetch': case 'WebSearch': text = 'browses the web'; break
    case 'Task': case 'Agent': text = 'starts a subagent'; break
    case 'TaskStop': text = 'stops a task'; break
    case 'SendMessage': text = 'sends a message'; break
    case 'ask_for_help': text = 'asks for help'; break
    default: text = `uses ${tool}`
  }
  return text.slice(0, GRAPH_LIMITS.text)
}

const newNode = (id: string, kind: NodeKind, label: string, model: string, at: number): GraphNode => ({
  id, kind, label: cap(label, GRAPH_LIMITS.label), model: cap(model, 100), tier: tierOf(model),
  status: kind === 'senior' ? 'waiting' : 'active', action: kind === 'senior' ? 'idle' : 'starts',
  level: 0, score: 0, cost: 0, interventions: 0, consults: 0, since: at,
})

export function emptyGraph(leadModel: string, at = 0): GraphState {
  return { nodes: [newNode(LEAD_ID, 'lead', 'lead', leadModel, at)], edges: [], events: [], seq: 0, collapsed: 0, dropped: 0 }
}

const find = (s: GraphState, id: string): GraphNode | undefined => s.nodes.find((n) => n.id === id)
const idOf = (agentId: unknown): string => (typeof agentId === 'string' && agentId ? agentId : LEAD_ID)

function patch(s: GraphState, id: string, change: Partial<GraphNode> | ((n: GraphNode) => Partial<GraphNode>)): GraphState {
  return { ...s, nodes: s.nodes.map((n) => (n.id === id ? { ...n, ...(typeof change === 'function' ? change(n) : change) } : n)) }
}

function addEvent(s: GraphState, e: Omit<GraphEvent, 'seq'>): GraphState {
  const seq = s.seq + 1
  const events = [...s.events, { ...e, seq }]
  return { ...s, seq, events: events.length > GRAPH_LIMITS.events ? events.slice(events.length - GRAPH_LIMITS.events) : events }
}

function addEdge(s: GraphState, kind: EdgeKind, from: string, to: string, at: number): GraphState {
  const id = `${kind}|${from}|${to}`
  if (s.edges.some((e) => e.id === id)) {
    return { ...s, edges: s.edges.map((e) => (e.id === id ? { ...e, count: e.count + 1, at } : e)) }
  }
  const edges = [...s.edges, { id, kind, from, to, count: 1, at }]
  return { ...s, edges: edges.length > GRAPH_LIMITS.edges ? edges.slice(edges.length - GRAPH_LIMITS.edges) : edges }
}

const workerCount = (s: GraphState): number => s.nodes.filter((n) => n.kind === 'worker').length

// A done node ignores a tool end and a paused one every activity update until it resumes; a done node that
// starts a tool or takes a step wakes up (see tool-start and step).
const frozen = (n: GraphNode): boolean => n.status === 'done' || n.status === 'paused'

function applySpawn(s: GraphState, i: Extract<GraphInput, { type: 'spawn' }>): GraphState {
  if (typeof i.agentId !== 'string' || !i.agentId || i.agentId === LEAD_ID || i.agentId === SENIOR_ID || find(s, i.agentId)) return s
  let cur = s
  if (workerCount(cur) >= GRAPH_LIMITS.workers) {
    const old = cur.nodes.find((n) => n.kind === 'worker' && n.status === 'done')
    if (!old) return { ...cur, dropped: cur.dropped + 1 }
    cur = {
      ...cur,
      nodes: cur.nodes.filter((n) => n.id !== old.id),
      edges: cur.edges.filter((e) => e.from !== old.id && e.to !== old.id),
      collapsed: cur.collapsed + 1,
    }
  }
  cur = { ...cur, nodes: [...cur.nodes, newNode(i.agentId, 'worker', i.label, i.model, num(i.at))] }
  cur = addEdge(cur, 'spawn', LEAD_ID, i.agentId, num(i.at))
  return addEvent(cur, { kind: 'spawn', at: num(i.at), nodes: [LEAD_ID, i.agentId] })
}

function applyLadder(s: GraphState, i: Extract<GraphInput, { type: 'ladder' }>): GraphState {
  const id = idOf(i.agentId)
  const n = find(s, id)
  if (!n) return s
  const at = num(i.at)
  const base: Partial<GraphNode> = {
    interventions: n.interventions + 1,
    level: i.level === undefined ? n.level : Math.max(0, Math.floor(num(i.level, n.level))),
    score: i.score === undefined ? n.score : num(i.score, n.score),
  }
  switch (i.action) {
    case 'swap': {
      if (typeof i.toModel !== 'string' || !i.toModel) return s
      const toTier = tierOf(i.toModel)
      const cur = addEvent(patch(s, id, { ...base, model: cap(i.toModel, 100), tier: toTier }),
        { kind: 'swap', at, nodes: [id], fromTier: n.tier, toTier })
      return cur
    }
    case 'nudge': return addEvent(patch(s, id, base), { kind: 'nudge', at, nodes: [id] })
    case 'effort': return addEvent(patch(s, id, base), { kind: 'effort', at, nodes: [id] })
    case 'human': return addEvent(patch(s, id, { ...base, status: 'stuck', since: at }), { kind: 'human', at, nodes: [id] })
    case 'consult': return patch(s, id, base) // the consult itself arrives as its own record
    default: return s
  }
}

function applyConsult(s: GraphState, i: Extract<GraphInput, { type: 'consult' }>): GraphState {
  const id = idOf(i.agentId)
  const w = find(s, id)
  if (!w) return s
  const at = num(i.at)
  let cur = s
  if (!find(cur, SENIOR_ID)) {
    const model = typeof i.model === 'string' && i.model ? i.model : 'opus'
    cur = { ...cur, nodes: [...cur.nodes, newNode(SENIOR_ID, 'senior', 'senior', model, at)] }
  } else if (typeof i.model === 'string' && i.model) {
    cur = patch(cur, SENIOR_ID, { model: cap(i.model, 100), tier: tierOf(i.model) })
  }
  if (i.phase === 'start') {
    cur = patch(cur, id, (n) => (n.status === 'done' ? {} : { status: 'waiting', action: 'asks for help', since: at, interventions: n.interventions + 1 }))
    cur = patch(cur, SENIOR_ID, { status: 'active', action: `advises ${w.label}`.slice(0, GRAPH_LIMITS.text), since: at })
    cur = addEdge(cur, 'consult', id, SENIOR_ID, at)
    return addEvent(cur, { kind: 'consult', at, nodes: [id, SENIOR_ID] })
  }
  if (i.phase === 'end') {
    cur = patch(cur, id, (n) => ({ consults: n.consults + 1, ...(n.status === 'waiting' ? { status: 'active' as const, action: 'thinks', since: at } : {}) }))
    return patch(cur, SENIOR_ID, (n) => ({ status: 'waiting', action: 'idle', since: at, cost: n.cost + money(i.cost) }))
  }
  return s
}

function applyStatus(s: GraphState, id: string, status: NodeStatus, kind: GraphEventKind, at: number): GraphState {
  const n = find(s, id)
  if (!n) return s
  return addEvent(patch(s, id, { status, since: at }), { kind, at, nodes: [id] })
}

function reduceUnsafe(s: GraphState, i: GraphInput): GraphState {
  if (!i || typeof i !== 'object') return s
  const at = num((i as { at?: unknown }).at)
  switch (i.type) {
    case 'spawn': return applySpawn(s, i)
    case 'tool-start': {
      const id = idOf(i.agentId)
      const n = find(s, id)
      if (!n || typeof i.tool !== 'string' || !i.tool) return s
      if (n.status === 'paused') return s
      return patch(s, id, { status: 'active', action: actionText(i.tool, i.summary), since: n.status === 'active' ? n.since : at })
    }
    case 'tool-end': {
      const id = idOf(i.agentId)
      const n = find(s, id)
      if (!n || frozen(n)) return s
      return patch(s, id, { action: 'thinks' })
    }
    case 'step': {
      const id = idOf(i.agentId)
      const n = find(s, id)
      if (!n) return s
      const model = typeof i.model === 'string' && i.model ? cap(i.model, 100) : n.model
      // A worker that finished and then steps again was woken (a background command ended, a message came).
      const wake: Partial<GraphNode> = n.status === 'done' ? { status: 'active', since: at } : {}
      return patch(s, id, { model, tier: tierOf(model), cost: n.cost + money(i.cost), ...(n.status === 'paused' ? {} : { action: 'thinks', ...wake }) })
    }
    case 'ladder': return applyLadder(s, i)
    case 'consult': return applyConsult(s, i)
    case 'message': {
      const from = idOf(i.from)
      const to = idOf(i.to)
      if (from === to || !find(s, from) || !find(s, to)) return s
      return addEvent(addEdge(s, 'message', from, to, at), { kind: 'message', at, nodes: [from, to] })
    }
    case 'notice': {
      const id = idOf(i.agentId)
      if (id === LEAD_ID || !find(s, id)) return s
      return addEvent(addEdge(s, 'notice', id, LEAD_ID, at), { kind: 'notice', at, nodes: [id, LEAD_ID] })
    }
    case 'stall': {
      const n = find(s, idOf(i.agentId))
      if (!n || n.status === 'done') return s
      return applyStatus(s, n.id, 'stuck', 'stall', at)
    }
    case 'pause': {
      const n = find(s, idOf(i.agentId))
      if (!n || n.status === 'done') return s
      return applyStatus(s, n.id, 'paused', 'pause', at)
    }
    case 'resume': {
      const n = find(s, idOf(i.agentId))
      if (!n || (n.status !== 'paused' && n.status !== 'stuck')) return s
      return applyStatus(s, n.id, 'active', 'resume', at)
    }
    case 'complete': {
      const n = find(s, idOf(i.agentId))
      if (!n || n.status === 'done') return s
      if (n.kind === 'lead') return patch(s, n.id, { status: 'waiting', action: 'waits', since: at })
      return addEvent(patch(s, n.id, { status: 'done', action: 'done', since: at }), { kind: 'done', at, nodes: [n.id] })
    }
    default: return s
  }
}

// Applies one input record and returns the next state. Never throws: a malformed record leaves the state as is.
export function reduce(state: GraphState, input: GraphInput): GraphState {
  try {
    return reduceUnsafe(state, input)
  } catch {
    return state
  }
}
