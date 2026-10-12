import { expect, mock, test } from 'claude-code/testing'
import { resetState } from '../hooks/register'
import { parseSnapshot } from '../hooks/state'

// A core that fails: the test kit skips a throwing core hook and the engine then reports that nothing beneath the
// plugins answered, so `next(e)` rejects there. Each core hook below fails for one marked input and answers otherwise,
// so every test can check that the mod's state is intact after a rejection and that the next call works as usual.
const MIN = 60_000
const BOOM = /no implementation for/

type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

type Harness = {
  clock: ReturnType<typeof mock.clock>
  logs: string[]
  stepModels: string[]
  snapshot: unknown
  // How many times the failing core hooks ran: a rejection must not make the engine run them again.
  failedRuns: number
}

function wire(on: any): Harness {
  resetState()
  mock.env(on, {})
  mock.store(on)
  const h: Harness = { clock: mock.clock(on, { now: 1_000_000 }), logs: [], stepModels: [], snapshot: undefined, failedRuns: 0 }
  let n = 0
  on('session.start', (_$: unknown, e: any) => {
    if (e.cwd === '/fail') throw new Error('session.start exploded')
    return { cwd: e.cwd } as never
  })
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('agent.spawn', (_$: unknown, e: any) => {
    if (String(e.prompt).includes('fail')) h.failedRuns++
    if (String(e.prompt).includes('fail')) throw new Error('agent.spawn exploded')
    return { model: e.model ?? 'haiku', agentId: 'a' + ++n }
  })
  on('tool.call', (_$: unknown, e: any) => {
    if (e.command === 'fail') h.failedRuns++
    if (e.command === 'fail') throw new Error('tool.call exploded')
    return { isError: e.command === 'npm test', result: e.command === 'npm test' ? 'Error: boom' : 'ok', text: e.command === 'npm test' ? 'Error: boom' : 'ok' } as never
  })
  on('model.complete', () => ({ value: { isAnswered: true, text: 'advice' } }) as never)
  on('turn.complete', (_$: unknown, e: any) => {
    if (e.answer === 'fail') throw new Error('turn.complete exploded')
    return { text: 'done' } as never
  })
  on('turn.step', async function* (_$: unknown, e: any) {
    if (e.messageCount === 99) throw new Error('turn.step exploded')
    h.stepModels.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
  on('session.end', (_$: unknown, e: any) => {
    if (e.reason === 'logout') throw new Error('session.end exploded')
    return { sessionId: 's1' } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('state.set', async (_$: unknown, e: any, next: any) => { h.snapshot = e.value; return next(e) })
  on('ui.log', (_$: unknown, e: any) => { h.logs.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  for (const k of ['ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return h
}

async function spawn($: any, prompt = 'p'): Promise<string> {
  const r = await $.agent.spawn({ prompt, description: 'fix db test', subagentType: 'general-purpose', model: 'haiku' } as never) as { agentId: string }
  return r.agentId
}

const rejection = async (p: Promise<unknown>): Promise<string> => {
  try { await p } catch (e) { return String((e as Error)?.message ?? e) }
  return ''
}

const agentsOf = async (h: Harness) => { await h.clock.settle(); return parseSnapshot(h.snapshot)?.agents ?? [] }

test('tool.call: a rejected call reaches the caller and leaves no tool in flight', { options: { stallMinutes: 2 } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  expect(await rejection($.tool.call({ tool: 'Bash', command: 'fail', agentId: id } as never) as never)).toMatch(BOOM)
  expect(h.failedRuns).toBe(1)
  // The next call works as usual.
  const ok = await $.tool.call({ tool: 'Bash', command: 'ls', agentId: id } as never) as { text?: string }
  expect(ok.text).toBe('ok')
  // A call that never ended would stretch the stall window three times (6 minutes) and show up as still running.
  await h.clock.advance(3 * MIN)
  const stalls = h.logs.filter((l) => l.includes('no activity'))
  expect(stalls.length).toBe(1)
  expect(stalls[0]).not.toContain('still running')
})

test('tool.call: a rejected call from outside any agent also passes through', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  expect(await rejection($.tool.call({ tool: 'Bash', command: 'fail' } as never) as never)).toMatch(BOOM)
  const ok = await $.tool.call({ tool: 'Bash', command: 'ls' } as never) as { text?: string }
  expect(ok.text).toBe('ok')
})

test('agent.spawn: a rejected spawn registers nothing, the next one is tracked', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  expect(await rejection($.agent.spawn({ prompt: 'fail', description: 'x', subagentType: 'general-purpose', model: 'haiku' } as never) as never)).toMatch(BOOM)
  expect(h.failedRuns).toBe(1)
  expect((await agentsOf(h)).length).toBe(0)
  const id = await spawn($)
  expect(id).toBe('a1')
  expect((await agentsOf(h)).map((a) => a.id)).toEqual(['a1'])
})

test('turn.step: a rejected request reaches the caller, nothing is metered, the next one is', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  expect(await rejection(drain($.turn.step({ turnId: 't', index: 0, model: 'haiku', messageCount: 99, agentId: id } as never) as never))).toMatch(BOOM)
  expect(parseSnapshot(h.snapshot)?.ledger.agentSteps ?? 0).toBe(0)
  await drain($.turn.step({ turnId: 't', index: 1, model: 'haiku', messageCount: 3, agentId: id } as never) as never)
  await h.clock.settle()
  expect(parseSnapshot(h.snapshot)?.ledger.agentSteps).toBe(1)
})

test('turn.step: a request rejected after a swap passes through and the swap still works', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  for (let i = 0; i < 12; i++) await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: id } as never)
  expect(await rejection(drain($.turn.step({ turnId: 't', index: 0, model: 'haiku', messageCount: 99, agentId: id } as never) as never))).toMatch(BOOM)
  expect(h.stepModels.length).toBe(0)
  await drain($.turn.step({ turnId: 't', index: 1, model: 'haiku', messageCount: 3, agentId: id } as never) as never)
  expect(h.stepModels).toHaveLength(1)
  expect(h.stepModels[0]).not.toBe('haiku')
})

test('turn.complete: a rejection reaches the caller and the next run is recorded', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  expect(await rejection($.turn.complete({ turnId: 'r1', agentId: id, answer: 'fail' } as never) as never)).toMatch(BOOM)
  await $.turn.complete({ turnId: 'r2', agentId: id, answer: 'done' } as never)
  expect((await agentsOf(h))[0]?.running).toBe(false)
})

test('session.start: a rejection reaches the caller and a later start works', async ($, on) => {
  const h = wire(on)
  expect(await rejection($.session.start({ cwd: '/fail' } as never) as never)).toMatch(BOOM)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  expect(id).toBe('a1')
  expect((await agentsOf(h)).length).toBe(1)
})

test('session.end: a rejection reaches the caller and a later end works', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await drain($.turn.step({ turnId: 't', index: 0, model: 'haiku', messageCount: 3, agentId: id } as never) as never)
  expect(await rejection($.session.end({ reason: 'logout' } as never) as never)).toMatch(BOOM)
  await $.session.end({ reason: 'other' } as never)
  await h.clock.settle()
})
