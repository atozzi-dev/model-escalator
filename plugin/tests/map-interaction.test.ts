import { expect, mock, test } from 'claude-code/testing'
import { MAP_PANE, resetState } from '../hooks/register'

type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

type Harness = {
  invalidations: number
  registered: any[]
  completes: { model: string; prompt: string }[]
  replies: any[]                    // consumed in order by model.complete; the last one repeats
  stepModels: string[]
  toasts: string[]
  logs: string[]
  toolText: string
  clock: ReturnType<typeof mock.clock>
}

// Fake core under the plugin: spawn, a failing tool, a senior model, metered steps, panes.
function wire(on: any, env: Record<string, string> = {}, now = 1_000_000): Harness {
  resetState()
  mock.env(on, env)
  mock.store(on)
  const h: Harness = { invalidations: 0, registered: [], completes: [], replies: [{ isAnswered: true, text: 'try the other branch' }], stepModels: [], toasts: [], logs: [], toolText: 'Error: boom', clock: mock.clock(on, { now }) }
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', (_$: unknown, e: any) => { h.registered.push(e); return { value: undefined } as never })
  on('tool.register', (_$: unknown, e: any) => ({ value: { tool: `mcp__model-escalator__${e.name}` } }) as never)
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a' + ++n }))
  on('tool.call', () => ({ isError: true, result: h.toolText, text: h.toolText }) as never)
  on('model.complete', (_$: unknown, e: any) => {
    h.completes.push({ model: e.model, prompt: e.prompt })
    const r = h.replies.length > 1 ? h.replies.shift() : h.replies[0]
    return { value: r } as never
  })
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    h.stepModels.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20000, cache_creation_input_tokens: 1000 } } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  on('ui.invalidate', () => { h.invalidations++; return { value: undefined } as never })
  on('ui.log', (_$: unknown, e: any) => { h.logs.push(String(e.text ?? e.message ?? '')); return { value: undefined } as never })
  on('ui.toast', (_$: unknown, e: any) => { h.toasts.push(String(e.text ?? e.message ?? '')); return { value: undefined } as never })
  on('ui.status', () => ({ value: undefined }) as never)
  return h
}

const spawn = async ($: any, name?: string, model = 'haiku'): Promise<string> =>
  ((await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model, ...(name ? { name } : {}) } as never)) as { agentId: string }).agentId

const call = async ($: any, agentId: string, command = 'npm test'): Promise<readonly string[]> =>
  ((await $.tool.call({ tool: 'Bash', command, agentId } as never)) as { context?: readonly string[] }).context ?? []

const stepOf = ($: any, agentId: string, model = 'haiku') =>
  drain($.turn.step({ turnId: 't' + Math.random(), index: 0, model, messageCount: 3, agentId } as never) as never)

const runCommand = async ($: any, args: string) =>
  (await $.command.run({ command: 'escalator', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never) as { text: string }).text

const PROPS = { title: 'Agent network', isFocused: false, bodyColumns: 100, placement: 'inline', scroll: { first: 0, last: 0, bodyRows: 30 }, view: {} } as never
const mount = ($: any, surface: 'terminal' | 'desktop' | 'vscode' | 'mobile') =>
  $.ui.mount({ plugin: 'model-escalator', surface, component: 'Pane', requestId: MAP_PANE, props: PROPS }) as Promise<any>

const walk = (node: any, out: string[] = []): string[] => {
  if (node === null || typeof node !== 'object') return out
  if (node.type === 'Text') { out.push(node.children.map((c: unknown) => String(c)).join('')); return out }
  for (const c of node.children ?? []) walk(c, out)
  return out
}
const shown = async (ui: any): Promise<string> => walk(await ui.drawn()).join('\n')
const buttons = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Button' })).map((b: any) => String(b.key ?? b.props?.key ?? b.text))

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: a button per worker selects it and shows its detail`, async ($, on) => {
    const h = wire(on)
    await $.session.start({ cwd: '/work' } as never)
    const a = await spawn($, 'scout')
    const b = await spawn($, 'fixer')
    await call($, b)
    await h.clock.settle()
    const ui = await mount($, surface)
    expect(await buttons(ui)).toEqual([`select-${a}`, `select-${b}`])
    expect(await shown(ui)).not.toContain('Category')            // nothing selected yet
    await ui.press({ key: `select-${b}` })
    await ui.redraw()
    const text = await shown(ui)
    expect(text).toContain(`fixer (${b})`)
    expect(text).toContain('Category')
    expect(text).toContain('Tier')
    expect(text).toContain('Cost')
    expect(await buttons(ui)).toContain('consult-now')
    expect(await buttons(ui)).toContain('swap-now')
    expect(await buttons(ui)).toContain('close-detail')
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()
    await ui.press({ key: 'close-detail' })
    await ui.redraw()
    expect(await shown(ui)).not.toContain('Category')
    expect(await buttons(ui)).not.toContain('consult-now')
    await ui.unmount()
  })
}

test('the pane without workers has no selector', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const ui = await mount($, 'desktop')
  expect(await buttons(ui)).toEqual([])
  await ui.unmount()
})

test('selecting marks the map dirty: one redraw on the next tick, no second timer', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'scout')
  await runCommand($, 'map')
  await h.clock.advance(5000)
  const idle = h.invalidations
  const ui = await mount($, 'desktop')
  await ui.press({ key: `select-${id}` })
  expect(h.invalidations).toBe(idle)                            // the press itself draws nothing
  await h.clock.advance(250)
  expect(h.invalidations).toBe(idle + 1)
  await h.clock.advance(1000)
  expect(h.invalidations).toBe(idle + 1)
  await ui.unmount()
})

test('the detail shows the last failed attempts redacted and capped, and the interventions', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'fixer')
  await call($, id, 'node build.js --token=supersecretvalue99')
  for (let i = 0; i < 6; i++) await call($, id, `npm test ${i}`)
  await h.clock.settle()
  const ui = await mount($, 'desktop')
  await ui.press({ key: `select-${id}` })
  await ui.redraw()
  const text = await shown(ui)
  expect(text).not.toContain('supersecretvalue99')
  expect(text.split('\n').filter((l) => l.includes('Bash:')).length).toBeLessThanOrEqual(3)
  expect(text).toContain('npm test 5')
  expect(text).toMatch(/Interventions/)
  expect(text).not.toContain('Interventions: none')
  await ui.unmount()
})

test('/escalator consult delivers the advice on the next tool call, once', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'fixer')
  await call($, id)
  const text = await runCommand($, `consult ${id}`)
  expect(text).toContain('next tool call')
  expect(h.completes.length).toBe(1)
  expect(h.completes[0]!.model).toBe('opus')
  expect(h.completes[0]!.prompt).toContain('npm test')
  const first = await call($, id)
  expect(first.some((c) => c.includes('Advice from a senior model') && c.includes('try the other branch'))).toBe(true)
  const again = await call($, id)
  expect(again.some((c) => c.includes('Advice from a senior model'))).toBe(false)
})

test('the consult button does the same, in the background', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'fixer')
  const ui = await mount($, 'terminal')
  await ui.press({ key: `select-${id}` })
  await ui.redraw()
  await ui.press({ key: 'consult-now' })
  await h.clock.settle()
  expect(h.completes.length).toBe(1)
  const ctx = await call($, id)
  expect(ctx.some((c) => c.includes('try the other branch'))).toBe(true)
  await ui.redraw()
  expect(await shown(ui)).toContain('Consult')
  await ui.unmount()
})

test('a refused consult retries on the other senior with the same flow', async ($, on) => {
  const h = wire(on)
  h.replies = [{ isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 10, output_tokens: 3 } }, { isAnswered: true, text: 'second opinion' }]
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'fixer')
  await runCommand($, `consult ${id}`)
  expect(h.completes.map((c) => c.model)).toEqual(['opus', 'sonnet'])
  expect((await call($, id)).some((c) => c.includes('second opinion'))).toBe(true)
})

test('consult caps: per agent, per session and budget refuse with a clear message', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'fixer')
  for (let i = 0; i < 3; i++) expect(await runCommand($, `consult ${id}`)).toContain('next tool call')
  const capped = await runCommand($, `consult ${id}`)
  expect(capped).toContain('per agent (3 consults)')
  expect(h.completes.length).toBe(3)
})

test('the session cap refuses a consult', { options: { maxConsultsPerSession: 0 } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'fixer')
  expect(await runCommand($, `consult ${id}`)).toContain('per session (0 consults)')
  expect(h.completes.length).toBe(0)
})

test('a consult budget already spent refuses a consult', { options: { consultBudgetUsd: 0.0000001 } }, async ($, on) => {
  const h = wire(on)
  h.replies = [{ isAnswered: true, text: 'advice', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }]
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'fixer')
  expect(await runCommand($, `consult ${id}`)).toContain('next tool call')
  expect(await runCommand($, `consult ${id}`)).toContain('budget')
  expect(h.completes.length).toBe(1)
})

test('/escalator swap moves the next request one tier up, with the full id, and stops at the top', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'fixer')
  expect(await runCommand($, `swap ${id}`)).toContain('sonnet')
  await stepOf($, id)
  expect(h.stepModels.at(-1)).toBe('claude-sonnet-5-5')
  const note = await call($, id)
  expect(note.some((c) => c.includes('stronger model (sonnet)'))).toBe(true)
  expect(await runCommand($, `swap fixer`)).toContain('opus')       // by name
  await stepOf($, id)
  expect(h.stepModels.at(-1)).toBe('claude-opus-5-5')
  const top = await runCommand($, `swap ${id}`)
  expect(top).toContain('top tier')
  await stepOf($, id)
  expect(h.stepModels.at(-1)).toBe('claude-opus-5-5')
})

test('swap respects maxTier', { options: { maxTier: 'sonnet' } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'fixer')
  await runCommand($, `swap ${id}`)
  const capped = await runCommand($, `swap ${id}`)
  expect(capped).toContain('maxTier is sonnet')
  await stepOf($, id)
  expect(h.stepModels.at(-1)).toBe('claude-sonnet-5-5')
})

test('a manual swap counts like an escalated run: log, toast and the ladder past the swap', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'fixer')
  await runCommand($, `swap ${id}`)
  expect(h.toasts.some((t) => t.includes('sonnet'))).toBe(true)
  expect(h.logs.some((l) => l.includes('swap') && l.includes('fixer'))).toBe(true)
  // The ladder is already past its swap level: the next trigger moves up again instead of starting over.
  expect((await runCommand($, '')).toLowerCase()).toContain('swap')
})

test('the swap button moves the agent up', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'fixer')
  const ui = await mount($, 'desktop')
  await ui.press({ key: `select-${id}` })
  await ui.redraw()
  await ui.press({ key: 'swap-now' })
  await ui.redraw()
  await stepOf($, id)
  expect(h.stepModels.at(-1)).toBe('claude-sonnet-5-5')
  expect(await shown(ui)).toContain('sonnet')
  await ui.unmount()
})

test('observe mode does not act and hides the buttons with a reason', { timeoutMs: 8000 }, async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'observe' })
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'fixer')
  expect(await runCommand($, `consult ${id}`)).toContain('active mode')
  expect(await runCommand($, `swap ${id}`)).toContain('active mode')
  expect(h.completes.length).toBe(0)
  await stepOf($, id)
  expect(h.stepModels.at(-1)).toBe('haiku')
  const ui = await mount($, 'desktop')
  await ui.press({ key: `select-${id}` })
  await ui.redraw()
  expect(await buttons(ui)).not.toContain('consult-now')
  expect(await buttons(ui)).not.toContain('swap-now')
  expect(await shown(ui)).toContain('active mode')
  await ui.unmount()
})

test('an unknown id, a missing id, a finished and a paused agent get a clear message', async ($, on) => {
  const h = wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'fixer')
  expect(await runCommand($, 'consult nope')).toContain('No agent')
  expect(await runCommand($, 'swap nope')).toContain('No agent')
  expect(await runCommand($, 'consult')).toContain('Name an agent')
  expect(await runCommand($, 'swap   ')).toContain('Name an agent')
  await $.turn.complete({ turnId: 't', agentId: id, answer: 'done' } as never)
  await h.clock.settle()
  expect(await runCommand($, `consult ${id}`)).toContain('finished')
  expect(await runCommand($, `swap ${id}`)).toContain('finished')
  expect(h.completes.length).toBe(0)
})

test('a finished agent shows its detail without action buttons', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'fixer')
  await $.turn.complete({ turnId: 't', agentId: id, answer: 'done' } as never)
  await h.clock.settle()
  const ui = await mount($, 'desktop')
  await ui.press({ key: `select-${id}` })
  await ui.redraw()
  expect(await shown(ui)).toContain('finished')
  expect(await buttons(ui)).not.toContain('consult-now')
  expect(await buttons(ui)).toContain('close-detail')
  await ui.unmount()
})

test('help and the command hint list consult and swap', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const help = await runCommand($, 'help')
  expect(help).toContain('/escalator consult <id>')
  expect(help).toContain('/escalator swap <id>')
  expect(JSON.stringify(h.registered)).toContain('consult <id>')
  expect(JSON.stringify(h.registered)).toContain('swap <id>')
})
