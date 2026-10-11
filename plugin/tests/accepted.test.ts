import { expect, mock, test } from 'claude-code/testing'
import { parseConfig } from '../hooks/config'
import { categorize, formatStats, type Cell, type Stats } from '../hooks/learning'
import { resetState } from '../hooks/register'
import { REVIEW_SYSTEM } from '../hooks/review'

type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

const CAT = categorize('general-purpose', 'add loader cache')
const NOW = 1_000_000_000_000

const usage = (input: number, model?: string) => ({ ...(model ? { model } : {}), input_tokens: input, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
const answered = (text: string, input = 1000) => ({ isAnswered: true, text, usage: usage(input) })
const okDiff = { exitCode: 0, stdout: ' a.ts | 2 +-\n\ndiff --git a/a.ts b/a.ts\n-old\n+new', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

type H = { data: Record<string, unknown>; logs: string[]; spawned: string[]; reviews: number }

function wire(on: any, opts: {
  stats?: Stats
  review?: () => unknown | Promise<unknown>
  proc?: (argv: readonly string[]) => unknown
  senior?: () => unknown
} = {}): H {
  resetState()
  mock.clock(on, { now: NOW })
  mock.env(on, {})
  const h: H = { data: opts.stats ? { stats: opts.stats } : {}, logs: [], spawned: [], reviews: 0 }
  on('store.get', (_$: unknown, e: any) => ({ value: h.data[e.key] }))
  on('store.set', (_$: unknown, e: any) => { h.data[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: unknown, e: any) => { delete h.data[e.key]; return { value: undefined } })
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => { h.spawned.push(e.model); return { model: e.model ?? 'haiku', agentId: 'a' + ++n } })
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage(100_000, e.model) } as never
  })
  on('process.run', async (_$: unknown, e: any) => ({ value: await (opts.proc ?? (() => okDiff))(e.argv) }) as never)
  on('model.complete', async (_$: unknown, e: any) => {
    if (e.system === REVIEW_SYSTEM) {
      h.reviews++
      return { value: await (opts.review ?? (() => answered('SCORE: 4\n- fine', 2_000_000)))() } as never
    }
    return { value: opts.senior ? opts.senior() : answered('advice', 1_000_000) } as never
  })
  on('ui.log', (_$: unknown, e: any) => { h.logs.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  for (const k of ['ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return h
}

const sleep = (ms: number) => new Promise<void>((r) => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown }).setTimeout(r, ms))
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !cond(); i++) await sleep(10)
  await sleep(40)
}

const cell = (h: H, tier = 'haiku'): Cell | undefined => ((h.data.stats as Stats | undefined)?.[CAT] as Record<string, Cell> | undefined)?.[tier]
const spawn = async ($: any, model = 'haiku'): Promise<string> =>
  ((await $.agent.spawn({ prompt: 'add a cache to the loader', description: 'add loader cache', subagentType: 'general-purpose', model } as never)) as { agentId: string }).agentId
const finish = ($: any, id: string) => $.turn.complete({ turnId: 't-' + id, agentId: id, answer: 'x' } as never)
const step = ($: any, id: string, model = 'haiku') => drain($.turn.step({ turnId: 't-' + id, index: 0, model, messageCount: 2, agentId: id } as never) as never)
const near = (a: number | undefined, b: number): boolean => a !== undefined && Math.abs(a - b) < 1e-6

const RATE = { reviewRate: 1 }

test('options: learnByCost defaults on, minReviewScore defaults to 3 and stays within 1-5', () => {
  const d = parseConfig({})
  expect(d.learnByCost).toBe(true)
  expect(d.minReviewScore).toBe(3)
  expect(parseConfig({ learnByCost: false }).learnByCost).toBe(false)
  expect(parseConfig({ learnByCost: 'false' }).learnByCost).toBe(false)
  expect(parseConfig({ learnByCost: 'x' }).learnByCost).toBe(true)
  expect(parseConfig({ minReviewScore: 4 }).minReviewScore).toBe(4)
  expect(parseConfig({ minReviewScore: '2' }).minReviewScore).toBe(2)
  for (const bad of [0, 6, -1, 'x', '', null]) expect(parseConfig({ minReviewScore: bad }).minReviewScore).toBe(3)
})

test('a late low review moves the run to not accepted, once', { options: RATE }, async ($, on) => {
  let release: (v: unknown) => void = () => undefined
  const gate = new Promise((r) => { release = r })
  const h = wire(on, { review: () => gate.then(() => answered('SCORE: 2\n- weakens a test')) })
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await finish($, id)
  await until(() => cell(h)?.runs === 1)
  expect(cell(h)!.notAccepted).toBe(0)
  expect(cell(h)!.reviews).toBeUndefined()
  release(undefined)
  await until(() => cell(h)?.reviews === 1)
  expect(cell(h)!.runs).toBe(1)
  expect(cell(h)!.notAccepted).toBe(1)
  expect(cell(h)!.reviewScore).toBe(2)
  // Another run of the same agent is its own run: nothing flips twice.
  await sleep(60)
  expect(cell(h)!.notAccepted).toBe(1)
})

test('a late good review leaves the run accepted', { options: RATE }, async ($, on) => {
  let release: (v: unknown) => void = () => undefined
  const gate = new Promise((r) => { release = r })
  const h = wire(on, { review: () => gate.then(() => answered('SCORE: 4\n- fine')) })
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await finish($, id)
  await until(() => cell(h)?.runs === 1)
  release(undefined)
  await until(() => cell(h)?.reviews === 1)
  expect(cell(h)!.notAccepted).toBe(0)
})

test('minReviewScore raises the bar: a 3 is below a bar of 4', { options: { ...RATE, minReviewScore: 4 } }, async ($, on) => {
  let release: (v: unknown) => void = () => undefined
  const gate = new Promise((r) => { release = r })
  const h = wire(on, { review: () => gate.then(() => answered('SCORE: 3\n- needs changes')) })
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await finish($, id)
  await until(() => cell(h)?.runs === 1)
  release(undefined)
  await until(() => cell(h)?.reviews === 1)
  expect(cell(h)!.notAccepted).toBe(1)
})

test('a review that lands before the run is recorded counts the run once', { options: { ...RATE, verifyCommand: 'npm test' } }, async ($, on) => {
  let release: (v: unknown) => void = () => undefined
  const gate = new Promise((r) => { release = r })
  const h = wire(on, {
    review: () => answered('SCORE: 2\n- wrong'),
    proc: (argv) => (argv[0] === 'git' ? okDiff : gate.then(() => ({ ...okDiff, stdout: 'ok' }))),
  })
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await finish($, id)
  await until(() => cell(h)?.reviews === 1)
  expect(cell(h)!.runs).toBe(0)
  release(undefined)
  await until(() => cell(h)?.runs === 1)
  expect(cell(h)!.runs).toBe(1)
  expect(cell(h)!.notAccepted).toBe(1)
  expect(cell(h)!.reviews).toBe(1)
  expect(cell(h)!.reviewScore).toBe(2)
})

test('the recorded cost is the agent steps plus its consults, not the review', { options: RATE }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await step($, id)
  await step($, id)
  const help = await $.tool.call({ tool: 'mcp__model-escalator__ask_for_help', problem: 'stuck', agentId: id } as never) as { result?: string }
  expect(String(help.result)).toContain('advice')
  await finish($, id)
  await until(() => cell(h)?.reviews === 1)
  // Two haiku steps of 100K input tokens ($0.01 each) and one opus consult of 1M input tokens ($4); the review
  // (2M opus input tokens, $8) is measurement, not work.
  expect(h.reviews).toBe(1)
  expect(cell(h)!.costRuns).toBe(1)
  expect(near(cell(h)!.cost, 4.02)).toBe(true)
})

test('the cost of one run does not leak into the next run of the same agent', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await step($, id)
  await finish($, id)
  await until(() => cell(h)?.runs === 1)
  await step($, id)
  await step($, id)
  await finish($, id)
  await until(() => cell(h)?.runs === 2)
  expect(cell(h)!.costRuns).toBe(2)
  expect(near(cell(h)!.cost, 0.03)).toBe(true)
})

test('a run with no metered step records no cost (unknown, not zero)', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await finish($, id)
  await until(() => cell(h)?.runs === 1)
  expect(cell(h)!.cost).toBeUndefined()
  expect(cell(h)!.costRuns).toBeUndefined()
})

// haiku fails half of its runs but costs little per run; sonnet always succeeds but costs more:
// per accepted run haiku is cheaper (0.05 / (6/12) = 0.10 against 0.30 / (11/12) = 0.33).
const PRICED: Stats = {
  [CAT]: {
    haiku: { runs: 10, escalated: 5, tokens: 0, notAccepted: 5, cost: 0.5, costRuns: 10 },
    sonnet: { runs: 10, escalated: 0, tokens: 0, notAccepted: 0, cost: 3, costRuns: 10 },
  },
}

test('with enough cost data the spawn keeps the cheaper tier by cost and logs it', async ($, on) => {
  const h = wire(on, { stats: PRICED })
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'haiku')
  expect(h.spawned).toEqual(['haiku'])
  const line = h.logs.find((l) => l.includes('chosen by cost per accepted run'))
  expect(line).toBeDefined()
  expect(line!).toContain('haiku')
  expect(line!).toContain('sonnet')
})

test('learnByCost false keeps the failure-rate rule: haiku climbs to sonnet, no cost line', { options: { learnByCost: false } }, async ($, on) => {
  const h = wire(on, { stats: PRICED })
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'haiku')
  expect(h.spawned).toEqual(['sonnet'])
  expect(h.logs.some((l) => l.includes('chosen by cost'))).toBe(false)
})

test('without cost data the old rule decides and nothing is logged about cost', async ($, on) => {
  const stats: Stats = { [CAT]: { haiku: { runs: 10, escalated: 5, tokens: 0, notAccepted: 5 } } }
  const h = wire(on, { stats })
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'haiku')
  expect(h.spawned).toEqual(['sonnet'])
  expect(h.logs.some((l) => l.includes('chosen by cost'))).toBe(false)
})

test('formatStats shows the mean cost per run and per accepted run when known', () => {
  const text = formatStats(PRICED)
  expect(text).toContain('$0.05/run')
  expect(text).toContain('$0.10 per accepted')
  expect(formatStats({ [CAT]: { haiku: { runs: 3, escalated: 0, tokens: 0 } } })).not.toContain('$')
  // A mean is shown from the first priced run; the per-accepted figure needs enough data.
  const few = formatStats({ [CAT]: { haiku: { runs: 2, escalated: 0, tokens: 0, cost: 0.2, costRuns: 2 } } })
  expect(few).toContain('$0.10/run')
  expect(few).not.toContain('per accepted')
})
