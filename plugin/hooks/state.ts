import { MAX_ERROR_TEXT, MAX_RECENT_ERRORS, type AgentState, type ObservedModels, type Tier } from './detector'
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
  blockedTiers: Tier[]      // tiers the account refused as a swap target this session
  refusedSeniors: Tier[]    // tiers refused for senior consults this session
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
    // Senior consults of the agent: a whole, non-negative count; anything else is dropped (counts as none).
    if (typeof a.consults !== 'number' || !Number.isInteger(a.consults) || a.consults < 0) delete live.consults
    // The ring of full error texts: kept only as an array of strings, and cut to its bounds.
    if (Array.isArray(a.recentErrors) && a.recentErrors.every((e) => typeof e === 'string')) {
      live.recentErrors = (a.recentErrors as string[]).slice(-MAX_RECENT_ERRORS).map((e) => e.slice(0, MAX_ERROR_TEXT))
    } else delete live.recentErrors
    return live
  })
  // Snapshots saved before blocked models existed have no such lists; a malformed one counts as empty.
  const tiers = (x: unknown): Tier[] => (Array.isArray(x) ? [...new Set(x.filter((t): t is Tier => TIERS.includes(t as string)))] : [])
  return { ...v, agents, blockedTiers: tiers(v.blockedTiers), refusedSeniors: tiers(v.refusedSeniors) } as unknown as Snapshot
}
