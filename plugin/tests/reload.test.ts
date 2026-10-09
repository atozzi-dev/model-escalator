import { expect, mock, test } from 'claude-code/testing'
import { resetState } from '../hooks/register'
import { parseSnapshot } from '../hooks/state'

type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

// Fake core under the plugin: spawn, failing tool, senior model, metered steps.
function wire(on: any): void {
  resetState()
  mock.env(on, {})
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a' + ++n }))
  on('tool.call', () => ({ isError: true, result: 'Error: boom', text: 'Error: boom' }) as never)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'advice' } }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20000, cache_creation_input_tokens: 1000 } } as never
  })
  on('ui.log', () => ({ value: undefined }) as never)
  for (const k of ['ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
}

async function spawn($: any): Promise<string> {
  const r = await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model: 'haiku' } as never) as { agentId: string }
  return r.agentId
}

async function stuck($: any, agentId: string, calls: number): Promise<string[]> {
  const notes: string[] = []
  for (let i = 0; i < calls; i++) {
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test', agentId } as never) as { context?: readonly string[] }
    for (const c of r.context ?? []) notes.push(c)
  }
  return notes
}

const step = ($: any, agentId?: string) =>
  drain($.turn.step({ turnId: 't', index: 0, model: 'haiku', messageCount: 3, agentId } as never) as never)

const escalator = async ($: any) =>
  (await $.command.run({ command: 'escalator', args: 'report', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never) as { text: string }).text

const agentSteps = (report: string): number => [...report.matchAll(/: (\d+) requests/g)].reduce((n, m) => n + Number(m[1]), 0)

test('a module reload keeps tracking the agent and the ledger', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  const before = await stuck($, id, 2)
  await step($, id)
  await step($, id)
  const reportBefore = await escalator($)
  expect(agentSteps(reportBefore)).toBe(2)

  // A reload: the module's variables start over, $.state is kept, session.start fires again.
  resetState()
  await $.session.start({ cwd: '/work' } as never)

  const after = await stuck($, id, 12)
  // The agent is still tracked, so it keeps climbing the ladder (a lost agent would give no notes).
  expect(before.length + after.length).toBeGreaterThan(0)
  expect(after.length).toBeGreaterThan(0)
  await step($, id)
  expect(agentSteps(await escalator($))).toBe(3)
})

test('the session tag is the same after a reload', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  const first = await stuck($, id, 12)
  expect(first.length).toBeGreaterThan(0)
  const tagOf = (note: string) => /\[supervisor:(\w+)\]/.exec(note)?.[1]
  const tag = tagOf(first[0]!)

  resetState()
  await $.session.start({ cwd: '/work' } as never)
  const id2 = await spawn($)
  // Spawn after the reload announces with the restored tag in the prompt: compare through the notes.
  const second = await stuck($, id2, 12)
  expect(second.length).toBeGreaterThan(0)
  expect(tagOf(second[0]!)).toBe(tag)
})

test('a new session starts clean', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  // Nothing persisted: no ledger, and an agent this session never spawned is not tracked.
  expect(agentSteps(await escalator($))).toBe(0)
  const notes = await stuck($, 'ghost', 12)
  expect(notes.length).toBe(0)
})

test('malformed persisted state is ignored', () => {
  expect(parseSnapshot(undefined)).toBe(undefined)
  expect(parseSnapshot({ agents: 'x' })).toBe(undefined)
  expect(parseSnapshot({ agents: [{ id: 1 }], ledger: {}, seenModels: {}, sessionTag: 'a', mode: 'active', baseline: 'opus', baselinePinned: false })).toBe(undefined)
})

test('concurrent steps of different agents are both counted', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const a = await spawn($)
  const b = await spawn($)
  await Promise.all([step($, a), step($, b), step($, a), step($, b)])
  expect(agentSteps(await escalator($))).toBe(4)

  resetState()
  await $.session.start({ cwd: '/work' } as never)
  expect(agentSteps(await escalator($))).toBe(4)
})
