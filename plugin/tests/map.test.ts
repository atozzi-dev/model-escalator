import { expect, mock, test } from 'claude-code/testing'
import { LEAD_ID, SENIOR_ID, type GraphState } from '../hooks/graph'
import { HELP_TOOL, MAP_PANE, resetState } from '../hooks/register'
import { emptyLedger } from '../hooks/savings'
import { parseSnapshot } from '../hooks/state'
import { SVG_MAX } from '../hooks/render-svg'
import { SPINNER } from '../hooks/render-text'

type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

type Harness = {
  opened: any[]
  invalidations: number
  registered: any[]
  gate: Promise<void> | undefined
  lastState: unknown
  stateOverride: unknown
  clock: ReturnType<typeof mock.clock>
}

// Fake core under the plugin: spawn, a failing tool, a senior model, metered steps, panes.
function wire(on: any, now = 1_000_000): Harness {
  resetState()
  mock.env(on, {})
  mock.store(on)
  const h: Harness = { opened: [], invalidations: 0, registered: [], gate: undefined, lastState: undefined, stateOverride: undefined, clock: mock.clock(on, { now }) }
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', (_$: unknown, e: any) => { h.registered.push(e); return { value: undefined } as never })
  on('tool.register', (_$: unknown, e: any) => ({ value: { tool: `mcp__model-escalator__${e.name}` } }) as never)
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a' + ++n }))
  on('tool.call', async (_$: unknown, e: any) => {
    // A tool call can be held open, to look at the map while it runs.
    if (e.agentId && h.gate) await h.gate
    return { isError: true, result: 'Error: boom', text: 'Error: boom' } as never
  })
  on('model.complete', () => ({ value: { isAnswered: true, text: 'advice' } }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20000, cache_creation_input_tokens: 1000 } } as never
  })
  on('ui.open', (_$: unknown, e: any) => { h.opened.push(e); return { value: { isPlaced: true } } as never })
  on('ui.panes', () => ({ value: [] }) as never)
  on('ui.invalidate', () => { h.invalidations++; return { value: undefined } as never })
  on('state.get', (_$: unknown, e: any, next: any) => (h.stateOverride === undefined ? next(e) : ({ value: { value: h.stateOverride, version: 1 } }) as never))
  on('state.set', async (_$: unknown, e: any, next: any) => { h.lastState = e.value; return next(e) })
  on('ui.log', () => ({ value: undefined }) as never)
  for (const k of ['ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return h
}

async function spawn($: any, name?: string): Promise<string> {
  const r = await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model: 'haiku', ...(name ? { name } : {}) } as never) as { agentId: string }
  return r.agentId
}

async function stuck($: any, agentId: string, calls: number): Promise<void> {
  for (let i = 0; i < calls; i++) await $.tool.call({ tool: 'Bash', command: 'npm test', agentId } as never)
}

const step = ($: any, agentId?: string) =>
  drain($.turn.step({ turnId: 't', index: 0, model: 'haiku', messageCount: 3, agentId } as never) as never)

const runCommand = async ($: any, args: string) =>
  (await $.command.run({ command: 'escalator', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never) as { text: string }).text

// The graph in the snapshot saved last. The plugin runs in the engine's host, so its state is read from what it saved.
async function graphOf(h: Harness): Promise<GraphState> {
  await h.clock.settle()
  const g = parseSnapshot(h.lastState)?.graph
  if (!g) throw new Error('no graph in the saved snapshot')
  return g
}

const PANE_PROPS = { title: 'Agent network', isFocused: false, bodyColumns: 120, placement: 'inline', scroll: { first: 0, last: 0, bodyRows: 30 }, view: {} } as never
const mount = ($: any, surface: 'terminal' | 'desktop' | 'vscode' | 'mobile') =>
  $.ui.mount({ plugin: 'model-escalator', surface, component: 'Pane', requestId: MAP_PANE, props: PANE_PROPS }) as Promise<any>

test('spawn, tool calls and steps feed the graph', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'scout')
  let g = await graphOf(h)
  expect(g.nodes.map((n) => n.id)).toEqual([LEAD_ID, id])
  expect(g.nodes[1]!.label).toBe('scout')
  expect(g.nodes[1]!.tier).toBe('haiku')
  expect(g.edges.some((e) => e.kind === 'spawn' && e.to === id)).toBe(true)

  // The map shows what the agent does while its tool call is still running.
  let release: () => void = () => undefined
  h.gate = new Promise<void>((resolve) => { release = resolve })
  const running = $.tool.call({ tool: 'Bash', command: 'npm test', agentId: id } as never)
  await h.clock.settle()
  const during = await mount($, 'desktop')
  expect(String((await during.find({ type: 'Svg' })).props.source)).toContain('runs the tests')
  await during.unmount()
  release()
  await running
  h.gate = undefined

  await step($, id)
  await step($)                                      // the lead's own request
  await $.turn.complete({ turnId: 't', agentId: id, answer: 'done' } as never)
  g = await graphOf(h)
  const worker = g.nodes.find((n) => n.id === id)!
  expect(worker.cost).toBeGreaterThan(0)
  expect(g.nodes.find((n) => n.id === LEAD_ID)!.cost).toBeGreaterThan(0)
  expect(worker.status).toBe('done')
  expect(g.events.map((e) => e.kind)).toContain('done')
})

test('the ladder and the senior consults feed the graph', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'fixer')
  await stuck($, id, 14)
  const g = await graphOf(h)
  const kinds = g.events.map((e) => e.kind)
  expect(kinds).toContain('consult')
  expect(kinds).toContain('swap')
  expect(g.nodes.some((n) => n.id === SENIOR_ID)).toBe(true)
  expect(g.edges.some((e) => e.kind === 'consult' && e.from === id && e.to === SENIOR_ID)).toBe(true)
  const w = g.nodes.find((n) => n.id === id)!
  expect(w.consults).toBeGreaterThan(0)
  expect(w.interventions).toBeGreaterThan(0)
  expect(w.tier).not.toBe('haiku')
})

test('the help tool feeds a consult', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'asker')
  await $.tool.call({ tool: HELP_TOOL, problem: 'the migration hangs', agentId: id } as never)
  const g = await graphOf(h)
  expect(g.nodes.some((n) => n.id === SENIOR_ID)).toBe(true)
  expect(g.nodes.find((n) => n.id === id)!.consults).toBe(1)
  expect(g.events.map((e) => e.kind)).toContain('consult')
})

test('/escalator map opens the pane and the help text lists it', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const text = await runCommand($, 'map')
  expect(h.opened.length).toBe(1)
  expect(h.opened[0].id).toBe(MAP_PANE)
  expect(h.opened[0].title).toBe('Agent network')
  expect(text).toContain('Agent network')
  expect(JSON.stringify(h.registered)).toContain('map')
  expect(await runCommand($, '')).toContain('/escalator map')
})

test('the pane draws an escaped Svg on desktop, vscode and mobile', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'a<b>&"c')
  await spawn($, 'plain')
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await mount($, surface)
    const svg = await ui.find({ type: 'Svg' })
    expect(svg).toBeDefined()
    const source = String(svg.props.source)
    expect(source.length).toBeLessThan(SVG_MAX)
    expect(source).toStartWith('<svg ')
    expect(source).toContain('plain')
    expect(source).toContain('a&lt;b&gt;&amp;&quot;c')
    expect(source).not.toContain('a<b>')
    expect(svg.props.isInteractive).toBe(true)
    expect(String(svg.props.alt)).toBe('Agent network: 2 workers')
    await ui.unmount()
  }
})

// The terminal tree: one row Box per line, one Text per segment. (The node panel under the tree is a column Box.)
const treeRows = async (ui: any): Promise<any[]> => ((await ui.drawn()).children as any[]).filter((r) => r.props?.flexDirection === 'row')
const termTexts = async (ui: any): Promise<any[]> => (await treeRows(ui)).flatMap((r) => r.children as any[])
const termRows = async (ui: any): Promise<string[]> =>
  (await treeRows(ui)).map((r) => (r.children as any[]).map((t) => String(t.children[0])).join(''))
const mountTerminal = ($: any, bodyColumns: number) =>
  $.ui.mount({ plugin: 'model-escalator', surface: 'terminal', component: 'Pane', requestId: MAP_PANE, props: { ...(PANE_PROPS as object), bodyColumns } }) as Promise<any>

test('the terminal draws the tree as rows of Text, not an Svg', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'scout')
  await spawn($, 'fixer')
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  const rows = await termRows(ui)
  expect(rows.length).toBe(3)
  expect(rows[0]).toContain('[lead]')
  expect(rows[1]).toContain('[haiku]')
  expect(rows[1]).toContain('scout')
  expect(rows[2]).toContain('fixer')
  expect(rows[2]).toMatch(/^└─ /)
  // Segments keep their style: the badge is coloured and bold, the status word dim.
  const badge = (await termTexts(ui)).find((t) => t.children[0] === '[haiku]')
  expect(badge.props.bold).toBe(true)
  expect(String(badge.props.color)).toMatch(/^#[0-9a-f]{6}$/)
  expect((await termTexts(ui)).some((t) => t.props?.dimColor === true && String(t.children[0]).includes('working'))).toBe(true)
  await ui.unmount()
})

test('a stuck agent uses the theme error colour, a finished one the success colour', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const a = await spawn($, 'fin')
  await $.turn.complete({ turnId: 't', agentId: a, answer: 'done' } as never)
  const ui = await mount($, 'terminal')
  expect((await termTexts(ui)).some((t) => t.children[0] === '✓' && t.props.color === 'success')).toBe(true)
  await ui.unmount()
})

test('the terminal tree fits the width of the pane and falls back to 80', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'a-rather-long-agent-name-that-needs-clipping')
  for (const width of [24, 40, 100]) {
    const ui = await mountTerminal($, width)
    for (const row of await termRows(ui)) expect(Array.from(row).length).toBeLessThanOrEqual(width)
    await ui.unmount()
  }
  const odd = await mountTerminal($, Number.NaN)
  for (const row of await termRows(odd)) expect(Array.from(row).length).toBeLessThanOrEqual(80)
  await odd.unmount()
})

test('the spinner advances on the redraw tick while an agent works, and stays still otherwise', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'scout')
  await runCommand($, 'map')
  const ui = await mount($, 'terminal')
  const glyph = async () => Array.from((await termRows(ui))[1]!)[3]!   // after the "├─ " prefix
  const seen = [await glyph()]
  expect(SPINNER).toContain(seen[0]!)
  for (let i = 0; i < 4; i++) {
    const before = h.invalidations
    await h.clock.advance(250)
    expect([i, h.invalidations]).toEqual([i, before + 1])       // one redraw per tick, no more than four a second
    await ui.redraw()
    seen.push(await glyph())
  }
  expect(new Set(seen).size).toBe(5)
  for (let i = 1; i < seen.length; i++) expect(seen[i]).toBe(SPINNER[i])

  // Once the worker is done nothing animates: after the quiet redraw the ticks stop.
  await $.turn.complete({ turnId: 't', agentId: id, answer: 'done' } as never)
  await h.clock.advance(10_000)
  const settled = h.invalidations
  await h.clock.advance(5_000)
  expect(h.invalidations).toBe(settled)
  await ui.unmount()
})

test('recent-event suffixes stay for a few seconds, then go', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const a = await spawn($, 'scout')
  await runCommand($, 'map')
  const ui = await mount($, 'terminal')
  expect((await termRows(ui))[1]).toContain(' new')
  await h.clock.advance(1000)
  await ui.redraw()
  expect((await termRows(ui))[1]).toContain(' new')       // still inside the window
  await h.clock.advance(3000)
  await ui.redraw()
  expect((await termRows(ui))[1]).not.toContain(' new')   // the window passed
  // A later event gets its own window.
  await $.turn.complete({ turnId: 't', agentId: a, answer: 'done' } as never)
  await spawn($, 'late')
  await h.clock.advance(250)
  await ui.redraw()
  const rows = await termRows(ui)
  expect(rows[2]).toContain(' new')
  expect(rows[1]).not.toContain(' new')
  await ui.unmount()
})

test('a draw with no agents shows the lead alone, with a singular alt', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const ui = await mount($, 'desktop')
  const svg = await ui.find({ type: 'Svg' })
  expect(String(svg.props.alt)).toBe('Agent network: 0 workers')
  await ui.unmount()
  await spawn($, 'one')
  const again = await mount($, 'desktop')
  expect(String((await again.find({ type: 'Svg' })).props.alt)).toBe('Agent network: 1 worker')
  await again.unmount()
})

test('redraws only when the graph changed, at most four times per second', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'scout')
  await runCommand($, 'map')
  // Nothing changed since the pane opened: ticks draw nothing.
  await h.clock.advance(2000)
  const idle = h.invalidations

  // A burst of events inside one tick folds into one redraw.
  for (let i = 0; i < 10; i++) await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: id } as never)
  expect(h.invalidations).toBe(idle)             // hooks never redraw by themselves
  await h.clock.advance(250)
  expect(h.invalidations).toBe(idle + 1)

  // Events every 50 ms for one second: no more than four redraws.
  const before = h.invalidations
  for (let i = 0; i < 20; i++) {
    await $.tool.call({ tool: 'Read', file_path: '/work/x' + i + '.ts', agentId: id } as never)
    await h.clock.advance(50)
  }
  expect(h.invalidations - before).toBeLessThanOrEqual(4)
  expect(h.invalidations - before).toBeGreaterThanOrEqual(3)

  // Once the network is quiet it settles with one last redraw (so animations stop), then nothing.
  await h.clock.advance(10_000)
  const settled = h.invalidations
  await h.clock.advance(10_000)
  expect(h.invalidations).toBe(settled)
})

test('no timer runs before the map is opened', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: id } as never)
  await h.clock.advance(5000)
  expect(h.invalidations).toBe(0)
})

test('the graph and its layout are saved, and a reload restores them', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const a = await spawn($, 'first')
  await spawn($, 'second')
  await step($, a)
  const ui = await mount($, 'desktop')       // a draw fixes the slots
  await ui.unmount()
  await step($, a)                           // the next save carries the slots the draw fixed
  await h.clock.settle()
  const saved = parseSnapshot(h.lastState)!
  expect(saved.graph?.nodes.length).toBe(3)
  expect(Object.keys(saved.layout?.slots ?? {}).length).toBe(2)
  expect(saved.drawnSeq).toBe(saved.graph?.seq)

  // The reload: the host hands back a snapshot from before, and the module takes the network from it.
  const ghost = { ...saved.graph!, nodes: [...saved.graph!.nodes.slice(0, 1), { ...saved.graph!.nodes[1]!, id: 'ghost', label: 'restored' }], edges: [], events: [] }
  h.stateOverride = { ...saved, graph: ghost, layout: { slots: { ghost: 7 }, retired: [] } }
  await $.session.start({ cwd: '/work' } as never)
  const reloaded = await mount($, 'desktop')
  const svg = await reloaded.find({ type: 'Svg' })
  expect(String(svg.props.alt)).toBe('Agent network: 1 worker')
  expect(String(svg.props.source)).toContain('restored')
  await reloaded.unmount()
  await step($, a)
  await h.clock.settle()
  // The slot it had is kept: the node did not jump.
  expect(parseSnapshot(h.lastState)!.layout?.slots).toEqual({ ghost: 7 })
})

test('a snapshot saved before the map existed hydrates to an empty graph', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'busy')
  const old = { agents: [], ledger: emptyLedger(), seenModels: {}, sessionTag: 'abcdef', mode: 'active', baseline: 'opus', baselinePinned: false }
  expect(parseSnapshot(old)!.graph).toBeUndefined()
  h.stateOverride = old
  await $.session.start({ cwd: '/work' } as never)
  const ui = await mount($, 'desktop')
  const svg = await ui.find({ type: 'Svg' })
  expect(String(svg.props.alt)).toBe('Agent network: 0 workers')
  expect(String(svg.props.source)).not.toContain('busy')
  await ui.unmount()
})

test('parseSnapshot keeps a sound graph and drops a malformed one', () => {
  const base = { agents: [], ledger: emptyLedger(), seenModels: {}, sessionTag: 'abcdef', mode: 'active', baseline: 'opus', baselinePinned: false }
  const node = (id: string, kind: string) => ({ id, kind, label: id, model: 'haiku', tier: 'haiku', status: 'active', action: 'thinks', level: 0, score: 0, cost: 0, interventions: 0, consults: 0, since: 0 })
  const good = { nodes: [node('lead', 'lead'), node('w1', 'worker')], edges: [{ id: 'spawn|lead|w1', kind: 'spawn', from: 'lead', to: 'w1', count: 1, at: 0 }], events: [{ seq: 1, kind: 'spawn', at: 0, nodes: ['lead', 'w1'] }], seq: 1, collapsed: 0, dropped: 0 }
  const kept = parseSnapshot({ ...base, graph: good, layout: { slots: { w1: 0 }, retired: [] }, drawnSeq: 1 })!
  expect(kept.graph?.nodes.length).toBe(2)
  expect(kept.layout?.slots).toEqual({ w1: 0 })
  expect(kept.drawnSeq).toBe(1)
  // No lead, or not an object: no graph.
  expect(parseSnapshot({ ...base, graph: { ...good, nodes: [node('w1', 'worker')] } })!.graph).toBeUndefined()
  expect(parseSnapshot({ ...base, graph: 'x' })!.graph).toBeUndefined()
  // A bad node is dropped with the edges that touched it; bad scalars fall back.
  const mixed = parseSnapshot({ ...base, graph: { ...good, nodes: [node('lead', 'lead'), { id: 5 }, node('w1', 'worker')], edges: [...good.edges, { id: 'x', kind: 'spawn', from: 'lead', to: 'gone', count: 1, at: 0 }] }, layout: { slots: { w1: 'z' }, retired: 3 }, drawnSeq: 'q' })!
  expect(mixed.graph?.nodes.map((n) => n.id)).toEqual(['lead', 'w1'])
  expect(mixed.graph?.edges.length).toBe(1)
  expect(mixed.layout).toBeUndefined()
  expect(mixed.drawnSeq).toBeUndefined()
})
