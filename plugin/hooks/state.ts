import { clipLabel, EFFORTS, MAX_AGENT_NAME, MAX_ERROR_TEXT, MAX_RECENT_ERRORS, MAX_TASK_TITLE, type AgentState, type ObservedModels, type Tier } from './detector'
import { GRAPH_LIMITS, LEAD_ID, type GraphEdge, type GraphEvent, type GraphNode, type GraphState } from './graph'
import type { LayoutMemory } from './layout'
import type { Ledger } from './savings'

// An agent as the mod tracks it: the detector's state plus the cost of its current run, which the mod meters.
export type TrackedAgent = AgentState & { runCost?: number; escCounted?: boolean }

// Pure: the session state that must survive a module reload. The host keeps `$.state` for the session
// (empty in a new session, intact across a hot reload), so a non-empty read at session start means reload.
export type Snapshot = {
  agents: TrackedAgent[]
  ledger: Ledger
  seenModels: ObservedModels
  sessionTag: string
  mode: 'active' | 'observe' | 'baseline' | 'off'
  baseline: Tier
  baselinePinned: boolean
  blockedTiers: Tier[]      // tiers the account refused as a swap target this session
  refusedSeniors: Tier[]    // tiers refused for senior consults this session
  graph?: GraphState        // the agent network of the map (absent in snapshots saved before the map)
  layout?: LayoutMemory     // the slots the map's nodes were given, kept so they do not jump after a reload
  drawnSeq?: number         // the last graph event the map drew
}

const MODES = ['active', 'observe', 'baseline', 'off']
const TIERS = ['haiku', 'sonnet', 'opus']
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// Accepts only a well-formed snapshot; anything else counts as "nothing persisted".
export function parseSnapshot(v: unknown): Snapshot | undefined {
  if (!isObj(v)) return undefined
  if (!Array.isArray(v.agents) || !isObj(v.ledger) || !isObj(v.seenModels)) return undefined
  if (typeof v.sessionTag !== 'string' || !MODES.includes(v.mode as string) || !TIERS.includes(v.baseline as string)) return undefined
  if (typeof v.baselinePinned !== 'boolean') return undefined
  if (!v.agents.every((a) => isObj(a) && typeof a.id === 'string')) return undefined
  // Snapshots saved before edit counts or the request counter existed have no such fields on their agents.
  const agents = v.agents.map((a: Record<string, unknown>) => {
    const withEdits = isObj(a.editCounts) ? a : { ...a, editCounts: {} }
    const withSteps = typeof a.stepsSinceProgress === 'number' ? withEdits : { ...withEdits, stepsSinceProgress: 0 }
    // Liveness fields are optional: drop any that is malformed, so a bad value can never flag an agent.
    const live: Record<string, unknown> = { ...withSteps }
    if (typeof a.lastEventAt !== 'number' || !Number.isFinite(a.lastEventAt)) delete live.lastEventAt
    if (typeof a.inFlight !== 'number' || !(a.inFlight >= 0)) delete live.inFlight
    if (typeof a.running !== 'boolean') delete live.running
    if (typeof a.stalled !== 'boolean') delete live.stalled
    if (typeof a.helped !== 'boolean') delete live.helped
    if (typeof a.paused !== 'boolean') delete live.paused
    if (typeof a.deescalated !== 'boolean') delete live.deescalated
    if (typeof a.effortBoosted !== 'boolean') delete live.effortBoosted
    if (typeof a.escCounted !== 'boolean') delete live.escCounted
    // The last request's effort: a level of the scale, a finite number, or null (the model takes none).
    const e = a.effortSeen
    if (!(e === null || EFFORTS.includes(e as never) || (typeof e === 'number' && Number.isFinite(e)))) delete live.effortSeen
    if (typeof a.progressSignals !== 'number' || !Number.isInteger(a.progressSignals) || a.progressSignals < 0) delete live.progressSignals
    // Senior consults of the agent: a whole, non-negative count; anything else is dropped (counts as none).
    if (typeof a.consults !== 'number' || !Number.isInteger(a.consults) || a.consults < 0) delete live.consults
    // The cost of the agent's current run (USD): a finite, non-negative number; anything else counts as unknown.
    if (typeof a.runCost !== 'number' || !Number.isFinite(a.runCost) || a.runCost < 0) delete live.runCost
    // The name and the task title are labels: kept as capped text, dropped when absent or blank.
    const name = clipLabel(a.name, MAX_AGENT_NAME)
    if (name === undefined) delete live.name
    else live.name = name
    const title = clipLabel(a.taskTitle, MAX_TASK_TITLE)
    if (title === undefined) delete live.taskTitle
    else live.taskTitle = title
    // The oscillation counters (edits after a failure, the failure count at each file's last edit): maps of whole,
    // non-negative counts, or nothing.
    for (const k of ['retryEdits', 'editMarks'] as const) {
      const m = a[k]
      if (!(isObj(m) && Object.values(m).every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0))) delete live[k]
    }
    // The model requests started and the message of the last call: whole, non-negative numbers; the signatures counted
    // in that message: strings. Anything else is dropped (the next call starts a fresh message).
    const whole = (n: unknown): boolean => typeof n === 'number' && Number.isInteger(n) && n >= 0
    for (const k of ['requests', 'messageCalls', 'messageTools', 'message'] as const) if (!whole(a[k])) delete live[k]
    if (!(Array.isArray(a.messageSigs) && a.messageSigs.every((x) => typeof x === 'string'))) delete live.messageSigs
    // The ring of full error texts: kept only as an array of strings, and cut to its bounds.
    if (Array.isArray(a.recentErrors) && a.recentErrors.every((e) => typeof e === 'string')) {
      live.recentErrors = (a.recentErrors as string[]).slice(-MAX_RECENT_ERRORS).map((e) => e.slice(0, MAX_ERROR_TEXT))
    } else delete live.recentErrors
    return live
  })
  // Snapshots saved before blocked models existed have no such lists; a malformed one counts as empty.
  const tiers = (x: unknown): Tier[] => (Array.isArray(x) ? [...new Set(x.filter((t): t is Tier => TIERS.includes(t as string)))] : [])
  const { graph: _g, layout: _l, drawnSeq: _d, ledger: _led, ...restKeys } = v
  const rest = { ...restKeys, ledger: parseLedger(v.ledger as Record<string, unknown>) }
  const graph = parseGraph(v.graph)
  const layout = parseLayout(v.layout)
  const drawnSeq = typeof v.drawnSeq === 'number' && Number.isInteger(v.drawnSeq) && v.drawnSeq >= 0 ? v.drawnSeq : undefined
  return {
    ...rest, agents, blockedTiers: tiers(v.blockedTiers), refusedSeniors: tiers(v.refusedSeniors),
    ...(graph ? { graph } : {}), ...(layout ? { layout } : {}), ...(drawnSeq !== undefined ? { drawnSeq } : {}),
  } as unknown as Snapshot
}

// The per-category breakdown is optional and read back row by row: a malformed row is dropped, a malformed map is absent.
const ROW_KEYS = ['steps', 'actual', 'baselineHigh', 'baselineLow', 'agents', 'escalated'] as const
function parseLedger(l: Record<string, unknown>): Record<string, unknown> {
  const { byCategory, ...rest } = l
  if (!isObj(byCategory)) return rest
  const rows: Record<string, unknown> = {}
  for (const [name, row] of Object.entries(byCategory)) {
    if (isObj(row) && ROW_KEYS.every((k) => typeof row[k] === 'number' && Number.isFinite(row[k]) && (row[k] as number) >= 0)) {
      rows[name] = Object.fromEntries(ROW_KEYS.map((k) => [k, row[k]]))
    }
  }
  return { ...rest, byCategory: rows }
}

const NODE_KINDS = ['lead', 'worker', 'senior']
const NODE_STATUSES = ['active', 'waiting', 'done', 'stuck', 'paused']
const EDGE_KINDS = ['spawn', 'message', 'consult', 'notice']
const EVENT_KINDS = ['spawn', 'message', 'consult', 'swap', 'nudge', 'effort', 'human', 'notice', 'stall', 'pause', 'resume', 'done']
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const count = (v: unknown): number => (fin(v) && v >= 0 ? v : 0)
const text = (v: unknown, n: number): string => (typeof v === 'string' ? v.slice(0, n) : '')

function parseNode(v: unknown): GraphNode | undefined {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id || !NODE_KINDS.includes(v.kind as string) || !NODE_STATUSES.includes(v.status as string)) return undefined
  return {
    id: v.id.slice(0, 100), kind: v.kind as GraphNode['kind'], label: text(v.label, GRAPH_LIMITS.label), model: text(v.model, 100),
    tier: TIERS.includes(v.tier as string) ? (v.tier as Tier) : 'sonnet', status: v.status as GraphNode['status'],
    action: text(v.action, GRAPH_LIMITS.text), level: count(v.level), score: fin(v.score) ? v.score : 0, cost: count(v.cost),
    interventions: count(v.interventions), consults: count(v.consults), since: fin(v.since) ? v.since : 0,
  }
}

// Pure: a graph read back from the session snapshot. Malformed nodes, edges and events are dropped (edges with
// their nodes), the caps of the graph are enforced again, and a graph without its lead counts as absent.
export function parseGraph(v: unknown): GraphState | undefined {
  if (!isObj(v) || !Array.isArray(v.nodes) || !Array.isArray(v.edges) || !Array.isArray(v.events)) return undefined
  const seen = new Set<string>()
  const nodes: GraphNode[] = []
  for (const raw of v.nodes) {
    const n = parseNode(raw)
    if (n && !seen.has(n.id)) { seen.add(n.id); nodes.push(n) }
  }
  if (!nodes.some((n) => n.id === LEAD_ID && n.kind === 'lead')) return undefined
  const edges: GraphEdge[] = []
  for (const e of v.edges) {
    if (!isObj(e) || typeof e.id !== 'string' || !EDGE_KINDS.includes(e.kind as string)) continue
    if (typeof e.from !== 'string' || typeof e.to !== 'string' || !seen.has(e.from) || !seen.has(e.to)) continue
    edges.push({ id: e.id.slice(0, 300), kind: e.kind as GraphEdge['kind'], from: e.from, to: e.to, count: count(e.count), at: fin(e.at) ? e.at : 0 })
  }
  const events: GraphEvent[] = []
  for (const e of v.events) {
    if (!isObj(e) || !fin(e.seq) || !EVENT_KINDS.includes(e.kind as string) || !Array.isArray(e.nodes)) continue
    const ids = e.nodes.filter((x): x is string => typeof x === 'string' && seen.has(x))
    events.push({
      seq: e.seq, kind: e.kind as GraphEvent['kind'], at: fin(e.at) ? e.at : 0, nodes: ids,
      ...(TIERS.includes(e.fromTier as string) ? { fromTier: e.fromTier as Tier } : {}),
      ...(TIERS.includes(e.toTier as string) ? { toTier: e.toTier as Tier } : {}),
    })
  }
  const keptEvents = events.slice(-GRAPH_LIMITS.events)
  const top = keptEvents.reduce((m, e) => Math.max(m, e.seq), 0)
  return {
    nodes: nodes.slice(0, GRAPH_LIMITS.workers + 2), edges: edges.slice(-GRAPH_LIMITS.edges), events: keptEvents,
    seq: Math.max(count(v.seq), top), collapsed: count(v.collapsed), dropped: count(v.dropped),
  }
}

// Pure: the slots of the map's nodes. All-or-nothing: a malformed record is the same as none.
export function parseLayout(v: unknown): LayoutMemory | undefined {
  if (!isObj(v) || !isObj(v.slots) || !Array.isArray(v.retired)) return undefined
  const slots: Record<string, number> = {}
  for (const [k, s] of Object.entries(v.slots)) {
    if (typeof s !== 'number' || !Number.isInteger(s) || s < 0) return undefined
    slots[k] = s
  }
  if (!v.retired.every((x) => typeof x === 'string')) return undefined
  return { slots, retired: v.retired as string[] }
}
