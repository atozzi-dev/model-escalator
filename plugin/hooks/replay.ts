// Pure: replays recorded sessions (hooks/recorder.ts) through the detector with another configuration, with no
// model call, and compares what the ladder would have done with what it did. The recorded stream is taken as it is:
// the replay does not simulate the models, so after an intervention the agent does what it did in the recording,
// not what it would have done after a different note or on a different model.

import { DEFAULT_CONFIG, optionValue, parseConfig, type Config } from './config'
import {
  afterHelp, allowedMax, canAskForHelp, consultLimit, countStep, decide, endRun, escalated, isSilent, markStall, newAgent, nextTier,
  noteProgress, pauseAgent, refuseTier, resumeAgent, revertSwap, skipGrace, tierRank, toolEnd, toolStart, touch, usableTier,
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

// Replays one session with `cfg`. With `followRecorded`, an option change the session went through (a module reload
// after /config) is applied where it happened: that is the session's own configuration, for the self-check.
// Active sessions replay as active (swaps change the tier, a human level pauses); observe and baseline sessions replay
// as observe (the tier never changes, as when observe only logs).
export function replaySession(rec: Recording, cfg: Config, followRecorded = false): SessionResult {
  const active = rec.mode === 'active'
  const events = wellFormed(rec)
  const actualMin = num(rec.opts.minReviewScore, DEFAULT_CONFIG.minReviewScore)
  let c = cfg
  const sims = new Map<number, Sim>()
  let blocked: Tier[] = []
  let consultCost = 0
  let calls = 0
  const cut = (a: number): boolean => rec.agents[a]?.cut === true

  // Recorded consult outcomes per agent, and their mean cost for consults the recording never made.
  const outcomes = new Map<number, { ok: boolean; c: number }[]>()
  let costSum = 0
  let costN = 0
  for (const e of events) {
    if (e.k !== 'consult') continue
    outcomes.set(e.a, [...(outcomes.get(e.a) ?? []), { ok: e.ok === true, c: num(e.c) }])
    costSum += num(e.c)
    costN++
  }
  const meanCost = costN > 0 ? costSum / costN : 0

  const sessionConsults = (): number => {
    let n = 0
    for (const x of sims.values()) n += x.s.consults ?? 0
    return n
  }
  const hit = (x: Sim, act: HitKind, at: number, into: 'actual' | 'candidate'): void => {
    x[into].push({ act, call: x.calls, at: Math.max(0, at - x.spawnAt) })
  }
  // A consult the replay makes: it counts like a live one, and takes the agent's next recorded outcome (a refusal
  // skips the grace window, as live). Past the recorded ones it assumes an answer at the session's mean cost.
  const consult = (x: Sim): void => {
    x.s = { ...x.s, consults: (x.s.consults ?? 0) + 1 }
    const o = x.outcomes[x.used++]
    consultCost += o ? o.c : meanCost
    if (o && !o.ok) x.s = skipGrace(x.s, c)
  }

  // Stall checks run on the session's timer: every period from the last boot (start or reload).
  const period = (): number => Math.max(1000, Math.min(30_000, (c.stallMinutes * 60_000) / 4))
  let nextTick: number | undefined
  const tick = (until: number): void => {
    while (nextTick !== undefined && nextTick < until) {
      const anyRunning = [...sims.values()].some((x) => x.s.running === true)
      if (!anyRunning) {
        // Nothing can stall: jump to the first tick at or after `until`.
        const p = period()
        nextTick += Math.ceil((until - nextTick) / p) * p
        break
      }
      for (const x of sims.values()) {
        if (isSilent(x.s, nextTick, c) === undefined) continue
        x.s = markStall(x.s, c)
        hit(x, 'stall', nextTick, 'candidate')
      }
      nextTick += period()
    }
  }

  // Starts of tool calls and model requests, by time: an agent is busy (or active) from then on.
  const starts = events
    .map((e, i) => ({ e, i, t: (e.k === 'tool' || e.k === 'step') && num(e.d) > 0 ? e.at - num(e.d) : undefined }))
    .filter((x): x is { e: RecEvent; i: number; t: number } => x.t !== undefined)
    .sort((x, y) => x.t - y.t || x.i - y.i)
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
      // A reload restarts the stall timer and forgets the calls in flight.
      nextTick = e.at + period()
      for (const x of sims.values()) x.s = { ...x.s, inFlight: 0 }
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
        const f: Features = { attempts: num(e.n), sig: typeof e.s === 'string' ? e.s : '', counts: Array.isArray(e.f) ? e.f.filter((n) => Number.isFinite(n)) : [],
          ...(typeof e.e === 'string' ? { edit: e.e } : {}), ...(e.env === 1 ? { env: true as const } : {}),
          ...(Number.isInteger(e.g) ? { group: e.g } : {}) }
        const limit = consultLimit(x.s, sessionConsults(), consultCost, c)
        const prev = x.s
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
function selfCheck(recs: Recording[]): { matched: number; total: number; agents: number; off: string[] } {
  let matched = 0
  let total = 0
  let agents = 0
  const off: string[] = []
  for (const rec of recs) {
    if (rec.mode === 'baseline') continue
    for (const a of replaySession(rec, configOf(rec), true).agents) {
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

// The comparison as text: interventions per level and per category, recorded against the candidate, the agents that
// differ most, possible false positives, and the self-check. `recs` oldest first.
export function replayReport(recs: Recording[], current: Config, candidate: { config: Config; changes: string[] }): string {
  if (recs.length === 0) {
    return 'No recorded sessions. Set recordSessions (for example 20) and run some sessions first: ' +
      '/escalator replay then compares other options on what they observed.'
  }
  const results = recs.map((r) => replaySession(r, candidate.config))
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

  const ladderOf = (h: Hit[]) => h.filter(isLadder)
  const fp = agents.filter((a) => a.finishedWell && ladderOf(a.candidate).length > 0)
  const earlier = agents.filter((a) => {
    const x = ladderOf(a.actual)[0]
    const y = ladderOf(a.candidate)[0]
    return y !== undefined && (x === undefined ? a.endedBadly : y.call < x.call)
  })
  const later = agents.filter((a) => {
    const x = ladderOf(a.actual)[0]
    const y = ladderOf(a.candidate)[0]
    return x !== undefined && (y === undefined || y.call > x.call)
  })
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

  const check = selfCheck(recs)
  out.push('', check.total === 0 && check.off.length === 0
    ? `Self-check: no recorded intervention to reproduce (${check.agents} agents).`
    : `Self-check: replaying each session with its own options reproduces ${check.matched} of ${check.total} recorded interventions` +
      (check.off.length === 0 ? '.' : `; ${check.off.length} agent${check.off.length === 1 ? '' : 's'} differ:`))
  for (const l of check.off.slice(0, 5)) out.push(`- ${l}`)

  out.push('', 'Limits: the replay does not simulate the models. After an intervention each agent does what it did in the recording, ' +
    'so an earlier or later note, consult or swap would have changed what came next. Start tiers (learning), verifications and ' +
    'reviews are not run again; consult answers are reused in order. Stalls follow the recorded times on the stall timer.')
  return out.join('\n')
}
