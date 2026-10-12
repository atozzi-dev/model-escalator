// Pure: the session recorder (option recordSessions). It keeps, per tracked agent, the stream of what the
// detector observes (spawn, tool results as features, model requests, ladder actions, stalls, the end of each run
// and its outcome), so a later replay can score the same stream with another configuration. Text is kept only
// where it helps a person read a recording: agent labels and error signatures, both redacted and capped. Commands,
// outputs, prompts and file paths are never kept (files and signatures are compared through a hash).
//
// The functions mutate the live recording in place: the hot path only appends to memory, and register.ts writes
// the recording to the store in batches.

import { optionValue, type Config } from './config'
import { tierOf, type Action, type Effort, type Features, type Tier } from './detector'
import { redactSecrets } from './dossier'

export const RECORDING_VERSION = 1
// Size caps, in characters of JSON text (the store measures its 4 MiB limit the same way): one session, and all
// recorded sessions together. A session over its cap drops its oldest events down to TRIM_TO of the cap.
export const SESSION_MAX_BYTES = 256 * 1024
export const TOTAL_MAX_BYTES = 1280 * 1024
export const TRIM_TO = 0.8
// Error signatures whose text is kept (redacted) per session; later ones are still compared through their hash.
export const MAX_SIG_TEXTS = 300
export const MAX_SIG_TEXT = 160
export const MAX_LABEL = 40
export const MAX_TOOL_NAME = 60

// The options a replay needs to rebuild the configuration a session ran with, by their user-facing names.
export const RECORDED_OPTIONS = [
  'thresholdHaiku', 'thresholdSonnet', 'thresholdOpus', 'graceSteps', 'levels', 'effortStep', 'effortBoost', 'maxTier',
  'oscillationEdits', 'idleSteps', 'idleWeight', 'stallMinutes', 'maxConsultsPerAgent', 'maxConsultsPerSession',
  'consultBudgetUsd', 'deescalateAfter', 'pauseAtHuman', 'minReviewScore',
] as const

export type RecordedMode = 'active' | 'observe' | 'baseline'

// `cut`: some of the agent's events were dropped (size cap, reset, reload): a replay skips it.
export type RecAgent = { id: string; label: string; cat: string; tier: Tier; cut?: true }

// Times (`at`) are milliseconds since the recording started; `d` is how long a tool call or a model request ran,
// so it started at `at - d`. `a` is the agent's index in `agents`. `w: 1` marks what observe mode only logged.
export type RecEvent =
  | { k: 'boot'; at: number; o?: Record<string, unknown> }                            // session start or module reload; o: options changed
  | { k: 'spawn'; a: number; at: number; asked: Tier; tier: Tier; x?: 1 }              // x: an explicit model kept
  // env: refused by the environment before it ran (no n, s, f or e then); g: the agent's assistant message it belongs to
  | { k: 'tool'; a: number; at: number; d: number; t: string; n?: number; s?: string; f?: number[]; e?: string; env?: 1; g?: number }
  | { k: 'step'; a: number; at: number; d: number; m: Tier; ef?: Effort | number; u?: [number, number, number, number] }
  | { k: 'act'; a: number; at: number; act: Action; lvl: number; tier: Tier; w?: 1 }   // a ladder action taken
  | { k: 'deesc'; a: number; at: number; tier: Tier; w?: 1 }
  | { k: 'consult'; a: number; at: number; ok: boolean; c: number }                   // a senior consult and its cost
  | { k: 'help'; a: number; at: number; g?: 1 }                                         // ask_for_help; g: granted
  | { k: 'manual'; a: number; at: number; act: 'consult' | 'swap' }                    // consult now / swap now
  | { k: 'stall'; a: number; at: number }
  | { k: 'resume'; a: number; at: number }
  | { k: 'refused'; at: number; tier: Tier }                                            // a swap target the account refused
  | { k: 'end'; a: number; at: number; esc?: boolean; ab?: 1 }                          // turn.complete; ab: aborted
  | { k: 'verify'; a: number; at: number; ok: boolean }
  | { k: 'review'; a: number; at: number; score: number; c: number }
  | { k: 'rework'; a: number; at: number }

export type Recording = {
  v: typeof RECORDING_VERSION
  id: string                       // the session's tag
  at: number                       // clock time the recording started
  mode: RecordedMode
  baseline: Tier
  opts: Record<string, unknown>    // RECORDED_OPTIONS as they were in force
  agents: RecAgent[]
  sigs: Record<string, string>     // error signature text by hash, redacted (the first MAX_SIG_TEXTS only)
  events: RecEvent[]
  dropped: number                  // events dropped to stay under the size cap
}

// The recording being written, with what makes appending cheap: agent indexes, the latest time, the number of
// signature texts and the recording's size as JSON text, kept up to date event by event.
export type Live = { rec: Recording; ix: Map<string, number>; last: number; sigCount: number; bytes: number }

export const sizeOf = (v: unknown): number => JSON.stringify(v).length

// A 53-bit string hash (cyrb53), base 36: equal inputs give equal keys, and a collision within one session is
// practically impossible. Used for error signatures and file paths, which are only ever compared.
export function hashKey(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

export function recordedOptions(c: Config): Record<string, unknown> {
  return Object.fromEntries(RECORDED_OPTIONS.map((n) => [n, optionValue(c, n)]))
}

export function startRecording(id: string, at: number, mode: RecordedMode, baseline: Tier, opts: Record<string, unknown>): Live {
  const rec: Recording = { v: RECORDING_VERSION, id, at, mode, baseline, opts, agents: [], sigs: {}, events: [], dropped: 0 }
  return { rec, ix: new Map(), last: 0, sigCount: 0, bytes: sizeOf(rec) }
}

// A recording read back from the store (after a module reload) to keep appending to it.
export function resumeRecording(rec: Recording): Live {
  const ix = new Map<string, number>()
  rec.agents.forEach((a, i) => ix.set(a.id, i))
  const last = rec.events.reduce((m, e) => Math.max(m, e.at), 0)
  const live: Live = { rec, ix, last, sigCount: Object.keys(rec.sigs).length, bytes: sizeOf(rec) }
  if (live.bytes > SESSION_MAX_BYTES) trim(live)
  return live
}

// Milliseconds since the recording started; the last recorded time when the clock could not be read.
export function relTime(live: Live, now: number | undefined): number {
  return now === undefined || !Number.isFinite(now) ? live.last : Math.max(0, Math.round(now - live.rec.at))
}

const span = (start: number | undefined, end: number | undefined): number =>
  start === undefined || end === undefined ? 0 : Math.max(0, Math.round(end - start))

export function indexOf(live: Live, id: string): number | undefined {
  return live.ix.get(id)
}

// The agent's index, adding it on first sight. `label` is the agent's name (redacted, capped), else its category.
export function addAgent(live: Live, a: { id: string; label: string; cat: string; tier: Tier }, cut = false): number {
  const known = live.ix.get(a.id)
  if (known !== undefined) return known
  const flat = redactSecrets(String(a.label ?? '')).replace(/\s+/g, ' ').trim()
  const label = (flat || String(a.cat)).slice(0, MAX_LABEL)
  const entry: RecAgent = { id: String(a.id).slice(0, 80), label, cat: String(a.cat).slice(0, 80), tier: a.tier, ...(cut ? { cut: true as const } : {}) }
  live.rec.agents.push(entry)
  live.bytes += sizeOf(entry) + (live.rec.agents.length > 1 ? 1 : 0)
  const i = live.rec.agents.length - 1
  live.ix.set(a.id, i)
  return i
}

// Appends one event and keeps the recording under its cap.
export function push(live: Live, ev: RecEvent): void {
  live.rec.events.push(ev)
  live.bytes += sizeOf(ev) + (live.rec.events.length > 1 ? 1 : 0)
  if (ev.at > live.last) live.last = ev.at
  if (live.bytes > SESSION_MAX_BYTES) trim(live)
}

// Drops the oldest events (boot marks stay: the replay needs the stall timer's phase) until the recording is at
// TRIM_TO of its cap. Every agent that lost an event is marked cut.
function trim(live: Live): void {
  const rec = live.rec
  const target = SESSION_MAX_BYTES * TRIM_TO
  const kept: RecEvent[] = []
  for (const ev of rec.events) {
    if (live.bytes > target && ev.k !== 'boot') {
      live.bytes -= sizeOf(ev) + 1
      rec.dropped++
      if ('a' in ev && rec.agents[ev.a]) rec.agents[ev.a]!.cut = true
    } else kept.push(ev)
  }
  rec.events = kept
  // The cut marks and the dropped count changed the header a little: measure once.
  live.bytes = sizeOf(rec)
}

// The readable text of an error signature: Unix paths are already gone (normalizeError); Windows drive and UNC paths
// go too, then secrets are redacted. Only the text kept for people: the hash is taken of the signature itself.
export function sigText(sig: string): string {
  const noPaths = sig.replace(/\b[A-Za-z]:[\\/][^\s'"`:;,)]*/g, '<path>').replace(/\\\\[^\s'"`:;,)]+/g, '<path>')
  return redactSecrets(noPaths).slice(0, MAX_SIG_TEXT)
}

// One tool result of an agent, as features. The error signature's text is kept once per session, redacted.
export function toolEvent(live: Live, a: number, end: number | undefined, start: number | undefined, tool: string, f: Features): RecEvent {
  const ev: Extract<RecEvent, { k: 'tool' }> = { k: 'tool', a, at: relTime(live, end), d: span(start, end), t: String(tool).slice(0, MAX_TOOL_NAME) }
  if (f.env) ev.env = 1
  if (f.attempts > 0) {
    ev.n = f.attempts
    const s = hashKey(f.sig)
    ev.s = s
    if (live.rec.sigs[s] === undefined && live.sigCount < MAX_SIG_TEXTS) {
      live.rec.sigs[s] = sigText(f.sig)
      live.sigCount++
      live.bytes += sizeOf(s) + 1 + sizeOf(live.rec.sigs[s]) + (live.sigCount > 1 ? 1 : 0)
    }
  }
  if (f.counts.length > 0) ev.f = f.counts.slice(0, 50)
  if (f.edit !== undefined) ev.e = hashKey(f.edit)
  if (f.group !== undefined) ev.g = f.group
  return ev
}

type StepUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

// One model request of an agent: the tier it ran on, its own effort (before any raise) and its usage.
export function stepEvent(live: Live, a: number, end: number | undefined, start: number | undefined, model: string | undefined,
  effort: Effort | number | null, usage: StepUsage | undefined): RecEvent {
  const ev: Extract<RecEvent, { k: 'step' }> = { k: 'step', a, at: relTime(live, end), d: span(start, end), m: tierOf(model) }
  if (effort !== null && effort !== undefined) ev.ef = effort
  if (usage) ev.u = [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens]
  return ev
}

const TIERS: readonly string[] = ['haiku', 'sonnet', 'opus']

function isRecording(v: unknown): v is Recording {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return r.v === RECORDING_VERSION && typeof r.id === 'string' && typeof r.at === 'number' && Number.isFinite(r.at)
    && (r.mode === 'active' || r.mode === 'observe' || r.mode === 'baseline') && TIERS.includes(r.baseline as string)
    && typeof r.opts === 'object' && r.opts !== null && Array.isArray(r.agents) && Array.isArray(r.events)
    && typeof r.sigs === 'object' && r.sigs !== null
    && r.agents.every((a) => typeof a === 'object' && a !== null && typeof (a as RecAgent).id === 'string' && TIERS.includes((a as RecAgent).tier))
}

// The recordings in the store, oldest first; anything malformed (or of another format version) is left out.
export function parseRecordings(v: unknown): Recording[] {
  if (!Array.isArray(v)) return []
  return v.filter(isRecording).map((r) => ({ ...r, dropped: typeof r.dropped === 'number' ? r.dropped : 0 }))
}

// What goes back to the store: the stored recordings with `current` in place of its older copy (or appended),
// the newest `keep` of them, then the oldest dropped until the total fits TOTAL_MAX_BYTES. `current` always stays.
export function mergeRecordings(stored: unknown, current: Recording, keep: number): Recording[] {
  const list = [...parseRecordings(stored).filter((r) => r.id !== current.id), current].slice(-Math.max(1, keep))
  const sizes = list.map(sizeOf)
  let total = sizes.reduce((n, s) => n + s, 0)
  while (total > TOTAL_MAX_BYTES && list.length > 1) {
    list.shift()
    total -= sizes.shift()!
  }
  return list
}
