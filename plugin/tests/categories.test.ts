import { expect, mock, test } from 'claude-code/testing'
import { cacheKey } from '../hooks/classify'
import { parseConfig } from '../hooks/config'
import { resetState } from '../hooks/register'

const ON = { modelCategories: true }
let nextId = 0

type Wired = { release: () => void; calls: { text: string; labels: readonly string[]; model?: string }[]; data: Record<string, unknown>; cats: string[]; logs: string[] }

// `answer` is what the fake classifier says; a function may throw to simulate a failed request.
async function wire(on: any, $: any, answer: (text: string) => string | undefined, env: Record<string, string> = {}, seed: Record<string, unknown> = {}, hold = false): Promise<Wired> {
  let release: () => void = () => {}
  const gate = hold ? new Promise<void>((r) => { release = r }) : undefined
  resetState()
  mock.clock(on, { now: 1_000_000_000_000 })
  mock.env(on, env)
  const data: Record<string, unknown> = { ...seed }
  on('store.get', (_$: unknown, e: any) => ({ value: data[e.key] }))
  on('store.set', (_$: unknown, e: any) => { data[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: unknown, e: any) => { delete data[e.key]; return { value: undefined } })
  const calls: Wired['calls'] = []
  on('model.classify', async (_$: unknown, e: any) => {
    calls.push({ text: e.text, labels: e.labels, model: e.options?.model })
    if (gate) await gate
    return { value: answer(e.text) } as never
  })
  const logs: string[] = []
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'c' + ++nextId }))
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('ui.log', (_$: unknown, e: any) => { logs.push(String(e.message ?? e.text ?? '')); return { value: undefined } as never })
  for (const k of ['ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/work' } as never)
  return { release, calls, data, cats: [], logs }
}

async function spawn($: any, description: string, prompt = 'please do the thing', extra: Record<string, unknown> = {}) {
  return await $.agent.spawn({ prompt, description, subagentType: 'general-purpose', model: 'haiku', ...extra } as never) as { agentId: string }
}

test('off by default: the option is false and no classification call is made', async ($, on) => {
  expect(parseConfig({}).modelCategories).toBe(false)
  expect(parseConfig({ modelCategories: 'x' }).modelCategories).toBe(false)
  expect(parseConfig({ modelCategories: true }).modelCategories).toBe(true)
  const w = await wire(on, $, () => 'feature')
  await spawn($, 'build the widget')
  expect(w.calls.length).toBe(0)
  expect(w.data.categories).toBe(undefined)
})

test('on: one call with the labels and a short input, then the label is cached', { options: ON }, async ($, on) => {
  const w = await wire(on, $, () => 'feature')
  await spawn($, 'build the widget', 'please build the widget with care')
  expect(w.calls.length).toBe(1)
  expect(w.calls[0]!.model).toBe('haiku')
  expect(w.calls[0]!.labels.includes('feature')).toBe(true)
  expect(w.calls[0]!.text.length <= 600).toBe(true)
  const stored = w.data.categories as { entries: [string, string][] }
  expect(stored.entries.length).toBe(1)
  expect(stored.entries[0]![1]).toBe('feature')
  await spawn($, 'Build the widget!', 'Please build the widget with care.')
  expect(w.calls.length).toBe(1)
})

test('the label becomes the category: type:label', { options: ON }, async ($, on) => {
  const w = await wire(on, $, () => 'review')
  const { agentId } = await spawn($, 'look over the module')
  void agentId
  await $.turn.complete({ agentId, answer: 'done' } as never)
  const stats = w.data.stats as Record<string, unknown>
  expect(Object.keys(stats)).toEqual(['general-purpose:review'])
})

test('a failed classification falls back to the keyword category and caches nothing', { options: ON }, async ($, on) => {
  const w = await wire(on, $, () => { throw new Error('api-error') })
  const { agentId } = await spawn($, 'fix db test')
  expect(w.calls.length).toBe(1)
  await $.turn.complete({ agentId, answer: 'done' } as never)
  expect(Object.keys(w.data.stats as object)).toEqual(['general-purpose:tests'])
  expect(w.data.categories).toBe(undefined)
  const again = await spawn($, 'fix db test')
  expect(again.agentId).toBeTruthy()
  expect(w.calls.length).toBe(2)
})

test('an undefined answer is not cached either', { options: ON }, async ($, on) => {
  const w = await wire(on, $, () => undefined)
  await spawn($, 'build the widget')
  expect(w.data.categories).toBe(undefined)
})

test("'other' keeps a specific keyword category", { options: ON }, async ($, on) => {
  const w = await wire(on, $, () => 'other')
  const { agentId } = await spawn($, 'fix db test')
  await $.turn.complete({ agentId, answer: 'done' } as never)
  expect(Object.keys(w.data.stats as object)).toEqual(['general-purpose:tests'])
})

test("'other' with no keyword match stays other", { options: ON }, async ($, on) => {
  const w = await wire(on, $, () => 'other')
  const { agentId } = await spawn($, 'zzz qqq')
  await $.turn.complete({ agentId, answer: 'done' } as never)
  expect(Object.keys(w.data.stats as object)).toEqual(['general-purpose:other'])
})

test('a cache already in the store is used without a call', { options: ON }, async ($, on) => {
  const key = cacheKey('general-purpose', 'build the widget', 'please do the thing')
  const w = await wire(on, $, () => 'docs', {}, { categories: { entries: [[key, 'ui']] } })
  const { agentId } = await spawn($, 'build the widget')
  expect(w.calls.length).toBe(0)
  await $.turn.complete({ agentId, answer: 'done' } as never)
  expect(Object.keys(w.data.stats as object)).toEqual(['general-purpose:ui'])
})

test('forks, baseline and off do not classify', { options: ON }, async ($, on) => {
  const w = await wire(on, $, () => 'feature')
  await spawn($, 'build the widget', 'p', { fork: true, subagentType: 'fork' })
  expect(w.calls.length).toBe(0)
})

test('baseline mode does not classify', { options: ON }, async ($, on) => {
  const w = await wire(on, $, () => 'feature', { MODEL_ESCALATOR_MODE: 'baseline' })
  await spawn($, 'build the widget')
  expect(w.calls.length).toBe(0)
})

test('off mode does not classify', { options: ON }, async ($, on) => {
  const w = await wire(on, $, () => 'feature', { MODEL_ESCALATOR_MODE: 'off' })
  await spawn($, 'build the widget')
  expect(w.calls.length).toBe(0)
})

test('observe mode classifies (it only measures)', { options: ON }, async ($, on) => {
  const w = await wire(on, $, () => 'feature', { MODEL_ESCALATOR_MODE: 'observe' })
  await spawn($, 'build the widget')
  expect(w.calls.length).toBe(1)
})

test('the spawn does not wait for the label: it starts at once on the keyword category and its learned tier', { options: ON }, async ($, on) => {
  // 'build the widget' is a feature by keywords; haiku keeps escalating there, so the spawn is lifted to sonnet.
  const cells = { haiku: { runs: 6, escalated: 5, tokens: 0 } }
  const w = await wire(on, $, () => 'docs', {}, { stats: { 'general-purpose:feature': cells } }, true)
  const r = await spawn($, 'build the widget') as { agentId: string; model?: string }
  expect(r.agentId).toBeTruthy()
  expect(r.model).toBe('sonnet')
  expect(w.calls.length).toBe(1) // asked, not answered: the gate is still closed
  expect(w.data.categories).toBe(undefined)
  w.release()
  await $.turn.complete({ agentId: r.agentId, answer: 'done' } as never)
  // The run is recorded under the refined label, and the label is cached for later spawns.
  expect(Object.keys(w.data.stats as object).sort()).toEqual(['general-purpose:docs', 'general-purpose:feature'])
  expect(((w.data.categories as { entries: [string, string][] }).entries[0]![1])).toBe('docs')
})

test('a later spawn of the same task uses the cached label at once', { options: ON }, async ($, on) => {
  const w = await wire(on, $, () => 'docs', {}, {}, true)
  const first = await spawn($, 'build the widget')
  w.release()
  await $.turn.complete({ agentId: first.agentId, answer: 'done' } as never)
  const second = await spawn($, 'build the widget')
  expect(w.calls.length).toBe(1)
  await $.turn.complete({ agentId: second.agentId, answer: 'done' } as never)
  const cells = (w.data.stats as Record<string, { haiku: { runs: number } }>)['general-purpose:docs']!
  expect(cells.haiku.runs).toBe(2)
})

test('a classifier that fails after the spawn leaves the keyword category', { options: ON }, async ($, on) => {
  const w = await wire(on, $, () => { throw new Error('api-error') }, {}, {}, true)
  const r = await spawn($, 'build the widget')
  w.release()
  await $.turn.complete({ agentId: r.agentId, answer: 'done' } as never)
  expect(Object.keys(w.data.stats as object)).toEqual(['general-purpose:feature'])
})

test('without the option the prompt still feeds the keyword category', async ($, on) => {
  const w = await wire(on, $, () => 'docs')
  const r = await spawn($, 'Task 9', 'Implement the export command.')
  await $.turn.complete({ agentId: r.agentId, answer: 'done' } as never)
  expect(Object.keys(w.data.stats as object)).toEqual(['general-purpose:feature'])
})
