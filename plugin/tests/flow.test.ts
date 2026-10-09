import { expect, mock, test } from 'claude-code/testing'

test('stuck cheap agent: nudge, senior consult, then hot swap of the model', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-09T09:00:00Z') })
  mock.store(on)
  let spawned = 0
  const spawnModels: (string | undefined)[] = []
  on('agent.spawn', (_$, e) => { spawnModels.push(e.model); return { model: e.model ?? 'haiku', agentId: 'a' + ++spawned } })
  on('tool.call', () => ({ isError: true, result: 'Error: Cannot find module ./db (src/app.ts:12)', text: 'Error: Cannot find module ./db (src/app.ts:12)' }) as never)
  const seniorPrompts: string[] = []
  on('model.complete', (_$, e) => { seniorPrompts.push(e.prompt); return { value: { isAnswered: true, text: 'Check the import path: the file is db/index.ts.' } } as never })
  const stepModels: string[] = []
  on('turn.step', async function* (_$, e) {
    stepModels.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20000, cache_creation_input_tokens: 1000 } } as never
  })
  for (const k of ['ui.log', 'ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)

  const { agentId } = await $.agent.spawn({ prompt: 'Fix the failing db test', description: 'fix db test', subagentType: 'general-purpose', model: 'haiku' } as never) as { agentId: string }
  expect(agentId).toBe('a1')

  const notes: string[] = []
  for (let i = 0; i < 12; i++) {
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test', agentId } as never) as { context?: readonly string[] }
    for (const c of r.context ?? []) notes.push(c)
  }
  expect(notes.length).toBe(3)
  expect(notes[0]).toContain('not making progress')
  expect(notes[1]).toContain('db/index.ts')
  expect(seniorPrompts[0]).toContain('Cannot find module')
  expect(notes[2]).toContain('stronger model (sonnet)')

  const drain = async (st: { result: Promise<unknown> } & AsyncIterable<unknown>) => { for await (const _ of st) { /* chunks */ } return st.result }
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'haiku', messageCount: 3, agentId } as never) as never)
  expect(stepModels.at(-1)).toBe('claude-sonnet-5-5')
  await drain($.turn.step({ turnId: 'm1', index: 0, model: 'opus', messageCount: 3 } as never) as never)
  expect(stepModels.at(-1)).toBe('opus')
})

test('history of escalations upgrades the next spawn of the same kind', async ($, on) => {
  mock.store(on)
  let n = 0
  const spawnModels: (string | undefined)[] = []
  on('agent.spawn', (_$, e) => { spawnModels.push(e.model); return { model: e.model ?? 'haiku', agentId: 'b' + ++n } })
  on('tool.call', () => ({ isError: true, result: 'boom', text: 'TypeError: boom' }) as never)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'try something else' } }) as never)
  on('turn.complete', () => ({ text: 'gave up' }) as never)
  for (const k of ['ui.log', 'ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)

  for (let run = 0; run < 5; run++) {
    const { agentId } = await $.agent.spawn({ prompt: 'p', description: 'fix login bug', subagentType: 'general-purpose', model: 'haiku' } as never) as { agentId: string }
    for (let i = 0; i < 12; i++) await $.tool.call({ tool: 'Bash', command: 'npm test', agentId } as never)
    await $.turn.complete({ turnId: 'r' + run, agentId, answer: 'gave up' } as never)
  }
  await $.agent.spawn({ prompt: 'p', description: 'fix signup bug', subagentType: 'general-purpose', model: 'haiku' } as never)
  expect(spawnModels.slice(0, 5)).toEqual(['haiku', 'haiku', 'haiku', 'haiku', 'haiku'])
  expect(spawnModels[5]).toBe('sonnet')
})

test('senior consult that is not answered degrades to the generic nudge', async ($, on) => {
  mock.store(on)
  let n = 0
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'haiku', agentId: 'd' + ++n }))
  on('tool.call', () => ({ isError: true, result: 'Error: boom', text: 'Error: boom' }) as never)
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'api-error', usage: { input_tokens: 0, output_tokens: 0 } } }) as never)
  for (const k of ['ui.log', 'ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)

  const { agentId } = await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model: 'haiku' } as never) as { agentId: string }
  const notes: string[] = []
  for (let i = 0; i < 12; i++) {
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test', agentId } as never) as { context?: readonly string[] }
    for (const c of r.context ?? []) notes.push(c)
  }
  expect(notes.length).toBe(3)
  expect(notes[1]).toContain('Still stuck')
  expect(notes[1]).not.toContain('Advice from a senior model')
})

test('meters requests and reports savings through /escalator', async ($, on) => {
  mock.store(on)
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'haiku', agentId: 'c1' }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20000, cache_creation_input_tokens: 1000 } } as never
  })
  for (const k of ['ui.log', 'ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  const drain = async (st: { result: Promise<unknown> } & AsyncIterable<unknown>) => { for await (const _ of st) { /* chunks */ } return st.result }

  await drain($.turn.step({ turnId: 'm', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never) as never)
  await $.agent.spawn({ prompt: 'p', description: 'write docs', subagentType: 'general-purpose', model: 'haiku' } as never)
  for (let i = 0; i < 5; i++) await drain($.turn.step({ turnId: 'c', index: i, model: 'haiku', messageCount: 3, agentId: 'c1' } as never) as never)

  const out = await $.command.run({ command: 'escalator', args: 'report', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never) as { text: string }
  expect(out.text).toContain('Same work all on opus')
  expect(out.text).toMatch(/Estimated savings: \$0\.\d\d to \$0\.\d\d/)
  expect(out.text).toContain('haiku: 5 requests')
  expect(out.text).toContain('opus: 1 requests')
})

test('the nudge asks to pause the repetition and does not read as a stop order', async ($, on) => {
  mock.store(on)
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'haiku', agentId: 'n1' }))
  on('tool.call', () => ({ isError: true, result: 'Error: boom', text: 'Error: boom' }) as never)
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'api-error', usage: { input_tokens: 0, output_tokens: 0 } } }) as never)
  for (const k of ['ui.log', 'ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)

  const { agentId } = await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model: 'haiku' } as never) as { agentId: string }
  const notes: string[] = []
  for (let i = 0; i < 6; i++) {
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test', agentId } as never) as { context?: readonly string[] }
    for (const c of r.context ?? []) notes.push(c)
  }
  expect(notes.length).toBe(1)
  expect(notes[0]).toContain('not making progress')
  expect(notes[0]).not.toMatch(/\bStop\b/)
  expect(notes[0]).toContain('continue')
})

// Runs one stuck agent until the consult fires (third note), with the given senior reply, and returns the report.
async function consultThenReport($: any, on: any, reply: unknown): Promise<{ notes: string[]; text: string }> {
  mock.store(on)
  let n = 0
  on('agent.spawn', (_$: any, e: any) => ({ model: e.model ?? 'haiku', agentId: 'u' + ++n }))
  on('tool.call', () => ({ isError: true, result: 'Error: boom', text: 'Error: boom' }) as never)
  on('model.complete', () => reply as never)
  for (const k of ['ui.log', 'ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)

  const { agentId } = await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model: 'haiku' } as never) as { agentId: string }
  const notes: string[] = []
  for (let i = 0; i < 12; i++) {
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test', agentId } as never) as { context?: readonly string[] }
    for (const c of r.context ?? []) notes.push(c)
  }
  const out = await $.command.run({ command: 'escalator', args: 'report', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never) as { text: string }
  return { notes, text: out.text }
}

test('a senior consult is priced from the usage the reply reports', async ($, on) => {
  // 500K opus input tokens at $4 per million: $2.00 exactly, far above the character estimate of a short dossier
  const r = await consultThenReport($, on, { value: { isAnswered: true, text: 'Check the import path.', usage: { input_tokens: 500_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
  expect(r.notes[1]).toContain('Check the import path.')
  expect(r.text).toContain('senior consults: 1, $2.00')
})

test('an empty senior reply still counts its reported usage', async ($, on) => {
  const r = await consultThenReport($, on, { value: { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 500_000, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
  expect(r.notes[1]).toContain('Still stuck')
  // Both calls (opus $2.00, then the retry on sonnet $1.00) are counted at their own price.
  expect(r.text).toContain('senior consults: 2, $3.00')
})

test('a malformed senior usage is ignored and the character estimate is used', async ($, on) => {
  const r = await consultThenReport($, on, { value: { isAnswered: true, text: 'Check the import path.', usage: { input_tokens: 'many', output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
  expect(r.notes[1]).toContain('Check the import path.')
  expect(r.text).toContain('senior consults: 1')
  expect(r.text).not.toContain('$2.00')
  expect(r.text).toMatch(/senior consults: 1, \$0\.0\d\)/)
})

// Store whose get/set/delete yield several times, so unserialized read-modify-writes interleave.
function slowStore(on: any, data: Record<string, unknown>): void {
  const ticks = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve() }
  on('store.get', async (_$: unknown, e: any) => { await ticks(); return { value: data[e.key] } })
  on('store.set', async (_$: unknown, e: any) => { await ticks(); data[e.key] = e.value; return { value: undefined } })
  on('store.delete', async (_$: unknown, e: any) => { await ticks(); delete data[e.key]; return { value: undefined } })
}

function quiet(on: any): void {
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'q' + ++n }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  for (const k of ['ui.log', 'ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
}

const spawnOne = async ($: any): Promise<string> =>
  (await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model: 'haiku' } as never) as { agentId: string }).agentId

const totalRuns = (stats: Record<string, Record<string, { runs: number }>> | undefined): number =>
  Object.values(stats ?? {}).flatMap((tiers) => Object.values(tiers)).reduce((sum, c) => sum + c.runs, 0)

test('agents completing together all land in the learned stats', async ($, on) => {
  const data: Record<string, unknown> = {}
  slowStore(on, data)
  quiet(on)
  const ids = [await spawnOne($), await spawnOne($), await spawnOne($)]
  await Promise.all(ids.map((agentId) => $.turn.complete({ turnId: 't' + agentId, agentId, answer: 'done' } as never)))
  expect(totalRuns(data['stats'] as never)).toBe(3)
})

test('reset waits for pending updates instead of racing them', async ($, on) => {
  const data: Record<string, unknown> = {}
  slowStore(on, data)
  quiet(on)
  const ids = [await spawnOne($), await spawnOne($)]
  const pending = ids.map((agentId) => $.turn.complete({ turnId: 't' + agentId, agentId, answer: 'done' } as never))
  const reset = $.command.run({ command: 'escalator', args: 'reset', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)
  await Promise.all([...pending, reset])
  expect(data['stats']).toBe(undefined)
})
