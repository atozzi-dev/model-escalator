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
  expect(notes[0]).toContain('repeating the same failing step')
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
  expect(notes[0]).toContain('repeating the same failing step')
  expect(notes[0]).not.toMatch(/\bStop\b/)
  expect(notes[0]).toContain('continue')
})
