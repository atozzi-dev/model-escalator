import { expect, mock, test } from 'claude-code/testing'
import { MAP_PANE, STATS_PANE, resetState } from '../hooks/register'
import { parseSnapshot } from '../hooks/state'

type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

type Harness = {
  opened: any[]
  closed: string[]
  invalidations: number
  registered: any[]
  lastState: unknown
  clock: ReturnType<typeof mock.clock>
  rateLimits: unknown[]
  data: Record<string, unknown>
  placed: boolean
  usageFails: boolean
  surfaces: string[]
  surfacesFail: boolean
}

// Fake core under the plugin: spawn, a failing tool, a senior model, metered steps, panes.
function wire(on: any, now = 1_000_000): Harness {
  resetState()
  mock.env(on, {})
  const h: Harness = { opened: [], closed: [], invalidations: 0, registered: [], lastState: undefined, clock: mock.clock(on, { now }), rateLimits: [], data: {}, placed: true, usageFails: false, surfaces: ['desktop'], surfacesFail: false }
  on('store.get', (_$: unknown, e: any) => ({ value: h.data[e.key] }) as never)
  on('store.set', (_$: unknown, e: any) => { h.data[e.key] = e.value; return { value: undefined } as never })
  on('store.delete', (_$: unknown, e: any) => { delete h.data[e.key]; return { value: undefined } as never })
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', (_$: unknown, e: any) => { h.registered.push(e); return { value: undefined } as never })
  on('tool.register', (_$: unknown, e: any) => ({ value: { tool: `mcp__model-escalator__${e.name}` } }) as never)
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a' + ++n }))
  on('tool.call', () => ({ isError: true, result: 'Error: boom', text: 'Error: boom' }) as never)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'advice', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20000, cache_creation_input_tokens: 1000 } } as never
  })
  on('session.usage', () => { if (h.usageFails) throw new Error('boom'); return { value: { startedAt: 0, context: {}, rateLimits: h.rateLimits } } as never })
  on('ui.open', (_$: unknown, e: any) => { h.opened.push(e); return { value: h.placed ? { isPlaced: true } : { isPlaced: false, reason: 'too narrow' } } as never })
  on('ui.close', (_$: unknown, e: any) => { h.closed.push(e.id); return { value: undefined } as never })
  on('ui.panes', () => ({ value: [] }) as never)
  on('session.surfaces', () => { if (h.surfacesFail) throw new Error('boom'); return { value: h.surfaces } as never })
  on('ui.invalidate', () => { h.invalidations++; return { value: undefined } as never })
  on('state.set', async (_$: unknown, e: any, next: any) => { h.lastState = e.value; return next(e) })
  for (const k of ['ui.log', 'ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return h
}

const spawn = async ($: any, description: string): Promise<string> =>
  ((await $.agent.spawn({ prompt: 'p', description, subagentType: 'general-purpose', model: 'haiku' } as never)) as { agentId: string }).agentId

const step = ($: any, agentId?: string) =>
  drain($.turn.step({ turnId: 't' + Math.random(), index: 0, model: agentId ? 'haiku' : 'opus', messageCount: 3, ...(agentId ? { agentId } : {}) } as never) as never)

async function stuck($: any, agentId: string, calls: number): Promise<void> {
  for (let i = 0; i < calls; i++) await $.tool.call({ tool: 'Bash', command: 'npm test', agentId } as never)
}

const runCommand = async ($: any, args: string) =>
  (await $.command.run({ command: 'escalator', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never) as { text: string }).text

const props = (bodyColumns: number | undefined) => ({ title: 'Escalator', isFocused: false, ...(bodyColumns === undefined ? {} : { bodyColumns }), placement: 'inline', scroll: { first: 0, last: 0, bodyRows: 30 }, view: {} }) as never
const mount = ($: any, surface: 'terminal' | 'desktop' | 'vscode' | 'mobile', bodyColumns: number | undefined = 100, requestId: string = STATS_PANE) =>
  $.ui.mount({ plugin: 'model-escalator', surface, component: 'Pane', requestId, props: props(bodyColumns) }) as Promise<any>

// Every Text string under a drawn tree, in reading order, and the same grouped per row Box.
const walk = (node: any, out: string[] = []): string[] => {
  if (node === null || typeof node !== 'object') return out
  if (node.type === 'Text') { out.push(node.children.map((c: unknown) => String(c)).join('')); return out }
  for (const c of node.children ?? []) walk(c, out)
  return out
}
const texts = async (ui: any): Promise<string[]> => walk(await ui.drawn())
const rows = (node: any, out: string[] = []): string[] => {
  if (node === null || typeof node !== 'object') return out
  if (node.type === 'Box' && node.props?.flexDirection === 'row') { out.push(walk(node).join('  ')); return out }
  for (const c of node.children ?? []) rows(c, out)
  return out
}

// A scripted session: a stuck bugfix agent that gets a consult and a swap, a second agent on docs, learned stats.
async function script($: any, h: Harness): Promise<void> {
  await $.session.start({ cwd: '/work' } as never)
  h.data.stats = {
    'general-purpose:tests': { haiku: { runs: 10, escalated: 4, notAccepted: 5, tokens: 1000, cost: 1, costRuns: 10, reviews: 2, reviewScore: 7, reworked: 1 } },
    'general-purpose:docs': { haiku: { runs: 3, escalated: 0, tokens: 100 } },
  }
  await step($)
  const a = await spawn($, 'fix the db test')
  const b = await spawn($, 'update the readme docs')
  await step($, a)
  await step($, b)
  await stuck($, a, 14)
  await h.clock.settle()
}

// Costs under a cent keep four decimals.
const usd = (x: number) => '$' + x.toFixed(x !== 0 && Math.abs(x) < 0.01 ? 4 : 2)

test('/escalator panel opens the pane and the help lists it', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const text = await runCommand($, 'panel')
  expect(h.opened.length).toBe(1)
  expect(h.opened[0].id).toBe(STATS_PANE)
  expect(h.opened[0].title).toBe('Escalator')
  expect(text).toContain('Escalator')
  expect(JSON.stringify(h.registered)).toContain('panel')
  expect(await runCommand($, 'help')).toContain('/escalator panel')
})

test('/escalator panel says that no surface in the session draws panels', async ($, on) => {
  const h = wire(on)
  h.surfaces = []
  await $.session.start({ cwd: '/work' } as never)
  const text = await runCommand($, 'panel')
  expect(h.opened.length).toBe(1)
  expect(text).toContain('No surface in this session draws panels')
  expect(text).toContain('/escalator panel')
  expect(text).not.toContain('opened')
})

test('/escalator panel falls back to the plain opened message when surfaces fails', async ($, on) => {
  const h = wire(on)
  h.surfacesFail = true
  await $.session.start({ cwd: '/work' } as never)
  expect(await runCommand($, 'panel')).toContain('Escalator panel opened')
})

test('the no-surface panel message suggests a terminal or the desktop app', async ($, on) => {
  const h = wire(on)
  h.surfaces = []
  await $.session.start({ cwd: '/work' } as never)
  const text = await runCommand($, 'panel')
  expect(text).toContain('in a terminal')
  expect(text).toContain('VS Code integrated terminal')
  expect(text).toContain('desktop app')
})

test('a pane that cannot open says so', async ($, on) => {
  const h = wire(on)
  h.placed = false
  await $.session.start({ cwd: '/work' } as never)
  expect(await runCommand($, 'panel')).toContain('too narrow')
})

test('the terminal shows the four sections with the numbers of the session', async ($, on) => {
  const h = wire(on)
  h.rateLimits = [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-12T15:00:00Z' }]
  await script($, h)
  const snap = parseSnapshot(h.lastState)!
  const ledger = snap.ledger
  expect(ledger.actual).toBeGreaterThan(0)
  const ui = await mount($, 'terminal')
  const all = await texts(ui)
  const flat = all.join('\n')
  for (const title of ['Session', 'Plan usage', 'Savings by category', 'Learned statistics']) expect(all).toContain(title)
  expect(flat).toContain('active (baseline opus)')
  expect(flat).toContain(usd(ledger.actual))
  expect(flat).toContain(`consults ${ledger.consults}, ${usd(ledger.consultCost)}`)
  expect(flat).toContain(`${usd(ledger.baselineLow)} to ${usd(ledger.baselineHigh)}`)
  for (const [k, n] of Object.entries(ledger.interventions)) expect(flat).toContain(`${k} ${n}`)
  expect(flat).toContain('five_hour: 23.5% used')
  // The category table, from the ledger.
  expect(flat).toContain('general-purpose:tests')
  expect(flat).toContain('general-purpose:docs')
  // The learned table: 10 runs, 5 not accepted, 2 reviews averaging 3.5, one rework.
  const learned = (await rows(await ui.drawn())).find((r) => r.includes('general-purpose:tests') && r.includes('3.5 (2)'))
  expect(learned).toBeDefined()
  expect(learned).toContain('50%')
  expect(learned).toContain('$0.20 haiku')
  await ui.unmount()
})

test('desktop, vscode and mobile draw the same content with Box and Text, no Svg', async ($, on) => {
  const h = wire(on)
  await script($, h)
  const ledger = parseSnapshot(h.lastState)!.ledger
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await mount($, surface)
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    const all = await texts(ui)
    for (const title of ['Session', 'Savings by category', 'Learned statistics']) expect(all).toContain(title)
    expect(all.join('\n')).toContain(usd(ledger.actual))
    expect(all.join('\n')).toContain('3.5 (2)')
    await ui.unmount()
  }
})

test('the plan section is absent without plan data and present with it', async ($, on) => {
  const h = wire(on)
  await script($, h)
  const without = await mount($, 'terminal')
  expect(await texts(without)).not.toContain('Plan usage')
  await without.unmount()
  h.rateLimits = [{ kind: 'seven_day', percentUsed: 7 }]
  const withPlan = await mount($, 'desktop')
  const all = await texts(withPlan)
  expect(all).toContain('Plan usage')
  expect(all.join('\n')).toContain('seven_day: 7% used')
  await withPlan.unmount()
})

test('a failing usage call leaves the panel without the plan section', async ($, on) => {
  const h = wire(on)
  await script($, h)
  h.usageFails = true
  const ui = await mount($, 'terminal')
  const all = await texts(ui)
  expect(all).toContain('Session')
  expect(all).not.toContain('Plan usage')
  await ui.unmount()
})

test('the terminal respects the pane width, and falls back to 80 columns', async ($, on) => {
  const h = wire(on)
  await script($, h)
  for (const width of [40, 60, 100]) {
    const ui = await mount($, 'terminal', width)
    const lines = await rows(await ui.drawn())
    expect(lines.length).toBeGreaterThan(5)
    for (const l of lines) expect([width, l, l.length <= width]).toEqual([width, l, true])
    await ui.unmount()
  }
  const odd = await mount($, 'terminal', undefined)
  for (const l of await rows(await odd.drawn())) expect(l.length).toBeLessThanOrEqual(80)
  await odd.unmount()
})

test('an empty session still draws every section with placeholders', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const ui = await mount($, 'terminal')
  const flat = (await texts(ui)).join('\n')
  expect(flat).toContain('No category data yet.')
  expect(flat).toContain('No learned stats yet.')
  expect(flat).toContain('none')
  await ui.unmount()
})

test('no timer runs before the panel is opened', async ($, on) => {
  const h = wire(on)
  await script($, h)
  await h.clock.advance(5000)
  expect(h.invalidations).toBe(0)
})

test('redraws only when something changed, at most once per second', async ($, on) => {
  const h = wire(on)
  await script($, h)
  const a = 'a1'
  await runCommand($, 'panel')
  // Opening marks the panel dirty: one redraw on the first tick, then quiet.
  await h.clock.advance(1000)
  await h.clock.advance(5000)
  const idle = h.invalidations
  await h.clock.advance(5000)
  expect(h.invalidations).toBe(idle)

  // A burst of steps inside one second folds into one redraw, and hooks never redraw by themselves.
  for (let i = 0; i < 10; i++) await step($, a)
  expect(h.invalidations).toBe(idle)
  await h.clock.advance(1000)
  expect(h.invalidations).toBe(idle + 1)

  // Steady changes every 100 ms for three seconds: no more than one redraw a second.
  const before = h.invalidations
  for (let i = 0; i < 30; i++) {
    await step($, a)
    await h.clock.advance(100)
  }
  expect(h.invalidations - before).toBeLessThanOrEqual(3)
  expect(h.invalidations - before).toBeGreaterThanOrEqual(2)

  // A change of the learned statistics redraws too.
  await h.clock.advance(2000)
  const quiet = h.invalidations
  h.data.stats = { 'general-purpose:other': { haiku: { runs: 1, escalated: 0, tokens: 1 } } }
  await h.clock.advance(1000)
  expect(h.invalidations).toBe(quiet + 1)
})

test('closing the panel stops the redraws', async ($, on) => {
  const h = wire(on)
  await script($, h)
  await runCommand($, 'panel')
  await h.clock.advance(2000)
  expect(await runCommand($, 'panel close')).toContain('closed')
  expect(h.closed).toEqual([STATS_PANE])
  const closed = h.invalidations
  await step($, 'a1')
  await h.clock.advance(10_000)
  expect(h.invalidations).toBe(closed)
})

test('the map pane still works beside the panel', async ($, on) => {
  const h = wire(on)
  await script($, h)
  await runCommand($, 'map')
  await runCommand($, 'panel')
  const map = await mount($, 'desktop', 100, MAP_PANE)
  expect(String((await map.find({ type: 'Svg' })).props.alt)).toBe('Agent network: 2 workers, a senior')
  await map.unmount()
  const panel = await mount($, 'desktop')
  expect(await panel.find({ type: 'Svg' })).toBeUndefined()
  await panel.unmount()
  // Closing the panel leaves the map's ticks running.
  await runCommand($, 'panel close')
  await h.clock.advance(250)
  const before = h.invalidations
  await spawn($, 'late worker')
  await h.clock.advance(250)
  expect(h.invalidations).toBe(before + 1)
})
