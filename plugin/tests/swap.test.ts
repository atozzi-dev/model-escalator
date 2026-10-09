import { expect, mock, test } from 'claude-code/testing'
import { resetState } from '../hooks/register'

type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

type Harness = { stepModels: string[]; spawnModels: (string | undefined)[]; consults: number; logs: string[]; entries: any[]; maxTokens: number; reply: any }

// Wires the fake core under the plugin: spawn, failing tool, senior model, metered steps.
function wire(on: any, env: Record<string, string>): Harness {
  resetState()
  mock.env(on, env)
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  const h: Harness = { stepModels: [], spawnModels: [], consults: 0, logs: [], entries: [], maxTokens: 0, reply: { isAnswered: true, text: 'advice' } }
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => { h.spawnModels.push(e.model); return { model: e.model ?? 'haiku', agentId: 'a' + ++n } })
  on('tool.call', () => ({ isError: true, result: 'Error: boom', text: 'Error: boom' }) as never)
  on('model.complete', (_$: unknown, e: any) => { h.consults++; h.maxTokens = e.maxTokens; return { value: h.reply } as never })
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    h.stepModels.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20000, cache_creation_input_tokens: 1000 } } as never
  })
  on('ui.log', (_$: unknown, e: any) => { h.entries.push(e); h.logs.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  for (const k of ['ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return h
}

async function spawn($: any, model = 'haiku', description = 'fix db test'): Promise<string> {
  const r = await $.agent.spawn({ prompt: 'p', description, subagentType: 'general-purpose', model } as never) as { agentId: string }
  return r.agentId
}

async function stuck($: any, agentId: string, calls = 12): Promise<string[]> {
  const notes: string[] = []
  for (let i = 0; i < calls; i++) {
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test', agentId } as never) as { context?: readonly string[] }
    for (const c of r.context ?? []) notes.push(c)
  }
  return notes
}


test('swap uses a full model id observed earlier in the session', async ($, on) => {
  const h = wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  await drain($.turn.step({ turnId: 'm', index: 0, model: 'claude-sonnet-5-5-20261001', messageCount: 1 } as never) as never)
  const id = await spawn($)
  await stuck($, id)
  await drain($.turn.step({ turnId: 't', index: 0, model: 'haiku', messageCount: 3, agentId: id } as never) as never)
  expect(h.stepModels.at(-1)).toBe('claude-sonnet-5-5-20261001')
  expect(['sonnet', 'opus', 'haiku']).not.toContain(h.stepModels.at(-1))
})

test('unanswered senior consult logs the reason to the debug log only', async ($, on) => {
  const h = wire(on, {})
  h.reply = { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 10, output_tokens: 600 } }
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  const notes = await stuck($, id)
  expect(notes[1]).toContain('Still stuck')
  expect(h.maxTokens).toBe(2000)
  const line = h.entries.find((l) => String(l.text).includes('empty-reply'))
  expect(line).toBeDefined()
  expect(line!.to).toBe('debug')
  expect(line!.text).toContain('600')
})

test('a lead on fable never becomes the opus swap target', async ($, on) => {
  const h = wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  await drain($.turn.step({ turnId: 'm', index: 0, model: 'claude-fable-5-1', messageCount: 1 } as never) as never)
  const id = await spawn($, 'sonnet')
  await stuck($, id, 40)
  await drain($.turn.step({ turnId: 't', index: 0, model: 'sonnet', messageCount: 3, agentId: id } as never) as never)
  expect(h.stepModels.at(-1)).toBe('claude-opus-5-5')
})
