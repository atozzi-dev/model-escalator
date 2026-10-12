import { expect, mock, test } from 'claude-code/testing'
import { resetState } from '../hooks/register'
import type { RecEvent, Recording } from '../hooks/recorder'

type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

type Harness = { store: Record<string, unknown>; recordingWrites: number; clock: ReturnType<typeof mock.clock> }

const SECRET_OUTPUT = 'Error: connect failed with password=hunter2hunter2 at /srv/app/db.ts:12'

// Fake core under the plugin: spawns, a failing command, a senior model, metered steps, and a store that counts
// the writes of the recordings.
function wire(on: any, env: Record<string, string> = {}, opts: { fresh?: boolean } = {}): Harness {
  resetState()
  mock.env(on, env)
  const h: Harness = { store: {}, recordingWrites: 0, clock: mock.clock(on, { now: 5_000_000 }) }
  on('store.get', (_$: unknown, e: any) => ({ value: h.store[e.key] }))
  on('store.set', (_$: unknown, e: any) => {
    if (e.key === 'recordings') h.recordingWrites++
    h.store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.delete', (_$: unknown, e: any) => { delete h.store[e.key]; return { value: undefined } })
  // Every session.start is a new session unless the test wants the kit's state (a reload).
  if (opts.fresh) on('state.get', () => ({ value: { value: undefined, version: 0 } }) as never)
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('session.end', () => ({ sessionId: 's' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', (_$: unknown, e: any) => ({ value: { tool: `mcp__model-escalator__${e.name}` } }) as never)
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a' + ++n }))
  on('tool.call', () => ({ isError: true, result: SECRET_OUTPUT, text: SECRET_OUTPUT }) as never)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'advice' } }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20000, cache_creation_input_tokens: 1000 } } as never
  })
  for (const k of ['ui.log', 'ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return h
}

const spawn = async ($: any, name = 'fixer'): Promise<string> =>
  ((await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model: 'haiku', name } as never)) as { agentId: string }).agentId

async function work($: any, h: Harness, agentId: string, calls: number): Promise<string[]> {
  const notes: string[] = []
  for (let i = 0; i < calls; i++) {
    await drain($.turn.step({ turnId: 't', index: i, model: 'claude-haiku-5-5', messageCount: 3, agentId, effort: 'medium' } as never) as never)
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test --token=abc', agentId } as never) as { context?: readonly string[] }
    for (const c of r.context ?? []) notes.push(c)
    await h.clock.advance(1000)
  }
  return notes
}

const runCommand = async ($: any, args: string) =>
  (await $.command.run({ command: 'escalator', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never) as { text: string }).text

const recordings = (h: Harness): Recording[] => (h.store['recordings'] ?? []) as Recording[]
const kinds = (r: Recording, k: RecEvent['k']) => r.events.filter((e) => e.k === k)

test('nothing is recorded with the option off (the default)', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await work($, h, id, 12)
  await $.turn.complete({ turnId: 't', agentId: id, answer: 'done' } as never)
  await $.session.end({ reason: 'exit' } as never)
  expect(h.store['recordings']).toBe(undefined)
  expect(h.recordingWrites).toBe(0)
})

test('active mode records spawn, steps, tool features, the ladder actions taken and the end of the run', { options: { recordSessions: 5 } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  const notes = await work($, h, id, 12)
  await $.turn.complete({ turnId: 't', agentId: id, answer: 'done' } as never)
  await $.session.end({ reason: 'exit' } as never)
  const [rec] = recordings(h)
  expect(rec).toBeDefined()
  expect(rec!.v).toBe(1)
  expect(rec!.mode).toBe('active')
  expect(rec!.opts.thresholdHaiku).toBe(3)
  expect(rec!.agents).toEqual([{ id, label: 'fixer', cat: 'general-purpose:tests', tier: 'haiku' }])
  expect(kinds(rec!, 'boot').length).toBe(1)
  expect(kinds(rec!, 'spawn')).toEqual([{ k: 'spawn', a: 0, at: 0, asked: 'haiku', tier: 'haiku' }])
  const tools = kinds(rec!, 'tool') as Extract<RecEvent, { k: 'tool' }>[]
  // Calls refused by the pause are not observed, so they are not recorded either.
  expect(tools.length).toBeGreaterThan(5)
  expect(tools.every((t) => t.t === 'Bash' && t.n === 1 && typeof t.s === 'string')).toBe(true)
  const steps = kinds(rec!, 'step') as Extract<RecEvent, { k: 'step' }>[]
  expect(steps.length).toBe(12)
  expect(steps[0]).toEqual({ k: 'step', a: 0, at: 0, d: 0, m: 'haiku', ef: 'medium', u: [1000, 500, 20000, 1000] })
  // One act event per note the agent received from the ladder, in order.
  const acts = kinds(rec!, 'act') as Extract<RecEvent, { k: 'act' }>[]
  expect(acts.map((a) => a.act)).toEqual(['nudge', 'consult', 'swap', 'swap', 'human'].slice(0, notes.length))
  expect(acts.length).toBe(notes.length)
  expect(acts.every((a) => a.w === undefined)).toBe(true)
  expect(kinds(rec!, 'consult')).toEqual([expect.objectContaining({ k: 'consult', a: 0, ok: true })])
  expect(kinds(rec!, 'end')).toEqual([expect.objectContaining({ k: 'end', a: 0, esc: true })])
  // Text: the error signature, redacted; never the command line or the raw output.
  const text = JSON.stringify(rec)
  expect(text).not.toContain('hunter2')
  expect(text).not.toContain('npm test')
  expect(text).not.toContain('token=abc')
  expect(Object.values(rec!.sigs)[0]).toContain('connect failed')
})

test('observe mode marks the actions it only logged', { options: { recordSessions: 5 } }, async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'observe' })
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await work($, h, id, 20)
  await $.turn.complete({ turnId: 't', agentId: id, answer: 'done' } as never)
  await $.session.end({ reason: 'exit' } as never)
  const [rec] = recordings(h)
  expect(rec!.mode).toBe('observe')
  const acts = kinds(rec!, 'act') as Extract<RecEvent, { k: 'act' }>[]
  expect(acts.length).toBeGreaterThan(2)
  expect(acts.every((a) => a.w === 1 && a.tier === 'haiku')).toBe(true)
  expect(kinds(rec!, 'tool').length).toBe(20)
})

test('baseline mode records the stream without any ladder action, off mode records nothing', { options: { recordSessions: 5 } }, async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'baseline' })
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await work($, h, id, 10)
  await $.turn.complete({ turnId: 't', agentId: id, answer: 'done' } as never)
  await $.session.end({ reason: 'exit' } as never)
  const [rec] = recordings(h)
  expect(rec!.mode).toBe('baseline')
  expect(kinds(rec!, 'tool').length).toBe(10)
  expect(kinds(rec!, 'step').length).toBe(10)
  expect(kinds(rec!, 'act').length).toBe(0)
  expect(kinds(rec!, 'end')).toEqual([expect.objectContaining({ k: 'end', a: 0 })])
})

test('off mode records nothing', { options: { recordSessions: 5 } }, async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'off' })
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await work($, h, id, 5)
  await $.session.end({ reason: 'exit' } as never)
  expect(h.store['recordings']).toBe(undefined)
})

test('tool calls only append in memory; the store is written at the end of a run, at most every 5 s, and at session end', { options: { recordSessions: 5 } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const ids = [await spawn($, 'one'), await spawn($, 'two'), await spawn($, 'three')]
  for (const id of ids) await work($, h, id, 3)
  expect(h.recordingWrites).toBe(0)
  for (const id of ids) await $.turn.complete({ turnId: 't', agentId: id, answer: 'done' } as never)
  await h.clock.settle()
  // The first end writes at once; the two right after it share one trailing write.
  expect(h.recordingWrites).toBe(1)
  await h.clock.advance(6000)
  await h.clock.settle()
  expect(h.recordingWrites).toBe(2)
  expect(kinds(recordings(h)[0]!, 'end').length).toBe(3)
  // Session end writes what came after the last write, and nothing when nothing did.
  await work($, h, ids[0]!, 1)
  await $.session.end({ reason: 'exit' } as never)
  expect(h.recordingWrites).toBe(3)
  expect(kinds(recordings(h)[0]!, 'tool').length).toBe(10)
  await $.session.end({ reason: 'exit' } as never)
  expect(h.recordingWrites).toBe(3)
})

test('a reload keeps appending to the same recording', { options: { recordSessions: 5 } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await work($, h, id, 2)
  await $.turn.complete({ turnId: 't', agentId: id, answer: 'done' } as never)
  await h.clock.settle()
  // Reload: the snapshot is in $.state, so this session.start restores instead of starting over.
  await $.session.start({ cwd: '/work' } as never)
  await work($, h, id, 2)
  await $.session.end({ reason: 'exit' } as never)
  const all = recordings(h)
  expect(all.length).toBe(1)
  expect(kinds(all[0]!, 'boot').length).toBe(2)
  expect(kinds(all[0]!, 'tool').length).toBe(4)
  expect(all[0]!.agents.length).toBe(1)
})

test('only the newest recordSessions sessions are kept', { options: { recordSessions: 2 } }, async ($, on) => {
  const h = wire(on, {}, { fresh: true })
  for (let s = 0; s < 3; s++) {
    await $.session.start({ cwd: '/work' } as never)
    const id = await spawn($, 'worker' + s)
    await work($, h, id, 1)
    await $.session.end({ reason: 'exit' } as never)
  }
  const all = recordings(h)
  expect(all.length).toBe(2)
  expect(all.map((r) => r.agents[0]?.label)).toEqual(['worker1', 'worker2'])
})

test('/escalator reset recordings clears them and config shows the option', { options: { recordSessions: 4 } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await work($, h, id, 2)
  await $.session.end({ reason: 'exit' } as never)
  expect(recordings(h).length).toBe(1)
  h.store['stats'] = { x: 1 }
  expect(await runCommand($, 'reset recordings')).toContain('Recorded sessions cleared')
  expect(h.store['recordings']).toBe(undefined)
  expect(h.store['stats']).toBeDefined()
  expect(await runCommand($, 'config')).toContain('recordSessions: 4 (changed, default 0)')
  expect(await runCommand($, 'help')).toContain('/escalator reset recordings')
})
