import { expect, mock, test } from 'claude-code/testing'
import { categorize, type Cell, type Stats } from '../hooks/learning'
import { resetState } from '../hooks/register'
import { REVIEW_SYSTEM } from '../hooks/review'

// The lead continues the same agent with SendMessage: the engine raises another agent.spawn for the same agentId, with
// the follow-up message as the prompt. The agent keeps what it is (category, start tier, escalation flag); its runs
// land in the tables of the task it was given, not of the follow-up message.

const CAT = categorize('general-purpose', 'fix db test')
const NOW = 1_000_000_000_000

const usage = (input: number, model?: string) => ({ ...(model ? { model } : {}), input_tokens: input, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
const answered = (text: string) => ({ isAnswered: true, text, usage: usage(1000) })
const okDiff = { exitCode: 0, stdout: ' a.ts | 2 +-\n\ndiff --git a/a.ts b/a.ts\n-old\n+new', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

type H = { data: Record<string, unknown>; scores: number[]; reviews: number; sets: string[] }

function wire(on: any, scores: number[]): H {
  resetState()
  mock.clock(on, { now: NOW })
  mock.env(on, {})
  const h: H = { data: {}, scores, reviews: 0, sets: [] }
  on('store.get', (_$: unknown, e: any) => ({ value: h.data[e.key] }))
  on('store.set', (_$: unknown, e: any) => { h.data[e.key] = e.value; h.sets.push(e.key); return { value: undefined } })
  on('store.delete', (_$: unknown, e: any) => { delete h.data[e.key]; return { value: undefined } })
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  // Every spawn of the test is the same agent: a continued one.
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a1' }))
  on('tool.call', (_$: unknown, e: any) => (e.tool === 'Bash' ? { isError: true, result: 'Error: boom', text: 'Error: boom' } : { result: 'ok' }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('process.run', () => ({ value: okDiff }) as never)
  on('model.complete', async (_$: unknown, e: any) => {
    if (e.system === REVIEW_SYSTEM) {
      const score = h.scores[h.reviews++] ?? 4
      return { value: answered(`SCORE: ${score}\n- note`) } as never
    }
    return { value: answered('advice') } as never
  })
  on('ui.log', () => ({ value: undefined }) as never)
  for (const k of ['ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return h
}

const sleep = (ms: number) => new Promise<void>((r) => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown }).setTimeout(r, ms))
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !cond(); i++) await sleep(10)
  await sleep(10)
}

const stats = (h: H): Stats => (h.data.stats ?? {}) as Stats
const cell = (h: H, category = CAT, tier = 'haiku'): Cell | undefined => (stats(h)[category] as Record<string, Cell> | undefined)?.[tier]
const near = (a: number | undefined, b: number): boolean => a !== undefined && Math.abs(a - b) < 1e-6

const first = ($: any, model = 'haiku') =>
  $.agent.spawn({ prompt: 'make the db tests pass', description: 'fix db test', subagentType: 'general-purpose', model } as never) as Promise<{ agentId: string }>
// What SendMessage raises: the follow-up text, no description of its own, the tier the agent runs on now.
const resume = ($: any, model = 'haiku') =>
  $.agent.spawn({ prompt: 'Thanks. Now also update the changelog and the readme.', description: '', subagentType: 'general-purpose', model } as never) as Promise<{ agentId: string }>
const work = async ($: any, id: string, turnId: string) => {
  await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'old', new_string: 'new', agentId: id } as never)
  return $.turn.complete({ turnId, agentId: id, answer: 'x' } as never)
}
const stuck = async ($: any, id: string, calls = 12) => { for (let i = 0; i < calls; i++) await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: id } as never) }

test('a resumed agent keeps its category: escalated run counted once, late low review moves its run, nothing double counted', { options: { reviewRate: 1 }, timeoutMs: 15000 }, async ($, on) => {
  const h = wire(on, [4, 4, 2])
  await $.session.start({ cwd: '/work' } as never)
  const { agentId: id } = await first($)
  await work($, id, 't1')
  await until(() => h.reviews >= 1)
  // Each step runs a swap ladder and a background review: slow on a busy machine (see timeoutMs).
  // The lead continues the agent; it gets stuck and is swapped up, then finishes.
  await resume($)
  await stuck($, id)
  await work($, id, 't2')
  await until(() => h.reviews >= 2)
  // Continued again: a clean run whose review is low.
  await resume($)
  await work($, id, 't3')
  await until(() => h.reviews >= 3)

  // Everything is in the cell of the original task, nothing in a category made from the follow-up message.
  expect(Object.keys(stats(h))).toEqual([CAT])
  const c = cell(h)!
  expect(near(c.runs, 3)).toBe(true)
  expect(near(c.escalated, 1)).toBe(true)
  // One escalated run, one run moved by the low review: two not accepted, one of them a quality failure of the run's own work.
  expect(near(c.notAccepted, 2)).toBe(true)
  expect(near(c.qualityFailed, 1)).toBe(true)
  expect(near(c.reviews, 3)).toBe(true)
  expect(near(c.reviewScore, 10)).toBe(true)
})

test('a resumed agent is not counted as a new agent, and its escalation counts once in the report', { timeoutMs: 15000 }, async ($, on) => {
  wire(on, [])
  await $.session.start({ cwd: '/work' } as never)
  const { agentId: id } = await first($)
  await stuck($, id)
  await work($, id, 't1')
  await resume($)
  await stuck($, id)
  await work($, id, 't2')
  const text = ((await $.command.run({ command: 'escalator', args: 'stats', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)) as { text: string }).text
  expect(text).toContain('escalations 1/1 agents')
})
