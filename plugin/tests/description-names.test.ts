import { expect, mock, test } from 'claude-code/testing'
import { findAgent } from '../hooks/node-detail'
import { newAgent, MAX_AGENT_NAME } from '../hooks/detector'
import type { GraphState } from '../hooks/graph'
import { resetState } from '../hooks/register'
import { parseSnapshot } from '../hooks/state'

type Harness = { logs: string[]; lastState: unknown }

// Fake core under the plugin: spawn, a failing tool, metered steps. The last state the plugin saved is kept.
function wire(on: any): Harness {
  resetState()
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
  mock.store(on)
  const h: Harness = { logs: [], lastState: undefined }
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a' + ++n }))
  on('tool.call', () => ({ isError: true, result: 'Error: boom', text: 'Error: boom' }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
  on('state.set', (_$: unknown, e: any, next: any) => { h.lastState = e.value; return next(e) })
  on('ui.log', (_$: unknown, e: any) => { h.logs.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  return h
}

const spawn = async ($: any, description: string, name?: string, fork = false): Promise<string> =>
  ((await $.agent.spawn({ prompt: 'Fix paginate.mjs bugs in the helper', description, subagentType: 'general-purpose', model: 'haiku', ...(fork ? { fork: true } : {}), ...(name ? { name } : {}) } as never)) as { agentId: string }).agentId

async function stuck($: any, agentId: string): Promise<void> {
  for (let i = 0; i < 12; i++) await $.tool.call({ tool: 'Bash', command: 'npm test', agentId } as never)
}

const runCommand = async ($: any, args: string) =>
  (await $.command.run({ command: 'escalator', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never) as { text: string }).text

test('an unnamed agent is labelled by its description in log lines', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'Fix paginate.mjs bugs')
  await stuck($, id)
  expect(h.logs.some((l) => l.startsWith(`Fix paginate.mjs bugs (${id}) (`))).toBe(true)
  expect(h.logs.every((l) => !l.startsWith(`${id} (`))).toBe(true)
})

test('an explicit name wins over the description', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'Fix paginate.mjs bugs', 'fixer')
  await stuck($, id)
  expect(h.logs.some((l) => l.startsWith(`fixer (${id}) (`))).toBe(true)
  expect(h.logs.every((l) => !l.includes('Fix paginate.mjs'))).toBe(true)
})

test('a blank name falls back to the description', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'Fix paginate.mjs bugs', '   ')
  await stuck($, id)
  expect(h.logs.some((l) => l.startsWith(`Fix paginate.mjs bugs (${id}) (`))).toBe(true)
})

test('a long description is clipped like a name', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'd'.repeat(60))
  await stuck($, id)
  expect(h.logs.some((l) => l.startsWith(`${'d'.repeat(MAX_AGENT_NAME - 3)}... (${id}) (`))).toBe(true)
})

test('the map graph labels an unnamed agent by its description', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'Fix paginate.mjs bugs')
  const graph = parseSnapshot(h.lastState)?.graph as GraphState | undefined
  expect(graph?.nodes.find((n) => n.id === id)?.label).toBe('Fix paginate.mjs bugs')
})

test('an unnamed agent is found by its description with /escalator swap', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'a')
  const text = await runCommand($, 'swap a')
  expect(text.includes(`a (${id})`)).toBe(true)
  expect(text.startsWith('No agent')).toBe(false)
})

test('two unnamed agents with the same description are ambiguous and listed by id', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const first = await spawn($, 'twin')
  const second = await spawn($, 'twin')
  const text = await runCommand($, 'swap twin')
  expect(text).toContain('Several agents are named "twin"')
  expect(text).toContain(first)
  expect(text).toContain(second)
})

test('a fork spawn stays untracked even with a description', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'Fix paginate.mjs bugs', undefined, true)
  const graph = parseSnapshot(h.lastState)?.graph as GraphState | undefined
  expect(graph?.nodes.some((n) => n.label === 'Fix paginate.mjs bugs')).toBe(false)
})

test('findAgent matches an agent by its description, case-insensitively', () => {
  const agents = [newAgent('a1', 'tests', 'haiku', 'p'), { ...newAgent('a2', 'tests', 'haiku', 'p'), name: 'Fix paginate.mjs bugs' }]
  const found = findAgent(agents, 'fix PAGINATE.mjs bugs')
  expect('agent' in found && found.agent.id).toBe('a2')
})
