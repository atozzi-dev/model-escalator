import { expect, mock, test } from 'claude-code/testing'
import type { Recording } from '../hooks/recorder'
import { resetState } from '../hooks/register'
import { parseSnapshot } from '../hooks/state'
import { newAgent } from '../hooks/detector'

type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

// Fake core: every tool call fails with the same error; `perMessage` calls follow each model request, as the
// parallel calls of one assistant message do. `reported` is how many tool uses each request's result lists.
async function run(on: any, $: any, messages: number, perMessage: number, reported = perMessage) {
  resetState()
  mock.env(on, {})
  const store: Record<string, unknown> = {}
  on('store.get', (_$: unknown, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: unknown, e: any) => { store[e.key] = JSON.parse(JSON.stringify(e.value)); return { value: undefined } })
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('session.end', () => ({ sessionId: 's' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a1' }))
  on('tool.call', () => ({ isError: true, result: 'Exit code 1\nError: cannot find module x', text: 'Exit code 1\nError: cannot find module x' }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    const toolUses = Array.from({ length: reported }, () => ({ name: 'Bash', input: { command: 'node build.js' } }))
    return { turnId: e.turnId, index: e.index, answer: '', toolUses, stopReason: 'tool_use',
      usage: { model: e.model, input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
  for (const k of ['ui.log', 'ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/work' } as never)
  const { agentId } = await $.agent.spawn({ prompt: 'p', description: 'fix the parser', subagentType: 'general-purpose', model: 'haiku' } as never) as { agentId: string }
  const notesAt: number[] = []
  let call = 0
  for (let m = 0; m < messages; m++) {
    await drain($.turn.step({ turnId: 't', index: m, model: 'claude-haiku-5-5', messageCount: 3, agentId } as never) as never)
    const results = await Promise.all(Array.from({ length: perMessage }, () =>
      $.tool.call({ tool: 'Bash', command: 'node build.js', agentId } as never) as Promise<{ context?: readonly string[] }>))
    for (const r of results) { call++; if ((r.context ?? []).length > 0) notesAt.push(call) }
  }
  await $.turn.complete({ turnId: 't', agentId, answer: 'done' } as never)
  await $.session.end({ reason: 'exit' } as never)
  return { notesAt, store }
}

test('three parallel calls failing the same way count as one failure per message', { options: { recordSessions: 5 } }, async ($, on) => {
  // One failure per message: 0.25, then 1 per repeat: the haiku threshold (3) is reached in the fourth message.
  const { notesAt, store } = await run(on, $, 4, 3)
  expect(notesAt).toEqual([10])
  // The recording keeps each call's message, so a replay groups them the same way.
  const rec = (store['recordings'] as Recording[])[0]!
  expect(rec.events.filter((e) => e.k === 'tool').map((e) => (e as { g?: number }).g)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4])
})

test('the same failures one per message climb as before', { options: { recordSessions: 5 } }, async ($, on) => {
  const { notesAt } = await run(on, $, 4, 1)
  expect(notesAt).toEqual([4])
})

test('calls beyond the tool uses a request asked for are not grouped with it', { options: { recordSessions: 5 } }, async ($, on) => {
  // The requests report no tool use: every call counts on its own, as before.
  const { notesAt, store } = await run(on, $, 4, 3, 0)
  expect(notesAt[0]).toBe(4)
  const rec = (store['recordings'] as Recording[])[0]!
  expect(rec.events.filter((e) => e.k === 'tool').every((e) => (e as { g?: number }).g === undefined)).toBe(true)
})

test('a snapshot keeps the request count and the message only when they are well formed', async () => {
  const snap = (extra: Record<string, unknown>) => parseSnapshot({
    agents: [{ ...newAgent('a', 'x', 'haiku', 't'), ...extra }], ledger: {}, seenModels: {}, sessionTag: 't', mode: 'active', baseline: 'sonnet', baselinePinned: false,
  })!.agents[0]!
  const good = { requests: 4, message: 4, messageSigs: ['E'], messageCalls: 2, messageTools: 3 }
  expect(snap(good)).toMatchObject(good)
  const bad = snap({ requests: -1, message: 'x', messageSigs: [1], messageCalls: 1.5, messageTools: null })
  for (const k of Object.keys(good)) expect(bad).not.toHaveProperty(k)
})
