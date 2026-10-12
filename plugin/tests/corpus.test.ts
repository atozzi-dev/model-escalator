import { expect, test } from 'claude-code/testing'
import { DEFAULT_CONFIG } from '../hooks/config'
import type { Tier } from '../hooks/detector'
import { addAgent, push, recordedOptions, startRecording, type RecEvent, type Recording } from '../hooks/recorder'
import { replaySession, type Hit } from '../hooks/replay'
import corpus from './fixtures/corpus'

// Regression corpus: real subagent runs observed with the mod, as features only (tool name, attempts, a per-agent
// signature id, failing test counts, a per-agent file id, the assistant message, refusals by the environment), with
// no text, path or name. Labels:
// - negative: 72 workers of a real project, every one of which finished its task normally;
// - positive: 20 Haiku agents of a sandbox given tasks that cannot succeed (an unsatisfiable test, a secret word);
// - control: 5 sandbox agents with easy tasks (reading a file, waiting for a command).
// Each run is replayed through the detector and the ladder with the default options, in observe mode (the tier never
// changes, so the ladder keeps climbing as long as the score does). Event times are synthetic, one second apart:
// stalls are out of scope here.

type CorpusEvent = 's' | 'h' | 'e' | { t: string; n?: number; s?: number; f?: number[]; e?: number; g?: number; env?: 1 }
type CorpusAgent = { set: string; label: 'negative' | 'positive' | 'control'; tier: Tier; events: CorpusEvent[] }
const AGENTS = (corpus as { agents: CorpusAgent[] }).agents

const LADDER = ['nudge', 'consult', 'effort', 'swap', 'human']

function recordingOf(a: CorpusAgent): Recording {
  const live = startRecording('corpus', 0, 'observe', 'opus', recordedOptions(DEFAULT_CONFIG))
  const i = addAgent(live, { id: 'x', label: a.label, cat: 'corpus', tier: a.tier })
  let at = 0
  push(live, { k: 'boot', at })
  push(live, { k: 'spawn', a: i, at: (at += 1000), asked: a.tier, tier: a.tier })
  for (const e of a.events) {
    at += 1000
    if (e === 's') push(live, { k: 'step', a: i, at, d: 0, m: a.tier })
    else if (e === 'h') push(live, { k: 'help', a: i, at })
    else if (e === 'e') push(live, { k: 'end', a: i, at })
    else {
      const ev: RecEvent = { k: 'tool', a: i, at, d: 0, t: e.t }
      if (e.n !== undefined) ev.n = e.n
      if (e.s !== undefined) ev.s = String(e.s)
      if (e.f !== undefined) ev.f = e.f
      if (e.e !== undefined) ev.e = String(e.e)
      if (e.g !== undefined) ev.g = e.g
      if (e.env === 1) ev.env = 1
      push(live, ev)
    }
  }
  return live.rec
}

const ladderOf = (a: CorpusAgent): Hit[] => replaySession(recordingOf(a), DEFAULT_CONFIG).agents[0]!.candidate.filter((h) => LADDER.includes(h.act))
const results = (label: CorpusAgent['label']) => AGENTS.filter((a) => a.label === label).map(ladderOf)
const flagged = (hits: Hit[][]) => hits.filter((h) => h.length > 0)

test('the corpus holds the observed runs: 72 negatives, 20 positives, 5 controls', async () => {
  const count = (l: string) => AGENTS.filter((a) => a.label === l).length
  expect([count('negative'), count('positive'), count('control')]).toEqual([72, 20, 5])
})

test('false positives: at most 2 of the 72 normal runs are flagged, and only with a nudge', async () => {
  const hit = flagged(results('negative'))
  expect(hit.length).toBeLessThanOrEqual(2)
  for (const h of hit) expect(h.map((x) => x.act)).toEqual(h.map(() => 'nudge'))
})

test('the easy sandbox tasks are never flagged', async () => {
  expect(flagged(results('control')).length).toBe(0)
})

test('true positives: at least 12 of the 20 impossible tasks are flagged, at least 10 up to a swap or a human', async () => {
  const hit = flagged(results('positive'))
  expect(hit.length).toBeGreaterThanOrEqual(12)
  expect(hit.filter((h) => h.some((x) => x.act === 'swap' || x.act === 'human')).length).toBeGreaterThanOrEqual(10)
})
