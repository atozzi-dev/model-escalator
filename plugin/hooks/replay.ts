// Pure: replays recorded sessions (hooks/recorder.ts) through the detector with another configuration, with no
// model call, and compares what the ladder would have done with what it did. The recorded stream is taken as it is:
// the replay does not simulate the models, so after an intervention the agent does what it did in the recording,
// not what it would have done after a different note or on a different model.

import { DEFAULT_CONFIG, optionValue, parseConfig, type Config } from './config'
import {
  afterHelp, allowedMax, canAskForHelp, consultLimit, countStep, decide, endRun, escalated, isSilent, markStall, newAgent, nextTier,
  noteProgress, pauseAgent, refuseTier, restartSilence, resumeAgent, revertSwap, skipGrace, tierRank, toolEnd, toolStart, touch, usableTier,
  type Action, type AgentState, type Features, type Tier,
} from './detector'
import { RECORDED_OPTIONS, type RecEvent, type Recording } from './recorder'

// Options the replay reads (the ones that steer the score and the ladder). minReviewScore only tells what a recorded
// run's outcome was, so it is not one.
export const REPLAY_KEYS: readonly string[] = RECORDED_OPTIONS.filter((k) => k !== 'minReviewScore')

export type HitKind = Action | 'stall' | 'deesc' | 'help'
// One intervention: what, at which of the agent's tool results (1 = its first), and when (ms since its spawn).
export type Hit = { act: HitKind; call: number; at: number }

export type AgentResult = {
  session: string
  sessionAt: number
  label: string
  cat: string
  tier: Tier
  actual: Hit[]
  candidate: Hit[]
  runs: number
  actualEscalatedRuns: number
  candidateEscalatedRuns: number
  // Every run ended without escalation, no failed verification, no low review, no rework, and no intervention at all.
  finishedWell: boolean
  endedBadly: boolean        // a run ended escalated, failed its verification, was reviewed low or reworked
  pausedAtCall?: number      // the candidate paused the agent here (active sessions with pauseAtHuman)
  ignoredCalls: number       // recorded calls after the candidate's pause: refused live, so not scored
}

export type SessionResult = { id: string; at: number; mode: Recording['mode']; agents: AgentResult[]; skipped: number; calls: number }

const LADDER_ACTS: readonly HitKind[] = ['nudge', 'consult', 'effort', 'swap', 'human']
const isLadder = (h: Hit): boolean => LADDER_ACTS.includes(h.act)
const firstLadder = (hits: Hit[]): Hit | undefined => hits.find(isLadder)

// A possible false positive: the agent finished well with no intervention recorded, and the candidate acts on it.
const falsePositive = (a: AgentResult): boolean => a.finishedWell && firstLadder(a.candidate) !== undefined
// The candidate's first ladder action comes earlier than the recorded one, or there is one where none was recorded
// and the run ended badly.
function actsEarlier(a: AgentResult): boolean {
  const x = firstLadder(a.actual)
  const y = firstLadder(a.candidate)
  return y !== undefined && (x === undefined ? a.endedBadly : y.call < x.call)
}
// The candidate's first ladder action comes later than the recorded one, or never.
function actsLater(a: AgentResult): boolean {
  const x = firstLadder(a.actual)
  const y = firstLadder(a.candidate)
  return x !== undefined && (y === undefined || y.call > x.call)
}

// The configuration a session ran with, from the options it recorded (missing ones take the defaults).
export function configOf(rec: Recording, base: Config = DEFAULT_CONFIG): Config {
  return parseConfig(rec.opts, base)
}

type Sim = {
  s: AgentState
  spawnAt: number
  calls: number
  actual: Hit[]
  candidate: Hit[]
  outcomes: { ok: boolean; c: number }[]   // the recorded consults of the agent, in order: reused as the replay's
  used: number
  runs: number
  actualEsc: number
  candEsc: number
  bad: boolean                             // a recorded outcome says the work was not accepted
  pausedAtCall?: number
  ignored: number
}

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)

// The events of a session, checked one by one: a malformed one is left out.
function wellFormed(rec: Recording): RecEvent[] {
  const n = rec.agents.length
  return rec.events.filter((e): e is RecEvent => {
    if (typeof e !== 'object' || e === null || typeof (e as { k?: unknown }).k !== 'string' || !Number.isFinite((e as { at?: unknown }).at)) return false
    const a = (e as { a?: unknown }).a
    return a === undefined || (Number.isInteger(a) && (a as number) >= 0 && (a as number) < n)
  })
}

type Start = { e: RecEvent; i: number; t: number }

// What a replay needs from a recording whatever the configuration: computed once, then replayed with many (a sweep).
// The recording must not change after it is prepared.
export type PreparedRecording = {
  rec: Recording
  events: RecEvent[]
  outcomes: Map<number, { ok: boolean; c: number }[]>   // recorded consult outcomes per agent
  meanCost: number                                       // their mean cost, for consults the recording never made
  starts: Start[]                                        // starts of tool calls and model requests, by time
  features: (Features | undefined)[]                     // of each tool event, by event index (decide only reads them)
}

// The detector's features of one recorded tool result.
function featuresOf(e: Extract<RecEvent, { k: 'tool' }>): Features {
  const f: Features = { attempts: num(e.n), sig: typeof e.s === 'string' ? e.s : '', counts: Array.isArray(e.f) ? e.f.filter((n) => Number.isFinite(n)) : [] }
  if (typeof e.e === 'string') f.edit = e.e
  if (e.env === 1) f.env = true
  if (Number.isInteger(e.g)) f.group = e.g
  // Recordings made before output prints have none: the signal stays silent on them, as it was live.
  if (typeof e.o === 'string') { f.out = e.o; f.cmd = typeof e.c === 'string' ? e.c : '' }
  return f
}

export function prepareRecording(rec: Recording): PreparedRecording {
  const events = wellFormed(rec)
  const features = events.map((e) => (e.k === 'tool' ? featuresOf(e) : undefined))
  const outcomes = new Map<number, { ok: boolean; c: number }[]>()
  let costSum = 0
  let costN = 0
  for (const e of events) {
    if (e.k !== 'consult') continue
    const list = outcomes.get(e.a)
    const o = { ok: e.ok === true, c: num(e.c) }
    if (list) list.push(o)
    else outcomes.set(e.a, [o])
    costSum += num(e.c)
    costN++
  }
  // An agent is busy (or active) from the start of its tool call or model request on.
  const starts: Start[] = []
  events.forEach((e, i) => { if ((e.k === 'tool' || e.k === 'step') && num(e.d) > 0) starts.push({ e, i, t: e.at - num(e.d) }) })
  starts.sort((x, y) => x.t - y.t || x.i - y.i)
  return { rec, events, outcomes, meanCost: costN > 0 ? costSum / costN : 0, starts, features }
}

// Replays one session with `cfg`. With `followRecorded`, an option change the session went through (a module reload
// after /config) is applied where it happened: that is the session's own configuration, for the self-check.
// Active sessions replay as active (swaps change the tier, a human level pauses); observe and baseline sessions replay
// as observe (the tier never changes, as when observe only logs).
export function replaySession(rec: Recording, cfg: Config, followRecorded = false): SessionResult {
  return replayPrepared(prepareRecording(rec), cfg, followRecorded)
}

// What a replay read and spent, beyond its result (for the sweep's reuse of per-agent replays): the tiers whose
// threshold it read (bit tierRank), the consults it made and their USD (reviews left out).
export type ReplayTrace = { tiers: number; consults: number; usd: number }

export function replayPrepared(p: PreparedRecording, cfg: Config, followRecorded = false, trace?: ReplayTrace): SessionResult {
  const { rec, events, outcomes, meanCost, starts, features } = p
  const active = rec.mode === 'active'
  const actualMin = num(rec.opts.minReviewScore, DEFAULT_CONFIG.minReviewScore)
  let c = cfg
  const sims = new Map<number, Sim>()
  let blocked: Tier[] = []
  let consultCost = 0
  let calls = 0
  const cut = (a: number): boolean => rec.agents[a]?.cut === true

  // The consults of the agents replayed (the sum of their `consults`), kept up to date instead of summed per call.
  let consultsInSession = 0
  const sessionConsults = (): number => consultsInSession
  const hit = (x: Sim, act: HitKind, at: number, into: 'actual' | 'candidate'): void => {
    x[into].push({ act, call: x.calls, at: Math.max(0, at - x.spawnAt) })
  }
  // A consult the replay makes: it counts like a live one, and takes the agent's next recorded outcome (a refusal
  // skips the grace window, as live). Past the recorded ones it assumes an answer at the session's mean cost.
  const consult = (x: Sim): void => {
    x.s = { ...x.s, consults: (x.s.consults ?? 0) + 1 }
    consultsInSession++
    const o = x.outcomes[x.used++]
    consultCost += o ? o.c : meanCost
    if (trace) { trace.consults++; trace.usd += o ? o.c : meanCost }
    if (o && !o.ok) x.s = skipGrace(x.s, c)
  }

  // Stall checks run on the session's timer: every period from the last boot (start or reload).
  const period = (): number => Math.max(1000, Math.min(30_000, (c.stallMinutes * 60_000) / 4))
  let nextTick: number | undefined
  const tick = (until: number): void => {
    while (nextTick !== undefined && nextTick < until) {
      let anyRunning = false
      for (const x of sims.values()) if (x.s.running === true) { anyRunning = true; break }
      if (!anyRunning) {
        // Nothing can stall: jump to the first tick at or after `until`.
        const p = period()
        nextTick += Math.ceil((until - nextTick) / p) * p
        break
      }
      for (const x of sims.values()) {
        if (isSilent(x.s, nextTick, c) === undefined) continue
        if (trace) trace.tiers |= 1 << tierRank(x.s.tier)
        x.s = markStall(x.s, c)
        hit(x, 'stall', nextTick, 'candidate')
      }
      nextTick += period()
    }
  }

  let si = 0

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!
    while (si < starts.length && starts[si]!.t <= e.at) {
      const st = starts[si++]!
      tick(st.t)
      const a = (st.e as { a: number }).a
      const x = sims.get(a)
      if (!x) continue
      if (st.e.k === 'tool') { if (!x.s.paused) x.s = toolStart(x.s, st.t) } else x.s = touch(x.s, st.t)
    }
    tick(e.at)
    if (e.k === 'boot') {
      if (followRecorded && e.o) c = parseConfig(e.o, c)
      // A reload (or a resumed session) restarts the stall timer and the agents' silence windows, and forgets the
      // calls in flight.
      nextTick = e.at + period()
      for (const x of sims.values()) x.s = restartSilence({ ...x.s, inFlight: 0 }, e.at)
      continue
    }
    if (e.k === 'refused') {
      blocked = refuseTier(blocked, e.tier)
      if (active) for (const x of sims.values()) { const ok = usableTier(x.s, blocked); if (x.s.tier !== ok) x.s = revertSwap(x.s, ok, c) }
      continue
    }
    if (!('a' in e) || cut(e.a)) continue
    if (e.k === 'spawn') {
      const meta = rec.agents[e.a]!
      const s = newAgent(meta.id, meta.cat, e.tier, '')
      consultsInSession -= sims.get(e.a)?.s.consults ?? 0   // a spawn again replaces the agent
      sims.set(e.a, { s: touch(s, e.at), spawnAt: e.at, calls: 0, actual: [], candidate: [], outcomes: outcomes.get(e.a) ?? [], used: 0, runs: 0, actualEsc: 0, candEsc: 0, bad: false, ignored: 0 })
      continue
    }
    const x = sims.get(e.a)
    if (!x) continue   // its spawn was not recorded
    switch (e.k) {
      case 'tool': {
        x.calls++
        calls++
        if (x.s.paused) { x.ignored++; break }
        x.s = toolEnd(x.s, e.at)
        const f = features[i]!
        const limit = consultLimit(x.s, sessionConsults(), consultCost, c)
        const prev = x.s
        if (trace) trace.tiers |= 1 << tierRank(prev.tier)
        const out = decide(prev, f, c, limit === undefined, blocked)
        if (!out.action) {
          const back = out.progress ? noteProgress(out.state, c, !active) : { state: out.state }
          x.s = back.state
          if (back.decided) hit(x, 'deesc', e.at, 'candidate')
          break
        }
        hit(x, out.action, e.at, 'candidate')
        if (!active) {
          // Observe only logs: the tier and a raised effort stay as they were.
          const { effortBoosted: _b, ...rest } = out.state
          x.s = prev.effortBoosted === undefined ? { ...rest, tier: prev.tier } : { ...rest, tier: prev.tier, effortBoosted: prev.effortBoosted }
          break
        }
        x.s = out.action === 'human' && c.pauseAtHuman ? pauseAgent(out.state) : out.state
        if (x.s.paused) x.pausedAtCall = x.calls
        if (out.action === 'consult') consult(x)
        break
      }
      case 'step': {
        if (active && x.s.tier !== usableTier(x.s, blocked)) x.s = revertSwap(x.s, usableTier(x.s, blocked), c)
        x.s = touch({ ...x.s, effortSeen: e.ef ?? null }, e.at)
        if (!x.s.paused) x.s = countStep(x.s, c)
        break
      }
      case 'help': {
        if (x.s.paused) break
        if (!active) { hit(x, 'help', e.at, 'candidate'); break }
        if (!canAskForHelp(x.s, c) || consultLimit(x.s, sessionConsults(), consultCost, c) !== undefined) break
        x.s = afterHelp(x.s, c)
        hit(x, 'help', e.at, 'candidate')
        consult(x)
        break
      }
      case 'manual': {
        if (!active || x.s.paused) break
        if (e.act === 'consult') {
          consult(x)
          x.s = { ...x.s, stepsSinceAction: 0 }
        } else if (tierRank(x.s.tier) < tierRank(allowedMax(c.maxTier, blocked))) {
          const swapAt = c.levels.indexOf('swap')
          x.s = { ...x.s, tier: nextTier(x.s.tier), score: 0, stepsSinceAction: 0, progressSignals: 0, effortBoosted: false,
            ...(swapAt >= 0 ? { level: Math.max(x.s.level, swapAt + 1) } : {}) }
        }
        break
      }
      case 'resume': {
        if (x.s.paused) { x.s = resumeAgent(x.s, e.at); x.pausedAtCall = undefined }
        break
      }
      case 'end': {
        x.runs++
        if (e.esc === true) { x.actualEsc++; x.bad = true }
        if (escalated(x.s, c.levels)) x.candEsc++
        x.s = endRun(x.s)
        break
      }
      case 'act': hit(x, e.act, e.at, 'actual'); break
      case 'deesc': hit(x, 'deesc', e.at, 'actual'); break
      case 'stall': hit(x, 'stall', e.at, 'actual'); break
      case 'verify': if (e.ok === false) x.bad = true; break
      case 'review': {
        consultCost += num(e.c)
        if (num(e.score) >= 1 && num(e.score) < actualMin) x.bad = true
        break
      }
      case 'rework': x.bad = true; break
      case 'consult': break
    }
    // Help granted live counts as an intervention of the recording (in observe every request was only logged).
    if (e.k === 'help' && (e.g === 1 || !active)) hit(x, 'help', e.at, 'actual')
  }

  const agents: AgentResult[] = []
  for (const [a, x] of sims) {
    const meta = rec.agents[a]!
    agents.push({
      session: rec.id, sessionAt: rec.at, label: meta.label, cat: meta.cat, tier: meta.tier,
      actual: x.actual, candidate: x.candidate, runs: x.runs, actualEscalatedRuns: x.actualEsc, candidateEscalatedRuns: x.candEsc,
      finishedWell: x.runs > 0 && !x.bad && x.actual.length === 0, endedBadly: x.bad,
      ...(x.pausedAtCall !== undefined ? { pausedAtCall: x.pausedAtCall } : {}), ignoredCalls: x.ignored,
    })
  }
  const skipped = rec.agents.filter((m) => m.cut === true).length
  return { id: rec.id, at: rec.at, mode: rec.mode, agents, skipped, calls }
}

// ---- Arguments ----

// A second base that differs from the defaults on every replay option: a value that parses the same over both is a
// valid one; an invalid value falls back to the base, so it parses differently.
const ALT_BASE = parseConfig({
  thresholdHaiku: 97, thresholdSonnet: 98, thresholdOpus: 99, graceSteps: 97, levels: 'human', effortStep: true, effortBoost: 'max',
  maxTier: 'haiku', oscillationEdits: 97, idleSteps: 97, idleWeight: 0.97, stallMinutes: 97, maxConsultsPerAgent: 97,
  maxConsultsPerSession: 97, consultBudgetUsd: 97, deescalateAfter: 97, pauseAtHuman: false,
})

const shown = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v))

// `option=value ...` over the options in force: the candidate configuration and one line per changed option, or an
// error naming what is wrong. Values go through the same validation as the plugin options.
export function parseReplayArgs(args: string, current: Config): { config: Config; changes: string[] } | { error: string } {
  const valid = `Options the replay uses: ${REPLAY_KEYS.join(', ')}.`
  const raw: Record<string, string> = {}
  for (const token of args.split(/\s+/).filter(Boolean)) {
    const eq = token.indexOf('=')
    if (eq <= 0) return { error: `Expected option=value, got "${token}". ${valid}` }
    const key = token.slice(0, eq)
    const value = token.slice(eq + 1)
    if (!REPLAY_KEYS.includes(key)) return { error: `${key} is not used by the replay. ${valid}` }
    const one = { [key]: value }
    if (value === '' || shown(optionValue(parseConfig(one), key)) !== shown(optionValue(parseConfig(one, ALT_BASE), key))) {
      return { error: `Invalid value for ${key}: "${value}". ${valid}` }
    }
    raw[key] = value
  }
  const config = parseConfig(raw, current)
  const changes = Object.keys(raw)
    .map((k) => ({ k, from: shown(optionValue(current, k)), to: shown(optionValue(config, k)) }))
    .filter((x) => x.from !== x.to)
    .map((x) => `${x.k} ${x.from} -> ${x.to}`)
  return { config, changes }
}

// ---- Report ----

const ROWS: readonly [HitKind, string][] = [
  ['nudge', 'nudge'], ['consult', 'consult'], ['effort', 'effort'], ['swap', 'swap'], ['human', 'human'],
  ['stall', 'stall'], ['deesc', 'de-escalate'], ['help', 'help asked'],
]

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length))
const lpad = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s)
const count = (hits: Hit[], act: HitKind): number => hits.filter((h) => h.act === act).length
const trail = (hits: Hit[]): string => (hits.length === 0 ? 'none' : hits.slice(0, 6).map((h) => `${h.act}@${h.call}`).join(' ') + (hits.length > 6 ? ' ...' : ''))
const same = (a: Hit[], b: Hit[]): boolean => a.length === b.length && a.every((h, i) => h.act === b[i]!.act && h.call === b[i]!.call)
const when = (at: number): string => new Date(at).toISOString().slice(0, 16).replace('T', ' ')

// The self-check: each session replayed with its own options must give back what it recorded. Baseline sessions
// recorded no decision, so they are left out.
type SelfCheck = { matched: number; total: number; agents: number; off: string[] }

function selfCheck(recs: PreparedRecording[]): SelfCheck {
  let matched = 0
  let total = 0
  let agents = 0
  const off: string[] = []
  for (const p of recs) {
    if (p.rec.mode === 'baseline') continue
    for (const a of replayPrepared(p, configOf(p.rec), true).agents) {
      agents++
      total += a.actual.length
      let k = 0
      while (k < a.actual.length && k < a.candidate.length && a.actual[k]!.act === a.candidate[k]!.act && a.actual[k]!.call === a.candidate[k]!.call) k++
      matched += k
      if (!same(a.actual, a.candidate)) off.push(`${a.label} (${a.cat}): recorded ${trail(a.actual)}, replayed ${trail(a.candidate)}`)
    }
  }
  return { matched, total, agents, off }
}

function selfCheckLines(check: SelfCheck): string[] {
  const head = check.total === 0 && check.off.length === 0
    ? `Self-check: no recorded intervention to reproduce (${check.agents} agents).`
    : `Self-check: replaying each session with its own options reproduces ${check.matched} of ${check.total} recorded interventions` +
      (check.off.length === 0 ? '.' : `; ${check.off.length} agent${check.off.length === 1 ? '' : 's'} differ:`)
  return [head, ...check.off.slice(0, 5).map((l) => `- ${l}`)]
}

// The comparison as text: interventions per level and per category, recorded against the candidate, the agents that
// differ most, possible false positives, and the self-check. `recs` oldest first.
export function replayReport(recs: Recording[], current: Config, candidate: { config: Config; changes: string[] }): string {
  if (recs.length === 0) {
    return 'No recorded sessions. Set recordSessions (for example 20) and run some sessions first: ' +
      '/escalator replay then compares other options on what they observed.'
  }
  const prepared = recs.map(prepareRecording)
  const results = prepared.map((p) => replayPrepared(p, candidate.config))
  const agents = results.flatMap((r) => r.agents)
  const calls = results.reduce((n, r) => n + r.calls, 0)
  const skipped = results.reduce((n, r) => n + r.skipped, 0)
  const out: string[] = []
  out.push(`Replay of ${recs.length} recorded session${recs.length === 1 ? '' : 's'} (${when(recs[0]!.at)} to ${when(recs[recs.length - 1]!.at)} UTC): ` +
    `${agents.length} agent${agents.length === 1 ? '' : 's'}, ${calls} tool results` +
    (skipped > 0 ? `; ${skipped} agent${skipped === 1 ? '' : 's'} skipped (recording incomplete)` : '') + '.')
  out.push(candidate.changes.length === 0 ? 'Candidate: the options in force.' : `Candidate: ${candidate.changes.join(', ')}.`)
  const differ = recs.filter((r) => {
    const own = configOf(r)
    return REPLAY_KEYS.some((k) => shown(optionValue(own, k)) !== shown(optionValue(current, k)))
  }).length
  if (differ > 0) out.push(`${differ} session${differ === 1 ? ' was' : 's were'} recorded with other options than the ones in force: their recorded column reflects those.`)
  const observed = recs.filter((r) => r.mode !== 'active').length
  if (observed > 0) out.push(`${observed} session${observed === 1 ? '' : 's'} in observe or baseline mode: replayed as observe (actions only logged, the tier never changes).`)

  out.push('', `${pad('Interventions', 14)}${lpad('recorded', 9)}${lpad('candidate', 11)}`)
  for (const [act, name] of ROWS) {
    const a = agents.reduce((n, x) => n + count(x.actual, act), 0)
    const b = agents.reduce((n, x) => n + count(x.candidate, act), 0)
    if (act === 'effort' && a === 0 && b === 0) continue
    out.push(`${pad(name, 14)}${lpad(String(a), 9)}${lpad(String(b), 11)}`)
  }
  const escA = agents.reduce((n, x) => n + x.actualEscalatedRuns, 0)
  const escB = agents.reduce((n, x) => n + x.candidateEscalatedRuns, 0)
  out.push(`${pad('escalated runs', 14)}${lpad(String(escA), 9)}${lpad(String(escB), 11)}`)

  const cats = [...new Set(agents.map((a) => a.cat))].sort()
  if (cats.length > 0) {
    out.push('', 'Ladder interventions per category (recorded -> candidate, agents):')
    for (const cat of cats) {
      const of = agents.filter((a) => a.cat === cat)
      const a = of.reduce((n, x) => n + x.actual.filter(isLadder).length, 0)
      const b = of.reduce((n, x) => n + x.candidate.filter(isLadder).length, 0)
      out.push(`- ${cat}: ${a} -> ${b} (${of.length})`)
    }
  }

  const fp = agents.filter(falsePositive)
  const earlier = agents.filter(actsEarlier)
  const later = agents.filter(actsLater)
  out.push('', `Possible false positives (finished well with no intervention, hit by the candidate): ${fp.length}`)
  for (const a of fp.slice(0, 5)) out.push(`- ${a.label} (${a.cat}): candidate ${trail(a.candidate)}`)
  out.push(`Candidate acts earlier on ${earlier.length} agent${earlier.length === 1 ? '' : 's'} (an earlier first intervention, or one on an agent ` +
    `whose run failed its verification, was reviewed low or reworked with none recorded); later or never on ${later.length}.`)

  const diffs = agents
    .filter((a) => !same(a.actual, a.candidate))
    .map((a) => ({ a, d: Math.abs(a.actual.length - a.candidate.length) * 1000 + Math.abs((a.actual[0]?.call ?? 0) - (a.candidate[0]?.call ?? 0)) }))
    .sort((x, y) => y.d - x.d)
  if (diffs.length > 0) {
    out.push('', `Agents that differ most (${Math.min(8, diffs.length)} of ${diffs.length}; action@tool result):`)
    for (const { a } of diffs.slice(0, 8)) {
      const pause = a.ignoredCalls > 0 ? `, ${a.ignoredCalls} later calls ignored after the pause` : ''
      out.push(`- ${a.label} (${a.cat}, ${when(a.sessionAt)}): recorded ${trail(a.actual)} | candidate ${trail(a.candidate)}${pause}`)
    }
  }

  out.push('', ...selfCheckLines(selfCheck(prepared)))

  out.push('', 'Limits: the replay does not simulate the models. After an intervention each agent does what it did in the recording, ' +
    'so an earlier or later note, consult or swap would have changed what came next. Start tiers (learning), verifications and ' +
    'reviews are not run again; consult answers are reused in order. Stalls follow the recorded times on the stall timer.')
  return out.join('\n')
}

// ---- Sweep ----
//
// Replays every recorded session over a grid of candidate options and ranks the candidates, to tune the detector on
// what the sessions observed in one go instead of one `/escalator replay option=value` at a time.
//
// Wiring (register.ts, inside replayCommand, which gets the text after "replay"; before parseReplayArgs, and inside
// its try so an error still answers 'Could not replay the recorded sessions.'):
//
//   if (args === 'sweep' || args.startsWith('sweep ')) {
//     const grid = sweepGrid(args.slice(5).trim(), config)
//     if ('error' in grid) return grid.error
//     // recs: the stored recordings plus this session's live copy (a JSON copy), exactly as for a plain replay
//     return sweepReport(sweep(recs, config, grid))
//   }
//
// plus `replay sweep option=values ...` in the command's argumentHint and a help line: '/escalator replay sweep
// option=values ...: replay the recorded sessions over a grid of options (ranges lo..hi or lo..hi:step, lists a,b,c,
// alternatives of levels separated by |; at most 200 combinations) and rank them by false positives and stuck agents
// caught'. The largest sweep (the store full of recordings, 20 sessions, 200 candidates) takes about 5 s on a loaded
// machine, at most ~0.15 s per candidate (tests/replay-sweep.test.ts). To keep the engine free in between, drive
// `sweepSteps` instead of `sweep` and yield between candidates: it yields the number of candidates done and returns
// the result.
//
// Scoring, in this order (compareRows):
// 1. fewest possible false positives, weighted by the highest level each one reaches (FP_WEIGHT): an agent that finished
//    well with no intervention recorded and that the candidate acts on. A note costs a sentence; a consult a senior
//    call; a raised effort and a swap make every later request dearer; a human level stops the agent;
// 2. most stuck agents caught: agents the recording shows escalated (a swap or human level recorded, or a run that
//    ended escalated) or ended badly (failed verification, low review, rework), that the candidate acts on;
// 3. closest to the options in force: over the swept options, the relative gap for a number (|a - b| / max(|b|, 1)),
//    1 for any other change;
// 4. fewest ladder interventions in all; then the order of the grid.
// A row is marked when no other row is at least as good on both 1 and 2 and better on one (the trade-off front): the
// top row only wins on false positives, so a marked row lower down may catch more for a little more noise.

export const MAX_SWEEP_CANDIDATES = 200

type Level = Action
const LEVELS: readonly Level[] = ['nudge', 'consult', 'effort', 'swap', 'human']
export const FP_WEIGHT: Readonly<Record<Level, number>> = { nudge: 1, consult: 3, effort: 4, swap: 6, human: 10 }

export type SweepCandidate = { config: Config; values: [string, string][]; changes: string[] }
export type SweepAxis = { key: string; spec: string; values: string[] }
export type SweepGrid = { keys: string[]; axes: SweepAxis[]; candidates: SweepCandidate[] }

const zeroLevels = (): Record<Level, number> => ({ nudge: 0, consult: 0, effort: 0, swap: 0, human: 0 })
const RANGE = /^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)(?::(\d+(?:\.\d+)?))?$/

// `option=values ...` over the options in force. Values: `lo..hi` (step 1), `lo..hi:step`, a list `a,b,c`, or one
// value; the alternatives of `levels` (itself a comma list) are separated by `|`. Every value goes through the same
// validation as the plugin options; repeated values count once. At most MAX_SWEEP_CANDIDATES combinations.
export function sweepGrid(spec: string, current: Config): SweepGrid | { error: string } {
  const valid = `Options the replay uses: ${REPLAY_KEYS.join(', ')}.`
  const usage = 'Give the options to sweep as option=values: a range lo..hi or lo..hi:step, a list a,b,c ' +
    '(for levels, alternatives separated by |) or one value; for example thresholdHaiku=2..5 graceSteps=3,4,6.'
  const tokens = spec.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { error: usage }
  const axes: SweepAxis[] = []
  const cap = `a sweep has at most ${MAX_SWEEP_CANDIDATES} combinations`
  for (const token of tokens) {
    const eq = token.indexOf('=')
    if (eq <= 0) return { error: `Expected option=values, got "${token}". ${usage}` }
    const key = token.slice(0, eq)
    const raw = token.slice(eq + 1)
    if (!REPLAY_KEYS.includes(key)) return { error: `${key} is not used by the replay. ${valid}` }
    if (axes.some((a) => a.key === key)) return { error: `${key} is given twice.` }
    const values: string[] = []
    for (const alt of key === 'levels' ? raw.split('|') : raw.split(/[,|]/)) {
      const m = RANGE.exec(alt)
      if (!m) { values.push(alt); continue }
      const lo = Number(m[1])
      const hi = Number(m[2])
      const step = m[3] === undefined ? 1 : Number(m[3])
      if (!(lo <= hi) || !(step > 0)) return { error: `Invalid range for ${key}: "${alt}" (low..high or low..high:step, low not above high, a step above 0).` }
      const n = Math.floor((hi - lo) / step + 1e-9) + 1
      if (n > MAX_SWEEP_CANDIDATES) return { error: `${key}=${alt} gives ${n} values: ${cap}.` }
      for (let i = 0; i < n; i++) values.push(String(Number((lo + i * step).toFixed(10))))
    }
    // Each value checked alone, then kept once by the value it parses to.
    const seen = new Set<string>()
    const kept: string[] = []
    for (const v of values) {
      const one = parseReplayArgs(`${key}=${v}`, current)
      if ('error' in one) return { error: one.error }
      const norm = shown(optionValue(one.config, key))
      if (!seen.has(norm)) { seen.add(norm); kept.push(norm) }
    }
    axes.push({ key, spec: raw, values: kept })
  }
  const total = axes.reduce((n, a) => n * a.values.length, 1)
  if (total > MAX_SWEEP_CANDIDATES) {
    return { error: `The grid has ${total} combinations (${axes.map((a) => `${a.key} ${a.values.length}`).join(' x ')}); ` +
      `${cap}. Narrow a range or drop an option.` }
  }
  const candidates: SweepCandidate[] = []
  const pick = new Array<number>(axes.length).fill(0)
  for (let n = 0; n < total; n++) {
    // The first option varies slowest.
    let rest = n
    for (let i = axes.length - 1; i >= 0; i--) { pick[i] = rest % axes[i]!.values.length; rest = Math.floor(rest / axes[i]!.values.length) }
    const values = axes.map((a, i): [string, string] => [a.key, a.values[pick[i]!]!])
    const parsed = parseReplayArgs(values.map(([k, v]) => `${k}=${v}`).join(' '), current)
    if ('error' in parsed) return { error: parsed.error }
    candidates.push({ config: parsed.config, values, changes: parsed.changes })
  }
  return { keys: axes.map((a) => a.key), axes, candidates }
}

export type SweepRow = {
  values: [string, string][]           // the swept options and the candidate's value of each
  changes: string[]                    // what differs from the options in force
  config: Config
  isCurrent: boolean                   // the options in force
  order: number                        // position in the grid; -1 for the options in force outside it
  interventions: Record<Level, number> // ladder interventions per level, all agents
  ladder: number                       // all ladder interventions
  stalls: number
  escalatedRuns: number
  falsePositives: number
  fpByLevel: Record<Level, number>     // false positives by the highest level they reach
  fpWeight: number
  caught: number                       // stuck agents the candidate acts on
  earlier: number                      // agents whose first intervention comes earlier than recorded (as in the replay report)
  later: number                        // ... later than recorded, or never
  distance: number                     // from the options in force, over the swept options
  pareto: boolean                      // no other row is at least as good on fpWeight and caught and better on one
}

export type SweepResult = {
  sessions: number
  from?: number
  to?: number
  agents: number
  stuck: number
  finishedWell: number
  calls: number
  skipped: number
  observed: number                     // sessions recorded in observe or baseline mode
  axes: SweepAxis[]
  rows: SweepRow[]                     // the candidates, ranked
  current: SweepRow                    // the options in force (one of rows when the grid holds them)
  currentRank: number                  // where the options in force rank among the candidates (1 = first)
  check: SelfCheck
}

// Rank order: negative when `a` ranks before `b`.
export function compareRows(a: SweepRow, b: SweepRow): number {
  return a.fpWeight - b.fpWeight || b.caught - a.caught || a.distance - b.distance || a.ladder - b.ladder || a.order - b.order
}

const stuckAgent = (a: AgentResult): boolean => a.endedBadly || a.actual.some((h) => h.act === 'swap' || h.act === 'human')

function distanceOf(cfg: Config, current: Config, keys: string[]): number {
  let d = 0
  for (const k of keys) {
    const a = optionValue(cfg, k)
    const b = optionValue(current, k)
    if (typeof a === 'number' && typeof b === 'number') d += Math.abs(a - b) / Math.max(Math.abs(b), 1)
    else if (shown(a) !== shown(b)) d += 1
  }
  return d
}

// What the sessions hold, whatever the options: counted on the first candidate's replay.
type Totals = { agents: number; stuck: number; finishedWell: number; calls: number; skipped: number }

// Reuse of per-agent replays. Within a session the agents share only the consult limits of the session
// (maxConsultsPerSession, consultBudgetUsd): every other input of an agent's replay is its own events, the session's
// boots and refused tiers, and the options. So each agent is replayed alone, and its result serves every candidate
// that agrees on the options it read: the swept options other than the thresholds, and the threshold of each tier it
// was on when one was read (most agents never leave their start tier). When the candidate's session limits could
// have stopped a consult (the agents' consults together reach the limit, or with the reviews the budget), the
// session is replayed whole instead.
type AgentMemo = { result: AgentResult | undefined; calls: number; consults: number; usd: number }
type AgentPart = { prepared: PreparedRecording; memo: Map<string, AgentMemo>; masks: Set<number> }
type SessionPlan = { full: PreparedRecording; parts: AgentPart[]; reviewUsd: number; skipped: number }

const TIER_KEYS: readonly [Tier, string][] = [['haiku', 'thresholdHaiku'], ['sonnet', 'thresholdSonnet'], ['opus', 'thresholdOpus']]
const isThresholdKey = (k: string): boolean => TIER_KEYS.some(([, n]) => n === k)

function planOf(p: PreparedRecording): SessionPlan {
  const spawned: number[] = []
  let reviewUsd = 0
  for (const e of p.events) {
    if (e.k === 'spawn' && p.rec.agents[e.a]?.cut !== true && !spawned.includes(e.a)) spawned.push(e.a)
    if (e.k === 'review') reviewUsd += num(e.c)
  }
  const parts = spawned.map((a): AgentPart => {
    const keep: number[] = []
    p.events.forEach((e, i) => { if (!('a' in e) || e.a === a) keep.push(i) })
    const prepared: PreparedRecording = {
      rec: p.rec, events: keep.map((i) => p.events[i]!), features: keep.map((i) => p.features[i]),
      outcomes: new Map([[a, p.outcomes.get(a) ?? []]]), meanCost: p.meanCost,
      starts: p.starts.filter((st) => (st.e as { a: number }).a === a),
    }
    return { prepared, memo: new Map(), masks: new Set() }
  })
  return { full: p, parts, reviewUsd, skipped: p.rec.agents.filter((m) => m.cut === true).length }
}

function memoKey(other: string, mask: number, c: Config): string {
  return `${other}#${mask}#${TIER_KEYS.filter(([t]) => (mask & (1 << tierRank(t))) !== 0).map(([t]) => c.threshold[t]).join(',')}`
}

// The agents of one session replayed with a candidate (`other`: its swept options other than the thresholds).
function sessionAgents(plan: SessionPlan, c: Config, other: string, plain: boolean): { agents: AgentResult[]; calls: number } {
  const whole = (): { agents: AgentResult[]; calls: number } => {
    const r = replayPrepared(plan.full, c)
    return { agents: r.agents, calls: r.calls }
  }
  if (plain) return whole()
  const agents: AgentResult[] = []
  let calls = 0
  let consults = 0
  let usd = 0
  for (const part of plan.parts) {
    let m: AgentMemo | undefined
    for (const mask of part.masks) if ((m = part.memo.get(memoKey(other, mask, c)))) break
    if (!m) {
      const trace: ReplayTrace = { tiers: 0, consults: 0, usd: 0 }
      const r = replayPrepared(part.prepared, c, false, trace)
      m = { result: r.agents[0], calls: r.calls, consults: trace.consults, usd: trace.usd }
      part.memo.set(memoKey(other, trace.tiers, c), m)
      part.masks.add(trace.tiers)
    }
    if (m.result) agents.push(m.result)
    calls += m.calls
    consults += m.consults
    usd += m.usd
  }
  if (consults > c.maxConsultsPerSession || (c.consultBudgetUsd > 0 && plan.reviewUsd + usd >= c.consultBudgetUsd)) return whole()
  return { agents, calls }
}

function rowOf(plans: SessionPlan[], cand: SweepCandidate, current: Config, keys: string[], order: number, plain: boolean, totals?: Totals): SweepRow {
  const row: SweepRow = {
    values: cand.values, changes: cand.changes, config: cand.config, isCurrent: cand.changes.length === 0, order,
    interventions: zeroLevels(), ladder: 0, stalls: 0, escalatedRuns: 0, falsePositives: 0, fpByLevel: zeroLevels(), fpWeight: 0,
    caught: 0, earlier: 0, later: 0, distance: distanceOf(cand.config, current, keys), pareto: false,
  }
  const other = cand.values.filter(([k]) => !isThresholdKey(k)).map(([k, v]) => `${k}=${v}`).join(' ')
  for (const plan of plans) {
    const session = sessionAgents(plan, cand.config, other, plain)
    if (totals) { totals.calls += session.calls; totals.skipped += plan.skipped }
    for (const a of session.agents) {
      if (totals) {
        totals.agents++
        if (stuckAgent(a)) totals.stuck++
        if (a.finishedWell) totals.finishedWell++
      }
      let top = -1
      for (const h of a.candidate) {
        if (h.act === 'stall') { row.stalls++; continue }
        const lvl = LEVELS.indexOf(h.act as Level)
        if (lvl < 0) continue
        row.interventions[h.act as Level]++
        row.ladder++
        if (lvl > top) top = lvl
      }
      row.escalatedRuns += a.candidateEscalatedRuns
      if (top >= 0 && falsePositive(a)) {
        const lvl = LEVELS[top]!
        row.falsePositives++
        row.fpByLevel[lvl]++
        row.fpWeight += FP_WEIGHT[lvl]
      }
      if (top >= 0 && stuckAgent(a)) row.caught++
      if (actsEarlier(a)) row.earlier++
      if (actsLater(a)) row.later++
    }
  }
  return row
}

// The sweep, one candidate per step: yields the number of candidates replayed so far (the options in force last, when
// the grid leaves them out) and returns the ranked result. `plain` replays every session whole for every candidate
// (no reuse of per-agent replays): the same result, slower; for checks.
export function* sweepSteps(recs: Recording[], current: Config, grid: SweepGrid, plain = false): Generator<number, SweepResult, void> {
  const prepared = recs.map(prepareRecording)
  const plans = prepared.map(planOf)
  const keys = grid.keys
  const check = selfCheck(prepared)
  const rows: SweepRow[] = []
  const totals: Totals = { agents: 0, stuck: 0, finishedWell: 0, calls: 0, skipped: 0 }
  let done = 0
  for (const [i, cand] of grid.candidates.entries()) {
    rows.push(rowOf(plans, cand, current, keys, i, plain, done === 0 ? totals : undefined))
    yield ++done
  }
  let cur = rows.find((r) => r.isCurrent)
  if (!cur) {
    const values = keys.map((k): [string, string] => [k, shown(optionValue(current, k))])
    cur = rowOf(plans, { config: current, values, changes: [] }, current, keys, -1, plain, done === 0 ? totals : undefined)
    yield ++done
  }
  const all = rows.includes(cur) ? rows : [...rows, cur]
  for (const r of all) {
    r.pareto = !all.some((o) => o !== r && o.fpWeight <= r.fpWeight && o.caught >= r.caught && (o.fpWeight < r.fpWeight || o.caught > r.caught))
  }
  rows.sort(compareRows)
  const currentRank = rows.includes(cur) ? rows.indexOf(cur) + 1 : rows.filter((r) => compareRows(r, cur!) < 0).length + 1

  return {
    sessions: recs.length, ...(recs.length > 0 ? { from: recs[0]!.at, to: recs[recs.length - 1]!.at } : {}),
    ...totals, observed: recs.filter((r) => r.mode !== 'active').length,
    axes: grid.axes, rows, current: cur, currentRank, check,
  }
}

export function sweep(recs: Recording[], current: Config, grid: SweepGrid, plain = false): SweepResult {
  const it = sweepSteps(recs, current, grid, plain)
  let step = it.next()
  while (!step.done) step = it.next()
  return step.value
}

const MAX_VALUE_WIDTH = 28
const TOP_ROWS = 10

// The ranked table as text: the top rows and the row of the options in force, with the scoring and the limits.
export function sweepReport(r: SweepResult): string {
  if (r.sessions === 0) {
    return 'No recorded sessions. Set recordSessions (for example 20) and run some sessions first: ' +
      '/escalator replay sweep then ranks other options on what they observed.'
  }
  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`
  const out: string[] = []
  out.push(`Sweep of ${plural(r.rows.length, 'candidate')} over ${plural(r.sessions, 'recorded session')} ` +
    `(${when(r.from!)} to ${when(r.to!)} UTC): ${plural(r.agents, 'agent')}, ${r.stuck} stuck (escalated or ended badly in the recording), ` +
    `${r.finishedWell} finished well with no intervention, ${r.calls} tool results` +
    (r.skipped > 0 ? `; ${plural(r.skipped, 'agent')} skipped (recording incomplete)` : '') + '.')
  if (r.observed > 0) out.push(`Sessions in observe or baseline mode: ${r.observed} of ${r.sessions}, replayed as observe (actions only logged, the tier never changes).`)
  out.push(`Swept: ${r.axes.map((a) => `${a.key} ${a.spec} (${a.values.length})`).join(', ')}. ` +
    `In force: ${r.current.values.map(([k, v]) => `${k} ${v}`).join(', ')}.`)
  out.push(`Ranking: fewest possible false positives weighted by the highest level each reaches ` +
    `(${LEVELS.map((l) => `${l} ${FP_WEIGHT[l]}`).join(', ')}), then most stuck agents caught, then closest to the options in force, ` +
    'then fewest interventions. * marks a row no other row beats on both weighted false positives and stuck agents caught.')

  const shownRows: [number, SweepRow][] = r.rows.slice(0, TOP_ROWS).map((row, i) => [i + 1, row])
  if (r.currentRank > TOP_ROWS || !r.rows.includes(r.current)) shownRows.push([r.currentRank, r.current])
  const byLevel = (counts: Record<Level, number>): string => LEVELS.map((l) => counts[l]).join('/')
  // One column per swept option (values cut only when very long), then the scores.
  const cols: [string, number, (row: SweepRow) => string][] = r.axes.map((a, i) => {
    const value = (row: SweepRow): string => {
      const v = row.values[i]![1]
      return v.length > MAX_VALUE_WIDTH ? v.slice(0, MAX_VALUE_WIDTH - 3) + '...' : v
    }
    return [a.key, 2 + Math.max(a.key.length, ...shownRows.map(([, row]) => value(row).length)), value]
  })
  const scores: [string, (row: SweepRow) => string][] = [
    ['FP', (x) => String(x.falsePositives)],
    ['wFP', (x) => String(x.fpWeight)],
    ['FP n/c/e/s/h', (x) => byLevel(x.fpByLevel)],
    ['caught', (x) => `${x.caught}/${r.stuck}`],
    ['earlier', (x) => String(x.earlier)],
    ['later', (x) => String(x.later)],
    ['acts n/c/e/s/h', (x) => byLevel(x.interventions)],
  ]
  for (const [h, f] of scores) cols.push([h, 2 + Math.max(h.length, ...shownRows.map(([, row]) => f(row).length)), f])
  out.push('', `${lpad('#', 3)} ${cols.map(([h, w]) => lpad(h, w)).join('')}`)
  for (const [rank, row] of shownRows) {
    const mark = row.order < 0 ? '  options in force' : row.isCurrent ? '  <- options in force' : ''
    out.push(`${lpad(String(rank), 3)}${row.pareto ? '*' : ' '}${cols.map(([, w, f]) => lpad(f(row), w)).join('')}${mark}`)
  }
  out.push('', 'FP: agents that finished well with no intervention recorded and that the candidate acts on, by the highest ' +
    'level they reach (n/c/e/s/h: nudge, consult, effort, swap, human). caught: stuck agents the candidate acts on. ' +
    'earlier, later: agents whose first intervention comes earlier, or later or never, than recorded. acts: all the ' +
    'candidate\'s interventions by level.')
  out.push('', ...selfCheckLines(r.check))
  out.push('', 'Limits: the replay does not simulate the models. From the first difference on, each agent\'s recorded stream is ' +
    'replayed as it was, so an earlier or later note, consult or swap would have changed what came next. Stuck and finished ' +
    'well come from the recording (its own ladder, verifications, reviews and rework): an agent the recorded options never ' +
    'flagged and that ended well counts as fine. Start tiers, verifications and reviews are not run again.')
  return out.join('\n')
}
