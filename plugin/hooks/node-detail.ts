// Pure builders for the map's node detail (select an agent, see what it did, consult or swap it now). No $ calls:
// register.ts feeds these with its state and draws the result as Box, Text and Button.

import { redactSecrets } from './dossier'
import { agentHead, agentLabel, clipLabel, tierRank, type AgentState, type Tier } from './detector'
import type { GraphEvent, GraphNode } from './graph'

export const DETAIL_LIMITS = {
  chips: 8,            // agents offered as selector buttons
  chipChars: 36,       // longest selector label
  attempts: 3,         // failed attempts shown
  attemptChars: 140,   // longest failed attempt
} as const

// Whether an action may run now; a refusal says why in one plain sentence.
export type Gate = { ok: true } | { ok: false; reason: string }

export type NodeDetail = {
  title: string
  rows: { label: string; value: string }[]
  attempts: string[]               // newest last
  consult: Gate
  swap: Gate
}

// Why a senior consult cannot be made for this agent now. `limit` is the consult cap that is closed, if any.
export function consultGate(a: AgentState, ctx: { mode: string; done: boolean; limit?: string }): Gate {
  if (ctx.mode !== 'active') return { ok: false, reason: `Actions need active mode (the mode is ${ctx.mode}).` }
  if (ctx.done) return { ok: false, reason: `${agentHead(a)} has finished.` }
  if (a.paused) return { ok: false, reason: `${agentHead(a)} is paused: resume it first.` }
  if (ctx.limit) return { ok: false, reason: `No senior consult is available for ${agentHead(a)}: ${ctx.limit}.` }
  return { ok: true }
}

// Why the agent cannot be moved one tier up now. `allowed` is the highest tier a swap may reach (maxTier lowered
// by the tiers the account refused); `maxTier` is the configured one.
export function swapGate(a: AgentState, ctx: { mode: string; done: boolean; allowed: Tier; maxTier: Tier }): Gate {
  if (ctx.mode !== 'active') return { ok: false, reason: `Actions need active mode (the mode is ${ctx.mode}).` }
  if (ctx.done) return { ok: false, reason: `${agentHead(a)} has finished.` }
  if (a.paused) return { ok: false, reason: `${agentHead(a)} is paused: resume it first.` }
  if (tierRank(a.tier) >= tierRank('opus')) return { ok: false, reason: `${agentHead(a)} already runs on the top tier (${a.tier}).` }
  if (tierRank(a.tier) >= tierRank(ctx.allowed)) {
    return tierRank(ctx.allowed) < tierRank(ctx.maxTier)
      ? { ok: false, reason: `The next tier is not available to this account: ${agentHead(a)} stays on ${a.tier}.` }
      : { ok: false, reason: `maxTier is ${ctx.maxTier}: ${agentHead(a)} stays on ${a.tier}.` }
  }
  return { ok: true }
}

// The agent a person named: by id first, then by name (case-insensitive). Several with the same name are listed.
export function findAgent(agents: Iterable<AgentState>, query: string): { agent: AgentState } | { error: string } {
  const list = [...agents]
  const q = query.trim()
  const known = list.length === 0 ? 'No agent is tracked yet.' : `Tracked: ${list.slice(-DETAIL_LIMITS.chips).map(agentHead).join(', ')}.`
  if (q === '') return { error: `Name an agent by id or name. ${known}` }
  const byId = list.find((a) => a.id === q)
  if (byId) return { agent: byId }
  const byName = list.filter((a) => a.name !== undefined && a.name.toLowerCase() === q.toLowerCase())
  if (byName.length === 1) return { agent: byName[0]! }
  if (byName.length > 1) return { error: `Several agents are named "${q}": use an id (${byName.map((a) => a.id).join(', ')}).` }
  return { error: `No agent "${q.slice(0, 40)}". ${known}` }
}

export type Chip = { id: string; label: string; selected: boolean }

// The selector buttons: the newest agents up to the cap, and the selected one even when it is older.
export function selectorChips(agents: readonly AgentState[], selected: string | undefined): Chip[] {
  let shown = agents.slice(-DETAIL_LIMITS.chips)
  const pick = selected === undefined ? undefined : agents.find((a) => a.id === selected)
  if (pick && !shown.includes(pick)) shown = [pick, ...shown.slice(1)]
  return shown.map((a) => ({
    id: a.id,
    label: clipLabel(agentLabel(a), DETAIL_LIMITS.chipChars) ?? a.id,
    selected: a.id === selected,
  }))
}

const money = (x: number): string => '$' + (x < 0.1 ? x.toFixed(4) : x.toFixed(2))

// Kinds of event that are something done to the agent.
const INTERVENTION_KINDS = ['nudge', 'consult', 'effort', 'swap', 'human', 'pause', 'stall'] as const

function interventions(id: string, node: GraphNode | undefined, events: readonly GraphEvent[]): string {
  const counts = new Map<string, number>()
  for (const e of events) {
    if (e.nodes.includes(id) && (INTERVENTION_KINDS as readonly string[]).includes(e.kind)) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1)
  }
  const parts = INTERVENTION_KINDS.filter((k) => counts.has(k)).map((k) => `${k} ${counts.get(k)}`)
  const total = node?.interventions ?? [...counts.values()].reduce((x, y) => x + y, 0)
  if (total === 0 && parts.length === 0) return 'none'
  return parts.length > 0 ? `${total} (${parts.join(', ')})` : String(total)
}

// The last failed attempts, from the agent's log: short, redacted, newest last.
function failedAttempts(a: AgentState): string[] {
  const failed = (a.log ?? []).filter((l) => / -> ERR\b/.test(l))
  return failed.slice(-DETAIL_LIMITS.attempts).map((l) => {
    const flat = redactSecrets(l).replace(/\s+/g, ' ').trim()
    return flat.length > DETAIL_LIMITS.attemptChars ? `${flat.slice(0, DETAIL_LIMITS.attemptChars - 3)}...` : flat
  })
}

export type DetailInput = {
  agent: AgentState
  node?: GraphNode                 // absent when the map folded the agent away
  events: readonly GraphEvent[]
  consult: Gate
  swap: Gate
}

export function buildDetail(i: DetailInput): NodeDetail {
  const a = i.agent
  const status = a.paused ? 'paused' : i.node?.status ?? 'done'
  const tier = a.tier === a.startTier ? `${a.tier} (as requested)` : `${a.tier} (requested ${a.startTier})`
  const rows = [
    { label: 'Category', value: a.category },
    { label: 'Tier', value: tier },
    { label: 'State', value: status },
    { label: 'Difficulty', value: `level ${a.level}, score ${(Math.round(a.score * 10) / 10).toString()}` },
    { label: 'Cost', value: i.node ? money(i.node.cost) : 'unknown' },
    { label: 'Consults', value: String(a.consults ?? 0) },
    { label: 'Interventions', value: interventions(a.id, i.node, i.events) },
  ]
  return { title: agentLabel(a), rows, attempts: failedAttempts(a), consult: i.consult, swap: i.swap }
}
