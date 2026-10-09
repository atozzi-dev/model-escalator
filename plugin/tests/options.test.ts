import { expect, mock, test } from 'claude-code/testing'
import { resetState } from '../hooks/register'

type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

type Harness = { consultModels: string[]; stepModels: string[] }

function wire(on: any): Harness {
  resetState()
  mock.env(on, {})
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  const h: Harness = { consultModels: [], stepModels: [] }
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a1' }))
  on('tool.call', () => ({ isError: true, result: 'Error: boom', text: 'Error: boom' }) as never)
  on('model.complete', (_$: unknown, e: any) => { h.consultModels.push(e.model); return { value: { isAnswered: true, text: 'advice' } } as never })
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    h.stepModels.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20000, cache_creation_input_tokens: 1000 } } as never
  })
  on('ui.log', () => ({ value: undefined }) as never)
  for (const k of ['ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return h
}

async function run($: any, calls: number): Promise<string[]> {
  await $.session.start({ cwd: '/work' } as never)
  const r = await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model: 'haiku' } as never) as { agentId: string }
  const notes: string[] = []
  for (let i = 0; i < calls; i++) {
    const t = await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: r.agentId } as never) as { context?: readonly string[] }
    for (const c of t.context ?? []) notes.push(c)
  }
  return notes
}

test('without options the full ladder runs and the senior is opus', async ($, on) => {
  const h = wire(on)
  const notes = await run($, 40)
  expect(notes.length).toBe(4)
  expect(h.consultModels).toEqual(['opus'])
})

test('the levels option removes the consult from the ladder', { options: { levels: 'nudge,swap,human' } }, async ($, on) => {
  const h = wire(on)
  const notes = await run($, 40)
  expect(h.consultModels.length).toBe(0)
  expect(notes.length).toBe(3)
  expect(notes[0]).toContain('Pause the repetition')
  expect(notes[1]).toContain('stronger model')
})

test('the senior model option is used for the consult', { options: { seniorModel: 'sonnet' } }, async ($, on) => {
  const h = wire(on)
  await run($, 40)
  expect(h.consultModels).toEqual(['sonnet'])
})

test('a lower threshold makes the first intervention come earlier', { options: { thresholdHaiku: 1 } }, async ($, on) => {
  wire(on)
  expect((await run($, 2)).length).toBe(1)
})

test('with the default threshold two failures do not intervene yet', async ($, on) => {
  wire(on)
  expect((await run($, 2)).length).toBe(0)
})

test('invalid options fall back to the defaults', { options: { levels: 'bogus', thresholdHaiku: -3 } }, async ($, on) => {
  const h = wire(on)
  const notes = await run($, 40)
  expect(notes.length).toBe(4)
  expect(h.consultModels).toEqual(['opus'])
})
