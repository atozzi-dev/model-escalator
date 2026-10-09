import type { AgentState, ObservedModels, Tier } from './detector'
import type { Ledger } from './savings'

// Pure: the session state that must survive a module reload. The host keeps `$.state` for the session
// (empty in a new session, intact across a hot reload), so a non-empty read at session start means reload.
export type Snapshot = {
  agents: AgentState[]
  ledger: Ledger
  seenModels: ObservedModels
  sessionTag: string
  mode: 'active' | 'observe' | 'baseline' | 'off'
  baseline: Tier
  baselinePinned: boolean
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
  return v as unknown as Snapshot
}
