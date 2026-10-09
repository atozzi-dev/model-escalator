import { expect, mock, test } from 'claude-code/testing'
import { DEFAULT_CONFIG, parseConfig } from '../hooks/config'
import { isSilent, markStall, newAgent, toolEnd, toolStart, touch } from '../hooks/detector'
import { resetState } from '../hooks/register'
import { parseSnapshot } from '../hooks/state'

const MIN = 60_000

test('stallMinutes defaults to 10 and is parsed from options', async () => {
  expect(DEFAULT_CONFIG.stallMinutes).toBe(10)
  expect(parseConfig({ stallMinutes: '3' }).stallMinutes).toBe(3)
  expect(parseConfig({ stallMinutes: 0 }).stallMinutes).toBe(10)
  expect(parseConfig({ stallMinutes: 'x' }).stallMinutes).toBe(10)
  expect(parseConfig({ stallMinutes: -4 }).stallMinutes).toBe(10)
})

test('isSilent: only a running agent past the window, once, and later when a tool call is in flight', async () => {
  const cfg = DEFAULT_CONFIG
  const s = touch(newAgent('a', 'x', 'haiku', 't'), 0)
  expect(isSilent(s, 9 * MIN, cfg)).toBeUndefined()
  expect(isSilent(s, 11 * MIN, cfg)).toBe(11 * MIN)
  expect(isSilent({ ...s, running: false }, 11 * MIN, cfg)).toBeUndefined()
  expect(isSilent(markStall(s, cfg), 99 * MIN, cfg)).toBeUndefined()
  const busy = toolStart(s, 0)
  expect(isSilent(busy, 25 * MIN, cfg)).toBeUndefined()
  expect(isSilent(busy, 31 * MIN, cfg)).toBe(31 * MIN)
  expect(isSilent(toolEnd(busy, 31 * MIN), 40 * MIN, cfg)).toBeUndefined()
  expect(isSilent(toolEnd(busy, 31 * MIN), 42 * MIN, cfg)).toBe(11 * MIN)
})

test('markStall adds the agent threshold to the score and flags it; activity clears the flag', async () => {
  const s = markStall(touch(newAgent('a', 'x', 'haiku', 't'), 0), DEFAULT_CONFIG)
  expect(s.stalled).toBe(true)
  expect(s.score).toBe(DEFAULT_CONFIG.threshold.haiku)
  const t = touch(s, 5)
  expect(t.stalled).toBe(false)
  expect(t.score).toBe(DEFAULT_CONFIG.threshold.haiku)
})

test('markStall with a tool call in flight flags the agent but leaves the score alone', async () => {
  const s = markStall(toolStart(touch(newAgent('a', 'x', 'haiku', 't'), 0), 0), DEFAULT_CONFIG)
  expect(s.stalled).toBe(true)
  expect(s.score).toBe(0)
})

test('a toolEnd never drives the in-flight count below zero', async () => {
  expect(toolEnd(touch(newAgent('a', 'x', 'haiku', 't'), 0), 1).inFlight).toBe(0)
})

test('a snapshot saved before stall tracking hydrates and is never flagged by itself', async () => {
  const old = newAgent('a', 'x', 'haiku', 't')
  const snap = parseSnapshot({
    agents: [old], ledger: {}, seenModels: {}, sessionTag: 't', mode: 'active', baseline: 'sonnet', baselinePinned: false,
  })
  expect(snap?.agents[0]?.id).toBe('a')
  expect(isSilent(snap!.agents[0]!, 999 * MIN, DEFAULT_CONFIG)).toBeUndefined()
  const bad = parseSnapshot({
    agents: [{ ...old, lastEventAt: 'x', running: 'yes', inFlight: -2, stalled: 1 }], ledger: {}, seenModels: {}, sessionTag: 't', mode: 'active', baseline: 'sonnet', baselinePinned: false,
  })
  expect(isSilent(bad!.agents[0]!, 999 * MIN, DEFAULT_CONFIG)).toBeUndefined()
})

// Fake core under the plugin, with a mocked clock. `toolMs` is how long a tool call takes.
type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

async function wire(on: any, $: any, mode: string | undefined, toolMs = 0) {
  resetState()
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, mode ? { MODEL_ESCALATOR_MODE: mode } : {})
  mock.store(on)
  const logs: string[] = []
  const toasts: string[] = []
  const statuses: string[] = []
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a1' }))
  on('tool.call', async () => {
    if (toolMs > 0) await clock.sleep(toolMs)
    return { isError: false, result: 'listed', text: 'listed' } as never
  })
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
  on('ui.log', (_$: unknown, e: any) => { logs.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  on('ui.toast', (_$: unknown, e: any) => { toasts.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  on('ui.status', (_$: unknown, e: any) => { statuses.push(String(e.text ?? e.message ?? JSON.stringify(e))); return { value: undefined } as never })
  await $.session.start({ cwd: '/work' } as never)
  const { agentId } = await $.agent.spawn({ prompt: 'p', description: 'survey the code', subagentType: 'general-purpose', model: 'haiku' } as never) as { agentId: string }
  const stalls = () => logs.filter((l) => l.includes('no activity'))
  return { clock, logs, toasts, statuses, agentId, stalls }
}

test('a silent agent is flagged once after the window, with log, status and toast', async ($, on) => {
  const w = await wire(on, $, undefined)
  await w.clock.advance(9 * MIN)
  expect(w.stalls().length).toBe(0)
  await w.clock.advance(2 * MIN)
  expect(w.stalls().length).toBe(1)
  expect(w.stalls()[0]).toContain('a1')
  expect(w.stalls()[0]).toContain('general')
  expect(w.stalls()[0]).toMatch(/1[01] min/)
  expect(w.toasts.length).toBe(1)
  expect(w.statuses.some((s) => s.includes('a1'))).toBe(true)
  await w.clock.advance(30 * MIN)
  expect(w.stalls().length).toBe(1)
  expect(w.toasts.length).toBe(1)
})

test('the stall is counted in the ledger as an intervention', async ($, on) => {
  const w = await wire(on, $, undefined)
  await w.clock.advance(11 * MIN)
  const out = await $.command.run({ command: 'escalator', args: '' } as never) as { text?: string }
  expect(out.text ?? '').toContain('stall')
})

test('the stallMinutes option sets the window', { options: { stallMinutes: 2 } }, async ($, on) => {
  const w = await wire(on, $, undefined)
  await w.clock.advance(1 * MIN)
  expect(w.stalls().length).toBe(0)
  await w.clock.advance(2 * MIN)
  expect(w.stalls().length).toBe(1)
})

test('activity clears the flag: the same agent can stall again later', async ($, on) => {
  const w = await wire(on, $, undefined)
  await w.clock.advance(11 * MIN)
  expect(w.stalls().length).toBe(1)
  await $.tool.call({ tool: 'Read', file_path: '/src/a.ts', agentId: w.agentId } as never)
  await w.clock.advance(9 * MIN)
  expect(w.stalls().length).toBe(1)
  await w.clock.advance(2 * MIN)
  expect(w.stalls().length).toBe(2)
})

test('a model request counts as activity', async ($, on) => {
  const w = await wire(on, $, undefined)
  await w.clock.advance(8 * MIN)
  await drain($.turn.step({ turnId: 't', index: 0, model: 'haiku', messageCount: 3, agentId: w.agentId } as never) as never)
  await w.clock.advance(8 * MIN)
  expect(w.stalls().length).toBe(0)
})

test('a tool call in flight is not a stall until three windows have passed', async ($, on) => {
  const w = await wire(on, $, undefined, 100 * MIN)
  const call = $.tool.call({ tool: 'Bash', command: 'npm run build', agentId: w.agentId } as never)
  await w.clock.settle()
  await w.clock.advance(25 * MIN)
  expect(w.stalls().length).toBe(0)
  await w.clock.advance(10 * MIN)
  expect(w.stalls().length).toBe(1)
  expect(w.stalls()[0]).toContain('tool call')
  await w.clock.advance(66 * MIN)
  await call
  expect(w.stalls().length).toBe(1)
})

test('a slow command that succeeds is notified and counted but gets no note', async ($, on) => {
  const w = await wire(on, $, undefined, 40 * MIN)
  const call = $.tool.call({ tool: 'Bash', command: 'npm run build', agentId: w.agentId } as never)
  await w.clock.settle()
  await w.clock.advance(31 * MIN)
  expect(w.stalls().length).toBe(1)
  expect(w.toasts.length).toBe(1)
  await w.clock.advance(10 * MIN)
  const r = await call as { context?: readonly string[] }
  expect(r.context?.length ?? 0).toBe(0)
  const out = await $.command.run({ command: 'escalator', args: '' } as never) as { text?: string }
  expect(out.text ?? '').toContain('stall')
  const next = $.tool.call({ tool: 'Read', file_path: '/src/a.ts', agentId: w.agentId } as never)
  await w.clock.settle()
  await w.clock.advance(41 * MIN)
  expect(((await next) as { context?: readonly string[] }).context?.length ?? 0).toBe(0)
})

test('an agent whose run completed is never flagged', async ($, on) => {
  const w = await wire(on, $, undefined)
  await $.turn.complete({ turnId: 'r', agentId: w.agentId, answer: 'done' } as never)
  await w.clock.advance(60 * MIN)
  expect(w.stalls().length).toBe(0)
})

test('observe mode logs the stall without a toast', async ($, on) => {
  const w = await wire(on, $, 'observe')
  await w.clock.advance(11 * MIN)
  expect(w.stalls().length).toBe(1)
  expect(w.toasts.length).toBe(0)
})

for (const mode of ['baseline', 'off']) {
  test(`${mode} mode never flags a stall`, async ($, on) => {
    const w = await wire(on, $, mode)
    await w.clock.advance(60 * MIN)
    expect(w.stalls().length).toBe(0)
    expect(w.toasts.length).toBe(0)
  })
}

test('the next tool call after a stall gets the nudge note', async ($, on) => {
  const w = await wire(on, $, undefined)
  await w.clock.advance(11 * MIN)
  const r = await $.tool.call({ tool: 'Read', file_path: '/src/a.ts', agentId: w.agentId } as never) as { context?: readonly string[] }
  expect(r.context?.length).toBe(1)
  expect(r.context?.[0]).toContain('not making progress')
})

test('in observe mode the next tool call logs the nudge it would send and sends nothing', async ($, on) => {
  const w = await wire(on, $, 'observe')
  await w.clock.advance(11 * MIN)
  const r = await $.tool.call({ tool: 'Read', file_path: '/src/a.ts', agentId: w.agentId } as never) as { context?: readonly string[] }
  expect(r.context?.length ?? 0).toBe(0)
  expect(w.logs.some((l) => l.includes('would nudge'))).toBe(true)
})
