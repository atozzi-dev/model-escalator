import { expect, mock, test } from 'claude-code/testing'
import { resetState } from '../hooks/register'
import { parseSnapshot } from '../hooks/state'

type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

function wire(on: any): void {
  resetState()
  mock.env(on, {})
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a' + ++n }))
  on('tool.call', () => ({ isError: true, result: 'Error: boom', text: 'Error: boom' }) as never)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'advice', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20000, cache_creation_input_tokens: 1000 } } as never
  })
  for (const k of ['ui.log', 'ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
}

const spawn = async ($: any, description: string): Promise<string> =>
  ((await $.agent.spawn({ prompt: 'p', description, subagentType: 'general-purpose', model: 'haiku' } as never)) as { agentId: string }).agentId

const step = ($: any, agentId?: string) =>
  drain($.turn.step({ turnId: 't' + Math.random(), index: 0, model: agentId ? 'haiku' : 'opus', messageCount: 3, ...(agentId ? { agentId } : {}) } as never) as never)

async function stuck($: any, agentId: string, calls: number): Promise<void> {
  for (let i = 0; i < calls; i++) await $.tool.call({ tool: 'Bash', command: 'npm test', agentId } as never)
}

const report = async ($: any): Promise<string> =>
  ((await $.command.run({ command: 'escalator', args: 'stats', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)) as { text: string }).text

const section = (text: string): string[] => text.split('\n').filter((l) => /^  [\w:-]+: \d+ requests/.test(l) && l.includes('agents'))

test('two agents in two categories are broken down separately and the lead is left out', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await step($)
  const a = await spawn($, 'fix the failing bug')
  const b = await spawn($, 'update the readme docs')
  await step($, a)
  await step($, a)
  await step($, b)
  const text = await report($)
  expect(text).toContain('Savings by task category')
  const rows = section(text)
  expect(rows.length).toBe(2)
  expect(rows.find((l) => l.includes('bugfix:'))).toContain('2 requests')
  expect(rows.find((l) => l.includes('docs:'))).toContain('1 requests')
  expect(rows.every((l) => l.includes('/1 agents'))).toBe(true)
})

test('an escalation is counted once per agent, however many swaps follow', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const a = await spawn($, 'fix the failing bug')
  const b = await spawn($, 'update the readme docs')
  await stuck($, a, 40)
  await step($, a)
  await step($, b)
  const rows = section(await report($))
  expect(rows.find((l) => l.includes('bugfix:'))).toContain('escalations 1/1 agents')
  expect(rows.find((l) => l.includes('docs:'))).toContain('escalations 0/1 agents')
})

test('a senior consult is charged to the category of the asking agent', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const a = await spawn($, 'fix the failing bug')
  await stuck($, a, 12)
  const rows = section(await report($))
  const bug = rows.find((l) => l.includes('bugfix:'))!
  expect(bug).toContain('0 requests, $0.01,')
})

test('the section is absent from the report until an agent has been seen', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await step($)
  expect(await report($)).not.toContain('Savings by task category')
})

test('a saved snapshot keeps good category rows and drops malformed ones', () => {
  const base = {
    agents: [], seenModels: {}, sessionTag: 'abc123', mode: 'active', baseline: 'opus', baselinePinned: false,
    ledger: { actual: 1, baselineHigh: 2, baselineLow: 2, agentSteps: 1, byTier: {}, consults: 0, consultCost: 0, interventions: {} },
  }
  const row = { steps: 2, actual: 0.5, baselineHigh: 1, baselineLow: 0.9, agents: 1, escalated: 0 }
  const snap = parseSnapshot({ ...base, ledger: { ...base.ledger, byCategory: { docs: row, bad: { steps: 'x' }, worse: 7 } } })
  expect(Object.keys(snap!.ledger.byCategory ?? {})).toEqual(['docs'])
  expect(parseSnapshot({ ...base, ledger: { ...base.ledger, byCategory: 'oops' } })!.ledger.byCategory).toBeUndefined()
  expect(parseSnapshot(base)!.ledger.byCategory).toBeUndefined()
  expect(parseSnapshot({ ...base, agents: [{ id: 'a', escCounted: 'yes' }] })!.agents[0]!.escCounted).toBeUndefined()
})
