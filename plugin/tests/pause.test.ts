import { expect, mock, test } from 'claude-code/testing'
import { DEFAULT_CONFIG, parseConfig } from '../hooks/config'
import { isSilent, newAgent, pauseAgent, resumeAgent } from '../hooks/detector'
import { resetState } from '../hooks/register'
import { parseSnapshot } from '../hooks/state'

const MIN = 60_000

type Core = {
  calls: string[]; logs: string[]; toasts: string[]; statuses: string[]
  fail: { on: boolean }
  advance: (ms: number) => Promise<unknown>
}

// Fake core under the plugin: spawn, a tool that fails (or not), metered steps.
function wire(on: any, env: Record<string, string> = {}): Core {
  resetState()
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, env)
  mock.store(on)
  const core: Core = { calls: [], logs: [], toasts: [], statuses: [], fail: { on: true }, advance: (ms) => clock.advance(ms) }
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a' + ++n }))
  on('tool.call', (_$: unknown, e: any) => {
    core.calls.push(e.agentId ?? 'main')
    return core.fail.on
      ? ({ isError: true, result: 'Error: boom', text: 'Error: boom' } as never)
      : ({ isError: false, result: 'ok', text: 'ok' } as never)
  })
  on('model.complete', () => ({ value: { isAnswered: true, text: 'advice' } }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
  on('ui.log', (_$: unknown, e: any) => { core.logs.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  on('ui.toast', (_$: unknown, e: any) => { core.toasts.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  on('ui.status', (_$: unknown, e: any) => { core.statuses.push(String(e.text ?? e.message ?? JSON.stringify(e))); return { value: undefined } as never })
  return core
}

const spawn = async ($: any): Promise<string> =>
  ((await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model: 'haiku' } as never)) as { agentId: string }).agentId

type CallResult = { context?: readonly string[]; deny?: string; isError?: boolean }
const call = ($: any, agentId: string): Promise<CallResult> =>
  $.tool.call({ tool: 'Bash', command: 'npm test', agentId } as never) as Promise<CallResult>

// Drives a failing agent until the human note arrives (the levels option below keeps only that level).
async function reachHuman($: any, id: string): Promise<CallResult> {
  for (let i = 0; i < 40; i++) {
    const r = await call($, id)
    if ((r.context ?? []).some((c) => c.includes('Stop now'))) return r
  }
  throw new Error('human level not reached')
}

const escalator = async ($: any, args = ''): Promise<string> =>
  ((await $.command.run({ command: 'escalator', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)) as { text: string }).text

const HUMAN = { options: { levels: 'human' } }

test('after the human note the agent tool calls are denied with a tagged reason', HUMAN, async ($, on) => {
  const core = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  const note = await reachHuman($, id)
  expect(note.context!.join(' ')).toContain('/escalator resume')
  const before = core.calls.length
  const denied = await call($, id)
  expect(denied.deny).toMatch(/^\[supervisor:[0-9a-f]{6}\] /)
  expect(denied.deny).toContain('paused')
  expect(denied.deny).toContain('summar')
  expect(core.calls.length).toBe(before)   // the call never reached the tool
  expect((await call($, id)).deny).toBeDefined()
  expect(core.toasts.some((t) => t.includes('/escalator resume'))).toBe(true)
})

test('other agents are unaffected by a pause', HUMAN, async ($, on) => {
  const core = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const a = await spawn($)
  const b = await spawn($)
  await reachHuman($, a)
  core.fail.on = false
  expect((await call($, a)).deny).toBeDefined()
  expect((await call($, b)).deny).toBeUndefined()
  const main = await $.tool.call({ tool: 'Bash', command: 'ls' } as never) as CallResult
  expect(main.deny).toBeUndefined()
})

test('the help tool is refused while paused', HUMAN, async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await reachHuman($, id)
  const r = await $.tool.call({ tool: 'mcp__model-escalator__ask_for_help', problem: 'x', agentId: id } as never) as CallResult
  expect(r.deny).toContain('paused')
})

test('/escalator lists the paused agent with its id and category', HUMAN, async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  expect(await escalator($)).not.toContain('Paused')
  await reachHuman($, id)
  const text = await escalator($)
  expect(text).toContain('Paused')
  expect(text).toContain(id)
  expect(text).toContain('general')
  expect(text).toContain('/escalator resume')
})

test('resume <id> lets calls through and restarts the ladder on the current tier', HUMAN, async ($, on) => {
  const core = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await reachHuman($, id)
  const out = await escalator($, `resume ${id}`)
  expect(out).toContain(id)
  expect(out.toLowerCase()).toContain('resumed')
  expect(core.logs.some((l) => l.includes(id) && l.toLowerCase().includes('resumed'))).toBe(true)
  expect(await escalator($)).not.toContain('Paused')
  const r = await call($, id)
  expect(r.deny).toBeUndefined()
  expect(r.isError).toBe(true)
  // Fresh ladder: the human level is reached again only after the score builds up anew.
  const second = await reachHuman($, id)
  expect(second.context!.join(' ')).toContain('Stop now')
  expect((await call($, id)).deny).toBeDefined()
})

test('resume all resumes every paused agent', HUMAN, async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const a = await spawn($)
  const b = await spawn($)
  await reachHuman($, a)
  await reachHuman($, b)
  const out = await escalator($, 'resume all')
  expect(out).toContain(a)
  expect(out).toContain(b)
  expect((await call($, a)).deny).toBeUndefined()
  expect((await call($, b)).deny).toBeUndefined()
})

test('resume with an unknown id, nothing paused or no id says so', HUMAN, async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  expect(await escalator($, 'resume nope')).toContain('No paused agent')
  expect(await escalator($, `resume ${id}`)).toContain('not paused')
  expect(await escalator($, 'resume all')).toContain('No paused agent')
  expect(await escalator($, 'resume')).toContain('/escalator resume')
})

test('pauseAtHuman false keeps the note-only behaviour', { options: { levels: 'human', pauseAtHuman: false } }, async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await reachHuman($, id)
  expect((await call($, id)).deny).toBeUndefined()
  expect(await escalator($)).not.toContain('Paused')
})

test('observe mode never pauses', HUMAN, async ($, on) => {
  wire(on, { MODEL_ESCALATOR_MODE: 'observe' })
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  for (let i = 0; i < 30; i++) expect((await call($, id)).deny).toBeUndefined()
  expect(await escalator($)).not.toContain('Paused')
})

test('a paused agent is not flagged as stalled', HUMAN, async ($, on) => {
  const core = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await reachHuman($, id)
  await core.advance(30 * MIN)
  expect(core.logs.filter((l) => l.includes('no activity')).length).toBe(0)
  // Pure: silent for long, yet not flagged while paused; flagged again after a resume without activity.
  const s = pauseAgent({ ...newAgent('x', 'c', 'haiku', 't'), running: true, lastEventAt: 0 })
  expect(isSilent(s, 999 * MIN, DEFAULT_CONFIG)).toBeUndefined()
  expect(isSilent({ ...resumeAgent(s, 0), running: true }, 999 * MIN, DEFAULT_CONFIG)).toBeDefined()
})

test('turn.complete keeps the agent paused', HUMAN, async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await reachHuman($, id)
  await $.turn.complete({ turnId: 't', agentId: id, answer: 'summary' } as never)
  expect((await call($, id)).deny).toBeDefined()
  expect(await escalator($)).toContain(id)
})

test('the pause survives a reload', HUMAN, async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await reachHuman($, id)
  resetState()
  await $.session.start({ cwd: '/work' } as never)
  expect((await call($, id)).deny).toBeDefined()
  expect(await escalator($)).toContain(id)
})

test('pure helpers: pause and resume', () => {
  const a = { ...newAgent('x', 'c', 'sonnet', 't'), score: 5, level: 3, stepsSinceAction: 2, stepsSinceProgress: 9, errorCounts: { e: 2 }, editCounts: { f: 4 }, lastFailing: 3 }
  const p = pauseAgent(a)
  expect(p.paused).toBe(true)
  const r = resumeAgent(p, 42)
  expect(r.paused).toBeUndefined()
  expect(r.tier).toBe('sonnet')
  expect(r.score).toBe(0)
  expect(r.level).toBe(0)
  expect(r.stepsSinceAction).toBe(0)
  expect(r.stepsSinceProgress).toBe(0)
  expect(r.errorCounts).toEqual({})
  expect(r.editCounts).toEqual({})
  expect(r.lastFailing).toBeUndefined()
  expect(r.lastEventAt).toBe(42)
})

test('pauseAtHuman defaults to true and is parsed from options', () => {
  expect(DEFAULT_CONFIG.pauseAtHuman).toBe(true)
  expect(parseConfig({ pauseAtHuman: false }).pauseAtHuman).toBe(false)
  expect(parseConfig({ pauseAtHuman: 'false' }).pauseAtHuman).toBe(false)
  expect(parseConfig({ pauseAtHuman: 'true' }).pauseAtHuman).toBe(true)
  expect(parseConfig({ pauseAtHuman: 'maybe' }).pauseAtHuman).toBe(true)
})

test('snapshots: an old one hydrates unpaused, a malformed paused flag is dropped', () => {
  const base = { ledger: {}, seenModels: {}, sessionTag: 't', mode: 'active', baseline: 'sonnet', baselinePinned: false }
  const old = parseSnapshot({ ...base, agents: [newAgent('a', 'x', 'haiku', 't')] })
  expect(old?.agents[0]?.paused).toBeUndefined()
  const ok = parseSnapshot({ ...base, agents: [{ ...newAgent('a', 'x', 'haiku', 't'), paused: true }] })
  expect(ok?.agents[0]?.paused).toBe(true)
  const bad = parseSnapshot({ ...base, agents: [{ ...newAgent('a', 'x', 'haiku', 't'), paused: 'yes' }] })
  expect(bad?.agents[0]?.paused).toBeUndefined()
})
