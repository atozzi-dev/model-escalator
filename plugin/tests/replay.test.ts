import { expect, mock, test } from 'claude-code/testing'
import { DEFAULT_CONFIG, parseConfig } from '../hooks/config'
import { resetState } from '../hooks/register'
import { addAgent, push as recPush, recordedOptions, startRecording, type Recording } from '../hooks/recorder'
import { configOf, parseReplayArgs, REPLAY_KEYS, replayReport, replaySession, type AgentResult } from '../hooks/replay'

type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

// What each scripted agent's tool calls return, by the agent's name.
const SCRIPTS: Record<string, (i: number) => { isError: boolean; text: string }> = {
  // The same error again and again: climbs the whole ladder.
  stuck: () => ({ isError: true, text: 'TypeError: cannot read x of undefined' }),
  // Failing tests that drop now and then: some interventions, some progress.
  slow: (i) => ({ isError: false, text: `Tests: ${[5, 5, 5, 5, 5, 3, 3, 3, 3, 3, 3, 1, 1, 0][Math.min(i, 13)]} failed, 4 passed` }),
  // Mostly fine: the same error twice, far apart (below the default threshold).
  clean: (i) => (i === 3 || i === 9 ? { isError: true, text: `Error: flaky ${i}` } : { isError: false, text: 'ok' }),
}

type Harness = { store: Record<string, unknown>; clock: ReturnType<typeof mock.clock> }

function wire(on: any, env: Record<string, string> = {}): Harness {
  resetState()
  mock.env(on, env)
  const h: Harness = { store: {}, clock: mock.clock(on, { now: 7_000_000 }) }
  on('store.get', (_$: unknown, e: any) => ({ value: h.store[e.key] }))
  on('store.set', (_$: unknown, e: any) => { h.store[e.key] = JSON.parse(JSON.stringify(e.value)); return { value: undefined } })
  on('store.delete', (_$: unknown, e: any) => { delete h.store[e.key]; return { value: undefined } })
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('session.end', () => ({ sessionId: 's' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', (_$: unknown, e: any) => ({ value: { tool: `mcp__model-escalator__${e.name}` } }) as never)
  const names = new Map<string, string>()
  const calls = new Map<string, number>()
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => { const agentId = 'a' + ++n; names.set(agentId, e.name); return { model: e.model ?? 'haiku', agentId } })
  on('tool.call', (_$: unknown, e: any) => {
    const i = calls.get(e.agentId) ?? 0
    calls.set(e.agentId, i + 1)
    const r = SCRIPTS[names.get(e.agentId) ?? 'clean']!(i)
    return { isError: r.isError, result: r.text, text: r.text } as never
  })
  on('model.complete', () => ({ value: { isAnswered: true, text: 'advice' } }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 } } as never
  })
  for (const k of ['ui.log', 'ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return h
}

const runCommand = async ($: any, args: string) =>
  (await $.command.run({ command: 'escalator', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never) as { text: string }).text

// One recorded session: three agents interleaved, each a tool call per round (and a model step every fourth round), a second per round.
// Only the stuck agent needs the long run (to climb the whole ladder); the other two scripts are over after 14 and 10 rounds.
async function recordSession($: any, h: Harness, rounds = 24): Promise<Recording> {
  await $.session.start({ cwd: '/work' } as never)
  const ids: string[] = []
  for (const name of ['stuck', 'slow', 'clean']) {
    ids.push(((await $.agent.spawn({ prompt: 'p', description: 'fix the parser', subagentType: 'general-purpose', model: 'haiku', name } as never)) as { agentId: string }).agentId)
  }
  for (let i = 0; i < rounds; i++) {
    for (const [n, agentId] of ids.entries()) {
      if (i >= Math.min(rounds, [Infinity, 14, 10][n]!)) continue
      if (i % 4 === 0) await drain($.turn.step({ turnId: 't', index: i, model: 'claude-haiku-5-5', messageCount: 3, agentId, effort: 'medium' } as never) as never)
      await $.tool.call({ tool: 'Bash', command: 'npm test', agentId } as never)
    }
    await h.clock.advance(1000)
  }
  for (const agentId of ids) await $.turn.complete({ turnId: 't', agentId, answer: 'done' } as never)
  await $.session.end({ reason: 'exit' } as never)
  const all = h.store['recordings'] as Recording[]
  return all[all.length - 1]!
}

const ladder = (hits: AgentResult['actual']) => hits.filter((x) => ['nudge', 'consult', 'effort', 'swap', 'human'].includes(x.act))
const byLabel = (agents: AgentResult[], label: string) => agents.find((a) => a.label === label)!

// Records a whole session through the engine (about 60 hook calls) before replaying it: already cut to the turns the
// stuck agent needs to reach the human level, it still takes 4-5 s on a loaded machine, so it gets its own timeout.
test('replaying a recorded active session with its own options reproduces every recorded action', { options: { recordSessions: 5 }, timeoutMs: 15000 }, async ($, on) => {
  const h = wire(on)
  const rec = await recordSession($, h)
  const r = replaySession(rec, configOf(rec), true)
  expect(r.agents.length).toBe(3)
  const stuck = byLabel(r.agents, 'stuck')
  expect(stuck.actual.map((x) => x.act)).toEqual(['nudge', 'consult', 'swap', 'swap', 'human'])
  for (const a of r.agents) expect(a.candidate).toEqual(a.actual)
  // The paused agent's later calls were refused live, so the stream has none of them.
  expect(stuck.pausedAtCall).toBe(stuck.actual[4]!.call)
  expect(byLabel(r.agents, 'slow').actual.length).toBeGreaterThan(0)
  expect(byLabel(r.agents, 'clean').finishedWell).toBe(true)
})

test('replaying a recorded observe session reproduces the actions it only logged', { options: { recordSessions: 5 } }, async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'observe' })
  const rec = await recordSession($, h)
  const r = replaySession(rec, configOf(rec), true)
  const stuck = byLabel(r.agents, 'stuck')
  expect(stuck.actual.length).toBeGreaterThan(3)
  for (const a of r.agents) expect(a.candidate).toEqual(a.actual)
})

test('higher thresholds intervene less and later, lower thresholds more and earlier', { options: { recordSessions: 5 } }, async ($, on) => {
  const h = wire(on)
  const rec = await recordSession($, h)
  const total = (cfg: typeof DEFAULT_CONFIG) => replaySession(rec, cfg).agents.reduce((n, a) => n + ladder(a.candidate).length, 0)
  const first = (cfg: typeof DEFAULT_CONFIG) => ladder(byLabel(replaySession(rec, cfg).agents, 'slow').candidate)[0]?.call ?? Infinity
  const same = total(DEFAULT_CONFIG)
  const high = parseConfig({ thresholdHaiku: 6, graceSteps: 6 })
  const low = parseConfig({ thresholdHaiku: 1, graceSteps: 2 })
  expect(total(high)).toBeLessThan(same)
  expect(total(low)).toBeGreaterThan(same)
  expect(first(high)).toBeGreaterThan(first(DEFAULT_CONFIG))
  expect(first(low)).toBeLessThan(first(DEFAULT_CONFIG))
  // An agent that finished well with no intervention but would be hit by the candidate is a possible false positive.
  const clean = byLabel(replaySession(rec, low).agents, 'clean')
  expect(clean.finishedWell).toBe(true)
  expect(clean.actual.length).toBe(0)
  expect(ladder(clean.candidate).length).toBeGreaterThan(0)
  const text = replayReport([rec], DEFAULT_CONFIG, { config: low, changes: ['thresholdHaiku 3 -> 1', 'graceSteps 4 -> 2'] })
  expect(text).toContain('Possible false positives')
  expect(text).toContain('clean')
})

test('agents with an incomplete recording are skipped and malformed events are ignored', { options: { recordSessions: 5 } }, async ($, on) => {
  const h = wire(on)
  const rec = await recordSession($, h, 8)
  const damaged: Recording = JSON.parse(JSON.stringify(rec))
  damaged.agents[0]!.cut = true
  damaged.events.splice(3, 0, { k: 'tool', a: 99, at: 5 } as never, { nonsense: true } as never, null as never)
  const r = replaySession(damaged, configOf(damaged), true)
  expect(r.skipped).toBe(1)
  expect(r.agents.map((a) => a.label).sort()).toEqual(['clean', 'slow'])
  for (const a of r.agents) expect(a.candidate).toEqual(a.actual)
})

test('a stall is replayed from the recorded silences, on the stall timer of the session', { options: { recordSessions: 5, stallMinutes: 1 } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const agentId = ((await $.agent.spawn({ prompt: 'p', description: 'fix the parser', subagentType: 'general-purpose', model: 'haiku', name: 'clean' } as never)) as { agentId: string }).agentId
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId } as never)
  await h.clock.advance(3 * 60_000)
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'ls', agentId } as never)
  await $.turn.complete({ turnId: 't', agentId, answer: 'done' } as never)
  await $.session.end({ reason: 'exit' } as never)
  const rec = (h.store['recordings'] as Recording[])[0]!
  expect(rec.events.some((e) => e.k === 'stall')).toBe(true)
  const r = replaySession(rec, configOf(rec), true)
  const a = r.agents[0]!
  expect(a.actual.map((x) => x.act)).toEqual(['stall', 'nudge'])
  expect(a.candidate).toEqual(a.actual)
  // A longer window sees no stall, and so no nudge either.
  expect(replaySession(rec, parseConfig({ stallMinutes: 10 })).agents[0]!.candidate).toEqual([])
})

// A hand-built observe session of one haiku agent: `tools` are its recorded tool events, one step before each.
function handBuilt(tools: Record<string, unknown>[]): Recording {
  const live = startRecording('hand', 0, 'observe', 'opus', recordedOptions(DEFAULT_CONFIG))
  const a = addAgent(live, { id: 'x', label: 'x', cat: 'c', tier: 'haiku' })
  recPush(live, { k: 'boot', at: 0 })
  recPush(live, { k: 'spawn', a, at: 1, asked: 'haiku', tier: 'haiku' })
  tools.forEach((t, i) => {
    recPush(live, { k: 'step', a, at: 10 * i + 2, d: 0, m: 'haiku' })
    recPush(live, { k: 'tool', a, at: 10 * i + 3, d: 0, t: 'Bash', ...t } as never)
  })
  recPush(live, { k: 'end', a, at: 10 * tools.length + 5 })
  return live.rec
}

test('calls the recording marks as refused by the environment are replayed as refused; older recordings replay as before', async () => {
  const refused = handBuilt(Array.from({ length: 20 }, () => ({ env: 1 })))
  expect(ladder(replaySession(refused, DEFAULT_CONFIG).agents[0]!.candidate)).toEqual([])
  // An older recording has no mark: its failed calls carry their attempts and signature, and score.
  const older = handBuilt(Array.from({ length: 20 }, () => ({ n: 1, s: 'abc' })))
  expect(ladder(replaySession(older, DEFAULT_CONFIG).agents[0]!.candidate).length).toBeGreaterThan(0)
})

test('recorded messages are replayed: parallel repeats of one failure count once', async () => {
  const calls = (withGroup: boolean) => Array.from({ length: 6 }, (_, i) => ({ n: 1, s: 'abc', ...(withGroup ? { g: 1 + Math.floor(i / 3) } : {}) }))
  expect(ladder(replaySession(handBuilt(calls(true)), DEFAULT_CONFIG).agents[0]!.candidate)).toEqual([])
  expect(ladder(replaySession(handBuilt(calls(false)), DEFAULT_CONFIG).agents[0]!.candidate).length).toBeGreaterThan(0)
})

test('arguments are checked with the same validation as the options', async () => {
  const ok = parseReplayArgs('thresholdHaiku=4 graceSteps=6 levels=nudge,swap,human', DEFAULT_CONFIG)
  if ('error' in ok) throw new Error(ok.error)
  expect(ok.config.threshold.haiku).toBe(4)
  expect(ok.config.grace).toBe(6)
  expect(ok.config.levels).toEqual(['nudge', 'swap', 'human'])
  expect(ok.changes).toEqual(['thresholdHaiku 3 -> 4', 'graceSteps 4 -> 6', 'levels nudge,consult,swap,human -> nudge,swap,human'])
  // Options not named keep the value in force, not the default.
  const layered = parseReplayArgs('graceSteps=6', parseConfig({ thresholdHaiku: 5, effortStep: true }))
  if ('error' in layered) throw new Error(layered.error)
  expect(layered.config.threshold.haiku).toBe(5)
  expect(layered.config.levels).toContain('effort')
  const off = parseReplayArgs('effortStep=false', parseConfig({ effortStep: true }))
  if ('error' in off) throw new Error(off.error)
  expect(off.config.levels).not.toContain('effort')
  const none = parseReplayArgs('', DEFAULT_CONFIG)
  if ('error' in none) throw new Error(none.error)
  expect(none.changes).toEqual([])
  for (const bad of ['graceSteps=-2', 'thresholdHaiku=abc', 'levels=nudge,teleport', 'maxTier=fable', 'pauseAtHuman=maybe', 'thresholdSonnet=']) {
    const r = parseReplayArgs(bad, DEFAULT_CONFIG)
    expect('error' in r ? r.error : '').toContain(`Invalid value for ${bad.split('=')[0]}`)
  }
  const unknown = parseReplayArgs('verifyCommand=npm', DEFAULT_CONFIG)
  expect('error' in unknown ? unknown.error : '').toContain('verifyCommand is not used by the replay')
  for (const k of REPLAY_KEYS) expect('error' in unknown ? unknown.error : '').toContain(k)
  const shape = parseReplayArgs('graceSteps', DEFAULT_CONFIG)
  expect('error' in shape ? shape.error : '').toContain('option=value')
})

test('/escalator replay without recordings says how to start, and with them prints the comparison and the self-check', { options: { recordSessions: 5 } }, async ($, on) => {
  const h = wire(on)
  expect(await runCommand($, 'replay')).toContain('No recorded sessions')
  await recordSession($, h)
  const same = await runCommand($, 'replay')
  expect(same).toContain('Candidate: the options in force')
  const check = /Self-check: .*reproduces (\d+) of (\d+) recorded interventions/.exec(same)!
  expect(Number(check[2])).toBeGreaterThan(3)
  expect(check[1]).toBe(check[2])
  expect(same).toContain('does not simulate the models')
  const nudge = /nudge\s+(\d+)\s+(\d+)/.exec(same)!
  expect(nudge[1]).toBe(nudge[2])
  const higher = await runCommand($, 'replay thresholdHaiku=8')
  expect(higher).toContain('thresholdHaiku 3 -> 8')
  const row = /swap\s+(\d+)\s+(\d+)/.exec(higher)!
  expect(Number(row[2])).toBeLessThan(Number(row[1]))
  expect(await runCommand($, 'replay graceSteps=x')).toContain('Invalid value for graceSteps')
  expect(await runCommand($, 'help')).toContain('/escalator replay')
})

test('/escalator replay sweep: no recordings, an invalid spec, and a ranked table with one recording', { options: { recordSessions: 5 } }, async ($, on) => {
  const h = wire(on)
  expect(await runCommand($, 'replay sweep thresholdHaiku=2..4')).toContain('No recorded sessions')
  expect(await runCommand($, 'replay sweep graceSteps=x')).toContain('Invalid value for graceSteps')
  expect(await runCommand($, 'replay sweep')).toContain('option=values')
  await recordSession($, h)
  const text = await runCommand($, 'replay sweep thresholdHaiku=2..4')
  expect(text).toContain('Sweep of 3 candidates over 1 recorded session')
  expect(text).toContain('Swept: thresholdHaiku 2..4 (3)')
  expect(text).toContain('Ranking:')
  expect(await runCommand($, 'help')).toContain('/escalator replay sweep')
})
