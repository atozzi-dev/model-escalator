import { expect, mock, test } from 'claude-code/testing'
import { resetState } from '../hooks/register'
import { emptyLedger, planBlock } from '../hooks/savings'

type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

function wire(on: any): void {
  resetState()
  mock.env(on, {})
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a1' }))
  on('turn.step', async function* (_$: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20000, cache_creation_input_tokens: 1000 } } as never
  })
  for (const k of ['ui.log', 'ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
}

async function work($: any): Promise<void> {
  await $.session.start({ cwd: '/work' } as never)
  await $.agent.spawn({ prompt: 'p', description: 'fix the bug', subagentType: 'general-purpose', model: 'haiku' } as never)
  await drain($.turn.step({ turnId: 't', index: 0, model: 'haiku', messageCount: 3, agentId: 'a1' } as never) as never)
}

const report = async ($: any): Promise<string> =>
  ((await $.command.run({ command: 'escalator', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)) as { text: string }).text

const usage = (rateLimits: unknown[]) => ({ value: { startedAt: 0, context: {}, rateLimits } }) as never

test('plan data present: the report shows the used shares and the estimated saving', async ($, on) => {
  wire(on)
  on('session.usage', () => usage([{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-12T15:00:00Z' }, { kind: 'seven_day', percentUsed: 7 }]))
  await work($)
  const text = await report($)
  expect(text).toContain('Plan usage')
  expect(text).toContain('five_hour: 23.5% used')
  expect(text).toContain('seven_day: 7% used')
  expect(text).toContain('estimate')
  expect(text).toMatch(/saved about \d+% to \d+%/)
})

test('no plan data: no block', async ($, on) => {
  wire(on)
  on('session.usage', () => usage([]))
  await work($)
  const text = await report($)
  expect(text).not.toContain('Plan usage')
  expect(text).toContain('Session cost')
})

test('a failing usage call leaves the report intact', async ($, on) => {
  wire(on)
  on('session.usage', () => { throw new Error('boom') })
  await work($)
  const text = await report($)
  expect(text).not.toContain('Plan usage')
  expect(text).toContain('Session cost')
})

test('planBlock ignores malformed limits and never throws', () => {
  const l = emptyLedger()
  expect(planBlock(undefined, l)).toBe('')
  expect(planBlock('x', l)).toBe('')
  expect(planBlock([{ kind: 5 }, null, { kind: 'a', percentUsed: 'many' }], l)).toBe('')
  expect(planBlock([{ kind: 'spend_limit', percentUsed: 12 }], l)).toContain('spend_limit: 12% used')
})
