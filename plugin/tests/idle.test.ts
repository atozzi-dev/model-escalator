import { expect, mock, test } from 'claude-code/testing'
import { DEFAULT_CONFIG, parseConfig } from '../hooks/config'
import { countStep, newAgent, observe, type AgentState } from '../hooks/detector'
import { resetState } from '../hooks/register'
import { parseSnapshot } from '../hooks/state'

const steps = (s: AgentState, n: number): AgentState => {
  for (let i = 0; i < n; i++) s = countStep(s, DEFAULT_CONFIG)
  return s
}
const fail = (text = 'Error: boom') => ({ tool: 'Bash', ok: false, text, summary: 'npm test' })

test('the idle defaults are 20 requests and 0.5 per request, and are parsed from options', async () => {
  expect(DEFAULT_CONFIG.idleSteps).toBe(20)
  expect(DEFAULT_CONFIG.idleWeight).toBe(0.5)
  expect(parseConfig({ idleSteps: '7' }).idleSteps).toBe(7)
  expect(parseConfig({ idleSteps: '0' }).idleSteps).toBe(20)
  expect(parseConfig({ idleSteps: 'x' }).idleSteps).toBe(20)
  expect(parseConfig({ idleWeight: '2' }).idleWeight).toBe(2)
  expect(parseConfig({ idleWeight: '-1' }).idleWeight).toBe(0.5)
})

test('the first twenty requests without progress add nothing', async () => {
  const s = steps(newAgent('a', 'x', 'haiku', 't'), 20)
  expect(s.stepsSinceProgress).toBe(20)
  expect(s.score).toBe(0)
})

test('from the 21st request on, each request adds the idle weight', async () => {
  expect(steps(newAgent('a', 'x', 'haiku', 't'), 21).score).toBe(0.5)
  expect(steps(newAgent('a', 'x', 'haiku', 't'), 23).score).toBe(1.5)
})

test('a tool call that makes progress resets the request counter and the score', async () => {
  let s = steps(newAgent('a', 'x', 'opus', 't'), 25)
  expect(s.score).toBe(2.5)
  s = observe(s, { tool: 'Bash', ok: true, text: '10 passed', summary: 'npm test' }).state
  expect(s.stepsSinceProgress).toBe(0)
  expect(s.score).toBe(0)
  expect(steps(s, 20).score).toBe(0)
})

test('a failing tool call is not progress: the request counter keeps running', async () => {
  let s = steps(newAgent('a', 'x', 'opus', 't'), 5)
  s = observe(s, fail('3 failed')).state
  expect(s.stepsSinceProgress).toBe(5)
})

test('a plain successful tool call is not progress either', async () => {
  let s = steps(newAgent('a', 'x', 'opus', 't'), 5)
  s = observe(s, { tool: 'Read', ok: true, text: 'file contents', summary: '/src/a.ts' }).state
  expect(s.stepsSinceProgress).toBe(5)
})

test('a snapshot saved before the request counter hydrates it as zero', async () => {
  const { stepsSinceProgress: _omit, ...old } = newAgent('a', 'x', 'haiku', 't')
  const snap = parseSnapshot({
    agents: [old], ledger: {}, seenModels: {}, sessionTag: 't', mode: 'active', baseline: 'sonnet', baselinePinned: false,
  })
  expect(snap?.agents[0]?.stepsSinceProgress).toBe(0)
  expect(countStep(snap!.agents[0]!, DEFAULT_CONFIG).stepsSinceProgress).toBe(1)
})

// Fake core for the wiring: a spawned agent makes model requests and one successful tool call.
type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

type Run = { notes: string[]; logs: string[] }

async function run(on: any, $: any, mode: string | undefined, requests: number): Promise<Run> {
  resetState()
  mock.env(on, mode ? { MODEL_ESCALATOR_MODE: mode } : {})
  mock.store(on)
  const logs: string[] = []
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a1' }))
  on('tool.call', () => ({ isError: false, result: 'listed', text: 'listed' }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20000, cache_creation_input_tokens: 1000 } } as never
  })
  on('ui.log', (_$: unknown, e: any) => { logs.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  for (const k of ['ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)

  await $.session.start({ cwd: '/work' } as never)
  const { agentId } = await $.agent.spawn({ prompt: 'p', description: 'survey the code', subagentType: 'general-purpose', model: 'haiku' } as never) as { agentId: string }
  for (let i = 0; i < requests; i++) await drain($.turn.step({ turnId: 't', index: i, model: 'haiku', messageCount: 3, agentId } as never) as never)
  const r = await $.tool.call({ tool: 'Read', file_path: '/src/a.ts', agentId } as never) as { context?: readonly string[] }
  return { notes: [...(r.context ?? [])], logs }
}

test('an agent that only makes requests gets a nudge at its next tool call once the allowance is exceeded', async ($, on) => {
  // 26 requests: 6 past the allowance, 3.0 points, which is the haiku threshold.
  const r = await run(on, $, undefined, 26)
  expect(r.notes.length).toBe(1)
  expect(r.notes[0]).toContain('repeating the same failing step')
})

test('no nudge while the requests are still within the idle allowance', async ($, on) => {
  const r = await run(on, $, undefined, 25)
  expect(r.notes.length).toBe(0)
})

test('observe mode logs the idle nudge it would send, and sends nothing', async ($, on) => {
  const r = await run(on, $, 'observe', 26)
  expect(r.notes.length).toBe(0)
  expect(r.logs.some((l) => l.includes('would nudge'))).toBe(true)
})

test('baseline mode never intervenes, however many requests pass', async ($, on) => {
  const r = await run(on, $, 'baseline', 60)
  expect(r.notes.length).toBe(0)
  expect(r.logs.some((l) => l.includes('would'))).toBe(false)
})

test('off mode never intervenes, however many requests pass', async ($, on) => {
  const r = await run(on, $, 'off', 60)
  expect(r.notes.length).toBe(0)
  expect(r.logs.some((l) => l.includes('would'))).toBe(false)
})
